/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review base-tree`: stand up a BUILT tree at the merge base, so a claim
// about changed behaviour can be measured instead of read.
//
// Every other step in this pipeline looks at one tree. The agents read the PR's
// code, the verifier traces a failure scenario through the PR's code, and even
// the probe capability — which does run something — runs it against the PR's
// code alone. The merge base is known (`fetch-pr` resolves `mergeBaseSha`) and
// is used for exactly one thing: choosing the diff range. Nothing has ever built
// it.
//
// That leaves a whole class of claim decided by reading. "This preserves the
// existing output." "This only adds a field." "Cancelled calls looked the same
// as failures before." Each is a statement about the DIFFERENCE between two
// programs, and the review has only ever had one of them in front of it. Reading
// a diff and concluding what the old behaviour was is exactly the step that goes
// wrong quietly: the new lines are always right there and always look correct,
// and whether they change what a user observes routinely turns on code the diff
// never touches.
//
// With a built base tree the same input can be fed to both and the two outputs
// compared. That is a different kind of evidence from anything else here — not a
// stronger argument, but an observation — and it is the only kind that settles a
// disagreement about what a program used to do.
//
// **What this command deliberately does NOT do: run anything.** It creates the
// tree and builds it, which is the expensive, fiddly, failure-prone half (a
// detached worktree at the right SHA, a stale sibling from a crashed run, the
// minimal build set, the widening loop, deadlines that a real build can meet).
// WHAT to run is the reviewer's question, not this command's — it depends
// entirely on the claim under test, and a fixed scenario would fit almost none
// of them. So the report hands back a path and gets out of the way.
//
// Cost is why this is on demand rather than part of every review: the base
// worktree is a cold checkout, so this is an install AND a build. It is worth it for one claim that turns on it and wasted on
// a review with none, which is why the verifier's brief offers it per finding
// instead of the pipeline spending it up front.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { baseWorktreePath } from './lib/paths.js';
import {
  discardWorktree,
  sanitizedGitEnv,
  worktreeCreateFailureDetail,
  type SweepResult,
} from './lib/worktree.js';
import { runBuildTest, type BuildTestReport } from './build-test.js';
import {
  hasUnmodeledWorkspaceGlob,
  workspaceDirFor,
} from './lib/workspaces.js';

export interface BaseTreeReport {
  /**
   * True when a tree stands at `path` and its build succeeded — the only state
   * in which an A/B comparison means anything. A tree that would not compile
   * cannot be run, and a difference measured against one that half-built is not
   * a difference between the two programs.
   */
  available: boolean;
  /** Absolute path to the base worktree, when one was created. */
  path?: string;
  /** The commit it holds — the merge base of the PR and its target branch. */
  baseSha?: string;
  /** The build that ran there; null when the tree could not be created or a fast-path reuse found it already built. */
  build: BuildTestReport | null;
  /** What happened, in one line. Rendered to the reviewer verbatim. */
  note: string;
}

export interface BaseTreeArgs {
  plan: string;
  worktree: string;
  out?: string;
  timeout: number;
  install: boolean;
  /** Test seam: the build step. Production runs the real `runBuildTest`. */
  build?: (worktree: string) => BuildTestReport;
}

// Sanitized env on both helpers: an exported GIT_DIR redirects repository
// discovery for every call at once — the base tree would be added into the
// redirected repository and its reuse check would read HEAD from it, an A/B
// against the wrong program while every check against the given tree passes.
function gitOut(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
}

/**
 * Every sibling capture in these commands raises Node's 1 MiB spawnSync
 * default (`gh.ts`, `git.ts`, `build-test.ts`, `test-delta.ts`): on
 * overflow the child returns `error.code: 'ENOBUFS'` with `status: null`,
 * which the probes below would swallow into the same answer as 'absent' —
 * silently settling a base the probes never answered.
 */
const GIT_PROBE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Accepted symlink carve-out for all three git probes below: they are
 * symlink-blind where the disk-side twins follow links. `gitBlob` reads a
 * symlinked manifest as the link-target PATH text (JSON.parse fails, the
 * manifest reads as absent), `gitHasPath` accepts a symlinked `pom.xml`
 * blob, and `gitTreeChildDirs` keeps only mode-040000 entries (a symlinked
 * workspace member is dropped). Every outcome is conservative — lost A/B
 * attribution for a symlink-shaped base, never a wrong verdict — and the
 * repository shapes this gate screens for (root reactors, workspace
 * monorepos) do not hang their manifests on symlinks. Resolving
 * mode-120000 entries (bounded hop count, entry-mode gates) is left out
 * until a real base needs it.
 */
function gitHasPath(cwd: string, sha: string, path: string): boolean {
  // A BLOB, not mere existence: `cat-file -e` exits 0 for a DIRECTORY
  // too, and a dir named `pom.xml` is not a Maven project — reading one
  // as such misfires the gate into a false "Maven base" note that
  // permanently disables A/B attribution for that base.
  const r = spawnSync('git', ['cat-file', '-t', `${sha}:${path}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_PROBE_MAX_BUFFER,
  });
  return !r.error && r.status === 0 && (r.stdout ?? '').trim() === 'blob';
}

function gitBlob(cwd: string, sha: string, path: string): string | null {
  const r = spawnSync('git', ['cat-file', 'blob', `${sha}:${path}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_PROBE_MAX_BUFFER,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout ?? '';
}

/**
 * The base-tree twin of readWorkspacePackages' manifest gate: a member
 * counts only when its manifest parses and has a usable `name` — the disk
 * side puts every other manifest in `skipped`, not `packages`, and
 * `npmToolchainAdapter.applies` requires at least one package.
 */
function hasUsableManifestAt(cwd: string, sha: string, path: string): boolean {
  const blob = gitBlob(cwd, sha, path);
  if (blob === null) return false;
  try {
    const pkg = JSON.parse(blob) as { name?: unknown } | null;
    return pkg !== null && typeof pkg.name === 'string' && pkg.name !== '';
  } catch {
    return false;
  }
}

/**
 * A root package.json the npm adapter would actually apply to — mirroring
 * `npmToolchainAdapter.applies` against the BASE tree: MODELED workspace
 * globs that resolve to at least one package there, or a root build/test
 * script. A husky/lint-config/docs-tooling-only manifest applies to nothing,
 * and an unmodeled glob (`packages/**`, `foo-*`) or a zero-package glob
 * scopes nothing either, so suppressing the nested-pom probe for any of them
 * would let a standalone-module Maven base pay the cold checkout this gate
 * exists to prevent.
 */
function blobIsNpmProject(blob: string, cwd: string, sha: string): boolean {
  try {
    const pkg = JSON.parse(blob) as {
      workspaces?: unknown;
      scripts?: Record<string, unknown>;
    };
    const ws = pkg.workspaces;
    const globs = (
      Array.isArray(ws)
        ? ws
        : Array.isArray((ws as { packages?: unknown } | undefined)?.packages)
          ? ((ws as { packages: unknown[] }).packages as unknown[])
          : []
    ).filter((g): g is string => typeof g === 'string');
    if (globs.length > 0) {
      return (
        !hasUnmodeledWorkspaceGlob(globs) &&
        workspaceDirsAt(cwd, sha, globs).some(
          (dir) =>
            // A directory a negation excludes is not a workspace — the same
            // check readWorkspacePackages applies on disk.
            workspaceDirFor(`${dir}/package.json`, globs) === dir &&
            hasUsableManifestAt(
              cwd,
              sha,
              // The root-as-member shape (`"workspaces": [""]`): the disk
              // twin joins `<root>//package.json` and applies; the blob ref
              // must drop the leading slash or `<sha>:/package.json` is
              // unresolvable and the twins diverge.
              dir === '' ? 'package.json' : `${dir}/package.json`,
            ),
        )
      );
    }
    return (
      typeof pkg.scripts === 'object' &&
      pkg.scripts !== null &&
      ('build' in pkg.scripts || 'test' in pkg.scripts)
    );
  } catch {
    return false;
  }
}

/**
 * The dirs the workspace globs expand to in the tree at `sha` — the base-tree
 * twin of readWorkspacePackages' on-disk expansion (negations excluded there,
 * as here, by the caller's workspaceDirFor check).
 */
function workspaceDirsAt(cwd: string, sha: string, globs: string[]): string[] {
  const dirs = new Set<string>();
  for (const glob of globs) {
    if (glob.startsWith('!')) continue;
    // Strip a leading `./` exactly as workspaceDirCandidates does on disk.
    const g = glob.replace(/^\.\//, '').replace(/\/$/, '');
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      for (const child of gitTreeChildDirs(cwd, sha, base)) {
        dirs.add(base ? `${base}/${child}` : child);
      }
    } else {
      dirs.add(g);
    }
  }
  return [...dirs];
}

/** Direct children (mode 040000) of `dir` in the tree at `sha` — all of them
 * when `dir` is empty. */
function gitTreeChildDirs(cwd: string, sha: string, dir: string): string[] {
  // `sha:dir` lists the CHILDREN of dir with bare names (a pathspec without
  // the colon lists dir itself); `sha:` alone lists the root tree.
  const r = spawnSync('git', ['ls-tree', '-z', `${sha}:${dir}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_PROBE_MAX_BUFFER,
  });
  if (r.error || r.status !== 0) return [];
  const dirs: string[] = [];
  // `-z` output is NUL-delimited and NEVER C-quoted, so names with non-ASCII
  // bytes, quotes, tabs, backslashes — or line terminators — survive. Parse
  // structurally, not with a regex: `.` cannot span a line terminator, and a
  // `\n` in a name is the standard core.quotePath escape. The first tab ends
  // the OID: an object id is hex and contains no tab.
  for (const entry of (r.stdout ?? '').split('\0')) {
    if (!entry.startsWith('040000 tree ')) continue;
    const tab = entry.indexOf('\t');
    if (tab >= 0) dirs.push(entry.slice(tab + 1));
  }
  return dirs;
}

/**
 * Nested-pom bases (standalone modules, no root aggregator) miss the root
 * `pom.xml` probe but are Maven just the same; when the base carries no
 * npm-applicable root `package.json` either, a depth-1 listing settles it
 * before checkout. Only a DIRECT child counts: a pom deeper than
 * `<dir>/pom.xml` is a vendored sample, an archetype fixture, or a
 * maven-invoker IT, and counting one would permanently — and silently —
 * disable A/B attribution for a repo that merely ships one.
 */
function gitTreeHasNestedPom(cwd: string, sha: string): boolean {
  const dirs = gitTreeChildDirs(cwd, sha, '');
  if (dirs.length === 0) return false;
  // The batch probe below is line-based: a name carrying a line terminator
  // (PR-choosable) would split into two wrong refs, so those names keep
  // the per-dir argv probe, which hands the whole path as ONE argument.
  if (!dirs.every((dir) => !/[\r\n]/.test(dir))) {
    return dirs.some((dir) => gitHasPath(cwd, sha, `${dir}/pom.xml`));
  }
  // ONE batched `cat-file` for every root dir, not one spawn each: step 4's
  // verifier shards all offer this command, the gate's answer is a pure
  // function of baseSha's tree, and the per-dir spawns multiplied into
  // N shards x O(D) synchronous processes on the review's critical path.
  // `--batch-check` answers a missing path with `<ref> missing` on its own
  // line and still exits 0; a DIRECTORY named pom.xml answers `tree` and is
  // not a nested pom, exactly as the per-dir blob gate before it.
  const r = spawnSync('git', ['cat-file', '--batch-check'], {
    cwd,
    encoding: 'utf8',
    input: dirs.map((dir) => `${sha}:${dir}/pom.xml`).join('\n') + '\n',
    maxBuffer: GIT_PROBE_MAX_BUFFER,
  });
  if (r.error || r.status !== 0) return false;
  return (r.stdout ?? '').split('\n').some((line) => / blob \d+$/.test(line));
}

export function runBaseTree(args: BaseTreeArgs): BaseTreeReport {
  const unavailable = (note: string): BaseTreeReport => ({
    available: false,
    build: null,
    note,
  });

  let plan: { mergeBaseSha?: unknown; baseFetchFailed?: unknown };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    return unavailable(
      `cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }

  const baseSha = plan.mergeBaseSha;
  if (typeof baseSha !== 'string' || !baseSha) {
    // A local review, a bare `plan-diff`, or a PR whose merge base could not be
    // resolved. There is no "before" to build, and saying so plainly beats
    // guessing at one — an A/B against the wrong base is worse than no A/B.
    return unavailable(
      'the plan carries no mergeBaseSha, so there is no base commit to build ' +
        '(a local review, or a merge base that could not be resolved)',
    );
  }
  // `fetch-pr` sets this when it could not fetch the base branch, which leaves
  // `mergeBaseSha` possibly stale — pointing at whatever the local ref happened
  // to be. A comparison against a stale base attributes the base branch's own
  // movement to this PR, which is the same class of error two-dot diffs made.
  if (plan.baseFetchFailed === true) {
    return unavailable(
      'the base branch could not be fetched, so mergeBaseSha may be stale; an ' +
        "A/B against it would attribute the base branch's own commits to this PR",
    );
  }

  const worktree = resolve(args.worktree);
  if (!existsSync(worktree)) {
    return unavailable(`the review worktree ${worktree} does not exist`);
  }

  const tree = baseWorktreePath(worktree);
  // Idempotent fast path — and the CONCURRENCY guard. Step 4 launches its
  // verifier shards together, the brief offers every one of them this command,
  // and they all resolve the same path; without this, shard B's opening sweep
  // destroys the tree shard A is mid-A/B in, and A's base side silently reads
  // as empty output — a fabricated difference with a deterministic source tag.
  // A tree that exists, holds the right commit, and carries the marker a
  // successful build wrote is returned as-is: same answer, no clobber, and the
  // duplicate install+build cost gone with it. (Not a lock: two shards racing
  // the FIRST build can still collide — the window is narrow and the failure
  // is a build error, not a wrong verdict. A marker of the wrong SHA — a
  // rebase between runs — falls through to the rebuild below.)
  const marker = () => join(tree, '.qwen-review-base-ok');
  const failedMarker = () => join(tree, '.qwen-review-base-failed');
  try {
    if (
      existsSync(tree) &&
      readFileSync(marker(), 'utf8').trim() === baseSha &&
      gitOut(tree, 'rev-parse', 'HEAD') === baseSha
    ) {
      return {
        available: true,
        path: tree,
        baseSha,
        build: null,
        note: `base tree already built at ${baseSha.slice(0, 9)} in ${tree} (reusing it — a concurrent or earlier probe built it)`,
      };
    }
  } catch {
    // No marker, unreadable marker, or a tree git cannot answer for: rebuild.
  }
  // A base that FAILED to build is a settled answer too. Without this marker,
  // every shard that asks re-sweeps and re-pays the install+build to relearn
  // the same "unavailable" — and the sweep destroys the evidence tree the
  // failure deliberately leaves standing.
  try {
    if (
      existsSync(tree) &&
      readFileSync(failedMarker(), 'utf8').trim() === baseSha
    ) {
      return {
        available: false,
        path: tree,
        baseSha,
        build: null,
        note:
          `the base tree at ${baseSha.slice(0, 9)} already failed to build (an earlier probe measured it); ` +
          'an A/B is not available for this review (infrastructure, never a finding against the PR)',
      };
    }
  } catch {
    // No failed-marker: proceed to build.
  }
  // A/B attribution reruns the recorded npm test commands (test-delta); no
  // other toolchain has a delta consumer in this release — Agent 7's brief
  // says the same for Maven. The gate sits AFTER the marker checks: step 4
  // launches its verifier shards together, and once a tree stands (built or
  // failed) every later shard is answered by its marker without re-scanning.
  // It still runs before the checkout, so a Maven base never pays for a tree
  // that would not be built — including the nested-pom shape (standalone
  // modules, no root aggregator), settled by a depth-1 listing when the base
  // has no npm-applicable root package.json either. A husky-only manifest
  // leaves no consumable npm half, so it must not suppress the probe.
  const mavenBaseNote =
    `the merge base is a Maven project, and this release's A/B attribution only reruns npm test ` +
    'commands — a base-side Maven build could not be consumed, so it was not run ' +
    '(never a finding against the PR)';
  // The root pom decides the gate alone; probing it FIRST spares every
  // root-pom Maven base the npm workspace scan the second check pays.
  if (gitHasPath(worktree, baseSha, 'pom.xml')) {
    return unavailable(mavenBaseNote);
  }
  const npmAtBase = (() => {
    if (!gitHasPath(worktree, baseSha, 'package.json')) return false;
    const blob = gitBlob(worktree, baseSha, 'package.json');
    return blob !== null && blobIsNpmProject(blob, worktree, baseSha);
  })();
  if (!npmAtBase && gitTreeHasNestedPom(worktree, baseSha)) {
    return unavailable(mavenBaseNote);
  }
  // A real mutual-exclusion lock around sweep+add+build, not just the marker.
  // The reuse fast path covers the AFTER-build window; this covers the build
  // itself: measured in review, shard B's opening sweep deleted the tree shard
  // A was mid-`npm ci` in, both installed into the same directory, and
  // whichever finished stamped the marker for a tree the other was still
  // mutating. `mkdirSync` without `recursive` is the atomic test-and-set; the
  // loser returns busy rather than waiting out a multi-minute build.
  const lock = `${tree}.lock`;
  // Staleness: a builder killed without its finally leaves the lock forever,
  // and within the same review every later probe reports busy until cleanup.
  // A lock older than any plausible install+build (30 min) is a corpse — sweep
  // it and take the build. mtime is the lock dir's creation time (nothing
  // touches it after mkdir), so this cannot fire on a live build.
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age > 30 * 60 * 1000) {
      rmSync(lock, { recursive: true, force: true });
    }
  } catch {
    // No lock — the normal case.
  }
  try {
    mkdirSync(lock);
  } catch (err) {
    // Only EEXIST means "another builder holds it". EPERM/EROFS/ENOSPC is a
    // real failure this run owns — reporting it as busy sends the caller into
    // a retry loop against a lock that will never appear.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return unavailable(
        `could not take the base-tree build lock: ${(err as Error).message}`,
      );
    }
    return unavailable(
      'another probe is building the base tree right now — retry when its ' +
        'marker appears (the fast path will then reuse it), or settle the ' +
        'claim by reading; do not sweep the tree out from under the builder',
    );
  }
  try {
    return buildBaseTree(baseSha);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }

  // The parameter re-narrows: TS narrowing does not cross function scopes.
  function buildBaseTree(baseSha: string): BaseTreeReport {
    let sweep: SweepResult | undefined;
    try {
      // Clear a stale base tree left by a crashed run — it would fail `add`. Its
      // stderr is kept, because it is usually what explains that failure.
      sweep = discardWorktree(worktree, tree);
      git(worktree, 'worktree', 'add', '--detach', tree, baseSha);
    } catch (e) {
      return unavailable(
        worktreeCreateFailureDetail('base', e, String(sweep?.stderr ?? '')),
      );
    }

    const build = args.build
      ? args.build(tree)
      : runBuildTest({
          plan: args.plan,
          worktree: tree,
          timeout: args.timeout,
          install: args.install,
          // The base tree's own suite says nothing about this PR — it was green
          // before the PR existed. What the A/B needs from here is a compiled
          // tree to run against.
          buildOnly: true,
        });

    // A build the whole-call budget truncated is NOT available: rerunning the
    // PR's failing files against packages that were never compiled
    // manufactures failures that read as "fails on base too" — pre-existing
    // by measurement — and waves a real regression through. But it is not a
    // settled answer about this SHA either (with more budget it may build
    // fully), so NO marker is written — a later shard may repay and succeed.
    if ((build.notBuilt?.length ?? 0) > 0) {
      return {
        available: false,
        path: tree,
        baseSha,
        build,
        note:
          `the base tree build at ${baseSha.slice(0, 9)} was cut short by the ` +
          `whole-call budget (${build.notBuilt!.join(', ')} not built), so a ` +
          'rerun against it would manufacture pre-existing failures; an A/B ' +
          'is not available for this review (this is an infrastructure ' +
          'result, never a finding against the PR)',
      };
    }

    // `ok: true` is not enough: `runBuildTest` returns `ok: true` for a handoff
    // that built nothing — an `unsupported` toolchain (a changed dir the merge
    // base maps to no package, e.g. a package this PR adds), or an npm scope with
    // nothing to compile. Such a tree was never built, so it cannot be run against;
    // stamping it `available` would let an A/B read the absence of a build as a
    // behavioural difference.
    if (!build.ok || build.toolchain !== 'npm' || build.build.length === 0) {
      // Leave the tree standing. A base that does not build is a fact worth
      // looking at by hand, and deleting the evidence to save a directory is a
      // bad trade — `cleanup` sweeps it at the end of the review either way.
      // The marker makes the failure a SETTLED answer for every later shard.
      try {
        writeFileSync(failedMarker(), `${baseSha}\n`);
      } catch {
        // The tree may be too broken to hold a marker; the next shard repays.
      }
      return {
        available: false,
        path: tree,
        baseSha,
        build,
        note:
          `the base tree at ${baseSha.slice(0, 9)} did not build, so nothing can be run ` +
          'against it; an A/B is not available for this review (this is an ' +
          'infrastructure result, never a finding against the PR)',
      };
    }

    // The marker is what the fast path above trusts, so it is written only after
    // a build that succeeded, and it records the SHA it vouches for.
    try {
      writeFileSync(marker(), `${baseSha}\n`);
    } catch {
      // The tree may be too broken to hold a marker; the next shard rebuilds.
    }
    return {
      available: true,
      path: tree,
      baseSha,
      build,
      note:
        `base tree built at ${baseSha.slice(0, 9)} in ${tree}. Run the same input here and in the ` +
        'PR worktree and compare the observed output; a difference is evidence, a ' +
        'reading is not.',
    };
  }
}

export const baseTreeCommand: CommandModule = {
  command: 'base-tree',
  describe:
    "Build the PR's merge base in a sibling worktree, so a claim about changed " +
    'behaviour can be measured against the code as it stood before',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'The plan report from fetch-pr (it carries `mergeBaseSha`)',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: "The PR's worktree — the base tree is created beside it",
      })
      .option('out', { type: 'string', describe: 'Write the JSON report here' })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe: "Per-command deadline in seconds, as `build-test`'s",
      })
      .option('install', {
        type: 'boolean',
        default: true,
        describe:
          'Run `npm ci` first when node_modules is absent (npm toolchain only; ' +
          'Maven resolves dependencies inside its lifecycle command)',
      }),
  handler: (argv) => {
    const args = argv as unknown as BaseTreeArgs;
    try {
      const report = runBaseTree(args);
      if (args.out) {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(`base-tree: ${report.note}`);
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};

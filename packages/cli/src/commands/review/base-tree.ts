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
  untrustedGitfile,
  discardWorktree,
  sanitizedGitEnv,
  worktreeCreateFailureDetail,
  type SweepResult,
} from './lib/worktree.js';
import { runBuildTest, type BuildTestReport } from './build-test.js';
import {
  baseTreeTrustPath,
  builtTreeRecord,
  recordBuiltTree,
  runNonce,
} from './lib/base-tree-trust.js';

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

// The tree's untracked AND ignored path set, as `git status` collapses it (a
// directory holding nothing tracked reports as one `path/` entry). Ignored is
// included because that is exactly where a plant hides in a real repository —
// `dist/` and `node_modules/` are gitignored here, so an untracked-only
// listing is blind to the executable a host-side A/B would run.
function untrackedPaths(tree: string): string[] {
  return gitOut(tree, 'status', '--porcelain', '-z', '--ignored')
    .split('\0')
    .filter((e) => e.startsWith('?? ') || e.startsWith('!! '))
    .map((e) => e.slice(3))
    .sort();
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
  // The run's stamp secret, persisted OUTSIDE the mount beside the worktree
  // leases (see lib/base-tree-trust.ts). The fence used to key on the plan's
  // mtime, and the plan lives inside the directory the sandbox mounts
  // read-write — reviewed code could stat it, compute the epoch, and write
  // it into a forged stamp, after which every reuse check passed on an
  // attacker-shaped tree. A random per-run secret the mount can neither
  // read nor write is what a stamp now vouches with. Without it no marker
  // can be trusted or written, so its absence fails the command, not the
  // fence.
  const trustPath = baseTreeTrustPath(worktree, args.plan);
  let nonce: string;
  try {
    nonce = runNonce(trustPath);
  } catch (err) {
    return unavailable(
      `could not establish the run's trust artifact ${trustPath}: ` +
        `${(err as Error).message}`,
    );
  }
  try {
    const stamp = readFileSync(marker(), 'utf8').trim().split('\n');
    if (existsSync(tree) && stamp[0] === baseSha && stamp[1] === nonce) {
      // ...and THIS run built it — genuinely: the secret never enters the
      // mount, so a mount-local writer cannot have refreshed or forged the
      // stamp. `cleanStale` never releases `-base`, so an earlier round's
      // tree stands into this one with a whole containerized build/test
      // phase in between — long enough for the reviewed code to drop
      // untracked executables in here, and `dist/cli.js` is what a host-side
      // A/B runs.
      if (
        // The reuse path RETURNS, so the gate below the rebuild never runs
        // for it — and both facts these arms establish come from inside the
        // mount: `rev-parse HEAD` resolves through that tree's own `.git`,
        // and its working files are a direct child of the directory the
        // sandbox mounts read-write. A planted repository answers the right
        // sha for a working tree holding anything at all; a plain copy
        // overwrites the tracked sources while HEAD never moves — and the
        // A/B's BASE side is then the reviewed code's own, so a test the PR
        // breaks fails identically on both sides and reads as pre-existing.
        //
        // `--untracked-files=no`: the pipeline's own build leaves
        // `node_modules/` and `dist/` here, so an untracked-inclusive check
        // would call every correctly-built tree dirty and disable reuse
        // outright. (The untracked surface is fenced separately, below.)
        untrustedGitfile(tree) !== null ||
        gitOut(tree, 'rev-parse', 'HEAD') !== baseSha ||
        gitOut(tree, 'status', '--porcelain', '--untracked-files=no') !== ''
      ) {
        // A state arm failed on a tree THIS RUN built. Falling through would
        // discard it — but this run's own build can legitimately leave
        // tracked dirt (codegen, a lockfile rewrite), and a concurrent
        // shard's A/B can write one tracked file mid-measurement (a snapshot
        // `--update`). Sweeping that tree reintroduces the concurrent-shard
        // clobber this fast path exists to prevent: shard B would rmSync the
        // tree shard A is mid-A/B in, and A's base side reads as empty
        // output — a fabricated difference with a deterministic source tag.
        // So decline, the way the build lock's EEXIST arm does. (A stamp
        // that does NOT match this run still falls through to the rebuild:
        // an earlier run's leftover or a forge is nobody's live tree, and
        // the discard is what removes the plant.)
        return unavailable(
          `the base tree at ${baseSha.slice(0, 9)} was built by this run ` +
            'but no longer passes a reuse check (a concurrent probe may be ' +
            'writing it mid-A/B); declining to reuse or discard it — retry ' +
            'when the probe finishes, or settle the claim by reading',
        );
      }
      // The untracked surface. The state arms above are blind to it by
      // design, and the window to abuse it is guaranteed: the sandboxed
      // build/test phase overlaps the verifier shards, so reviewed code can
      // drop `dist/cli.js` or `node_modules/.bin/<x>` in here AFTER the
      // stamp, and a host-side A/B would then execute the plant as the BASE
      // side. The marker itself cannot vouch for the set the build left —
      // it is a file inside the mount — so the set was recorded host-side
      // when the marker was written, and anything beyond it is a plant:
      // content, not concurrency, so this one DOES fall through to the
      // rebuild whose discard sweeps it.
      const recorded = builtTreeRecord(trustPath, tree);
      const current = untrackedPaths(tree);
      if (
        recorded !== null &&
        recorded.baseSha === baseSha &&
        current.every((p) => recorded.untracked.includes(p))
      ) {
        return {
          available: true,
          path: tree,
          baseSha,
          build: null,
          note: `base tree already built at ${baseSha.slice(0, 9)} in ${tree} (reusing it — a concurrent or earlier probe built it)`,
        };
      }
    }
    // No marker, or a stamp that does not carry this run's secret — an
    // earlier run's leftover, or a forge computed from the mount-visible
    // inputs. Not a refusal: an unusable leftover is what the rebuild exists
    // for. Falling through discards the tree (removing a plant with it) and
    // creates a fresh one through the review worktree's pointer, which the
    // gate before `worktree add` checks. Same shape as `scratch-tree`'s
    // reuse path, for the same reason.
  } catch {
    // No marker, unreadable marker, or a tree git cannot answer for: rebuild.
  }
  // A base that FAILED to build is a settled answer too. Without this marker,
  // every shard that asks re-sweeps and re-pays the install+build to relearn
  // the same "unavailable" — and the sweep destroys the evidence tree the
  // failure deliberately leaves standing.
  try {
    const failed = readFileSync(failedMarker(), 'utf8').trim().split('\n');
    if (
      existsSync(tree) &&
      failed[0] === baseSha &&
      // The same fence the ok marker carries, on the path that needs it most:
      // this branch settles the question with NO build at all, and the file
      // lives inside the mount — a sha-only marker is one planted line away
      // from suppressing the A/B lane for the whole round, reading as
      // infrastructure rather than as an attack.
      failed[1] === nonce
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
      // The same question the probe phase asks before its own `worktree add`:
      // this resolves the repository through the REVIEW worktree's gitfile,
      // which lives inside the directory the sandbox mounts read-write and
      // which the build/test phase already gave the reviewed code a chance to
      // rewrite. `worktree add` checks files out, so it runs whatever that
      // pointer leads to, on the host. See `untrustedGitfile`.
      const untrusted = untrustedGitfile(worktree);
      if (untrusted !== null) {
        throw new Error(`refusing to create a base tree: ${untrusted}`);
      }
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
      // The marker makes the failure a SETTLED answer for every later shard,
      // and it carries the run secret for the same reason the ok marker does:
      // a planted sha-only marker must settle nothing (the fence above).
      try {
        writeFileSync(failedMarker(), `${baseSha}\n${nonce}\n`);
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
    // a build that succeeded, and it records the SHA and the run it vouches for
    // — the run secret, not the mount-visible epoch it replaced. With it goes
    // the host-side record of the untracked set this build legitimately left,
    // so the reuse fence can tell that residue from a plant dropped later
    // (marker first, so the marker itself is part of the recorded set).
    try {
      writeFileSync(marker(), `${baseSha}\n${nonce}\n`);
      recordBuiltTree(trustPath, tree, baseSha, untrackedPaths(tree));
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
        describe: 'Run `npm ci` first when node_modules is absent',
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

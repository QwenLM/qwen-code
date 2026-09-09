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
  lstatSync,
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
  establishTrust,
  recordBuiltTree,
  runIdentityMs,
  type BuiltTreeStat,
  type TrustState,
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
//
// Every invocation also carries the config neutralization `revParse` carries
// in lib/worktree.ts: these reads run against trees the containerized build
// just held read-write, and a planted `core.fsmonitor` fires on an ordinary
// index read while a planted `core.hooksPath` rides any command that takes
// hooks — both are inert arguments under the `-c` pins, wherever the
// resolved repository's own config points. `maxBuffer` because the ignored
// listing of a real built tree (~100k paths under node_modules/ and dist/,
// measured at 6+ MB) blows straight through spawnSync's 1 MiB default, and
// the fence's record silently never lands when it does — the cap is a
// ceiling, not an allocation.
const GIT_NEUTRALIZE = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null/no-hooks',
];
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function gitOut(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', [...GIT_NEUTRALIZE, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

// The NUL-delimited form: `gitOut`'s `.trim()` would eat a leading-space
// filename and the record separator is NUL, not whitespace.
function gitOutZ(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', [...GIT_NEUTRALIZE, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  const out = r.stdout ?? '';
  return out.endsWith('\0') ? out.slice(0, -1) : out;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', [...GIT_NEUTRALIZE, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
}

// The tree's untracked AND ignored FILES, listed individually. Two
// `ls-files` calls rather than `git status`: status collapses a directory to
// one `dir/` entry, and a plant dropped INSIDE a directory the build left —
// `dist/cli.js`, `node_modules/.bin/<x>`, exactly what a host-side A/B
// executes — then changes no set membership. `ls-files --others` never
// collapses.
function untrackedPaths(tree: string): string[] {
  const others = gitOutZ(
    tree,
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  );
  const ignored = gitOutZ(
    tree,
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
  );
  return [...others.split('\0'), ...ignored.split('\0')]
    .filter((e) => e !== '')
    .sort();
}

const OK_MARKER = '.qwen-review-base-ok';
const FAILED_MARKER = '.qwen-review-base-failed';

/**
 * The untracked inventory a build leaves, per file with the stat pair the
 * reuse fence compares — membership alone is blind to an in-place rewrite
 * of a recorded path (`dist/cli.js` keeps its name while its bytes become
 * the reviewed code's), and `BuiltTreeStat` says why the pair is size and
 * ctime.
 *
 * The two marker files are EXCLUDED: they are notes this pipeline itself
 * writes and the reviewed code may hold a copy of, so their presence or
 * absence must move no fence decision — and excluding them is what lets the
 * record be written before the marker without the marker showing up as its
 * own unrecorded extra.
 */
function untrackedInventory(tree: string): Record<string, BuiltTreeStat> {
  // No prototype: a path literally named `__proto__` is a legal filename,
  // and the plain-object setter would swallow it — recorded nowhere, so a
  // plant at that path would be invisible to the fence.
  const inventory: Record<string, BuiltTreeStat> = Object.create(null);
  for (const p of untrackedPaths(tree)) {
    if (p === OK_MARKER || p === FAILED_MARKER) continue;
    const st = lstatSync(join(tree, p));
    inventory[p] = { size: st.size, ctimeMs: st.ctimeMs };
  }
  return inventory;
}

/**
 * Whether every file the tree holds now is one the record holds, unchanged.
 * Recorded-but-absent is fine (residue may be cleaned between asks);
 * present-but-unrecorded is the addition arm, and present-but-rewritten —
 * size or ctime moved — is the in-place arm. Both are the plant shape.
 */
function inventoryMatches(
  current: Record<string, BuiltTreeStat>,
  recorded: Record<string, BuiltTreeStat>,
): boolean {
  for (const [p, now] of Object.entries(current)) {
    const was = recorded[p];
    if (!was || was.size !== now.size || was.ctimeMs !== now.ctimeMs) {
      return false;
    }
  }
  return true;
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
  // A tree that exists, holds the right commit, and carries a host-side
  // record this run wrote is returned as-is: same answer, no clobber, and the
  // duplicate install+build cost gone with it. (Not a lock: two shards racing
  // the FIRST build can still collide — the window is narrow and the failure
  // is a build error, not a wrong verdict. A record for the wrong SHA — a
  // rebase between runs — falls through to the rebuild below.)
  const marker = () => join(tree, OK_MARKER);
  const failedMarker = () => join(tree, FAILED_MARKER);
  // Either marker's first line naming this base — informational only: the
  // markers are in-tree notes, so this answers "was this run here", never
  // "is the tree good".
  const markerNamesBaseSha = (): boolean => {
    for (const m of [marker(), failedMarker()]) {
      try {
        if (readFileSync(m, 'utf8').trim().split('\n')[0] === baseSha) {
          return true;
        }
      } catch {
        // Absent marker — the common case.
      }
    }
    return false;
  };
  // The fence reads this run's trust record, kept OUTSIDE the mount beside
  // the worktree leases (see lib/base-tree-trust.ts). It used to read a
  // marker file inside the tree stamped with a per-run secret — but the
  // marker lived inside the directory the sandbox mounts read-write, and a
  // secret readable from the mount authenticates nothing: the reviewed code
  // could copy it into a forged failed-marker and settle the A/B lane into
  // "infrastructure" for the whole round, or stamp an ok marker over a tree
  // it shaped. So the markers are informational notes now, and the record —
  // which the mount cannot supply — is the fence. Without it no tree is
  // reused and no failure is settled, so its absence fails the command, not
  // the fence.
  let trustPath: string;
  let trust: TrustState;
  let identityMs: number;
  try {
    trustPath = baseTreeTrustPath(worktree, args.plan);
    identityMs = runIdentityMs(worktree, args.plan);
    trust = establishTrust(trustPath, identityMs, baseSha);
  } catch (err) {
    return unavailable(
      `could not establish the run's trust artifact: ${(err as Error).message}`,
    );
  }
  if (trust.conflict) {
    // The plan now names a different merge base than the one this run pinned
    // at establishment. The plan lives inside the mount, so a mid-run
    // rewrite of `mergeBaseSha` is how the reviewed code would choose the
    // base every later A/B certifies; re-pinning would make the rewritten
    // value authoritative, so the answer is to decline. A genuine rebase
    // arrives through a fresh capture — a new identity, a rotation, a clean
    // pin.
    return unavailable(
      'the plan now names a different merge base than the one this run ' +
        'pinned when it started, and the plan lives inside the review temp ' +
        'dir — declining to build or reuse at a sha named after the fact; ' +
        'an A/B is not available for this review',
    );
  }
  try {
    const recorded = builtTreeRecord(trustPath, tree);
    if (existsSync(tree) && recorded !== null && recorded.baseSha === baseSha) {
      if (recorded.state === 'failed') {
        // A base that FAILED to build is a settled answer too — and the
        // record, not any in-tree marker, is what settles it: this branch
        // answers with NO build at all, so a planted note must not reach it.
        // Without the record every shard that asks re-sweeps and re-pays the
        // install+build to relearn the same "unavailable" — and the sweep
        // destroys the evidence tree the failure deliberately leaves
        // standing.
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
      // ...and THIS run built it — genuinely: the record lives outside the
      // mount, so a mount-local writer cannot have written or refreshed it.
      // `cleanStale` never releases `-base`, so an earlier round's
      // tree stands into this one with a whole containerized build/test
      // phase in between — long enough for the reviewed code to drop
      // untracked executables in here, and `dist/cli.js` is what a host-side
      // A/B runs.
      // The reuse path RETURNS, so the gate below the rebuild never runs
      // for it — and both facts these arms establish come from inside the
      // mount: `rev-parse HEAD` resolves through that tree's own `.git`,
      // and its working files are a direct child of the directory the
      // sandbox mounts read-write. A planted repository answers the right
      // sha for a working tree holding anything at all; a plain copy
      // overwrites the tracked sources while HEAD never moves — and the
      // A/B's BASE side is then the reviewed code's own, so a test the PR
      // breaks fails identically on both sides and reads as pre-existing.
      const pointerWhy = untrustedGitfile(tree);
      if (
        pointerWhy !== null ||
        gitOut(tree, 'rev-parse', 'HEAD') !== baseSha
      ) {
        // A rewritten pointer or a moved HEAD has NO benign cause: this
        // run's build does not touch either, and a concurrent A/B does not
        // move HEAD. Not the busy arm — the discard-and-rebuild below is
        // exactly what sweeps the plant, and declining here would leave it
        // standing for the rest of the run.
      } else {
        // Tracked dirt OR an untracked change. Both have benign causes
        // on a tree this run built: codegen and lockfile rewrites from
        // this run's own build, a concurrent shard's snapshot `--update`
        // mid-A/B, the A/B's own cache output. Both are also what a plant
        // looks like — and that ambiguity is exactly why the answer is to
        // DECLINE rather than to discard: discarding on this signal
        // sweeps a live tree another shard may be mid-A/B in (the
        // concurrent-shard clobber this fast path exists to prevent),
        // while a genuine plant wedged here is never executed, and the
        // next run's rotation discards it.
        //
        // `--untracked-files=no` for the tracked arm: the pipeline's own
        // build leaves `node_modules/` and `dist/` here, so an
        // untracked-inclusive check would call every correctly-built
        // tree dirty and disable reuse outright — the untracked surface
        // is the inventory arm's, recorded host-side at build time. An
        // inventory that cannot be re-measured declines like a failed one:
        // "could not enumerate" is not evidence worth destroying a live
        // tree over.
        let inventory: Record<string, BuiltTreeStat> | null;
        try {
          inventory = untrackedInventory(tree);
        } catch {
          inventory = null;
        }
        if (
          gitOut(tree, 'status', '--porcelain', '--untracked-files=no') !==
            '' ||
          inventory === null ||
          !inventoryMatches(inventory, recorded.untracked)
        ) {
          return unavailable(
            `the base tree at ${baseSha.slice(0, 9)} was built by this run ` +
              'but no longer passes a reuse check (a concurrent probe may be ' +
              'writing it mid-A/B); declining to reuse or discard it — retry ' +
              'when the probe finishes, or settle the claim by reading',
          );
        }
        return {
          available: true,
          path: tree,
          baseSha,
          build: null,
          note: `base tree already built at ${baseSha.slice(0, 9)} in ${tree} (reusing it — a concurrent or earlier probe built it)`,
        };
      }
    } else if (existsSync(tree) && recorded === null) {
      // A standing tree with NO record in this run's trust file. Two shapes:
      // a leftover this run has no history of (an earlier run's tree, a
      // plant, a crashed pre-record build — the rebuild sweeps it), and a
      // tree THIS run built whose record never landed or tore (the build
      // lock serializes builders, so the tree may be mid-A/B in a sibling
      // shard — discarding on a bookkeeping gap is the clobber this fence
      // exists to prevent). The marker the build wrote is what tells them
      // apart: it says THIS run was here. Its content certifies nothing —
      // the decline below reuses nothing.
      const pointerWhy = untrustedGitfile(tree);
      if (
        pointerWhy !== null ||
        gitOut(tree, 'rev-parse', 'HEAD') !== baseSha
      ) {
        // The same no-benign-cause arm as above: a rewritten pointer is the
        // plant the rebuild sweeps, whatever the bookkeeping says.
      } else if (
        (trust.established === 'adopted' || trust.established === 'healed') &&
        markerNamesBaseSha()
      ) {
        return unavailable(
          `the base tree at ${baseSha.slice(0, 9)} was built by this run ` +
            'but its host-side build record is missing or unreadable — a ' +
            'torn write says nothing about the tree, and discarding on it ' +
            'would sweep a live tree another probe may be mid-A/B in; ' +
            'declining to reuse or discard it — settle the claim by ' +
            `reading, or remove ${tree} to force a rebuild`,
        );
      }
    }
    // No tree, no record, a record naming a different base (the pin makes
    // that unreachable from a same-run plan rewrite, so what remains is
    // contradiction — the one disagreeing state that IS evidence of a
    // plant), or a foreign marker: not a refusal, an unusable leftover is
    // what the rebuild exists for. Falling through discards the tree
    // (removing a plant with it) and creates a fresh one through the review
    // worktree's pointer, which the gate before `worktree add` checks. Same
    // shape as `scratch-tree`'s reuse path, for the same reason.
  } catch {
    // No marker, an unanswerable tree: rebuild.
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
      // The host-side RECORD makes the failure a SETTLED answer for every
      // later shard — an in-tree marker alone is one planted line away from
      // suppressing the A/B lane for the whole round, so it is a note here
      // and evidence nowhere.
      try {
        recordBuiltTree(trustPath, identityMs, tree, {
          baseSha,
          state: 'failed',
          untracked: {},
        });
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

    // The containerized build just held this tree read-write for minutes —
    // long enough for the reviewed code to rewrite its `.git`. Re-ask the
    // pointer question before the record's evidence-gathering:
    // `untrackedInventory` resolves the repository through that pointer, and
    // through a plant its reads would answer for — and run config out of —
    // whatever the plant names, on the host, outside the container.
    const pointerWhy = untrustedGitfile(tree);
    if (pointerWhy !== null) {
      return unavailable(
        `the base tree's .git pointer was rewritten during the build ` +
          `(${pointerWhy}), so its residue cannot be measured safely; the ` +
          'tree is left standing for inspection, and an A/B is not ' +
          'available for this review (this is an infrastructure result, ' +
          'never a finding against the PR)',
      );
    }
    // The host-side record is what the fast path above trusts, so it goes
    // FIRST: a call that certifies the tree must have landed the evidence
    // before the in-tree note. The marker is informational — content for a
    // human, excluded from the recorded inventory — so nothing reads it.
    try {
      recordBuiltTree(trustPath, identityMs, tree, {
        baseSha,
        state: 'ok',
        untracked: untrackedInventory(tree),
      });
    } catch {
      // The record could not be written (a full disk, a torn rename). THIS
      // call's answer stands — the build just succeeded in front of us —
      // and later shards decline on the missing record rather than reusing
      // what they cannot verify or discarding what a sibling may be using.
    }
    try {
      writeFileSync(marker(), `${baseSha}\n`);
    } catch {
      // The tree may be too broken to hold a note; the record is the fence.
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

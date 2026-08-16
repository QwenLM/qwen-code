/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Disposable sibling worktrees, and the steps their users need.
//
// `test-efficacy` runs its mutants in one; `base-tree` builds the merge-base in
// another; `scratch-tree` hands a third to each Step 4 verifier. All three add a
// tree beside the review worktree, all must survive a leftover from a crashed
// run, and all need the sweep's stderr to explain a subsequent `add` failure —
// so the step lives here rather than three times.
//
// The residue probe below is the same subject seen from the other side: the
// reason those trees exist is that the SHARED review worktree must stay exactly
// as the PR left it while other agents read it.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { readWorkspacePackages } from './workspaces.js';

export type SweepResult = ReturnType<typeof spawnSync>;

/**
 * Free a disposable worktree's path: unregister it, then remove what is left.
 *
 * `git worktree remove --force` only clears a tree git still tracks. A directory
 * left at the path after metadata loss or a partial cleanup is reported "not a
 * working tree" and left in place — and a *non-empty* one then makes
 * `git worktree add` fail `already exists`, wedging every later run until
 * someone clears it by hand. So the unregister is followed by a plain remove of
 * whatever dir remains. `rmSync` unlinks a symlink rather than following it, so
 * a tampered leftover cannot redirect the delete outside `tree`.
 *
 * This is `releaseWorktree`'s two-step, and deliberately NOT a call to it:
 * `releaseWorktree` runs git from the process cwd, which need not be this
 * worktree's repo, and it discards the sweep's stderr — which is usually the
 * only thing that explains a subsequent `add` failure. Every caller here needs
 * `cwd` and that stderr.
 *
 * Best-effort by design: a clean path is the normal case, so the unregister does
 * not throw on a non-zero status. `rmSync` still can (`force` suppresses ENOENT
 * but not EPERM/EBUSY) — callers decide what that means.
 */
export function discardWorktree(cwd: string, tree: string): SweepResult {
  const sweep = spawnSync('git', ['worktree', 'remove', '--force', tree], {
    cwd,
    encoding: 'utf8',
  });
  rmSync(tree, { recursive: true, force: true });
  // And clear the ADMIN entry the two steps above can leave behind. A tree
  // whose `.git` gitfile is broken makes `worktree remove` fail; `rmSync` then
  // takes the directory, but `.git/worktrees/<name>` survives, and the next
  // `worktree add` at that path refuses with "missing but already registered".
  // `prune` only drops entries whose working tree is gone, so it cannot touch a
  // live one — including this review's own.
  spawnSync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' });
  return sweep;
}

/** The residue probe's answer: what to name, and how much it left unnamed. */
export interface WorktreeResidue {
  /** The dirty paths, capped — every one of them safe to interpolate. */
  paths: string[];
  /**
   * How many the tree actually holds. `total > paths.length` means the cap bit,
   * and both renderers say so: a capped list presented as the complete one is a
   * verifier restoring twelve paths and leaving the thirteenth in the tree the
   * next round reads.
   */
  total: number;
  /**
   * Why the check could not run, when it could not. An empty list means "clean"
   * ONLY when this is absent: a `git status` that died — ENOBUFS on a tree so
   * dirty its output passed the buffer, a repository git refused to read — used
   * to be indistinguishable from a pristine tree, and the overload case is
   * exactly the one where the answer matters. Both renderers say "could not be
   * measured" instead of "clean" when this is set.
   */
  unmeasured?: string;
}

/**
 * The paths a tree carries that its HEAD commit does not — probe residue, seen
 * from the reading side (#9207).
 *
 * A review worktree is a pristine detached checkout of the PR head, and every
 * build artifact the review produces there is gitignored, so in a healthy run
 * this is empty. What it catches is the one thing that is neither: a file some
 * agent wrote into the shared tree, or a line it edited there, while the
 * pipelined loop had another agent reading the same tree. Named paths, not a
 * boolean — "the tree is dirty" tells a reader nothing it can act on, whereas
 * "these three paths are not in the commit" tells it exactly which of its
 * evidence to distrust.
 *
 * Three flags decide whether the names are usable, and every one of them was
 * wrong in the first cut:
 *
 * - `-z` because the names become COMMANDS. Porcelain's rendered form quotes a
 *   path with spaces or non-ASCII bytes (`"caf\303\251.ts"`) and writes a
 *   rename as `orig -> new`, so a file literally named `a -> b.ts` parsed to
 *   `b.ts"` — a name matching nothing on disk, handed to an agent as the path
 *   to run `git show HEAD:` against. The NUL format is unquoted and puts a
 *   rename's original path in its own record.
 * - `--untracked-files=all` because `normal` collapses a new directory to one
 *   `probe_dir/` entry, and every recovery this pipeline prints — `git show
 *   HEAD:`, `git checkout HEAD --` — fails on a directory. The contamination
 *   shape this exists to catch (an agent dropping probe files into a new
 *   folder) is exactly the shape `normal` renders unactionable. One directory
 *   shape survives the flag: git will not recurse into an untracked directory
 *   that holds its own `.git`, so a cloned fixture still arrives as a single
 *   `dir/` entry — detected and disclosed, but recoverable only by `rm -rf`,
 *   which is what both renderers tell the reader to use for untracked residue.
 * - `maxBuffer` because the default is 1 MB and `spawnSync` answers ENOBUFS by
 *   returning no stdout — which this function would have read as "clean". The
 *   overload case is the one where the tree is dirtiest.
 *
 * Ignored files are excluded (`node_modules`, `dist`: every review builds).
 * Empty on any git failure: this is a diagnostic, and a diagnostic that throws
 * would fail the build it is only commenting on.
 *
 * One limit the NUL format does not remove: `encoding: 'utf8'` maps an invalid
 * UTF-8 byte in a filename to U+FFFD, so such a path is reported but no longer
 * resolves on disk. No string form of it can — Node's fs API takes strings here
 * — so the name is disclosed as git rendered it rather than silently dropped.
 */
export function worktreeResidue(cwd: string, cap = 12): WorktreeResidue {
  const r = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '-z'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    const why = r.error
      ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message)
      : `git status exited ${r.status}`;
    return { paths: [], total: 0, unmeasured: why };
  }
  const records = r.stdout.split('\0').filter((rec) => rec.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // `XY <path>` — the status letters are noise to a reader; the path is what
    // it has to act on. A rename or copy spends a SECOND record on the ORIGINAL
    // path, and both names are reported: the destination is what sits in the
    // tree, and the original is what is missing from it, so a restore needs
    // both. Reporting only the destination left the reader with a `D <orig>`
    // it had never been given the name of.
    const status = rec.slice(0, 2);
    paths.push(rec.slice(3));
    if (
      (status.includes('R') || status.includes('C')) &&
      i + 1 < records.length
    ) {
      paths.push(records[++i]);
    }
  }
  return { paths: paths.slice(0, cap), total: paths.length };
}

/** What a dependency farm run did, and whether it found one already standing. */
export interface DependencyFarm {
  /** Packages symlinked in by THIS call. */
  linked: number;
  /** Packages this call could not link — disclosed, never silently dropped. */
  failed: number;
  /** True when a farm was already in place, so this call had nothing to link. */
  alreadyPresent: boolean;
}

/**
 * Make the dependency root's installed packages resolvable from a disposable
 * tree, by symlinking each `node_modules` entry into it.
 *
 * A fresh `git worktree add` has no `node_modules`, and a per-tree `npm ci`
 * costs minutes that neither the efficacy probe's budget nor a verifier's
 * patience has. So the packages are borrowed rather than installed: the tree
 * holds the CODE under test and reads its dependencies out of the tree that
 * already installed them.
 *
 * The root farm is not the whole job in a monorepo. npm hoists what it can, but
 * a version conflict leaves packages installed under the MEMBER
 * (`packages/cli/node_modules`), and Node resolves those by walking up from the
 * importing file — so a tree with only the root farm fails to resolve exactly
 * the dependency that could not be hoisted. Measured on this repo: a scratch
 * tree with 1 560 root packages linked still could not resolve
 * `@testing-library/react` for a UI probe, because that copy lives under
 * `packages/cli`. Each workspace member's farm is therefore built too, for the
 * members the disposable tree actually contains.
 *
 * Best-effort per entry, and deliberately so: one locked or concurrently
 * unlinked package must not throw out of the run that asked for the farm (for
 * the probe, that would re-class every mutant `inconclusive`). What could not
 * be linked is counted and disclosed by the caller, never silently dropped.
 *
 * Shared by `test-efficacy`'s `-probe` tree and `scratch-tree`'s per-verifier
 * tree, which is why it sits here rather than in either of them.
 */
export function exposeDependencies(
  probeTree: string,
  dependencyRoot: string,
): DependencyFarm {
  const done: DependencyFarm = { linked: 0, failed: 0, alreadyPresent: false };
  if (probeTree === dependencyRoot) return done;
  farmNodeModules(dependencyRoot, probeTree, done);
  let members: string[] = [];
  try {
    members = readWorkspacePackages(dependencyRoot).packages.map((p) => p.dir);
  } catch {
    // The workspace graph is an optimization on top of the root farm: a
    // manifest that will not read costs the tree its nested packages, never
    // the farm it already has.
  }
  for (const dir of members) {
    // Only for a member the disposable tree holds. A workspace the tree does
    // not contain has nothing to resolve FROM, and creating its directory just
    // to hang a `node_modules` off it would put a path in the tree that its
    // commit does not have.
    if (!existsSync(join(probeTree, dir))) continue;
    // Per member, not around the loop: one unreadable member used to abort the
    // walk, so every alphabetically later member silently went unfarmed while
    // `failed` stayed 0 and the caller reported success.
    try {
      farmNodeModules(join(dependencyRoot, dir), join(probeTree, dir), done);
    } catch {
      done.failed++;
    }
  }
  return done;
}

/**
 * The file a farm this code built leaves behind, so a later call can tell its
 * own work from anything else that happens to sit at that path.
 *
 * `node_modules` is gitignored, which is what lets a scratch tree's reset spare
 * it — and equally what lets a probe's own `npm install`, a killed install, or
 * a planted module stub survive that reset. Without a marker the reuse path
 * certified any non-empty directory as "the farm already in place", and every
 * later probe in that shard resolved its imports through whatever was there.
 */
const FARM_MARKER = '.qwen-review-farm';

/**
 * One directory's `node_modules`, mirrored entry by entry.
 *
 * A directory that already has one is left alone — the reuse path of a scratch
 * tree calls this again, and re-linking a farm that is already there would be
 * pure cost. That case is RECORDED rather than merely skipped: `{linked: 0,
 * failed: 0}` otherwise reads the same whether the farm was already standing or
 * the source had nothing to link (a killed `npm install` leaves a
 * `node_modules` holding one lockfile), and the two want opposite things said
 * to the verifier — "your harness is ready" versus "no harness will start
 * here".
 */
function farmNodeModules(
  sourceDir: string,
  targetDir: string,
  done: DependencyFarm,
): void {
  const source = join(sourceDir, 'node_modules');
  const target = join(targetDir, 'node_modules');
  if (!existsSync(source)) return;
  if (existsSync(target)) {
    // A standing farm counts only if THIS code built it: the marker is the
    // difference between "the packages I linked last time" and "whatever a
    // probe left in the one directory it is allowed to install into". Anything
    // else at that path is cleared and re-linked, because a probe's leftover
    // module resolving as a dependency is a wrong verdict with a deterministic
    // source tag on it.
    if (existsSync(join(target, FARM_MARKER))) {
      done.alreadyPresent = true;
      return;
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Cannot clear it: leave it, and report nothing linked rather than
      // claiming a farm this code did not build.
      done.failed++;
      return;
    }
  }
  try {
    mkdirSync(target);
  } catch {
    // Same best-effort contract as the per-entry steps below: a farm that
    // cannot be created costs a harness, and must not throw out of the run
    // that asked for it.
    done.failed++;
    return;
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  let entries: Dirent[];
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    // The source is the SHARED review worktree: a concurrent `npm ci` there can
    // unlink it between the `existsSync` above and this read.
    done.failed++;
    return;
  }
  const before = done.linked;
  for (const entry of entries) {
    if (entry.name === '.vite' || entry.name === '.vite-temp') continue;
    const sourceEntry = join(source, entry.name);
    const targetEntry = join(target, entry.name);
    // Every per-entry step is guarded: this is best-effort, so one locked or
    // concurrently-unlinked entry must not throw out of the probe run (which
    // would mark every probe `inconclusive`). What cannot be linked is counted
    // and disclosed by the caller — never silently dropped.
    let sourceStats: Stats;
    try {
      sourceStats = lstatSync(sourceEntry);
    } catch {
      done.failed++;
      continue;
    }
    if (sourceStats.isSymbolicLink()) {
      try {
        if (!statSync(sourceEntry).isDirectory()) continue;
      } catch {
        continue;
      }
    } else if (!sourceStats.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith('@')) {
      let pkgs: string[];
      try {
        mkdirSync(targetEntry);
        pkgs = readdirSync(sourceEntry);
      } catch {
        done.failed++;
        continue;
      }
      for (const pkg of pkgs) {
        try {
          symlinkSync(join(sourceEntry, pkg), join(targetEntry, pkg), linkType);
          done.linked++;
        } catch {
          done.failed++;
        }
      }
    } else {
      try {
        symlinkSync(sourceEntry, targetEntry, linkType);
        done.linked++;
      } catch {
        done.failed++;
      }
    }
  }
  // Marked only when something was actually linked. A farm of zero packages is
  // not one a later call should reuse — the killed-install shape (a
  // `node_modules` holding one lockfile) produces exactly that, and certifying
  // it sends the verifier into a `vitest: not found` the note promised it had
  // avoided.
  if (done.linked > before) {
    try {
      writeFileSync(join(target, FARM_MARKER), `${resolve(sourceDir)}\n`);
    } catch {
      // No marker: the next call rebuilds the farm. Costly, never wrong.
    }
  }
}

/**
 * The reason a disposable worktree could not be created.
 *
 * The stale-sweep's stderr is folded in because it is usually the explanation:
 * when `add` fails on a leftover the sweep could not clear, the sweep is what
 * says why. Pure, and extracted for that reason — the branch it lives on fires
 * only when `git worktree add` fails, and there is no portable way to force that
 * in a real-git test (the one lever, making `.git/worktrees` unwritable, is
 * bypassed by root and behaves differently under CI's unprivileged user).
 */
export function worktreeCreateFailureDetail(
  label: string,
  err: unknown,
  sweepStderr: string,
): string {
  const sweepErr = sweepStderr.trim();
  return (
    `${label} worktree could not be created: ${err instanceof Error ? err.message : String(err)}` +
    (sweepErr ? ` (stale-tree sweep also reported: ${sweepErr})` : '')
  );
}

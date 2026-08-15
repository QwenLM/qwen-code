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
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
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
  return sweep;
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
 * Ignored files are excluded (`node_modules`, `dist`: every review builds), and
 * the list is capped — a caller renders it into a prompt, and an unbounded list
 * from a tree someone ran a full build in would push out the brief around it.
 * Empty on any git failure: this is a diagnostic, and a diagnostic that throws
 * would fail the build it is only commenting on.
 */
export function worktreeResidue(cwd: string, cap = 12): string[] {
  const r = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    { cwd, encoding: 'utf8' },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return [];
  return (
    r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // `XY path` — and `XY orig -> path` for a rename. The path half is what a
      // reader needs; the status letters are noise to it.
      .map((line) => {
        const rest = line.slice(line.indexOf(' ') + 1).trim();
        const arrow = rest.lastIndexOf(' -> ');
        return arrow === -1 ? rest : rest.slice(arrow + 4);
      })
      .slice(0, cap)
  );
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
): { linked: number; failed: number } {
  const done = { linked: 0, failed: 0 };
  if (probeTree === dependencyRoot) return done;
  farmNodeModules(dependencyRoot, probeTree, done);
  try {
    for (const pkg of readWorkspacePackages(dependencyRoot).packages) {
      // Only for a member the disposable tree holds. A workspace the tree does
      // not contain has nothing to resolve FROM, and creating its directory
      // just to hang a `node_modules` off it would put a path in the tree that
      // its commit does not have.
      if (!existsSync(join(probeTree, pkg.dir))) continue;
      farmNodeModules(
        join(dependencyRoot, pkg.dir),
        join(probeTree, pkg.dir),
        done,
      );
    }
  } catch {
    // The workspace graph is an optimization on top of the root farm: a
    // manifest that will not read costs the tree its nested packages, never
    // the farm it already has.
  }
  return done;
}

/**
 * One directory's `node_modules`, mirrored entry by entry.
 *
 * A directory that already has one is left alone — the reuse path of a scratch
 * tree calls this again, and re-linking a farm that is already there would be
 * pure cost.
 */
function farmNodeModules(
  sourceDir: string,
  targetDir: string,
  done: { linked: number; failed: number },
): void {
  const source = join(sourceDir, 'node_modules');
  const target = join(targetDir, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return;
  mkdirSync(target);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const entry of readdirSync(source, { withFileTypes: true })) {
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

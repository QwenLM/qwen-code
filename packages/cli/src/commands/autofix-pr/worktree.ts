/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The checks every helper that writes from the autofix worktree makes first.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { gitOpt, gitProbe } from '../review/lib/git.js';
import type { AutofixPrPaths } from './state.js';

/**
 * Throws unless the watch's worktree is a git worktree of its own, at its
 * own path, with the watch's branch checked out. Inside a directory that is
 * not a worktree, git finds the enclosing clone; through a symlink, another
 * checkout; on another branch — the user's copy of the PR branch, say — a
 * push would publish that branch's commits and a reset would discard them.
 */
export function requireWorktree(paths: AutofixPrPaths, prNumber: number): void {
  const worktreePath = paths.worktreePath;
  if (!existsSync(worktreePath)) {
    throw new Error(
      `${worktreePath} does not exist; run \`qwen autofix-pr prepare ${prNumber} --repo <owner>/<repo>\` to recreate it.`,
    );
  }
  if (lstatSync(worktreePath).isSymbolicLink()) {
    throw new Error(`${worktreePath} is a symlink, not the watch's worktree.`);
  }
  const top = gitOpt('-C', worktreePath, 'rev-parse', '--show-toplevel');
  if (top === null || realpathSync(top) !== realpathSync(worktreePath)) {
    throw new Error(`${worktreePath} is not a git worktree.`);
  }
  const branch = gitOpt('-C', worktreePath, 'symbolic-ref', '-q', 'HEAD');
  if (branch !== `refs/heads/${paths.branch}`) {
    throw new Error(
      `${worktreePath} has ${branch ? branch.replace(/^refs\/heads\//, 'branch ') : 'a detached HEAD'} checked out, not ${paths.branch}; switch it back before pushing or syncing.`,
    );
  }
}

/**
 * Whether the worktree has anything uncommitted, untracked files included
 * whatever `status.showUntrackedFiles` says.
 */
export function hasUncommittedChanges(worktreePath: string): boolean {
  const status = gitOpt(
    '-C',
    worktreePath,
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  );
  if (status === null) throw new Error(`git cannot read ${worktreePath}`);
  return status !== '';
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `descendant`, asked in
 * the worktree. Exit 1 is git's "no"; anything else means it could not tell.
 */
export function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): boolean {
  const { status } = gitProbe(
    '-C',
    worktreePath,
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  );
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(
    `git cannot compare ${ancestor.slice(0, 12)} with ${descendant.slice(0, 12)} in ${worktreePath}`,
  );
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runGit } from './git-branches.js';

export interface GitWorktreeEntry {
  /** Absolute path as git records it. */
  path: string;
  head: string;
  /** Short branch name; `null` when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Present when the worktree is locked; the reason when git recorded one. */
  locked?: string;
  /** Present when git would prune the entry (its directory is gone). */
  prunable?: string;
  /** The repository's main worktree, which git lists first and never removes. */
  isMain: boolean;
}

function attribute(line: string, key: string): string | undefined {
  if (line === key) return '';
  return line.startsWith(`${key} `) ? line.slice(key.length + 1) : undefined;
}

/** Parse `git worktree list --porcelain -z` output. */
export function parseGitWorktreeList(raw: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of raw.split('\0')) {
    if (line === '') {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const worktreePath = attribute(line, 'worktree');
    if (worktreePath !== undefined) {
      current = {
        path: worktreePath,
        head: '',
        branch: null,
        detached: false,
        bare: false,
        isMain: entries.length === 0,
      };
      continue;
    }
    if (!current) continue;
    const head = attribute(line, 'HEAD');
    const branch = attribute(line, 'branch');
    const locked = attribute(line, 'locked');
    const prunable = attribute(line, 'prunable');
    if (head !== undefined) current.head = head;
    else if (branch !== undefined)
      current.branch = branch.replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (locked !== undefined) current.locked = locked;
    else if (prunable !== undefined) current.prunable = prunable;
  }
  if (current) entries.push(current);
  return entries;
}

/** List every worktree of the repository containing `cwd`, main first. */
export async function listGitWorktrees(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitWorktreeEntry[]> {
  const raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'], env);
  return parseGitWorktreeList(raw);
}

/**
 * Remove a linked worktree. Without `force` git refuses a worktree with
 * uncommitted changes or a lock; callers decide when to override.
 */
export async function removeGitWorktree(
  cwd: string,
  worktreePath: string,
  options: { force?: boolean } = {},
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(
    cwd,
    [
      'worktree',
      'remove',
      ...(options.force ? ['--force', '--force'] : []),
      '--',
      worktreePath,
    ],
    env,
  );
}

/** Drop worktree entries whose directories no longer exist. */
export async function pruneGitWorktrees(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(cwd, ['worktree', 'prune'], env);
}

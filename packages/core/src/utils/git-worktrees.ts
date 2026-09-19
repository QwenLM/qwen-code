/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit, runGitCapture } from './git-branches.js';
import { NO_EXEC_CONFIG } from './gitUtils.js';

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
  /**
   * Present when git has marked the entry stale: its directory is gone, or
   * the directory outlived its gitfile. git never marks a locked one.
   */
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
  const raw = await runGit(
    cwd,
    [...NO_EXEC_CONFIG, 'worktree', 'list', '--porcelain', '-z'],
    env,
  );
  return parseGitWorktreeList(raw);
}

/**
 * Remove one linked worktree, and only that one.
 *
 * Without `force` git refuses a worktree with uncommitted changes or a lock;
 * callers decide when to override. A worktree whose directory has already
 * disappeared is dropped without `force`, because git validates `<path>/.git`
 * only when the directory is there to validate — which is also why this
 * rejects, at every force level, a registration git can no longer validate:
 * a directory that outlived its gitfile (`fatal: validation failed …
 * '<path>/.git' does not exist`), a `.git` that is not a gitfile, or one
 * pointing at another repository. {@link pruneGitWorktrees} clears the first
 * of those; the rest need a hand at a terminal.
 */
export async function removeGitWorktree(
  cwd: string,
  worktreePath: string,
  options: { force?: boolean } = {},
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  // A worktree's own repository chooses `core.fsmonitor`, and git refreshes
  // the index — running it — on the status check the non-forced removal
  // makes. The shared `runGit` these go through does not scrub those keys,
  // so every git call in this file passes them itself; closing it in
  // `runGit` would cover the branch and remote helpers too.
  await runGit(
    cwd,
    [
      ...NO_EXEC_CONFIG,
      'worktree',
      'remove',
      ...(options.force ? ['--force', '--force'] : []),
      '--',
      worktreePath,
    ],
    env,
  );
}

/**
 * Whether any branch, remote-tracking branch or tag contains `commit`.
 *
 * A detached worktree is the only thing pointing at its own HEAD, so removing
 * it can be the last reference to those commits. Refs are shared across a
 * repository's worktrees, so this asks from anywhere in it.
 */
export async function commitIsReachable(
  cwd: string,
  commit: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const out = await runGit(
    cwd,
    [
      ...NO_EXEC_CONFIG,
      'for-each-ref',
      '--count=1',
      '--contains',
      commit,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    env,
  );
  return out.trim().length > 0;
}

/**
 * Whether this worktree holds initialised submodules.
 *
 * A submodule checked out inside a worktree keeps its own repository under
 * the worktree's admin directory, and a forced removal deletes that with
 * everything else — including commits made in the submodule that the
 * superproject's branch still names.
 */
export async function worktreeHoldsSubmodules(
  worktreePath: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const out = await runGit(
    worktreePath,
    [...NO_EXEC_CONFIG, 'submodule', 'status'],
    env,
  );
  // git prefixes an uninitialised submodule with `-`; anything else is one
  // with a repository of its own on disk.
  return out
    .split('\n')
    .some((line) => line.trim().length > 0 && !line.startsWith('-'));
}

/**
 * The registrations `git worktree prune` would drop, by admin-directory name.
 *
 * `git worktree list` is not the same set: a registration whose `gitdir` file
 * is missing or empty is absent from the listing, cannot be locked, and is
 * dropped by prune all the same — taking the HEAD and reflog that may be the
 * last anchor for commits no ref contains. This asks git what it would do
 * rather than inferring it from what it shows.
 */
export async function dryRunGitWorktreePrune(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Array<{ id: string; worktreePath: string | null }>> {
  // `-v` reports on stderr, so reading stdout alone would answer "nothing".
  const { stdout, stderr } = await runGitCapture(
    cwd,
    [...NO_EXEC_CONFIG, 'worktree', 'prune', '-n', '-v'],
    env,
  );
  const named = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => /^Removing worktrees\/([^:]+):/.exec(line.trim())?.[1])
    .filter((id): id is string => id !== undefined);
  if (named.length === 0) return [];
  // Anything in that directory which is not a directory is a stray file —
  // a `.DS_Store`, a half-written temporary — and prune names it too. It
  // holds no registration and no commits, so counting it would fail a
  // removal for a reason that has nothing to do with any worktree.
  const commonDir = (
    await runGit(cwd, [...NO_EXEC_CONFIG, 'rev-parse', '--git-common-dir'], env)
  ).trim();
  const admin = path.resolve(cwd, commonDir, 'worktrees');
  const entries: Array<{ id: string; worktreePath: string | null }> = [];
  for (const id of named) {
    let dir;
    try {
      dir = fs.statSync(path.join(admin, id));
    } catch {
      entries.push({ id, worktreePath: null });
      continue;
    }
    if (!dir.isDirectory()) continue;
    // An entry with nothing in it holds no back-pointer, no HEAD and no
    // reflog, so it is litter in the same sense a stray file is. One that has
    // lost only its `gitdir` still holds the commits this exists to protect.
    try {
      if (fs.readdirSync(path.join(admin, id)).length === 0) continue;
    } catch {
      // Unreadable: treated as a registration, which fails closed.
    }
    // The admin side records the worktree it belongs to, and keeps doing so
    // after the worktree's own gitfile is gone — which is the whole shape
    // this fallback exists for. A caller can therefore tell whether the one
    // entry prune would drop is the one it asked about, rather than trusting
    // that a count of one means the right one.
    let worktreePath: string | null = null;
    try {
      const back = fs.readFileSync(path.join(admin, id, 'gitdir'), 'utf8');
      const gitfile = back.trim();
      if (gitfile) worktreePath = path.dirname(path.resolve(cwd, gitfile));
    } catch {
      // No back-pointer to read; the caller treats that as "not mine".
    }
    entries.push({ id, worktreePath });
  }
  return entries;
}

/** Take git's own lock on a worktree, which prune then skips. */
export async function lockGitWorktree(
  cwd: string,
  worktreePath: string,
  reason: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(
    cwd,
    [
      ...NO_EXEC_CONFIG,
      'worktree',
      'lock',
      '--reason',
      reason,
      '--',
      worktreePath,
    ],
    env,
  );
}

/** Release {@link lockGitWorktree}. */
export async function unlockGitWorktree(
  cwd: string,
  worktreePath: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(
    cwd,
    [...NO_EXEC_CONFIG, 'worktree', 'unlock', '--', worktreePath],
    env,
  );
}

/**
 * Drop every registration git has already marked prunable.
 *
 * Repository-wide by nature: git offers no per-path form, so this is the last
 * resort for the registrations {@link removeGitWorktree} cannot clear and git
 * has marked prunable. It deletes no files — a directory that outlived its
 * gitfile keeps its contents — and it skips locked worktrees, which git never
 * marks prunable anyway.
 */
export async function pruneGitWorktrees(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(cwd, [...NO_EXEC_CONFIG, 'worktree', 'prune'], env);
}

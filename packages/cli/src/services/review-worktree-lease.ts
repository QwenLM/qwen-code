// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import {
  LEASE_PREFIX,
  REVIEW_TMP_DIR,
  REVIEW_LEASE_DIR,
  reviewBranch,
} from '../commands/review/lib/paths.js';

const GIT_TIMEOUT_MS = 120_000;
const debugLogger = createDebugLogger('REVIEW_WORKTREE_LEASE');

function gitOptions(timeout: number) {
  return {
    stdio: 'ignore' as const,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  };
}

function validTarget(target: string): boolean {
  return /^pr-\d+$/.test(target);
}

/**
 * Whether a filename under `REVIEW_LEASE_DIR` is a review-worktree lease.
 * Derived from `validTarget` so the writer, `cleanup`'s sweep guard, and the
 * `cleanupReviewWorktreeLeases` scan share one definition of the lease shape
 * (see the `LEASE_PREFIX` comment in `lib/paths.ts`).
 */
export function isReviewLeaseFile(fileName: string): boolean {
  if (!fileName.startsWith(LEASE_PREFIX) || !fileName.endsWith('.json')) {
    return false;
  }
  const target = fileName.slice(
    LEASE_PREFIX.length,
    fileName.length - '.json'.length,
  );
  return validTarget(target);
}

export interface ReviewWorktreeLease {
  sessionId: string;
  promptId: string;
  target: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
}

function leaseDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, REVIEW_LEASE_DIR);
}

/**
 * Where leases lived before they moved out of the mounted directory. Still
 * READ as well as deleted, for one release: a runner whose workspace persists
 * can be holding a live lock an older build wrote here.
 */
function legacyLeasePath(repositoryRoot: string, target: string): string {
  return join(repositoryRoot, REVIEW_TMP_DIR, `${LEASE_PREFIX}${target}.json`);
}

function leasePath(repositoryRoot: string, target: string): string {
  return join(leaseDirectory(repositoryRoot), `${LEASE_PREFIX}${target}.json`);
}

/** Absolute path of the lease file recording who holds a review target. */
export function reviewLeasePath(
  repositoryRoot: string,
  target: string,
): string {
  return leasePath(resolve(repositoryRoot), target);
}

export function clearReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): void {
  if (!validTarget(target)) return;
  rmSync(leasePath(resolve(repositoryRoot), target), { force: true });
}

/**
 * Remove the lease only when the caller wrote it. fetch-pr's failure-path
 * rollback must never erase a lease another session acquired DURING the run —
 * the documented manual-recovery shape: an operator deletes a stuck run's
 * lease, a new session acquires, then the stuck run un-sticks, fails, and
 * would blind-delete the new holder's lock.
 */
export function clearReviewWorktreeLeaseIfOwned(
  repositoryRoot: string,
  target: string,
  owner: { sessionId: string; promptId: string },
): void {
  const lease = readReviewWorktreeLease(repositoryRoot, target);
  if (
    !lease ||
    lease.sessionId !== owner.sessionId ||
    lease.promptId !== owner.promptId
  ) {
    return;
  }
  clearReviewWorktreeLease(repositoryRoot, target);
}

export function createReviewWorktreeLease(params: {
  sessionId: string | undefined;
  promptId: string | undefined;
  target: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
}): void {
  if (!params.sessionId || !params.promptId || !validTarget(params.target)) {
    return;
  }

  const repositoryRoot = resolve(params.repositoryRoot);
  const lease: ReviewWorktreeLease = {
    sessionId: params.sessionId,
    promptId: params.promptId,
    target: params.target,
    repositoryRoot,
    worktreePath: resolve(repositoryRoot, params.worktreePath),
    branch: params.branch,
  };
  const data = `${JSON.stringify(lease, null, 2)}\n`;
  const path = leasePath(repositoryRoot, params.target);
  mkdirSync(leaseDirectory(repositoryRoot), { recursive: true });
  // A lease written by a build from before the move would sit in the mounted
  // directory forever, because the sweep still skips the lease shape. Remove
  // the one this call supersedes, and only that one — which is NOT one another
  // session is holding: the gate read above now sees it and `fetch-pr` refuses
  // before getting here, so this is the second half of the same answer. Taking
  // the lock anyway would leave two leases for one target, and the older
  // session's rollback would clear nothing while this run swept its tree.
  const legacy = legacyLeasePath(repositoryRoot, params.target);
  const legacyLease = readLease(legacy);
  if (legacyLease !== null && legacyLease.sessionId !== params.sessionId) {
    throw new Error(
      `review worktree lease for ${params.target} is held by another ` +
        `session (session ${legacyLease.sessionId}) at the pre-move path ` +
        `${legacy} — an older build acquired it; retry`,
    );
  }
  //
  // `recursive`, because `force` only swallows ENOENT. That path is in the
  // one directory reviewed code can still write, and a DIRECTORY at the
  // lease's name would otherwise throw EISDIR out of here on every future
  // acquisition — `mkdir .qwen/tmp/qwen-review-lease-pr-<n>.json` is a
  // one-command permanent wedge on that PR, and nothing else removes it: the
  // rollback rethrows, the sweep skips the lease shape, and `rm -f` cannot
  // remove a directory. A directory parses to no lease, so the check above
  // still lets this remove it.
  rmSync(legacy, { force: true, recursive: true });
  try {
    // `flag: 'wx'` fails EEXIST instead of overwriting: two concurrent
    // fetch-prs can both pass the gate's read, and a plain write would let
    // the second clobber the winner's lease — after which the loser's
    // rollback deletes a lock it never owned. Same atomic-create shape as
    // `ensureWorktreesGitignored` in core's gitWorktreeService.
    writeFileSync(path, data, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readLease(path);
    if (existing && existing.sessionId !== params.sessionId) {
      throw new Error(
        `review worktree lease for ${params.target} is held by another ` +
          `session (session ${existing.sessionId}); it was acquired ` +
          `between the gate read and the lease write — retry`,
      );
    }
    // Same-session re-fetch refreshes the lease (ownership is per session,
    // not per prompt). An unreadable file is already read as no lease by
    // every reader, so rewriting it heals a torn write instead of wedging.
    writeFileSync(path, data, 'utf8');
  }
}

function readLease(path: string): ReviewWorktreeLease | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ReviewWorktreeLease;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.promptId !== 'string' ||
      typeof value.target !== 'string' ||
      typeof value.repositoryRoot !== 'string' ||
      typeof value.worktreePath !== 'string' ||
      typeof value.branch !== 'string'
    ) {
      return null;
    }
    return value;
  } catch (error) {
    debugLogger.debug(`Failed to read review lease ${path}:`, error);
    return null;
  }
}

/** The lease currently registered for a review target, or null. */
export function readReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): ReviewWorktreeLease | null {
  if (!validTarget(target)) return null;
  const root = resolve(repositoryRoot);
  // BOTH locations, for one release. The move changed where this reads with no
  // fallback for the population already on disk, so for the length of a rollout
  // a lock an older build was holding was invisible to the gate:
  // `reviewLeaseHeldByAnotherSession(null)` answers false, the newer run
  // proceeds, its acquisition deletes the older session's live lock, and
  // `cleanStale` force-removes its worktree and deletes its branch mid-run —
  // #9205, the incident this lease exists to prevent, with the older session's
  // rollback then clearing nothing so the destruction goes unannounced.
  //
  // A READ only, never a second write path: `flag: 'wx'` in
  // `createReviewWorktreeLease` is what makes acquisition atomic, and writing
  // at the legacy path too would give that guarantee up.
  return (
    readLease(leasePath(root, target)) ??
    readLease(legacyLeasePath(root, target))
  );
}

/**
 * Whether a lease blocks THIS process from taking the target over.
 *
 * The review worktree path is fixed per PR number, so two reviews of the same
 * PR run on top of each other: whichever runs `fetch-pr`'s stale-clean or
 * `cleanup` next removes the other's worktree, branch, and side files mid-run
 * (#9205). The lease doubles as the lock against that — holders compare by
 * SESSION, not prompt: one session reviews a PR across several prompts
 * (rounds, drift restarts), and a later prompt of the same session must be
 * able to re-take what its own earlier prompt leased. A process with no
 * session id cannot prove ownership of anything, so any existing lease blocks
 * it — a bare-terminal `cleanup` must not delete a live session's state.
 */
export function reviewLeaseHeldByAnotherSession(
  lease: ReviewWorktreeLease | null,
): lease is ReviewWorktreeLease {
  if (!lease) return false;
  const sessionId = process.env['QWEN_CODE_SESSION_ID']?.trim();
  return !sessionId || lease.sessionId !== sessionId;
}

function removeLeaseWorktree(
  lease: ReviewWorktreeLease,
  gitTimeout: number,
): boolean {
  const prMatch = /^pr-(\d+)$/.exec(lease.target);
  if (!prMatch || lease.branch !== reviewBranch(prMatch[1])) {
    debugLogger.debug(`Rejected invalid review lease ${lease.target}`);
    return false;
  }

  const repositoryRoot = resolve(lease.repositoryRoot);
  const worktreePath = resolve(lease.worktreePath);
  const reviewTmpRoot = resolve(repositoryRoot, REVIEW_TMP_DIR);
  const worktreeRelative = relative(reviewTmpRoot, worktreePath);
  if (
    worktreeRelative === '' ||
    worktreeRelative.startsWith('..') ||
    isAbsolute(worktreeRelative)
  ) {
    debugLogger.debug(
      `Rejected review lease outside ${REVIEW_TMP_DIR}: ${worktreePath}`,
    );
    return false;
  }

  try {
    execFileSync(
      'git',
      ['-C', repositoryRoot, 'worktree', 'remove', worktreePath, '--force'],
      gitOptions(gitTimeout),
    );
  } catch (error) {
    debugLogger.debug(
      `Git failed to remove review worktree ${lease.target}:`,
      error,
    );
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'worktree', 'prune'],
        gitOptions(gitTimeout),
      );
    } catch (fallbackError) {
      debugLogger.debug(
        `Fallback failed to remove review worktree ${lease.target}:`,
        fallbackError,
      );
      return false;
    }
  }

  let branchExists = true;
  try {
    execFileSync(
      'git',
      [
        '-C',
        repositoryRoot,
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${lease.branch}`,
      ],
      gitOptions(gitTimeout),
    );
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) {
      debugLogger.debug(
        `Failed to inspect review branch ${lease.branch}:`,
        error,
      );
      return false;
    }
    branchExists = false;
  }
  if (branchExists) {
    try {
      execFileSync(
        'git',
        ['-C', repositoryRoot, 'branch', '-D', lease.branch],
        gitOptions(gitTimeout),
      );
    } catch (error) {
      debugLogger.debug(
        `Failed to delete review branch ${lease.branch}:`,
        error,
      );
      return false;
    }
  }
  return !existsSync(worktreePath);
}

export function cleanupReviewWorktreeLeases(params: {
  sessionId: string;
  promptId: string;
  repositoryRoot: string;
  gitTimeout?: number;
}): void {
  try {
    const repositoryRoot = resolve(params.repositoryRoot);
    const directory = leaseDirectory(repositoryRoot);
    if (!existsSync(directory)) return;

    for (const entry of readdirSync(directory)) {
      if (!isReviewLeaseFile(entry)) continue;
      const path = join(directory, basename(entry));
      const lease = readLease(path);
      if (
        !lease ||
        lease.sessionId !== params.sessionId ||
        lease.promptId !== params.promptId ||
        resolve(lease.repositoryRoot) !== repositoryRoot
      ) {
        continue;
      }
      if (removeLeaseWorktree(lease, params.gitTimeout ?? GIT_TIMEOUT_MS)) {
        rmSync(path, { force: true });
      }
    }
  } catch (error) {
    debugLogger.debug('Failed to clean up review worktree leases:', error);
  }
}

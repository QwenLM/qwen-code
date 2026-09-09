// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
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

/**
 * The date the lease move out of `.qwen/tmp` landed on `main` — pinned to
 * a date that has already passed, never a guessed future release date: a
 * cutoff in the future honors every plant written before it, which is the
 * shape this bound exists to deny. A legacy-path lease is honored in
 * gate/acquisition reads only while its mtime says it was written before
 * this date: the legacy path lives in the one directory reviewed code can
 * still write, so a lease-shaped file appearing there after the move could
 * equally be a plant naming a foreign session, and honoring it would hand
 * that writable surface a permanent denial of service against the pipeline
 * meant to distrust it.
 *
 * One-release-window semantics: mirrors new builds write at the legacy path
 * are for OLD builds' benefit (old builds read the legacy path directly,
 * without this bound), so the mirror and the bound do not conflict. The
 * residual window this accepts: an old build acquiring AFTER this date on a
 * machine no new build has mirrored on yet writes a fresh-mtime legacy lease
 * that cannot be distinguished from a plant, and new builds will not honor
 * it. mtime is the only signal available at that path, and reviewed code can
 * backdate it with `utimes` — a forged-mtime plant is the other residual
 * this bound cannot close.
 */
export const LEGACY_LEASE_CUTOFF_MS = Date.UTC(2026, 8, 9);

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
  const root = resolve(repositoryRoot);
  rmSync(leasePath(root, target), { force: true });
  // The pre-move path too, for the same one-release window the read fallback
  // covers: a stale legacy lease would otherwise wedge this target for old
  // builds forever — nothing else removes it, and a recovery instruction
  // naming only the new path deletes a file that does not exist. `recursive`
  // because a DIRECTORY at the lease's name would throw EISDIR (the
  // acquisition-side wedge shape); `force` because absence is the common
  // case. Deletion only — the mirror in `createReviewWorktreeLease` is the
  // sole legacy write path.
  rmSync(legacyLeasePath(root, target), { force: true, recursive: true });
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
  // A pre-move lease still holding this target blocks acquisition exactly as
  // a new-path one does: taking the lock anyway would leave two leases for
  // one target, and the older session's rollback would clear nothing while
  // this run swept its tree. The bounded read is what keeps it safe to ask
  // the question at a path inside the mounted directory: a legacy file
  // younger than LEGACY_LEASE_CUTOFF_MS answers "no lease" here, so a plant
  // naming a foreign session cannot turn this throw into a denial of
  // service — acquisition proceeds and the mirror below replaces the plant.
  const legacy = legacyLeasePath(repositoryRoot, params.target);
  const legacyLease = readLegacyLease(legacy);
  if (legacyLease !== null && legacyLease.sessionId !== params.sessionId) {
    throw new Error(
      `review worktree lease for ${params.target} is held by another ` +
        `session (session ${legacyLease.sessionId}) at the pre-move path ` +
        `${legacy} — an older build acquired it; retry`,
    );
  }
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
          `session (session ${existing.sessionId}) at ${path}; it was ` +
          `acquired between the gate read and the lease write — retry`,
      );
    }
    // Same-session re-fetch refreshes the lease (ownership is per session,
    // not per prompt). An unreadable file is already read as no lease by
    // every reader, so rewriting it heals a torn write instead of wedging.
    writeFileSync(path, data, 'utf8');
  }
  mirrorLeaseAtLegacyPath(legacy, path, data, params.sessionId, params.target);
}

/**
 * Mirror the just-acquired lease at the pre-move path, for the one release
 * the read fallback assumes old builds exist in: a pre-move build reads ONLY
 * that path, so without the mirror its fetch-pr passes its own gate over
 * this live lease and its cleanStale force-removes this session's worktree
 * and deletes its branch mid-run — #9205 in the mirrored direction, and
 * unannounced, because this session's rollback clears only the new path.
 *
 * The mirror is NEVER an arbiter or a second acquisition path: it is written
 * only after the new-path `wx` write has won, and new builds grant a
 * fresh-mtime legacy file no gate authority (LEGACY_LEASE_CUTOFF_MS), so
 * this write hands the mounted directory no authority over new builds. An
 * EEXIST that reads as another session's honored lease backs the whole
 * acquisition out rather than clobbering a concurrent writer's lock.
 */
function mirrorLeaseAtLegacyPath(
  legacy: string,
  path: string,
  data: string,
  sessionId: string,
  target: string,
): void {
  mkdirSync(dirname(legacy), { recursive: true });
  try {
    writeFileSync(legacy, data, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readLegacyLease(legacy);
    if (existing && existing.sessionId !== sessionId) {
      // An honored pre-move lease surfaced between the gate read and this
      // mirror: an older build that cannot see the new path at all now
      // believes it holds the target, so this run must back out entirely —
      // release the new-path lease instead of leaving two sessions each
      // believing the target is theirs.
      rmSync(path, { force: true });
      throw new Error(
        `review worktree lease for ${target} is held by another ` +
          `session (session ${existing.sessionId}) at the pre-move path ` +
          `${legacy} — an older build acquired it between the gate read ` +
          `and the lease write; retry`,
      );
    }
    // Every other EEXIST is safe to overwrite: this session racing its own
    // earlier mirror, a fresh-mtime plant the cutoff declines to honor, or
    // a non-regular wedge (readLease has already removed a DIRECTORY at the
    // lease name, so this plain write also heals the EISDIR shape).
    writeFileSync(legacy, data, 'utf8');
  }
}

function readLease(path: string): ReviewWorktreeLease | null {
  try {
    // lstat BEFORE any open: either lease path can carry a planted FIFO —
    // the legacy one sits in the one directory reviewed code can still
    // write — and `readFileSync` blocks in open(2) on a FIFO with no
    // timeout, so no catch below could ever run and every gate read of the
    // target would hang forever. A non-regular file (FIFO, directory,
    // socket) cannot be a lease: treat it as none and remove it, because
    // nothing else will — a DIRECTORY at the lease's name otherwise keeps
    // throwing EISDIR at every non-recursive removal (the wedge shape the
    // recursive removes elsewhere in this file exist to escape).
    if (!lstatSync(path).isFile()) {
      rmSync(path, { force: true, recursive: true });
      return null;
    }
  } catch (error) {
    // ENOENT is the ordinary "no lease" answer; anything else (a removal
    // racing the lstat) is also read as no lease, the same torn-write
    // healing the parse catch below performs.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.debug(`Failed to inspect review lease ${path}:`, error);
    }
    return null;
  }
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

/**
 * The legacy-path read for GATE authority: a parseable lease there speaks
 * only when its mtime says it predates the first build carrying the move —
 * see LEGACY_LEASE_CUTOFF_MS. Goes through `readLease` first so a planted
 * non-regular file is still removed rather than merely ignored.
 */
function readLegacyLease(path: string): ReviewWorktreeLease | null {
  const lease = readLease(path);
  if (!lease) return null;
  try {
    if (lstatSync(path).mtimeMs > LEGACY_LEASE_CUTOFF_MS) return null;
  } catch {
    return null;
  }
  return lease;
}

/** The lease currently registered for a review target, or null. */
export function readReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): ReviewWorktreeLease | null {
  return readReviewWorktreeLeaseAt(repositoryRoot, target)?.lease ?? null;
}

/**
 * The lease currently registered for a review target AND the path it was
 * found at. A recovery instruction must name the file that actually holds
 * the lock: during the one-release rollout that can be the pre-move path,
 * and "delete <new path> and re-run" then points an operator at a file
 * that does not exist while the wedge stands.
 */
export function readReviewWorktreeLeaseAt(
  repositoryRoot: string,
  target: string,
): { lease: ReviewWorktreeLease; path: string } | null {
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
  // The legacy read stays a READ, bounded by LEGACY_LEASE_CUTOFF_MS so a
  // fresh-mtime file inside the mounted directory exercises no gate
  // authority. New builds' only legacy WRITE is the acquisition mirror in
  // `createReviewWorktreeLease`, which exists solely so pre-move builds —
  // reading only the legacy path, without the bound — can see the lock
  // during the rollout; the new-path `wx` remains the one atomic
  // acquisition.
  const current = leasePath(root, target);
  const lease = readLease(current);
  if (lease) return { lease, path: current };
  const legacy = legacyLeasePath(root, target);
  const legacyLease = readLegacyLease(legacy);
  return legacyLease ? { lease: legacyLease, path: legacy } : null;
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

/**
 * Parsed-content equality: two lease files record the same lease regardless
 * of formatting. The finalizer's mirror check keys on this rather than raw
 * bytes so a genuinely identical mirror always passes.
 */
function sameLease(
  a: ReviewWorktreeLease,
  b: ReviewWorktreeLease | null,
): boolean {
  return (
    b !== null &&
    a.sessionId === b.sessionId &&
    a.promptId === b.promptId &&
    a.target === b.target &&
    a.repositoryRoot === b.repositoryRoot &&
    a.worktreePath === b.worktreePath &&
    a.branch === b.branch
  );
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
    const newLeaseDirectory = leaseDirectory(repositoryRoot);
    // The pre-move directory too, for the same one-release window: this
    // build's own acquisition mirrors live there. It is scanned FIRST
    // because the mirror check below reads the new-path lease, which the
    // new-directory leg deletes when it finalizes.
    //
    // Acting on mounted-directory content is safe ONLY through the mirror
    // check: the mirror is READABLE from inside the mount, so reviewed code
    // can copy its sessionId/promptId into a planted lease naming a victim
    // worktreePath (the A/B base tree, a sibling shard's worktree) and pass
    // every ownership field below. Only equality with the new-path lease —
    // outside the mount, undoctorable from there — proves acquisition wrote
    // the content, so a plant is ignored, never wielded. A legacy lease
    // with no new-path twin fails the same check; that is the deliberate
    // cost of trusting nothing that lives only inside the mount.
    for (const directory of [
      join(repositoryRoot, REVIEW_TMP_DIR),
      newLeaseDirectory,
    ]) {
      if (!existsSync(directory)) continue;

      // Each leg fails alone: the pre-move directory lives inside the mount
      // reviewed code owns (a chmod 000, a stale handle), and its failure
      // must not disable the trusted lease directory's sweep — the
      // finalizer exists to be independent of the mount.
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch (error) {
        debugLogger.debug(
          `Failed to list ${directory} for lease cleanup:`,
          error,
        );
        continue;
      }

      for (const entry of entries) {
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
        if (
          directory !== newLeaseDirectory &&
          !sameLease(lease, readLease(join(newLeaseDirectory, basename(entry))))
        ) {
          continue;
        }
        if (removeLeaseWorktree(lease, params.gitTimeout ?? GIT_TIMEOUT_MS)) {
          rmSync(path, { force: true });
        }
      }
    }
  } catch (error) {
    debugLogger.debug('Failed to clean up review worktree leases:', error);
  }
}

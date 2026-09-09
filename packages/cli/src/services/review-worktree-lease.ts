// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  sep,
} from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
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
  const resolved = resolve(repositoryRoot);
  // Nested geometry (R27-6): a review launched from inside another review's
  // worktree has a repositoryRoot INSIDE the outer review's read-write
  // mount, and a plain `join(root, REVIEW_LEASE_DIR)` would put this
  // session's host-trusted state — the records the finalizer force-removes
  // worktrees and branches on the say-so of — back inside the writable
  // surface the move out of `.qwen/tmp` exists to escape. Re-root to the
  // OUTERMOST enclosing repository's lease directory instead. The scan is
  // lexical, never git's: a planted pointer would choose where the lock is
  // written. The re-root is also the correct lock SCOPE — every nested
  // layer shares the outermost repository's common git dir, so the branch
  // the lease guards (`qwen-review/pr-<n>`) is one resource across all of
  // them, and two layers reviewing the same PR genuinely collide on it.
  const marker = `${sep}${REVIEW_TMP_DIR}${sep}`;
  const at = (resolved + sep).indexOf(marker);
  if (at < 0) return join(resolved, REVIEW_LEASE_DIR);
  const outermostTmp = resolved.slice(0, at + marker.length - 1);
  // `<host>/.qwen/tmp` → `<host>`: the lease directory beside the outermost
  // review temp dir is outside every review temp dir on the path.
  return join(resolve(outermostTmp, '..', '..'), REVIEW_LEASE_DIR);
}

/**
 * Where leases lived before they moved out of the mounted directory. Still
 * WRITTEN (the acquisition mirror, for pre-move builds that read only this
 * path) and DELETED (the clear path, the finalizer's twin sweep) — but never
 * BELIEVED: a file here is mount-resident content and carries no gate
 * authority, so nothing in this module blocks on it.
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
  // The pre-move path is deliberately NOT read for authority here. While the
  // move rolled out, an mtime-bounded read honored a legacy lease that
  // predated the move's landing date — but a pinned-to-the-past cutoff
  // freezes the honored population at release day: an old build acquiring
  // AFTER it writes a fresh-mtime lease no new build honors, so the arm
  // protected no acquisition the rollout could still produce. What remained
  // was the cost (R30-7): the legacy path lives in the one directory
  // reviewed code can write, `utimes` backdating is a syscall away, and an
  // honored plant naming a foreign session wedged this target for every
  // later run until a human deleted it. A legacy-path file is residue, not
  // a lock: the mirror below replaces it — loudly, when it parses as
  // another session's lease — and only the new path answers the gate.
  const legacy = legacyLeasePath(repositoryRoot, params.target);
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
  mirrorLeaseAtLegacyPath(legacy, data, params.sessionId, params.target);
}

/**
 * Mirror the just-acquired lease at the pre-move path, for the one release
 * the rollout assumes old builds exist in: a pre-move build reads ONLY that
 * path, so without the mirror its fetch-pr passes its own gate over this
 * live lease and its cleanStale force-removes this session's worktree and
 * deletes its branch mid-run — #9205 in the mirrored direction, and
 * unannounced, because this session's rollback clears only the new path.
 *
 * The mirror is advisory, never an arbiter: it is written only after the
 * new-path `wx` write has won, and it is never FATAL (R29-5). The legacy
 * path lives in the one directory reviewed code can still write, so any
 * obstruction there — a directory at the lease's name, an unwritable
 * parent, a planted link — is mount weather, not a verdict; a failed mirror
 * skips with a warning, because a silent skip is how a missing mirror
 * re-opens #9205 for pre-move builds with nobody told.
 *
 * The replacement write never FOLLOWS what stands at the path (R27-7,
 * R30-8, R30-39): it writes a unique sibling and `renameSync`s it over the
 * name — rename replaces a symlink itself rather than writing through it,
 * so a planted link cannot aim this host-side write at a file outside the
 * mount, and a readerless FIFO at the name is never opened at all. A plain
 * `writeFileSync(legacy, …)` here was the one host-side write into the
 * mounted directory that followed whatever was at the path — `O_TRUNC`
 * through a swapped-in symlink is an arbitrary-file-write primitive from
 * the mount against the host filesystem.
 */
function mirrorLeaseAtLegacyPath(
  legacy: string,
  data: string,
  sessionId: string,
  target: string,
): void {
  try {
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, data, { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      warnMirrorSkipped(legacy, error);
      return;
    }
  }
  // EEXIST — something already stands at the legacy name. `readLease`'s
  // lstat guard removes a non-regular wedge (a DIRECTORY at the lease name,
  // which nothing else removes and a rename cannot replace; a planted
  // symlink — unlinked, never followed; a FIFO) before answering, so what
  // remains for the rename below is at most a regular file: this session's
  // own earlier mirror, or a lease-shaped file written inside the mount.
  // The replacement is quiet for the first and loud for a file that parses
  // as ANOTHER session's lease — the one honest way to produce that is a
  // pre-move build still holding the target, and displacing its lock
  // without a word is exactly the unannounced #9205 the mirror exists to
  // prevent.
  const displaced = readLease(legacy);
  try {
    const tmp = `${legacy}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, legacy);
  } catch (error) {
    warnMirrorSkipped(legacy, error);
    return;
  }
  if (displaced && displaced.sessionId !== sessionId) {
    writeStderrLineSafe(
      `warning: replaced the pre-move review lease for ${target} at ` +
        `${legacy} (recorded session ${displaced.sessionId}) — if a ` +
        `pre-move build is still reviewing ${target} on this machine, its ` +
        `worktree is no longer protected; otherwise this was residue or a ` +
        `plant, and it is gone.`,
    );
  }
}

/** A skipped mirror is mount weather: loud, never fatal (R29-5). */
function warnMirrorSkipped(legacy: string, error: unknown): void {
  writeStderrLineSafe(
    `warning: could not mirror the review worktree lease to the pre-move ` +
      `path ${legacy} (${(error as NodeJS.ErrnoException).code ?? error}); ` +
      `the acquisition stands on the new-path lease, but builds from before ` +
      `the lease move will not see this lock.`,
  );
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

/** The lease currently registered for a review target, or null. */
export function readReviewWorktreeLease(
  repositoryRoot: string,
  target: string,
): ReviewWorktreeLease | null {
  return readReviewWorktreeLeaseAt(repositoryRoot, target)?.lease ?? null;
}

/**
 * The lease currently registered for a review target AND the path it was
 * found at, so a recovery instruction names the file that actually holds
 * the lock.
 *
 * Only the new path answers. The pre-move path under `.qwen/tmp` carried an
 * mtime-bounded read for one rollout window, and the window closed without
 * the bound ever protecting a post-cutoff acquisition — what it still did
 * was hand a `utimes`-backdated plant permanent gate authority (R30-7).
 * Mount-resident content is never this build's idea of a lock.
 */
export function readReviewWorktreeLeaseAt(
  repositoryRoot: string,
  target: string,
): { lease: ReviewWorktreeLease; path: string } | null {
  if (!validTarget(target)) return null;
  const root = resolve(repositoryRoot);
  const current = leasePath(root, target);
  const lease = readLease(current);
  return lease ? { lease, path: current } : null;
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
    // Driven ONLY by the trusted directory (R28-5, R30-36): one target, one
    // destructive pass, one verdict. Scanning the legacy directory as an
    // independent actor ran `removeLeaseWorktree` TWICE per target — and the
    // second pass operated on state the first had already destroyed, so a
    // first pass that removed the tree and then failed a follow-up (a prune
    // losing a race, a 1s exit-time timeout kill) left the legs to disagree:
    // the later pass succeeded against the emptied world and deleted the
    // trusted lease while the mirror survived — twinless, and uncollectable
    // forever by the only automated sweep that knew it.
    if (!existsSync(newLeaseDirectory)) return;
    // The trusted directory lives outside the mount, so its listing can
    // still only fail on host weather (a stale handle, a permission the
    // pipeline never sets) — say so and stop rather than half-sweep.
    let entries: string[];
    try {
      entries = readdirSync(newLeaseDirectory);
    } catch (error) {
      debugLogger.debug(
        `Failed to list ${newLeaseDirectory} for lease cleanup:`,
        error,
      );
      return;
    }

    for (const entry of entries) {
      if (!isReviewLeaseFile(entry)) continue;
      const path = join(newLeaseDirectory, basename(entry));
      const lease = readLease(path);
      if (
        !lease ||
        lease.sessionId !== params.sessionId ||
        lease.promptId !== params.promptId ||
        resolve(lease.repositoryRoot) !== repositoryRoot
      ) {
        continue;
      }
      if (!removeLeaseWorktree(lease, params.gitTimeout ?? GIT_TIMEOUT_MS)) {
        // A failed finalize keeps BOTH files: the trusted lease for the next
        // sweep's retry, and the mirror, whose twin check below is the only
        // thing that ever deletes it — deleting it here would leave the
        // trusted lease standing with no mirror while pre-move builds still
        // read the legacy path.
        continue;
      }
      rmSync(path, { force: true });
      // The legacy twin goes with it — but only when it IS the twin. The
      // mirror is READABLE from inside the mount, so reviewed code can copy
      // its sessionId/promptId into a planted lease naming a victim
      // worktreePath; only content-equality with the trusted lease proves
      // acquisition wrote the legacy file. A doctored twin stays in place
      // (never wielded — the sweep reads the trusted side only — and never
      // deleted on a trusted twin's say-so alone). A legacy file with no
      // trusted twin is never visited at all: it proves nothing, and the
      // workflow's per-job sweep reaps it.
      const twin = join(repositoryRoot, REVIEW_TMP_DIR, basename(entry));
      try {
        if (sameLease(lease, readLease(twin))) {
          rmSync(twin, { force: true });
        }
      } catch (error) {
        // The mounted directory is reviewed code's weather; the trusted
        // lease is already gone and the next acquisition's mirror heals the
        // name.
        debugLogger.debug(`Failed to remove legacy lease twin ${twin}:`, error);
      }
    }
  } catch (error) {
    debugLogger.debug('Failed to clean up review worktree leases:', error);
  }
}

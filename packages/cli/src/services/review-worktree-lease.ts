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
  inertPath,
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
  /**
   * This capture's run identity, minted here and carried in the lease's
   * CONTENT.
   *
   * The review pipeline keys its base-tree trust state on it: the same value
   * across a run means "the same capture", and a different one means the
   * trust state rotates. It lives in the content rather than in the file's
   * mtime — which is what an earlier cut used — because a timestamp is the
   * wrong carrier for an identity. `utimesSync` restores a fractional mtime
   * with a sub-millisecond floor, so a second same-session refresh drifted
   * past the trust store's tolerance and rotated a live run's state; and the
   * heal arm, which rewrites a lease it could NOT parse, donated whatever
   * mtime the standing file had — an unrelated earlier run's identity,
   * adopted rather than rotated. A minted number has neither failure.
   *
   * Optional because a lease written by a build from before this field
   * existed carries none. A reader that needs an identity refuses on the
   * absence rather than substituting a mount-derived one; the next capture
   * rewrites the lease with one.
   */
  identity?: number;
  /**
   * What the PREVIOUS capture of this session resolved — kept only to decide
   * whether the next capture's merge base is a MOVE.
   *
   * It is deliberately not the anchor. The anchor (`mergeBaseSha`) is this
   * capture's own fact and is dropped on every refresh, so that a round whose
   * record write failed has none and `base-tree` refuses rather than reading
   * someone else's round as this one's. But dropping it also drops the
   * rotation signal a genuine rebase needs, so the value is remembered here
   * instead, where nothing reads it as an anchor.
   */
  priorMergeBaseSha?: string;
  /**
   * The merge base this capture resolved, recorded HOST-SIDE.
   *
   * `base-tree` pins the base it certifies against, and its only source used
   * to be `mergeBaseSha` in the plan — which lives inside the directory the
   * sandbox mounts read-write, and which the build/test phase gives the
   * reviewed code a chance to rewrite BEFORE the run's first `base-tree`
   * ask. The pin then authenticated the rewritten value against itself. The
   * capture records it here, outside the mount, so the pin has an anchor the
   * mount cannot reach.
   *
   * Optional because a lease written by an older build carries none, and
   * because a capture that could not resolve a merge base records none —
   * both leave `base-tree` on the plan's value, which is where it was.
   */
  mergeBaseSha?: string;
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
  //
  // Fenced, because this is the only removal in the clear path that touches
  // the directory reviewed code can still write, and it runs AFTER the
  // trusted lease above is already gone. `force` swallows ENOENT and nothing
  // else: a mode-500 directory planted at the legacy name (the wedge two of
  // this file's own tests stage) makes the unlink throw EACCES, and an open
  // handle on Windows does the same non-adversarially. Thrown, it leaves
  // `clearReviewWorktreeLease` — and `runCleanup`, whose tests pin it as
  // never throwing — reporting failure over a cleanup that succeeded, with
  // every retry re-throwing on a file no message names. Loud instead, the
  // same contract the mirror write carries.
  reclaimBaseTreeTrust(root, target);
  const legacy = legacyLeasePath(root, target);
  try {
    rmSync(legacy, { force: true, recursive: true });
  } catch (error) {
    writeStderrLineSafe(
      `warning: could not remove the pre-move review lease at ${legacy} ` +
        `(${(error as NodeJS.ErrnoException).code ?? error}); the trusted ` +
        `lease for ${target} is released, but a build from before the lease ` +
        `move will keep seeing this one until it is deleted by hand.`,
    );
  }
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

/**
 * A fresh run identity.
 *
 * `Date.now()` alone would collide for two captures inside one millisecond,
 * which is reachable when a restart re-captures immediately; the random low
 * bits make a collision a coincidence rather than a certainty, while the
 * millisecond part keeps the value readable in the lease file. Nothing
 * compares identities for ORDER — the trust store asks only "the same one or
 * not" — so the ordering the random part disturbs is not used.
 */
function mintIdentity(): number {
  // Seconds, not milliseconds, so the 20 random bits fit under
  // `Number.MAX_SAFE_INTEGER` alongside them (1.8e9 * 2^20 ≈ 1.9e15 < 9e15).
  // The trust store compares these EXACTLY, so the random part is what makes
  // two captures inside one clock tick distinct rather than a coincidence —
  // a millisecond part with three decimal digits of randomness left a
  // one-in-a-thousand collision, and, worse, put two distinct mints within
  // the store's old 1 ms tolerance of each other.
  return (
    Math.floor(Date.now() / 1000) * 2 ** 20 +
    (randomBytes(3).readUIntBE(0, 3) % 2 ** 20)
  );
}

/**
 * Record the merge base this capture resolved, in the host-side lease.
 *
 * Called by `fetch-pr` once the merge base is known — which is after the
 * lease is acquired, so it cannot be part of the acquisition write.
 *
 * A CHANGED merge base mints a new identity, and that is the point: a
 * genuine rebase arrives through a fresh capture, and the base-tree trust
 * state must rotate rather than adopt a pin taken at the old base. Without
 * it a same-session re-capture at a moved base kept the earlier identity,
 * the trust store reported a conflict between its pinned base and the new
 * plan, and every later ask in the session declined — a dead A/B lane
 * misdiagnosed as reviewed-code tampering. A re-capture at the SAME base
 * leaves the identity alone, so the standing base tree is still reused.
 *
 * Never throws: the lease is advisory state, and a capture that cannot
 * record its base leaves `base-tree` on the plan's value, which is where it
 * was before this field existed.
 */
export function recordReviewWorktreeLeaseMergeBase(
  repositoryRoot: string,
  target: string,
  mergeBaseSha: string,
  sessionId?: string,
): void {
  if (!validTarget(target) || !mergeBaseSha) return;
  const root = resolve(repositoryRoot);
  const path = leasePath(root, target);
  const existing = readLease(path);
  if (!existing) return;
  // Only this session's own lease. A capture that lost the acquisition race,
  // or one still running after an operator handed the target to a new
  // session, would otherwise write its merge base — and its fresh identity —
  // over the lease the live review is keyed on, rotating that review's trust
  // state and sweeping the base tree it is mid-A/B in.
  if (sessionId !== undefined && existing.sessionId !== sessionId) return;
  if (existing.mergeBaseSha === mergeBaseSha) return;
  // The MOVE is judged against what the last capture resolved, which survives
  // a refresh in `priorMergeBaseSha` even though the anchor itself does not.
  // Without that the rotation a genuine rebase is entitled to would be lost
  // the moment the anchor started being dropped: every round would look like
  // "the first capture to record one".
  const previous = existing.mergeBaseSha ?? existing.priorMergeBaseSha;
  const next: ReviewWorktreeLease = {
    ...existing,
    mergeBaseSha,
    priorMergeBaseSha: mergeBaseSha,
    // A lease from a build before the identity field existed carries none,
    // and leaving it undefined here would write it back out missing — after
    // which `runIdentity` refuses and the A/B lane is unavailable for the
    // rest of the review. The capture is exactly the moment a fresh identity
    // is legitimate, so mint one.
    identity:
      previous === undefined || previous === mergeBaseSha
        ? (existing.identity ?? mintIdentity())
        : mintIdentity(),
  };
  // tmp-then-rename, the shape the mirror write already uses: a lock-free
  // reader that catches this mid-write would read a torn file, and every
  // reader treats a torn lease as NO lease — which makes `runIdentity`
  // refuse and `base-tree` report itself unavailable for that ask.
  try {
    atomicWriteLease(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    debugLogger.debug(`Failed to record the merge base in ${path}:`, error);
  }
}

/**
 * tmp-then-rename, for a file read lock-free by `base-tree`'s `runIdentity`.
 *
 * A truncate in place lets a reader land inside the write and see a torn
 * file, which every reader treats as NO lease — and that costs the review
 * its A/B for that shard.
 */
function atomicWriteLease(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Litter, not a verdict.
    }
    throw error;
  }
}

/**
 * Reclaim the base-tree trust artifacts for a target.
 *
 * Nothing else can: they are keyed by the plan's PATH, a digest no other
 * module reconstructs, and a real built tree's per-file inventory measures
 * ~9 MB — one file per plan path per review, kept forever. Host-side and this
 * session's own state, so a plain recursive remove is right, and best-effort
 * like every other removal on the release paths.
 */
function reclaimBaseTreeTrust(root: string, target: string): void {
  try {
    rmSync(join(leaseDirectory(root), 'base-tree', target), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    debugLogger.debug(
      `Failed to reclaim base-tree trust state for ${target}:`,
      error,
    );
  }
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
  const path = leasePath(repositoryRoot, params.target);
  const leaseFor = (identity: number, priorMergeBaseSha?: string): string => {
    const lease: ReviewWorktreeLease = {
      sessionId: params.sessionId!,
      promptId: params.promptId!,
      target: params.target,
      repositoryRoot,
      worktreePath: resolve(repositoryRoot, params.worktreePath),
      branch: params.branch,
      identity,
      ...(priorMergeBaseSha === undefined ? {} : { priorMergeBaseSha }),
    };
    return `${JSON.stringify(lease, null, 2)}\n`;
  };
  let data = leaseFor(mintIdentity());
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
    //
    // The refresh CARRIES THE IDENTITY FORWARD — but only from a lease this
    // call actually verified as this session's. `existing` is null on the
    // heal arm, where the standing file did not parse and its owner, session
    // and target were therefore never checked; carrying an identity across
    // from there would let an unrelated earlier run's trust state be adopted
    // instead of rotated. On that arm a fresh identity is minted, which
    // rotates — the direction that loses a base tree rather than trusting
    // one. The merge base rides along the same way: it is this capture's
    // fact, and `recordReviewWorktreeLeaseMergeBase` is what moves it.
    if (existing) {
      // The identity carries forward; the MERGE BASE does not. It is this
      // capture's own fact, and carrying the previous one forward left a
      // stale host-side anchor that `base-tree` then read as belonging to
      // this capture — so `fetch-pr`'s invariant ("the anchor has to belong
      // to the capture that owns the plan") and `base-tree`'s fail-closed
      // rule ("a missing anchor refuses") both held only for round 1. Dropped
      // here, a round whose own record write fails has NO anchor, which
      // refuses; `recordReviewWorktreeLeaseMergeBase` puts this capture's
      // value back a moment later on the ordinary path.
      data = leaseFor(
        typeof existing.identity === 'number' &&
          Number.isFinite(existing.identity)
          ? existing.identity
          : mintIdentity(),
        existing.mergeBaseSha ?? existing.priorMergeBaseSha,
      );
    }
    // tmp-then-rename, not a truncate in place: `runIdentity` reads this file
    // lock-free on every `base-tree` ask, and a reader landing inside a
    // truncate sees a torn file — which every reader treats as NO lease, so
    // that ask refuses and the review loses its A/B for that shard.
    atomicWriteLease(path, data);
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
  const tmp = `${legacy}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, legacy);
  } catch (error) {
    // A rename failure (a directory at the name, EACCES) leaves the tmp
    // file behind: it matches no sweep's glob, so take it with us — and
    // THAT removal must not throw either: the mirror is never fatal, and
    // an rm error escaping here would roll back the acquisition that
    // already won.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A tmp file left behind is litter, not a verdict.
    }
    warnMirrorSkipped(legacy, error);
    return;
  }
  if (displaced && displaced.sessionId !== sessionId) {
    writeStderrLineSafe(
      `warning: replaced the pre-move review lease for ${target} at ` +
        `${legacy} (recorded session ${inertSessionId(displaced.sessionId)}) — if a ` +
        `pre-move build is still reviewing ${target} on this machine, its ` +
        `worktree is no longer protected; otherwise this was residue or a ` +
        `plant, and it is gone.`,
    );
  }
}

/**
 * The displaced session id, made inert for a terminal.
 *
 * It is parsed out of a file in the one directory reviewed code can write, so
 * it reaches stderr the way every other workspace-controlled value in this
 * repo does: through `inertPath`, which flattens control characters (a raw
 * ESC is an SGR sequence; a newline forges a second line — a `::error::`
 * workflow command of its own, in CI), the invisible formatting characters
 * that survive it, and the line separators. Bounded too: the warning names
 * the id so an operator can recognise the displaced run, and an id longer
 * than that is not a name, it is a payload.
 */
function inertSessionId(id: string): string {
  const inert = inertPath(id);
  return inert.length > 120 ? `${inert.slice(0, 120)}…` : inert;
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
      typeof value.branch !== 'string' ||
      (value.identity !== undefined &&
        (typeof value.identity !== 'number' ||
          !Number.isFinite(value.identity))) ||
      (value.mergeBaseSha !== undefined &&
        typeof value.mergeBaseSha !== 'string') ||
      (value.priorMergeBaseSha !== undefined &&
        typeof value.priorMergeBaseSha !== 'string')
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
      // ...and the base-tree trust artifacts for that target, which this is
      // the last call in a session that can name them. `clearReviewWorktreeLease`
      // reclaims them on the ordinary release path; a session that ends
      // through the FINALIZER instead reached here without passing through
      // it, and left a ~9 MB file per plan path behind forever.
      reclaimBaseTreeTrust(repositoryRoot, lease.target);
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

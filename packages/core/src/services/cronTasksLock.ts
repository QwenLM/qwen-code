/**
 * Per-project lock for the durable cron scheduler. Ensures only one
 * session fires file-backed tasks when multiple sessions share a project.
 *
 * Lock file: `~/.qwen/tmp/<project-hash>/scheduled_tasks.lock` (per-machine
 * runtime state — kept out of the working tree, next to the tasks file).
 * Content: `{ "pid": <number>, "sessionId": "<string>", "lockId": "<string>" }`
 *
 * `lockId` distinguishes lock holders that share a pid and sessionId —
 * e.g. a session reload creates a fresh scheduler for the same session
 * while the old scheduler's release is still in flight. Without it the
 * new holder would adopt the old lock file moments before its unlink
 * lands, and believe it owns a lock that no longer exists.
 *
 * Acquisition: exclusive create (`wx`). An existing lock is honored while
 * its PID is alive; a dead or malformed lock is atomically renamed aside
 * before re-creating. The renamed file is then verified to really be the
 * stale lock that was inspected — a racing contender may already have
 * cleared it and created a fresh lock at the same path, which must be
 * restored, not discarded.
 * Release: delete the file (best-effort on exit).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getProjectHash } from '../utils/paths.js';
import { Storage } from '../config/storage.js';

const LOCK_FILENAME = 'scheduled_tasks.lock';

// Distinguishes the rename-aside targets of concurrent takeover attempts
// within this process; cross-process uniqueness comes from the PID.
let staleSeq = 0;

interface LockContent {
  pid: number;
  sessionId: string;
  lockId?: string;
}

export function getLockFilePath(projectRoot: string): string {
  // Co-located with the tasks file under the user runtime dir, keyed by a
  // hash of the project root — the lock is per-machine state and must not
  // live in (or be committed from) the working tree.
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    LOCK_FILENAME,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we can't signal it (still alive)
    // ESRCH = no such process (dead)
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Try to acquire the scheduler lock. Returns true if this session now
 * owns it. Safe to call repeatedly — re-acquiring an already-held lock
 * is a no-op that returns true.
 */
export async function tryAcquireLock(
  projectRoot: string,
  sessionId: string,
  lockId?: string,
): Promise<boolean> {
  const lockPath = getLockFilePath(projectRoot);
  const content: LockContent = { pid: process.pid, sessionId, lockId };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  // Two attempts: one against the current state, one after clearing a
  // stale lock. If the lock is still contended after that, give up —
  // the caller's probe will retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Exclusive create — only one racing session can succeed.
    try {
      await fs.writeFile(lockPath, JSON.stringify(content), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // Lock exists — inspect it.
    let existing: LockContent | null = null;
    try {
      existing = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // vanished between create and read — retry the create
      }
      if (!(err instanceof SyntaxError)) {
        throw err;
      }
      // Malformed lock file — treat as stale, fall through to clear it
    }

    if (existing) {
      // We already own it
      if (
        existing.pid === process.pid &&
        existing.sessionId === sessionId &&
        existing.lockId === lockId
      ) {
        return true;
      }
      // Owner is still alive — we can't take over
      if (isProcessAlive(existing.pid)) {
        return false;
      }
    }

    // Stale (dead owner) or malformed. Move it aside before re-creating —
    // rename is atomic, so each contender grabs a distinct file. But the
    // lock at this path may no longer be the one we inspected: another
    // contender can have cleared it and created a fresh lock in the
    // meantime. Verify what was actually moved before discarding it.
    const stalePath = `${lockPath}.stale.${process.pid}.${staleSeq++}`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return false;
      }
      continue; // another contender cleared it — retry the create
    }

    // The moved file is private to this attempt, so this read is race-free.
    let movedIsLive = false;
    try {
      const moved: LockContent = JSON.parse(
        await fs.readFile(stalePath, 'utf-8'),
      );
      movedIsLive = isProcessAlive(moved.pid);
    } catch (err) {
      // Malformed is safe to discard — live sessions write valid JSON.
      // Anything else is unverifiable; assume live to be safe.
      movedIsLive = !(err instanceof SyntaxError);
    }

    if (movedIsLive) {
      // We yanked a live owner's fresh lock. Put it back with link(),
      // which fails on EEXIST instead of clobbering an even newer lock.
      await fs.link(stalePath, lockPath).catch(() => {});
      await fs.unlink(stalePath).catch(() => {});
      return false;
    }

    await fs.unlink(stalePath).catch(() => {});
  }

  return false;
}

/**
 * Release the lock. Only deletes if we own it. Best-effort — errors
 * are swallowed since this is typically called on shutdown.
 */
export async function releaseLock(
  projectRoot: string,
  sessionId: string,
  lockId?: string,
): Promise<void> {
  const lockPath = getLockFilePath(projectRoot);
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const existing: LockContent = JSON.parse(raw);
    if (
      existing.pid === process.pid &&
      existing.sessionId === sessionId &&
      existing.lockId === lockId
    ) {
      await fs.unlink(lockPath);
    }
  } catch {
    // Best-effort cleanup
  }
}

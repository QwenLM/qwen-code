/**
 * Single-owner lock for the `/schedule` daemon. Only one daemon per machine
 * may fire tasks; a second `qwen schedule daemon` invocation detects the live
 * owner and bows out. Unlike the per-project durable-cron lock
 * (`cronTasksLock.ts`, keyed by project hash + session), this is one global
 * lock file at `~/.qwen/scheduled-tasks/daemon.lock`.
 *
 * Acquisition: exclusive create (`wx`). An existing lock is honored while its
 * PID is alive; a dead/malformed/our-own-leftover lock is stolen and the
 * create retried. Release: unlink, but only if we still own it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Storage } from '../../config/storage.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('SCHEDULE_DAEMON_LOCK');

const DAEMON_LOCK_FILENAME = 'daemon.lock';

export interface DaemonLockHandle {
  path: string;
  pid: number;
  /** Distinguishes daemon instances that share a pid (e.g. two in one test
   * process, or a reload) so one never steals another's live lock. */
  lockId: string;
}

interface LockContent {
  pid: number;
  lockId?: string;
  startedAt: number;
}

function generateLockId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function getDaemonLockPath(): string {
  return path.join(Storage.getScheduledTasksDir(), DAEMON_LOCK_FILENAME);
}

/** True if a process with `pid` is currently running. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<LockContent | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (typeof parsed.pid === 'number') {
      return {
        pid: parsed.pid,
        lockId: typeof parsed.lockId === 'string' ? parsed.lockId : undefined,
        startedAt: parsed.startedAt ?? 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read-only check: is a schedule daemon currently running (lock held by a live
 * process)? Used to decide whether to auto-start one. Does not modify the lock.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const holder = await readLock(getDaemonLockPath());
  return holder != null && isProcessAlive(holder.pid);
}

/**
 * Attempts to become the sole scheduling daemon. Returns a handle on success,
 * or null if another live daemon already owns the lock.
 */
export async function acquireDaemonLock(): Promise<DaemonLockHandle | null> {
  const dir = Storage.getScheduledTasksDir();
  await fs.mkdir(dir, { recursive: true });
  const lockPath = getDaemonLockPath();
  const pid = process.pid;
  const lockId = generateLockId();
  const payload = JSON.stringify({ pid, lockId, startedAt: Date.now() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, payload, { flag: 'wx' });
      debugLogger.debug(`Acquired daemon lock (pid ${pid}, lockId ${lockId})`);
      return { path: lockPath, pid, lockId };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const holder = await readLock(lockPath);
    // Refuse if a live process holds it — unless it's this exact handle's own
    // leftover (same pid AND lockId), which only a retry within this call can
    // hit. A different lockId on our own pid means another daemon instance in
    // this process legitimately owns it.
    const isOurLeftover =
      holder != null && holder.pid === pid && holder.lockId === lockId;
    if (holder && isProcessAlive(holder.pid) && !isOurLeftover) {
      debugLogger.debug(
        `Daemon lock held by live pid ${holder.pid} (lockId ${holder.lockId ?? '?'})`,
      );
      return null;
    }
    // Stale (dead holder), malformed, or our own leftover — steal and retry.
    debugLogger.debug(
      `Stealing stale daemon lock (holder ${holder?.pid ?? 'unparseable'})`,
    );
    await fs.unlink(lockPath).catch(() => {});
  }
  return null;
}

/** Releases the lock, but only if this process still owns it. */
export async function releaseDaemonLock(
  handle: DaemonLockHandle,
): Promise<void> {
  const holder = await readLock(handle.path);
  // Only unlink if we still own it (same pid AND lockId) — a lock replaced by
  // another instance must be left intact.
  if (
    holder &&
    (holder.pid !== handle.pid || holder.lockId !== handle.lockId)
  ) {
    return;
  }
  await fs.unlink(handle.path).catch(() => {});
  debugLogger.debug(`Released daemon lock (pid ${handle.pid})`);
}

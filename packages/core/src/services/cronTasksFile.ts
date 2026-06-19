/**
 * File I/O for durable cron tasks. Reads/writes the per-project tasks file
 * under the user's runtime dir (`~/.qwen/tmp/<project-hash>/`), NOT the
 * working tree — durable tasks are the user's own automation against a
 * project, not project-shared config, so they live alongside the other
 * per-project-private runtime state (checkpoints, shell history) and never
 * become a committed/pulled prompt-injection surface.
 * Session-only tasks never touch this module.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { getProjectHash } from '../utils/paths.js';
import { Storage } from '../config/storage.js';

export interface DurableCronTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  lastFiredAt: number | null;
}

const TASKS_FILENAME = 'scheduled_tasks.json';

/** Generic label for the tasks file, for user-facing messages and tool
 * descriptions. The real path is per-project (hashed); this template
 * communicates the location without leaking the hash. */
export const CRON_TASKS_DISPLAY_PATH = `~/.qwen/tmp/<project-hash>/${TASKS_FILENAME}`;

// Cross-process write-lock tuning for updateCronTasks. Updates hold the
// lock for single-digit milliseconds, so anything older than STALE_MS is
// a crashed holder and safe to steal.
const UPDATE_LOCK_RETRY_MS = 15;
const UPDATE_LOCK_STALE_MS = 2_000;
const UPDATE_LOCK_TIMEOUT_MS = 3_000;

// Distinguishes the rename-aside targets of concurrent stale-lock clears
// within this process; cross-process uniqueness comes from the PID.
let updateStaleSeq = 0;

// In-process serialization: a per-file mutex so concurrent calls from this
// session never interleave (and never contend on the file lock). One entry
// per project root, never evicted — bounded by the number of project roots
// a single process touches, which in CLI usage is one. Not a leak worth a
// cleanup hook at this lifetime.
const updateMutexes = new Map<string, Mutex>();

function getUpdateMutex(filePath: string): Mutex {
  let mutex = updateMutexes.get(filePath);
  if (!mutex) {
    mutex = new Mutex();
    updateMutexes.set(filePath, mutex);
  }
  return mutex;
}

export function getCronFilePath(projectRoot: string): string {
  // Per-project-private, under the user runtime dir — keyed by a hash of
  // the project root (same scheme as checkpoints/shell-history), so the
  // file is never in the working tree.
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    TASKS_FILENAME,
  );
}

export async function readCronTasks(
  projectRoot: string,
): Promise<DurableCronTask[]> {
  const filePath = getCronFilePath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  // A file that exists but doesn't parse is corruption, not an empty
  // schedule: returning [] here would let a reload reconcile every loaded
  // durable job away, and let the next read-modify-write replace the
  // user's (recoverable) file with a valid-but-empty one. Throw instead —
  // the scheduler keeps its current view on read failure, and
  // updateCronTasks refuses to write through it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} — fix or delete the file; refusing to treat it as an empty schedule.`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON array in ${filePath} — fix or delete the file; refusing to treat it as an empty schedule.`,
    );
  }
  for (const [index, task] of parsed.entries()) {
    if (!isValidTask(task)) {
      throw new Error(
        `Invalid task entry at index ${index} in ${filePath} — fix or delete the entry; refusing to drop it from the schedule.`,
      );
    }
  }
  return parsed;
}

export async function writeCronTasks(
  projectRoot: string,
  tasks: DurableCronTask[],
): Promise<void> {
  const filePath = getCronFilePath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // noFollow: this file lives inside the project working tree, so a cloned
  // or hand-edited repo could pre-place it as a symlink. Following it would
  // let any durable write clobber an arbitrary target outside the repo — the
  // same project-controlled-symlink threat the credential write sites guard
  // against (see the noFollow docs in atomicFileWrite.ts). Replace the link
  // with a regular file instead of writing through it.
  await atomicWriteJSON(filePath, tasks, { noFollow: true });
}

/**
 * Acquires `<tasksFile>.lock` via exclusive create, retrying until the
 * holder releases it. Locks older than UPDATE_LOCK_STALE_MS belong to a
 * crashed holder and are stolen. Returns a release function.
 */
async function acquireUpdateLock(
  filePath: string,
): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + UPDATE_LOCK_TIMEOUT_MS;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for scheduled-tasks lock (${lockPath})`,
      );
    }

    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return async () => {
        await fs.unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > UPDATE_LOCK_STALE_MS) {
        // Don't unlink in place: between the stat and the unlink another
        // contender can clear the stale lock and create a fresh one, and
        // unlinking would then destroy a live holder's lock — two writers
        // inside the read-modify-write. Rename aside (atomic, one winner),
        // verify what was actually moved — rename preserves mtime — and
        // put back a fresh lock via link(), which fails on EEXIST instead
        // of clobbering an even newer one (same pattern as cronTasksLock).
        const stalePath = `${lockPath}.stale.${process.pid}.${updateStaleSeq++}`;
        try {
          await fs.rename(lockPath, stalePath);
        } catch {
          continue; // another contender cleared it — retry the create
        }
        const moved = await fs.stat(stalePath).catch(() => null);
        if (moved && Date.now() - moved.mtimeMs <= UPDATE_LOCK_STALE_MS) {
          await fs.link(stalePath, lockPath).catch(() => {});
        }
        await fs.unlink(stalePath).catch(() => {});
        continue;
      }
    } catch {
      continue; // lock vanished — retry the create
    }

    await new Promise((resolve) => setTimeout(resolve, UPDATE_LOCK_RETRY_MS));
  }
}

/**
 * Applies `mutate` to the on-disk task list in a single read-modify-write
 * cycle. Cycles are serialized — by a mutex within this process, guarded
 * by `<tasksFile>.lock` across processes — so concurrent updates from
 * other sessions sharing the cwd can't clobber each other.
 *
 * Returning the input array unchanged signals a no-op: the write is
 * skipped, so other sessions' file watchers don't reload for nothing.
 */
export async function updateCronTasks(
  projectRoot: string,
  mutate: (tasks: DurableCronTask[]) => DurableCronTask[],
): Promise<void> {
  const filePath = getCronFilePath(projectRoot);
  return getUpdateMutex(filePath).runExclusive(async () => {
    const release = await acquireUpdateLock(filePath);
    try {
      const tasks = await readCronTasks(projectRoot);
      const next = mutate(tasks);
      if (next !== tasks) {
        await writeCronTasks(projectRoot, next);
      }
    } finally {
      await release();
    }
  });
}

export async function addCronTask(
  projectRoot: string,
  task: DurableCronTask,
): Promise<void> {
  await updateCronTasks(projectRoot, (tasks) => [...tasks, task]);
}

/** Returns the number of tasks actually removed. */
export async function removeCronTasks(
  projectRoot: string,
  ids: string[],
): Promise<number> {
  const idSet = new Set(ids);
  // Lock-free pre-check: a miss must be entirely side-effect free — taking
  // the update lock would mkdir .qwen/ just to discover there is nothing
  // to remove. The authoritative filter re-runs under the lock below.
  const current = await readCronTasks(projectRoot);
  if (!current.some((t) => idSet.has(t.id))) return 0;
  let removed = 0;
  await updateCronTasks(projectRoot, (tasks) => {
    const remaining = tasks.filter((t) => !idSet.has(t.id));
    removed = tasks.length - remaining.length;
    return removed === 0 ? tasks : remaining;
  });
  return removed;
}

function isValidTask(value: unknown): value is DurableCronTask {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['cron'] === 'string' &&
    typeof obj['prompt'] === 'string' &&
    typeof obj['recurring'] === 'boolean' &&
    typeof obj['createdAt'] === 'number' &&
    (obj['lastFiredAt'] === null || typeof obj['lastFiredAt'] === 'number')
  );
}

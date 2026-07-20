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

/**
 * One entry in a recurring task's bounded run history — a record that the
 * task actually fired, surfaced by the Web Shell scheduled-tasks page. Only
 * recurring tasks accrue these: a one-shot is removed from disk the moment it
 * fires, so there is no surviving entry to attach history to.
 */
export interface CronTaskRun {
  /** Fire time (epoch ms), minute-aligned like `lastFiredAt`. */
  at: number;
  /**
   * How the run was delivered:
   *  - `'scheduled'` — fired on time by the running scheduler tick.
   *  - `'catch-up'` — a recurring fire that came due while no session owned
   *    the schedule, delivered late when a session took over.
   *  - `'manual'` — triggered by the user via the management UI's "run now",
   *    not by the scheduler.
   * Absent is treated as `'scheduled'` by consumers. Typed loosely (any
   * string is accepted on read) so a future kind can't fail validation on an
   * older reader.
   */
  kind?: 'scheduled' | 'catch-up' | 'manual';
  /**
   * Id of the session that owned the schedule when this fire ran — the session
   * whose transcript contains the run. Lets a management UI link a run back to
   * the conversation it happened in. Absent on tool-created history or when no
   * owner id was known.
   */
  sessionId?: string;
  /**
   * READ-ONLY backward-compatibility field. A pre-removal version stamped this
   * on a fire whose precondition withheld the prompt (it was booked as a run
   * but nothing executed). The isolated/precondition machinery is gone, so this
   * is never written anymore — but stored history still carries it, and dropping
   * it would misreport a deliberately-skipped fire as an ordinary successful
   * run. Preserved through read/validation/passthrough so the UI keeps its
   * "skipped" marker on legacy entries. Absent = a real dispatched run.
   */
  withheld?: boolean;
}

/** Cap on a task's on-disk run history. A ring, newest kept — this bounds the
 * per-task growth of the tasks file (every fire already rewrites it to stamp
 * `lastFiredAt`, so appending a capped run adds no extra write, only bytes). */
export const MAX_TASK_RUNS = 20;

export interface DurableCronTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  /**
   * Optional display name, shown in management UIs (the Web Shell
   * scheduled-tasks page). Absent on tool-created tasks — consumers fall
   * back to the prompt. Never used for scheduling.
   */
  name?: string;
  /**
   * Whether the task is active. Absent or `true` = scheduled; `false` =
   * kept on disk but skipped by the scheduler — a reversible "off" switch
   * for the management UI. Absent defaults to enabled so tool-created
   * tasks (which never write this field) keep firing.
   */
  enabled?: boolean;
  /**
   * Set when a task was disabled BY archiving its bound session (not by the
   * user's own off-switch). Only such tasks are re-enabled when the session is
   * unarchived, so a task the user deliberately disabled stays disabled across
   * an archive/unarchive cycle. Cleared on re-enable.
   */
  disabledByArchive?: boolean;
  /**
   * Id of the dedicated session this task is bound to. A task created through
   * the Web Shell management page mints its own session and stores its id here;
   * the task then fires ONLY inside that session (not via the shared per-project
   * durable owner), so the session's transcript is the task's run history, and
   * archiving/deleting that session stops the task. Absent on tool-created
   * (`cron_create`) and legacy tasks, which keep the shared-owner firing model.
   */
  sessionId?: string;
  /**
   * Bounded, newest-last history of recent fires (capped at MAX_TASK_RUNS).
   * Absent on tool-created tasks and on any task that has not fired yet.
   * Appended at the scheduler's persist sites via {@link appendCronRun}.
   */
  runs?: CronTaskRun[];
}

/**
 * Appends a run record to a task's bounded history ring (newest last), capping
 * at {@link MAX_TASK_RUNS} by dropping the oldest. Pure — returns a fresh
 * array and treats an absent/foreign `runs` as empty, so it is safe on a task
 * that predates the field. Shared by every scheduler persist site so the cap
 * is enforced in exactly one place.
 */
export function appendCronRun(
  runs: CronTaskRun[] | undefined,
  entry: CronTaskRun,
): CronTaskRun[] {
  const base = Array.isArray(runs) ? runs : [];
  const next = [...base, entry];
  return next.length > MAX_TASK_RUNS
    ? next.slice(next.length - MAX_TASK_RUNS)
    : next;
}

/**
 * True for a task written by a pre-removal version as an `isolated` task with a
 * `condition` precondition. The field is no longer part of {@link
 * DurableCronTask} (validation accepts it as an unknown key), so it is read off
 * the raw object. A blank/absent condition is not a gate.
 *
 * The isolated run mode and its preconditions were removed; such a task can no
 * longer be evaluated. Every consumer — the scheduler, the REST list view, and
 * the manual `/run` endpoint — uses this to FAIL CLOSED (skip / block / reject)
 * so a removed safety gate ("only run when X") can never silently degrade into
 * "always run" on any path. The user re-creates the task if they still want it.
 */
export function taskHasLegacyCondition(task: DurableCronTask): boolean {
  const condition = (task as unknown as Record<string, unknown>)['condition'];
  return typeof condition === 'string' && condition.length > 0;
}

/**
 * True for a task written by a pre-removal version with `runMode: 'isolated'`
 * (with or without a precondition). The field is no longer part of {@link
 * DurableCronTask}, so it is read off the raw object.
 *
 * Unlike a legacy precondition (which is a safety gate → fail closed), a bare
 * isolated task has no gate: it can still run, just no longer in a fresh
 * per-run session — it now accumulates history in its bound session. So the
 * scheduler still fires it, but logs a one-time notice so an operator who
 * relied on the clean-slate isolation is not left wondering why runs now differ.
 */
export function taskHasLegacyRunMode(task: DurableCronTask): boolean {
  return (task as unknown as Record<string, unknown>)['runMode'] === 'isolated';
}

/**
 * Generates an 8-character base36 id for a durable task. Shared by the
 * scheduler (`CronScheduler`) and the daemon's scheduled-tasks route so
 * route-created and tool-created tasks use one id scheme — changing it here
 * changes it everywhere. Math.random is fine: ids only need to be unique
 * within a <50-entry file, not unpredictable.
 */
export function generateCronTaskId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
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
  options: { assertCanCommit?: () => void } = {},
): Promise<void> {
  const filePath = getCronFilePath(projectRoot);
  options.assertCanCommit?.();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // noFollow: this file lives inside the project working tree, so a cloned
  // or hand-edited repo could pre-place it as a symlink. Following it would
  // let any durable write clobber an arbitrary target outside the repo — the
  // same project-controlled-symlink threat the credential write sites guard
  // against (see the noFollow docs in atomicFileWrite.ts). Replace the link
  // with a regular file instead of writing through it.
  await atomicWriteJSON(filePath, tasks, {
    noFollow: true,
    assertCanCommit: options.assertCanCommit,
  });
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
  options: { assertCanCommit?: () => void } = {},
): Promise<void> {
  const filePath = getCronFilePath(projectRoot);
  return getUpdateMutex(filePath).runExclusive(async () => {
    const release = await acquireUpdateLock(filePath);
    try {
      const tasks = await readCronTasks(projectRoot);
      const next = mutate(tasks);
      if (next !== tasks) {
        await writeCronTasks(projectRoot, next, options);
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

// Finite, not just number: JSON like -1e999 parses to -Infinity, and a
// non-finite timestamp poisons downstream date math — new Date(...)
// .toISOString() throws mid-load, and age/expiry comparisons go
// degenerate. Rejecting the entry routes it through the same
// fix-or-delete contract as any other corrupt field.
function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validates the optional run-history ring. Each entry needs a finite `at`
 * timestamp; `kind` is optional and accepted as any string (forward-compat
 * with kinds a newer writer may add). A present-but-malformed `runs` routes
 * through the same fix-or-delete contract as any other corrupt field. */
function isValidRuns(value: unknown): value is CronTaskRun[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const run = entry as Record<string, unknown>;
    return (
      isFiniteTimestamp(run['at']) &&
      (run['kind'] === undefined || typeof run['kind'] === 'string') &&
      (run['sessionId'] === undefined ||
        typeof run['sessionId'] === 'string') &&
      // Read-only legacy compat: validate so a stored `withheld` marker isn't
      // rejected on read (it is never written anymore).
      (run['withheld'] === undefined || typeof run['withheld'] === 'boolean')
    );
  });
}

function isValidTask(value: unknown): value is DurableCronTask {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['cron'] === 'string' &&
    typeof obj['prompt'] === 'string' &&
    typeof obj['recurring'] === 'boolean' &&
    isFiniteTimestamp(obj['createdAt']) &&
    (obj['lastFiredAt'] === null || isFiniteTimestamp(obj['lastFiredAt'])) &&
    // Optional fields (added for the management UI): absent is valid and
    // means "unnamed" / "enabled". Present-but-wrong-type routes through
    // the same fix-or-delete contract as any other corrupt field rather
    // than being silently coerced or dropped.
    (obj['name'] === undefined || typeof obj['name'] === 'string') &&
    (obj['enabled'] === undefined || typeof obj['enabled'] === 'boolean') &&
    (obj['disabledByArchive'] === undefined ||
      typeof obj['disabledByArchive'] === 'boolean') &&
    // A bound sessionId must be a NON-EMPTY string: an empty string would pass
    // a bare `typeof` check but the scheduler's truthy `task.sessionId` guard
    // would treat it as unbound, so a "bound" task would silently run unbound.
    (obj['sessionId'] === undefined ||
      (typeof obj['sessionId'] === 'string' && obj['sessionId'].length > 0)) &&
    (obj['runs'] === undefined || isValidRuns(obj['runs']))
  );
}

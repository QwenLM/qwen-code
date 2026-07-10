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
   * Set when this fire was delivered but its prompt never ran, because the
   * task's precondition did not release it. The scheduler books the run the
   * moment it fires — before the bound session has evaluated anything — so
   * without this a withheld fire and a dispatched one are the same record, and
   * a management UI reports "ran at 02:00" for a task that deliberately did
   * nothing. Stamped afterwards by the evaluating session
   * ({@link markCronRunWithheld}). Absent means the fire was dispatched, or
   * predates the field.
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
   * How each scheduled fire runs. Absent or `'shared'` = the #6389 model: the
   * task fires inside its single bound {@link sessionId} session and every run
   * accumulates in that one transcript. `'isolated'` = the owning session
   * dispatches each fire straight into a FRESH sub-session (its own clean
   * context and transcript) and never runs the prompt inline. Absent defaults to
   * `'shared'` so tool-created and legacy tasks are unchanged. The scheduler
   * treats both modes identically — it only carries the field to `onFire`, which
   * is where the routing happens.
   */
  runMode?: 'shared' | 'isolated';
  /**
   * Optional PRECONDITION guarding each fire of an `isolated` task. When set,
   * the bound session first runs this text as its own cron turn (a normal model
   * turn, with tools, under the workspace's approval mode) and only dispatches
   * {@link prompt} into a fresh sub-session when that turn's verdict is YES. Any
   * other outcome — NO, an unparseable answer, a tool-loop error, a cancelled or
   * timed-out turn — skips the fire (fail-closed).
   *
   * Only meaningful with `runMode: 'isolated'`; the REST route rejects a
   * condition on a `'shared'` task, and the scheduler/session consult the field
   * only on the isolated path. Absent = fire unconditionally, which is what
   * every tool-created and pre-existing task keeps doing.
   */
  condition?: string;
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
      (run['withheld'] === undefined || typeof run['withheld'] === 'boolean')
    );
  });
}

/**
 * Stamps the run recorded for `at` on task `taskId` as withheld — the fire was
 * delivered, but its precondition did not release the prompt.
 *
 * Matched on the exact fire timestamp rather than "the newest run": the
 * scheduler stamps `runs[].at` from the very `lastFiredAt` it hands to `onFire`,
 * so the evaluating session knows precisely which record is its own, and a
 * concurrent fire of the same task cannot be mislabelled.
 *
 * Best-effort and idempotent. A no-op when the task, the run, or the field is
 * already gone/set — the scheduler persists the run asynchronously, and losing
 * a cosmetic marker must never fail a fire. Callers should not await it on any
 * path that gates behaviour.
 */
export async function markCronRunWithheld(
  projectRoot: string,
  taskId: string,
  at: number,
): Promise<boolean> {
  let marked = false;
  await updateCronTasks(projectRoot, (tasks) => {
    const index = tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return tasks;
    const task = tasks[index]!;
    const runs = task.runs;
    if (!Array.isArray(runs)) return tasks;
    const runIndex = runs.findIndex((r) => r.at === at);
    if (runIndex === -1 || runs[runIndex]!.withheld === true) return tasks;
    marked = true;
    const nextRuns = runs.map((run, i) =>
      i === runIndex ? { ...run, withheld: true } : run,
    );
    return tasks.map((t, i) => (i === index ? { ...t, runs: nextRuns } : t));
  });
  return marked;
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
    // Absent = 'shared'. Any string other than the two known modes routes
    // through fix-or-delete rather than being silently treated as 'shared',
    // so a typo can't quietly disable per-run isolation.
    (obj['runMode'] === undefined ||
      obj['runMode'] === 'shared' ||
      obj['runMode'] === 'isolated') &&
    // A precondition must be a NON-EMPTY string: the fire path gates on a
    // truthy `condition`, so an empty one would validate here and then be
    // silently ignored — a task the user believes is guarded would fire
    // unconditionally. Absent is the only way to say "no precondition".
    (obj['condition'] === undefined ||
      (typeof obj['condition'] === 'string' && obj['condition'].length > 0)) &&
    (obj['runs'] === undefined || isValidRuns(obj['runs']))
  );
}

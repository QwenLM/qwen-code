/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scheduled prompts, stored in a project's `CONFIG_DIR/scheduled_tasks.json`.
 *
 * Tasks come in two flavors:
 *   - One-shot (recurring: false/undefined) — fire once, then auto-delete.
 *   - Recurring (recurring: true) — fire on schedule, reschedule from now,
 *     persist until explicitly deleted or auto-expire after
 *     a configurable limit (DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs).
 *
 * File format:
 *   { "tasks": [{ id, cron, prompt, createdAt, recurring?, permanent? }] }
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_DIR } from '../utils/paths.js';
import { parseCustomContext } from '../utils/sessionIdContext.js';
import { computeNextCronRun, parseCronExpression } from './cron-parser.js';

export type CronTask = {
  id: string;
  /** 5-field cron string (local time) — validated on write, re-validated on read. */
  cron: string;
  /** Prompt to enqueue when the task fires. */
  prompt: string;
  /** Opaque per-turn identity captured when the task was created. */
  customContext?: Readonly<Record<string, string>>;
  /** Epoch ms when the task was created. Anchor for missed-task detection. */
  createdAt: number;
  /**
   * Epoch ms of the most recent fire. Written back by the scheduler after
   * each recurring fire so next-fire computation survives process restarts.
   */
  lastFiredAt?: number;
  /**
   * Lifetime fire count, incremented on the same write that stamps
   * `lastFiredAt`. The scheduler's in-process counter restarts at 1 with every
   * process, so a durable task that has fired for weeks looks brand new to it;
   * this is the only place the real total survives. Absent on a task that has
   * never fired, and on session tasks, which cannot outlive their process.
   */
  fireCount?: number;
  /**
   * Lifetime credits this task's runs have cost.
   *
   * Absent until a metered turn has completed. Absent is not zero: a task whose
   * turns were never metered has an unknown cost, which is a different claim from
   * having cost nothing.
   */
  creditsUsed?: number;
  /**
   * Stop after this many fires. Absent means no limit.
   *
   * Counted against {@link fireCount}, the lifetime total that survives restarts,
   * so a task cannot win a fresh allowance by being reloaded.
   */
  maxTurns?: number;
  /**
   * Stop once {@link creditsUsed} reaches this. Absent means no limit.
   *
   * Checked after a turn is metered, so a single expensive turn can finish
   * slightly over the line. Stopping mid-turn to hold an exact ceiling would
   * discard work already paid for.
   */
  maxCredits?: number;
  /** When true, the task reschedules after firing instead of being deleted. */
  recurring?: boolean;
  /**
   * When true, the task is exempt from recurringMaxAgeMs auto-expiry.
   * System escape hatch for built-in tasks — not settable via user-facing tools.
   */
  permanent?: boolean;
  /**
   * Epoch ms when this task should auto-expire. Takes precedence over the
   * global recurringMaxAgeMs when set. Persisted to disk for durable tasks.
   * - undefined: use global default (7 days from creation)
   * - set: expire at this specific time
   * Ignored when `permanent` is true.
   */
  expiresAt?: number;
  /**
   * Session that created this task. Persisted for durable tasks so the
   * scheduler can enforce session ownership: only the creating session
   * auto-fires a durable task; other sessions must claim it explicitly
   * via /crontab. Tasks without this field (legacy) are treated as
   * unclaimed — never auto-fired.
   */
  createdBySessionId?: string;
  /** PID of the creating process — used to display owner liveness in /crontab. */
  createdByPid?: number;
  /** Epoch ms start time of the creating process — guards against PID reuse. */
  createdByProcStart?: number;
  /**
   * Runtime-only flag controlling task persistence behavior.
   * - undefined: file-backed task (persisted to
   *   CONFIG_DIR/scheduled_tasks.json)
   * - true: durable task (written to disk, survives restarts)
   * - false: non-durable task (in-memory only, dies with the session)
   *
   * writeCronTasks strips this field so the on-disk shape stays clean.
   */
  durable?: boolean;
  /**
   * Runtime-only. When set, the task was created by an in-process sub-agent.
   * The scheduler routes fires to that agent's queue instead of the main loop.
   * Never written to disk (agent crons are always session-only).
   */
  agentId?: string;
};

type CronFile = { tasks: CronTask[] };

const CRON_FILE_REL = join(CONFIG_DIR, 'scheduled_tasks.json');

// ---------------------------------------------------------------------------
// Session-scoped in-memory task store (non-durable tasks)
// ---------------------------------------------------------------------------

/**
 * In-memory store for the non-durable tasks of one session.
 *
 * Instance state rather than module state on purpose. A process can host several
 * sessions, and a module-level array would let one session fire, list, edit and
 * delete another session's tasks — and one session's teardown would empty the
 * store for all of them. Owned by `CronManager`
 * (see cronManager.ts), of which `Config` holds exactly one per session.
 */
export class SessionCronTaskStore {
  private tasks: CronTask[] = [];

  /** Add a session-scoped task. Never written to disk. */
  add(task: CronTask): void {
    this.tasks.push(task);
  }

  /**
   * The live task objects, not copies.
   *
   * The scheduler stamps `lastFiredAt` and `fireCount` in place on a recurring
   * session task, and /crontab renders these same objects — handing out copies
   * would leave the panel showing a task that never appears to run.
   */
  getAll(): CronTask[] {
    return this.tasks;
  }

  find(id: string): CronTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** Remove tasks by id. Returns how many were actually present. */
  remove(ids: string[]): number {
    const idSet = new Set(ids);
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => !idSet.has(t.id));
    return before - this.tasks.length;
  }

  /** Drop every task, e.g. when the owning session ends. */
  clear(): void {
    this.tasks = [];
  }
}

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------

/**
 * Path to the cron file. `dir` defaults to cwd — pass it explicitly from
 * contexts that don't have a known project root.
 */
export function getCronFilePath(dir?: string): string {
  return join(dir ?? process.cwd(), CRON_FILE_REL);
}

// ---------------------------------------------------------------------------
// Safe JSON parsing
// ---------------------------------------------------------------------------

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

/**
 * Read and parse the configured scheduled_tasks.json. Returns an empty task
 * list if the file is missing, empty, or malformed. Tasks with invalid cron
 * strings are silently dropped so a single bad entry never blocks the whole
 * file.
 */
export async function readCronTasks(dir?: string): Promise<CronTask[]> {
  let raw: string;
  try {
    raw = await readFile(getCronFilePath(dir), { encoding: 'utf-8' });
  } catch {
    return [];
  }

  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== 'object') return [];
  const file = parsed as Partial<CronFile>;
  if (!Array.isArray(file.tasks)) return [];

  const out: CronTask[] = [];
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      continue;
    }
    if (!parseCronExpression(t.cron)) {
      continue;
    }
    const customContext = parseCustomContext(t.customContext);
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(customContext !== undefined ? { customContext } : {}),
      ...(typeof t.lastFiredAt === 'number'
        ? { lastFiredAt: t.lastFiredAt }
        : {}),
      // Lifetime fire count. Dropping it here would reset the total on every
      // reload, which is the exact failure the persisted counter exists to avoid.
      ...(typeof t.fireCount === 'number' && t.fireCount >= 0
        ? { fireCount: t.fireCount }
        : {}),
      // Lifetime cost and the two ceilings. Rebuilt field by field for the same
      // reason as fireCount: anything this literal omits is dropped on the next
      // write, and a limit that forgets itself stops limiting anything.
      ...(typeof t.creditsUsed === 'number' &&
      Number.isFinite(t.creditsUsed) &&
      t.creditsUsed >= 0
        ? { creditsUsed: t.creditsUsed }
        : {}),
      ...(typeof t.maxTurns === 'number' &&
      Number.isFinite(t.maxTurns) &&
      t.maxTurns > 0
        ? { maxTurns: t.maxTurns }
        : {}),
      ...(typeof t.maxCredits === 'number' &&
      Number.isFinite(t.maxCredits) &&
      t.maxCredits > 0
        ? { maxCredits: t.maxCredits }
        : {}),
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.permanent ? { permanent: true } : {}),
      ...(typeof t.expiresAt === 'number'
        ? { expiresAt: t.expiresAt }
        : {}),
      // Ownership fingerprint (session-scope isolation)
      ...(typeof t.createdBySessionId === 'string'
        ? { createdBySessionId: t.createdBySessionId }
        : {}),
      ...(typeof t.createdByPid === 'number'
        ? { createdByPid: t.createdByPid }
        : {}),
      ...(typeof t.createdByProcStart === 'number'
        ? { createdByProcStart: t.createdByProcStart }
        : {}),
    });
  }
  return out;
}

/**
 * Sync check for whether the cron file has any valid tasks. Used by
 * the scheduler start() to decide whether to auto-enable. One file read.
 */
export function hasCronTasksSync(dir?: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(getCronFilePath(dir), 'utf-8');
  } catch {
    return false;
  }
  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== 'object') return false;
  const tasks = (parsed as Partial<CronFile>).tasks;
  return Array.isArray(tasks) && tasks.length > 0;
}

/**
 * Returns the number of valid persisted cron tasks on disk.
 * Used for startup notifications. Returns 0 on any error.
 */
export function countCronTasksSync(dir?: string): number {
  let raw: string;
  try {
    raw = readFileSync(getCronFilePath(dir), 'utf-8');
  } catch {
    return 0;
  }
  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== 'object') return 0;
  const tasks = (parsed as Partial<CronFile>).tasks;
  return Array.isArray(tasks) ? tasks.length : 0;
}

/**
 * Serialises every read-modify-write against the task file.
 *
 * Callers mutate by reading the whole file, changing a task, and writing the
 * whole file back. Two of those interleaving lose one of the two changes, and a
 * write landing while another is mid-flight can leave the file unparseable.
 * That was tolerable while the only writer was the fire stamp; recording a run
 * adds a second writer on a different clock — the fire stamps when the schedule
 * fires, the run record when the turn that served it finishes — so the two
 * genuinely overlap.
 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Run `op` after every previously queued file mutation has settled.
 *
 * A rejection is contained: the chain continues so one failed write cannot
 * wedge every later one, while the caller still sees its own error.
 */
function queueFileMutation<T>(op: () => Promise<T>): Promise<T> {
  const result = writeChain.then(op, op);
  writeChain = result.catch(() => undefined);
  return result;
}

/**
 * Overwrite the configured scheduled_tasks.json with the given tasks. Creates
 * the project config directory if missing. An empty task list writes an empty
 * file instead of deleting it, so the file watcher sees a change event when the
 * last task is removed.
 */
export async function writeCronTasks(
  tasks: CronTask[],
  dir?: string,
): Promise<void> {
  await queueFileMutation(() => writeCronTasksUnqueued(tasks, dir));
}

/**
 * The write itself, without taking a place in the queue.
 *
 * For callers already running inside {@link queueFileMutation}: going through
 * the public entry point from there would wait on a chain that cannot advance
 * until the current operation finishes, which is a deadlock.
 */
async function writeCronTasksUnqueued(
  tasks: CronTask[],
  dir?: string,
): Promise<void> {
  const root = dir ?? process.cwd();
  await mkdir(join(root, CONFIG_DIR), { recursive: true });
  // Strip the runtime-only `durable` and `agentId` flags
  const body: CronFile = {
    tasks: tasks.map(({ durable: _durable, agentId: _agentId, ...rest }) => rest),
  };
  await writeFile(
    getCronFilePath(root),
    JSON.stringify(body, null, 2) + '\n',
    'utf-8',
  );
}

/**
 * Add what a completed run cost to a task's lifetime total.
 *
 * Called when the turn that executed a fired prompt ends, which is the first
 * moment the cost is known. The fire itself is counted separately by
 * {@link markCronTasksFired}, so a task that fires but never completes a turn
 * shows the fire and no cost — the honest reading of that state.
 *
 * File store only. A session task's spend is recorded in memory by
 * `CronManager.addTaskCredits`, which tries its own store first and falls
 * through to here.
 */
export async function addCronTaskCredits(
  id: string,
  credits: number,
  dir?: string,
): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;

  await queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    task.creditsUsed = (task.creditsUsed ?? 0) + credits;
    await writeCronTasksUnqueued(tasks, dir);
  });
}

/**
 * Why a task has stopped, or null while it may still run.
 *
 * Returned rather than acted on so the caller decides what to say and to whom;
 * the same verdict drives the scheduler's stop, the panel's label, and the
 * message the model is told.
 */
export type CronBudgetVerdict =
  | { reason: 'max-turns'; limit: number; reached: number }
  | { reason: 'max-credits'; limit: number; reached: number }
  | null;

/**
 * Whether a task has spent its allowance.
 *
 * Turns are checked before credits so a task that hit both reports the one the
 * user is more likely to have set deliberately. Both compare with `>=`: the limit
 * is a ceiling to arrive at, not one to exceed.
 */
export function checkCronBudget(task: CronTask): CronBudgetVerdict {
  const fires = task.fireCount ?? 0;
  if (task.maxTurns !== undefined && fires >= task.maxTurns) {
    return { reason: 'max-turns', limit: task.maxTurns, reached: fires };
  }
  const credits = task.creditsUsed ?? 0;
  if (task.maxCredits !== undefined && credits >= task.maxCredits) {
    return { reason: 'max-credits', limit: task.maxCredits, reached: credits };
  }
  return null;
}

/**
 * Shape a task without deciding where it lives.
 *
 * Split out of the old `addCronTask` because "session store or file store" is a
 * per-session decision, and the session store belongs to whoever owns the
 * session. `CronManager.addTask` calls this and then routes the result;
 * the caller is responsible for having already validated the cron string.
 */
export function buildCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  opts?: {
    permanent?: boolean;
    expiresAt?: number;
    /** Creating session identity — persisted on durable tasks for ownership. */
    owner?: { sessionId: string; pid: number; procStart: number };
    /** Stop after this many fires. */
    maxTurns?: number;
    /** Stop once this many credits have been spent. */
    maxCredits?: number;
    /** Identity snapshot inherited by each fired turn. */
    customContext?: Readonly<Record<string, string>>;
  },
): CronTask {
  // Short ID — 8 hex chars is plenty for typical task counts
  const task: CronTask = {
    id: randomUUID().slice(0, 8),
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
    ...(opts?.permanent ? { permanent: true } : {}),
    ...(opts?.expiresAt !== undefined && !opts?.permanent ? { expiresAt: opts.expiresAt } : {}),
    ...(opts?.maxTurns !== undefined && opts.maxTurns > 0
      ? { maxTurns: opts.maxTurns }
      : {}),
    ...(opts?.maxCredits !== undefined && opts.maxCredits > 0
      ? { maxCredits: opts.maxCredits }
      : {}),
    ...(opts?.customContext !== undefined
      ? { customContext: Object.freeze({ ...opts.customContext }) }
      : {}),
  };
  // Durable tasks carry the creator fingerprint so other sessions in the
  // same workspace never auto-fire them (feedback: cross-session injection).
  if (opts?.owner) {
    task.createdBySessionId = opts.owner.sessionId;
    task.createdByPid = opts.owner.pid;
    task.createdByProcStart = opts.owner.procStart;
  }
  return task;
}

/** Append an already-shaped task to the file store. */
export async function appendCronTask(
  task: CronTask,
  dir?: string,
): Promise<void> {
  await queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    tasks.push(task);
    await writeCronTasksUnqueued(tasks, dir);
  });
}

/**
 * Re-bind a durable task to a new owning session (explicit claim from
 * /crontab). Returns false when the task id is not found in the file store.
 */
export async function claimCronTask(
  id: string,
  owner: { sessionId: string; pid: number; procStart: number },
  dir?: string,
): Promise<boolean> {
  return queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    const task = tasks.find((t) => t.id === id);
    if (!task) return false;
    task.createdBySessionId = owner.sessionId;
    task.createdByPid = owner.pid;
    task.createdByProcStart = owner.procStart;
    await writeCronTasksUnqueued(tasks, dir);
    return true;
  });
}

/**
 * Remove file-backed tasks by id. No-op if none match (e.g. another session
 * raced us).
 *
 * File store only — `CronManager.removeTasks` sweeps its own session
 * store first and skips this entirely when every id was accounted for there.
 */
export async function removeCronTasks(
  ids: string[],
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  await queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    const remaining = tasks.filter((t) => !idSet.has(t.id));
    if (remaining.length === tasks.length) return;
    await writeCronTasksUnqueued(remaining, dir);
  });
}

/**
 * Stamp `lastFiredAt` on the given recurring tasks and write back. Batched
 * so N fires in one scheduler tick = one read-modify-write. Only touches
 * file-backed tasks — session tasks die with the process.
 *
 * Also advances `fireCount`. It rides on this write rather than getting one of
 * its own: the lifetime total is worth nothing if it costs an extra disk write
 * per fire.
 */
export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  // The read and the write are one queued operation. Queueing only the write
  // would still let a concurrent mutation read the same tasks and overwrite this
  // one's stamps — serialised writes are not the same as an atomic update.
  await queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    let changed = false;
    for (const t of tasks) {
      if (idSet.has(t.id)) {
        t.lastFiredAt = firedAt;
        t.fireCount = (t.fireCount ?? 0) + 1;
        changed = true;
      }
    }
    if (!changed) return;
    await writeCronTasksUnqueued(tasks, dir);
  });
}

/**
 * Update expiry settings for a file-backed task.
 * - `expiresAt: number` → set explicit expiry timestamp
 * - `expiresAt: undefined` + `permanent: true` → make permanent
 * - `expiresAt: undefined` + `permanent: false` → revert to default 7d expiry
 *
 * File store only — `CronManager.updateTaskExpiry` applies the same
 * update to a session task in memory when it has one.
 */
export async function updateCronTaskExpiry(
  id: string,
  update: { expiresAt?: number; permanent?: boolean },
  dir?: string,
): Promise<boolean> {
  return queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    const task = tasks.find((t) => t.id === id);
    if (!task) return false;
    if (update.permanent !== undefined) {
      task.permanent = update.permanent || undefined;
    }
    task.expiresAt = update.expiresAt;
    await writeCronTasksUnqueued(tasks, dir);
    return true;
  });
}

/**
 * The field-update rules for a task, shared by the file store and the session
 * store so the two cannot drift.
 *
 * `expiresAt` uses key-presence semantics: passing `expiresAt: undefined`
 * explicitly clears the field (e.g. when switching a task to permanent),
 * while omitting the key leaves it untouched.
 */
export function applyCronTaskUpdate(
  task: CronTask,
  update: {
    cron?: string;
    prompt?: string;
    expiresAt?: number;
    permanent?: boolean;
    maxTurns?: number;
    maxCredits?: number;
  },
): void {
  if (update.cron !== undefined) task.cron = update.cron;
  if (update.prompt !== undefined) task.prompt = update.prompt;
  if (update.permanent !== undefined) task.permanent = update.permanent || undefined;
  if ('expiresAt' in update) task.expiresAt = update.expiresAt;
  // Key presence clears, as with expiresAt: passing the key explicitly
  // undefined removes the ceiling, while omitting it leaves it alone. A limit
  // has to be removable, or a typo in the panel would be permanent.
  if ('maxTurns' in update) task.maxTurns = update.maxTurns;
  if ('maxCredits' in update) task.maxCredits = update.maxCredits;
}

/**
 * Update arbitrary fields (cron, prompt, expiresAt, permanent, ceilings) on a
 * file-backed task.
 *
 * File store only — `CronManager.updateTask` tries its own store first
 * and applies {@link applyCronTaskUpdate} in memory when the task is there.
 */
export async function updateCronTask(
  id: string,
  update: {
    cron?: string;
    prompt?: string;
    expiresAt?: number;
    permanent?: boolean;
    maxTurns?: number;
    maxCredits?: number;
  },
  dir?: string,
): Promise<boolean> {
  return queueFileMutation(async () => {
    const tasks = await readCronTasks(dir);
    const task = tasks.find((t) => t.id === id);
    if (!task) return false;
    applyCronTaskUpdate(task, update);
    await writeCronTasksUnqueued(tasks, dir);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Fire-time computation & jitter
// ---------------------------------------------------------------------------

/**
 * Next fire time in epoch ms for a cron string, strictly after `fromMs`.
 * Returns null if invalid or no match in the next 366 days.
 *
 * @param cron - A 5-field cron expression (e.g. "0 9 * * *")
 * @param fromMs - Epoch timestamp from which to find the next fire time (exclusive)
 * @returns Next fire time in epoch ms, or null if cron is invalid or unreachable
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron);
  if (!fields) return null;
  const next = computeNextCronRun(fields, new Date(fromMs));
  return next ? next.getTime() : null;
}

/**
 * Cron scheduler tuning knobs for jitter and load balancing.
 * Defaults preserve pre-config behavior; callers may override for fleet-wide tuning.
 *
 * Jitter serves two purposes:
 * - Recurring tasks: spread fire times to avoid thundering herd
 * - One-shot tasks: fire slightly early on aligned minutes to spread system load
 */
export type CronJitterConfig = {
  /** Recurring-task forward delay as a fraction of the interval between fires. */
  recurringFrac: number;
  /** Upper bound on recurring forward delay regardless of interval length. */
  recurringCapMs: number;
  /** One-shot backward lead: maximum ms a task may fire early. */
  oneShotMaxMs: number;
  /** One-shot backward lead: minimum ms a task fires early. */
  oneShotFloorMs: number;
  /** Jitter fires landing on minutes where `minute % N === 0`. */
  oneShotMinuteMod: number;
  /** Recurring tasks auto-expire this many ms after creation (0 = unlimited). */
  recurringMaxAgeMs: number;
};

// ─── Jitter timing constants ────────────────────────────────────────────────
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Recurring tasks auto-expire after 7 days of inactivity. */
const DEFAULT_RECURRING_MAX_AGE_MS = 7 * MS_PER_DAY;
/** Max forward delay for recurring tasks: 15 minutes. */
const DEFAULT_RECURRING_CAP_MS = 15 * MS_PER_MINUTE;
/** Max early-fire window for one-shot tasks: 90 seconds. */
const DEFAULT_ONESHOT_MAX_MS = 90 * 1000;

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: DEFAULT_RECURRING_CAP_MS,
  oneShotMaxMs: DEFAULT_ONESHOT_MAX_MS,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: DEFAULT_RECURRING_MAX_AGE_MS,
};

/**
 * taskId is an 8-hex-char UUID slice → parse as u32 → [0, 1).
 * Stable across restarts, uniformly distributed.
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(frac) ? frac : 0;
}

/**
 * Same as nextCronRunMs, plus a deterministic per-task delay to avoid a
 * thundering herd when many sessions schedule the same cron string.
 *
 * Only used for recurring tasks. One-shot tasks use oneShotJitteredNextCronRunMs.
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  const t2 = nextCronRunMs(cron, t1);
  // No second match → nothing to proportion against, fire on t1.
  if (t2 === null) return t1;
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  );
  return t1 + jitter;
}

/**
 * Same as nextCronRunMs, minus a deterministic per-task lead time when the
 * fire time lands on a minute boundary matching oneShotMinuteMod.
 *
 * One-shot tasks are user-pinned ("remind me at 3pm") so delaying them breaks
 * the contract — but firing slightly early is invisible and spreads the spike.
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1;
  const lead =
    cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs);
  return Math.max(t1 - lead, fromMs);
}

/**
 * A task is "missed" when its next scheduled run (computed from createdAt or
 * lastFiredAt) is in the past. Surfaced to the user at startup.
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter(t => {
    const anchor = t.lastFiredAt ?? t.createdAt;
    const next = nextCronRunMs(t.cron, anchor);
    return next !== null && next < nowMs;
  });
}

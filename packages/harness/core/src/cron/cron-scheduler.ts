/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Non-React scheduler core for .qwen/scheduled_tasks.json.
 *
 * Lifecycle: load tasks + watch the file + start a 1s check timer →
 * on fire, call onFire(prompt) (or onFireTask(task) when provided).
 * stop() tears everything down.
 */

import type { FSWatcher } from 'chokidar';

import { CONFIG_DIR } from '../utils/paths.js';
import { cronToHuman } from './cron-parser.js';
import {
  type CronBudgetVerdict,
  type CronJitterConfig,
  type CronTask,
  type SessionCronTaskStore,
  checkCronBudget,
  DEFAULT_CRON_JITTER_CONFIG,
  findMissedTasks,
  getCronFilePath,
  hasCronTasksSync,
  jitteredNextCronRunMs,
  markCronTasksFired,
  oneShotJitteredNextCronRunMs,
  readCronTasks,
  removeCronTasks,
} from './cron-tasks.js';
import type { CronFireSink } from './cron-fire-registry.js';

/** Check for cron fires every 1 second (1000 ms). */
const CHECK_INTERVAL_MS = 1000;
/** File must be stable (not changing) for 300ms before reading. Prevents partial writes. */
const FILE_STABILITY_MS = 300;

/**
 * True when a recurring task has expired and should be deleted on its next fire.
 * Priority: permanent (never) > expiresAt (per-task) > maxAgeMs (global default).
 */
export function isRecurringTaskAged(
  t: CronTask,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!t.recurring) return false;
  if (t.permanent) return false;
  // Per-task expiry takes precedence over global default
  if (t.expiresAt !== undefined) return nowMs >= t.expiresAt;
  // Global default (0 = unlimited)
  if (maxAgeMs === 0) return false;
  return nowMs - t.createdAt >= maxAgeMs;
}

export type CronSchedulerOptions = {
  /** Called when a task fires (regular or missed-on-startup). */
  onFire: (prompt: string) => void;
  /** While true, firing is deferred to the next tick. */
  isLoading: () => boolean;
  /**
   * When provided, receives the full CronTask on normal fires (and onFire is
   * NOT called for that fire). Lets callers see the task id/cron/etc instead
   * of just the prompt string.
   */
  onFireTask?: (task: CronTask) => void;
  /**
   * When provided, receives the missed one-shot tasks on initial load (and
   * onFire is NOT called with the pre-formatted notification). Caller decides
   * how to surface them.
   */
  onMissed?: (tasks: CronTask[]) => void;
  /**
   * Directory containing .qwen/scheduled_tasks.json. Defaults to cwd.
   */
  dir?: string;
  /**
   * The owning session's in-memory store of non-durable tasks. Omit it and the
   * scheduler runs file-backed tasks only, which is what a caller that points
   * `dir` at somebody else's workspace wants.
   *
   * Passed in rather than read from a module global: a process can host several
   * sessions, and a shared store would let one session's scheduler fire and
   * delete another session's tasks.
   */
  sessionTasks?: SessionCronTaskStore;
  /**
   * Returns the cron jitter config to use for this tick. Called once per
   * check() cycle. When omitted, DEFAULT_CRON_JITTER_CONFIG is used.
   */
  getJitterConfig?: () => CronJitterConfig;
  /**
   * Killswitch: polled once per check() tick. When true, check() bails
   * before firing anything — existing crons stop dead mid-session.
   */
  isKilled?: () => boolean;
  /**
   * Per-task gate applied before any side effect. Tasks returning false are
   * invisible to this scheduler: never fired, never stamped, never deleted.
   *
   * `isSession` is true for in-memory session-only tasks and false for
   * file-backed ones — the two need different ownership rules, and the
   * runtime `durable` flag is not available here (writeCronTasks strips it
   * and readCronTasks never restores it).
   */
  filter?: (t: CronTask, isSession: boolean) => boolean;
  /**
   * Called when a task is retired for spending its turn or credit allowance,
   * instead of firing. The scheduler has already removed the task by then; the
   * callback exists to tell somebody, which is not the scheduler's job.
   */
  onBudgetExhausted?: (t: CronTask, verdict: CronBudgetVerdict) => void;
  /**
   * The owning session's parked-fire registry. Injected rather than reached
   * through a module global: the registry belongs to one session, and a shared
   * one would hand its fires to whichever session's agent loop happened to
   * dequeue the prompt.
   *
   * Omitted only by callers that drive a scheduler without a manager, which get
   * no parking — so their fires are never charged back to a task. Production
   * always supplies it.
   */
  fireContext?: CronFireSink;
};

export type CronScheduler = {
  start: () => void;
  stop: () => void;
  /**
   * Epoch ms of the soonest scheduled fire across all loaded tasks, or null
   * if nothing is scheduled (no tasks, or all tasks already in-flight).
   */
  getNextFireTime: () => number | null;
};

/**
 * Create a cron scheduler for managing .qwen/scheduled_tasks.json.
 *
 * @param options - Configuration including callbacks, directory path, and jitter settings
 * @returns A scheduler object with start/stop/getNextFireTime methods
 */
export function createCronScheduler(
  options: CronSchedulerOptions,
): CronScheduler {
  const {
    onFire,
    isLoading,
    onFireTask,
    onMissed,
    dir,
    sessionTasks,
    getJitterConfig,
    isKilled,
    filter,
    onBudgetExhausted,
    fireContext,
  } = options;

  // A scheduler is created per CronManager, so a context handed in is already
  // per-session. Without one there is no agent loop to claim the fire and no
  // manager to charge it to, so nothing is parked.

  // File-backed tasks only. Session tasks are read fresh per tick.
  let tasks: CronTask[] = [];
  // Per-task next-fire times (epoch ms).
  const nextFireAt = new Map<string, number>();
  // Ids we've already enqueued a "missed task" prompt for.
  const missedAsked = new Set<string>();
  // Tasks currently enqueued but not yet removed from the file.
  const inFlight = new Set<string>();

  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let watcher: FSWatcher | null = null;
  let stopped = false;

  async function load(initial: boolean) {
    const next = await readCronTasks(dir);
    if (stopped) return;
    tasks = next;

    // Only surface missed tasks on initial load.
    if (!initial) return;

    const now = Date.now();
    const missed = findMissedTasks(next, now).filter(
      t => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t, false)),
    );
    if (missed.length > 0) {
      for (const t of missed) {
        missedAsked.add(t.id);
        // Prevent check() from re-firing while removeCronTasks resolves.
        nextFireAt.set(t.id, Infinity);
      }
      if (onMissed) {
        onMissed(missed);
      } else {
        onFire(buildMissedTaskNotification(missed));
      }
      void removeCronTasks(
        missed.map(t => t.id),
        dir,
      ).catch(() => {
        // Surfacing failures here would conflict with the missed-task UX —
        // the user already saw the prompts.
      });
    }
  }

  function check() {
    if (isKilled?.()) return;
    if (isLoading()) return;
    const now = Date.now();
    const seen = new Set<string>();
    // File-backed recurring tasks that fired this tick. Batched so N fires
    // in one tick = one persistence write.
    const firedFileRecurring: string[] = [];
    const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG;

    function process(t: CronTask, isSession: boolean) {
      if (filter && !filter(t, isSession)) return;
      seen.add(t.id);
      if (inFlight.has(t.id)) return;

      let next = nextFireAt.get(t.id);
      if (next === undefined) {
        // First sight — anchor from lastFiredAt (recurring) or createdAt.
        next = t.recurring
          ? (jitteredNextCronRunMs(
              t.cron,
              t.lastFiredAt ?? t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
          : (oneShotJitteredNextCronRunMs(
              t.cron,
              t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity);
        nextFireAt.set(t.id, next);
      }

      if (now < next) return;

      // Budget gate, checked before the fire rather than after. Firing first and
      // retiring afterwards would give a task with maxTurns=3 a fourth run, and
      // the fourth is the one that costs money the user asked us not to spend.
      const verdict = checkCronBudget(t);
      if (verdict) {
        onBudgetExhausted?.(t, verdict);
        if (isSession) {
          sessionTasks?.remove([t.id]);
          nextFireAt.delete(t.id);
        } else {
          inFlight.add(t.id);
          void removeCronTasks([t.id], dir)
            .catch(() => {
              // Suppress — chokidar reload will re-anchor on the next tick.
            })
            .finally(() => inFlight.delete(t.id));
          nextFireAt.delete(t.id);
        }
        return;
      }

      // Parked before the fire callback so the pending entry exists by the time
      // a synchronous consumer starts the turn: that turn is what the claimed
      // task gets charged for.
      fireContext?.registerFire({ taskId: t.id, isWakeup: false });

      if (onFireTask) {
        onFireTask(t);
      } else {
        onFire(t.prompt);
      }

      // Aged-out recurring tasks fall through to the one-shot delete paths.
      const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs);

      if (t.recurring && !aged) {
        // Recurring: reschedule from now (not from next) to avoid rapid
        // catch-up if the session was blocked.
        const newNext =
          jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg) ?? Infinity;
        nextFireAt.set(t.id, newNext);
        if (isSession) {
          // Stamp in place. A session task is the same object /crontab renders,
          // so there is nothing to write and nothing to batch; without this the
          // panel would show what a session task cost but not how often it ran.
          t.lastFiredAt = now;
          t.fireCount = (t.fireCount ?? 0) + 1;
        } else {
          firedFileRecurring.push(t.id);
        }
      } else if (isSession) {
        // One-shot (or aged-out recurring) session task: synchronous removal.
        sessionTasks?.remove([t.id]);
        nextFireAt.delete(t.id);
      } else {
        // One-shot file task: delete from disk. inFlight guards against
        // double-fire during the async removeCronTasks + chokidar reload.
        inFlight.add(t.id);
        void removeCronTasks([t.id], dir)
          .catch(() => {
            // Suppress — chokidar reload will re-anchor on next tick.
          })
          .finally(() => inFlight.delete(t.id));
        nextFireAt.delete(t.id);
      }
    }

    // File-backed tasks. Per-task ownership is enforced by the filter
    // (createdBySessionId match): every session drives its own durable tasks
    // directly, and there is no cross-process scheduler lock to arbitrate.
    for (const t of tasks) process(t, false);
    // Batched lastFiredAt write.
    if (firedFileRecurring.length > 0) {
      for (const id of firedFileRecurring) inFlight.add(id);
      void markCronTasksFired(firedFileRecurring, now, dir)
        .catch(() => {
          // Suppress — next reload will re-seed nextFireAt idempotently.
        })
        .finally(() => {
          for (const id of firedFileRecurring) inFlight.delete(id);
        });
    }
    // Session-only tasks: private to the session that owns this scheduler.
    if (sessionTasks) {
      for (const t of sessionTasks.getAll()) process(t, true);
    }

    if (seen.size === 0) {
      // No live tasks this tick — clear schedule so getNextFireTime() returns null.
      nextFireAt.clear();
      return;
    }
    // Evict schedule entries for tasks no longer present.
    for (const id of nextFireAt.keys()) {
      if (!seen.has(id)) nextFireAt.delete(id);
    }
  }

  async function enable() {
    if (stopped) return;

    const { default: chokidar } = await import('chokidar');
    if (stopped) return;

    void load(true);

    const path = getCronFilePath(dir);
    watcher = chokidar.watch(path, {
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: FILE_STABILITY_MS },
      ignorePermissionErrors: true,
    });
    watcher.on('add', () => void load(false));
    watcher.on('change', () => void load(false));
    watcher.on('unlink', () => {
      if (!stopped) {
        tasks = [];
        nextFireAt.clear();
      }
    });

    checkTimer = setInterval(check, CHECK_INTERVAL_MS);
    // Don't keep the process alive for the scheduler alone.
    checkTimer.unref?.();
  }

  return {
    start() {
      stopped = false;
      // Pure SDK: no scheduledTasksEnabled flag/poll. Auto-enable always.
      void enable();
    },
    stop() {
      stopped = true;
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
      void watcher?.close();
      watcher = null;
    },
    getNextFireTime() {
      // nextFireAt uses Infinity for "never". Filter those out.
      let min = Infinity;
      for (const t of nextFireAt.values()) {
        if (t < min) min = t;
      }
      return min === Infinity ? null : min;
    },
  };
}

/** Re-exported for callers that want to gate their own start() on file presence. */
export { hasCronTasksSync };

/**
 * Build the missed-task notification text. Guidance precedes the task list
 * and the list is wrapped in a code fence so a multi-line imperative prompt
 * is not interpreted as immediate instructions.
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  const plural = missed.length > 1;
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while the CLI was not running. ` +
    `${plural ? 'They have' : 'It has'} already been removed from ${CONFIG_DIR}/scheduled_tasks.json.\n\n` +
    `Do NOT execute ${plural ? 'these prompts' : 'this prompt'} yet. ` +
    `First ask the user whether to run ${plural ? 'each one' : 'it'} now. ` +
    `Only execute if the user confirms.`;

  const blocks = missed.map(t => {
    const meta = `[${cronToHuman(t.cron)}, created ${new Date(t.createdAt).toLocaleString()}]`;
    // Use a fence one longer than any backtick run in the prompt so a
    // prompt containing ``` cannot close the fence early.
    const longestRun = (t.prompt.match(/`+/g) ?? ([] as string[])).reduce(
      (max: number, run: string) => Math.max(max, run.length),
      0,
    );
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${meta}\n${fence}\n${t.prompt}\n${fence}`;
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

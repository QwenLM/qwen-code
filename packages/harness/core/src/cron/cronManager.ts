/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CronManager — the cron and one-shot-wakeup state of exactly one session.
 *
 * This used to be `scheduler-manager.ts`, a pile of module-level `let`s: one
 * scheduler, one set of wakeup slots, one owner fingerprint, two registered
 * providers. That is correct while a process hosts one session, which is what
 * the CLI did. A daemon that runs several sessions in one process turns every
 * one of those slots into a cross-session write: the second session's
 * `ensureSchedulerStarted` is a no-op because `started` is already true, so it
 * never gets a scheduler of its own and its tasks are filtered by the *first*
 * session's id; its ScheduleWakeup overwrites the first session's pending timer;
 * its `/crontab` lists and deletes the other session's in-memory tasks.
 *
 * So the state moved here, and `Config` holds one instance per session
 * (`Config.getCronManager()`). Every caller reaches it through the Config it
 * already has — the tools are constructed with one, the agent loop carries one,
 * the TUI reads one from ConfigContext. Nothing in this module is reachable
 * without naming a session first, which is the point: the compiler now rejects
 * an un-threaded call site instead of silently picking somebody else's state.
 *
 * Two things stay process-level, both deliberately:
 * - **The exit handler.** One `process.on('exit')` is installed for the whole
 *   process and stops every live manager; see {@link trackManager}. Installing
 *   one per manager would leak a listener per session.
 * - **The presence clocks** in `user-activity-clock.ts` and **the per-task
 *   fire counter** in `cron-fire-registry.ts`. Presence belongs to the person at
 *   the keyboard rather than to a session, and the counter is keyed by task id,
 *   which is unique.
 *
 * The fire registry and the prompt-cache clock are per session and live on this
 * class; `cron-fire-registry.ts` explains what a process-wide copy of either
 * one gets wrong.
 */

import { randomUUID } from 'node:crypto';

import { enqueuePendingNotification } from '../services/messageQueueManager.js';
import { coreEvents } from '../utils/events.js';
import { CONFIG_DIR } from '../utils/paths.js';
import { runLogger } from '../utils/runLogger.js';
import { MAX_LOOP_MD_BYTES, readLoopMd } from '../skills/bundled/loop-md.js';
import {
  CronFireRegistry,
  type PendingCronFire,
} from './cron-fire-registry.js';
import {
  buildMissedTaskNotification,
  type CronScheduler,
  createCronScheduler,
} from './cron-scheduler.js';
import {
  type CronTask,
  addCronTaskCredits,
  appendCronTask,
  applyCronTaskUpdate,
  buildCronTask,
  claimCronTask,
  readCronTasks,
  removeCronTasks,
  SessionCronTaskStore,
  updateCronTask,
  updateCronTaskExpiry,
} from './cron-tasks.js';
import { readUserActivityClock } from './user-activity-clock.js';

// ---------------------------------------------------------------------------
// Process-level helpers
// ---------------------------------------------------------------------------

/**
 * Process-start timestamp (epoch ms). Used in owner fingerprints to guard
 * against PID reuse after reboot. Computed per call rather than at module load
 * so it stays correct across a test suite that fakes the clock.
 */
function getProcessStartMs(): number {
  // process.uptime() gives seconds since Node start → derive start epoch.
  return Date.now() - Math.round(process.uptime() * 1000);
}

/** Identity of the session that created a durable task. */
export interface CronOwnerFingerprint {
  sessionId: string;
  pid: number;
  procStart: number;
}

/**
 * Build the owner fingerprint for a task created by `sessionId` in this process.
 * Pure — the caller names the session rather than relying on scheduler start
 * order, which is not guaranteed: CronCreate can run before any AppContainer
 * effect, and headless has no AppContainer at all.
 */
export function buildOwnerFingerprint(
  sessionId: string,
): CronOwnerFingerprint {
  return { sessionId, pid: process.pid, procStart: getProcessStartMs() };
}

/**
 * Live managers, so the single process-exit handler can stop all of them.
 *
 * Reference-counted by membership: the handler is installed when the first
 * manager starts and never removed, because `process.on('exit')` cannot be
 * un-installed reliably enough to be worth the churn, and an empty set makes it
 * a no-op.
 */
const liveManagers = new Set<CronManager>();
let exitHandlerInstalled = false;

function trackManager(manager: CronManager): void {
  liveManagers.add(manager);
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const live of [...liveManagers]) {
      live.stop();
    }
  });
}

/**
 * Credits at a precision that suits the magnitude.
 *
 * A fractional cost has to stay distinguishable from no cost, so small values
 * keep their decimals; large ones do not need them.
 */
function formatCredits(credits: number): string {
  if (credits >= 100) return String(Math.round(credits));
  if (credits >= 10) return credits.toFixed(1);
  return credits.toFixed(2);
}

// Sentinel detection (strip from prompt on ingestion, track via flags instead).
// Non-global for .test() — a /g regex keeps lastIndex state across calls and
// silently skips matches on the next invocation.
const LOOP_MD_SENTINEL_TEST = /<<loop\.md(?:-dynamic)?>>/;
const AUTONOMOUS_SENTINEL_TEST = /<<autonomous-loop(?:-dynamic)?>>/;
const LOOP_MD_SENTINEL_STRIP = /<<loop\.md(?:-dynamic)?>>[\n]?/g;
const AUTONOMOUS_SENTINEL_STRIP = /<<autonomous-loop(?:-dynamic)?>>[\n]?/g;

// Sentinel markers used in /loop prompts
const SENTINEL_LOOP_MD = '<<loop.md>>';
const SENTINEL_LOOP_MD_DYNAMIC = '<<loop.md-dynamic>>';
const SENTINEL_AUTO = '<<autonomous-loop>>';
const SENTINEL_AUTO_DYNAMIC = '<<autonomous-loop-dynamic>>';

/**
 * Fallback prompt when the wakeup was armed with a pure autonomous sentinel
 * (strips to empty). Mirrors the autonomous tick semantics: re-run the loop
 * instructions established earlier in the conversation.
 */
const AUTONOMOUS_TICK_PROMPT =
  'Autonomous loop tick (dynamic pacing): run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick and end the loop by calling ScheduleWakeup with stop: true.';

/** Prefix a prompt with a timestamp for LLM context (CC behavior: transcript time markers). */
function withTimestamp(prompt: string): string {
  const timeStr = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date());
  return `[Running scheduled task (${timeStr})]\n${prompt}`;
}

const WAKEUP_MIN_DELAY_MS = 60_000; // 1 minute
const WAKEUP_MAX_DELAY_MS = 3_600_000; // 1 hour

export interface ScheduleWakeupResult {
  /** Epoch ms timestamp when the next wakeup will fire. */
  scheduledAt: number;
  /** Actual delay used after clamping to the manager's bounds (ms). */
  actualDelay: number;
  /** True if the requested delay was outside [60, 3600] seconds. */
  wasClamped: boolean;
}

export interface LoopStatus {
  /** Whether a one-shot wakeup timer is armed. */
  pendingWakeup: boolean;
  /** Epoch ms of the next scheduled fire (cron or wakeup), or null. */
  nextFireMs: number | null;
}

/**
 * What the manager needs from its owner. Deliberately not `Config`: the cron
 * modules sit below the config layer, and a narrow read-only contract keeps the
 * dependency one-directional.
 */
export interface CronManagerHost {
  /**
   * The session this manager belongs to, read live.
   *
   * Live rather than captured at construction so session rotations (/resume,
   * /clear, fork) are picked up without restarting the scheduler. The old
   * module-level design could only promise this through an externally
   * registered provider, and every path that did not register one — headless,
   * daemon — silently froze on the id the scheduler started with.
   */
  getSessionId(): string;
}

export interface EnsureCronSchedulerOptions {
  /**
   * Working directory holding `.qwen/scheduled_tasks.json`. Defaults to cwd.
   * Supplying it also detaches the session task store, which is what a caller
   * driving somebody else's workspace wants.
   */
  dir?: string;
}

/**
 * The cron and wakeup state of one session.
 *
 * Constructed by `Config`; reached through `config.getCronManager()`.
 */
export class CronManager {
  /** This session's non-durable tasks. Shared with the scheduler and /crontab. */
  readonly tasks: SessionCronTaskStore;

  /**
   * This session's parked fires and prompt-cache clock. Both describe one
   * conversation rather than the process, so both are released along with the
   * Config that owns this manager.
   */
  private readonly fires = new CronFireRegistry();

  private scheduler: CronScheduler | null = null;
  private started = false;

  /**
   * Defers fires while this session's agent is busy.
   *
   * Read at fire time rather than captured at start: the TUI installs its
   * provider from an effect, and the scheduler can already be running by then
   * (CronCreate starts it lazily, from a tool call). Capturing once meant a
   * provider registered after the start was ignored for the rest of the process.
   */
  private isLoadingProvider: (() => boolean) | null = null;

  // ── One-shot wakeup state (ScheduleWakeup tool) ──────────────────────────

  private wakeupTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeupPrompt: string | null = null;
  private wakeupCustomContext?: Readonly<Record<string, string>>;
  private wakeupScheduledAt: number | null = null;
  /** When true, the next wakeup fire should inject loop.md content. */
  private wakeupInjectLoopMd = false;
  /** When true, the wakeup came from autonomous mode (no file injection). */
  private wakeupAutonomous = false;

  /**
   * Identity of the current dynamic loop, not of one wakeup.
   *
   * A dynamic loop is a chain of one-shot timers: the model re-arms after every
   * tick. Minting a fresh id per arm would make each tick look like a separate
   * task in the warehouse, so the id is held across re-arms and only released
   * when the loop actually ends.
   */
  private wakeupLoopId: string | null = null;
  /**
   * Ceilings for the current dynamic loop, and what it has spent against them.
   *
   * A separate track from CronTask because a wakeup is not one: it lives in
   * these fields, so the scheduler's budget gate cannot see it. Without this,
   * `/loop --max-credits 50` on a dynamic loop would be silently ignored, which
   * is worse than rejecting the flag — the user would believe a cap was in place.
   *
   * Sticky across reschedules on purpose. The model calls ScheduleWakeup again
   * on every tick to set the next delay, and a ceiling that reset on each call
   * would never be reached.
   */
  private wakeupMaxTurns: number | null = null;
  private wakeupMaxCredits: number | null = null;
  private wakeupTurnsUsed = 0;
  private wakeupCreditsUsed = 0;

  /** loop.md content hash, for first-fire vs reminder injection. */
  private lastLoopMdHash: string | null = null;

  /**
   * When this session's user last submitted a prompt.
   *
   * Per session because it exists to tell a loop someone is watching from one
   * they forgot to stop. Shared across sessions, typing in one made every other
   * session's abandoned loop look attended.
   */
  private lastUserActivityAt: number | undefined;

  constructor(
    private readonly host: CronManagerHost,
    taskStore: SessionCronTaskStore = new SessionCronTaskStore(),
  ) {
    // The store is injectable so a test can seed or inspect it directly;
    // production takes the default and reaches it through `this.tasks`.
    this.tasks = taskStore;
  }

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------

  /**
   * The session this manager belongs to, read live from the owning Config.
   *
   * What the ownership comparison in /crontab needs; cheaper than minting a
   * fingerprint object on every render.
   */
  getSessionId(): string {
    return this.host.getSessionId();
  }

  /**
   * This session's fingerprint, stamped on the durable tasks it creates and
   * compared against `createdBySessionId` by the ownership gate.
   */
  getOwnerFingerprint(): CronOwnerFingerprint {
    return buildOwnerFingerprint(this.host.getSessionId());
  }

  // ---------------------------------------------------------------------------
  // Session activity
  // ---------------------------------------------------------------------------

  /**
   * Records that this session's user just submitted a prompt. Called from the
   * agent loop for interactive turns only — a scheduled fire is not user
   * activity, and counting it would make every loop look attended.
   *
   * The coarse signal, and the fallback rather than the primary one: see
   * `getUserIdleDurationMs`.
   */
  markUserActivity(now: number = Date.now()): void {
    this.lastUserActivityAt = now;
  }

  /**
   * Milliseconds since this session's user was last present, or undefined when it
   * has never seen one at all (a pure headless scheduled run).
   *
   * Prefers the host keyboard clock and falls back to this session's submission
   * clock. The later of the two is not taken: the host clock, when present, is
   * strictly better informed, and mixing them would let a stale submission time
   * mask real inactivity. Only the fallback is per session — a physical keyboard
   * belongs to the process, so the injected clock stays shared.
   */
  getUserIdleDurationMs(now: number = Date.now()): number | undefined {
    const at = readUserActivityClock() ?? this.lastUserActivityAt;
    if (at === undefined) return undefined;
    return Math.max(0, now - at);
  }

  // ---------------------------------------------------------------------------
  // Fire registry
  // ---------------------------------------------------------------------------

  /** Claims the fires this session parked that `promptText` actually carries. */
  claimPendingFires(promptText: string): PendingCronFire[] {
    return this.fires.claimPendingFires(promptText);
  }

  // ---------------------------------------------------------------------------
  // Scheduler lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Tell the scheduler when this session's agent is busy, so fires defer to the
   * next tick instead of landing mid-turn.
   *
   * Pass null to clear. Replaces the old module-level
   * `registerIsLoadingProvider`, which every session in the process overwrote.
   */
  setIsLoadingProvider(fn: (() => boolean) | null): void {
    this.isLoadingProvider = fn;
  }

  /**
   * Start the scheduler. Idempotent — calling again after the first is a no-op.
   */
  ensureStarted(options?: EnsureCronSchedulerOptions): void {
    if (this.started) return;
    this.started = true;

    runLogger.debug('[CronManager] Starting cron scheduler');

    this.scheduler = createCronScheduler({
      onFire: (prompt: string) => {
        void (async () => {
          const expanded = await this.expandSentinel(prompt);
          runLogger.debug(
            `[CronManager] Cron fired, enqueueing prompt: ${expanded.slice(0, 80)}...`,
          );
          enqueuePendingNotification({
            prompt: withTimestamp(expanded),
            commandMode: 'task-notification',
            priority: 'later',
            // Ownership stamp, read live so a rotated session still stamps
            // correctly. Every queue consumer filters on this field; without it a
            // fire is drained by whichever session is idle, or by none under ACP.
            sessionId: this.host.getSessionId(),
          });
        })();
      },
      onFireTask: (task) => {
        void (async () => {
          const expanded = await this.expandSentinel(task.prompt);
          runLogger.debug(
            `[CronManager] Cron fired, enqueueing prompt: ${expanded.slice(0, 80)}...`,
          );
          enqueuePendingNotification({
            prompt: withTimestamp(expanded),
            commandMode: 'task-notification',
            priority: 'later',
            sessionId: this.host.getSessionId(),
            ...(task.customContext !== undefined
              ? { customContext: task.customContext }
              : {}),
          });
          // Emit TurnComplete-adjacent event so CLI layer can react (e.g. show a
          // toast). Reuses user-feedback for lightweight observability.
          const timeStr = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
          }).format(new Date());
          coreEvents.emitFeedback(
            'info',
            `Scheduled task triggered (${timeStr})`,
          );
        })();
      },
      onMissed: (missed) => {
        const customContext = missed.find(
          (task) => task.customContext !== undefined,
        )?.customContext;
        enqueuePendingNotification({
          prompt: buildMissedTaskNotification(missed),
          commandMode: 'task-notification',
          priority: 'later',
          sessionId: this.host.getSessionId(),
          ...(customContext !== undefined ? { customContext } : {}),
        });
        const timeStr = new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
        }).format(new Date());
        coreEvents.emitFeedback(
          'info',
          `Scheduled task triggered (${timeStr})`,
        );
      },
      isLoading: () => this.isLoadingProvider?.() ?? false,
      // The registry describes this conversation rather than the process: a
      // shared one let one session's turn claim the fires another session's
      // scheduler had parked. Composed here rather than handed over as the
      // registry itself, so the scheduler has one seam and cannot reach the
      // claim side that belongs to the agent loop.
      fireContext: {
        registerFire: (fire) => this.fires.registerFire(fire),
      },
      dir: options?.dir,
      // A caller that points the scheduler at somebody else's workspace has no
      // business firing that workspace's in-memory tasks — which do not exist
      // there anyway. Preserves the old `dir !== undefined` bypass.
      ...(options?.dir === undefined ? { sessionTasks: this.tasks } : {}),
      // Ownership gate. Session-only tasks live in this manager's own store and
      // always fire. File-backed (durable) tasks fire only when this session
      // created them; foreign-owned and legacy no-owner tasks are skipped and
      // surfaced as 'unclaimed' in /crontab for explicit claiming.
      filter: (t, isSession) => {
        if (isSession) return true;
        const me = this.host.getSessionId();
        if (!me) return true;
        return t.createdBySessionId === me;
      },
      // Told to both audiences on purpose. The user needs to know their schedule
      // stopped and why, or a silent stop looks like a bug; the model needs it in
      // the conversation, or it will keep reasoning as though the loop is running.
      onBudgetExhausted: (task, verdict) => {
        if (!verdict) return;
        const spent =
          verdict.reason === 'max-turns'
            ? `${verdict.reached} of ${verdict.limit} turns`
            : `${formatCredits(verdict.reached)} of ${verdict.limit} credits`;
        const summary = `Scheduled task ${task.id} stopped: it used ${spent}.`;

        coreEvents.emitFeedback('info', summary);
        enqueuePendingNotification({
          prompt:
            `${summary} The task has been removed and will not fire again. ` +
            `Do not recreate it unless the user asks; report the stop instead, and ` +
            `mention that a new limit can be set with /loop --max-turns or ` +
            `--max-credits.`,
          commandMode: 'task-notification',
          priority: 'later',
          sessionId: this.host.getSessionId(),
          ...(task.customContext !== undefined
            ? { customContext: task.customContext }
            : {}),
        });
      },
    });

    this.scheduler.start();
    trackManager(this);
  }

  /**
   * Stop the scheduler and release its watcher and interval.
   * Safe to call when it was never started, and safe to call twice.
   */
  stop(): void {
    liveManagers.delete(this);
    if (this.scheduler) {
      runLogger.debug('[CronManager] Stopping cron scheduler');
      this.scheduler.stop();
      this.scheduler = null;
    }
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Epoch ms of the next scheduled cron fire, or null if nothing is scheduled. */
  getNextFireTime(): number | null {
    return this.scheduler?.getNextFireTime() ?? null;
  }

  /** Snapshot for the status bar and /loops. */
  getLoopStatus(): LoopStatus {
    const cronNext = this.getNextFireTime();
    const wakeupNext = this.wakeupScheduledAt;

    let nextFireMs: number | null = null;
    if (cronNext !== null && wakeupNext !== null) {
      nextFireMs = Math.min(cronNext, wakeupNext);
    } else {
      nextFireMs = cronNext ?? wakeupNext;
    }

    return {
      pendingWakeup: this.wakeupTimer !== null,
      nextFireMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Task store — this session's in-memory tasks plus the shared file store
  // ---------------------------------------------------------------------------

  /** This session's non-durable tasks. Never written to disk. */
  getSessionTasks(): CronTask[] {
    return this.tasks.getAll();
  }

  /** Drop this session's non-durable tasks, e.g. when the session ends. */
  clearSessionTasks(): void {
    this.tasks.clear();
  }

  /**
   * Create a task. When `durable` is false it is held in this session's memory
   * only — it fires on schedule here but is never written to disk and dies with
   * the session.
   *
   * Returns the generated id. The caller is responsible for having already
   * validated the cron string.
   */
  async addTask(
    cron: string,
    prompt: string,
    recurring: boolean,
    durable: boolean,
    opts?: {
      dir?: string;
      agentId?: string;
      permanent?: boolean;
      expiresAt?: number;
      maxTurns?: number;
      maxCredits?: number;
      customContext?: Readonly<Record<string, string>>;
    },
  ): Promise<string> {
    const task = buildCronTask(cron, prompt, recurring, {
      ...(opts?.permanent !== undefined ? { permanent: opts.permanent } : {}),
      ...(opts?.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts?.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts?.maxCredits !== undefined ? { maxCredits: opts.maxCredits } : {}),
      ...(opts?.customContext !== undefined
        ? { customContext: opts.customContext }
        : {}),
      // Only a durable task can be seen by another session, so only a durable
      // task needs to say who made it.
      ...(durable ? { owner: this.getOwnerFingerprint() } : {}),
    });

    if (!durable) {
      this.tasks.add({
        ...task,
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      });
      return task.id;
    }

    await appendCronTask(task, opts?.dir);
    return task.id;
  }

  /**
   * File-backed tasks plus this session's in-memory ones, the latter marked
   * `durable: false` so callers can tell them apart.
   *
   * Merges the session store only when `dir` is omitted — a caller pointing at
   * somebody else's workspace has no session store to merge with.
   */
  async listTasks(dir?: string): Promise<CronTask[]> {
    const fileTasks = await readCronTasks(dir);
    if (dir !== undefined) return fileTasks;
    const session = this.tasks
      .getAll()
      .map((t) => ({ ...t, durable: false as const }));
    return [...fileTasks, ...session];
  }

  /**
   * Remove tasks by id from this session's store and the file store.
   *
   * The session store goes first and, when it accounts for every id, the file
   * round-trip is skipped entirely.
   */
  async removeTasks(ids: string[], dir?: string): Promise<void> {
    if (ids.length === 0) return;
    if (dir === undefined && this.tasks.remove(ids) === ids.length) return;
    await removeCronTasks(ids, dir);
  }

  /** Update fields on a task, in this session's store or in the file. */
  async updateTask(
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
    const sessionTask = this.tasks.find(id);
    if (sessionTask) {
      applyCronTaskUpdate(sessionTask, update);
      return true;
    }
    return updateCronTask(id, update, dir);
  }

  /** Update expiry on a task, in this session's store or in the file. */
  async updateTaskExpiry(
    id: string,
    update: { expiresAt?: number; permanent?: boolean },
    dir?: string,
  ): Promise<boolean> {
    const sessionTask = this.tasks.find(id);
    if (sessionTask) {
      if (update.permanent !== undefined) {
        sessionTask.permanent = update.permanent || undefined;
      }
      sessionTask.expiresAt = update.expiresAt;
      return true;
    }
    return updateCronTaskExpiry(id, update, dir);
  }

  /** Re-bind a durable task to this session (explicit claim from /crontab). */
  claimTask(id: string, dir?: string): Promise<boolean> {
    return claimCronTask(id, this.getOwnerFingerprint(), dir);
  }

  /**
   * Charge a completed run against the task's allowance.
   *
   * Session tasks are counted in memory. Their total dies with the session,
   * which is the same deal as the task itself; a user watching a session task
   * run still wants to know what it is spending.
   */
  async addTaskCredits(
    id: string,
    credits: number,
    dir?: string,
  ): Promise<void> {
    if (!Number.isFinite(credits) || credits <= 0) return;
    // Session store first, and without the file write queue: nothing here
    // touches the file, so there is nothing to serialise against.
    const sessionTask = this.tasks.find(id);
    if (sessionTask) {
      sessionTask.creditsUsed = (sessionTask.creditsUsed ?? 0) + credits;
      return;
    }
    await addCronTaskCredits(id, credits, dir);
  }

  // ---------------------------------------------------------------------------
  // One-shot wakeup (ScheduleWakeup tool)
  // ---------------------------------------------------------------------------

  /**
   * Schedule a one-shot wakeup after `delayMs`. Fires once then auto-clears;
   * calling again replaces the previous timer.
   *
   * Semantics: calling = continue the loop; not calling = end the loop.
   */
  scheduleWakeup(
    delayMs: number,
    prompt: string,
    reason?: string,
    budget?: { maxTurns?: number; maxCredits?: number },
    customContext?: Readonly<Record<string, string>>,
  ): ScheduleWakeupResult {
    const actualDelay = Math.max(
      WAKEUP_MIN_DELAY_MS,
      Math.min(WAKEUP_MAX_DELAY_MS, delayMs),
    );
    const wasClamped = actualDelay !== delayMs;

    // Clear the timer without ending the loop: re-arming is how a dynamic loop
    // continues, so the loop identity must survive it.
    this.clearWakeupTimer();
    if (!this.wakeupLoopId) this.wakeupLoopId = randomUUID().slice(0, 8);

    // Ceilings are sticky. The model re-arms on every tick, and only the first
    // arm carries the flags the user typed; taking the latest value each time
    // would let a later arm without them silently remove the cap.
    if (budget?.maxTurns !== undefined && budget.maxTurns > 0) {
      this.wakeupMaxTurns ??= budget.maxTurns;
    }
    if (budget?.maxCredits !== undefined && budget.maxCredits > 0) {
      this.wakeupMaxCredits ??= budget.maxCredits;
    }

    // Strip sentinel markers from prompt on ingestion — track via flags instead.
    // This ensures the stored prompt is always clean for display, and the two
    // sentinel families keep their distinct semantics (loop.md injects the file;
    // autonomous never does).
    const hasLoopMdSentinel = LOOP_MD_SENTINEL_TEST.test(prompt);
    const hasAutoSentinel = AUTONOMOUS_SENTINEL_TEST.test(prompt);
    const cleanPrompt = prompt
      .replace(LOOP_MD_SENTINEL_STRIP, '')
      .replace(AUTONOMOUS_SENTINEL_STRIP, '')
      .trim();
    this.wakeupInjectLoopMd = hasLoopMdSentinel;
    this.wakeupAutonomous = hasAutoSentinel;

    const scheduledAt = Date.now() + actualDelay;
    this.wakeupPrompt = cleanPrompt;
    this.wakeupCustomContext =
      customContext === undefined
        ? undefined
        : Object.freeze({ ...customContext });
    this.wakeupScheduledAt = scheduledAt;

    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = null;
      const p = this.wakeupPrompt;
      const wakeupCustomContext = this.wakeupCustomContext;
      const injectLoopMd = this.wakeupInjectLoopMd;
      const autonomous = this.wakeupAutonomous;
      this.wakeupPrompt = null;
      this.wakeupCustomContext = undefined;
      this.wakeupScheduledAt = null;
      this.wakeupInjectLoopMd = false;
      this.wakeupAutonomous = false;
      void this.fireWakeup(
        p,
        injectLoopMd,
        autonomous,
        `Loop wakeup fired${reason ? `: ${reason}` : ''}`,
        reason,
        wakeupCustomContext,
      );
    }, actualDelay);
    this.wakeupTimer.unref?.();

    return { scheduledAt, actualDelay, wasClamped };
  }

  /** Tears down the pending timer and its prompt state, leaving the loop identity. */
  private clearWakeupTimer(): boolean {
    if (!this.wakeupTimer) return false;
    clearTimeout(this.wakeupTimer);
    this.wakeupTimer = null;
    this.wakeupPrompt = null;
    this.wakeupCustomContext = undefined;
    this.wakeupScheduledAt = null;
    this.wakeupInjectLoopMd = false;
    this.wakeupAutonomous = false;
    return true;
  }

  /**
   * Cancel a pending wakeup. Returns true if one was cancelled.
   *
   * This is the loop actually ending (the model called `stop: true`, or the tool
   * tore it down), so the loop identity is released here — unlike the
   * internal re-arm path, which keeps it.
   */
  cancelWakeup(): boolean {
    const cancelled = this.clearWakeupTimer();
    this.wakeupLoopId = null;
    // The allowance belongs to the loop, not to the session. Leaving the spend
    // behind would have the next loop start already partly spent, and leaving
    // the ceiling behind would apply it to a loop nobody capped.
    this.wakeupMaxTurns = null;
    this.wakeupMaxCredits = null;
    this.wakeupTurnsUsed = 0;
    this.wakeupCreditsUsed = 0;
    return cancelled;
  }

  /** The pending wakeup's scheduled epoch ms, or null. */
  getPendingWakeupTime(): number | null {
    return this.wakeupScheduledAt;
  }

  /** Details about the pending wakeup, or null if none. */
  getWakeupDetails(): { scheduledAt: number; prompt: string } | null {
    // wakeupPrompt may be '' (pure-sentinel wakeup) — only null means "no wakeup".
    if (!this.wakeupScheduledAt || this.wakeupPrompt === null) return null;
    return { scheduledAt: this.wakeupScheduledAt, prompt: this.wakeupPrompt };
  }

  /**
   * Update the pending wakeup's prompt and/or reschedule with a new delay.
   * Returns the new scheduled time, or null if no wakeup was pending.
   */
  updateWakeup(opts: {
    prompt?: string;
    delaySeconds?: number;
  }): number | null {
    if (!this.wakeupTimer || this.wakeupPrompt === null) return null;

    if (opts.prompt !== undefined) {
      this.wakeupPrompt = opts.prompt;
    }

    if (opts.delaySeconds !== undefined) {
      // Reschedule: cancel old timer, set new one with same callback logic
      const requestedDelay = opts.delaySeconds * 1000;
      const newDelay = Math.max(
        WAKEUP_MIN_DELAY_MS,
        Math.min(WAKEUP_MAX_DELAY_MS, requestedDelay),
      );
      clearTimeout(this.wakeupTimer);
      this.wakeupScheduledAt = Date.now() + newDelay;

      this.wakeupTimer = setTimeout(() => {
        this.wakeupTimer = null;
        const p = this.wakeupPrompt;
        const injectLoopMd = this.wakeupInjectLoopMd;
        const autonomous = this.wakeupAutonomous;
        this.wakeupPrompt = null;
        this.wakeupScheduledAt = null;
        this.wakeupInjectLoopMd = false;
        this.wakeupAutonomous = false;
        void this.fireWakeup(
          p,
          injectLoopMd,
          autonomous,
          'Loop wakeup fired (rescheduled)',
        );
      }, newDelay);
      this.wakeupTimer.unref?.();
    }

    return this.wakeupScheduledAt;
  }

  /**
   * Charge a completed turn against the dynamic loop's allowance.
   *
   * Called from the same place that charges a CronTask, so a dynamic loop and a
   * fixed one are metered by one code path rather than two that can drift.
   */
  addWakeupCredits(credits: number): void {
    if (!Number.isFinite(credits) || credits <= 0) return;
    if (this.wakeupMaxCredits === null) return;
    this.wakeupCreditsUsed += credits;
  }

  /**
   * Why the dynamic loop should stop, as the sentence to show, or null to
   * continue.
   *
   * Turns are checked before credits for the same reason as the CronTask gate: a
   * loop that hit both reports the limit the user more likely set deliberately.
   */
  private checkWakeupBudget(): string | null {
    if (this.wakeupMaxTurns !== null && this.wakeupTurnsUsed >= this.wakeupMaxTurns) {
      return `Loop stopped: it used ${this.wakeupTurnsUsed} of ${this.wakeupMaxTurns} turns.`;
    }
    if (
      this.wakeupMaxCredits !== null &&
      this.wakeupCreditsUsed >= this.wakeupMaxCredits
    ) {
      return `Loop stopped: it used ${formatCredits(this.wakeupCreditsUsed)} of ${this.wakeupMaxCredits} credits.`;
    }
    return null;
  }

  /**
   * Shared fire logic for wakeup timers (initial schedule and reschedule).
   * Resolves the final prompt from the stored clean prompt + sentinel flags,
   * then enqueues it as a task notification.
   */
  private async fireWakeup(
    p: string | null,
    injectLoopMd: boolean,
    autonomous: boolean,
    feedbackText: string,
    reason?: string,
    customContext?: Readonly<Record<string, string>>,
  ): Promise<void> {
    let finalPrompt = p || '';

    if (injectLoopMd) {
      const loopMd = await readLoopMd();
      if (loopMd) {
        const content = loopMd.truncated
          ? `> WARNING: loop.md was truncated to ${MAX_LOOP_MD_BYTES} bytes.\n\n${loopMd.content}`
          : loopMd.content;
        finalPrompt = finalPrompt
          ? `## Loop tasks (from loop.md)\n\n${content}\n\n---\n\n${finalPrompt}`
          : `## Loop tasks (from loop.md)\n\n${content}`;
      }
    }

    // Pure-sentinel prompts strip to '' — fall back so the wakeup still fires
    // instead of being silently dropped (the loop must never die unannounced).
    if (!finalPrompt) {
      if (autonomous) {
        finalPrompt = AUTONOMOUS_TICK_PROMPT;
      } else if (injectLoopMd) {
        // loop.md mode but the file is gone — tell the model so it can stop cleanly.
        finalPrompt =
          `Loop tick: the ${CONFIG_DIR}/loop.md task file was scheduled for this loop but no longer exists. End the loop by calling ScheduleWakeup with stop: true, or ask the user how to proceed.`;
      } else {
        runLogger.debug(
          '[ScheduleWakeup] Wakeup skipped: empty prompt and no sentinel flags',
        );
        return;
      }
    }

    runLogger.debug(`[ScheduleWakeup] Firing wakeup: ${reason ?? 'no reason'}`);

    // Budget gate, before the wakeup is enqueued. Checked here rather than at
    // schedule time because credits only become known after a turn has run, and
    // this is the last point where the loop can be stopped without paying again.
    const spent = this.checkWakeupBudget();
    if (spent) {
      this.cancelWakeup();
      coreEvents.emitFeedback('info', spent);
      enqueuePendingNotification({
        prompt:
          `${spent} The dynamic loop has been cancelled and will not wake again. ` +
          `Do not reschedule it unless the user asks; report the stop instead, and ` +
          `mention that a new limit can be set with /loop --max-turns or ` +
          `--max-credits.`,
        commandMode: 'task-notification',
        priority: 'next',
        sessionId: this.host.getSessionId(),
        ...(customContext !== undefined ? { customContext } : {}),
      });
      return;
    }

    this.wakeupTurnsUsed += 1;
    this.parkWakeupFire();
    enqueuePendingNotification({
      prompt: withTimestamp(finalPrompt),
      commandMode: 'task-notification',
      priority: 'next',
      sessionId: this.host.getSessionId(),
      ...(customContext !== undefined ? { customContext } : {}),
    });
    coreEvents.emitFeedback('info', feedbackText);
  }

  /**
   * Parks one dynamic wakeup fire so the agent loop can claim and charge it.
   */
  private parkWakeupFire(): void {
    const loopId = this.wakeupLoopId;
    if (!loopId) return;
    this.fires.registerFire({ taskId: loopId, isWakeup: true });
  }

  // ---------------------------------------------------------------------------
  // Sentinel expansion (loop.md injection)
  // ---------------------------------------------------------------------------

  /**
   * Expand sentinel markers in a fired prompt.
   *
   * - `<<loop.md>>` / `<<loop.md-dynamic>>` → inject loop.md content (full on
   *   first fire or edit, reminder on subsequent unchanged fires).
   * - `<<autonomous-loop>>` / `<<autonomous-loop-dynamic>>` → strip sentinel
   *   (autonomous mode has no file injection).
   *
   * "First fire" is per session: the hash that decides between full content and
   * reminder belongs to whichever conversation is about to receive it, so a
   * second session in the same process must not inherit the first one's.
   */
  async expandSentinel(prompt: string): Promise<string> {
    // Quick check: does the prompt contain any sentinel?
    const hasLoopMdSentinel =
      prompt.includes(SENTINEL_LOOP_MD) ||
      prompt.includes(SENTINEL_LOOP_MD_DYNAMIC);
    const hasAutoSentinel =
      prompt.includes(SENTINEL_AUTO) ||
      prompt.includes(SENTINEL_AUTO_DYNAMIC);

    if (!hasLoopMdSentinel && !hasAutoSentinel) return prompt;

    let result = prompt;

    // Expand loop.md sentinels
    if (hasLoopMdSentinel) {
      const loopMd = await readLoopMd();
      if (loopMd) {
        const isFirstOrChanged = this.lastLoopMdHash !== loopMd.contentHash;
        this.lastLoopMdHash = loopMd.contentHash;

        let injection: string;
        if (isFirstOrChanged) {
          // Full content injection
          const truncWarning = loopMd.truncated
            ? `> WARNING: loop.md was truncated to ${MAX_LOOP_MD_BYTES} bytes. Keep the task list concise.\n\n`
            : '';
          injection =
            `## Loop tasks (from loop.md)\n\n` +
            truncWarning +
            `The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).\n\n---\n\n${loopMd.content}\n\n---`;
        } else {
          // Reminder on subsequent unchanged fires
          injection =
            'Reminder: continue working through the loop.md tasks from the first fire (the full content is in the cached message-prefix above). Refer back to those instructions.';
        }

        result = result
          .replace(SENTINEL_LOOP_MD, injection)
          .replace(SENTINEL_LOOP_MD_DYNAMIC, injection);
      } else {
        // No loop.md file found — strip sentinels silently
        result = result
          .replace(SENTINEL_LOOP_MD, '')
          .replace(SENTINEL_LOOP_MD_DYNAMIC, '');
      }
    }

    // Strip autonomous sentinels (they don't inject file content)
    if (hasAutoSentinel) {
      result = result
        .replace(SENTINEL_AUTO, '')
        .replace(SENTINEL_AUTO_DYNAMIC, '');
    }

    return result.trim();
  }
}

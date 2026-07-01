/**
 * The `/schedule` daemon engine. Loads tasks from the global store, and on a
 * 1s tick fires any that are due by invoking an injected `fire` callback (the
 * real one spawns a fresh `qwen -p` child; tests inject a fake). Recurring
 * schedules use the shared cron math; one-shots (`fireAt`) fire once and
 * auto-disable. There is deliberately NO 7-day expiry — routines run
 * indefinitely (that cap is a `/loop` session guardrail).
 *
 * `load()` and `tick()` are separated from `start()` so the scheduling logic
 * is unit-testable with an injected clock and no timers, lock, or filesystem
 * watcher.
 */

import * as fsSync from 'node:fs';

import { nextFireTime, parseCron } from '../../utils/cronParser.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { Storage } from '../../config/storage.js';
import {
  isTaskEnabled,
  listTasks,
  readState,
  updateState,
  type ScheduledTask,
  type TaskRuntimeState,
} from './task-store.js';
import {
  acquireDaemonLock,
  releaseDaemonLock,
  type DaemonLockHandle,
} from './daemon-lock.js';

const debugLogger = createDebugLogger('SCHEDULE_DAEMON');

const MINUTE_MS = 60_000;
const DEFAULT_TICK_MS = 1000;
const DEFAULT_RELOAD_MS = 5000;
const DEFAULT_MAX_CONCURRENT = 3;

export interface FireContext {
  task: ScheduledTask;
  firedAtMs: number;
  runId: string;
}

export type FireCallback = (ctx: FireContext) => void | Promise<void>;

export interface ScheduleDaemonOptions {
  /** The action run when a task is due (spawns a child in production). */
  fire: FireCallback;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  tickIntervalMs?: number;
  reloadIntervalMs?: number;
  /** Max tasks firing at once; excess wait for a later tick. */
  maxConcurrent?: number;
}

interface Job {
  task: ScheduledTask;
  state: TaskRuntimeState;
  /** Load-time minute floor; the anchor for a task that has never fired. */
  anchorMs: number;
}

function floorMinute(ms: number): number {
  return ms - (ms % MINUTE_MS);
}

function generateRunId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export class ScheduleDaemon {
  private readonly fire: FireCallback;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly reloadIntervalMs: number;
  private readonly maxConcurrent: number;

  private jobs = new Map<string, Job>();
  private inFlight = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private lock: DaemonLockHandle | null = null;
  // Chained fire-stamp writes, so stop()/flush() can await them landing.
  private pendingPersist: Promise<unknown> = Promise.resolve();

  constructor(options: ScheduleDaemonOptions) {
    this.fire = options.fire;
    this.now = options.now ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.reloadIntervalMs = options.reloadIntervalMs ?? DEFAULT_RELOAD_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /** Number of tasks currently loaded. */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * (Re)loads tasks from the store into memory, preserving in-memory
   * fire progress across reloads so a just-fired task (whose state write may
   * still be in flight) is not re-fired.
   */
  async load(): Promise<void> {
    let tasks: ScheduledTask[];
    try {
      tasks = await listTasks();
    } catch (err) {
      debugLogger.warn(`Task load failed — keeping current view: ${err}`);
      return;
    }
    const anchor = floorMinute(this.now());
    const next = new Map<string, Job>();
    for (const task of tasks) {
      const existing = this.jobs.get(task.id);
      let state = await readState(task.id);
      // Carry forward a newer in-memory lastFiredAt: a reload that reads disk
      // before a fire's state write lands must not resurrect the slot.
      if (
        existing &&
        existing.state.lastFiredAt != null &&
        (state.lastFiredAt == null ||
          existing.state.lastFiredAt > state.lastFiredAt)
      ) {
        state = { ...state, lastFiredAt: existing.state.lastFiredAt };
      }
      next.set(task.id, {
        task,
        state,
        anchorMs: existing?.anchorMs ?? anchor,
      });
    }
    this.jobs = next;
  }

  /**
   * Checks all loaded tasks against `nowMs` and fires those that are due.
   * Exposed (with an explicit clock) for tests.
   */
  tick(nowMs: number = this.now()): void {
    for (const job of this.jobs.values()) {
      if (this.inFlight.size >= this.maxConcurrent) break;
      if (this.inFlight.has(job.task.id)) continue;
      if (!isTaskEnabled(job.task, job.state)) continue;
      if (this.isDue(job, nowMs)) {
        this.fireJob(job, nowMs);
      }
    }
  }

  private isDue(job: Job, nowMs: number): boolean {
    const { schedule } = job.task;
    if (schedule.fireAt) {
      // One-shot: fire once when the timestamp passes and we've never fired.
      if (job.state.lastFiredAt != null) return false;
      const fireAtMs = Date.parse(schedule.fireAt);
      return Number.isFinite(fireAtMs) && nowMs >= fireAtMs;
    }
    if (!schedule.cron) return false;
    try {
      parseCron(schedule.cron);
    } catch {
      // A hand-edited/corrupt cron is skipped (left on disk for the user to fix).
      debugLogger.warn(`Task ${job.task.id}: unparseable cron, skipping`);
      return false;
    }
    const anchorMs = job.state.lastFiredAt ?? job.anchorMs;
    const nextMs = nextFireTime(schedule.cron, new Date(anchorMs)).getTime();
    return nextMs <= nowMs;
  }

  private fireJob(job: Job, nowMs: number): void {
    const runId = generateRunId();
    const { task } = job;
    // Recurring fires collapse any missed slots to the current minute so a
    // daemon that was down does not fire once per missed interval.
    job.state.lastFiredAt = task.schedule.cron ? floorMinute(nowMs) : nowMs;
    job.state.lastRunId = runId;
    job.state.nextRunAt = this.computeNextRunAt(task, nowMs);
    if (task.schedule.fireAt) {
      // One-shot auto-disables after firing (stays on disk to be re-armed).
      job.state.enabledOverride = false;
    }

    // Persist the stamp before/independently of the (possibly long) run so a
    // restart mid-run does not re-fire. Tracked (not awaited) so the tick stays
    // non-blocking, but stop()/flush() can wait for it to land.
    const stamp = { ...job.state };
    this.trackPersist(
      updateState(task.id, () => stamp).catch((err) =>
        debugLogger.warn(`Persisting fire stamp for ${task.id} failed: ${err}`),
      ),
    );

    debugLogger.debug(`Firing task ${task.id} (run ${runId})`);
    this.inFlight.add(task.id);
    Promise.resolve(this.fire({ task, firedAtMs: nowMs, runId }))
      .catch((err) => debugLogger.warn(`Fire failed for ${task.id}: ${err}`))
      .finally(() => this.inFlight.delete(task.id));
  }

  private trackPersist(write: Promise<unknown>): void {
    this.pendingPersist = this.pendingPersist.then(() => write);
  }

  /** Resolves once all in-flight fire-stamp persists have landed. */
  async flush(): Promise<void> {
    await this.pendingPersist;
  }

  private computeNextRunAt(task: ScheduledTask, nowMs: number): number | null {
    if (task.schedule.fireAt) return null;
    if (!task.schedule.cron) return null;
    try {
      return nextFireTime(task.schedule.cron, new Date(nowMs)).getTime();
    } catch {
      return null;
    }
  }

  /**
   * Acquires the single-owner lock, loads tasks, and starts the tick + reload
   * timers. Throws if another daemon already owns the lock.
   */
  async start(): Promise<void> {
    this.lock = await acquireDaemonLock();
    if (!this.lock) {
      throw new Error(
        'Another qwen schedule daemon is already running on this machine.',
      );
    }
    await this.load();
    this.startWatcher();
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.reloadTimer = setInterval(() => {
      void this.load();
    }, this.reloadIntervalMs);
    this.reloadTimer.unref();
    debugLogger.debug(`Schedule daemon started with ${this.jobs.size} task(s)`);
  }

  /** Stops timers and releases the lock. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Let in-flight fire-stamp writes land before we drop the lock, so a
    // successor daemon reading the store doesn't re-fire a just-fired task.
    await this.flush();
    if (this.lock) {
      await releaseDaemonLock(this.lock);
      this.lock = null;
    }
  }

  private watcher: fsSync.FSWatcher | null = null;

  /**
   * Best-effort directory watch to reload promptly on task add/remove. The
   * periodic reload timer is the cross-platform backstop (recursive watch is
   * not supported on Linux), so a missed event only delays a reload by
   * `reloadIntervalMs`.
   */
  private startWatcher(): void {
    const dir = Storage.getScheduledTasksDir();
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      this.watcher = fsSync.watch(dir, { persistent: false }, () => {
        void this.load();
      });
      this.watcher.on('error', (err) => {
        debugLogger.warn(`Schedule dir watcher error: ${err}`);
      });
    } catch (err) {
      debugLogger.warn(`Could not watch schedule dir: ${err}`);
    }
  }
}

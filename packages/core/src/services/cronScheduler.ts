/**
 * Cron scheduler with optional durable (file-backed) task support.
 * In-memory jobs live and die with the process. Durable jobs persist
 * under the user runtime dir (~/.qwen/tmp/<project-hash>/) and survive
 * restarts.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { matches, nextFireTime, parseCron } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { ToolNames } from '../tools/tool-names.js';
import type { DurableCronTask } from './cronTasksFile.js';
import {
  addCronTask,
  CRON_TASKS_DISPLAY_PATH,
  getCronFilePath,
  readCronTasks,
  removeCronTasks,
  updateCronTasks,
} from './cronTasksFile.js';
import { tryAcquireLock, releaseLock } from './cronTasksLock.js';

const debugLogger = createDebugLogger('CRON_SCHEDULER');

const MAX_JOBS = 50;
// Recurring jobs auto-expire this long after creation (claw-code parity:
// covers "check my PRs every hour this week" while bounding how long a
// forgotten schedule keeps firing). Age is evaluated at fire time — an
// aged job fires one final time, then is deleted.
const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Recurring: up to 10% of period, capped at 15 minutes.
const MAX_RECURRING_JITTER_MS = 15 * 60 * 1000;
// One-shot: up to 90s early for jobs landing on :00 or :30.
const MAX_ONESHOT_JITTER_MS = 90 * 1000;
const LOCK_PROBE_INTERVAL_MS = 5000;
const FILE_DEBOUNCE_MS = 300;
// Loop wakeups (self-paced /loop) align with Claude Code's ScheduleWakeup:
// the requested delay is clamped to [60, 3600] seconds, with a 1200s default
// heartbeat for non-finite input. Unlike cron jobs the fire time is exact
// (second resolution, not minute-rounded) and lives in a separate map — not
// subject to MAX_JOBS, never durable.
const WAKEUP_MIN_SECONDS = 60;
const WAKEUP_MAX_SECONDS = 3600;
const WAKEUP_DEFAULT_SECONDS = 1200;
const WAKEUP_CHAIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CronJob {
  id: string;
  cronExpr: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  expiresAt: number;
  lastFiredAt?: number;
  jitterMs: number;
  /** Persisted under ~/.qwen (per-project) — survives restarts. */
  durable?: boolean;
  /** One-shot that was due while no owning session ran — fired late. */
  missed?: boolean;
}

/**
 * A second-resolution, session-only one-shot wakeup used by self-paced
 * `/loop` (loop_wakeup). Kept separate from cron jobs: never persisted,
 * never counted against MAX_JOBS, fired at an exact ms (not minute-rounded).
 */
export interface SessionWakeup {
  id: string;
  fireAtMs: number;
  prompt: string;
  createdAt: number;
}

interface WakeupChain {
  startedAt: number;
}

/**
 * Catch-up work detected at owner load/takeover, queued until an onFire
 * channel exists. The kind decides what delivery does afterwards:
 * 'missed' (one-shots, batched into a single confirm-first notification)
 * and 'final' (aged-out recurring, fired raw one last time) remove their
 * tasks from disk; 'catch-up' (overdue recurring, fired raw) persists the
 * lastFiredAt stamp instead — the task stays scheduled.
 */
type PendingFire =
  | { kind: 'missed'; tasks: DurableCronTask[] }
  | { kind: 'catch-up'; ids: string[] }
  | { kind: 'final'; jobs: CronJob[] };

/**
 * Deterministic hash from a string ID, returned as a positive integer.
 */
function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Derives a deterministic jitter offset from a job ID and its cron period.
 * Recurring jobs: up to 10% of period, capped at 15 minutes (added after fire time).
 * One-shot jobs landing on :00 or :30: up to 90s early (subtracted before fire time).
 * Other one-shot jobs: 0 jitter.
 */
function computeJitter(
  id: string,
  cronExpr: string,
  recurring: boolean,
): number {
  const hash = hashId(id);

  if (recurring) {
    // Estimate period by computing two consecutive fire times
    const now = new Date();
    try {
      const first = nextFireTime(cronExpr, now);
      const second = nextFireTime(cronExpr, first);
      const periodMs = second.getTime() - first.getTime();
      const tenPercent = periodMs * 0.1;
      const maxJitter = Math.min(tenPercent, MAX_RECURRING_JITTER_MS);
      return hash % Math.max(1, Math.floor(maxJitter));
    } catch {
      return 0;
    }
  }

  // One-shot: apply up to 90s early jitter only when the fire time lands
  // on :00 or :30 — the wall-clock marks humans round to. Checked on the
  // computed fire time rather than the raw minute field, so lists, steps,
  // and ranges that land on those marks are covered too (claw-code parity).
  try {
    const next = nextFireTime(cronExpr, new Date());
    if (next.getMinutes() % 30 === 0) {
      // Negative jitter = fire early
      return -(hash % MAX_ONESHOT_JITTER_MS);
    }
  } catch {
    // fall through
  }

  return 0;
}

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function clampWakeupSeconds(delaySeconds: number): number {
  if (!Number.isFinite(delaySeconds)) return WAKEUP_DEFAULT_SECONDS;
  return Math.min(
    WAKEUP_MAX_SECONDS,
    Math.max(WAKEUP_MIN_SECONDS, Math.round(delaySeconds)),
  );
}

/**
 * Maps a wakeup onto the minimal CronJob shape onFire consumers read (they
 * only use `prompt`). cronExpr `@wakeup` marks its origin.
 */
function wakeupToJob(wakeup: SessionWakeup): CronJob {
  return {
    id: wakeup.id,
    cronExpr: '@wakeup',
    prompt: wakeup.prompt,
    recurring: false,
    createdAt: wakeup.createdAt,
    expiresAt: Infinity,
    jitterMs: 0,
  };
}

function truncatePrompt(prompt: string): string {
  return prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
}

export class CronScheduler {
  // All jobs — session-only and durable — live in this one map.
  private jobs = new Map<string, CronJob>();
  // Loop wakeups live separately: second-resolution, never durable, never
  // counted against MAX_JOBS. Delivered through the same onFire as cron.
  private wakeups = new Map<string, SessionWakeup>();
  private wakeupChains = new Map<string, WakeupChain>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onFire: ((job: CronJob) => void) | null = null;

  // --- Durable (file-backed) support ---
  private durableEnabled = false;
  // Bumped by stop(). Async durable work captures the value before each
  // await and bails if it changed — a continuation that resumes after
  // stop() must not install state (or keep a lock) that stop() already
  // cleaned up or can no longer see.
  private durableGeneration = 0;
  private sessionId: string | null = null;
  // Distinguishes this scheduler's lock from one written by another
  // scheduler instance with the same pid+sessionId (session reload) —
  // adopting such a lock means owning a file whose unlink is in flight.
  private readonly lockId = generateId();
  // Release from a previous stop() that may not have landed yet. A new
  // acquire must wait it out so it can't grab the doomed lock file.
  private pendingRelease: Promise<void> | null = null;
  private isOwner = false;
  // Durable ids whose on-disk removal hasn't landed yet — a reload that
  // reads the file before the write completes must not resurrect them.
  private pendingRemoval = new Set<string>();
  // Durable ids whose initial on-disk write hasn't landed yet — a reload
  // that reads the file before the write completes must not reconcile
  // the live job away (or clear its pendingRemoval guard) as if it had
  // been deleted on disk.
  private pendingAdd = new Set<string>();
  private fileWatcher: fsSync.FSWatcher | null = null;
  private lockProbeTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Catch-up work detected before start() installed onFire — flushed
  // through onFire as soon as it exists.
  private pendingFires: PendingFire[] = [];
  // Fire-and-forget writes (tick persists, delivered missed-fire
  // removals), chained so stop() can hold the lock until they land — a
  // successor reading the file pre-write would re-run the same work.
  private pendingPersist: Promise<void> = Promise.resolve();

  /** `projectRoot` anchors durable storage; without it only session-only
   * jobs work. Production constructs via `Config.getCronScheduler()`,
   * which always supplies it. */
  constructor(private readonly projectRoot: string | null = null) {}

  /**
   * Creates a new session-only cron job. Returns the created job.
   * Throws if the max job limit is reached.
   */
  create(cronExpr: string, prompt: string, recurring: boolean): CronJob {
    if (this.jobs.size >= MAX_JOBS) {
      throw new Error(
        `Maximum number of cron jobs (${MAX_JOBS}) reached. Delete some jobs first.`,
      );
    }

    const id = generateId();
    const now = Date.now();
    const jitterMs = computeJitter(id, cronExpr, recurring);

    const job: CronJob = {
      id,
      cronExpr,
      prompt,
      recurring,
      createdAt: now,
      expiresAt: recurring ? now + RECURRING_MAX_AGE_MS : Infinity,
      // Prevent the scheduler from firing during the creation minute
      lastFiredAt: now - (now % 60_000),
      jitterMs,
    };

    this.jobs.set(id, job);
    return job;
  }

  /**
   * Schedules a second-resolution, session-only one-shot wakeup for
   * self-paced `/loop`. Clamps `delaySeconds` to [60, 3600]; non-finite
   * input falls back to the default heartbeat. The fire time is exact (not
   * minute-rounded) and is not subject to MAX_JOBS. Returns the scheduling
   * outcome for the model (mirrors ScheduleWakeup's output).
   */
  scheduleWakeup(
    delaySeconds: number,
    prompt: string,
  ): {
    id: string;
    scheduledFor: string;
    clampedDelaySeconds: number;
    wasClamped: boolean;
    replacedId: string | null;
  } {
    const clampedDelaySeconds = clampWakeupSeconds(delaySeconds);
    const roundedDelaySeconds = Number.isFinite(delaySeconds)
      ? Math.round(delaySeconds)
      : delaySeconds;
    const wasClamped =
      !Number.isFinite(delaySeconds) ||
      roundedDelaySeconds < WAKEUP_MIN_SECONDS ||
      roundedDelaySeconds > WAKEUP_MAX_SECONDS;
    const id = generateId();
    const now = Date.now();
    const fireAtMs = now + clampedDelaySeconds * 1000;
    const replacedWakeup = this.wakeups.values().next().value ?? null;
    const replacedId = replacedWakeup?.id ?? null;
    if (replacedWakeup && replacedWakeup.prompt !== prompt) {
      this.wakeupChains.delete(replacedWakeup.prompt);
    }
    const chain = this.wakeupChains.get(prompt) ?? {
      startedAt: now,
    };
    if (fireAtMs > chain.startedAt + WAKEUP_CHAIN_MAX_AGE_MS) {
      throw new Error(
        'Loop wakeup chain exceeded the 24h session limit. ' +
          'Omit LoopWakeup to end this loop, or start a new loop prompt.',
      );
    }
    if (replacedId) {
      debugLogger.debug(`Replacing pending wakeup ${replacedId}`);
    }
    this.wakeups.clear();
    this.wakeupChains.set(prompt, chain);
    this.wakeups.set(id, { id, fireAtMs, prompt, createdAt: now });
    debugLogger.debug(
      `Wakeup ${id} scheduled for ${new Date(fireAtMs).toISOString()} ` +
        `(delay=${clampedDelaySeconds}s)`,
    );
    return {
      id,
      scheduledFor: new Date(fireAtMs).toISOString(),
      clampedDelaySeconds,
      wasClamped,
      replacedId,
    };
  }

  /** Cancels a single pending wakeup. Returns true if it existed. */
  cancelWakeup(id: string): boolean {
    const wakeup = this.wakeups.get(id);
    const deleted = this.wakeups.delete(id);
    if (deleted) {
      if (wakeup) this.wakeupChains.delete(wakeup.prompt);
      debugLogger.debug(`Cancelled wakeup ${id}`);
    }
    return deleted;
  }

  /**
   * Cancels every pending wakeup; returns how many were cancelled. The
   * primitive behind a future loop-scoped "cancel all wakeups on abort".
   */
  cancelAllWakeups(): number {
    for (const wakeup of this.wakeups.values()) {
      this.wakeupChains.delete(wakeup.prompt);
    }
    const count = this.wakeups.size;
    this.wakeups.clear();
    if (count > 0) debugLogger.debug(`Cancelled ${count} wakeup(s)`);
    return count;
  }

  /**
   * Creates a durable cron job: registered like any other job, and
   * persisted under ~/.qwen (per-project) so it survives restarts.
   * Throws if the job can't be persisted.
   */
  async createDurable(
    cronExpr: string,
    prompt: string,
    recurring: boolean,
  ): Promise<CronJob> {
    if (!this.projectRoot) {
      throw new Error('Durable cron jobs require a project root.');
    }
    const job = this.create(cronExpr, prompt, recurring);
    job.durable = true;
    this.pendingAdd.add(job.id);
    try {
      await addCronTask(this.projectRoot, jobToDurableTask(job));
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    } finally {
      this.pendingAdd.delete(job.id);
    }
    return job;
  }

  /**
   * Deletes a job by ID. Durable jobs are also removed from disk, and the
   * removal is awaited — reporting success while the on-disk entry could
   * survive would let the task resurface in another session or after a
   * restart. On write failure the job is restored and the error rethrown.
   * Returns true if the job existed.
   */
  async delete(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return this.cancelWakeup(id);

    this.jobs.delete(id);
    if (job.durable && this.projectRoot) {
      this.pendingRemoval.add(id);
      try {
        await removeCronTasks(this.projectRoot, [id]);
      } catch (error) {
        this.pendingRemoval.delete(id);
        this.jobs.set(id, job);
        throw error;
      }
    }
    return true;
  }

  /**
   * Returns all active jobs.
   */
  list(): CronJob[] {
    return [
      ...this.jobs.values(),
      ...[...this.wakeups.values()].map(wakeupToJob),
    ];
  }

  /**
   * Returns the number of active jobs.
   */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Returns the number of session-only (non-durable) jobs. Headless mode
   * keys its hold-open loop on this: durable jobs outlive the process by
   * design and never fire without lock ownership, so they must not pin it.
   */
  get sessionSize(): number {
    // Pending wakeups count: a self-paced loop must hold the headless
    // process open until its wakeup fires (and re-arms), mirroring CC's
    // "call to keep alive / omit to end".
    let count = this.wakeups.size;
    for (const job of this.jobs.values()) {
      if (!job.durable) count++;
    }
    return count;
  }

  /**
   * Enables durable cron support. Loads tasks from disk and watches the
   * tasks file in every session — durable tasks are project-level, so
   * cron_list/cron_delete must see them regardless of which session owns
   * the lock. The lock only gates firing.
   */
  async enableDurable(sessionId: string): Promise<void> {
    if (this.durableEnabled) return;
    const projectRoot = this.projectRoot;
    if (!projectRoot) return;
    this.durableEnabled = true;

    this.sessionId = sessionId;
    const generation = this.durableGeneration;

    try {
      if (this.pendingRelease) {
        await this.pendingRelease;
        this.pendingRelease = null;
        if (generation !== this.durableGeneration) return;
      }

      const acquired = await tryAcquireLock(
        projectRoot,
        sessionId,
        this.lockId,
      );
      if (generation !== this.durableGeneration) {
        // stop() ran during the acquire — it saw isOwner=false and couldn't
        // release this lock, so hand it back here.
        this.releaseLateAcquisition(acquired, projectRoot, sessionId);
        return;
      }
      this.isOwner = acquired;

      // Watch before the initial load: a task another session persists
      // between the load's file read and watcher registration would emit no
      // event we'd see, leaving it dormant on disk until the next change or
      // restart. Registering first means any such write triggers a reload,
      // and the watcher's 300ms debounce serializes that reload after this
      // initial load rather than racing it. stop() closes the watcher, so a
      // generation change during the load below is still cleaned up.
      this.startFileWatcher(projectRoot);

      // Missed one-shots and overdue-recurring catch-ups are handled by
      // the owner alone — a non-owner load must not fire (or delete)
      // tasks the live owner is managing.
      await this.loadFileTasks(this.isOwner);
      if (generation !== this.durableGeneration) {
        // stop() ran during the load (releasing the lock and closing the
        // watcher) — bail before installing the takeover probe.
        return;
      }

      if (!this.isOwner) {
        // Probe periodically to take over if the owner dies.
        // unref() so this timer doesn't prevent process exit in headless mode.
        this.lockProbeTimer = setInterval(() => {
          void tryAcquireLock(projectRoot, sessionId, this.lockId)
            .then((acquired) => {
              if (generation !== this.durableGeneration) {
                // stop() ran while this probe was in flight.
                this.releaseLateAcquisition(acquired, projectRoot, sessionId);
                return;
              }
              if (acquired && !this.isOwner) {
                this.isOwner = true;
                if (this.lockProbeTimer) {
                  clearInterval(this.lockProbeTimer);
                  this.lockProbeTimer = null;
                }
                // Already loaded and watching — reload once with missed-task
                // handling for one-shots that went stale while no owner ran.
                // Separate promise from the outer .catch chain, so guard its
                // own rejection — an unhandled one crashes Node >=22.
                void this.loadFileTasks(true).catch((err) => {
                  debugLogger.warn(`Cron takeover reload failed: ${err}`);
                });
              }
            })
            .catch((err) => {
              // tryAcquireLock rethrows non-EEXIST errors (EACCES/EIO on
              // the lock path); without this handler a transient blip
              // becomes an unhandled rejection and crashes the process.
              // The next probe interval retries.
              debugLogger.warn(`Cron lock probe failed: ${err}`);
            });
        }, LOCK_PROBE_INTERVAL_MS);
        this.lockProbeTimer.unref();
      }
    } catch (error) {
      // Failed setup must not leave durable mode half-on: the guard at
      // the top would turn every later enableDurable() into a no-op for
      // the session's lifetime. Skip if stop() already reset the state
      // (a newer enable may own it by now).
      if (generation === this.durableGeneration) {
        if (this.isOwner) {
          this.pendingRelease = releaseLock(
            projectRoot,
            sessionId,
            this.lockId,
          );
          this.isOwner = false;
        }
        this.durableEnabled = false;
        this.sessionId = null;
      }
      throw error;
    }
  }

  /**
   * Hands back a lock acquired by an await that resumed after stop() —
   * unless a newer enableDurable() for the same session is already active
   * on this scheduler, in which case the lock is exactly the one it owns
   * (acquisition is idempotent per pid+sessionId+lockId) and releasing
   * would pull it out from under it.
   */
  private releaseLateAcquisition(
    acquired: boolean,
    projectRoot: string,
    sessionId: string,
  ): void {
    if (!acquired) return;
    if (this.durableEnabled && this.sessionId === sessionId) return;
    this.pendingRelease = releaseLock(projectRoot, sessionId, this.lockId);
  }

  private async loadFileTasks(handleMissed: boolean): Promise<void> {
    const projectRoot = this.projectRoot;
    if (!projectRoot) return;
    const generation = this.durableGeneration;
    let read: DurableCronTask[];
    try {
      read = await readCronTasks(projectRoot);
    } catch {
      // readCronTasks maps only a missing file to []; anything thrown
      // here is a real read failure (EACCES/EIO/...) or a corrupted file
      // (malformed JSON throws rather than reading as empty). Treating
      // either as an empty schedule would wipe every loaded durable job
      // and clear pendingRemoval guards whose removals are still in
      // flight; keep the current view and let a later reload retry.
      return;
    }
    if (generation !== this.durableGeneration) {
      // stop() ran during the read. Bail before any side effects:
      // buffering a missed fire now would plant a ghost that a later
      // start() flushes — delivering (and deleting) work this session
      // already disowned.
      return;
    }
    // Entries whose cron no longer parses (hand-edited or corrupted
    // file) are skipped but left on disk: installing one would make the
    // tick's matches() throw from the interval, while dropping it from
    // the file would discard what the user wrote over a typo.
    const tasks = read.filter(hasParseableCron);

    const now = Date.now();
    const missedOneShots: DurableCronTask[] = [];
    const catchUpIds: string[] = [];
    const finalTasks: DurableCronTask[] = [];
    if (handleMissed) {
      for (const t of tasks) {
        // A task whose on-disk removal is already in flight (deleted via
        // cron_delete, or a just-delivered fire) is gone, not missed.
        if (this.pendingRemoval.has(t.id)) continue;
        const jitter = computeJitter(t.id, t.cron, t.recurring);
        const anchor = t.recurring
          ? (t.lastFiredAt ?? t.createdAt)
          : t.createdAt;
        const nextFire = computeNextFireMs(t.cron, anchor, jitter);
        if (nextFire === null || nextFire >= now) continue;
        if (!t.recurring) {
          // Missed one-shots are delivered as one batched confirm-first
          // notification: the task file is project-controlled, and
          // executing a prompt read from it would bypass the approval
          // gate cron_create runs at scheduling time. Wrapping at
          // delivery covers every consumer — interactive, headless, and
          // ACP enqueue whatever `prompt` holds.
          missedOneShots.push(t);
        } else if (now - t.createdAt >= RECURRING_MAX_AGE_MS) {
          // Aged out while overdue — fires raw one final time, then is
          // deleted (same contract as an aged fire from the tick loop).
          finalTasks.push(t);
        } else {
          // Overdue recurring — fire raw once now and resume the normal
          // schedule (claw-code parity: "check my PRs every 30m"
          // restarted after lunch checks promptly instead of waiting
          // for the next aligned window).
          catchUpIds.push(t.id);
        }
      }
      // The install loop below skips these via pendingRemoval. The
      // on-disk removal is deferred to delivery (fireOrBuffer / the
      // start() flush): removing at detection would lose the task
      // outright if stop() dropped the buffered fire before any onFire
      // existed.
      for (const t of [...missedOneShots, ...finalTasks]) {
        this.pendingRemoval.add(t.id);
        // A prior non-owner load may have installed this task as a
        // live job — drop it, or the now-owning tick could fire it a
        // second time before the on-disk removal propagates back
        // through the watcher reload.
        this.jobs.delete(t.id);
      }
    }

    // Reconcile disk state into the job map. lastFiredAt is carried
    // forward from the in-memory entry — an in-flight persist may not
    // have landed yet, and regressing it would double-fire.
    const diskIds = new Set(tasks.map((t) => t.id));
    // Jobs mid-createDurable are on their way to disk — treat them as
    // present so this reload doesn't delete the live job it can't see yet.
    for (const id of this.pendingAdd) diskIds.add(id);
    for (const job of this.jobs.values()) {
      if (job.durable && !diskIds.has(job.id)) {
        this.jobs.delete(job.id);
      }
    }
    for (const id of this.pendingRemoval) {
      if (!diskIds.has(id)) this.pendingRemoval.delete(id);
    }
    for (const task of tasks) {
      if (this.pendingRemoval.has(task.id)) continue;
      const existing = this.jobs.get(task.id);
      // Bound what a project-controlled file can install, mirroring the
      // create()-time MAX_JOBS limit. Updating an already-loaded job is
      // always allowed (it doesn't grow the map); only brand-new ids are
      // capped, so a hand-edited or force-committed file with hundreds of
      // entries can't balloon the map and the 1s tick loop.
      if (!existing && this.jobs.size >= MAX_JOBS) {
        debugLogger.warn(
          `Durable task ${task.id} skipped — MAX_JOBS (${MAX_JOBS}) reached.`,
        );
        continue;
      }
      const job = durableTaskToJob(task, existing);
      if (existing?.lastFiredAt !== undefined) {
        job.lastFiredAt = Math.max(existing.lastFiredAt, job.lastFiredAt ?? 0);
      }
      this.jobs.set(task.id, job);
    }

    // Stamp catch-up jobs with the current minute before delivery so the
    // tick loop can't fire a matched minute at or before the catch-up
    // (processJob skips slots <= lastFiredAt). The stamp is persisted at
    // delivery; until then it's memory-only, so a dropped buffer just
    // means a later enable re-detects the catch-up from disk.
    if (catchUpIds.length > 0) {
      const nowMinuteMs = now - (now % 60_000);
      for (const id of catchUpIds) {
        const job = this.jobs.get(id);
        if (job) job.lastFiredAt = nowMinuteMs;
      }
    }

    if (missedOneShots.length > 0) {
      this.fireOrBuffer({ kind: 'missed', tasks: missedOneShots });
    }
    if (catchUpIds.length > 0) {
      this.fireOrBuffer({ kind: 'catch-up', ids: catchUpIds });
    }
    if (finalTasks.length > 0) {
      this.fireOrBuffer({
        kind: 'final',
        jobs: finalTasks.map((t) => durableTaskToJob(t)),
      });
    }
  }

  /**
   * Delivers catch-up work through the normal onFire channel, or holds
   * it until start() installs one. Delivery is what removes a missed or
   * final task from disk (and what persists a catch-up stamp) — a
   * buffered fire leaves disk state untouched, so a stop() that drops
   * the buffer loses nothing.
   */
  private fireOrBuffer(pending: PendingFire): void {
    if (this.onFire) {
      this.deliverPending(pending, this.onFire);
    } else {
      this.pendingFires.push(pending);
    }
  }

  private deliverPending(
    pending: PendingFire,
    onFire: (job: CronJob) => void,
  ): void {
    switch (pending.kind) {
      case 'missed': {
        // One batched notification for every one-shot missed in this
        // load (claw-code parity) — one model turn and one confirmation
        // flow instead of N separate prompts. The carrier job exists to
        // satisfy the onFire shape; consumers only read prompt/missed.
        onFire({
          ...durableTaskToJob(pending.tasks[0]!),
          prompt: buildMissedCronNotification(pending.tasks),
          missed: true,
        });
        this.removeMissedFromDisk(pending.tasks.map((t) => t.id));
        break;
      }
      case 'catch-up': {
        const fired: string[] = [];
        for (const id of pending.ids) {
          const job = this.jobs.get(id);
          if (!job) continue; // deleted while buffered
          onFire(job);
          fired.push(id);
        }
        this.persistCatchUpStamps(fired);
        break;
      }
      case 'final': {
        for (const job of pending.jobs) {
          onFire(job);
        }
        this.removeMissedFromDisk(pending.jobs.map((j) => j.id));
        break;
      }
      default: {
        // Forces a TS error if PendingFire gains a variant this switch
        // doesn't handle.
        const _exhaustive: never = pending;
        return _exhaustive;
      }
    }
  }

  /**
   * Persists the in-memory lastFiredAt stamps of just-delivered catch-up
   * fires so a restart doesn't replay them.
   */
  private persistCatchUpStamps(ids: string[]): void {
    if (!this.projectRoot || ids.length === 0) return;
    const stamps = new Map<string, number>();
    for (const id of ids) {
      const fired = this.jobs.get(id)?.lastFiredAt;
      if (fired !== undefined) stamps.set(id, fired);
    }
    if (stamps.size === 0) return;
    this.trackPersist(
      updateCronTasks(this.projectRoot, (tasks) => {
        let changed = false;
        const next = tasks.map((t) => {
          const stamp = stamps.get(t.id);
          if (stamp === undefined || t.lastFiredAt === stamp) return t;
          changed = true;
          return { ...t, lastFiredAt: stamp };
        });
        return changed ? next : tasks;
      }),
    );
  }

  /** Launches the on-disk removal of missed/final tasks just delivered. */
  private removeMissedFromDisk(ids: string[]): void {
    if (!this.projectRoot || ids.length === 0) return;
    this.trackPersist(removeCronTasks(this.projectRoot, ids));
  }

  /**
   * Chains a background write into pendingPersist so stop() releases the
   * lock only after it lands. Failures are logged but not retried — same
   * best-effort contract as a fire-and-forget persist; the fire was
   * already delivered, so a failed stamp degrades to at-least-once.
   */
  private trackPersist(write: Promise<unknown>): void {
    const settled = write.then(
      () => {},
      (err) => {
        debugLogger.warn(
          `Durable cron persist failed — disk state is stale and the task may fire again in a later session: ${err}`,
        );
      },
    );
    this.pendingPersist = this.pendingPersist.then(() => settled);
  }

  private startFileWatcher(projectRoot: string): void {
    if (this.fileWatcher) return;
    const filePath = getCronFilePath(projectRoot);
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    // Watch the directory instead of the file — the file may not exist yet.
    // When it's created or modified, we reload. Non-owners reload too, so
    // their view tracks tasks the owner fires/removes.
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      this.fileWatcher = fsSync.watch(
        dir,
        { persistent: false },
        (_event, filename) => {
          if (filename && filename !== fileName) return;
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            void this.loadFileTasks(false);
          }, FILE_DEBOUNCE_MS);
          this.debounceTimer.unref();
        },
      );
      this.fileWatcher.on('error', (err) => {
        debugLogger.warn(
          `Tasks-file watcher error — durable task changes from other sessions may not be picked up until restart: ${err}`,
        );
      });
    } catch {
      // Directory doesn't exist or can't be watched — fine
    }
  }

  /**
   * Starts the scheduler tick. Calls `onFire` when a job is due.
   * Only fires when called — does not auto-fire missed intervals.
   */
  start(onFire: (job: CronJob) => void): void {
    this.onFire = onFire;
    for (const pending of this.pendingFires.splice(0)) {
      this.deliverPending(pending, onFire);
    }
    if (this.timer) return; // already running

    // Deliberately not unref()'d, unlike lockProbeTimer/debounceTimer: in
    // headless mode this interval is the only live handle holding the
    // process open between fires (the cron hold-open in nonInteractiveCli
    // awaits a promise, which pins nothing by itself). Every exit path
    // goes through stop(), which clears it.
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  }

  /**
   * Stops the scheduler and relinquishes durable participation: the lock
   * is released so another session can take over, and a later
   * `enableDurable()` re-acquires from scratch (a re-enable under a new
   * sessionId must not be blocked by this session's own old lock).
   * Does not clear jobs — they remain queryable.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lockProbeTimer) {
      clearInterval(this.lockProbeTimer);
      this.lockProbeTimer = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.wakeups.size > 0) {
      debugLogger.debug(`stop() discarding ${this.wakeups.size} wakeup(s)`);
      this.wakeups.clear();
    }
    this.wakeupChains.clear();
    this.onFire = null;

    if (this.durableEnabled) {
      // Invalidate in-flight durable continuations (see durableGeneration).
      this.durableGeneration++;
      if (this.isOwner && this.projectRoot && this.sessionId) {
        // Release only after in-flight fire persists land (see
        // pendingPersist); sessionId may be reassigned by a re-enable
        // before the chain runs, so capture it now.
        const projectRoot = this.projectRoot;
        const sessionId = this.sessionId;
        this.pendingRelease = this.pendingPersist.then(() =>
          releaseLock(projectRoot, sessionId, this.lockId),
        );
      }
      this.isOwner = false;
      this.durableEnabled = false;
      // Dropped buffered fires were never delivered: missed and final
      // tasks are still on disk — un-guard their ids so a later load
      // sees them again. Dropped catch-up stamps are memory-only; a
      // later enable re-detects the catch-up from disk.
      for (const pending of this.pendingFires) {
        if (pending.kind === 'missed') {
          for (const t of pending.tasks) this.pendingRemoval.delete(t.id);
        } else if (pending.kind === 'final') {
          for (const j of pending.jobs) this.pendingRemoval.delete(j.id);
        }
      }
      this.pendingFires.length = 0;
    }
  }

  /**
   * True while durable (file-backed) support is active — this session is
   * either firing durable tasks (owner) or probing to take over.
   */
  get durableActive(): boolean {
    return this.durableEnabled;
  }

  /**
   * True when the tick loop has — or may acquire — work: any in-memory
   * job, or durable mode active (the file watcher and lock takeover can
   * install fireable tasks at any time, even while the map is empty).
   */
  get hasPendingWork(): boolean {
    return this.jobs.size > 0 || this.wakeups.size > 0 || this.durableEnabled;
  }

  /**
   * Returns true if the scheduler is running.
   */
  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * Manual tick — checks all jobs against the current time and fires those
   * that are due. Exported for testing.
   */
  tick(now?: Date): void {
    // Wakeups live in a separate map; check both or self-paced loops stop firing.
    if (this.jobs.size === 0 && this.wakeups.size === 0) return;
    const currentDate = now ?? new Date();
    const currentMs = currentDate.getTime();

    const firedAt = new Map<string, number>(); // durable recurring fires
    const removedIds: string[] = []; // durable one-shot fires / expiries

    for (const job of this.jobs.values()) {
      // Durable jobs fire only while this session holds the lock — never
      // in non-owner sessions, where a persisted job would otherwise fire
      // uncoordinated alongside the real owner's copy.
      if (job.durable && !this.isOwner) continue;

      const result = this.processJob(job, currentDate, currentMs);
      if (!job.durable || result === 'none') continue;

      if (result === 'fired-final' || !job.recurring) {
        removedIds.push(job.id);
      } else {
        firedAt.set(job.id, job.lastFiredAt!);
      }
    }

    // Persist durable changes in one write so the lastFiredAt update and
    // the removals can't clobber each other's read-modify-write cycle.
    if (this.projectRoot && (firedAt.size > 0 || removedIds.length > 0)) {
      for (const id of removedIds) this.pendingRemoval.add(id);
      const removed = new Set(removedIds);
      this.trackPersist(
        updateCronTasks(this.projectRoot, (tasks) =>
          tasks
            .filter((t) => !removed.has(t.id))
            .map((t) =>
              firedAt.has(t.id) ? { ...t, lastFiredAt: firedAt.get(t.id)! } : t,
            ),
        ),
      );
    }

    // Fire due wakeups (second-resolution, one-shot). Delivered through the
    // same onFire channel as cron jobs so interactive, headless, and ACP
    // consumers handle them identically, then removed immediately.
    for (const wakeup of this.wakeups.values()) {
      if (wakeup.fireAtMs > currentMs) continue;
      this.wakeups.delete(wakeup.id);
      debugLogger.debug(`Firing wakeup ${wakeup.id}`);
      if (this.onFire) this.onFire(wakeupToJob(wakeup));
    }
  }

  /**
   * Processes a single job. Returns 'fired' if the job fired,
   * 'fired-final' if it fired one last time and was removed (aged out),
   * and 'none' otherwise.
   */
  private processJob(
    job: CronJob,
    currentDate: Date,
    currentMs: number,
  ): 'fired' | 'fired-final' | 'none' {
    const absJitter = Math.abs(job.jitterMs);
    const windowMinutes = Math.ceil(absJitter / 60_000);

    const nowMinuteStart = new Date(currentDate);
    nowMinuteStart.setSeconds(0, 0);
    const nowMinuteMs = nowMinuteStart.getTime();

    let matchedMinuteMs: number | null = null;

    for (let offset = -windowMinutes; offset <= windowMinutes; offset++) {
      const candidateMs = nowMinuteMs + offset * 60_000;
      const candidateDate = new Date(candidateMs);
      if (!matches(job.cronExpr, candidateDate)) continue;

      const fireTimeMs = candidateMs + job.jitterMs;
      if (currentMs >= fireTimeMs) {
        if (matchedMinuteMs === null || candidateMs > matchedMinuteMs) {
          matchedMinuteMs = candidateMs;
        }
      }
    }

    if (matchedMinuteMs === null) return 'none';

    // >= rather than ===: a catch-up fire stamps the current minute,
    // which can sit after an already-matched older slot — slots at or
    // before the stamp must never (re-)fire.
    if (job.lastFiredAt !== undefined && job.lastFiredAt >= matchedMinuteMs) {
      return 'none';
    }

    job.lastFiredAt = matchedMinuteMs;

    // Expiry is evaluated at fire time (claw-code parity): an aged
    // recurring job fires one final time, then is deleted. A hard cliff
    // at expiresAt would silently swallow the job's pending window —
    // and contradict the cron_create description, which promises the
    // final fire.
    const expired = job.recurring && currentMs >= job.expiresAt;

    if (!job.recurring || expired) {
      this.jobs.delete(job.id);
    }

    if (this.onFire) {
      this.onFire(job);
    }

    return expired ? 'fired-final' : 'fired';
  }

  /**
   * Returns a human-readable summary of active session-only jobs for
   * display on session exit. Durable jobs are not included since they
   * persist. Returns null if there are no session-only jobs.
   */
  getExitSummary(): string | null {
    const sessionJobs = [...this.jobs.values()].filter((job) => !job.durable);
    const wakeups = [...this.wakeups.values()];
    if (sessionJobs.length === 0 && wakeups.length === 0) return null;

    const count = sessionJobs.length + wakeups.length;
    const lines = [
      `Session ending. ${count} active loop${count === 1 ? '' : 's'} cancelled:`,
    ];
    for (const job of sessionJobs) {
      const schedule = humanReadableCron(job.cronExpr);
      lines.push(`  - [${job.id}] ${schedule}: ${truncatePrompt(job.prompt)}`);
    }
    for (const wakeup of wakeups) {
      lines.push(
        `  - [${wakeup.id}] wakeup at ${new Date(
          wakeup.fireAtMs,
        ).toISOString()}: ${truncatePrompt(wakeup.prompt)}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Clears all jobs and stops the scheduler.
   */
  destroy(): void {
    this.stop();
    this.jobs.clear();
    this.wakeups.clear();
    this.pendingRemoval.clear();
    this.pendingAdd.clear();
  }
}

/**
 * Wraps missed one-shot prompts in a single confirmation notice for the
 * model (mirrors claw-code's buildMissedTaskNotification, including the
 * batching). The task file is project-controlled, so a prompt read from
 * it must not execute without the user confirming — delivering it raw
 * would bypass the approval gate cron_create runs at scheduling time.
 */
export function buildMissedCronNotification(missed: DurableCronTask[]): string {
  const plural = missed.length > 1;
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while Qwen Code was not running. ` +
    `${plural ? 'They have' : 'It has'} been removed from ${CRON_TASKS_DISPLAY_PATH} and will not fire again.\n\n` +
    `Do NOT execute ${plural ? 'these prompts' : 'this prompt'} yet. ` +
    `First ask the user whether to run ${plural ? 'each one' : 'it'} now ` +
    `(use the ${ToolNames.ASK_USER_QUESTION} tool if available). ` +
    'Only execute if the user confirms.';

  const blocks = missed.map((task) => {
    const meta = `[${humanReadableCron(task.cron)}, created ${new Date(task.createdAt).toLocaleString()}]`;
    // Use a fence one longer than any backtick run in the prompt so a
    // prompt containing ``` cannot close the fence early and un-wrap the
    // trailing text (CommonMark fence-matching rule).
    const longestRun = (task.prompt.match(/`+/g) ?? []).reduce(
      (max, run) => Math.max(max, run.length),
      0,
    );
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${meta}\n${fence}\n${task.prompt}\n${fence}`;
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

function hasParseableCron(task: DurableCronTask): boolean {
  try {
    parseCron(task.cron);
    return true;
  } catch {
    return false;
  }
}

function durableTaskToJob(task: DurableCronTask, existing?: CronJob): CronJob {
  // Jitter is deterministic per (id, cron, recurring) but costly to
  // compute for sparse crons — carry it forward across reloads.
  const jitterMs =
    existing &&
    existing.cronExpr === task.cron &&
    existing.recurring === task.recurring
      ? existing.jitterMs
      : computeJitter(task.id, task.cron, task.recurring);
  return {
    id: task.id,
    cronExpr: task.cron,
    prompt: task.prompt,
    recurring: task.recurring,
    createdAt: task.createdAt,
    expiresAt: task.recurring
      ? task.createdAt + RECURRING_MAX_AGE_MS
      : Infinity,
    lastFiredAt: task.lastFiredAt ?? undefined,
    jitterMs,
    durable: true,
  };
}

function jobToDurableTask(job: CronJob): DurableCronTask {
  return {
    id: job.id,
    cron: job.cronExpr,
    prompt: job.prompt,
    recurring: job.recurring,
    createdAt: job.createdAt,
    lastFiredAt: job.lastFiredAt ?? null,
  };
}

/**
 * Computes the next fire time for a cron expression after `afterMs`,
 * accounting for jitter. Returns null if no match in the next year.
 */
function computeNextFireMs(
  cronExpr: string,
  afterMs: number,
  jitterMs: number,
): number | null {
  try {
    const afterDate = new Date(afterMs);
    const next = nextFireTime(cronExpr, afterDate);
    return next.getTime() + jitterMs;
  } catch {
    return null;
  }
}

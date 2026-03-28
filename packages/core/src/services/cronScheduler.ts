/**
 * In-session cron scheduler. Jobs live in memory and are gone when the
 * process exits. Ticks every second, fires callbacks when jobs are due.
 */

import { matches, nextFireTime } from '../utils/cronParser.js';

const MAX_JOBS = 50;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
// Jitter must stay within the matching minute (< 60s).
// Cap at 55s to avoid edge cases near the minute boundary.
const MAX_JITTER_MS = 55 * 1000;

export interface CronJob {
  id: string;
  cronExpr: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  expiresAt: number;
  lastFiredAt?: number;
  jitterMs: number;
}

/**
 * Derives a deterministic jitter offset from a job ID and its cron period.
 * Recurring jobs get up to 10% of period (capped at 15 min).
 * One-shot jobs get 0 jitter.
 */
function computeJitter(
  id: string,
  cronExpr: string,
  recurring: boolean,
): number {
  if (!recurring) return 0;

  // Estimate period by computing two consecutive fire times
  const now = new Date();
  try {
    const first = nextFireTime(cronExpr, now);
    const second = nextFireTime(cronExpr, first);
    const periodMs = second.getTime() - first.getTime();
    const tenPercent = periodMs * 0.1;
    const maxJitter = Math.min(tenPercent, MAX_JITTER_MS);

    // Deterministic hash from ID
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % Math.max(1, Math.floor(maxJitter));
  } catch {
    return 0;
  }
}

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onFire: ((job: CronJob) => void) | null = null;

  /**
   * Creates a new cron job. Returns the created job.
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
      expiresAt: recurring ? now + THREE_DAYS_MS : now + THREE_DAYS_MS,
      jitterMs,
    };

    this.jobs.set(id, job);
    return job;
  }

  /**
   * Deletes a job by ID. Returns true if the job existed.
   */
  delete(id: string): boolean {
    return this.jobs.delete(id);
  }

  /**
   * Returns all active jobs.
   */
  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  /**
   * Returns the number of active jobs.
   */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Starts the scheduler tick. Calls `onFire` when a job is due.
   * Only fires when called — does not auto-fire missed intervals.
   */
  start(onFire: (job: CronJob) => void): void {
    this.onFire = onFire;
    if (this.timer) return; // already running

    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  }

  /**
   * Stops the scheduler. Does not clear jobs — they remain queryable.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onFire = null;
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
    const currentDate = now ?? new Date();
    const currentMs = currentDate.getTime();

    for (const job of this.jobs.values()) {
      // Check expiry
      if (currentMs >= job.expiresAt) {
        this.jobs.delete(job.id);
        continue;
      }

      // Check if this minute matches
      if (!matches(job.cronExpr, currentDate)) {
        continue;
      }

      // Apply jitter: the job fires at :00 + jitterMs of the matching minute.
      // We check if we're within the jitter window.
      const minuteStart = new Date(currentDate);
      minuteStart.setSeconds(0, 0);
      const fireTimeMs = minuteStart.getTime() + job.jitterMs;

      if (currentMs < fireTimeMs) {
        continue; // Not yet time (jitter hasn't elapsed)
      }

      // Prevent double-firing within the same minute
      if (job.lastFiredAt) {
        const lastFiredMinute = new Date(job.lastFiredAt);
        lastFiredMinute.setSeconds(0, 0);
        if (lastFiredMinute.getTime() === minuteStart.getTime()) {
          continue; // Already fired this minute
        }
      }

      // Fire!
      job.lastFiredAt = currentMs;

      if (!job.recurring) {
        this.jobs.delete(job.id);
      }

      if (this.onFire) {
        this.onFire(job);
      }
    }
  }

  /**
   * Clears all jobs and stops the scheduler.
   */
  destroy(): void {
    this.stop();
    this.jobs.clear();
  }
}

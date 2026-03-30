/**
 * In-session cron scheduler. Jobs live in memory and are gone when the
 * process exits. Ticks every second, fires callbacks when jobs are due.
 */

import { matches, nextFireTime } from '../utils/cronParser.js';
import { humanReadableCron } from '../utils/cronDisplay.js';

const MAX_JOBS = 50;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
// Recurring: up to 10% of period, capped at 15 minutes.
const MAX_RECURRING_JITTER_MS = 15 * 60 * 1000;
// One-shot: up to 90s early for jobs landing on :00 or :30.
const MAX_ONESHOT_JITTER_MS = 90 * 1000;

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

  // One-shot: apply up to 90s early jitter only when minute is :00 or :30
  try {
    const fields = cronExpr.trim().split(/\s+/);
    const minuteField = fields[0] ?? '';
    const minuteVal = parseInt(minuteField, 10);
    if (!isNaN(minuteVal) && (minuteVal === 0 || minuteVal === 30)) {
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
      expiresAt: recurring ? now + THREE_DAYS_MS : Infinity,
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

      // Apply jitter: positive jitter delays after :00, negative fires early.
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
   * Returns a human-readable summary of active jobs for display on session
   * exit. Returns null if there are no active jobs.
   */
  getExitSummary(): string | null {
    if (this.jobs.size === 0) return null;

    const count = this.jobs.size;
    const lines = [
      `Session ending. ${count} active loop${count === 1 ? '' : 's'} cancelled:`,
    ];
    for (const job of this.jobs.values()) {
      const schedule = humanReadableCron(job.cronExpr);
      // Truncate long prompts
      const prompt =
        job.prompt.length > 60 ? job.prompt.slice(0, 57) + '...' : job.prompt;
      lines.push(`  - [${job.id}] ${schedule}: ${prompt}`);
    }
    return lines.join('\n');
  }

  /**
   * Clears all jobs and stops the scheduler.
   */
  destroy(): void {
    this.stop();
    this.jobs.clear();
  }
}

import type {
  ChannelCronJob,
  ChannelCronJobPatch,
  ChannelCronStore,
} from './ChannelCronStore.js';

const MAX_RESULT_PREVIEW_LENGTH = 500;

export interface ChannelRoutineRunner {
  runScheduledPrompt(
    job: ChannelCronJob,
    options?: { timeoutMs?: number },
  ): Promise<string | undefined>;
}

export interface ChannelCronSchedulerOptions {
  store: Pick<ChannelCronStore, 'list' | 'update' | 'disable'>;
  channels: ReadonlyMap<string, ChannelRoutineRunner>;
  nextFireTime: (cron: string, after: Date) => Date;
  now?: () => Date;
  maxConsecutiveFailures?: number;
  intervalMs?: number;
  jobTimeoutMs?: number;
}

export class ChannelCronScheduler {
  private readonly store: Pick<ChannelCronStore, 'list' | 'update' | 'disable'>;
  private readonly channels: ReadonlyMap<string, ChannelRoutineRunner>;
  private readonly nextFireTime: (cron: string, after: Date) => Date;
  private readonly now: () => Date;
  private readonly maxConsecutiveFailures: number;
  private readonly intervalMs: number;
  private readonly jobTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private runningTick: Promise<void> | undefined;
  private readonly inFlightJobs = new Set<string>();

  constructor(options: ChannelCronSchedulerOptions) {
    this.store = options.store;
    this.channels = options.channels;
    this.nextFireTime = options.nextFireTime;
    this.now = options.now ?? (() => new Date());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 5 * 60_000;
  }

  start(): void {
    if (this.timer) return;
    void this.tick().catch((err) => {
      process.stderr.write(`[scheduler] initial tick failed: ${err}\n`);
    });
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        process.stderr.write(`[scheduler] interval tick failed: ${err}\n`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    this.runningTick = undefined;
    this.inFlightJobs.clear();
  }

  async tick(): Promise<void> {
    if (this.runningTick) return this.runningTick;
    this.runningTick = this.runTick().finally(() => {
      this.runningTick = undefined;
    });
    return this.runningTick;
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    const jobs = await this.store.list();
    const dueJobs = jobs.filter(
      (job) =>
        job.enabled &&
        this.channels.has(job.channelName) &&
        !this.inFlightJobs.has(job.id) &&
        this.isDue(job, now),
    );
    await Promise.allSettled(dueJobs.map((job) => this.fireOnce(job, now)));
  }

  private isDue(job: ChannelCronJob, now: Date): boolean {
    try {
      const after = new Date(job.lastFiredAt ?? job.createdAt);
      return this.nextFireTime(job.cron, after).getTime() <= now.getTime();
    } catch (err) {
      process.stderr.write(
        `[scheduler] invalid cron for job ${job.id}: ${err}\n`,
      );
      return false;
    }
  }

  private async fireOnce(job: ChannelCronJob, now: Date): Promise<void> {
    this.inFlightJobs.add(job.id);
    try {
      await this.fire(job, now);
    } finally {
      this.inFlightJobs.delete(job.id);
    }
  }

  private async fire(job: ChannelCronJob, now: Date): Promise<void> {
    const channel = this.channels.get(job.channelName);
    if (!channel) {
      return;
    }
    const latestJob = await this.findJob(job.id);
    if (!latestJob?.enabled) return;

    try {
      await this.store.update(latestJob.id, {
        runningSince: now.toISOString(),
      });
      const resultPreview = await channel.runScheduledPrompt(latestJob, {
        timeoutMs: this.jobTimeoutMs,
      });
      const patch: ChannelCronJobPatch = {
        lastFiredAt: now.toISOString(),
        lastFinishedAt: now.toISOString(),
        lastResultPreview: truncateResultPreview(resultPreview),
        lastStatus: 'ok',
        lastError: undefined,
        consecutiveFailures: 0,
        runningSince: undefined,
        runCount: latestJob.runCount + 1,
      };
      if (!latestJob.recurring) {
        patch.enabled = false;
      }
      await this.store.update(latestJob.id, patch);
    } catch (err) {
      await this.recordFailure(
        latestJob,
        now,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async findJob(id: string): Promise<ChannelCronJob | undefined> {
    const jobs = await this.store.list();
    return jobs.find((job) => job.id === id);
  }

  private async recordFailure(
    job: ChannelCronJob,
    now: Date,
    message: string,
  ): Promise<void> {
    const consecutiveFailures = job.consecutiveFailures + 1;
    await this.store.update(job.id, {
      lastFiredAt: now.toISOString(),
      lastFinishedAt: now.toISOString(),
      lastStatus: 'error',
      lastError: message,
      consecutiveFailures,
      runningSince: undefined,
      runCount: job.runCount + 1,
    });
    if (consecutiveFailures >= this.maxConsecutiveFailures) {
      await this.store.disable(job.id);
    }
  }
}

function truncateResultPreview(text: string | undefined): string | undefined {
  return text === undefined
    ? undefined
    : text.slice(0, MAX_RESULT_PREVIEW_LENGTH);
}

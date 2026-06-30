import type {
  ChannelCronJob,
  ChannelCronJobPatch,
  ChannelCronStore,
} from './ChannelCronStore.js';

export interface ChannelRoutineRunner {
  runScheduledPrompt(
    job: ChannelCronJob,
    options?: { timeoutMs?: number },
  ): Promise<void>;
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
  private readonly inFlightJobs = new Map<string, symbol>();

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
    const tick = this.runTick().finally(() => {
      if (this.runningTick === tick) {
        this.runningTick = undefined;
      }
    });
    this.runningTick = tick;
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
    for (const job of dueJobs) {
      void this.fireOnce(job, now);
    }
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
    const token = Symbol(job.id);
    this.inFlightJobs.set(job.id, token);
    try {
      await this.fire(job, now);
    } catch (err) {
      process.stderr.write(
        `[scheduler] unhandled error for job ${job.id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      if (this.inFlightJobs.get(job.id) === token) {
        this.inFlightJobs.delete(job.id);
      }
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
      await channel.runScheduledPrompt(latestJob, {
        timeoutMs: this.jobTimeoutMs,
      });
    } catch (err) {
      await this.recordFailure(
        latestJob,
        now,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    const patch: ChannelCronJobPatch = {
      lastFiredAt: now.toISOString(),
      lastStatus: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
    };
    if (!latestJob.recurring) {
      patch.enabled = false;
    }
    try {
      await this.store.update(latestJob.id, patch);
    } catch (err) {
      process.stderr.write(
        `[scheduler] job ${latestJob.id} succeeded but status persist failed: ${err instanceof Error ? err.message : String(err)}\n`,
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
      lastStatus: 'error',
      lastError: message,
      consecutiveFailures,
    });
    if (consecutiveFailures >= this.maxConsecutiveFailures) {
      await this.store.disable(job.id);
    }
  }
}

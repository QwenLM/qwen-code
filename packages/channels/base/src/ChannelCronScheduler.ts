import type { ChannelCronJob, ChannelCronStore } from './ChannelCronStore.js';

export interface ChannelRoutineRunner {
  runScheduledPrompt(job: ChannelCronJob): Promise<void>;
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
  private readonly timedOutJobs = new Set<string>();

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
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
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
      if (!this.timedOutJobs.has(job.id)) {
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

    let run: Promise<void> | undefined;
    try {
      run = channel.runScheduledPrompt(latestJob);
      await this.withTimeout(run, latestJob.id);
      await this.store.update(latestJob.id, {
        lastFiredAt: now.toISOString(),
        lastStatus: 'ok',
        lastError: undefined,
        consecutiveFailures: 0,
      });
      if (!latestJob.recurring) {
        await this.store.disable(latestJob.id);
      }
    } catch (err) {
      if (
        run !== undefined &&
        err instanceof Error &&
        err.message === 'scheduled job timed out'
      ) {
        this.timedOutJobs.add(latestJob.id);
        run
          .catch(() => undefined)
          .finally(() => {
            this.timedOutJobs.delete(latestJob.id);
            this.inFlightJobs.delete(latestJob.id);
          });
      }
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

  private async withTimeout(run: Promise<void>, jobId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('scheduled job timed out'));
          }, this.jobTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      process.stderr.write(`[scheduler] job ${jobId} failed: ${err}\n`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
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

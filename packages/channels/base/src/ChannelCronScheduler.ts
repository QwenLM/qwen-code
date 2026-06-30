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
}

export class ChannelCronScheduler {
  private readonly store: Pick<ChannelCronStore, 'list' | 'update' | 'disable'>;
  private readonly channels: ReadonlyMap<string, ChannelRoutineRunner>;
  private readonly nextFireTime: (cron: string, after: Date) => Date;
  private readonly now: () => Date;
  private readonly maxConsecutiveFailures: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private runningTick: Promise<void> | undefined;

  constructor(options: ChannelCronSchedulerOptions) {
    this.store = options.store;
    this.channels = options.channels;
    this.nextFireTime = options.nextFireTime;
    this.now = options.now ?? (() => new Date());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
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
    for (const job of jobs) {
      if (!job.enabled || !this.isDue(job, now)) continue;
      await this.fire(job, now);
    }
  }

  private isDue(job: ChannelCronJob, now: Date): boolean {
    const after = new Date(job.lastFiredAt ?? job.createdAt);
    return this.nextFireTime(job.cron, after).getTime() <= now.getTime();
  }

  private async fire(job: ChannelCronJob, now: Date): Promise<void> {
    const channel = this.channels.get(job.channelName);
    if (!channel) {
      await this.recordFailure(
        job,
        now,
        `Channel not running: ${job.channelName}`,
      );
      return;
    }

    try {
      await channel.runScheduledPrompt(job);
      await this.store.update(job.id, {
        lastFiredAt: now.toISOString(),
        lastStatus: 'ok',
        lastError: undefined,
        consecutiveFailures: 0,
      });
      if (!job.recurring) {
        await this.store.disable(job.id);
      }
    } catch (err) {
      await this.recordFailure(
        job,
        now,
        err instanceof Error ? err.message : String(err),
      );
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

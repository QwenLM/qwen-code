import type {
  ChannelLoop,
  ChannelLoopPatch,
  ChannelLoopStore,
} from './ChannelLoopStore.js';

const MAX_RESULT_PREVIEW_LENGTH = 500;
const MAX_CONCURRENT_LOOP_FIRES = 5;

export interface ChannelLoopRunner {
  runLoopPrompt(
    job: ChannelLoop,
    options?: { timeoutMs?: number; shouldContinue?: () => Promise<boolean> },
  ): Promise<string | undefined>;
}

export interface ChannelLoopSchedulerOptions {
  store: Pick<ChannelLoopStore, 'list' | 'update' | 'disable'>;
  channels: ReadonlyMap<string, ChannelLoopRunner>;
  nextFireTime: (cron: string, after: Date) => Date;
  now?: () => Date;
  maxConsecutiveFailures?: number;
  intervalMs?: number;
  loopTimeoutMs?: number;
}

export class ChannelLoopSkippedError extends Error {}

export class ChannelLoopScheduler {
  private readonly store: Pick<ChannelLoopStore, 'list' | 'update' | 'disable'>;
  private readonly channels: ReadonlyMap<string, ChannelLoopRunner>;
  private readonly nextFireTime: (cron: string, after: Date) => Date;
  private readonly now: () => Date;
  private readonly maxConsecutiveFailures: number;
  private readonly intervalMs: number;
  private readonly loopTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private runningTick: Promise<void> | undefined;
  private readonly inFlightJobs = new Map<string, symbol>();
  private generation = 0;

  constructor(options: ChannelLoopSchedulerOptions) {
    this.store = options.store;
    this.channels = options.channels;
    this.nextFireTime = options.nextFireTime;
    this.now = options.now ?? (() => new Date());
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.loopTimeoutMs = options.loopTimeoutMs ?? 5 * 60_000;
  }

  start(): void {
    if (this.timer) return;
    const generation = this.generation;
    const startup = this.reconcileStartupState();
    void startup
      .then(() => {
        if (!this.timer || this.generation !== generation) return;
        return this.tick();
      })
      .catch((err) => {
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
    this.generation++;
    this.inFlightJobs.clear();
  }

  private async reconcileStartupState(): Promise<void> {
    const jobs = await this.store.list();
    const staleRunning = jobs.filter((job) => job.runningSince);
    for (const job of staleRunning) {
      await this.clearRunningSince(job.id);
    }
    const enabledCount = jobs.filter((job) => job.enabled).length;
    process.stderr.write(
      `[scheduler] started, tick interval ${this.intervalMs}ms, jobs ${jobs.length}, enabled ${enabledCount}, cleared stale running ${staleRunning.length}\n`,
    );
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
    const generation = this.generation;
    const now = this.now();
    const jobs = await this.store.list();
    if (this.generation !== generation) {
      return;
    }
    const dueJobs = jobs.filter(
      (job) =>
        job.enabled &&
        this.channels.has(job.channelName) &&
        !this.inFlightJobs.has(job.id) &&
        this.isDue(job, now),
    );
    const availableSlots = MAX_CONCURRENT_LOOP_FIRES - this.inFlightJobs.size;
    if (availableSlots <= 0) return;
    for (const job of dueJobs.slice(0, availableSlots)) {
      void this.fireOnce(job, now, generation);
    }
  }

  private isDue(job: ChannelLoop, now: Date): boolean {
    try {
      const after = new Date(lastAnchor(job));
      return this.nextFireTime(job.cron, after).getTime() <= now.getTime();
    } catch (err) {
      process.stderr.write(
        `[scheduler] invalid cron for loop ${job.id}: ${err}\n`,
      );
      return false;
    }
  }

  private async fireOnce(
    job: ChannelLoop,
    now: Date,
    generation: number,
  ): Promise<void> {
    const token = Symbol(job.id);
    this.inFlightJobs.set(job.id, token);
    try {
      await this.fire(job, now, generation);
    } catch (err) {
      process.stderr.write(
        `[scheduler] unhandled error for loop ${job.id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      if (this.inFlightJobs.get(job.id) === token) {
        this.inFlightJobs.delete(job.id);
      }
    }
  }

  private async fire(
    job: ChannelLoop,
    now: Date,
    generation: number,
  ): Promise<void> {
    const channel = this.channels.get(job.channelName);
    if (!channel) {
      return;
    }
    const latestJob = await this.findJob(job.id);
    if (!latestJob?.enabled) return;
    if (this.generation !== generation) return;

    const runningSince = now.toISOString();
    let resultPreview: string | undefined;
    try {
      await this.store.update(latestJob.id, {
        runningSince,
        lastFiredAt: runningSince,
      });
      if (this.generation !== generation) {
        await this.clearRunningSince(latestJob.id, runningSince);
        return;
      }
      resultPreview = await channel.runLoopPrompt(latestJob, {
        timeoutMs: this.loopTimeoutMs,
        shouldContinue: async () => {
          if (this.generation !== generation) {
            return false;
          }
          const currentJob = await this.findJob(latestJob.id);
          return currentJob?.enabled === true;
        },
      });
    } catch (err) {
      if (err instanceof ChannelLoopSkippedError) {
        await this.recordSkipped(latestJob.id, runningSince);
        return;
      }
      let currentJob: ChannelLoop | undefined;
      try {
        currentJob = await this.findJob(latestJob.id);
      } catch (findErr) {
        process.stderr.write(
          `[scheduler] findJob failed in catch for loop ${latestJob.id}: ${findErr instanceof Error ? findErr.message : String(findErr)}\n`,
        );
        await this.clearRunningSince(latestJob.id, runningSince);
        return;
      }
      if (this.generation !== generation || !currentJob?.enabled) {
        await this.clearRunningSince(latestJob.id, runningSince);
        return;
      }
      await this.recordFailure(
        currentJob,
        now,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    const currentJob = await this.findJob(latestJob.id);
    if (!currentJob || currentJob.runningSince !== runningSince) {
      return;
    }

    const finishedAt = this.now();
    const patch: ChannelLoopPatch = {
      lastFiredAt: runningSince,
      lastFinishedAt: finishedAt.toISOString(),
      lastResultPreview: truncateResultPreview(resultPreview),
      lastStatus: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
      runningSince: undefined,
      runCount: currentJob.runCount + 1,
    };
    if (!currentJob.recurring) {
      patch.enabled = false;
    }
    try {
      await this.store.update(latestJob.id, patch);
    } catch (err) {
      process.stderr.write(
        `[scheduler] loop ${latestJob.id} succeeded but status persist failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await this.clearRunningSince(latestJob.id, runningSince);
    }
  }

  private async findJob(id: string): Promise<ChannelLoop | undefined> {
    const jobs = await this.store.list();
    return jobs.find((job) => job.id === id);
  }

  private async clearRunningSince(
    id: string,
    expectedRunningSince?: string,
  ): Promise<void> {
    try {
      if (expectedRunningSince) {
        const currentJob = await this.findJob(id);
        if (currentJob?.runningSince !== expectedRunningSince) return;
      }
      await this.store.update(id, { runningSince: undefined });
    } catch (err) {
      process.stderr.write(
        `[scheduler] failed to clear running state for loop ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private async recordSkipped(
    id: string,
    expectedRunningSince: string,
  ): Promise<void> {
    try {
      const currentJob = await this.findJob(id);
      if (!currentJob || currentJob.runningSince !== expectedRunningSince) {
        return;
      }
      await this.store.update(id, {
        lastFinishedAt: this.now().toISOString(),
        runningSince: undefined,
      });
    } catch (err) {
      process.stderr.write(
        `[scheduler] failed to record skipped loop ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private async recordFailure(
    job: ChannelLoop,
    now: Date,
    message: string,
  ): Promise<void> {
    const consecutiveFailures = job.consecutiveFailures + 1;
    const patch: ChannelLoopPatch = {
      lastFiredAt: now.toISOString(),
      lastFinishedAt: this.now().toISOString(),
      lastStatus: 'error',
      lastError: truncateError(message),
      lastResultPreview: undefined,
      consecutiveFailures,
      runningSince: undefined,
      runCount: job.runCount + 1,
    };
    if (!job.recurring) {
      patch.enabled = false;
    }
    if (consecutiveFailures >= this.maxConsecutiveFailures) {
      patch.enabled = false;
      process.stderr.write(
        `[scheduler] loop ${job.id} auto-disabled after ${consecutiveFailures} consecutive failures\n`,
      );
    }
    try {
      await this.store.update(job.id, patch);
    } catch (err) {
      process.stderr.write(
        `[scheduler] loop ${job.id} failure persist failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await this.clearRunningSince(job.id);
    }
  }
}

function lastAnchor(job: ChannelLoop): string {
  if (job.lastFiredAt && job.lastFinishedAt) {
    return new Date(job.lastFiredAt).getTime() >
      new Date(job.lastFinishedAt).getTime()
      ? job.lastFiredAt
      : job.lastFinishedAt;
  }
  return job.lastFinishedAt ?? job.lastFiredAt ?? job.createdAt;
}

function truncateResultPreview(text: string | undefined): string | undefined {
  return text === undefined
    ? undefined
    : text.slice(0, MAX_RESULT_PREVIEW_LENGTH);
}

function truncateError(message: string): string {
  return message.slice(0, 1000);
}

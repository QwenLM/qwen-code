import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionTarget } from './types.js';

export type ChannelCronJobStatus = 'ok' | 'error';

export interface ChannelCronJob {
  id: string;
  channelName: string;
  target: SessionTarget;
  cwd: string;
  cron: string;
  prompt: string;
  label?: string;
  recurring: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastFiredAt?: string;
  lastFinishedAt?: string;
  lastResultPreview?: string;
  lastStatus?: ChannelCronJobStatus;
  lastError?: string;
  consecutiveFailures: number;
  runningSince?: string;
  runCount: number;
}

export type ChannelCronJobInput = Omit<
  ChannelCronJob,
  | 'id'
  | 'enabled'
  | 'createdAt'
  | 'lastFiredAt'
  | 'lastFinishedAt'
  | 'lastResultPreview'
  | 'lastStatus'
  | 'lastError'
  | 'consecutiveFailures'
  | 'runningSince'
  | 'runCount'
>;

export type ChannelCronJobPatch = Partial<
  Pick<
    ChannelCronJob,
    | 'enabled'
    | 'lastFiredAt'
    | 'lastFinishedAt'
    | 'lastResultPreview'
    | 'lastStatus'
    | 'lastError'
    | 'consecutiveFailures'
    | 'runningSince'
    | 'runCount'
  >
>;

export interface ChannelCronStoreOptions {
  filePath: string;
  now?: () => Date;
  idFactory?: () => string;
}

export class ChannelCronStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(options: ChannelCronStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.idFactory =
      options.idFactory ?? (() => crypto.randomUUID().slice(0, 8));
  }

  async list(): Promise<ChannelCronJob[]> {
    return this.readJobs();
  }

  async listForTarget(
    channelName: string,
    target: SessionTarget,
  ): Promise<ChannelCronJob[]> {
    const jobs = await this.readJobs();
    return jobs.filter(
      (job) =>
        job.channelName === channelName && sameTarget(job.target, target),
    );
  }

  async create(input: ChannelCronJobInput): Promise<ChannelCronJob> {
    const job: ChannelCronJob = {
      ...input,
      id: this.idFactory(),
      enabled: true,
      createdAt: this.now().toISOString(),
      consecutiveFailures: 0,
      runCount: 0,
    };
    await this.updateJobs((jobs) => [...jobs, job]);
    return job;
  }

  async createForTarget(
    input: ChannelCronJobInput,
    maxEnabledJobs: number,
  ): Promise<ChannelCronJob | undefined> {
    let created: ChannelCronJob | undefined;
    await this.updateJobs((jobs) => {
      const enabledForTarget = jobs.filter(
        (job) =>
          job.enabled &&
          job.channelName === input.channelName &&
          sameTarget(job.target, input.target),
      ).length;
      if (enabledForTarget >= maxEnabledJobs) {
        return jobs;
      }
      const job: ChannelCronJob = {
        ...input,
        id: this.idFactory(),
        enabled: true,
        createdAt: this.now().toISOString(),
        consecutiveFailures: 0,
        runCount: 0,
      };
      created = job;
      return [...jobs, job];
    });
    return created;
  }

  async update(id: string, patch: ChannelCronJobPatch): Promise<boolean> {
    let found = false;
    await this.updateJobs((jobs) =>
      jobs.map((job) => {
        if (job.id !== id) return job;
        found = true;
        return { ...job, ...patch };
      }),
    );
    return found;
  }

  async disable(id: string): Promise<boolean> {
    return this.update(id, { enabled: false });
  }

  private async updateJobs(
    mutate: (jobs: ChannelCronJob[]) => ChannelCronJob[],
  ): Promise<void> {
    const nextUpdate = this.pendingUpdate.then(async () => {
      const jobs = await this.readJobs();
      await this.writeJobs(mutate(jobs));
    });
    this.pendingUpdate = nextUpdate.catch(() => {});
    await nextUpdate;
  }

  private async readJobs(): Promise<ChannelCronJob[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Malformed JSON in ${this.filePath}; fix or delete the file.`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error(
        `Expected a JSON array in ${this.filePath}; fix or delete the file.`,
      );
    }
    for (const [index, value] of parsed.entries()) {
      if (!isChannelCronJob(value)) {
        throw new Error(
          `Invalid channel cron job at index ${index} in ${this.filePath}.`,
        );
      }
    }
    return parsed.map(normalizeJob);
  }

  private async writeJobs(jobs: ChannelCronJob[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(jobs, null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  const sameGroupChat = a.isGroup === true && b.isGroup === true;
  return (
    a.channelName === b.channelName &&
    (sameGroupChat || a.senderId === b.senderId) &&
    a.chatId === b.chatId &&
    a.threadId === b.threadId &&
    a.isGroup === b.isGroup
  );
}

function isSessionTarget(value: unknown): value is SessionTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target['channelName'] === 'string' &&
    typeof target['senderId'] === 'string' &&
    typeof target['chatId'] === 'string' &&
    (target['threadId'] === undefined ||
      typeof target['threadId'] === 'string') &&
    (target['isGroup'] === undefined || typeof target['isGroup'] === 'boolean')
  );
}

function isChannelCronJob(value: unknown): value is ChannelCronJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job['id'] === 'string' &&
    typeof job['channelName'] === 'string' &&
    isSessionTarget(job['target']) &&
    typeof job['cwd'] === 'string' &&
    typeof job['cron'] === 'string' &&
    typeof job['prompt'] === 'string' &&
    (job['label'] === undefined || typeof job['label'] === 'string') &&
    typeof job['recurring'] === 'boolean' &&
    typeof job['enabled'] === 'boolean' &&
    typeof job['createdBy'] === 'string' &&
    typeof job['createdAt'] === 'string' &&
    (job['lastFiredAt'] === undefined ||
      typeof job['lastFiredAt'] === 'string') &&
    (job['lastFinishedAt'] === undefined ||
      typeof job['lastFinishedAt'] === 'string') &&
    (job['lastResultPreview'] === undefined ||
      typeof job['lastResultPreview'] === 'string') &&
    (job['lastStatus'] === undefined ||
      job['lastStatus'] === 'ok' ||
      job['lastStatus'] === 'error') &&
    (job['lastError'] === undefined || typeof job['lastError'] === 'string') &&
    typeof job['consecutiveFailures'] === 'number' &&
    (job['runningSince'] === undefined ||
      typeof job['runningSince'] === 'string') &&
    (job['runCount'] === undefined || typeof job['runCount'] === 'number')
  );
}

function normalizeJob(job: ChannelCronJob): ChannelCronJob {
  return {
    ...job,
    runCount: job.runCount ?? 0,
  };
}

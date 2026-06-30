import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelCronScheduler } from './ChannelCronScheduler.js';
import type { ChannelCronJob, ChannelCronStore } from './ChannelCronStore.js';

describe('ChannelCronScheduler', () => {
  let jobs: ChannelCronJob[];
  let store: Pick<ChannelCronStore, 'list' | 'update' | 'disable'>;
  let runScheduledPrompt: ReturnType<typeof vi.fn>;
  let nowMs: number;

  const baseJob: ChannelCronJob = {
    id: 'job-1',
    channelName: 'feishu-main',
    target: {
      channelName: 'feishu-main',
      senderId: 'alice',
      chatId: 'chat-1',
    },
    cwd: '/repo',
    cron: '* * * * *',
    prompt: 'summarize',
    label: 'summary',
    recurring: true,
    enabled: true,
    createdBy: 'Alice',
    createdAt: '2026-06-30T01:00:00.000Z',
    consecutiveFailures: 0,
  };

  beforeEach(() => {
    jobs = [{ ...baseJob }];
    nowMs = Date.parse('2026-06-30T01:05:30.000Z');
    store = {
      list: vi.fn(async () => jobs),
      update: vi.fn(async (id, patch) => {
        jobs = jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
        return true;
      }),
      disable: vi.fn(async (id) => {
        jobs = jobs.map((job) =>
          job.id === id ? { ...job, enabled: false } : job,
        );
        return true;
      }),
    };
    runScheduledPrompt = vi.fn(async () => undefined);
  });

  it('fires an overdue enabled job through its channel and records success', async () => {
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date('2026-06-30T01:01:00.000Z'),
    });

    await scheduler.tick();

    expect(runScheduledPrompt).toHaveBeenCalledWith(baseJob);
    expect(store.update).toHaveBeenCalledWith('job-1', {
      lastFiredAt: '2026-06-30T01:05:30.000Z',
      lastStatus: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
    });
  });

  it('does not replay a recurring job again after recording the catch-up fire', async () => {
    const nextFireTime = vi.fn((_, after: Date) => {
      if (after.getTime() < nowMs) return new Date(nowMs - 60_000);
      return new Date(nowMs + 60_000);
    });
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime,
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runScheduledPrompt).toHaveBeenCalledTimes(1);
  });

  it('disables a one-shot job after it fires', async () => {
    jobs = [{ ...baseJob, recurring: false }];
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(store.disable).toHaveBeenCalledWith('job-1');
  });

  it('records failures and disables a job after repeated errors', async () => {
    jobs = [{ ...baseJob, consecutiveFailures: 4 }];
    runScheduledPrompt.mockRejectedValue(new Error('cannot cold send'));
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
      maxConsecutiveFailures: 5,
    });

    await scheduler.tick();

    expect(store.update).toHaveBeenCalledWith('job-1', {
      lastFiredAt: '2026-06-30T01:05:30.000Z',
      lastStatus: 'error',
      lastError: 'cannot cold send',
      consecutiveFailures: 5,
    });
    expect(store.disable).toHaveBeenCalledWith('job-1');
  });
});

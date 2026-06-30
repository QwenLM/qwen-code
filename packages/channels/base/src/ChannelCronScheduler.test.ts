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
    runCount: 0,
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
    runScheduledPrompt = vi.fn(async () => 'done summary');
  });

  it('fires an overdue enabled job through its channel and records success', async () => {
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date('2026-06-30T01:01:00.000Z'),
    });

    await scheduler.tick();

    expect(runScheduledPrompt).toHaveBeenCalledWith(baseJob, {
      timeoutMs: 300_000,
    });
    expect(store.update).toHaveBeenCalledWith('job-1', {
      lastFiredAt: '2026-06-30T01:05:30.000Z',
      lastFinishedAt: '2026-06-30T01:05:30.000Z',
      lastResultPreview: 'done summary',
      lastStatus: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
      runningSince: undefined,
      runCount: 1,
    });
  });

  it('truncates long result previews before storing success', async () => {
    runScheduledPrompt.mockResolvedValue('x'.repeat(600));
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date('2026-06-30T01:01:00.000Z'),
    });

    await scheduler.tick();

    expect(store.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        lastResultPreview: 'x'.repeat(500),
      }),
    );
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

    expect(store.update).toHaveBeenCalledWith('job-1', {
      lastFiredAt: '2026-06-30T01:05:30.000Z',
      lastFinishedAt: '2026-06-30T01:05:30.000Z',
      lastResultPreview: 'done summary',
      lastStatus: 'ok',
      lastError: undefined,
      consecutiveFailures: 0,
      runningSince: undefined,
      runCount: 1,
      enabled: false,
    });
    expect(store.disable).not.toHaveBeenCalled();
  });

  it('clears abandoned in-flight state when stopped', async () => {
    runScheduledPrompt.mockImplementation(() => new Promise(() => undefined));
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    void scheduler.tick();
    await vi.waitFor(() => expect(runScheduledPrompt).toHaveBeenCalledOnce());

    scheduler.stop();
    void scheduler.tick();

    await vi.waitFor(() => expect(runScheduledPrompt).toHaveBeenCalledTimes(2));
  });

  it('passes the timeout budget to the channel runner', async () => {
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
      jobTimeoutMs: 1234,
    });

    await scheduler.tick();

    expect(runScheduledPrompt).toHaveBeenCalledWith(baseJob, {
      timeoutMs: 1234,
    });
  });

  it('marks a job as running before awaiting the channel routine', async () => {
    let finish!: (value: string) => void;
    runScheduledPrompt.mockImplementation(
      () => new Promise((resolve) => void (finish = resolve)),
    );
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    const tick = scheduler.tick();

    await vi.waitFor(() => expect(runScheduledPrompt).toHaveBeenCalledOnce());
    expect(store.update).toHaveBeenNthCalledWith(1, 'job-1', {
      runningSince: '2026-06-30T01:05:30.000Z',
    });

    finish('done summary');
    await tick;
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
      lastFinishedAt: '2026-06-30T01:05:30.000Z',
      lastStatus: 'error',
      lastError: 'cannot cold send',
      consecutiveFailures: 5,
      runningSince: undefined,
      runCount: 1,
    });
    expect(store.disable).toHaveBeenCalledWith('job-1');
  });

  it('skips jobs for channels owned by another process', async () => {
    jobs = [{ ...baseJob, channelName: 'other-channel' }];
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(runScheduledPrompt).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(store.disable).not.toHaveBeenCalled();
  });

  it('continues firing other due jobs when one job is still running', async () => {
    const secondJob = { ...baseJob, id: 'job-2' };
    jobs = [{ ...baseJob }, secondJob];
    runScheduledPrompt.mockImplementation((job: ChannelCronJob) => {
      if (job.id === 'job-1') return new Promise(() => undefined);
      return Promise.resolve();
    });
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    void scheduler.tick();
    await vi.waitFor(() => {
      expect(runScheduledPrompt).toHaveBeenCalledWith(secondJob, {
        timeoutMs: 300_000,
      });
    });
  });

  it('rechecks that a job is still enabled before firing', async () => {
    store.list = vi
      .fn()
      .mockResolvedValueOnce([{ ...baseJob }])
      .mockResolvedValueOnce([{ ...baseJob, enabled: false }]);
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(runScheduledPrompt).not.toHaveBeenCalled();
  });

  it('ignores a malformed cron job and still fires later due jobs', async () => {
    const secondJob = { ...baseJob, id: 'job-2' };
    jobs = [{ ...baseJob }, secondJob];
    const nextFireTime = vi.fn((cron: string) => {
      if (cron === baseJob.cron) throw new Error('impossible cron');
      return new Date(nowMs - 60_000);
    });
    jobs[1] = { ...secondJob, cron: '*/5 * * * *' };
    const scheduler = new ChannelCronScheduler({
      store,
      channels: new Map([['feishu-main', { runScheduledPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime,
    });

    await scheduler.tick();

    expect(runScheduledPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-2' }),
      { timeoutMs: 300_000 },
    );
  });
});

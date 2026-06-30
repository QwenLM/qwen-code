import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelLoopScheduler,
  ChannelLoopSkippedError,
} from './ChannelLoopScheduler.js';
import type { ChannelLoop, ChannelLoopStore } from './ChannelLoopStore.js';

describe('ChannelLoopScheduler', () => {
  let jobs: ChannelLoop[];
  let store: Pick<ChannelLoopStore, 'list' | 'update' | 'disable'>;
  let runLoopPrompt: ReturnType<typeof vi.fn>;
  let nowMs: number;

  const baseJob: ChannelLoop = {
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

  const runOptions = (timeoutMs = 300_000) =>
    expect.objectContaining({
      timeoutMs,
      shouldContinue: expect.any(Function),
    });

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
    runLoopPrompt = vi.fn(async () => 'done summary');
  });

  it('starts immediately, ticks on the interval, and stops scheduling', async () => {
    jobs = [];
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs + 60_000),
      intervalMs: 1_000,
    });

    vi.useFakeTimers();
    try {
      scheduler.start();
      await Promise.resolve();
      expect(store.list).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.list).toHaveBeenCalledTimes(3);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(store.list).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      scheduler.stop();
    }
  });

  it('clears stale running state and logs startup diagnostics', async () => {
    jobs = [
      {
        ...baseJob,
        runningSince: '2026-06-30T00:59:00.000Z',
      },
      {
        ...baseJob,
        id: 'job-2',
        enabled: false,
      },
    ];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs + 60_000),
      intervalMs: 1_000,
    });

    vi.useFakeTimers();
    try {
      scheduler.start();

      await vi.waitFor(() => {
        expect(store.update).toHaveBeenCalledWith('job-1', {
          runningSince: undefined,
        });
      });
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[scheduler] started, tick interval 1000ms, jobs 2, enabled 1, cleared stale running 1',
        ),
      );
    } finally {
      vi.useRealTimers();
      scheduler.stop();
      writeSpy.mockRestore();
    }
  });

  it('fires an overdue enabled job through its channel and records success', async () => {
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date('2026-06-30T01:01:00.000Z'),
    });

    await scheduler.tick();

    expect(runLoopPrompt).toHaveBeenCalledWith(baseJob, runOptions());
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
    runLoopPrompt.mockResolvedValue('x'.repeat(600));
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
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
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime,
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runLoopPrompt).toHaveBeenCalledTimes(1);
  });

  it('disables a one-shot job after it fires', async () => {
    jobs = [{ ...baseJob, recurring: false }];
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
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

  it('does not let stopped in-flight loops write stale lifecycle state', async () => {
    let finishFirst!: (value: string) => void;
    runLoopPrompt.mockImplementation(() => new Promise(() => undefined));
    runLoopPrompt
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => void (finishFirst = resolve)),
      )
      .mockResolvedValueOnce('second result');
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    void scheduler.tick();
    await vi.waitFor(() => expect(runLoopPrompt).toHaveBeenCalledOnce());

    scheduler.stop();
    void scheduler.tick();

    await vi.waitFor(() => expect(runLoopPrompt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(store.update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ lastResultPreview: 'second result' }),
      ),
    );
    finishFirst('stale result');
    await Promise.resolve();

    expect(store.update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ lastResultPreview: 'stale result' }),
    );
    expect(store.update).toHaveBeenCalledWith('job-1', {
      runningSince: undefined,
    });
  });

  it('uses lastFinishedAt as the recurrence anchor', async () => {
    jobs = [
      {
        ...baseJob,
        lastFiredAt: '2026-06-30T01:00:00.000Z',
        lastFinishedAt: '2026-06-30T01:05:00.000Z',
      },
    ];
    const nextFireTime = vi.fn(
      (_, after: Date) => new Date(after.getTime() + 60_000),
    );
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date('2026-06-30T01:05:30.000Z'),
      nextFireTime,
    });

    await scheduler.tick();

    expect(runLoopPrompt).not.toHaveBeenCalled();
    expect(nextFireTime).toHaveBeenCalledWith(
      baseJob.cron,
      new Date('2026-06-30T01:05:00.000Z'),
    );
  });

  it('passes the timeout budget to the channel runner', async () => {
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
      loopTimeoutMs: 1234,
    });

    await scheduler.tick();

    expect(runLoopPrompt).toHaveBeenCalledWith(baseJob, runOptions(1234));
  });

  it('marks a loop as running before awaiting the channel loop', async () => {
    let finish!: (value: string) => void;
    runLoopPrompt.mockImplementation(
      () => new Promise((resolve) => void (finish = resolve)),
    );
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    const tick = scheduler.tick();

    await vi.waitFor(() => expect(runLoopPrompt).toHaveBeenCalledOnce());
    expect(store.update).toHaveBeenNthCalledWith(1, 'job-1', {
      runningSince: '2026-06-30T01:05:30.000Z',
      lastFiredAt: '2026-06-30T01:05:30.000Z',
    });

    finish('done summary');
    await tick;
  });

  it('records failures and disables a job after repeated errors', async () => {
    jobs = [{ ...baseJob, consecutiveFailures: 4 }];
    runLoopPrompt.mockRejectedValue(new Error('cannot cold send'));
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
      maxConsecutiveFailures: 5,
    });

    await scheduler.tick();

    await vi.waitFor(() => {
      expect(store.update).toHaveBeenCalledWith('job-1', {
        lastFiredAt: '2026-06-30T01:05:30.000Z',
        lastFinishedAt: '2026-06-30T01:05:30.000Z',
        lastStatus: 'error',
        lastError: 'cannot cold send',
        lastResultPreview: undefined,
        consecutiveFailures: 5,
        runningSince: undefined,
        runCount: 1,
        enabled: false,
      });
    });
    expect(store.disable).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[scheduler] loop job-1 auto-disabled after 5 consecutive failures',
      ),
    );
    writeSpy.mockRestore();
  });

  it('disables one-shot loops after a failed attempt', async () => {
    jobs = [{ ...baseJob, recurring: false }];
    runLoopPrompt.mockRejectedValue(new Error('cannot cold send'));
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    await vi.waitFor(() => {
      expect(store.update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ lastStatus: 'error', enabled: false }),
      );
    });
  });

  it('records failure finish time when the loop fails', async () => {
    runLoopPrompt.mockRejectedValue(new Error('cannot cold send'));
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: vi
        .fn()
        .mockReturnValueOnce(new Date(nowMs))
        .mockReturnValue(new Date(nowMs + 15_000)),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    await vi.waitFor(() => {
      expect(store.update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          lastFiredAt: '2026-06-30T01:05:30.000Z',
          lastFinishedAt: '2026-06-30T01:05:45.000Z',
        }),
      );
    });
  });

  it('skips jobs for channels owned by another process', async () => {
    jobs = [{ ...baseJob, channelName: 'other-channel' }];
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(runLoopPrompt).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(store.disable).not.toHaveBeenCalled();
  });

  it('continues firing other due jobs when one job is still running', async () => {
    const secondJob = { ...baseJob, id: 'job-2' };
    jobs = [{ ...baseJob }, secondJob];
    runLoopPrompt.mockImplementation((job: ChannelLoop) => {
      if (job.id === 'job-1') return new Promise(() => undefined);
      return Promise.resolve();
    });
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    void scheduler.tick();
    await vi.waitFor(() => {
      expect(runLoopPrompt).toHaveBeenCalledWith(secondJob, runOptions());
    });
  });

  it('does not block later ticks behind a hung job', async () => {
    const laterJob = {
      ...baseJob,
      id: 'job-2',
      createdAt: '2026-06-30T01:06:00.000Z',
    };
    jobs = [{ ...baseJob }];
    runLoopPrompt.mockImplementation((job: ChannelLoop) => {
      if (job.id === 'job-1') return new Promise(() => undefined);
      return Promise.resolve();
    });
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    void scheduler.tick();
    await vi.waitFor(() => {
      expect(runLoopPrompt).toHaveBeenCalledWith(baseJob, runOptions());
    });
    jobs = [jobs[0]!, laterJob];
    void scheduler.tick();

    await vi.waitFor(() => {
      expect(runLoopPrompt).toHaveBeenCalledWith(laterJob, runOptions());
    });
  });

  it('logs success persistence failures without recording a job failure', async () => {
    store.update = vi.fn(async (_id, patch) => {
      if (patch.lastStatus === 'ok') {
        throw new Error('disk full');
      }
      return true;
    });
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(store.update).toHaveBeenCalledTimes(3);
    expect(store.disable).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('job-1', {
      runningSince: undefined,
    });
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('succeeded but status persist failed'),
    );
    writeSpy.mockRestore();
  });

  it('does not record skipped loop turns as job failures', async () => {
    runLoopPrompt.mockRejectedValue(new ChannelLoopSkippedError('user steer'));
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(store.update).toHaveBeenCalledWith('job-1', {
      runningSince: undefined,
    });
    expect(store.update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ lastStatus: 'error' }),
    );
  });

  it('rechecks that a job is still enabled before firing', async () => {
    store.list = vi
      .fn()
      .mockResolvedValueOnce([{ ...baseJob }])
      .mockResolvedValueOnce([{ ...baseJob, enabled: false }]);
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime: () => new Date(nowMs - 60_000),
    });

    await scheduler.tick();

    expect(runLoopPrompt).not.toHaveBeenCalled();
  });

  it('ignores a malformed cron job and still fires later due jobs', async () => {
    const secondJob = { ...baseJob, id: 'job-2' };
    jobs = [{ ...baseJob }, secondJob];
    const nextFireTime = vi.fn((cron: string) => {
      if (cron === baseJob.cron) throw new Error('impossible cron');
      return new Date(nowMs - 60_000);
    });
    jobs[1] = { ...secondJob, cron: '*/5 * * * *' };
    const scheduler = new ChannelLoopScheduler({
      store,
      channels: new Map([['feishu-main', { runLoopPrompt }]]),
      now: () => new Date(nowMs),
      nextFireTime,
    });

    await scheduler.tick();

    expect(runLoopPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-2' }),
      runOptions(),
    );
  });
});

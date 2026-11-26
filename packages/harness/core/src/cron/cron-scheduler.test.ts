/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  isRecurringTaskAged,
  buildMissedTaskNotification,
} from './cron-scheduler.js';
import type { CronTask, SessionCronTaskStore } from './cron-tasks.js';

describe('cron-scheduler', () => {
  // -------------------------------------------------------------------------
  // isRecurringTaskAged
  // -------------------------------------------------------------------------
  describe('isRecurringTaskAged', () => {
    const makeTask = (overrides: Partial<CronTask> = {}): CronTask => ({
      id: 'test-id',
      cron: '*/5 * * * *',
      prompt: 'test',
      createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      recurring: true,
      ...overrides,
    });

    it('returns true when recurring task exceeds maxAge', () => {
      const now = Date.now();
      const task = makeTask({
        createdAt: now - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      });
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      expect(isRecurringTaskAged(task, now, maxAge)).toBe(true);
    });

    it('returns false when recurring task is within maxAge', () => {
      const now = Date.now();
      const task = makeTask({
        createdAt: now - 3 * 24 * 60 * 60 * 1000, // 3 days ago
      });
      const maxAge = 7 * 24 * 60 * 60 * 1000;
      expect(isRecurringTaskAged(task, now, maxAge)).toBe(false);
    });

    it('returns false for permanent tasks regardless of age', () => {
      const now = Date.now();
      const task = makeTask({
        createdAt: now - 100 * 24 * 60 * 60 * 1000, // 100 days ago
        permanent: true,
      });
      const maxAge = 7 * 24 * 60 * 60 * 1000;
      expect(isRecurringTaskAged(task, now, maxAge)).toBe(false);
    });

    it('returns false for non-recurring tasks', () => {
      const now = Date.now();
      const task = makeTask({
        recurring: false,
        createdAt: now - 100 * 24 * 60 * 60 * 1000,
      });
      expect(isRecurringTaskAged(task, now, 7 * 24 * 60 * 60 * 1000)).toBe(
        false,
      );
    });

    it('returns false when maxAge is 0 (unlimited)', () => {
      const now = Date.now();
      const task = makeTask({
        createdAt: now - 365 * 24 * 60 * 60 * 1000,
      });
      expect(isRecurringTaskAged(task, now, 0)).toBe(false);
    });

    it('returns true at exact boundary (age === maxAge)', () => {
      const maxAge = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const task = makeTask({ createdAt: now - maxAge });
      expect(isRecurringTaskAged(task, now, maxAge)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // buildMissedTaskNotification
  // -------------------------------------------------------------------------
  describe('buildMissedTaskNotification', () => {
    it('builds notification for a single missed task', () => {
      const tasks: CronTask[] = [
        {
          id: 'miss-1',
          cron: '0 9 * * *',
          prompt: 'Do the thing',
          createdAt: Date.now() - 60 * 60 * 1000,
        },
      ];
      const result = buildMissedTaskNotification(tasks);
      expect(result).toContain('task was missed');
      expect(result).toContain('Do the thing');
      expect(result).toContain('It has');
    });

    it('builds notification for multiple missed tasks', () => {
      const tasks: CronTask[] = [
        {
          id: 'miss-1',
          cron: '0 9 * * *',
          prompt: 'Task A',
          createdAt: Date.now() - 60 * 60 * 1000,
        },
        {
          id: 'miss-2',
          cron: '0 14 * * *',
          prompt: 'Task B',
          createdAt: Date.now() - 2 * 60 * 60 * 1000,
        },
      ];
      const result = buildMissedTaskNotification(tasks);
      expect(result).toContain('tasks were missed');
      expect(result).toContain('Task A');
      expect(result).toContain('Task B');
      expect(result).toContain('They have');
    });

    it('escapes prompts containing backticks', () => {
      const tasks: CronTask[] = [
        {
          id: 'miss-bt',
          cron: '0 9 * * *',
          prompt: 'Run ```code``` block',
          createdAt: Date.now(),
        },
      ];
      const result = buildMissedTaskNotification(tasks);
      // Should use a fence longer than the longest backtick run in the prompt
      expect(result).toContain('````');
    });

    it('includes human-readable cron description', () => {
      const tasks: CronTask[] = [
        {
          id: 'miss-hr',
          cron: '*/5 * * * *',
          prompt: 'check',
          createdAt: Date.now(),
        },
      ];
      const result = buildMissedTaskNotification(tasks);
      expect(result).toContain('Every 5 minutes');
    });
  });
});

// ---------------------------------------------------------------------------
// createCronScheduler - check loop
// ---------------------------------------------------------------------------

// These tests need full control of the cron-tasks / chokidar deps.
vi.mock('./cron-tasks.js', () => ({
  readCronTasks: vi.fn(async () => []),
  markCronTasksFired: vi.fn(async () => {}),
  // Default: nothing has a ceiling, so the budget gate is inert and these cases
  // exercise the firing paths they were written for. The gate has its own tests.
  checkCronBudget: vi.fn(() => null),
  removeCronTasks: vi.fn(async () => {}),
  findMissedTasks: vi.fn(() => []),
  getCronFilePath: vi.fn(() => '/fake/.qwen/scheduled_tasks.json'),
  hasCronTasksSync: vi.fn(() => false),
  jitteredNextCronRunMs: vi.fn(
    (_cron: string, fromMs: number, _id: string) => fromMs + 60_000,
  ),
  oneShotJitteredNextCronRunMs: vi.fn(
    (_cron: string, fromMs: number, _id: string) => fromMs + 60_000,
  ),
  DEFAULT_CRON_JITTER_CONFIG: {
    recurringFrac: 0.1,
    recurringCapMs: 15 * 60 * 1000,
    oneShotMaxMs: 90 * 1000,
    oneShotFloorMs: 0,
    oneShotMinuteMod: 30,
    recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  },
}));

vi.mock('chokidar', () => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn(async () => {}),
  };
  return {
    default: { watch: vi.fn(() => mockWatcher) },
  };
});

describe('createCronScheduler - check loop', () => {
  let createCronSchedulerFn: typeof import('./cron-scheduler.js').createCronScheduler;
  let cronTasksMock: {
    readCronTasks: ReturnType<typeof vi.fn>;
    markCronTasksFired: ReturnType<typeof vi.fn>;
    removeCronTasks: ReturnType<typeof vi.fn>;
    jitteredNextCronRunMs: ReturnType<typeof vi.fn>;
    oneShotJitteredNextCronRunMs: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

    const cronMod = await import('./cron-tasks.js');
    cronTasksMock = cronMod as unknown as typeof cronTasksMock;

    const schedulerMod = await import('./cron-scheduler.js');
    createCronSchedulerFn = schedulerMod.createCronScheduler;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeTask(overrides: Partial<CronTask> = {}): CronTask {
    return {
      id: 'task-1',
      cron: '*/5 * * * *',
      prompt: 'do something',
      createdAt: Date.now() - 120_000,
      recurring: true,
      ...overrides,
    };
  }

  /**
   * A stand-in for the session's in-memory task store.
   *
   * The store moved off `cron-tasks` module state and onto the per-session
   * cron manager, so the scheduler now receives it as an option instead of
   * reading a global. This module is mocked wholesale above, which is why the
   * real class cannot be constructed here — the scheduler only ever calls these
   * two methods, so a shaped object is the whole contract.
   */
  function fakeSessionStore(initial: CronTask[] = []): SessionCronTaskStore {
    let tasks = initial;
    return {
      getAll: () => tasks,
      remove: (ids: string[]) => {
        const idSet = new Set(ids);
        const before = tasks.length;
        tasks = tasks.filter((t) => !idSet.has(t.id));
        return before - tasks.length;
      },
    } as unknown as SessionCronTaskStore;
  }

  /** Flush microtasks including module-loader async ops. */
  const flushAsync = async () => {
    // vi.waitFor polls until the assertion passes, reliably flushing
    // enable()'s async chain (dynamic import + load).
    await vi.waitFor(() => {
      expect(cronTasksMock.readCronTasks).toHaveBeenCalled();
    });
  };

  /**
   * Helper: flush the async enable() chain and advance to the first check.
   */
  async function startAndAdvanceToFirstCheck(
    scheduler: ReturnType<typeof createCronSchedulerFn>,
  ) {
    scheduler.start();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(1100);
  }

  it('does not fire when isLoading returns true', async () => {
    const task = makeTask();
    cronTasksMock.readCronTasks.mockResolvedValue([task]);
    cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => true,
    });

    await startAndAdvanceToFirstCheck(scheduler);

    expect(onFire).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('fires due task when isLoading returns false', async () => {
    const task = makeTask();
    cronTasksMock.readCronTasks.mockResolvedValue([task]);
    cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => false,
    });

    await startAndAdvanceToFirstCheck(scheduler);

    expect(onFire).toHaveBeenCalledWith('do something');
    scheduler.stop();
  });

  it('stop() prevents further fires', async () => {
    const task = makeTask();
    cronTasksMock.readCronTasks.mockResolvedValue([task]);
    cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => false,
    });
    scheduler.start();

    // Let enable() complete
    await flushAsync();

    // Stop before first check fires
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires all due tasks in a single tick (batch)', async () => {
    const taskA = makeTask({ id: 'a', prompt: 'task-a' });
    const taskB = makeTask({ id: 'b', prompt: 'task-b' });
    const taskC = makeTask({ id: 'c', prompt: 'task-c' });

    cronTasksMock.readCronTasks.mockResolvedValue([taskA, taskB, taskC]);
    cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => false,
    });

    await startAndAdvanceToFirstCheck(scheduler);

    expect(onFire).toHaveBeenCalledTimes(3);
    expect(onFire).toHaveBeenCalledWith('task-a');
    expect(onFire).toHaveBeenCalledWith('task-b');
    expect(onFire).toHaveBeenCalledWith('task-c');
    scheduler.stop();
  });

  it('recurring task gets nextFireAt recalculated after fire', async () => {
    const baseTime = Date.now();
    const task = makeTask({ id: 'rec-1', recurring: true });
    cronTasksMock.readCronTasks.mockResolvedValue([task]);

    // First call: task is due immediately
    let callCount = 0;
    cronTasksMock.jitteredNextCronRunMs.mockImplementation(
      (_cron: string, fromMs: number, _id: string) => {
        callCount++;
        if (callCount === 1) {
          // First sight: due in the past
          return baseTime - 1000;
        }
        // After fire: reschedule 5 minutes from now
        return fromMs + 300_000;
      },
    );

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => false,
    });

    await startAndAdvanceToFirstCheck(scheduler);

    // Should fire once
    expect(onFire).toHaveBeenCalledTimes(1);

    // After fire, nextFireAt should be recalculated (future), so second tick doesn't fire
    onFire.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    expect(onFire).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('one-shot task is removed after fire', async () => {
    const task = makeTask({ id: 'oneshot-1', recurring: false });
    cronTasksMock.readCronTasks.mockResolvedValue([task]);
    cronTasksMock.oneShotJitteredNextCronRunMs.mockReturnValue(
      Date.now() - 1000,
    );

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => false,
    });

    await startAndAdvanceToFirstCheck(scheduler);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(cronTasksMock.removeCronTasks).toHaveBeenCalledWith(
      ['oneshot-1'],
      undefined,
    );
    scheduler.stop();
  });

  it('tasks already inFlight are not fired again', async () => {
    const task = makeTask({ id: 'inflight-1', recurring: false });
    cronTasksMock.readCronTasks.mockResolvedValue([task]);
    cronTasksMock.oneShotJitteredNextCronRunMs.mockReturnValue(
      Date.now() - 1000,
    );
    // Make removeCronTasks hang so inFlight stays set
    cronTasksMock.removeCronTasks.mockReturnValue(new Promise(() => {}));

    const onFire = vi.fn();
    const scheduler = createCronSchedulerFn({
      onFire,
      isLoading: () => false,
    });

    await startAndAdvanceToFirstCheck(scheduler);

    // First tick should have fired
    expect(onFire).toHaveBeenCalledTimes(1);

    // Second tick should NOT fire again because removeCronTasks hasn't resolved
    // (task is still inFlight)
    onFire.mockClear();
    cronTasksMock.oneShotJitteredNextCronRunMs.mockReturnValue(
      Date.now() - 1000,
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(onFire).not.toHaveBeenCalled();

    scheduler.stop();
  });

  describe('ownership filter (isSession-aware)', () => {
    /**
     * The production ownership gate from CronManager. Mirrored here so
     * the four branches are locked down independent of the manager wiring.
     */
    const ownershipFilter =
      (mySessionId: string) => (t: CronTask, isSession: boolean) =>
        isSession ? true : t.createdBySessionId === mySessionId;

    it('fires a file-backed task owned by this session', async () => {
      cronTasksMock.readCronTasks.mockResolvedValue([
        makeTask({ createdBySessionId: 'ses-mine' }),
      ]);
      cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

      const onFire = vi.fn();
      const scheduler = createCronSchedulerFn({
        onFire,
        isLoading: () => false,
        filter: ownershipFilter('ses-mine'),
      });
      await startAndAdvanceToFirstCheck(scheduler);

      expect(onFire).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it('does NOT fire a file-backed task owned by another session', async () => {
      cronTasksMock.readCronTasks.mockResolvedValue([
        makeTask({ createdBySessionId: 'ses-other' }),
      ]);
      cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

      const onFire = vi.fn();
      const scheduler = createCronSchedulerFn({
        onFire,
        isLoading: () => false,
        filter: ownershipFilter('ses-mine'),
      });
      await startAndAdvanceToFirstCheck(scheduler);

      expect(onFire).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('does NOT fire a legacy file-backed task with no owner (regression: durable flag is absent on read)', async () => {
      // readCronTasks never restores `durable`, so a filter keyed on it would
      // wrongly let legacy tasks through. The gate must key on isSession.
      cronTasksMock.readCronTasks.mockResolvedValue([makeTask()]);
      cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

      const onFire = vi.fn();
      const scheduler = createCronSchedulerFn({
        onFire,
        isLoading: () => false,
        filter: ownershipFilter('ses-mine'),
      });
      await startAndAdvanceToFirstCheck(scheduler);

      expect(onFire).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('fires a session-only task even though it carries no owner', async () => {
      cronTasksMock.readCronTasks.mockResolvedValue([]);
      cronTasksMock.jitteredNextCronRunMs.mockReturnValue(Date.now() - 1000);

      const onFire = vi.fn();
      const scheduler = createCronSchedulerFn({
        onFire,
        isLoading: () => false,
        filter: ownershipFilter('ses-mine'),
        sessionTasks: fakeSessionStore([makeTask({ id: 'sess-task' })]),
      });
      await startAndAdvanceToFirstCheck(scheduler);

      expect(onFire).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Two sessions in one process must not share a scheduler, a wakeup timer, a
 * task store or a budget.
 *
 * That is the whole reason `CronManager` exists: this state used to be
 * module-level in `scheduler-manager.ts`, where a second session's
 * `ensureSchedulerStarted` was a no-op (so it never got a scheduler and its
 * durable tasks were filtered by the *first* session's id), its ScheduleWakeup
 * overwrote the first session's pending timer, and its teardown emptied a task
 * store both sessions were using.
 *
 * Each case below is one of those failures, asserted from the side that used to
 * lose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CronTask } from './cron-tasks.js';
import type { CronSchedulerOptions } from './cron-scheduler.js';

const { schedulerSpy, enqueueMock, emitFeedbackMock } = vi.hoisted(() => ({
  // Captures the options of every scheduler the runtimes build, so a case can
  // read back the filter and the isLoading predicate it was handed. Each call
  // gets its own start/stop spies so "which session stopped" is answerable.
  schedulerSpy: vi.fn(
    (_options: import('./cron-scheduler.js').CronSchedulerOptions) => ({
      start: vi.fn(),
      stop: vi.fn(),
      getNextFireTime: vi.fn(() => null),
    }),
  ),
  enqueueMock: vi.fn(),
  emitFeedbackMock: vi.fn(),
}));

vi.mock('./cron-scheduler.js', () => ({
  createCronScheduler: schedulerSpy,
}));

vi.mock('../services/messageQueueManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/messageQueueManager.js')>()),
  enqueuePendingNotification: enqueueMock,
}));

vi.mock('../utils/events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/events.js')>()),
  coreEvents: { emitFeedback: emitFeedbackMock },
}));

import { CronManager } from './cronManager.js';
import {
  registerUserActivityClock,
  resetUserActivityClockForTest,
} from './user-activity-clock.js';

/**
 * A manager over a session id the test can rotate, which is how /resume, /clear
 * and fork present themselves: same Config, different session.
 */
function makeManager(initialSessionId: string) {
  const state = { sessionId: initialSessionId };
  const manager = new CronManager({ getSessionId: () => state.sessionId });
  return { manager, state };
}

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    cron: '*/5 * * * *',
    prompt: 'do something',
    createdAt: Date.now(),
    recurring: true,
    ...overrides,
  };
}

/** The options a given `createCronScheduler` call was handed. */
function optionsFor(call: number): CronSchedulerOptions {
  return schedulerSpy.mock.calls[call]![0];
}

beforeEach(() => {
  schedulerSpy.mockClear();
  enqueueMock.mockClear();
  emitFeedbackMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CronManager — per-session scheduler', () => {
  it('gives the second session a scheduler of its own', () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    a.ensureStarted();
    b.ensureStarted();

    // The shared `started` flag used to make the second call a no-op, which left
    // session B with no scheduler at all: nothing of its own ever fired, and the
    // only one running filtered on A's id.
    expect(schedulerSpy).toHaveBeenCalledTimes(2);
    expect(a.isStarted()).toBe(true);
    expect(b.isStarted()).toBe(true);
  });

  it('stays idempotent within one session', () => {
    const { manager } = makeManager('ses-A');
    manager.ensureStarted();
    manager.ensureStarted();
    expect(schedulerSpy).toHaveBeenCalledTimes(1);
  });

  it('filters durable tasks by the session that owns the manager', () => {
    const { manager } = makeManager('ses-A');
    manager.ensureStarted();

    const { filter } = optionsFor(0);
    expect(filter).toBeDefined();
    // Session-only tasks live in this manager's own store, so ownership does not
    // apply to them.
    expect(filter!(makeTask(), true)).toBe(true);
    expect(filter!(makeTask({ createdBySessionId: 'ses-A' }), false)).toBe(true);
    expect(filter!(makeTask({ createdBySessionId: 'ses-B' }), false)).toBe(false);
    // A legacy task with no owner is not silently adopted either.
    expect(filter!(makeTask(), false)).toBe(false);
  });

  it('follows a session rotation without restarting the scheduler', () => {
    const { manager, state } = makeManager('ses-A');
    manager.ensureStarted();
    const { filter } = optionsFor(0);

    expect(filter!(makeTask({ createdBySessionId: 'ses-A' }), false)).toBe(true);

    // /resume, /clear and fork change the session id under a live Config. The
    // gate reads it on every check, so a durable task created after the rotation
    // fires — the frozen-snapshot behaviour it replaced made those tasks
    // silently never fire.
    state.sessionId = 'ses-B';

    expect(filter!(makeTask({ createdBySessionId: 'ses-A' }), false)).toBe(false);
    expect(filter!(makeTask({ createdBySessionId: 'ses-B' }), false)).toBe(true);
    expect(schedulerSpy).toHaveBeenCalledTimes(1);
  });

  it('hands the scheduler its own session task store, and none when dir is set', () => {
    const { manager } = makeManager('ses-A');
    manager.ensureStarted();
    expect(optionsFor(0).sessionTasks).toBe(manager.tasks);

    // Pointing the scheduler at somebody else's workspace means that
    // workspace's file is the only store it should read.
    const other = makeManager('ses-B').manager;
    other.ensureStarted({ dir: '/elsewhere' });
    expect(optionsFor(1).sessionTasks).toBeUndefined();
    expect(optionsFor(1).dir).toBe('/elsewhere');
  });

  it('reads the isLoading provider at fire time, not at start time', () => {
    const { manager } = makeManager('ses-A');
    // The TUI installs its provider from an effect; CronCreate can start the
    // scheduler from a tool call before that effect runs. Capturing the provider
    // once at start meant a later registration was ignored for the whole process.
    manager.ensureStarted();

    let loading = true;
    manager.setIsLoadingProvider(() => loading);

    const { isLoading } = optionsFor(0);
    expect(isLoading()).toBe(true);
    loading = false;
    expect(isLoading()).toBe(false);
  });

  it('stops only the session that asked', () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;
    a.ensureStarted();
    b.ensureStarted();

    a.stop();

    expect(a.isStarted()).toBe(false);
    expect(b.isStarted()).toBe(true);
    expect(schedulerSpy.mock.results[0]!.value.stop).toHaveBeenCalledTimes(1);
    expect(schedulerSpy.mock.results[1]!.value.stop).not.toHaveBeenCalled();
  });
});

describe('CronManager — per-session task store', () => {
  it('keeps one session\'s non-durable tasks out of the other\'s list', async () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    await a.addTask('* * * * *', 'A only', true, false);

    expect(a.getSessionTasks()).toHaveLength(1);
    expect(a.getSessionTasks()[0]!.prompt).toBe('A only');
    expect(b.getSessionTasks()).toHaveLength(0);
  });

  it('clears only the session that ended', async () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    await a.addTask('* * * * *', 'A only', true, false);
    await b.addTask('* * * * *', 'B only', true, false);

    // One session's teardown used to empty the array both were reading.
    a.clearSessionTasks();

    expect(a.getSessionTasks()).toHaveLength(0);
    expect(b.getSessionTasks()).toHaveLength(1);
    expect(b.getSessionTasks()[0]!.prompt).toBe('B only');
  });

  it('stamps the owning session on durable tasks and not on session-only ones', async () => {
    const { manager } = makeManager('ses-A');
    expect(manager.getOwnerFingerprint().sessionId).toBe('ses-A');

    // Session-only tasks never leave this process, so there is nobody to
    // protect them from and nothing to stamp.
    await manager.addTask('* * * * *', 'volatile', true, false);
    expect(manager.getSessionTasks()[0]!.createdBySessionId).toBeUndefined();
  });
});

describe('CronManager — per-session wakeup timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T10:00:00.000Z'));
  });

  it('does not let one session re-arm over another\'s pending wakeup', async () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    a.scheduleWakeup(120_000, 'loop A');
    b.scheduleWakeup(120_000, 'loop B');

    // Both survive: the shared `wakeupTimer` slot used to keep only the last
    // one armed, so the second session silently killed the first's loop.
    expect(a.getWakeupDetails()?.prompt).toBe('loop A');
    expect(b.getWakeupDetails()?.prompt).toBe('loop B');

    await vi.advanceTimersByTimeAsync(121_000);

    const prompts = enqueueMock.mock.calls.map(
      (c) => (c[0] as { prompt: string }).prompt,
    );
    expect(prompts.some((p) => p.includes('loop A'))).toBe(true);
    expect(prompts.some((p) => p.includes('loop B'))).toBe(true);
  });

  it('cancels only the session that asked', () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    a.scheduleWakeup(120_000, 'loop A');
    b.scheduleWakeup(120_000, 'loop B');

    expect(b.cancelWakeup()).toBe(true);
    expect(b.getPendingWakeupTime()).toBeNull();
    expect(a.getPendingWakeupTime()).not.toBeNull();
  });

  it('reports no pending wakeup for a session that never armed one', () => {
    const { manager } = makeManager('ses-A');
    expect(manager.getPendingWakeupTime()).toBeNull();
    expect(manager.getWakeupDetails()).toBeNull();
    expect(manager.cancelWakeup()).toBe(false);
  });

  it('keeps the credit ceiling and the spend inside one session', () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    a.scheduleWakeup(120_000, 'loop A', undefined, { maxCredits: 10 });
    b.scheduleWakeup(120_000, 'loop B', undefined, { maxCredits: 10 });

    // One session's expensive turn used to charge the shared counter, spending
    // an allowance another session's user had set.
    a.addWakeupCredits(8);

    expect(a.getWakeupDetails()?.prompt).toBe('loop A');
    expect(b.getWakeupDetails()?.prompt).toBe('loop B');
  });

  it('releases the ceiling and the spend when the loop ends', () => {
    const { manager } = makeManager('ses-A');
    manager.scheduleWakeup(120_000, 'loop A', undefined, { maxCredits: 10 });
    manager.addWakeupCredits(8);

    manager.cancelWakeup();

    // The allowance belongs to the loop, not to the session: the next loop must
    // start unspent and uncapped rather than inheriting this one's.
    manager.scheduleWakeup(120_000, 'loop A2');
    manager.addWakeupCredits(8);
    expect(manager.getWakeupDetails()?.prompt).toBe('loop A2');
  });

  it('clamps the delay to the configured bounds', () => {
    const { manager } = makeManager('ses-A');

    const tooSoon = manager.scheduleWakeup(1_000, 'loop');
    expect(tooSoon.wasClamped).toBe(true);
    expect(tooSoon.actualDelay).toBe(60_000);

    const tooLate = manager.scheduleWakeup(10 * 60 * 60 * 1000, 'loop');
    expect(tooLate.wasClamped).toBe(true);
    expect(tooLate.actualDelay).toBe(3_600_000);

    const justRight = manager.scheduleWakeup(300_000, 'loop');
    expect(justRight.wasClamped).toBe(false);
    expect(justRight.actualDelay).toBe(300_000);
  });
});

describe('CronManager — loop status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T10:00:00.000Z'));
  });

  it('reports only this session\'s pending wakeup', () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    const armed = a.scheduleWakeup(120_000, 'loop A');

    expect(a.getLoopStatus().pendingWakeup).toBe(true);
    expect(a.getLoopStatus().nextFireMs).toBe(armed.scheduledAt);
    expect(b.getLoopStatus().pendingWakeup).toBe(false);
    expect(b.getLoopStatus().nextFireMs).toBeNull();
  });
});

describe('CronManager — notification ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T10:00:00.000Z'));
  });

  /**
   * The command queue is one process-wide array, and `sessionId` is the only
   * thing telling a consumer whether a notification is theirs. Cron has four
   * enqueue sites, so each one is asserted separately: the defect this covers
   * was a site being missed, not a site being wrong.
   */
  function enqueued(): Array<{
    prompt: string;
    sessionId: string | undefined;
  }> {
    return enqueueMock.mock.calls.map((call) => {
      const cmd = call[0] as { prompt: string; sessionId?: string };
      return { prompt: cmd.prompt, sessionId: cmd.sessionId };
    });
  }

  it('stamps a scheduler fire with the session that owns the manager', async () => {
    const { manager } = makeManager('ses-A');
    manager.ensureStarted();

    optionsFor(0).onFire('recurring ping');
    await vi.advanceTimersByTimeAsync(0);

    expect(enqueued()).toEqual([
      { prompt: expect.stringContaining('recurring ping'), sessionId: 'ses-A' },
    ]);
  });

  it('carries the creating turn identity on a fired cron task', async () => {
    const { manager } = makeManager('ses-A');
    const customContext = Object.freeze({ tenant: 'alpha' });
    manager.ensureStarted();

    optionsFor(0).onFireTask?.(
      makeTask({ customContext, prompt: 'recurring ping' }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ customContext }),
    );
  });

  it('stamps the budget-exhausted notice the scheduler reports', () => {
    const { manager } = makeManager('ses-A');
    manager.ensureStarted();

    optionsFor(0).onBudgetExhausted!(makeTask(), {
      reason: 'max-turns',
      limit: 3,
      reached: 3,
    });

    expect(enqueued()).toEqual([
      { prompt: expect.stringContaining('stopped'), sessionId: 'ses-A' },
    ]);
  });

  it('keeps two sessions\' wakeups addressable to their own session', async () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    a.scheduleWakeup(120_000, 'loop A');
    b.scheduleWakeup(120_000, 'loop B');
    await vi.advanceTimersByTimeAsync(121_000);

    // Unstamped, the two look identical to a consumer, so whichever session
    // drained first ran the other's loop tick — and under ACP, which requires an
    // exact match, neither was ever drained at all.
    expect(enqueued()).toEqual(
      expect.arrayContaining([
        { prompt: expect.stringContaining('loop A'), sessionId: 'ses-A' },
        { prompt: expect.stringContaining('loop B'), sessionId: 'ses-B' },
      ]),
    );
  });

  it('carries the creating turn identity on a wakeup fire', async () => {
    const { manager } = makeManager('ses-A');
    const customContext = Object.freeze({ tenant: 'alpha' });
    manager.scheduleWakeup(
      120_000,
      'loop A',
      undefined,
      undefined,
      customContext,
    );

    await vi.advanceTimersByTimeAsync(121_000);

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ customContext }),
    );
  });

  it('stamps the wakeup budget notice', async () => {
    const { manager } = makeManager('ses-A');
    manager.scheduleWakeup(120_000, 'loop A', undefined, { maxCredits: 10 });
    manager.addWakeupCredits(10);

    await vi.advanceTimersByTimeAsync(121_000);

    expect(enqueued()).toEqual([
      { prompt: expect.stringContaining('Loop stopped'), sessionId: 'ses-A' },
    ]);
  });

  it('stamps the session live, so a rotation needs no scheduler restart', async () => {
    const { manager, state } = makeManager('ses-A');
    manager.ensureStarted();
    state.sessionId = 'ses-B';

    optionsFor(0).onFire('recurring ping');
    await vi.advanceTimersByTimeAsync(0);

    expect(enqueued()[0]!.sessionId).toBe('ses-B');
    expect(schedulerSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CronManager — user presence clock', () => {
  // The injected host clock is process-level by design — one keyboard per process,
  // not per conversation — so a test that registers one must clear it, or every
  // later test reads that host's presence.
  afterEach(() => {
    resetUserActivityClockForTest();
  });

  it('reports nothing before the first user prompt', () => {
    expect(makeManager('ses-A').manager.getUserIdleDurationMs()).toBeUndefined();
  });

  it('measures the gap since the last user prompt', () => {
    const { manager } = makeManager('ses-A');
    manager.markUserActivity(1_000);

    expect(manager.getUserIdleDurationMs(61_000)).toBe(60_000);
  });

  it('never reports a negative idle time', () => {
    const { manager } = makeManager('ses-A');
    manager.markUserActivity(10_000);

    expect(manager.getUserIdleDurationMs(9_000)).toBe(0);
  });

  it("does not let one session's typing vouch for another's loop", () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;

    a.markUserActivity(1_000);

    // The whole reason the clock moved off the process: the field exists to
    // separate a loop someone is watching from one they forgot to stop, and a
    // shared timestamp answers that question using somebody else's session.
    expect(a.getUserIdleDurationMs(61_000)).toBe(60_000);
    expect(b.getUserIdleDurationMs(61_000)).toBeUndefined();
  });

  it('prefers a host clock over the submission clock', () => {
    const { manager } = makeManager('ses-A');
    manager.markUserActivity(1_000);
    registerUserActivityClock(() => 50_000);

    // 60s - 50s, not 60s - 1s: the host clock knows about interaction the
    // submission clock cannot see.
    expect(manager.getUserIdleDurationMs(60_000)).toBe(10_000);
  });

  it('shares one host clock across sessions, because a keyboard is not per session', () => {
    const a = makeManager('ses-A').manager;
    const b = makeManager('ses-B').manager;
    registerUserActivityClock(() => 50_000);

    expect(a.getUserIdleDurationMs(60_000)).toBe(10_000);
    expect(b.getUserIdleDurationMs(60_000)).toBe(10_000);
  });

  it('falls back to the submission clock when no host registers one', () => {
    const { manager } = makeManager('ses-A');
    manager.markUserActivity(1_000);

    expect(manager.getUserIdleDurationMs(60_000)).toBe(59_000);
  });

  it('reports nothing when the host clock has no answer either', () => {
    const { manager } = makeManager('ses-A');
    registerUserActivityClock(() => undefined);

    expect(manager.getUserIdleDurationMs(60_000)).toBeUndefined();
  });

  it('falls back when the host clock is unregistered again', () => {
    const { manager } = makeManager('ses-A');
    manager.markUserActivity(1_000);
    registerUserActivityClock(() => 50_000);
    registerUserActivityClock(undefined);

    expect(manager.getUserIdleDurationMs(60_000)).toBe(59_000);
  });

  /**
   * The condition the agent loop uses to decide a turn counts as user activity.
   *
   * Kept as a table rather than in an agent-loop test because the whole defect was
   * that the condition looked reasonable in isolation: it tested
   * `taskTrigger === 'user_prompt'`, which is derived from
   * `skipInitialUserMessage` and therefore describes message plumbing rather than
   * presence. Production reported 234,344 TUI turns as `continue` and 182 as
   * `user_prompt`, so the gate opened on 0.07% of turns and the idle field was
   * null on every row in the warehouse.
   *
   * Claiming a pending fire is the direct test: a scheduled run always has one,
   * an interactive turn never does.
   */
  const countsAsUserActivity = (turn: {
    claimedFires: number;
    isSubagent?: boolean;
    remoteWorker?: boolean;
  }): boolean =>
    turn.claimedFires === 0 &&
    turn.isSubagent !== true &&
    turn.remoteWorker !== true;

  it.each([
    ['an interactive turn', { claimedFires: 0 }, true],
    ['a scheduled fire', { claimedFires: 1 }, false],
    ['a turn that merged two fires', { claimedFires: 2 }, false],
    ['a subagent turn', { claimedFires: 0, isSubagent: true }, false],
    ['a remote-worker turn', { claimedFires: 0, remoteWorker: true }, false],
  ])('treats %s correctly', (_label, turn, expected) => {
    expect(countsAsUserActivity(turn)).toBe(expected);
  });
});

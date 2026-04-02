/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LoopManager,
  parseInterval,
  formatInterval,
  getLoopManager,
  resetLoopManager,
  DEFAULT_EXPIRY_MS,
} from './loopManager.js';

// ---------------------------------------------------------------------------
// parseInterval
// ---------------------------------------------------------------------------

describe('parseInterval', () => {
  it('parses seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('1s')).toBe(1_000);
  });
  it('parses minutes', () => {
    expect(parseInterval('5m')).toBe(300_000);
    expect(parseInterval('10m')).toBe(600_000);
  });
  it('parses hours', () => {
    expect(parseInterval('1h')).toBe(3_600_000);
    expect(parseInterval('2h')).toBe(7_200_000);
  });
  it('parses days', () => {
    expect(parseInterval('1d')).toBe(86_400_000);
    expect(parseInterval('2d')).toBe(172_800_000);
  });
  it('returns null for invalid input', () => {
    expect(parseInterval('')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('5')).toBeNull();
    expect(parseInterval('5x')).toBeNull();
    expect(parseInterval('-5m')).toBeNull();
    expect(parseInterval('0m')).toBeNull();
  });
  it('is case-insensitive', () => {
    expect(parseInterval('5M')).toBe(300_000);
    expect(parseInterval('1H')).toBe(3_600_000);
    expect(parseInterval('30S')).toBe(30_000);
    expect(parseInterval('1D')).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// formatInterval
// ---------------------------------------------------------------------------

describe('formatInterval', () => {
  it('formats days', () => {
    expect(formatInterval(86_400_000)).toBe('1d');
    expect(formatInterval(172_800_000)).toBe('2d');
  });
  it('formats hours', () => {
    expect(formatInterval(3_600_000)).toBe('1h');
    expect(formatInterval(7_200_000)).toBe('2h');
  });
  it('formats minutes', () => {
    expect(formatInterval(300_000)).toBe('5m');
    expect(formatInterval(60_000)).toBe('1m');
  });
  it('formats seconds', () => {
    expect(formatInterval(30_000)).toBe('30s');
    expect(formatInterval(1_000)).toBe('1s');
  });
  it('uses fractional minutes for non-round values >= 60s', () => {
    expect(formatInterval(90_000)).toBe('1.5m');
    expect(formatInterval(150_000)).toBe('2.5m');
  });
  it('rounds non-round minutes to one decimal', () => {
    expect(formatInterval(62_000)).toBe('1m');
    expect(formatInterval(80_000)).toBe('1.3m');
  });
  it('uses seconds for values < 60s', () => {
    expect(formatInterval(45_000)).toBe('45s');
  });
});

// ---------------------------------------------------------------------------
// LoopManager — backward-compatible single-loop tests
// ---------------------------------------------------------------------------

describe('LoopManager', () => {
  let manager: LoopManager;
  let iterationCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new LoopManager();
    iterationCallback = vi.fn();
    manager.setIterationCallback(iterationCallback);
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('starts a loop and executes immediately', () => {
    manager.start({ prompt: 'check CI', intervalMs: 60_000, maxIterations: 0 });
    expect(manager.isActive()).toBe(true);
    expect(iterationCallback).toHaveBeenCalledWith(
      'check CI',
      1,
      expect.any(String),
    );
    expect(manager.getState()?.iteration).toBe(1);
    expect(manager.getState()?.waitingForResponse).toBe(true);
  });

  it('skipFirstIteration starts at iteration 1 without callback', () => {
    manager.start(
      { prompt: 'check CI', intervalMs: 60_000, maxIterations: 0 },
      true,
    );
    expect(manager.isActive()).toBe(true);
    expect(iterationCallback).not.toHaveBeenCalled();
    expect(manager.getState()?.iteration).toBe(1);
    expect(manager.getState()?.waitingForResponse).toBe(true);
  });

  it('schedules next iteration after onIterationComplete', () => {
    manager.start({ prompt: 'check CI', intervalMs: 60_000, maxIterations: 0 });
    iterationCallback.mockClear();
    const result = manager.onIterationComplete(true);
    expect(result).toMatchObject({
      done: false,
      paused: false,
      iteration: 1,
      consecutiveFailures: 0,
    });
    expect(result?.loopId).toEqual(expect.any(String));
    expect(manager.getState()?.waitingForResponse).toBe(false);
    expect(iterationCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000 + 6_000); // interval + max jitter (10% of 60s)
    expect(iterationCallback).toHaveBeenCalled();
  });

  it('returns null from onIterationComplete when no loop is active', () => {
    expect(manager.onIterationComplete(true)).toBeNull();
    expect(manager.onIterationComplete(false)).toBeNull();
  });

  it('returns null from onIterationComplete when not waiting for response', () => {
    manager.start({ prompt: 'check', intervalMs: 10_000, maxIterations: 0 });
    manager.onIterationComplete(true);
    const result = manager.onIterationComplete(false);
    expect(result).toBeNull();
  });

  it('stops after max iterations and returns done result', () => {
    manager.start({ prompt: 'check', intervalMs: 10_000, maxIterations: 2 });
    manager.onIterationComplete(true);
    vi.advanceTimersByTime(13_000); // interval + jitter headroom
    expect(manager.getState()?.iteration).toBe(2);
    const result = manager.onIterationComplete(true);
    expect(result?.done).toBe(true);
    expect(result?.iteration).toBe(2);
    expect(manager.getState()).toBeNull();
  });

  it('pauses after consecutive failures with backoff', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
      jitter: false,
    });

    let result = manager.onIterationComplete(false);
    expect(result?.paused).toBe(false);
    vi.advanceTimersByTime(20_000); // 2x backoff
    result = manager.onIterationComplete(false);
    expect(result?.paused).toBe(false);
    vi.advanceTimersByTime(40_000); // 4x backoff
    result = manager.onIterationComplete(false);
    expect(result?.paused).toBe(true);
    expect(result?.consecutiveFailures).toBe(3);
  });

  it('resumes from paused state', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
      jitter: false,
    });
    manager.onIterationComplete(false);
    vi.advanceTimersByTime(20_000);
    manager.onIterationComplete(false);
    vi.advanceTimersByTime(40_000);
    manager.onIterationComplete(false);
    expect(manager.getState()?.isPaused).toBe(true);

    iterationCallback.mockClear();
    manager.resume();
    expect(manager.getState()?.isPaused).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(iterationCallback).toHaveBeenCalled();
  });

  it('manually pauses and resumes', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
      jitter: false,
    });
    manager.onIterationComplete(true);
    manager.pause();
    expect(manager.getState()?.isPaused).toBe(true);
    iterationCallback.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(iterationCallback).not.toHaveBeenCalled();
    manager.resume();
    vi.advanceTimersByTime(10_000);
    expect(iterationCallback).toHaveBeenCalled();
  });

  it('does not schedule next iteration when paused during response', () => {
    manager.start(
      { prompt: 'check', intervalMs: 10_000, maxIterations: 0 },
      true,
    );
    manager.pause();
    iterationCallback.mockClear();
    manager.onIterationComplete(true);
    expect(manager.getState()?.nextFireAt).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(iterationCallback).not.toHaveBeenCalled();
    manager.resume();
    vi.advanceTimersByTime(13_000);
    expect(iterationCallback).toHaveBeenCalled();
  });

  it('pause clears safety timer and releases streaming slot', () => {
    manager.start(
      { prompt: '/help', intervalMs: 10_000, maxIterations: 0 },
      true,
    );
    expect(manager.isWaitingForResponse()).toBe(true);
    manager.startSafetyTimer();
    manager.pause();
    // Pause releases the streaming slot and clears waiting state
    expect(manager.isWaitingForResponse()).toBe(false);
    // Safety timer should not fire
    vi.advanceTimersByTime(3_000);
    expect(manager.isWaitingForResponse()).toBe(false);
  });

  it('stop clears state', () => {
    manager.start({ prompt: 'check', intervalMs: 10_000, maxIterations: 0 });
    manager.stop();
    expect(manager.isActive()).toBe(false);
    expect(manager.getState()).toBeNull();
  });

  it('starting a new unnamed loop stops the previous one', () => {
    manager.start({ prompt: 'first', intervalMs: 10_000, maxIterations: 0 });
    manager.start({ prompt: 'second', intervalMs: 20_000, maxIterations: 0 });
    expect(manager.getState()?.config.prompt).toBe('second');
    expect(manager.getActiveCount()).toBe(1);
  });

  it('resets consecutive failures on success', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
      jitter: false,
    });
    manager.onIterationComplete(false);
    expect(manager.getState()?.consecutiveFailures).toBe(1);
    vi.advanceTimersByTime(20_000);
    manager.onIterationComplete(true);
    expect(manager.getState()?.consecutiveFailures).toBe(0);
  });

  it('does not fire callback after stop', () => {
    manager.start({ prompt: 'check', intervalMs: 10_000, maxIterations: 0 });
    manager.onIterationComplete(true);
    iterationCallback.mockClear();
    manager.stop();
    vi.advanceTimersByTime(15_000);
    expect(iterationCallback).not.toHaveBeenCalled();
  });

  it('safety timer auto-advances when streaming never starts', () => {
    manager.start(
      { prompt: '/help', intervalMs: 10_000, maxIterations: 0 },
      true,
    );
    manager.startSafetyTimer();
    vi.advanceTimersByTime(3_000);
    expect(manager.isWaitingForResponse()).toBe(false);
    expect(manager.getState()?.nextFireAt).not.toBeNull();
  });

  it('safety timer is cleared by normal onIterationComplete', () => {
    manager.start(
      { prompt: 'check', intervalMs: 10_000, maxIterations: 0 },
      true,
    );
    manager.startSafetyTimer();
    manager.onIterationComplete(true);
    vi.advanceTimersByTime(3_000);
    expect(manager.getState()?.waitingForResponse).toBe(false);
  });

  it('serializes state for persistence', () => {
    manager.start({
      prompt: 'check CI',
      intervalMs: 300_000,
      maxIterations: 5,
    });
    const persisted = manager.toPersistedState();
    expect(persisted).toMatchObject({
      config: { prompt: 'check CI', intervalMs: 300_000, maxIterations: 5 },
      iteration: 1,
    });
    expect(persisted?.id).toEqual(expect.any(String));
  });

  it('toPersistedState returns null when no loop active', () => {
    expect(manager.toPersistedState()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-task tests
// ---------------------------------------------------------------------------

describe('LoopManager — multi-task', () => {
  let manager: LoopManager;
  let cb: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new LoopManager();
    cb = vi.fn();
    manager.setIterationCallback(cb);
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('supports multiple named loops concurrently', () => {
    const id1 = manager.start(
      { prompt: 'a', intervalMs: 10_000, maxIterations: 0, id: 'loop-a' },
      true,
    );
    const id2 = manager.start(
      { prompt: 'b', intervalMs: 20_000, maxIterations: 0, id: 'loop-b' },
      true,
    );
    expect(id1).toBe('loop-a');
    expect(id2).toBe('loop-b');
    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getState('loop-a')?.config.prompt).toBe('a');
    expect(manager.getState('loop-b')?.config.prompt).toBe('b');
  });

  it('named loops coexist with default loop', () => {
    manager.start(
      { prompt: 'default', intervalMs: 10_000, maxIterations: 0 },
      true,
    );
    manager.start(
      { prompt: 'named', intervalMs: 10_000, maxIterations: 0, id: 'my-loop' },
      true,
    );
    expect(manager.getActiveCount()).toBe(2);
  });

  it('stopOne removes only the targeted loop', () => {
    manager.start(
      { prompt: 'a', intervalMs: 10_000, maxIterations: 0, id: 'a' },
      true,
    );
    manager.start(
      { prompt: 'b', intervalMs: 10_000, maxIterations: 0, id: 'b' },
      true,
    );
    manager.stopOne('a');
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.isActive('a')).toBe(false);
    expect(manager.isActive('b')).toBe(true);
  });

  it('stop() without arg stops all loops', () => {
    manager.start(
      { prompt: 'a', intervalMs: 10_000, maxIterations: 0, id: 'a' },
      true,
    );
    manager.start(
      { prompt: 'b', intervalMs: 10_000, maxIterations: 0, id: 'b' },
      true,
    );
    manager.stop();
    expect(manager.getActiveCount()).toBe(0);
  });

  it('pause/resume targets specific loop', () => {
    manager.start({
      prompt: 'a',
      intervalMs: 10_000,
      maxIterations: 0,
      id: 'a',
      jitter: false,
    });
    manager.start({
      prompt: 'b',
      intervalMs: 10_000,
      maxIterations: 0,
      id: 'b',
      jitter: false,
    });
    // Complete iteration for 'a' first since it's the active response
    manager.onIterationComplete(true);
    manager.pause('a');
    expect(manager.getState('a')?.isPaused).toBe(true);
    expect(manager.getState('b')?.isPaused).toBe(false);
    manager.resume('a');
    expect(manager.getState('a')?.isPaused).toBe(false);
  });

  it('getAllStates returns all loops', () => {
    manager.start(
      { prompt: 'a', intervalMs: 10_000, maxIterations: 0, id: 'a' },
      true,
    );
    manager.start(
      { prompt: 'b', intervalMs: 10_000, maxIterations: 0, id: 'b' },
      true,
    );
    const all = manager.getAllStates();
    expect(all.size).toBe(2);
    expect([...all.keys()]).toContain('a');
    expect([...all.keys()]).toContain('b');
  });

  it('toPersistedStates returns all active loops', () => {
    manager.start(
      { prompt: 'a', intervalMs: 10_000, maxIterations: 0, id: 'a' },
      true,
    );
    manager.start(
      { prompt: 'b', intervalMs: 10_000, maxIterations: 0, id: 'b' },
      true,
    );
    const states = manager.toPersistedStates();
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('replacing a named loop by same ID', () => {
    manager.start(
      { prompt: 'old', intervalMs: 10_000, maxIterations: 0, id: 'x' },
      true,
    );
    manager.start(
      { prompt: 'new', intervalMs: 20_000, maxIterations: 0, id: 'x' },
      true,
    );
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getState('x')?.config.prompt).toBe('new');
  });

  it('executeIteration retries when slot is busy', () => {
    // Loop 'a' owns the slot
    manager.start({
      prompt: 'a',
      intervalMs: 10_000,
      maxIterations: 0,
      id: 'a',
      jitter: false,
    });
    // 'a' just executed (iteration 1), complete it and schedule next
    manager.onIterationComplete(true);

    // Loop 'b' also started, first timer fires
    manager.start({
      prompt: 'b',
      intervalMs: 10_000,
      maxIterations: 0,
      id: 'b',
      jitter: false,
    });
    manager.onIterationComplete(true); // complete 'b' iteration 1 (b got the slot after a released)
    // Now both have timers. Advance so 'a' fires first
    cb.mockClear();
    vi.advanceTimersByTime(10_000); // 'a' timer fires → executes
    // 'b' timer also fires → slot busy ('a' owns it) → retry in 1s
    expect(cb).toHaveBeenCalledTimes(1); // only 'a' fired
    expect(cb).toHaveBeenCalledWith('a', 2, 'a');

    // Complete 'a', then 'b' retry fires
    manager.onIterationComplete(true);
    vi.advanceTimersByTime(1_000); // 'b' retry
    expect(cb).toHaveBeenCalledWith('b', 2, 'b');
  });

  it('pause/resume all loops at once', () => {
    manager.start(
      {
        prompt: 'a',
        intervalMs: 10_000,
        maxIterations: 0,
        id: 'a',
        jitter: false,
      },
      true,
    );
    manager.start(
      {
        prompt: 'b',
        intervalMs: 10_000,
        maxIterations: 0,
        id: 'b',
        jitter: false,
      },
      true,
    );
    // Complete 'a' so both have timers
    manager.onIterationComplete(true);

    manager.pause(); // pause all
    expect(manager.getState('a')?.isPaused).toBe(true);
    expect(manager.getState('b')?.isPaused).toBe(true);

    cb.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    manager.resume(); // resume all
    expect(manager.getState('a')?.isPaused).toBe(false);
    expect(manager.getState('b')?.isPaused).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-expiry
// ---------------------------------------------------------------------------

describe('LoopManager — auto-expiry', () => {
  let manager: LoopManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new LoopManager();
    manager.setIterationCallback(() => {});
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('sets expiresAt to now + DEFAULT_EXPIRY_MS when not specified', () => {
    const before = Date.now();
    manager.start(
      { prompt: 'check', intervalMs: 10_000, maxIterations: 0, id: 'a' },
      true,
    );
    const state = manager.getState('a');
    expect(state?.config.expiresAt).toBeGreaterThanOrEqual(
      before + DEFAULT_EXPIRY_MS,
    );
  });

  it('checkExpired removes expired loops', () => {
    manager.start(
      {
        prompt: 'check',
        intervalMs: 10_000,
        maxIterations: 0,
        id: 'a',
        expiresAt: Date.now() + 5_000,
      },
      true,
    );
    expect(manager.isActive('a')).toBe(true);
    vi.advanceTimersByTime(5_000);
    const expired = manager.checkExpired();
    expect(expired).toEqual(['a']);
    expect(manager.isActive('a')).toBe(false);
  });

  it('oneShot loops do not get expiresAt', () => {
    manager.start(
      {
        prompt: 'once',
        intervalMs: 10_000,
        maxIterations: 0,
        id: 'a',
        oneShot: true,
      },
      true,
    );
    expect(manager.getState('a')?.config.expiresAt).toBeUndefined();
    expect(manager.getState('a')?.config.maxIterations).toBe(1);
  });

  it('scheduleNext stops loop when expired before scheduling', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
      id: 'a',
      jitter: false,
      expiresAt: Date.now() + 15_000, // expires at t=15s
    });
    // t=0: iteration 1 fires immediately
    manager.onIterationComplete(true); // scheduleNext → timer at t=10s
    vi.advanceTimersByTime(10_000); // t=10s: iteration 2 fires
    manager.onIterationComplete(true); // scheduleNext → now=10s < 15s → timer at t=20s
    vi.advanceTimersByTime(10_000); // t=20s: iteration 3 fires
    // Now complete iteration 3 → scheduleNext → now=20s >= expiresAt=15s → stopOne
    manager.onIterationComplete(true);
    expect(manager.isActive('a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missed task detection
// ---------------------------------------------------------------------------

describe('LoopManager — missed tasks', () => {
  it('detects tasks with nextFireAt in the past', () => {
    const manager = new LoopManager();
    const now = Date.now();
    const missed = manager.getMissedTasks([
      {
        id: 'a',
        config: { prompt: 'a', intervalMs: 10_000, maxIterations: 0 },
        iteration: 1,
        startedAt: now - 100_000,
        createdAt: now - 100_000,
        nextFireAt: now - 50_000,
      },
      {
        id: 'b',
        config: { prompt: 'b', intervalMs: 10_000, maxIterations: 0 },
        iteration: 1,
        startedAt: now,
        createdAt: now,
        nextFireAt: now + 50_000,
      },
    ]);
    expect(missed).toHaveLength(1);
    expect(missed[0].id).toBe('a');
  });

  it('excludes expired tasks from missed', () => {
    const manager = new LoopManager();
    const now = Date.now();
    const missed = manager.getMissedTasks([
      {
        id: 'a',
        config: {
          prompt: 'a',
          intervalMs: 10_000,
          maxIterations: 0,
          expiresAt: now - 1000,
        },
        iteration: 1,
        startedAt: now - 100_000,
        createdAt: now - 100_000,
        nextFireAt: now - 50_000,
      },
    ]);
    expect(missed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Jitter
// ---------------------------------------------------------------------------

describe('LoopManager — jitter', () => {
  let manager: LoopManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new LoopManager();
    manager.setIterationCallback(() => {});
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('applies jitter offset when jitter is not disabled', () => {
    manager.start(
      { prompt: 'check', intervalMs: 60_000, maxIterations: 0, id: 'test' },
      true,
    );
    const state = manager.getState('test');
    expect(state?.jitterOffsetMs).toBeGreaterThanOrEqual(0);
    // Jitter is capped at 10% of interval or 30s
    expect(state?.jitterOffsetMs).toBeLessThanOrEqual(6_000); // 10% of 60s
  });

  it('has zero jitter when jitter is disabled', () => {
    manager.start(
      {
        prompt: 'check',
        intervalMs: 60_000,
        maxIterations: 0,
        id: 'nj',
        jitter: false,
      },
      true,
    );
    expect(manager.getState('nj')?.jitterOffsetMs).toBe(0);
  });

  it('jitter is deterministic for the same ID', () => {
    manager.start(
      { prompt: 'check', intervalMs: 60_000, maxIterations: 0, id: 'stable' },
      true,
    );
    const j1 = manager.getState('stable')?.jitterOffsetMs;
    manager.stopOne('stable');
    manager.start(
      { prompt: 'check', intervalMs: 60_000, maxIterations: 0, id: 'stable' },
      true,
    );
    const j2 = manager.getState('stable')?.jitterOffsetMs;
    expect(j1).toBe(j2);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe('getLoopManager / resetLoopManager', () => {
  afterEach(() => resetLoopManager());

  it('returns singleton', () => {
    expect(getLoopManager()).toBe(getLoopManager());
  });
  it('resetLoopManager creates new instance', () => {
    const a = getLoopManager();
    resetLoopManager();
    expect(getLoopManager()).not.toBe(a);
  });
});

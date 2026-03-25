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
} from './loopManager.js';

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
    expect(formatInterval(62_000)).toBe('62s'); // not exactly divisible by 60s, fall back
    expect(formatInterval(80_000)).toBe('1.3m'); // 1.333... rounds to 1.3
  });

  it('uses seconds for values < 60s', () => {
    expect(formatInterval(45_000)).toBe('45s');
  });
});

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
    manager.start({
      prompt: 'check CI',
      intervalMs: 60_000,
      maxIterations: 0,
    });

    expect(manager.isActive()).toBe(true);
    expect(iterationCallback).toHaveBeenCalledWith('check CI', 1);
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
    manager.start({
      prompt: 'check CI',
      intervalMs: 60_000,
      maxIterations: 0,
    });

    iterationCallback.mockClear();
    manager.onIterationComplete(true);
    expect(manager.getState()?.waitingForResponse).toBe(false);

    // Not yet — need to wait for interval
    expect(iterationCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(iterationCallback).toHaveBeenCalledWith('check CI', 2);
    expect(manager.getState()?.waitingForResponse).toBe(true);
  });

  it('ignores onIterationComplete when no loop is active', () => {
    // Should not throw
    expect(() => manager.onIterationComplete(true)).not.toThrow();
    expect(() => manager.onIterationComplete(false)).not.toThrow();
  });

  it('ignores onIterationComplete when not waiting for response', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    manager.onIterationComplete(true);
    // Second call should be ignored — not waiting anymore
    manager.onIterationComplete(false);
    expect(manager.getState()?.consecutiveFailures).toBe(0);
  });

  it('stops after max iterations', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 2,
    });

    // First iteration already ran
    manager.onIterationComplete(true);
    vi.advanceTimersByTime(10_000);
    // Second iteration ran
    expect(manager.getState()?.iteration).toBe(2);

    manager.onIterationComplete(true);
    // Should be inactive now
    expect(manager.getState()?.isActive).toBe(false);
  });

  it('pauses after consecutive failures', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    // First iteration: fail
    manager.onIterationComplete(false);
    expect(manager.getState()?.isPaused).toBe(false);

    // Second iteration: fail
    vi.advanceTimersByTime(10_000);
    manager.onIterationComplete(false);
    expect(manager.getState()?.isPaused).toBe(false);

    // Third iteration: fail → pause
    vi.advanceTimersByTime(10_000);
    manager.onIterationComplete(false);
    expect(manager.getState()?.isPaused).toBe(true);
  });

  it('resumes from paused state', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    // Fail 3 times to pause
    manager.onIterationComplete(false);
    vi.advanceTimersByTime(10_000);
    manager.onIterationComplete(false);
    vi.advanceTimersByTime(10_000);
    manager.onIterationComplete(false);
    expect(manager.getState()?.isPaused).toBe(true);

    iterationCallback.mockClear();
    manager.resume();
    expect(manager.getState()?.isPaused).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(iterationCallback).toHaveBeenCalled();
  });

  it('resets consecutive failures on success', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    // Fail once
    manager.onIterationComplete(false);
    expect(manager.getState()?.consecutiveFailures).toBe(1);

    // Next iteration succeeds
    vi.advanceTimersByTime(10_000);
    manager.onIterationComplete(true);
    expect(manager.getState()?.consecutiveFailures).toBe(0);
  });

  it('stop clears state', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    manager.stop();
    expect(manager.isActive()).toBe(false);
    expect(manager.getState()).toBeNull();
  });

  it('starting a new loop stops the previous one', () => {
    manager.start({
      prompt: 'first',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    manager.start({
      prompt: 'second',
      intervalMs: 20_000,
      maxIterations: 0,
    });

    expect(manager.getState()?.config.prompt).toBe('second');
    expect(iterationCallback).toHaveBeenLastCalledWith('second', 1);
  });

  it('throws when starting without iteration callback', () => {
    const mgr = new LoopManager();
    expect(() =>
      mgr.start({ prompt: 'test', intervalMs: 60_000, maxIterations: 0 }),
    ).toThrow('no iteration callback');
  });

  it('throws for invalid intervalMs', () => {
    expect(() =>
      manager.start({ prompt: 'test', intervalMs: 0, maxIterations: 0 }),
    ).toThrow('intervalMs');
    expect(() =>
      manager.start({ prompt: 'test', intervalMs: Infinity, maxIterations: 0 }),
    ).toThrow('intervalMs');
  });

  it('throws for invalid maxIterations', () => {
    expect(() =>
      manager.start({ prompt: 'test', intervalMs: 60_000, maxIterations: -1 }),
    ).toThrow('maxIterations');
    expect(() =>
      manager.start({
        prompt: 'test',
        intervalMs: 60_000,
        maxIterations: 1.5,
      }),
    ).toThrow('maxIterations');
  });

  it('does not fire callback after stop', () => {
    manager.start({
      prompt: 'check',
      intervalMs: 10_000,
      maxIterations: 0,
    });

    manager.onIterationComplete(true);
    iterationCallback.mockClear();

    manager.stop();
    vi.advanceTimersByTime(10_000);
    expect(iterationCallback).not.toHaveBeenCalled();
  });
});

describe('getLoopManager / resetLoopManager', () => {
  afterEach(() => {
    resetLoopManager();
  });

  it('returns singleton', () => {
    const a = getLoopManager();
    const b = getLoopManager();
    expect(a).toBe(b);
  });

  it('resetLoopManager creates new instance', () => {
    const a = getLoopManager();
    resetLoopManager();
    const b = getLoopManager();
    expect(a).not.toBe(b);
  });
});

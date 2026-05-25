/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RunBudgetEnforcer,
  parseDurationSeconds,
  validateMaxWallTimeSetting,
} from './runBudget.js';

describe('parseDurationSeconds', () => {
  it.each([
    ['90', 90],
    ['90s', 90],
    ['30S', 30],
    ['  45  ', 45],
    ['5m', 300],
    ['1h', 3600],
    ['500ms', 0.5],
    ['1.5h', 5400],
  ])('parses %s as %d seconds', (input, expected) => {
    expect(parseDurationSeconds(input)).toBeCloseTo(expected);
  });

  it.each(['', 'abc', '10x', '-5', '5 m s', 'NaN', '0', '0s', '0ms'])(
    'rejects invalid / non-positive input %s',
    (input) => {
      expect(() => parseDurationSeconds(input)).toThrow();
    },
  );

  it('rejects values larger than Node.js can safely time out on', () => {
    // 100 days in seconds is well above MAX_TIMEOUT_MS / 1000 (~24.8d).
    expect(() => parseDurationSeconds('100d')).toThrow();
    expect(() => parseDurationSeconds('2400h')).toThrow();
  });
});

describe('validateMaxWallTimeSetting', () => {
  it('accepts -1 (unlimited sentinel)', () => {
    expect(validateMaxWallTimeSetting(-1)).toBe(-1);
  });

  it('accepts positive numbers', () => {
    expect(validateMaxWallTimeSetting(60)).toBe(60);
    expect(validateMaxWallTimeSetting(0.5)).toBeCloseTo(0.5);
  });

  it('rejects 0 (mirrors CLI flag behavior — 0 is a foot-gun)', () => {
    expect(() => validateMaxWallTimeSetting(0)).toThrow();
  });

  it('rejects negatives other than -1', () => {
    expect(() => validateMaxWallTimeSetting(-2)).toThrow();
  });

  it('rejects Infinity and NaN', () => {
    expect(() =>
      validateMaxWallTimeSetting(Number.POSITIVE_INFINITY),
    ).toThrow();
    expect(() => validateMaxWallTimeSetting(Number.NaN)).toThrow();
  });

  it('rejects values larger than the Node.js timeout ceiling', () => {
    expect(() => validateMaxWallTimeSetting(3_000_000)).toThrow();
  });
});

describe('RunBudgetEnforcer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to maxToolCalls calls, aborts on the (N+1)th', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxToolCalls: 1 }, ac);
    enforcer.tickToolCall();
    expect(ac.signal.aborted).toBe(false);
    enforcer.tickToolCall();
    expect(ac.signal.aborted).toBe(true);
    const exceeded = enforcer.getExceeded();
    expect(exceeded?.kind).toBe('tool-calls');
    expect(exceeded?.limit).toBe(1);
    expect(exceeded?.observed).toBe(2);
  });

  it('treats maxToolCalls=0 as "no tool calls allowed"', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxToolCalls: 0 }, ac);
    enforcer.tickToolCall();
    expect(ac.signal.aborted).toBe(true);
    expect(enforcer.getExceeded()?.kind).toBe('tool-calls');
  });

  it('does not enforce when budget is -1 (unlimited)', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxToolCalls: -1 }, ac);
    for (let i = 0; i < 50; i++) enforcer.tickToolCall();
    expect(ac.signal.aborted).toBe(false);
    expect(enforcer.getExceeded()).toBeNull();
  });

  it('fires wall-clock abort after maxWallTimeSeconds', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxWallTimeSeconds: 5 }, ac);
    enforcer.start();
    vi.advanceTimersByTime(4999);
    expect(ac.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2);
    expect(ac.signal.aborted).toBe(true);
    expect(enforcer.getExceeded()?.kind).toBe('wall-time');
  });

  it('stop() cancels a pending wall-clock timer', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxWallTimeSeconds: 1 }, ac);
    enforcer.start();
    enforcer.stop();
    vi.advanceTimersByTime(10_000);
    expect(ac.signal.aborted).toBe(false);
    expect(enforcer.getExceeded()).toBeNull();
  });

  it('first-fence-wins: a later overrun does not clobber the original reason', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer(
      { maxToolCalls: 0, maxWallTimeSeconds: 1 },
      ac,
    );
    enforcer.start();
    enforcer.tickToolCall();
    vi.advanceTimersByTime(2000);
    expect(enforcer.getExceeded()?.kind).toBe('tool-calls');
  });

  it('does not record a budget reason when the controller was already aborted by a third party (SIGINT race)', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxToolCalls: 0 }, ac);
    // Simulate SIGINT landing first: the shared abortController already
    // fired before any budget tick. The enforcer must not retroactively
    // claim the abort as a budget overrun.
    ac.abort();
    enforcer.tickToolCall();
    expect(enforcer.getExceeded()).toBeNull();
  });

  it('start() is idempotent — only one wall-clock timer is armed', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxWallTimeSeconds: 5 }, ac);
    enforcer.start();
    enforcer.start();
    vi.advanceTimersByTime(5_001);
    expect(ac.signal.aborted).toBe(true);
    expect(enforcer.getExceeded()?.kind).toBe('wall-time');
  });
});

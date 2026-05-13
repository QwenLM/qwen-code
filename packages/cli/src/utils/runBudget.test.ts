/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RunBudgetEnforcer, parseDurationSeconds } from './runBudget.js';

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
});

describe('RunBudgetEnforcer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to maxApiCalls calls, aborts on the (N+1)th', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxApiCalls: 2 }, ac);
    enforcer.tickApiCall();
    enforcer.tickApiCall();
    expect(ac.signal.aborted).toBe(false);
    expect(enforcer.getExceeded()).toBeNull();
    enforcer.tickApiCall();
    expect(ac.signal.aborted).toBe(true);
    const exceeded = enforcer.getExceeded();
    expect(exceeded?.kind).toBe('api-calls');
    expect(exceeded?.limit).toBe(2);
    expect(exceeded?.observed).toBe(3);
  });

  it('allows up to maxToolCalls calls, aborts on the (N+1)th', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxToolCalls: 1 }, ac);
    enforcer.tickToolCall();
    expect(ac.signal.aborted).toBe(false);
    enforcer.tickToolCall();
    expect(ac.signal.aborted).toBe(true);
    expect(enforcer.getExceeded()?.kind).toBe('tool-calls');
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
    const enforcer = new RunBudgetEnforcer(
      { maxToolCalls: -1, maxApiCalls: -1 },
      ac,
    );
    for (let i = 0; i < 50; i++) {
      enforcer.tickApiCall();
      enforcer.tickToolCall();
    }
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
      { maxToolCalls: 0, maxApiCalls: 0 },
      ac,
    );
    enforcer.tickToolCall();
    enforcer.tickApiCall();
    expect(enforcer.getExceeded()?.kind).toBe('tool-calls');
  });

  it('aborts when the reported cumulative token count exceeds maxTokens', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxTokens: 1000 }, ac);
    enforcer.tickTokens(500);
    expect(ac.signal.aborted).toBe(false);
    enforcer.tickTokens(1000);
    expect(ac.signal.aborted).toBe(false);
    enforcer.tickTokens(1001);
    expect(ac.signal.aborted).toBe(true);
    const exceeded = enforcer.getExceeded();
    expect(exceeded?.kind).toBe('tokens');
    expect(exceeded?.limit).toBe(1000);
    expect(exceeded?.observed).toBe(1001);
  });

  it('does not enforce token budget when maxTokens is -1 (unlimited)', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxTokens: -1 }, ac);
    enforcer.tickTokens(Number.MAX_SAFE_INTEGER);
    expect(ac.signal.aborted).toBe(false);
    expect(enforcer.getExceeded()).toBeNull();
  });

  it('does not record an "exceeded" reason when the controller was already aborted by a third party (SIGINT race)', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxApiCalls: 0 }, ac);
    // Simulate SIGINT landing first: the shared abortController already
    // fired before any budget tick. The enforcer must not retroactively
    // claim the abort as a budget overrun.
    ac.abort();
    enforcer.tickApiCall();
    expect(enforcer.getExceeded()).toBeNull();
  });

  it('start() is idempotent', () => {
    const ac = new AbortController();
    const enforcer = new RunBudgetEnforcer({ maxWallTimeSeconds: 5 }, ac);
    enforcer.start();
    enforcer.start(); // should not stack a second timer
    vi.advanceTimersByTime(5_001);
    expect(ac.signal.aborted).toBe(true);
    // Even with a stacked timer the exceeded record is still only one.
    expect(enforcer.getExceeded()?.kind).toBe('wall-time');
  });
});

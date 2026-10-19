/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettleTimeout } from './settle-timeout.js';

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(1_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSettleTimeout', () => {
  it.each([
    ['ordinary host', 15_000, 10_000, 10_000],
    ['loaded non-ECS host', 15_000, 45_000, 14_000],
    ['ECS host', 60_000, 45_000, 45_000],
    ['explicit test ceiling', 30_000, 45_000, 29_000],
  ])('leaves reporting headroom on an %s', (_, testMs, waitMs, expected) => {
    expect(createSettleTimeout(testMs, waitMs)()).toBe(expected);
  });

  it('shares the deadline across setup and sequential helper waits', () => {
    const remaining = createSettleTimeout(30_000, 45_000);
    vi.mocked(performance.now).mockReturnValue(3_000);
    expect(remaining()).toBe(27_000);

    vi.mocked(performance.now).mockReturnValue(23_000);
    expect(remaining()).toBe(7_000);

    vi.mocked(performance.now).mockReturnValue(29_000);
    expect(remaining()).toBe(1_000);
  });

  it('retains the per-wait cap while time remains in the test', () => {
    const remaining = createSettleTimeout(60_000, 45_000);
    vi.mocked(performance.now).mockReturnValue(6_000);
    expect(remaining()).toBe(45_000);
    vi.mocked(performance.now).mockReturnValue(21_000);
    expect(remaining()).toBe(39_000);
  });

  it('gives the current assertion one attempt after the budget is exhausted', () => {
    const remaining = createSettleTimeout(15_000, 45_000);
    vi.mocked(performance.now).mockReturnValue(15_000);
    expect(remaining()).toBe(1);
    vi.mocked(performance.now).mockReturnValue(20_000);
    expect(remaining()).toBe(1);
  });

  it('starts a fresh deadline for the next test or retry', () => {
    const previous = createSettleTimeout(15_000, 45_000);
    vi.mocked(performance.now).mockReturnValue(20_000);
    const next = createSettleTimeout(15_000, 45_000);
    expect(previous()).toBe(1);
    expect(next()).toBe(14_000);
  });

  it('does not consume the deadline when a test changes the wall clock', () => {
    const remaining = createSettleTimeout(15_000, 45_000);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    expect(remaining()).toBe(14_000);
  });

  it('retains the per-wait cap when the test timeout is disabled', () => {
    const remaining = createSettleTimeout(0, 45_000);
    vi.mocked(performance.now).mockReturnValue(1_000_000);
    expect(remaining()).toBe(45_000);
  });
});

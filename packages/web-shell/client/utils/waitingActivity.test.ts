/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWaitingActivity,
  buildWaitingTokenUsage,
  WAITING_ACTIVITY_BUCKETS,
} from './waitingActivity';

describe('waiting activity summary', () => {
  it('returns empty buckets when the task has no Q&A messages', () => {
    const buckets = buildWaitingActivity([
      { role: 'thinking', timestamp: 1_000 },
      { role: 'tool', timestamp: 2_000 },
      { role: 'user' },
    ]);
    expect(buckets).toHaveLength(WAITING_ACTIVITY_BUCKETS);
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
    expect(buckets[0]?.startAt).toBeUndefined();
  });

  it('buckets user and assistant messages across the task timeline', () => {
    const buckets = buildWaitingActivity(
      [
        { role: 'user', timestamp: 1_000 },
        { role: 'assistant', timestamp: 3_000 },
      ],
      4,
    );
    expect(buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 1]);
    expect(buckets[0]?.startAt).toBe(1_000);
    expect(buckets[3]?.endAt).toBe(3_000);
  });

  it('gives a single message a one-minute window', () => {
    const buckets = buildWaitingActivity(
      [{ role: 'user', timestamp: 5_000 }],
      2,
    );
    expect(buckets.map((bucket) => bucket.count)).toEqual([1, 0]);
    expect(buckets[1]?.endAt).toBe(65_000);
  });

  it('sums assistant usage and falls back to the latest usage event', () => {
    const summed = buildWaitingTokenUsage(
      [
        {
          role: 'assistant',
          usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
        },
        {
          role: 'assistant',
          usage: { inputTokens: 50, outputTokens: 10 },
        },
      ],
      {},
      900,
      1_000,
    );
    expect(summed).toEqual({
      input: 150,
      output: 30,
      cached: 40,
      context: 900,
      contextLimit: 1_000,
    });

    const fallback = buildWaitingTokenUsage([{ role: 'user' }], {
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: 1,
    });
    expect(fallback).toEqual({ input: 7, output: 3, cached: 1 });
  });
});

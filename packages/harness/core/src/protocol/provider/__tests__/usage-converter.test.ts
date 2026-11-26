/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  addAnthropicUsage,
  annotateContextUsageRatio,
  attachThinkingTokenCount,
  getThinkingTokenCount,
  getTotalTokenCount,
} from '../usage-converter.js';
import {
  EMPTY_USAGE,
  cloneUsage,
  isCacheReadUsageAvailable,
  isCacheWriteUsageAvailable,
  markCacheReadUsageAvailable,
  markCacheWriteUsageAvailable,
} from '../empty-usage.js';

describe('annotateContextUsageRatio', () => {
  it('stores the current request context usage ratio', () => {
    const usage = cloneUsage();
    usage.input_tokens = 45_000;

    annotateContextUsageRatio(usage, 180_000);

    expect((usage as Record<string, unknown>)['context_usage_ratio']).toBe(
      0.25,
    );
  });

  it('clamps the ratio to one', () => {
    const usage = cloneUsage();
    usage.input_tokens = 200;

    annotateContextUsageRatio(usage, 100);

    expect((usage as Record<string, unknown>)['context_usage_ratio']).toBe(1);
  });
});

describe('addAnthropicUsage', () => {
  it('keeps the latest request_id while summing token counts', () => {
    const accumulated = cloneUsage();
    accumulated.input_tokens = 10;
    accumulated.request_id = 'req-prev';
    const next = cloneUsage();
    next.output_tokens = 5;
    next.request_id = 'req-next';

    const result = addAnthropicUsage(accumulated, next);

    expect(result.input_tokens).toBe(10);
    expect(result.output_tokens).toBe(5);
    expect(result.request_id).toBe('req-next');
  });

  it('keeps context_usage_ratio as the latest request state while summing token counts', () => {
    const accumulated = cloneUsage();
    accumulated.input_tokens = 100;
    (accumulated as Record<string, unknown>)['context_usage_ratio'] = 0.4;
    const next = cloneUsage();
    next.input_tokens = 50;
    (next as Record<string, unknown>)['context_usage_ratio'] = 0.2;

    const result = addAnthropicUsage(accumulated, next);

    expect(result.input_tokens).toBe(150);
    expect((result as Record<string, unknown>)['context_usage_ratio']).toBe(
      0.2,
    );
  });

  it('sums thinking tokens across requests', () => {
    const accumulated = attachThinkingTokenCount(cloneUsage(), 3);
    const next = attachThinkingTokenCount(cloneUsage(), 4);

    const result = addAnthropicUsage(accumulated, next);

    expect(getThinkingTokenCount(result)).toBe(7);
  });

  it('sums raw total_tokens across requests when present', () => {
    const accumulated = attachThinkingTokenCount(
      Object.assign(cloneUsage(), {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      }),
      3,
    );
    const next = attachThinkingTokenCount(
      Object.assign(cloneUsage(), {
        input_tokens: 20,
        output_tokens: 7,
        total_tokens: 27,
      }),
      4,
    );

    const result = addAnthropicUsage(accumulated, next);

    expect(getThinkingTokenCount(result)).toBe(7);
    expect(getTotalTokenCount(result)).toBe(42);
  });

  it('does not sum request-level credits metadata across requests', () => {
    const accumulated = Object.assign(cloneUsage(), {
      billable: true,
      credits: 1,
      original_credits: 2,
    });
    const next = Object.assign(cloneUsage(), {
      billable: true,
      credits: 3,
      original_credits: 4,
    });

    const result = addAnthropicUsage(accumulated, next);

    expect(result).not.toHaveProperty('billable');
    expect(result).not.toHaveProperty('credits');
    expect(result).not.toHaveProperty('original_credits');
  });

  it('preserves independent cache-field availability while accumulating requests', () => {
    const unavailable = cloneUsage();
    const readAvailable = markCacheReadUsageAvailable(cloneUsage(), true);
    const writeAvailable = markCacheWriteUsageAvailable(cloneUsage(), true);

    const readAccumulated = addAnthropicUsage(unavailable, readAvailable);
    expect(isCacheReadUsageAvailable(readAccumulated)).toBe(true);
    expect(isCacheWriteUsageAvailable(readAccumulated)).toBe(false);
    const bothAccumulated = addAnthropicUsage(readAccumulated, writeAvailable);
    expect(isCacheReadUsageAvailable(bothAccumulated)).toBe(true);
    expect(isCacheWriteUsageAvailable(bothAccumulated)).toBe(true);
    expect(isCacheReadUsageAvailable(addAnthropicUsage(unavailable))).toBe(false);
    expect(isCacheWriteUsageAvailable(addAnthropicUsage(unavailable))).toBe(false);
  });
});

describe('EMPTY_USAGE / cloneUsage', () => {
  it('EMPTY_USAGE has all zero defaults', () => {
    expect(EMPTY_USAGE.input_tokens).toBe(0);
    expect(EMPTY_USAGE.output_tokens).toBe(0);
    expect(EMPTY_USAGE.service_tier).toBe('standard');
    expect(EMPTY_USAGE.iterations).toEqual([]);
  });

  it('cloneUsage returns a distinct object', () => {
    const a = cloneUsage();
    const b = cloneUsage();
    expect(a).not.toBe(b);
    expect(a.server_tool_use).not.toBe(b.server_tool_use);
    expect(a.cache_creation).not.toBe(b.cache_creation);
    expect(a.iterations).not.toBe(b.iterations);
  });
});

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildAnthropicUsageMetadata } from './usage.js';

describe('buildAnthropicUsageMetadata', () => {
  it('sums all three prompt fields under standard Anthropic semantics', () => {
    expect(
      buildAnthropicUsageMetadata({
        inputTokens: 5_000,
        cacheReadTokens: 25_000,
        cacheCreationTokens: 0,
        outputTokens: 1_000,
      }),
    ).toEqual({
      promptTokenCount: 30_000,
      candidatesTokenCount: 1_000,
      totalTokenCount: 31_000,
      cachedContentTokenCount: 25_000,
    });
  });

  it('sums when only cache_creation is set (first cache write)', () => {
    expect(
      buildAnthropicUsageMetadata({
        inputTokens: 10_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 20_000,
        outputTokens: 500,
      }),
    ).toEqual({
      promptTokenCount: 30_000,
      candidatesTokenCount: 500,
      totalTokenCount: 30_500,
      cachedContentTokenCount: 0,
    });
  });

  it('uses inputTokens alone when it already covers cache fields (OpenAI semantics on Anthropic protocol)', () => {
    expect(
      buildAnthropicUsageMetadata({
        inputTokens: 30_000,
        cacheReadTokens: 25_000,
        cacheCreationTokens: 0,
        outputTokens: 800,
      }),
    ).toEqual({
      promptTokenCount: 30_000,
      candidatesTokenCount: 800,
      totalTokenCount: 30_800,
      cachedContentTokenCount: 25_000,
    });
  });

  it('reports inputTokens directly when no cache fields are present', () => {
    expect(
      buildAnthropicUsageMetadata({
        inputTokens: 12_345,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 678,
      }),
    ).toEqual({
      promptTokenCount: 12_345,
      candidatesTokenCount: 678,
      totalTokenCount: 13_023,
      cachedContentTokenCount: 0,
    });
  });

  it('handles all-zero usage cleanly', () => {
    expect(
      buildAnthropicUsageMetadata({
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
      }),
    ).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
    });
  });
});

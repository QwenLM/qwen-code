/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildDashScopeUsageMetadata } from './usage.js';
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import type { DashScopeUsage } from './types.js';

describe('buildDashScopeUsageMetadata', () => {
  it('returns undefined for undefined input', () => {
    expect(buildDashScopeUsageMetadata(undefined)).toBeUndefined();
  });

  it('does NOT sum cached_tokens into promptTokenCount (no-summing regression)', () => {
    const usage: DashScopeUsage = {
      input_tokens: 1581,
      output_tokens: 9,
      total_tokens: 1590,
      prompt_tokens_details: {
        cached_tokens: 1564,
        cache_type: 'ephemeral',
        cache_creation_input_tokens: 9,
        cache_creation: { ephemeral_5m_input_tokens: 9 },
      },
      input_tokens_details: { text_tokens: 1581 },
      output_tokens_details: { text_tokens: 9, reasoning_tokens: 24 },
    };

    const metadata = buildDashScopeUsageMetadata(usage);

    expect(metadata?.promptTokenCount).toBe(1581);
    expect(metadata?.cachedContentTokenCount).toBe(1564);
    expect(metadata?.candidatesTokenCount).toBe(9);
    expect(metadata?.thoughtsTokenCount).toBe(24);
    expect(metadata?.totalTokenCount).toBe(1590);
  });

  it('ignores output_tokens_details.text_tokens entirely', () => {
    const metadata = buildDashScopeUsageMetadata({
      input_tokens: 100,
      output_tokens: 50,
      output_tokens_details: { text_tokens: 50, reasoning_tokens: 30 },
    });

    expect(metadata?.thoughtsTokenCount).toBe(30);
    expect(metadata?.candidatesTokenCount).toBe(50);
  });

  it('falls back to input + output when total_tokens is absent', () => {
    const metadata = buildDashScopeUsageMetadata({
      input_tokens: 14,
      output_tokens: 1,
    });

    expect(metadata?.totalTokenCount).toBe(15);
  });

  it('defaults every count to 0 when fields are missing', () => {
    expect(buildDashScopeUsageMetadata({})).toEqual({
      promptTokenCount: 0,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    });
  });

  it('records provenance mirroring the Anthropic generator call site', () => {
    const usage: DashScopeUsage = {
      input_tokens: 1581,
      output_tokens: 9,
      prompt_tokens_details: {
        cached_tokens: 1564,
        cache_creation_input_tokens: 9,
      },
    };

    const metadata = buildDashScopeUsageMetadata(usage);
    const provenance = getGenAiUsageProvenance(metadata);

    expect(provenance).toEqual({
      cachedInputTokensReported: true,
      cacheCreationInputTokens: 9,
    });
  });

  it('reports cachedInputTokensReported: false when cached_tokens is absent', () => {
    const metadata = buildDashScopeUsageMetadata({
      input_tokens: 14,
      output_tokens: 1,
    });
    const provenance = getGenAiUsageProvenance(metadata);

    expect(provenance).toEqual({
      cachedInputTokensReported: false,
      cacheCreationInputTokens: undefined,
    });
  });
});

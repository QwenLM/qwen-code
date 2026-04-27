/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { computeContextUsage } from './contextUsage.js';

describe('computeContextUsage', () => {
  it('returns null when there is no trusted token limit', () => {
    expect(
      computeContextUsage(
        {
          usage: {
            promptTokens: 1234,
          },
        },
        {
          modelId: 'unknown-model',
          name: 'Unknown Model',
        },
      ),
    ).toBeNull();
  });

  it('prefers usageStats.tokenLimit over model metadata', () => {
    expect(
      computeContextUsage(
        {
          usage: {
            promptTokens: 1000,
          },
          tokenLimit: 4000,
        },
        {
          modelId: 'qwen3-max',
          name: 'Qwen3 Max',
          _meta: { contextLimit: 8000 },
        },
      ),
    ).toEqual({
      percentLeft: 75,
      usedTokens: 1000,
      tokenLimit: 4000,
    });
  });

  it('falls back to model metadata when usageStats does not include a limit', () => {
    expect(
      computeContextUsage(
        {
          usage: {
            promptTokens: 2000,
          },
        },
        {
          modelId: 'qwen3-max',
          name: 'Qwen3 Max',
          _meta: { contextLimit: 8000 },
        },
      ),
    ).toEqual({
      percentLeft: 75,
      usedTokens: 2000,
      tokenLimit: 8000,
    });
  });

  it('uses inputTokens when promptTokens is unavailable', () => {
    expect(
      computeContextUsage(
        {
          usage: {
            inputTokens: 3000,
          },
          tokenLimit: 12000,
        },
        null,
      ),
    ).toEqual({
      percentLeft: 75,
      usedTokens: 3000,
      tokenLimit: 12000,
    });
  });
});

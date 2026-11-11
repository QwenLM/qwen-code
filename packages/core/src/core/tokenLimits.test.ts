/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  tokenLimit,
  outputTokenLimit,
  DEFAULT_TOKEN_LIMIT,
  DEFAULT_OUTPUT_TOKEN_LIMIT,
} from './tokenLimits.js';
import { testListedModel } from '../test-utils/listed-model.js';

describe('tokenLimit', () => {
  it('should return the default token limit for an unknown model', () => {
    expect(tokenLimit(undefined)).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should return the default token limit if no model is provided', () => {
    expect(tokenLimit(undefined)).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should have the correct default token limit value', () => {
    expect(DEFAULT_TOKEN_LIMIT).toBe(1_048_576);
  });

  it('should return maxContextTokens from the listed model', () => {
    expect(
      tokenLimit(testListedModel('qwen-max', { max_input_tokens: 131072 })),
    ).toBe(131072);
  });

  it('should NOT inflate via selectable context windows — opt-in via Config.getEffectiveContextWindow only', () => {
    // tokenLimit reflects the model's declared input limit. The selectable
    // context window tiers sit behind the context_window_selection feature
    // gate; tokenLimit must not silently inflate for users who never opted in.
    const model = testListedModel('qwen-max', {
      max_input_tokens: 180_000,
      available_context_windows: [200_000, 400_000, 1_000_000],
    });
    expect(tokenLimit(model)).toBe(180_000);
  });

  it('should fall back to default when the listed model has maxContextTokens of 0', () => {
    expect(
      tokenLimit(testListedModel('some-model', { max_input_tokens: 0 })),
    ).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])(
    '无效限额 %s 使用默认值',
    (limit) => {
      const model = {
        ...testListedModel('invalid'),
        limits: { maxContextTokens: limit, maxOutputTokens: limit },
      };
      expect(tokenLimit(model)).toBe(DEFAULT_TOKEN_LIMIT);
      expect(outputTokenLimit(model)).toBe(DEFAULT_OUTPUT_TOKEN_LIMIT);
    },
  );

  it('输出限额直接读取模型字段', () => {
    expect(
      outputTokenLimit(
        testListedModel('output', {
          max_output_tokens: 8192,
        }),
      ),
    ).toBe(8192);
    expect(outputTokenLimit(undefined)).toBe(DEFAULT_OUTPUT_TOKEN_LIMIT);
  });
});

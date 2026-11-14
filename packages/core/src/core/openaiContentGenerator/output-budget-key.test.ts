/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  OUTPUT_BUDGET_KEYS,
  configuredOutputBudget,
  outputBudgetWireKey,
} from './output-budget-key.js';

describe('output-budget-key', () => {
  describe('configuredOutputBudget', () => {
    it('reads each key a samplingParams budget can travel under', () => {
      // Every reader of "did the user choose a ceiling" goes through here, so
      // dropping a key from the contract must redden this, not only the
      // indirect llm-chat / baseLlmClient cases.
      expect(OUTPUT_BUDGET_KEYS).toEqual([
        'max_tokens',
        'max_completion_tokens',
        'max_new_tokens',
      ]);
      expect(configuredOutputBudget({ max_tokens: 1024 })).toBe(1024);
      expect(configuredOutputBudget({ max_completion_tokens: 1024 })).toBe(
        1024,
      );
      expect(configuredOutputBudget({ max_new_tokens: 1024 })).toBe(1024);
    });

    it('prefers the documented max_tokens when several keys carry a number', () => {
      expect(
        configuredOutputBudget({
          max_tokens: 1000,
          max_completion_tokens: 100_000,
        }),
      ).toBe(1000);
      expect(
        configuredOutputBudget({
          max_completion_tokens: 2048,
          max_new_tokens: 100_000,
        }),
      ).toBe(2048);
    });

    it('treats null and non-numeric placeholders as unset and falls through', () => {
      expect(
        configuredOutputBudget({
          max_tokens: null,
          max_completion_tokens: 2048,
        }),
      ).toBe(2048);
      expect(configuredOutputBudget({ max_tokens: '4096' })).toBeUndefined();
      expect(configuredOutputBudget({ temperature: 0.2 })).toBeUndefined();
      expect(configuredOutputBudget({})).toBeUndefined();
      expect(configuredOutputBudget(undefined)).toBeUndefined();
    });
  });

  describe('outputBudgetWireKey', () => {
    it.each([
      'gpt-5',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-6',
      'o1',
      'o3-mini',
      'o4-mini',
      'openai.gpt-5.5',
      'openai.o3',
      'openai.gpt-5-1:0',
      'openai/gpt-5.5-pro:batch',
      'openai:gpt-5.5',
    ])('picks max_completion_tokens for %s', (model) => {
      expect(outputBudgetWireKey(model)).toBe('max_completion_tokens');
    });

    it.each([
      'gpt-4.1',
      'gpt-4o',
      'gpt-oss-120b',
      'openai.gpt-oss-120b-1:0',
      'o-series-proxy',
      'qwen3-coder-plus',
      'xai.grok-4.3',
      '',
      undefined,
    ])('keeps max_tokens for %s', (model) => {
      expect(outputBudgetWireKey(model)).toBe('max_tokens');
    });
  });
});

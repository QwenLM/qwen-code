/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { liveModels, selectCases } from './live-config.js';

const CASES = ['bill', 'checklist', 'form', 'comparator'];
const GATING = {
  QWEN_GENERATED_UI_LIVE_BASE_URL: 'https://example.invalid/v1',
  QWEN_GENERATED_UI_LIVE_API_KEY: 'key',
  QWEN_GENERATED_UI_LIVE_MODEL: 'qwen-model',
};

describe('live evaluation settings', () => {
  it('selects every case by default and a named subset in order', () => {
    expect(selectCases(CASES)).toEqual(CASES);
    expect(selectCases(CASES, ' form, bill ')).toEqual(['bill', 'form']);
  });

  it('rejects an unknown case name instead of running nothing', () => {
    expect(() => selectCases(CASES, 'billl')).toThrow(
      'unknown QWEN_GENERATED_UI_LIVE_CASES: billl',
    );
  });

  it('requires a complete gating model', () => {
    expect(() => liveModels({})).toThrow('QWEN_GENERATED_UI_LIVE=1 needs');
    expect(() =>
      liveModels({ ...GATING, QWEN_GENERATED_UI_LIVE_MODEL: '' }),
    ).toThrow('set QWEN_GENERATED_UI_LIVE_MODEL');
    expect(liveModels(GATING)).toEqual([
      {
        label: 'gating:qwen-model',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'key',
        model: 'qwen-model',
      },
    ]);
  });

  it('adds a complete comparison model and rejects a partial one', () => {
    expect(
      liveModels({
        ...GATING,
        QWEN_GENERATED_UI_COMPARE_BASE_URL: 'https://other.invalid/v1',
        QWEN_GENERATED_UI_COMPARE_API_KEY: 'other',
        QWEN_GENERATED_UI_COMPARE_MODEL: 'other-model',
      }).map((model) => model.label),
    ).toEqual(['gating:qwen-model', 'comparison:other-model']);
    expect(() =>
      liveModels({ ...GATING, QWEN_GENERATED_UI_COMPARE_MODEL: 'other' }),
    ).toThrow(
      'set QWEN_GENERATED_UI_COMPARE_BASE_URL, QWEN_GENERATED_UI_COMPARE_API_KEY',
    );
  });
});

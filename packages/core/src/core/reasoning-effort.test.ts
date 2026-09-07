/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '../config/config.js';
import {
  REASONING_EFFORT_TIERS,
  applyReasoningEffort,
  clampReasoningEffort,
  getGpt5ReasoningCapabilities,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from './reasoning-effort.js';

describe('getGpt5ReasoningCapabilities', () => {
  it.each([
    ['gpt-5', ['low', 'medium', 'high'], 'medium', true, true],
    ['gpt-5-mini', ['low', 'medium', 'high'], 'medium', true, true],
    ['gpt-5.1', ['low', 'medium', 'high'], 'medium', false, false],
    ['gpt-5.1-codex', ['low', 'medium', 'high'], 'medium', true, true],
    [
      'gpt-5.1-codex-max',
      ['low', 'medium', 'high', 'xhigh'],
      'medium',
      true,
      true,
    ],
    ['gpt-5.2', ['low', 'medium', 'high', 'xhigh'], 'medium', false, false],
    ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh'], 'medium', true, true],
    [
      'gpt-5.4-2026-03-05',
      ['low', 'medium', 'high', 'xhigh'],
      'medium',
      false,
      false,
    ],
    [
      'openai/gpt-5.4',
      ['low', 'medium', 'high', 'xhigh'],
      'medium',
      false,
      false,
    ],
    ['GPT-5.5', ['low', 'medium', 'high', 'xhigh'], 'medium', true, false],
    [
      'gpt-5.6',
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'medium',
      true,
      false,
    ],
    [
      'gpt-5.6-sol',
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'medium',
      true,
      false,
    ],
    ['gpt-5-pro', ['high'], 'high', true, true],
    ['gpt-5.2-pro', ['medium', 'high', 'xhigh'], 'medium', true, true],
    ['gpt-5.5-pro', ['medium', 'high', 'xhigh'], 'high', true, true],
  ] as const)(
    'describes %s',
    (model, efforts, defaultEffort, defaultEnabled, thinkingMandatory) => {
      expect(getGpt5ReasoningCapabilities(model)).toEqual({
        efforts,
        defaultEffort,
        defaultEnabled,
        thinkingMandatory,
      });
    },
  );

  it.each([
    undefined,
    '',
    'gpt-4.1',
    'gpt-50',
    'my-gpt-5.4',
    'gpt-5.4custom',
    'gpt-5-chat-latest',
    'openai/gpt-5.2-chat-latest',
    'qwen3.8-max',
  ])('does not assign GPT reasoning controls to %s', (model) => {
    expect(getGpt5ReasoningCapabilities(model)).toBeUndefined();
  });
});

describe('REASONING_EFFORT_TIERS', () => {
  it('is ordered weakest to strongest', () => {
    expect(REASONING_EFFORT_TIERS).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});

describe('normalizeReasoningEffort', () => {
  it('accepts canonical tiers case-insensitively', () => {
    expect(normalizeReasoningEffort('LOW')).toBe('low');
    expect(normalizeReasoningEffort('Medium')).toBe('medium');
    expect(normalizeReasoningEffort('high')).toBe('high');
  });

  it('accepts separators and aliases', () => {
    expect(normalizeReasoningEffort('x-high')).toBe('xhigh');
    expect(normalizeReasoningEffort('extra high')).toBe('xhigh');
    expect(normalizeReasoningEffort('  MAX ')).toBe('max');
    expect(normalizeReasoningEffort('maximum')).toBe('max');
    expect(normalizeReasoningEffort('med')).toBe('medium');
  });

  it('returns undefined for unknown or empty input', () => {
    expect(normalizeReasoningEffort('off')).toBeUndefined();
    expect(normalizeReasoningEffort('ultra')).toBeUndefined();
    expect(normalizeReasoningEffort('')).toBeUndefined();
    expect(normalizeReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeReasoningEffort(null)).toBeUndefined();
  });

  it('returns undefined for non-string input without throwing', () => {
    // A hand-edited settings.json can hold a non-string reasoningEffort
    // (e.g. `true` or `123`); the runtime call site forwards the raw value,
    // so normalize must not call `.trim()` on it and crash at startup.
    expect(normalizeReasoningEffort(true as unknown as string)).toBeUndefined();
    expect(normalizeReasoningEffort(123 as unknown as string)).toBeUndefined();
    expect(normalizeReasoningEffort({} as unknown as string)).toBeUndefined();
  });
});

describe('clampReasoningEffort', () => {
  it('keeps a supported tier unchanged', () => {
    expect(clampReasoningEffort('high')).toBe('high');
    expect(clampReasoningEffort('max', ['low', 'medium', 'high', 'max'])).toBe(
      'max',
    );
  });

  it('caps over-strong requests to the model ceiling (walk down)', () => {
    const supported: ReasoningEffort[] = ['low', 'medium', 'high'];
    expect(clampReasoningEffort('xhigh', supported)).toBe('high');
    expect(clampReasoningEffort('max', supported)).toBe('high');
  });

  it('rounds up to the next stronger supported tier when the exact one is missing', () => {
    expect(clampReasoningEffort('medium', ['low', 'high'])).toBe('high');
    expect(clampReasoningEffort('low', ['high', 'max'])).toBe('high');
  });

  it('falls back to the full ladder when no supported set is given', () => {
    for (const tier of REASONING_EFFORT_TIERS) {
      expect(clampReasoningEffort(tier)).toBe(tier);
    }
  });

  it('handles an empty supported list as no clamping', () => {
    expect(clampReasoningEffort('xhigh', [])).toBe('xhigh');
  });
});

describe('applyReasoningEffort', () => {
  function makeConfig(thinkingDisabled = false) {
    let stored: ReasoningEffort | undefined;
    return {
      setReasoningEffort(effort: ReasoningEffort | undefined) {
        // Mirrors Config: a no-op when thinking is explicitly disabled.
        if (thinkingDisabled) return;
        stored = effort;
      },
      getReasoningEffort() {
        return stored;
      },
    } as unknown as Config;
  }

  it('applies the tier and reports true when the config accepts it', () => {
    const config = makeConfig();
    expect(applyReasoningEffort(config, 'high')).toBe(true);
    expect(config.getReasoningEffort()).toBe('high');
  });

  it('reports false when setReasoningEffort no-ops (thinking disabled)', () => {
    const config = makeConfig(true);
    expect(applyReasoningEffort(config, 'high')).toBe(false);
    expect(config.getReasoningEffort()).toBeUndefined();
  });

  it('clearing the override always reports true', () => {
    const active = makeConfig();
    applyReasoningEffort(active, 'max');
    expect(applyReasoningEffort(active, undefined)).toBe(true);
    expect(active.getReasoningEffort()).toBeUndefined();

    const disabled = makeConfig(true);
    expect(applyReasoningEffort(disabled, undefined)).toBe(true);
  });
});

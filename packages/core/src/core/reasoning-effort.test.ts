/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  REASONING_EFFORT_TIERS,
  clampReasoningEffort,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from './reasoning-effort.js';

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

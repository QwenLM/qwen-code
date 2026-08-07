/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getModelReasoningControls,
  normalizeModelReasoningEffort,
  resolveModelReasoningControlRegistration,
  resolveModelReasoningControls,
  type ModelReasoningControlRegistration,
} from './model-reasoning-controls.js';

describe('model reasoning controls', () => {
  it('matches only the exact registered base model id', () => {
    expect(getModelReasoningControls('qwen3.8-max')).toBeDefined();
    expect(getModelReasoningControls('Qwen3.8-Max')).toBeUndefined();
    expect(getModelReasoningControls('qwen3.8-max-preview')).toBeUndefined();
    expect(getModelReasoningControls('qwen3.8-max-latest')).toBeUndefined();
    expect(getModelReasoningControls('qwen3.8-max-2026-01-15')).toBeUndefined();
  });

  it('uses registered defaults without inheriting another preference', () => {
    expect(resolveModelReasoningControls('qwen3.8-max', undefined)).toEqual({
      thinkingEnabled: true,
      effort: 'xhigh',
    });
  });

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'xhigh'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
  ] as const)('normalizes %s to %s', (requested, expected) => {
    const registration = getModelReasoningControls('qwen3.8-max')!;
    expect(normalizeModelReasoningEffort(registration, requested)).toBe(
      expected,
    );
  });

  it('resolves thinking-only and effort-only registrations independently', () => {
    const thinkingOnly: ModelReasoningControlRegistration = {
      thinking: { defaultEnabled: false },
    };
    const effortOnly: ModelReasoningControlRegistration = {
      effort: { supported: ['low', 'high'], default: 'high' },
    };
    expect(normalizeModelReasoningEffort(thinkingOnly, 'low')).toBeUndefined();
    expect(normalizeModelReasoningEffort(effortOnly, undefined)).toBe('high');
    expect(
      resolveModelReasoningControlRegistration(thinkingOnly, undefined),
    ).toEqual({ thinkingEnabled: false });
    expect(
      resolveModelReasoningControlRegistration(effortOnly, { effort: 'low' }),
    ).toEqual({ effort: 'low' });
  });

  it('preserves the selected effort while thinking is disabled', () => {
    expect(
      resolveModelReasoningControls('qwen3.8-max', {
        thinkingEnabled: false,
        effort: 'medium',
      }),
    ).toEqual({ thinkingEnabled: false, effort: 'medium' });
  });
});

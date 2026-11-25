/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatDefaultEffortInline,
  formatEffortMeter,
  getDefaultReasoningEffort,
} from './reasoningEffort.js';
import { figures } from './figures.js';

describe('getDefaultReasoningEffort', () => {
  it('prefers an enabled effort when disabled thinking is only an option', () => {
    expect(
      getDefaultReasoningEffort({
        efforts: ['none', 'medium'],
        supports_disabled: true,
      }),
    ).toBe('medium');
  });

  it('keeps an explicit disabled default when provided by metadata', () => {
    expect(
      getDefaultReasoningEffort({
        efforts: ['none', 'medium'],
        default_effort: 'none',
        supports_disabled: true,
      }),
    ).toBe('none');
  });

  it('does not treat disable-only metadata as default disabled', () => {
    expect(
      getDefaultReasoningEffort({ efforts: [], supports_disabled: true }),
    ).toBeUndefined();
  });
});

describe('formatDefaultEffortInline', () => {
  it('returns undefined when the model has no effort metadata', () => {
    expect(formatDefaultEffortInline({})).toBeUndefined();
  });

  it('uses enabled effort for enable/disable-only models', () => {
    expect(
      formatDefaultEffortInline({ efforts: [], supports_disabled: true }),
    ).toBe('enabled effort');
  });

  it('uses the default thinking tier when the model has effort levels', () => {
    expect(
      formatDefaultEffortInline({
        efforts: ['low', 'medium', 'high'],
        default_effort: 'medium',
        supports_disabled: true,
      }),
    ).toBe('medium effort');
  });
});

describe('formatEffortMeter', () => {
  const ALL = [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const;

  it('keeps xhigh and max distinct on a six-level model', () => {
    // `none` is not a rung on the ladder, so five cells are enough for the five
    // real levels. Counting it would clamp the top two to the same full bar.
    expect(formatEffortMeter(ALL, 'xhigh', 5)).not.toEqual(
      formatEffortMeter(ALL, 'max', 5),
    );
    expect(formatEffortMeter(ALL, 'max', 5)).toEqual(
      figures.meterFilled.repeat(5),
    );
  });

  it('fills one cell per level from the weakest thinking level up', () => {
    const filled = (effort: (typeof ALL)[number]) =>
      formatEffortMeter(ALL, effort, 5).split('').filter((c) => c === figures.meterFilled)
        .length;
    expect(filled('low')).toBe(1);
    expect(filled('medium')).toBe(2);
    expect(filled('high')).toBe(3);
    expect(filled('xhigh')).toBe(4);
    expect(filled('max')).toBe(5);
  });

  it('renders none as an empty gauge', () => {
    expect(formatEffortMeter(ALL, 'none', 5)).toEqual(
      figures.meterEmpty.repeat(5),
    );
  });

  it('pads to the requested width when the model has fewer levels', () => {
    expect(formatEffortMeter(['none', 'low', 'high'], 'high', 5)).toHaveLength(5);
  });
});

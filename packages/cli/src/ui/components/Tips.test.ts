/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { selectWeightedTip } from './Tips.js';

describe('selectWeightedTip', () => {
  const tips = [
    { text: 'tip-a', weight: 1 },
    { text: 'tip-b', weight: 3 },
    { text: 'tip-c', weight: 1 },
  ];

  it('returns a valid tip text', () => {
    const result = selectWeightedTip(tips);
    expect(['tip-a', 'tip-b', 'tip-c']).toContain(result);
  });

  it('selects the first tip when random is near zero', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(selectWeightedTip(tips)).toBe('tip-a');
    vi.restoreAllMocks();
  });

  it('selects the weighted tip when random falls in its range', () => {
    // Total weight = 5. tip-a covers [0,1), tip-b covers [1,4), tip-c covers [4,5)
    // Math.random() * 5 = 2.0 falls in tip-b's range
    vi.spyOn(Math, 'random').mockReturnValue(0.4); // 0.4 * 5 = 2.0
    expect(selectWeightedTip(tips)).toBe('tip-b');
    vi.restoreAllMocks();
  });

  it('selects the last tip when random is near max', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(selectWeightedTip(tips)).toBe('tip-c');
    vi.restoreAllMocks();
  });

  it('respects weight distribution over many samples', () => {
    const counts: Record<string, number> = {
      'tip-a': 0,
      'tip-b': 0,
      'tip-c': 0,
    };
    const iterations = 10000;
    for (let i = 0; i < iterations; i++) {
      const result = selectWeightedTip(tips);
      counts[result]!++;
    }
    // tip-b (weight 3) should appear roughly 3x as often as tip-a or tip-c (weight 1)
    // With 10k iterations, we expect: tip-a ~2000, tip-b ~6000, tip-c ~2000
    expect(counts['tip-b']!).toBeGreaterThan(counts['tip-a']! * 2);
    expect(counts['tip-b']!).toBeGreaterThan(counts['tip-c']! * 2);
  });

  it('handles single tip', () => {
    expect(selectWeightedTip([{ text: 'only', weight: 1 }])).toBe('only');
  });
});

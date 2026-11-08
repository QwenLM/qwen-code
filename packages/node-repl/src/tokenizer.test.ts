/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './tokenizer.js';

const tokens = (text: string) =>
  estimateTextTokenUnits(text) / TOKEN_ESTIMATE_UNITS_PER_TOKEN;

describe('estimateTextTokenUnits', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTextTokenUnits('')).toBe(0);
  });

  it('estimates ASCII at ~4 chars per token', () => {
    expect(tokens('x'.repeat(400))).toBe(100);
  });

  it('estimates non-ASCII at ~1.1 tokens per char', () => {
    expect(tokens('中'.repeat(100))).toBeCloseTo(110, 5);
  });

  it('handles mixed ASCII and non-ASCII additively', () => {
    const mixed = `${'a'.repeat(40)}${'中'.repeat(10)}`;
    // 40 ascii * 5 + 10 non-ascii * 22 = 200 + 220 = 420 units
    expect(estimateTextTokenUnits(mixed)).toBe(420);
  });

  it('returns integer units so estimates accumulate without float drift', () => {
    for (const sample of ['a', '中', 'a中b', '😀']) {
      expect(Number.isInteger(estimateTextTokenUnits(sample))).toBe(true);
    }
  });

  it('counts a surrogate pair as its two code units', () => {
    // '😀' is 2 UTF-16 code units, both >= 0x80 -> 2 * 22 = 44
    expect(estimateTextTokenUnits('😀')).toBe(44);
  });

  it('is monotonic in input length', () => {
    let previous = 0;
    for (let i = 1; i <= 50; i++) {
      const current = estimateTextTokenUnits('a'.repeat(i));
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });
});

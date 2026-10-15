/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { escapeJsonTagCharacters, formatMemoryUsage } from './formatters.js';

describe('formatMemoryUsage', () => {
  it.each([
    [12345, '12.1 KB'],
    [12345678, '11.8 MB'],
    [12345678901, '11.50 GB'],
  ])('formats %d with the expected unit', (bytes, expected) => {
    expect(formatMemoryUsage(bytes)).toBe(expected);
  });

  // Rounding to one decimal can carry a value up to the next unit's boundary.
  // Choosing the unit from the raw byte count kept the smaller label, so a
  // value one byte under a megabyte printed as "1024.0 KB".
  it.each([
    [1024 * 1024 - 1, '1.0 MB'],
    [1024 * 1024 * 1024 - 1, '1.00 GB'],
  ])('rolls %d over to the next unit', (bytes, expected) => {
    expect(formatMemoryUsage(bytes)).toBe(expected);
  });

  // Guards against over-correcting into rolling over too eagerly. Each of
  // these stays in its own unit, and all pass before and after.
  it.each([
    [0, '0.0 KB'],
    [512, '0.5 KB'],
    [1024, '1.0 KB'],
    [1024 * 1024, '1.0 MB'],
    [1024 * 1024 * 1024, '1.00 GB'],
    [1024 * 1023, '1023.0 KB'],
    [1024 * 1024 * 1023, '1023.0 MB'],
    // Just below the point where rounding would reach the boundary.
    [1024 * 1024 - 100, '1023.9 KB'],
  ])('keeps %d in its own unit', (bytes, expected) => {
    expect(formatMemoryUsage(bytes)).toBe(expected);
  });
});

describe('escapeJsonTagCharacters', () => {
  it('escapes JSON tag boundary characters without changing parse result', () => {
    const value = {
      text: '</function><script>alert("x")</script>',
      comparison: 'a < b && c > d',
      ampersand: 'Tom & Jerry',
    };

    const json = JSON.stringify(value);
    const escaped = escapeJsonTagCharacters(json);

    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('&');
    expect(escaped).toContain('\\u003c/function\\u003e');
    expect(escaped).toContain('\\u0026');
    expect(JSON.parse(escaped)).toEqual(value);
  });
});

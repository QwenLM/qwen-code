/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatCompressionTokens,
  parseContextCompressionMeta,
} from './contextCompression';

describe('parseContextCompressionMeta', () => {
  it('reads a progress frame', () => {
    expect(parseContextCompressionMeta({ phase: 'progress' })).toEqual({
      phase: 'progress',
    });
  });

  it('reads a no-op frame', () => {
    expect(parseContextCompressionMeta({ phase: 'noop' })).toEqual({
      phase: 'noop',
    });
  });

  it('reads a notice frame', () => {
    expect(
      parseContextCompressionMeta({ phase: 'notice', instructionsLimit: 2000 }),
    ).toEqual({ phase: 'notice', instructionsLimit: 2000 });
  });

  it.each([
    ['a missing limit', { phase: 'notice' }],
    ['a non-numeric limit', { phase: 'notice', instructionsLimit: '2000' }],
    ['a negative limit', { phase: 'notice', instructionsLimit: -1 }],
  ])('rejects a notice with %s', (_label, value) => {
    expect(parseContextCompressionMeta(value)).toBeUndefined();
  });

  it('reads a done frame with explicit estimate flags', () => {
    expect(
      parseContextCompressionMeta({
        phase: 'done',
        originalTokenCount: 263195,
        newTokenCount: 99799,
        originalTokenCountIsEstimated: false,
        newTokenCountIsEstimated: true,
        warning: 'History before the marker was summarized.',
      }),
    ).toEqual({
      phase: 'done',
      result: {
        originalTokenCount: 263195,
        newTokenCount: 99799,
        originalTokenCountIsEstimated: false,
        newTokenCountIsEstimated: true,
        warning: 'History before the marker was summarized.',
      },
    });
  });

  it('treats a missing estimate flag as measured', () => {
    expect(
      parseContextCompressionMeta({
        phase: 'done',
        originalTokenCount: 10,
        newTokenCount: 5,
      }),
    ).toEqual({
      phase: 'done',
      result: {
        originalTokenCount: 10,
        newTokenCount: 5,
        originalTokenCountIsEstimated: false,
        newTokenCountIsEstimated: false,
      },
    });
  });

  it.each([
    ['null', null],
    ['a string', 'done'],
    ['an array', [{ phase: 'done' }]],
    ['an unknown phase', { phase: 'later' }],
    ['a missing phase', { originalTokenCount: 1, newTokenCount: 1 }],
    [
      'a non-numeric count',
      { phase: 'done', originalTokenCount: 'many', newTokenCount: 1 },
    ],
    [
      'a fractional count',
      { phase: 'done', originalTokenCount: 1.5, newTokenCount: 1 },
    ],
    [
      'a negative count',
      { phase: 'done', originalTokenCount: -1, newTokenCount: 1 },
    ],
    ['a finite-check dodge', { phase: 'done', originalTokenCount: NaN }],
  ])('rejects %s', (_label, value) => {
    expect(parseContextCompressionMeta(value)).toBeUndefined();
  });

  it('ignores an empty warning', () => {
    expect(
      parseContextCompressionMeta({
        phase: 'done',
        originalTokenCount: 1,
        newTokenCount: 1,
        warning: '',
      }),
    ).toEqual({
      phase: 'done',
      result: {
        originalTokenCount: 1,
        newTokenCount: 1,
        originalTokenCountIsEstimated: false,
        newTokenCountIsEstimated: false,
      },
    });
  });
});

describe('formatCompressionTokens', () => {
  it('groups thousands for the UI language, not the host locale', () => {
    expect(formatCompressionTokens(263195, false, 'en')).toBe('263,195');
    expect(formatCompressionTokens(263195, false, 'zh-CN')).toBe('263,195');
    expect(formatCompressionTokens(99799, true, 'zh-CN')).toBe('~99,799');
    // A language that groups differently from the host locale: this can only
    // pass if the argument is really what formats the number.
    expect(formatCompressionTokens(263195, false, 'de')).toBe('263.195');
  });
});

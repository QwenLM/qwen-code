/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from './output-tokens.js';

describe('resolveMaxOutputTokens', () => {
  it('uses a decimal 32k default', () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(32_000);
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    ' ',
    '0',
    '-1',
    '1.5',
    'invalid',
    true,
    {},
    [],
  ])('defaults invalid value %j', (value) => {
    expect(resolveMaxOutputTokens(value)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it.each([1, 16_384, Number.MAX_SAFE_INTEGER, '16384', ' 16384 ', '1e4'])(
    'preserves positive safe-integer value %j',
    (value) => {
      expect(resolveMaxOutputTokens(value)).toBe(Number(value));
    },
  );
});

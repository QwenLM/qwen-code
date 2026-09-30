/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parsePositiveIntegerEnv } from './env.js';

describe('parsePositiveIntegerEnv', () => {
  it.each([
    ['1', 1],
    ['10', 10],
    [' 3 ', 3],
  ])('accepts positive integer value %j', (value, expected) => {
    expect(parsePositiveIntegerEnv(value, 10)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    ' ',
    '0',
    '-1',
    '2abc',
    '2.5',
    '0x10',
    String(Number.MAX_SAFE_INTEGER + 1),
  ])('falls back for malformed value %j', (value) => {
    expect(parsePositiveIntegerEnv(value, 10)).toBe(10);
  });
});

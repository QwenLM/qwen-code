/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractVisionTimeout,
  parseVisionTimeoutMs,
} from './vision-timeout-command.js';

describe('extractVisionTimeout', () => {
  it.each([
    ['--vision --timeout 60', '--vision', '60'],
    ['--timeout 60 --vision', '--vision', '60'],
    ['--vision qwen-vl --timeout 45s', '--vision qwen-vl', '45s'],
    ['--vision --timeout', '--vision', ''],
  ])('extracts %j', (input, modelArg, timeout) => {
    expect(extractVisionTimeout(input)).toEqual({ modelArg, timeout });
  });

  it.each([
    '--vision qwen-vl',
    '--fast --timeout 60',
    'qwen-max what does --timeout 60 do',
    '--vision --timeouts 60',
  ])('leaves %j untouched', (input) => {
    expect(extractVisionTimeout(input)).toEqual({ modelArg: input });
  });
});

describe('parseVisionTimeoutMs', () => {
  it.each([
    ['60', 60_000],
    ['60s', 60_000],
    ['90000ms', 90_000],
    ['2147483647ms', 2_147_483_647],
  ])('parses %j', (value, expected) => {
    expect(parseVisionTimeoutMs(value)).toBe(expected);
  });

  it.each(['', 'abc', '0', '1.5', '-5', '60m', '2147484'])(
    'rejects %j',
    (value) => {
      expect(parseVisionTimeoutMs(value)).toBeUndefined();
    },
  );
});

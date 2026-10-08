/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXTRACT_NOOP_SKIP_TURNS_ENV,
  MAX_EXTRACT_NOOP_SKIP_TURNS,
  getExtractNoopSkipTurns,
} from './extract-cadence.js';

describe('getExtractNoopSkipTurns', () => {
  const original = process.env[EXTRACT_NOOP_SKIP_TURNS_ENV];

  beforeEach(() => {
    delete process.env[EXTRACT_NOOP_SKIP_TURNS_ENV];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[EXTRACT_NOOP_SKIP_TURNS_ENV];
    } else {
      process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = original;
    }
  });

  it('keeps the documented 0-3 window', () => {
    expect(MAX_EXTRACT_NOOP_SKIP_TURNS).toBe(3);
  });

  it('stays off unless the flag is a run of digits', () => {
    expect(getExtractNoopSkipTurns()).toBe(0);
    for (const raw of ['', '   ', 'abc', '1.5', '-1', '0x2', '2 turns']) {
      process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = raw;
      // Number() accepts '1.5', '-1' and '0x2'; the digit check is what
      // rejects them, so a skip window can never be armed by a typo.
      expect({ raw, turns: getExtractNoopSkipTurns() }).toEqual({
        raw,
        turns: 0,
      });
    }
  });

  it('trims surrounding whitespace before parsing', () => {
    process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = ' 2 ';
    expect(getExtractNoopSkipTurns()).toBe(2);
  });

  it('clamps at both ends of the window', () => {
    process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = '0';
    expect(getExtractNoopSkipTurns()).toBe(0);
    for (const raw of ['3', '4', '999']) {
      process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = raw;
      expect({ raw, turns: getExtractNoopSkipTurns() }).toEqual({
        raw,
        turns: MAX_EXTRACT_NOOP_SKIP_TURNS,
      });
    }
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { tokenizeArgs } from './shell-args.js';

describe('tokenizeArgs', () => {
  it('splits on whitespace and collapses runs', () => {
    expect(tokenizeArgs('  6711   --comment ')).toEqual(['6711', '--comment']);
  });

  it('honours double- and single-quoted segments', () => {
    expect(tokenizeArgs('"src/my file.ts" --effort low')).toEqual([
      'src/my file.ts',
      '--effort',
      'low',
    ]);
    expect(tokenizeArgs("'a b' c")).toEqual(['a b', 'c']);
  });

  it('keeps shell metacharacters inside quotes verbatim', () => {
    expect(tokenizeArgs('"a $x;`y`*" b')).toEqual(['a $x;`y`*', 'b']);
  });

  it('returns an empty list for an empty string', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
  });
});

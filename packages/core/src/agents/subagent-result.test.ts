/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toModelVisibleSubagentResult } from './subagent-result.js';

describe('toModelVisibleSubagentResult', () => {
  it.each([
    ['', ''],
    ['plain text', 'plain text'],
    ['<analysis>scratch</analysis><summary>visible</summary>', 'visible'],
    [
      '<analysis>scratch <summary>hidden</summary></analysis><summary>visible</summary>',
      'visible',
    ],
    [
      '<analysis type="scratch">scratch</analysis><summary kind="final">visible</summary>',
      'visible',
    ],
    ['<analysis>scratch\n<summary>visible</summary>', 'visible'],
    ['a<analysis>one</analysis>b<analysis>two</analysis>', 'ab'],
    ['prefix <summary>visible</summary> suffix', 'prefix visible suffix'],
    ['literal </analysis> marker', 'literal </analysis> marker'],
  ])('returns model-visible text for %j', (input, expected) => {
    expect(toModelVisibleSubagentResult(input)).toBe(expected);
  });
});

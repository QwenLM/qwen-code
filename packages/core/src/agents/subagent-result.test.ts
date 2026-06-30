/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AgentTerminateMode } from './runtime/agent-types.js';
import { toModelVisibleSubagentResult } from './subagent-result.js';

describe('toModelVisibleSubagentResult', () => {
  it.each([
    ['', ''],
    ['plain text', 'plain text'],
    ['<summary>just summary</summary>', 'just summary'],
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
    [
      'important context<summary>additional info</summary>',
      'important context additional info',
    ],
    [
      '<summary>part1</summary> middle <summary>part2</summary>',
      'part1 middle part2',
    ],
    [
      '<analysis>scratch</analysis><summary>Fix: replace <analysis> tag in src/app.tsx line 42</summary>',
      'Fix: replace <analysis> tag in src/app.tsx line 42',
    ],
    [
      '<summary>visible <analysis>hidden scratch</analysis></summary>',
      'visible',
    ],
    ['<analysis>outer<analysis>inner</analysis>LEAKED</analysis>', ''],
    [
      '<summary>visible <analysis>outer<analysis>inner</analysis>LEAKED</analysis></summary>',
      'visible',
    ],
    ['<summary>Done<analysis/>leaked</summary>', 'Done leaked'],
    ['literal </analysis> marker', 'literal </analysis> marker'],
  ])('returns model-visible text for %j', (input, expected) => {
    expect(toModelVisibleSubagentResult(input)).toBe(expected);
  });

  it('preserves raw diagnostics for non-goal terminations', () => {
    const raw = '<analysis>debug</analysis><summary>partial</summary>';

    expect(toModelVisibleSubagentResult(raw, AgentTerminateMode.ERROR)).toBe(
      raw,
    );
  });
});

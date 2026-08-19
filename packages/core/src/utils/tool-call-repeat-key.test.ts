/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getToolCallRepeatKey } from './tool-call-repeat-key.js';

describe('getToolCallRepeatKey', () => {
  it('resolves legacy aliases to the same key as the canonical name', () => {
    // Extracting the repeat key also canonicalized legacy aliases, which
    // widens every detector keyed off it — pin that equivalence so a
    // future split between classification and keying cannot ship silent.
    expect(getToolCallRepeatKey('task', { subagent_type: 'explore' })).toBe(
      getToolCallRepeatKey('agent', { subagent_type: 'explore' }),
    );
    expect(getToolCallRepeatKey('replace', { file: 'a.ts' })).toBe(
      getToolCallRepeatKey('edit', { file: 'a.ts' }),
    );
    expect(getToolCallRepeatKey('search_file_content', { q: 'x' })).toBe(
      getToolCallRepeatKey('grep_search', { q: 'x' }),
    );
  });

  it('is stable across object key order but not across different args', () => {
    expect(getToolCallRepeatKey('read_file', { a: 1, b: 2 })).toBe(
      getToolCallRepeatKey('read_file', { b: 2, a: 1 }),
    );
    expect(getToolCallRepeatKey('read_file', { a: 1 })).not.toBe(
      getToolCallRepeatKey('read_file', { a: 2 }),
    );
  });
});

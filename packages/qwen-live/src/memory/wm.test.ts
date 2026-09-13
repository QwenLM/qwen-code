/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { applyOperations, parseEntries, renderEntries } from './wm.js';

describe('working memory', () => {
  it('applies update and all deletes against original positions, then adds', () => {
    const input = ['A', 'B', 'C'];
    const { entries, result } = applyOperations(input, {
      update: [{ index: 1, content: 'new B' }],
      delete: [0, 2, 0],
      add: ['D'],
    });
    expect(entries).toEqual(['new B', 'D']);
    expect(result).toMatchObject({
      updated: 1,
      deleted: 2,
      added: 1,
      succeeded: true,
      nAfter: 2,
    });
    expect(input).toEqual(['A', 'B', 'C']);
    expect(renderEntries(entries)).toBe('0. new B\n1. D');
  });

  it('partially succeeds while rejecting bool, fractional, absent and invalid indices', () => {
    const { entries, result } = applyOperations(['A'], {
      update: [
        { index: true, content: 'bad' },
        { index: 0.5, content: 'bad' },
        { index: -1, content: 'bad' },
        { index: 0, content: 'new' },
      ],
      delete: [10],
      add: [false, '', 'new'],
    });
    expect(entries).toEqual(['new']);
    expect(result).toMatchObject({ succeeded: true, updated: 1, skipped: 7 });
  });

  it('frees capacity before adds and never evicts an existing memory', () => {
    expect(
      applyOperations(
        ['A', 'B'],
        { delete: [0], add: ['C', 'D'] },
        { maxEntries: 2, maxEntryChars: 200 },
      ),
    ).toMatchObject({ entries: ['B', 'C'], result: { added: 1, skipped: 1 } });
  });

  it('normalizes lines, truncates Unicode characters and detects no-ops', () => {
    const { entries } = applyOperations(
      [],
      { add: [' one\n two ', '🌻🌻🌻🌻'] },
      { maxEntries: 8, maxEntryChars: 3 },
    );
    expect(entries).toEqual(['one', '🌻🌻🌻']);
    expect(
      applyOperations(entries, { update: [{ index: 0, content: 'one' }] })
        .result.changed,
    ).toBe(false);
    expect(applyOperations(entries, null).result.malformed).toBe(true);
    expect(parseEntries('{')).toEqual([]);
  });
});

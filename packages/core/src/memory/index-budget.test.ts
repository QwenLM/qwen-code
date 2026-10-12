/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_INDEX_CHARS,
  MAX_INDEX_LINES,
  trimIndexToBudget,
} from './index-budget.js';

describe('trimIndexToBudget', () => {
  it('keeps empty and within-budget content unchanged', () => {
    expect(trimIndexToBudget([])).toBe('');
    const lines = ['- [One](notes/one.md)', '', '- [Two](notes/two.md)'];
    expect(trimIndexToBudget(lines)).toBe(lines.join('\n'));
  });

  it('keeps exactly 200 lines and excludes later entries', () => {
    const lines = Array.from(
      { length: MAX_INDEX_LINES + 1 },
      (_, i) => `- [Note ${i}](notes/${i}.md)`,
    );
    expect(trimIndexToBudget(lines)).toBe(
      lines.slice(0, MAX_INDEX_LINES).join('\n'),
    );
  });

  it('retains a complete entry at the character limit and drops one over it', () => {
    const entry = `- [Boundary](notes/${'a'.repeat(MAX_INDEX_CHARS - 23)}.md)`;
    expect(entry).toHaveLength(MAX_INDEX_CHARS);
    expect(trimIndexToBudget([entry])).toBe(entry);
    expect(trimIndexToBudget([`${entry}x`])).toBe('');
  });

  it('counts newline separators in the budget', () => {
    const first = 'a'.repeat(12_500);
    const second = 'b'.repeat(12_499);
    expect(trimIndexToBudget([first, second])).toBe(`${first}\n${second}`);
    expect(trimIndexToBudget([first, `${second}b`])).toBe(first);
  });

  it('drops an oversized first entry without cutting its percent-encoded target', () => {
    const oversized = `- [Oversized](notes/${'%28'.repeat(9_000)}.md)`;
    const kept = '- [Kept](notes/kept%28note%29.md)';
    expect(trimIndexToBudget([oversized, kept])).toBe(kept);
  });

  it('reserves space for ordinary entries and preserves the retained order', () => {
    const first = `- [First](notes/${'a'.repeat(10_000)}.md)`;
    const second = `- [Second](notes/${'b'.repeat(15_000)}.md)`;
    const ordinary = '- [Ordinary](notes/ordinary.md)';
    expect(trimIndexToBudget([first, second, ordinary])).toBe(
      `${first}\n${ordinary}`,
    );
  });

  it('does not replace the existing code-unit limit with UTF-8 bytes', () => {
    const entry = '😀'.repeat(MAX_INDEX_CHARS / 2);
    expect(trimIndexToBudget([entry])).toBe(entry);
    expect(trimIndexToBudget([`${entry}😀`])).toBe('');
  });
});

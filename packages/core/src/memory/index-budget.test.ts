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
  trimIndexToBudgetDetailed,
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

describe('trimIndexToBudgetDetailed', () => {
  it('reports nothing dropped when the index fits the budget', () => {
    const lines = ['- [One](notes/one.md)', '- [Two](notes/two.md)'];
    expect(trimIndexToBudgetDetailed(lines)).toEqual({
      content: lines.join('\n'),
      dropped: [],
    });
  });

  it('reports the entries removed by the line cap, in index order', () => {
    const lines = Array.from(
      { length: MAX_INDEX_LINES + 3 },
      (_, i) => `- [Note ${i}](notes/${i}.md)`,
    );
    const result = trimIndexToBudgetDetailed(lines);
    expect(result.content).toBe(lines.slice(0, MAX_INDEX_LINES).join('\n'));
    expect(result.dropped).toEqual(lines.slice(MAX_INDEX_LINES));
  });

  // The backfill pass keeps later short entries after an earlier long one is
  // refused, so a caller must not infer the drop set from the tail.
  it('reports a non-tail drop when backfill keeps a later short entry', () => {
    const long = 'a'.repeat(24_600);
    const middle = 'b'.repeat(300);
    const short = 'c'.repeat(150);
    const result = trimIndexToBudgetDetailed([long, middle, short]);
    expect(result.content).toBe(`${long}\n${short}`);
    expect(result.dropped).toEqual([middle]);
  });

  it('preserves native entries ahead of imports and reports the dropped imports', () => {
    const native = 'n'.repeat(24_600);
    const imports = ['a', 'b', 'c', 'd'].map((value) => value.repeat(150));
    const lines = [native, ...imports];
    const result = trimIndexToBudgetDetailed(lines, 1);

    expect(result.content).toBe([native, ...imports.slice(0, 2)].join('\n'));
    expect(result.dropped).toEqual(imports.slice(2));
    expect(trimIndexToBudget(lines, 1)).toBe(result.content);
  });

  it('leaves trimIndexToBudget as the content-only projection', () => {
    const lines = Array.from(
      { length: MAX_INDEX_LINES + 1 },
      (_, i) => `- [Note ${i}](notes/${i}.md)`,
    );
    expect(trimIndexToBudget(lines)).toBe(
      trimIndexToBudgetDetailed(lines).content,
    );
  });
});

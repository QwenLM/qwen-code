/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it } from 'vitest';
import sliceAnsi from './sliceAnsi.js';

describe('sliceAnsi', () => {
  it('slices plain text and handles empty or out-of-range bounds', () => {
    expect(sliceAnsi('', 0)).toBe('');
    expect(sliceAnsi('abcdef', 1, 4)).toBe('bcd');
    expect(sliceAnsi('abcdef', -2, 2)).toBe('ab');
    expect(sliceAnsi('abcdef', 2, 99)).toBe('cdef');
    expect(sliceAnsi('abcdef', 10)).toBe('');
  });

  it('replays a style active at the slice start', () => {
    expect(sliceAnsi('\x1b[31mhello\x1b[0m', 1, 4)).toBe(
      '\x1b[31mell',
    );
  });

  it('preserves resets and consecutive active styles', () => {
    expect(sliceAnsi('\x1b[31mab\x1b[0mcd', 1, 3)).toBe(
      '\x1b[31mb\x1b[0mc',
    );
    expect(sliceAnsi('\x1b[1m\x1b[4mhello\x1b[0m', 2, 4)).toBe(
      '\x1b[1m\x1b[4mll',
    );
  });

  it.each([
    ['3/4-bit foreground', '\x1b[94m', '\x1b[94mb'],
    ['3/4-bit background', '\x1b[104m', '\x1b[104mb'],
    ['256-color foreground', '\x1b[38;5;196m', '\x1b[38;5;196mb'],
    ['true-color background', '\x1b[48;2;1;2;3m', '\x1b[48;2;1;2;3mb'],
  ])('preserves %s styles', (_name, style, expected) => {
    expect(sliceAnsi(`${style}abc\x1b[0m`, 1, 2)).toBe(expected);
  });

  it('keeps unrecognized escape sequences as visible code units', () => {
    const input = 'a\x1b[?25lb\x1b[31mc\x1b[0m';

    expect(sliceAnsi(input, 0)).toBe(input);
    expect(sliceAnsi(input, 1, 7)).toBe('\x1b[?25l');
  });

  it('keeps the existing UTF-16 code-unit slicing semantics', () => {
    expect(sliceAnsi('A😀中B', 1, 3)).toBe('😀');
    expect(sliceAnsi('A😀中B', 3, 4)).toBe('中');
  });

  it('does not leak sticky regex state between calls', () => {
    expect(sliceAnsi('\x1b[31mred\x1b[0m', 1, 2)).toBe('\x1b[31me');
    expect(sliceAnsi('plain', 1, 4)).toBe('lai');
    expect(sliceAnsi('\x1b[?25ltext', 0)).toBe('\x1b[?25ltext');
    expect(sliceAnsi('\x1b[32mok\x1b[0m', 0, 2)).toBe(
      '\x1b[32mok\x1b[0m',
    );
  });

  it('slices a 256 KiB styled line within the regression budget', () => {
    const visibleLength = 256 * 1024;
    const input = `\x1b[31m${'x'.repeat(visibleLength)}\x1b[0m`;
    const start = performance.now();

    const result = sliceAnsi(input, 0, visibleLength);
    const elapsed = performance.now() - start;

    expect(result).toBe(input);
    expect(elapsed).toBeLessThan(1500);
  });
});

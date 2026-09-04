/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  findInlineMathExpressions,
  INLINE_MATH_MAX_CHARS,
  readInlineMathSpanAt,
  unescapeMarkdownBeforeMath,
  unescapeMarkdownDollars,
} from './inline-math.js';

describe('inline math recognition', () => {
  it('recognizes single-character and CJK-adjacent formulas', () => {
    expect(findInlineMathExpressions('Values $x$、$α$。')).toEqual(['x', 'α']);
  });

  it('preserves escaped dollars, prices, variables, and adjacent spans', () => {
    expect(
      findInlineMathExpressions(String.raw`Literal \$xy$ and \$\alpha$`),
    ).toEqual([]);
    expect(findInlineMathExpressions('Price $20 and $30')).toEqual([]);
    expect(findInlineMathExpressions('Use $HOME and ${PATH}')).toEqual([]);
    expect(findInlineMathExpressions('$a$$b$')).toEqual([]);
  });

  it('rejects formulas whose closing dollar is escaped', () => {
    expect(findInlineMathExpressions(String.raw`A $x\$ B`)).toEqual([]);
    expect(findInlineMathExpressions(String.raw`Total $a b\$ end`)).toEqual([]);
  });

  it('recognizes literal dollars inside and next to formulas', () => {
    expect(findInlineMathExpressions(String.raw`Formula $x + \$5$`)).toEqual([
      String.raw`x + \$5`,
    ]);
    expect(
      findInlineMathExpressions(String.raw`Literal then math: \$$x^2$`),
    ).toEqual(['x^2']);
    expect(
      findInlineMathExpressions(String.raw`Math then literal: $x^2\$$`),
    ).toEqual([String.raw`x^2\$`]);
  });

  it('uses the full backslash-run parity around delimiters', () => {
    expect(findInlineMathExpressions(String.raw`Odd \$x$; even \\$y$`)).toEqual(
      ['y'],
    );
    expect(findInlineMathExpressions(String.raw`Odd $x\$; even $y\\$`)).toEqual(
      [String.raw`y\\`],
    );
  });

  it('ignores inline code spans and unclosed formulas', () => {
    expect(findInlineMathExpressions('Use `$xy$` then $z$ and $open')).toEqual([
      'z',
    ]);
    expect(findInlineMathExpressions('Use ``a `$x$` b`` then $y$')).toEqual([
      'y',
    ]);
    expect(findInlineMathExpressions('Use `a `` $x$ `` b` then $y$')).toEqual([
      'y',
    ]);
  });

  it('bounds formula length', () => {
    const maximum = 'x'.repeat(INLINE_MATH_MAX_CHARS);
    const tooLong = 'x'.repeat(INLINE_MATH_MAX_CHARS + 1);

    expect(findInlineMathExpressions(`$${maximum}$`)).toHaveLength(1);
    expect(findInlineMathExpressions(`$${tooLong}$`)).toEqual([]);
  });

  it('reads a span only at the requested offset', () => {
    expect(readInlineMathSpanAt('A $x$ B', 2)).toBe('$x$');
    expect(readInlineMathSpanAt(String.raw`A \$x$ B`, 3)).toBeNull();
    expect(readInlineMathSpanAt(String.raw`\$$x$`, 2)).toBe('$x$');
  });

  it('removes Markdown escaping from literal dollars by parity', () => {
    expect(unescapeMarkdownDollars(String.raw`\$ \\$ \\\$`)).toBe(
      String.raw`$ \$ \$`,
    );
    expect(unescapeMarkdownBeforeMath(String.raw`prefix \\`)).toBe('prefix \\');
  });
});

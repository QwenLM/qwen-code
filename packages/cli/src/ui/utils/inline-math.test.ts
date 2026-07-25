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
  });
});

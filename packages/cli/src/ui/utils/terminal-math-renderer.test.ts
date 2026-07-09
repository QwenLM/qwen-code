/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  renderInlineMathInText,
  renderTerminalMathBlock,
  renderTerminalMathInline,
  splitInlineMathSegments,
} from './terminal-math-renderer.js';

describe('TerminalMathRenderer', () => {
  it('renders common inline symbols and scripts as terminal text', () => {
    expect(renderTerminalMathInline('\\partial_t u = \\Delta u + \\xi')).toBe(
      '∂ₜ u = Δ u + ξ',
    );
    expect(renderTerminalMathInline('E = mc^2')).toBe('E = mc²');
    expect(renderTerminalMathInline('\\alpha + \\beta \\leq \\gamma')).toBe(
      'α + β ≤ γ',
    );
  });

  it('renders fractions as stacked terminal blocks', () => {
    expect(renderTerminalMathBlock('\\frac{a+b}{c+d}')).toEqual([
      'a+b',
      '───',
      'c+d',
    ]);
  });

  it('renders large operators with limits in block layout', () => {
    expect(renderTerminalMathBlock('\\sum_{i=1}^n x_i')).toEqual([
      ' n    ',
      ' ∑  xᵢ',
      'i=1   ',
    ]);
    expect(renderTerminalMathBlock('\\sum_{i=1}')).toEqual([' ∑ ', 'i=1']);
    expect(renderTerminalMathBlock('\\sum^n')).toEqual(['n', '∑']);
    expect(renderTerminalMathInline('\\int_0^1 f(x) dx')).toBe('∫₀¹ f(x) dx');
  });

  it('renders matrix environments with terminal fences', () => {
    expect(
      renderTerminalMathBlock(
        '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
      ),
    ).toEqual(['⎛ a  b ⎞', '⎝ c  d ⎠']);
    expect(
      renderTerminalMathBlock(
        '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
      ),
    ).toEqual(['⎡ a  b ⎤', '⎣ c  d ⎦']);
    expect(
      renderTerminalMathBlock(
        '\\begin{Bmatrix} a & b \\\\ c & d \\end{Bmatrix}',
      ),
    ).toEqual(['⎧ a  b ⎫', '⎩ c  d ⎭']);
    expect(
      renderTerminalMathBlock(
        '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}',
      ),
    ).toEqual(['│ a  b │', '│ c  d │']);
    expect(
      renderTerminalMathBlock(
        '\\begin{Vmatrix} a & b \\\\ c & d \\end{Vmatrix}',
      ),
    ).toEqual(['║ a  b ║', '║ c  d ║']);
  });

  it('keeps nested same-name environments together', () => {
    expect(
      renderTerminalMathBlock(
        [
          '\\begin{pmatrix}',
          '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} & e',
          '\\end{pmatrix}',
        ].join(' '),
      ),
    ).toEqual(['⎛ ⎛ a  b ⎞    ⎞', '⎝ ⎝ c  d ⎠  e ⎠']);
  });

  it('does not confuse starred and non-starred environments', () => {
    expect(
      renderTerminalMathBlock(
        [
          '\\begin{pmatrix}',
          '\\begin{pmatrix*} a & b \\\\ c & d \\end{pmatrix*} & e',
          '\\end{pmatrix}',
        ].join(' '),
      ),
    ).toEqual(['⎛ ⎛ a  b ⎞    ⎞', '⎝ ⎝ c  d ⎠  e ⎠']);
  });

  it('keeps empty matrix cells from adding extra rows', () => {
    expect(
      renderTerminalMathBlock('\\begin{pmatrix} a & \\\\ c & d \\end{pmatrix}'),
    ).toEqual(['⎛ a    ⎞', '⎝ c  d ⎠']);
  });

  it('renders cases environments with a left brace', () => {
    expect(
      renderTerminalMathBlock(
        '\\begin{cases} x^2 & x \\geq 0 \\\\ -x & x < 0 \\end{cases}',
      ),
    ).toEqual(['⎧ x²  x ≥ 0', '⎩ -x  x < 0']);
  });

  it('renders underlines and scaled left/right delimiters', () => {
    expect(renderTerminalMathInline('\\underline{x}')).toBe('x̲');
    expect(renderTerminalMathBlock('\\underline{\\frac{a}{b}}')).toEqual([
      'a',
      '─',
      'b',
      '─',
    ]);
    expect(renderTerminalMathBlock('\\overline{x}')).toEqual(['─', 'x']);
    expect(renderTerminalMathBlock('\\left(\\frac{a}{b}\\right)')).toEqual([
      '⎛ a ⎞',
      '⎜ ─ ⎟',
      '⎝ b ⎠',
    ]);
    expect(renderTerminalMathInline('\\left\\| x \\right\\|')).toBe('‖x‖');
    expect(renderTerminalMathBlock('\\left]\\frac{a}{b}\\right[')).toEqual([
      '⎤ a ⎡',
      '⎥ ─ ⎢',
      '⎦ b ⎣',
    ]);
  });

  it('renders additional command forms covered by the parser', () => {
    expect(renderTerminalMathInline('x^{A}')).toBe('x^{A}');
    expect(renderTerminalMathInline('x_i_j')).toBe('xᵢ_j');
    expect(renderTerminalMathBlock('\\frac{a}{b}^2')).toEqual([
      'a    ',
      '─^{2}',
      'b    ',
    ]);
    expect(renderTerminalMathInline('\\sqrt[3]{x}')).toBe('³√(x)');
    expect(renderTerminalMathBlock('\\binom{n}{k}')).toEqual([
      '⎛ n ⎞',
      '⎜ ─ ⎟',
      '⎝ k ⎠',
    ]);
    expect(renderTerminalMathBlock('\\hat{\\frac{a}{b}}')).toEqual([
      '^',
      'a',
      '─',
      'b',
    ]);
    expect(renderTerminalMathInline('\\bar{x}')).toBe('x̄');
    expect(renderTerminalMathInline('\\vec{x}')).toBe('x⃗');
    expect(renderTerminalMathInline('\\dot{x}')).toBe('ẋ');
    expect(renderTerminalMathInline('\\ddot{x}')).toBe('ẍ');
    expect(renderTerminalMathInline('\\tilde{x}')).toBe('x̃');
    expect(
      renderTerminalMathInline('\\text{hello} + \\mathrm{R} + \\mathbf{x}'),
    ).toBe('hello + R + x');
    expect(renderTerminalMathInline('\\text{a\u009bb\u009cc}')).toBe('abc');
    expect(renderTerminalMathInline('a \\quad b')).toBe('a      b');
  });

  it('ignores environment and row markers inside groups', () => {
    expect(
      renderTerminalMathBlock(
        '\\begin{array}{cc} \\text{a & b} & c \\\\ d & e \\end{array}',
      ),
    ).toEqual(['a & b  c', 'd      e']);
    expect(
      renderTerminalMathBlock(
        '\\begin{array}{c} \\text{\\end{array}} \\\\ x \\end{array}',
      ),
    ).toEqual(['\\end{array}', 'x          ']);
  });

  it('consumes column specs for array-style environments', () => {
    expect(
      renderTerminalMathBlock(
        '\\begin{array}{cc} a & b \\\\ c & d \\end{array}',
      ),
    ).toEqual(['a  b', 'c  d']);
  });

  it('splits inline math while leaving prices and shell variables alone', () => {
    expect(renderInlineMathInText('Energy $E = mc^2$')).toBe('Energy E = mc²');
    expect(renderInlineMathInText('Use \\(E = mc^2\\) now')).toBe(
      'Use E = mc² now',
    );
    expect(renderInlineMathInText('Function $f(x)$ and spaced $ x $')).toBe(
      'Function f(x) and spaced x',
    );
    expect(renderInlineMathInText('Price is $20 and $30')).toBe(
      'Price is $20 and $30',
    );
    expect(splitInlineMathSegments('Use $PATH as-is')).toEqual([
      { type: 'text', text: 'Use $PATH as-is' },
    ]);
    expect(splitInlineMathSegments('Cost \\$20 and $E=mc^2$')).toEqual([
      { type: 'text', text: 'Cost \\$20 and ' },
      { type: 'math', text: 'E=mc^2', raw: '$E=mc^2$' },
    ]);
    expect(splitInlineMathSegments('$a$$b$')).toEqual([
      { type: 'text', text: '$a$$b$' },
    ]);
    expect(renderInlineMathInText('bad $\\left( x$ ok')).toBe(
      'bad $\\left( x$ ok',
    );
  });

  it('throws a controlled error for deeply nested groups', () => {
    const nested = '{'.repeat(160) + 'x' + '}'.repeat(160);

    expect(() => renderTerminalMathInline(nested)).toThrow(
      'Maximum TeX parse depth exceeded',
    );
  });

  it('throws controlled errors for unclosed paired constructs', () => {
    expect(() => renderTerminalMathInline('\\left( x')).toThrow(
      'Missing \\right delimiter',
    );
    expect(() => renderTerminalMathBlock('\\begin{pmatrix} a & b')).toThrow(
      'Missing \\end{pmatrix}',
    );
  });
});

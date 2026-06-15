/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderBlockLatex, renderInlineLatex } from './latexRenderer.js';

describe('latexRenderer', () => {
  it('renders common fractions, roots, scripts, and symbols', () => {
    expect(renderInlineLatex(String.raw`\frac{a}{b} + \sqrt{x^2}`)).toBe(
      '(a)/(b) + √(x²)',
    );
    expect(renderInlineLatex(String.raw`\sum_{i=1}^{n} x_i`)).toBe(
      '∑_i=1^n xᵢ',
    );
  });

  it('renders nested fractions and invisible left/right delimiters', () => {
    expect(renderInlineLatex(String.raw`\frac{\frac{1}{2}}{3}`)).toBe(
      '((1)/(2))/(3)',
    );
    expect(renderInlineLatex(String.raw`\left.\frac{a}{b}\right.`)).toBe(
      '(a)/(b)',
    );
  });

  it('renders block fractions with terminal layout', () => {
    expect(
      renderBlockLatex(String.raw`\frac{\partial_t u}{\Delta u + \xi}`),
    ).toEqual([' ∂ₜ u  ', '───────', 'Δ u + ξ']);
  });

  it('preserves unknown commands instead of stripping command markers', () => {
    expect(renderInlineLatex(String.raw`\mathcal{O}(n)`)).toBe(
      String.raw`\mathcal{O}(n)`,
    );
    expect(renderInlineLatex(String.raw`\mathbb{E}[X]`)).toBe(
      String.raw`\mathbb{E}[X]`,
    );
  });

  it('bounds nested command rendering depth', () => {
    const nested = String.raw`\frac{`.repeat(20) + 'x' + '}{1}'.repeat(20);

    expect(() => renderInlineLatex(nested)).not.toThrow();
    expect(renderInlineLatex(nested)).toContain('x');
  });

  it('falls back instead of throwing when terminal parsing is too deep', () => {
    const nested = '{'.repeat(160) + 'x' + '}'.repeat(160);

    expect(() => renderInlineLatex(nested)).not.toThrow();
    expect(renderInlineLatex(nested)).toContain('x');
  });
});

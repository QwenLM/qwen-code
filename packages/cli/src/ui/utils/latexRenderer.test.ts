/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderInlineLatex } from './latexRenderer.js';

describe('latexRenderer', () => {
  it('renders common fractions, roots, scripts, and symbols', () => {
    expect(renderInlineLatex(String.raw`\frac{a}{b} + \sqrt{x^2}`)).toBe(
      'a/b + √(x²)',
    );
    expect(renderInlineLatex(String.raw`\sum_{i=1}^{n} x_i`)).toBe('Σᵢ₌₁ⁿ xᵢ');
  });

  it('preserves unknown commands instead of stripping command markers', () => {
    expect(renderInlineLatex(String.raw`\mathcal{O}(n)`)).toBe(
      String.raw`\mathcal{O}(n)`,
    );
    expect(renderInlineLatex(String.raw`\mathbb{E}[X]`)).toBe(
      String.raw`\mathbb{E}[X]`,
    );
  });
});

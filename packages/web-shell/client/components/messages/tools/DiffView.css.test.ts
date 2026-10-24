/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// jsdom does not compute the cascade, so pin the stylesheet's source shape
// instead. The transcript keeps the 400px line cap; only the floating
// approval card opts out through .linesFill, which must win by source order
// (equal specificity with .lines).
const css = readFileSync(
  fileURLToPath(new URL('./DiffView.module.css', import.meta.url)),
  'utf8',
);
const root = postcss.parse(css);

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

function declarations(rule: Rule): string[] {
  return (rule.nodes ?? [])
    .filter((node: ChildNode) => node.type !== 'comment')
    .map((node: ChildNode) =>
      node.type === 'decl'
        ? `${node.prop}: ${node.value}${node.important ? ' !important' : ''}`
        : `<nested ${node.type}>`,
    );
}

function find(selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.map(tidy).includes(selector)) found.push(rule);
  });
  return found;
}

describe('DiffView line list caps', () => {
  it('keeps the transcript cap on .lines', () => {
    const rules = find('.lines');
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0]!)).toEqual([
      'max-height: 400px',
      'overflow-y: auto',
    ]);
  });

  it('adds .linesFill and lets it win by source order', () => {
    const rules = find('.linesFill');
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0]!)).toEqual([
      'max-height: none',
      'overflow-y: visible',
    ]);
    expect(css.indexOf('.linesFill')).toBeGreaterThan(css.indexOf('.lines'));
  });
});

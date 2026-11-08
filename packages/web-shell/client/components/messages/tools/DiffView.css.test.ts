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
// instead. The transcript keeps the 400px line cap; the floating approval
// card opts out through .lines.linesFill, which wins by specificity (two
// classes against .lines' one) regardless of file position.
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

  it('opts the line list out of the cap with a two-class selector', () => {
    const rules = find('.lines.linesFill');
    expect(rules).toHaveLength(1);
    // One rule owns the uncapped state: the floating-card opt-out and the
    // document-mode transcript share the same declarations.
    expect(rules[0]!.selectors.map(tidy)).toEqual([
      '.lines.linesFill',
      ":global([data-transcript-render-mode='document']) .lines",
    ]);
    expect(declarations(rules[0]!)).toEqual([
      'max-height: none',
      'overflow-y: visible',
    ]);
  });
});

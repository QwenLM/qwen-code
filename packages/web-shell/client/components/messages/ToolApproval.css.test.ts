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
// instead. A disabled option used to be styled only inside a goal approval,
// so a Managed approval the viewer cannot answer looked exactly like a live
// one while every click was silently swallowed.
const css = readFileSync(
  fileURLToPath(new URL('./ToolApproval.module.css', import.meta.url)),
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
        : // Nested rules would hide declarations from a flat reading.
          `<nested ${node.type}>`,
    );
}

function find(selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.map(tidy).includes(selector)) found.push(rule);
  });
  return found;
}

describe('ToolApproval disabled options', () => {
  it('dims every disabled option and marks it unclickable', () => {
    const rules = find('.option:disabled');
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0]!)).toEqual([
      'opacity: 0.5',
      'cursor: not-allowed',
    ]);
    // Not switched off from further out: no enclosing at-rule guards it.
    for (let node = rules[0]!.parent; node; node = node.parent) {
      expect(node.type).not.toBe('atrule');
    }
  });

  it('wins over the hover dim by source order and leaves the goal variant intact', () => {
    expect(find('.option:hover')).toHaveLength(1);
    // `.option:hover` and `.option:disabled` share one class and one
    // pseudo-class of specificity, so the later rule decides how a disabled
    // option looks when the pointer rests on it.
    expect(css.indexOf('.option:disabled')).toBeGreaterThan(
      css.indexOf('.option:hover'),
    );
    // The goal variant keeps its own, more specific rule.
    const goal = find('.goalApproval .option:disabled');
    expect(goal).toHaveLength(1);
    expect(declarations(goal[0]!)).toEqual(['opacity: 0.5', 'cursor: default']);
  });
});

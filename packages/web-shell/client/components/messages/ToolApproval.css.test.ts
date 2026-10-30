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

describe('ToolApproval floating scroll layout', () => {
  // Regression guard for the nested-scrollbar bug: the floating sheet used to
  // stack three scroll containers (sheet, 300px content cap, 400px diff-line
  // cap). The command/content region absorbs the overflow and scrolls itself so
  // the decision buttons stay pinned; the sheet scrolls only as a fallback.
  it('keeps a sheet-level scroll fallback for unshrinkable chrome', () => {
    const rules = find('.floating');
    expect(rules).toHaveLength(1);
    const props = rules[0]!.nodes
      ?.filter((node: ChildNode) => node.type === 'decl')
      .map((node: { prop: string }) => node.prop);
    expect(props).toContain('overflow-y');
    const overflowY = rules[0]!.nodes
      ?.filter((node: ChildNode) => node.type === 'decl')
      .find((node: { prop: string }) => node.prop === 'overflow-y') as {
      value: string;
    };
    // Header, description, explain row and options never shrink. When they
    // alone (plus the region floors) exceed the min(360px, 55vh) cap on a short
    // viewport, a non-scrolling sheet would clip the decision buttons with no
    // way to reach them by pointer or touch.
    expect(overflowY.value).toBe('auto');
  });

  it('makes the content and command regions the sheet scroll container', () => {
    const rules = find('.floating > .content:not(.planContent)');
    expect(rules).toHaveLength(1);
    // One rule carries both selectors — the text/diff wrapper and the
    // exec-command wrapper scroll identically.
    expect(rules[0]!.selectors.map(tidy)).toEqual([
      '.floating > .content:not(.planContent)',
      '.floating > .code',
    ]);
    expect(declarations(rules[0]!)).toEqual([
      'flex: 1 1 auto',
      'min-height: 3.5em',
      'overflow-y: auto',
    ]);
    // Both selectors match every co-rendered region (a warning block next to
    // the diff, the warnings next to a command), so the floor must equal the
    // inline variant's: `min-height: 0` let a short warning or command shrink
    // to a sliver, or to nothing, while digit-confirm still fired.
    const inlineFloor = declarations(find('.content')[0]!).find((decl) =>
      decl.startsWith('min-height:'),
    );
    expect(inlineFloor).toBe('min-height: 3.5em');
    expect(declarations(find('.code')[0]!)).toContain(inlineFloor);
    // .planContent (the plan-approval text under .floatingWorkflow) keeps its
    // own 240px layout — the :not() guard is load-bearing.
    expect(rules[0]!.selectors[0]).toContain(':not(.planContent)');
  });

  it('lifts the command block cap and self-scroll inside the sheet only', () => {
    const rules = find('.floating .codeBlock');
    expect(rules).toHaveLength(1);
    // The base .codeBlock keeps overflow-y: auto, so the override must
    // release the self-scroll too: with only the cap lifted, the <pre> stays
    // its own scroller when the region is squeezed.
    expect(declarations(rules[0]!)).toEqual([
      'max-height: none',
      'overflow-y: visible',
    ]);
  });

  it('leaves the inline variant caps intact', () => {
    const content = find('.content');
    expect(content).toHaveLength(1);
    const contentDecls = declarations(content[0]!);
    expect(contentDecls).toContain('max-height: 300px');
    expect(contentDecls).toContain('overflow-y: auto');
    const codeBlock = find('.codeBlock');
    expect(codeBlock).toHaveLength(1);
    const codeBlockDecls = declarations(codeBlock[0]!);
    expect(codeBlockDecls).toContain('max-height: 300px');
    expect(codeBlockDecls).toContain('overflow-y: auto');
  });
});

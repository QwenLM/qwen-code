// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import postcss, { type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { describe, expect, it } from 'vitest';
import { DiffView } from './DiffView';
import styles from './DiffView.module.css';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'DiffView.module.css'),
  'utf8',
);
const root = postcss.parse(css);

function find(selector: string): Rule {
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.includes(selector)) rules.push(rule);
  });
  expect(rules).toHaveLength(1);
  return rules[0]!;
}

function declarations(rule: Rule): string[] {
  return rule.nodes
    .filter((node) => node.type !== 'comment')
    .map((node) =>
      node.type === 'decl'
        ? `${node.prop}: ${node.value}${node.important ? ' !important' : ''}`
        : `<nested ${node.type}>`,
    );
}

describe('DiffView text wrapping styles', () => {
  it('preserves whitespace and wraps unbroken paths with no later override', () => {
    const rules: Rule[] = [];
    root.walkRules((rule) => {
      let targetsContent = false;
      selectorParser((selectors) => {
        selectors.walkClasses((node) => {
          if (node.value === 'content') targetsContent = true;
        });
      }).processSync(rule.selector);
      if (targetsContent) rules.push(rule);
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector).toBe('.content');
    expect(rules[0]!.parent).toBe(root);
    expect(declarations(rules[0]!)).toEqual([
      'min-width: 0',
      'white-space: pre-wrap',
      'overflow-wrap: anywhere',
    ]);
  });

  it('applies the wrapping class to the rendered diff content', async () => {
    const container = document.createElement('div');
    const reactRoot = createRoot(container);
    try {
      await act(async () => {
        reactRoot.render(
          createElement(DiffView, { diff: '@@ -0,0 +1 @@\n+    long/path' }),
        );
      });
      const content = Array.from(container.querySelectorAll('span')).find(
        (span) => span.textContent === '    long/path',
      );
      expect(content).toBeDefined();
      expect(content!.classList.contains(styles.content)).toBe(true);
    } finally {
      await act(async () => reactRoot.unmount());
    }
  });

  it('lets the diff root shrink with the review panel', () => {
    expect(declarations(find('.view'))).toEqual([
      'margin: 0',
      'overflow: hidden',
      'font-size: 12px',
      'display: flex',
      'flex-direction: column',
      'min-height: 0',
    ]);
  });

  it('keeps the rows scrollable when the available height is below the cap', () => {
    expect(declarations(find('.lines'))).toEqual([
      'max-height: 400px',
      'overflow-y: auto',
      'flex: 1 1 auto',
      'min-height: 0',
    ]);
  });

  it('leaves document transcripts in natural-height flow', () => {
    expect(
      declarations(
        find(":global([data-transcript-render-mode='document']) .lines"),
      ),
    ).toEqual(['max-height: none', 'overflow-y: visible']);
  });
});

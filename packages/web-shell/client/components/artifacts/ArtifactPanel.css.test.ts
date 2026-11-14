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
// instead. A turn with many edits renders one DiffView block per edit inside
// .diffPreview: each block must keep its natural height and the panel must
// scroll, otherwise the default flex-shrink: 1 squeezes every block into a
// few-pixel sliver. .codeMirrorDiffWrap (full-content case) must keep its own
// flex sizing, which requires the > * rule to precede it in file order.
const css = readFileSync(
  fileURLToPath(new URL('./ArtifactPanel.module.css', import.meta.url)),
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

describe('ArtifactPanel review diff preview', () => {
  it('lets .diffPreview scroll vertically instead of clipping', () => {
    const rules = find('.diffPreview');
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0]!)).toEqual([
      'border: 1px solid var(--border)',
      'overflow-y: auto',
      'overflow-x: hidden',
      'background: var(--muted, rgba(0, 0, 0, 0.03))',
      'min-height: 0',
      'flex: 1 1 0',
      'display: flex',
      'flex-direction: column',
    ]);
  });

  it('pins direct children at natural height with a single dedicated rule', () => {
    const rules = find('.diffPreview > *');
    expect(rules).toHaveLength(1);
    expect(declarations(rules[0]!)).toEqual(['flex-shrink: 0']);
  });

  it('declares the > * rule before .codeMirrorDiffWrap so its flex sizing wins', () => {
    const childRule = find('.diffPreview > *')[0]!;
    const cmRules = find('.codeMirrorDiffWrap');
    expect(cmRules).toHaveLength(1);
    expect(childRule.source?.line ?? -1).toBeLessThan(
      cmRules[0]!.source?.line ?? Number.POSITIVE_INFINITY,
    );
  });
});

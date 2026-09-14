/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { render } from 'ink-testing-library';
import { describe, it, expect, beforeEach } from 'vitest';
import { SuggestionsDisplay } from './SuggestionsDisplay.js';
import { setLanguageAsync } from '../../i18n/index.js';

describe('SuggestionsDisplay with qualified extension labels', () => {
  beforeEach(async () => {
    await setLanguageAsync('en');
  });

  // Qualified names plus owner badges overflow the half-width label column at
  // common terminal widths. The row must stay one line, truncating the
  // badge, never wrapping it into the leftover sliver one character per
  // line (the regression this pins).
  it('keeps each row on one line when name plus owner badge exceed the column', () => {
    const desc = 'MUST use when reviewing or writing rust code';
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[
          {
            label: 'rust:functions',
            value: 'rust:functions',
            sourceBadge: '[Extension: rust]',
            description: desc,
          },
          {
            label: 'rust:function-item-types',
            value: 'rust:function-item-types',
            sourceBadge: '[Extension: rust]',
            description: desc,
          },
          {
            label: 'tailwindcss:functions-and-directives',
            value: 'tailwindcss:functions-and-directives',
            sourceBadge: '[Extension: tailwindcss]',
            description: 'MUST use when writing Tailwind directives',
          },
          {
            label: 'rust:trait-and-lifetime-bounds',
            value: 'rust:trait-and-lifetime-bounds',
            sourceBadge: '[Extension: rust]',
            description: desc,
          },
          {
            label: 'superpowers:functions',
            value: 'superpowers:functions',
            sourceBadge: '[Extension: Superpowers — develo…]',
            description: desc,
          },
          {
            label: 'refresh-plugins',
            value: 'refresh-plugins',
            sourceBadge: '[User]',
            description: 'Use when refreshing explicitly selected plugins',
          },
        ]}
        activeIndex={0}
        isLoading={false}
        width={90}
        scrollOffset={0}
        userInput="/fun"
        mode="slash"
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame.trim().split('\n')).toHaveLength(6);
    expect(frame).toContain('rust:functions [Extension: rust]');
    // A wrapped badge leaves orphan fragments on their own lines.
    expect(frame).not.toMatch(/^\s*css\]$/m);
    expect(frame).not.toMatch(/^\s*rust\]$/m);
  });
});

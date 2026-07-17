/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { render } from 'ink-testing-library';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  SuggestionsDisplay,
  normalizeDescription,
} from './SuggestionsDisplay.js';
import { setLanguageAsync } from '../../i18n/index.js';

describe('SuggestionsDisplay', () => {
  beforeEach(async () => {
    await setLanguageAsync('en');
  });

  afterAll(async () => {
    await setLanguageAsync('en');
  });

  it('renders localized loading text in zh', async () => {
    await setLanguageAsync('zh');

    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[]}
        activeIndex={0}
        isLoading={true}
        width={80}
        scrollOffset={0}
        userInput="/"
        mode="slash"
      />,
    );

    expect(lastFrame()).toContain('正在加载建议...');
  });

  it('truncates long slash command descriptions to a single line by default', () => {
    const description =
      'This long command description should be truncated to a single line so it cannot fill the entire terminal window.';
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[
          {
            label: 'review',
            value: 'review',
            description,
          },
        ]}
        activeIndex={0}
        isLoading={false}
        width={40}
        scrollOffset={0}
        userInput="/re"
        mode="slash"
      />,
    );

    const output = lastFrame() ?? '';

    // The description is cut off with an ellipsis and the full text is gone.
    expect(output).toContain('…');
    expect(output).not.toContain('entire terminal window');
    // A single suggestion with a long description must not blow up vertically.
    expect(output.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('keeps the full MCP resource reference on one line and truncates its description (reverse mode)', () => {
    // Two resources that share a long `server:scheme://` prefix and differ only
    // in the tail — the discriminating part. The reference (label) must stay
    // intact on a single line so the two rows are distinguishable; the
    // description yields the width and truncates instead.
    const a = 'asys-mcp-http:asight://skills/ppu_bubble_analysis';
    const b = 'asys-mcp-http:asight://skills/ppu_operator_performance';
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[
          {
            label: a,
            value: a,
            description:
              'Analyze PPU bubble (idle time) from a loaded trace report.',
          },
          {
            label: b,
            value: b,
            description:
              'Analyze PPU operator performance from a loaded trace report.',
          },
        ]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput="asys-mcp-http:asight"
        mode="reverse"
      />,
    );

    const output = lastFrame() ?? '';
    // Each full reference appears verbatim (the tail is NOT truncated away), so
    // the two rows can be told apart.
    expect(output).toContain(a);
    expect(output).toContain(b);
    // The description is what gets cut — its tail must be gone, ellipsized.
    expect(output).toContain('…');
    expect(output).not.toContain('loaded trace report.');
    // One visible row per suggestion: the label is not wrapped onto extra lines.
    expect(
      output.split('\n').filter((l) => l.includes('asys-mcp-http:')),
    ).toHaveLength(2);
  });

  it('collapses newlines in multi-line descriptions so a row stays one line', () => {
    const description = [
      'First line of the skill description.',
      '',
      '- bullet one',
      '- bullet two',
    ].join('\n');
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[{ label: 'skill', value: 'skill', description }]}
        activeIndex={0}
        isLoading={false}
        width={120}
        scrollOffset={0}
        userInput="/sk"
        mode="slash"
      />,
    );

    const output = lastFrame() ?? '';
    // The verbatim multi-line layout (with the blank line / bullets stacked)
    // must not appear; everything collapses onto the single command row.
    expect(output).not.toContain('\n\n');
    expect(output).toContain('First line of the skill description.');
    expect(output).toContain('- bullet one - bullet two');
  });

  it('renders a visible marker for the active suggestion', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[
          { label: 'pr', value: 'pr', description: 'Pull request helper' },
          {
            label: 'issue-to-pr',
            value: 'issue-to-pr',
            description: 'Issue helper',
          },
        ]}
        activeIndex={1}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput="/pr"
        mode="slash"
      />,
    );

    const lines = (lastFrame() ?? '').split('\n');

    expect(lines[0]).toMatch(/^ {2}pr/);
    expect(lines[1]).toMatch(/^> issue-to-pr/);
  });
});

describe('SuggestionsDisplay tabs', () => {
  const mixed = [
    { label: 'a.ts', value: 'a.ts', category: 'file' as const },
    { label: 'Fix bug', value: 'session:id-1', category: 'session' as const },
  ];

  it('shows a tab bar when multiple categories are present', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={mixed}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        activeCategory="all"
        availableCategories={['all', 'file', 'session']}
      />,
    );
    expect(lastFrame()).toContain('Files');
    expect(lastFrame()).toContain('Sessions');
  });

  it('filters rows to the active category', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={mixed}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        activeCategory="session"
        availableCategories={['all', 'file', 'session']}
      />,
    );
    expect(lastFrame()).toContain('Fix bug');
    expect(lastFrame()).not.toContain('a.ts');
  });

  it('hides the tab bar for single-category (file-only) completion', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay
        suggestions={[mixed[0]]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        activeCategory="all"
        availableCategories={['all', 'file']}
      />,
    );
    expect(lastFrame()).not.toContain('Sessions');
  });
});

describe('normalizeDescription', () => {
  it('collapses all whitespace runs into single spaces and trims', () => {
    expect(normalizeDescription('  a\n\nb\t c  ')).toBe('a b c');
  });
});

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
});

describe('normalizeDescription', () => {
  it('collapses all whitespace runs into single spaces and trims', () => {
    expect(normalizeDescription('  a\n\nb\t c  ')).toBe('a b c');
  });
});

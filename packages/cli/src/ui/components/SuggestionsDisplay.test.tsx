/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { render } from 'ink-testing-library';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { SuggestionsDisplay } from './SuggestionsDisplay.js';
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

  it('wraps long slash command descriptions instead of truncating them', () => {
    const description =
      'This long command description should wrap across multiple lines and remain fully visible in the menu.';
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
    const normalizedOutput = output.replace(/\s+/g, ' ').trim();

    expect(normalizedOutput).toContain(description);
    expect(output.split('\n').length).toBeGreaterThan(1);
  });
});

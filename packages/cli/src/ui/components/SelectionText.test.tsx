/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { Box, Text } from 'ink';
import { render } from '../../test-utils/render.js';
import { themeManager } from '../themes/theme-manager.js';
import { SelectionText } from './SelectionText.js';

// The suite-wide tokenizer shim discards ANSI styles. Use the real tokenizer
// here so the SVG assertions verify actual colors rather than plain text.
vi.mock(
  '@alcalzone/ansi-tokenize',
  async () =>
    import(
      /* @vite-ignore */ new URL(
        '../../../../../node_modules/@alcalzone/ansi-tokenize/build/index.js',
        import.meta.url,
      ).href
    ),
);

const originalTheme = themeManager.getThemeName();
const originalColorLevel = chalk.level;

beforeEach(() => {
  chalk.level = 3;
});

afterEach(() => {
  themeManager.setActiveTheme(originalTheme);
  chalk.level = originalColorLevel;
});

describe('selection emphasis', () => {
  it.each(['Qwen Light', 'Qwen Dark'])(
    'renders blue-purple prompts and inline icons in %s',
    async (name) => {
      themeManager.setActiveTheme(name);
      const result = await render(
        <Box flexDirection="column">
          <SelectionText bold>[+] Add custom model...</SelectionText>
          <SelectionText bold>
            Describe the agent you want to create:
          </SelectionText>
          <Text>
            Selected: <SelectionText>▦</SelectionText> 1M ·{' '}
            <SelectionText>✦</SelectionText> Low (Default)
          </Text>
        </Box>,
      );
      try {
        await result.waitUntilReady();
        expect(result.lastFrame()).toContain('Describe the agent');
        expect(result.lastFrame()).toContain(
          'Selected: ▦ 1M · ✦ Low (Default)',
        );
        const svg = result.generateSvg();
        expect(svg).toContain(name === 'Qwen Light' ? '#4796e4' : '#89b4fa');
        expect(svg).toContain(name === 'Qwen Light' ? '#847ace' : '#cba6f7');
        await expect(result).toMatchSvgSnapshot();
      } finally {
        result.unmount();
      }
    },
  );

  it('preserves the existing success color when the theme has no selection palette', async () => {
    themeManager.setActiveTheme('Default');
    expect(
      themeManager.getSemanticColors().ui.selectionGradient,
    ).toBeUndefined();
    const result = await render(
      <SelectionText bold>
        Describe the agent you want to create:
      </SelectionText>,
    );
    try {
      await result.waitUntilReady();
      expect(result.generateSvg()).toContain(
        themeManager.getSemanticColors().status.success.toLowerCase(),
      );
      await expect(result).toMatchSvgSnapshot();
    } finally {
      result.unmount();
    }
  });
});

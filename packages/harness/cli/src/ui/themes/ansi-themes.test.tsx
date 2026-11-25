/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import chalk from 'chalk';
import { Box, Text } from 'ink';
import { ANSI } from './builtin/dark/ansi-dark.js';
import { ANSILight } from './builtin/light/ansi-light.js';
import { ansiTheme, INK_SUPPORTED_NAMES, Theme } from './theme.js';
import { themeManager } from './theme-manager.js';
import { renderToAnsiString } from '../utils/staticRender.js';
import { ModelSpinner } from '../components/ModelSpinner.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { createMockSettings } from '../../test-utils/settings.js';

// The shared test alias discards colors. Exercise the real ANSI tokenizer.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packageJson = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  return import(new URL('./build/index.js', pathToFileURL(packageJson)).href);
});

// Reflect all fields, including the protected syntax style map, so newly added
// tokens cannot silently reintroduce RGB defaults into a palette-only theme.
function colorEntries(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'name' || key === 'type'
      ? []
      : colorEntries(child, `${path}.${key}`),
  );
}

function expectPaletteOnly(value: unknown): void {
  const entries = colorEntries(value);
  expect(entries.length).toBeGreaterThan(0);
  expect(
    entries.filter(
      ([, color]) => color !== '' && !INK_SUPPORTED_NAMES.has(color),
    ),
  ).toEqual([]);
  expect(entries.filter(([, color]) => /#|rgb|ansi256/i.test(color))).toEqual(
    [],
  );
}

function expectBasicSgr(output: string): void {
  // eslint-disable-next-line no-control-regex -- Inspect actual terminal SGR.
  const sgr = [...output.matchAll(/\x1b\[([\d;]*)m/g)];
  expect(sgr.length).toBeGreaterThan(0);
  for (const [, parameters] of sgr) {
    // 38/48 are extended color introducers (both truecolor and 256-color).
    expect(parameters).not.toMatch(/(?:^|;)(?:38|48)(?:;|$)/);
  }
}

describe('ANSI themes', () => {
  let originalTheme: string;
  let originalBackground: string | undefined;
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalTheme = themeManager.getActiveTheme().name;
    originalBackground = themeManager.getTerminalBackground();
    originalLevel = chalk.level;
    chalk.level = 3;
  });

  afterEach(() => {
    themeManager.setActiveTheme(originalTheme);
    themeManager.setTerminalBackground(originalBackground);
    chalk.level = originalLevel;
  });

  describe.each([ANSI, ANSILight])('$name', (theme) => {
    it('uses only terminal palette slots in every color, semantic token and syntax style', () => {
      expect(theme.type).toBe('ansi');
      expect(theme.colors.type).toBe('ansi');
      expectPaletteOnly(theme);
      expect(theme.defaultColor).toBe('');
      expect(theme.colors.Background).toBe('');
      expect(theme.colors.Foreground).toBe('');
      expect(theme.semanticColors.background.primary).toBe('');
      expect(theme.semanticColors.background.message).toBe('');
      expect(theme.semanticColors.background.focus).toBe('');
      expect(theme.colors.GradientColors).toBeUndefined();
      expect(theme.semanticColors.ui.gradient).toBeUndefined();
    });

    it.each([undefined, '#25272e', '#000000', '#ffffff', '#e8e4db'])(
      'does not mix terminal background %s into either color API',
      (background) => {
        themeManager.setActiveTheme(theme.name);
        themeManager.setTerminalBackground(background);
        expect(themeManager.getColors()).toBe(theme.colors);
        expect(themeManager.getSemanticColors()).toBe(theme.semanticColors);
        expectPaletteOnly(themeManager.getColors());
        expectPaletteOnly(themeManager.getSemanticColors());
      },
    );

    it('keeps the model spinner on a palette color', async () => {
      themeManager.setActiveTheme(theme.name);
      let output = '';
      await act(async () => {
        output = await renderToAnsiString(
          <SettingsContext.Provider value={createMockSettings({})}>
            <ModelSpinner />
          </SettingsContext.Provider>,
        );
      });
      expectBasicSgr(output);
    });

    it.each([1, 2, 3] as const)(
      'emits no extended SGR for any foreground/background at color level %s',
      async (level) => {
        chalk.level = level;
        const colors = [
          ...new Set(colorEntries(theme).map(([, color]) => color)),
        ];
        let output = '';
        await act(async () => {
          output = await renderToAnsiString(
            <Box flexDirection="column">
              {colors.map((color) => (
                <Text key={color} color={color} backgroundColor={color}>
                  palette sample
                </Text>
              ))}
            </Box>,
          );
        });
        expect(output).toContain('palette sample');
        expectBasicSgr(output);
      },
    );
  });

  it('keeps the legacy ANSI Light display name', () => {
    expect(ANSILight.name).toBe('ANSI Light');
  });

  it('does not synthesize RGB when optional ANSI colors are omitted', () => {
    const theme = new Theme(
      'minimal ANSI',
      'ansi',
      {},
      {
        ...ansiTheme,
        // Named nonempty endpoints would normally interpolate into RGB.
        Background: 'black',
        Gray: 'white',
        MessageBackground: undefined,
        FocusBackground: undefined,
        InputBackground: undefined,
        AgentRed: undefined,
        AgentBlue: undefined,
        AgentGreen: undefined,
        AgentYellow: undefined,
        AgentPurple: undefined,
        AgentOrange: undefined,
        AgentPink: undefined,
        AgentCyan: undefined,
        GradientColors: ['cyan', 'green'],
      },
    );
    expectPaletteOnly(theme);
    expect(theme.semanticColors.background.message).toBe('');
    expect(theme.semanticColors.background.focus).toBe('');
    expect(theme.semanticColors.border.input).toBe('');
    expect(theme.semanticColors.ui.gradient).toBeUndefined();
  });
});

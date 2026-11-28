/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, memo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeConfig, type Config } from '@qwen-code/core';
import os from 'node:os';
import chalk from 'chalk';
import { render } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import {
  TerminalProvider,
  useTerminalContext,
} from '../contexts/TerminalContext.js';
import { theme } from '../semantic-colors.js';
import { themeManager } from '../themes/theme-manager.js';
import { useTerminalTheme } from './useTerminalTheme.js';
import { useThemeRevision } from './useThemeRevision.js';

// The shared test alias drops styles; color assertions need the real tokenizer.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packageJson = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  return import(new URL('./build/index.js', pathToFileURL(packageJson)).href);
});

const originalChalkLevel = chalk.level;
const mounted = vi.fn();
const unmounted = vi.fn();
const painted = vi.fn();
const StatefulPanel = memo(() => {
  useThemeRevision();
  const [draft, setDraft] = useState('');
  useInput((input) => setDraft((value) => value + input));
  useEffect(() => {
    mounted();
    return () => { unmounted(); };
  }, []);
  painted();
  return (
    <Box flexDirection="column">
      <Text color={theme.text.primary}>Thinking</Text>
      <Text color={theme.text.primary} backgroundColor={theme.background.message}>
        Draft: {draft}
      </Text>
    </Box>
  );
});

StatefulPanel.displayName = 'StatefulPanel';

let queryBackground: () => Promise<void>;
function Follower({ config }: { config: Config }) {
  const app = useApp();
  const repaint = useCallback(() => app.rerender(), [app]);
  useTerminalTheme(config, repaint);
  queryBackground = useTerminalContext().queryTerminalBackground;
  return <StatefulPanel />;
}

describe('terminal theme rendering', () => {
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', undefined);
    chalk.level = 3;
    themeManager.resetForTesting();
    mounted.mockClear();
    unmounted.mockClear();
    painted.mockClear();
  });

  afterEach(() => {
    chalk.level = originalChalkLevel;
    vi.unstubAllEnvs();
    themeManager.resetForTesting();
  });

  it('recolors a mounted memo subtree from OSC replies without losing input', async () => {
    const config = makeFakeConfig({ targetDir: os.tmpdir() });
    config.setTerminalBackground('#14161e');
    themeManager.setTerminalBackground('#14161e');
    const settings = createMockSettings({
      ui: { theme: 'auto', autoThemeSwitching: true, terminalBackgroundPollingInterval: 60 },
    });
    const view = await render(
      <SettingsContext.Provider value={settings}>
        <TerminalProvider><Follower config={config} /></TerminalProvider>
      </SettingsContext.Provider>,
      40,
      8,
    );
    const report = async (rgb: string) => {
      await act(async () => {
        const pending = queryBackground();
        view.stdin.write(`\x1b]11;${rgb}\x07\x1b[?1;2c`);
        await pending;
      });
      await view.waitUntilReady();
    };
    try {
      await act(async () => {
        // Finish Ink's startup capability batch before sending a color query.
        view.stdin.write('\x1b[?1;2c');
        view.stdin.write('keep my draft');
      });
      await view.waitUntilReady();
      expect(view.lastFrame()).toContain('Draft: keep my draft');
      await expect(view).toMatchSvgSnapshot({ name: 'osc-dark' });

      await report('rgb:ffff/ffff/ffff');
      expect(config.getTerminalBackground()).toBe('#ffffff');
      expect(themeManager.getThemeName()).toBe('Default Light');
      expect(view.generateSvg()).toMatch(/fill="#1a1917"[^>]*>Thinking/);
      expect(view.lastFrame()).toContain('Draft: keep my draft');
      await expect(view).toMatchSvgSnapshot({ name: 'osc-light' });

      await report('rgb:1414/1616/1e1e');
      expect(themeManager.getThemeName()).toBe('Default');
      expect(view.generateSvg()).toMatch(/fill="#eeeeeb"[^>]*>Thinking/);
      expect(view.lastFrame()).toContain('Draft: keep my draft');
      expect(mounted).toHaveBeenCalledOnce();
      expect(unmounted).not.toHaveBeenCalled();
      const paints = painted.mock.calls.length;
      await report('rgb:1414/1616/1e1e');
      expect(painted).toHaveBeenCalledTimes(paints);
    } finally {
      view.unmount();
    }
  });
});

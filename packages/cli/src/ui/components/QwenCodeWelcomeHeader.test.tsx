/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { Box, useApp } from 'ink';
import { act, useEffect, useLayoutEffect, useState } from 'react';
import * as core from '@qwen-code/core';
import {
  persistentStateMock,
  type RenderWithProvidersInstance,
} from '../../test-utils/render.js';
import { theme } from '../semantic-colors.js';
import { createTuiFixture } from '../../test-utils/tuiFixture.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { _clearTipsShownForTest } from '../hooks/useTips.js';
import { UIStateContext, useUIState } from '../contexts/UIStateContext.js';
import { AppHeader } from './AppHeader.js';

// The shared test alias discards ANSI styles. Color assertions need the real parser.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packagePath = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  return import(new URL('./build/index.js', pathToFileURL(packagePath)).href);
});

const { renderWithProviders } = createTuiFixture();

function logoRgbColors(terminal: RenderWithProvidersInstance['terminal']) {
  const colors = new Set<number>();
  const buffer = terminal.buffer.active;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    for (let col = 1; col <= 37; col++) {
      const cell = line?.getCell(col);
      if (cell?.getChars().trim() && cell.isFgRGB()) {
        colors.add(cell.getFgColor());
      }
    }
  }
  return colors;
}

let changeModel: (model: string) => void;
function HeaderWithModel() {
  const [model, setModel] = useState('');
  useEffect(() => {
    changeModel = setModel;
  }, []);
  const state = useUIState();
  return (
    <UIStateContext.Provider value={{ ...state, currentModel: model }}>
      <AppHeader version="2.0.0" />
    </UIStateContext.Provider>
  );
}

describe('QwenCodeWelcomeHeader through AppHeader', () => {
  let previousColorLevel: typeof chalk.level;
  beforeEach(async () => {
    previousColorLevel = chalk.level;
    chalk.level = 3;
    vi.restoreAllMocks();
    persistentStateMock.reset();
    _clearTipsShownForTest();
  });
  afterEach(() => {
    chalk.level = previousColorLevel;
  });

  it.each([120, 85, 84, 60, 40, 39, 24, 23])(
    'renders the complete first frame and remount at %i terminal columns',
    async (width) => {
      const config = core.makeFakeConfig();
      vi.spyOn(config.getModelProviderManager(), 'getModel').mockReturnValue(
        new Promise<never>(() => {}),
      );
      let setScreen!: (screen: string) => void;
      function TranscriptHeader() {
        const [screen, updateScreen] = useState('prompt');
        const { requestTranscriptReplacement } = useApp();
        setScreen = updateScreen;
        useLayoutEffect(() => {
          requestTranscriptReplacement?.();
        }, [screen, requestTranscriptReplacement]);
        return <AppHeader key={screen} version="2.0.0" />;
      }
      const rendered = await renderWithProviders(<TranscriptHeader />, {
        config,
        width,
        uiState: { terminalWidth: width, currentModel: 'unresolved-model' },
      });
      try {
        // Do not settle ResizeObservers: startup and transcript replay must
        // already contain the complete header before any later layout update.
        const expectHeader = () => {
          const frame = rendered.lastFrame();
          expect(frame).toContain('Qwen Code');
          expect(frame.includes('▄▄▄▄▄▄')).toBe(width >= 85);
          expect(frame.includes('╭')).toBe(width >= 24);
          expect(frame.includes('Tips for getting started')).toBe(width >= 40);
          expect(persistentStateMock.set).toHaveBeenCalledTimes(
            width >= 40 ? 1 : 0,
          );
        };
        expectHeader();
        for (const key of ['transcript', 'prompt']) {
          await act(async () => setScreen(key));
          await rendered.waitUntilReady();
          expectHeader();
        }
      } finally {
        rendered.unmount();
      }
    },
  );

  it('updates breakpoints when the terminal width changes', async () => {
    let resize!: (width: number) => void;
    function ResizableHeader() {
      const [width, setWidth] = useState(40);
      const state = useUIState();
      resize = setWidth;
      return (
        <UIStateContext.Provider value={{ ...state, terminalWidth: width }}>
          <Box width={width}>
            <AppHeader version="2.0.0" />
          </Box>
        </UIStateContext.Provider>
      );
    }
    const rendered = await renderWithProviders(<ResizableHeader />, {
      width: 120,
    });
    try {
      expect(rendered.lastFrame()).toContain('Tips for getting started');
      for (const width of [39, 40, 84, 85, 23, 24, 120]) {
        await act(async () => resize(width));
        await rendered.waitUntilReady();
        const frame = rendered.lastFrame();
        expect(frame).toContain('Qwen Code');
        expect(frame.includes('▄▄▄▄▄▄')).toBe(width >= 85);
        expect(frame.includes('╭')).toBe(width >= 24);
        expect(frame.includes('Tips for getting started')).toBe(width >= 40);
      }
      expect(persistentStateMock.set).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
    }
  });

  it('renders the Qwen logo with native RGB gradient colors', async () => {
    const rendered = await renderWithProviders(<AppHeader version="2.0.0" />, {
      width: 120,
      settings: createMockSettings({ ui: { hideTips: true } }),
    });
    try {
      await rendered.settleLayout();
      const colors = logoRgbColors(rendered.terminal);
      expect(colors.size).toBeGreaterThan(10);
      expect(colors.has(0x4796e4)).toBe(true);
      expect(colors.has(0xc3677f)).toBe(true);
    } finally {
      rendered.unmount();
    }
  });

  it.each([
    { name: 'single color', gradient: ['#123456'] },
    { name: 'empty gradient', gradient: [] },
    { name: 'missing gradient', gradient: undefined },
  ])('uses native theme coloring with a $name', async ({ gradient }) => {
    const ui = theme.ui;
    vi.spyOn(theme, 'ui', 'get').mockReturnValue({ ...ui, gradient });
    const rendered = await renderWithProviders(<AppHeader version="2.0.0" />, {
      width: 120,
      settings: createMockSettings({ ui: { hideTips: true } }),
    });
    try {
      await rendered.settleLayout();
      const expected = Number.parseInt(
        (gradient?.[0] ?? theme.text.accent).replace('#', ''),
        16,
      );
      expect(logoRgbColors(rendered.terminal)).toEqual(new Set([expected]));
    } finally {
      rendered.unmount();
    }
  });

  it('respects disabled terminal colors', async () => {
    chalk.level = 0;
    const rendered = await renderWithProviders(<AppHeader version="2.0.0" />, {
      width: 120,
      settings: createMockSettings({ ui: { hideTips: true } }),
    });
    try {
      await rendered.settleLayout();
      expect(rendered.lastFrame()).toContain('Qwen Code');
      expect(logoRgbColors(rendered.terminal).size).toBe(0);
    } finally {
      rendered.unmount();
    }
  });

  it.each([120, 60, 20])(
    'renders the Qwen brand at %i columns',
    async (width) => {
      const config = core.makeFakeConfig();
      vi.spyOn(config, 'getTargetDir').mockReturnValue(
        '/项目/包含 空格的工作目录',
      );
      const rendered = await renderWithProviders(
        <AppHeader version="2.0.0" />,
        {
          config,
          width,
          uiState: { terminalWidth: width, currentModel: 'qwen-code-model' },
          settings: createMockSettings({ ui: { hideTips: true } }),
        },
      );
      try {
        await rendered.settleLayout();
        const frame = rendered.lastFrame();
        expect(frame).toContain('Qwen Code');
        expect(frame).not.toContain('Qoder');
        expect(frame.includes('▄▄▄▄▄▄')).toBe(width >= 85);
        if (width >= 85) {
          expect(frame).toContain('██╔═══██╗██║    ██║██╔════╝████╗  ██║');
        }
        if (width >= 60) {
          expect(frame).toContain('v2.0.0');
          expect(frame).toContain('/项目/包含 空格的工作目录');
        }
        await expect(rendered).toMatchSvgSnapshot();
      } finally {
        rendered.unmount();
      }
    },
  );

  it('keeps the same number of rows as an empty model resolves and changes', async () => {
    const errors = vi
      .spyOn(core.runLogger, 'error')
      .mockImplementation(() => {});
    const config = core.makeFakeConfig();
    vi.spyOn(config, 'getTargetDir').mockReturnValue('C:\\工作 项目\\子目录');
    const rendered = await renderWithProviders(<HeaderWithModel />, {
      config,
      width: 85,
      uiState: { terminalWidth: 85 },
      settings: createMockSettings({ ui: { hideTips: true } }),
    });
    try {
      await rendered.settleLayout();
      const initialRows = rendered.lastFrame().split('\n').length;
      expect(rendered.lastFrame()).toContain('—');
      for (const model of [
        'qwen-first',
        'very-long-custom-model-name-'.repeat(8),
      ]) {
        await act(async () => changeModel(model));
        await rendered.settleLayout();
        expect(errors.mock.calls).toEqual([]);
        expect(rendered.lastFrame().split('\n')).toHaveLength(initialRows);
        expect(rendered.lastFrame()).toContain('C:\\工作 项目\\子目录');
      }
    } finally {
      rendered.unmount();
    }
  });

  it.each([
    {
      width: 120,
      hideBanner: false,
      hideTips: false,
      screenReader: false,
      count: true,
    },
    {
      width: 20,
      hideBanner: false,
      hideTips: false,
      screenReader: false,
      count: false,
    },
    {
      width: 120,
      hideBanner: true,
      hideTips: false,
      screenReader: false,
      count: false,
    },
    {
      width: 120,
      hideBanner: false,
      hideTips: true,
      screenReader: false,
      count: false,
    },
    {
      width: 120,
      hideBanner: false,
      hideTips: false,
      screenReader: true,
      count: false,
    },
  ])(
    'counts tips only when displayed: %j',
    async ({ width, hideBanner, hideTips, screenReader, count }) => {
      const config = core.makeFakeConfig();
      vi.spyOn(config, 'getScreenReader').mockReturnValue(screenReader);
      const rendered = await renderWithProviders(
        <AppHeader version="2.0.0" />,
        {
          config,
          width,
          uiState: { terminalWidth: width },
          settings: createMockSettings({ ui: { hideBanner, hideTips } }),
        },
      );
      try {
        await rendered.settleLayout();
        const frame = rendered.lastFrame({ allowEmpty: true });
        expect(frame.includes('Tips for getting started')).toBe(count);
        expect(persistentStateMock.set).toHaveBeenCalledTimes(count ? 1 : 0);
        if (count) {
          rendered.rerender(<AppHeader key="resumed" version="2.0.0" />);
          await rendered.settleLayout();
          expect(persistentStateMock.set).toHaveBeenCalledTimes(1);
        }
      } finally {
        rendered.unmount();
      }
    },
  );

  it('does not display or count tips after their budget is exhausted', async () => {
    persistentStateMock.setData({ tipsShown: 10 });
    const rendered = await renderWithProviders(<AppHeader version="2.0.0" />, {
      width: 120,
      uiState: { terminalWidth: 120 },
    });
    try {
      await rendered.settleLayout();
      expect(rendered.lastFrame()).toContain('Qwen Code');
      expect(rendered.lastFrame()).not.toContain('Tips for getting started');
      expect(persistentStateMock.set).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  it('retains the Qwen brand when the complete header throws without consuming tips', async () => {
    vi.spyOn(core.runLogger, 'error').mockImplementation(() => {});
    const config = core.makeFakeConfig();
    vi.spyOn(config, 'getTargetDir').mockImplementation(() => {
      throw new Error('failed to read workspace');
    });
    const rendered = await renderWithProviders(<AppHeader version="2.0.0" />, {
      config,
      width: 120,
      uiState: { terminalWidth: 120 },
    });
    try {
      await rendered.settleLayout();
      expect(rendered.lastFrame().trim()).toBe('Qwen Code v2.0.0');
      expect(persistentStateMock.set).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });
});

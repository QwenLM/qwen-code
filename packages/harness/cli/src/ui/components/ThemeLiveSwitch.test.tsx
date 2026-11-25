/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef, memo, useState } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { CoreToolCallStatus, makeFakeConfig } from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import {
  areHistoryItemPropsEqual,
  HistoryItemDisplay,
} from './HistoryItemDisplay.js';
import { themeManager } from '../themes/theme-manager.js';
import { theme } from '../semantic-colors.js';
import type { HistoryItem } from '../types.js';
import { ThemeDialog } from './ThemeDialog.js';
import { AskUserDialog } from './AskUserDialog.js';
import { DiffRenderer } from './messages/DiffRenderer.js';
import { waitFor } from '../../test-utils/async.js';
import { DialogContextBridge } from './MainControls.js';
import { VirtualizedList, type VirtualizedListRef } from './shared/VirtualizedList.js';
import { useAnimatedScrollbar } from '../hooks/useAnimatedScrollbar.js';

// The shared Vitest alias is a plain-character stub that discards styling.
// Load the real tokenizer for color regressions; do not mock the renderer.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packageJson = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  return import(new URL('./build/index.js', pathToFileURL(packageJson)).href);
});

// Match MainContent's actual static-history bailout, rather than forcing a
// rerender through props or mocking Ink's requestRender.
const MemoizedHistoryItemDisplay = memo(
  HistoryItemDisplay,
  areHistoryItemPropsEqual,
);

const originalChalkLevel = chalk.level;

beforeEach(() => {
  chalk.level = 3;
  themeManager.setTerminalBackground('#000000');
  themeManager.setActiveTheme('Default');
});

afterEach(() => {
  chalk.level = originalChalkLevel;
  vi.useRealTimers();
  themeManager.setTerminalBackground(undefined);
  themeManager.setActiveTheme('Default');
});

describe('live theme boundaries', () => {
  it('recolors static history without rerendering its memoized parent', async () => {
    const item: HistoryItem = {
      id: 1,
      type: 'warning',
      text: 'Retained history warning',
    };
    const parentRender = vi.fn();
    const Parent = memo(() => {
      parentRender();
      return (
        <MemoizedHistoryItemDisplay
          item={item}
          terminalWidth={60}
          isPending={false}
          isStatic
        />
      );
    });
    Parent.displayName = 'Parent';
    const result = await renderWithProviders(<Parent />, { width: 60 });
    try {
      await result.waitUntilReady();
      const parentRenderCount = parentRender.mock.calls.length;
      const darkColor = theme.status.warning;
      await expect(result).toMatchSvgSnapshot({ name: 'history-dark' });

      await act(async () => {
        themeManager.setTerminalBackground('#ffffff');
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(theme.status.warning).not.toBe(darkColor);
      expect(result.generateSvg()).toContain(theme.status.warning.toLowerCase());
      expect(result.lastFrame()).toContain('Retained history warning');
      expect(parentRender).toHaveBeenCalledTimes(parentRenderCount);
      await expect(result).toMatchSvgSnapshot({ name: 'history-light' });
    } finally {
      result.unmount();
    }
  });

  it('recolors tool names while preserving the live pulse state', async () => {
    vi.useFakeTimers();
    const item: HistoryItem = {
      id: 2,
      type: 'tool_group',
      borderTop: true,
      borderBottom: true,
      tools: [
        {
          callId: 'retained-tool',
          name: 'RetainedTool',
          args: {},
          description: 'Working without remounting',
          status: CoreToolCallStatus.Executing,
          resultDisplay: undefined,
          confirmationDetails: undefined,
        },
      ],
    };
    const settings = createMockSettings({
      ui: { useAlternateBuffer: true, showSpinner: true },
    });
    const result = await renderWithProviders(
      <MemoizedHistoryItemDisplay
        item={item}
        terminalWidth={60}
        isPending={false}
        isStatic
      />,
      {
        width: 60,
        settings,
        config: makeFakeConfig({ useAlternateBuffer: true }),
      },
    );
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('▪');
      const darkNameColor = theme.text.primary;
      await expect(result).toMatchSvgSnapshot({ name: 'tool-dark' });

      await act(async () => {
        themeManager.setTerminalBackground('#ffffff');
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(theme.text.primary).not.toBe(darkNameColor);
      expect(result.generateSvg()).toContain(theme.text.primary.toLowerCase());
      // A keyed remount would restart ToolStatusPulseFrames at the hollow frame.
      expect(result.lastFrame()).toContain('▪');
      expect(result.lastFrame()).toContain('RetainedTool');
      await expect(result).toMatchSvgSnapshot({ name: 'tool-light' });
    } finally {
      result.unmount();
    }
  });

  it('refreshes a cached dialog element without losing its local input state', async () => {
    let setDraft!: (value: string) => void;
    function CachedDialog() {
      const [draft, updateDraft] = useState('initial');
      setDraft = updateDraft;
      return <Text color={theme.text.primary}>{draft}</Text>;
    }
    const cachedNode = <CachedDialog />;
    const result = await renderWithProviders(
      <DialogContextBridge>{cachedNode}</DialogContextBridge>,
    );
    try {
      await act(async () => setDraft('unsent draft'));
      await act(async () => {
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('unsent draft');
      expect(result.generateSvg()).toContain(theme.text.primary.toLowerCase());
      await expect(result).toMatchSvgSnapshot({ name: 'cached-dialog-light' });
    } finally {
      result.unmount();
    }
  });

  it('refreshes cached custom history content without remounting it', async () => {
    let expand!: () => void;
    function CustomHistory() {
      const [expanded, setExpanded] = useState(false);
      expand = () => setExpanded(true);
      return (
        <Text color={theme.text.primary}>
          {expanded ? 'expanded history' : 'collapsed history'}
        </Text>
      );
    }
    const item: HistoryItem = {
      id: 3,
      type: 'custom_content',
      text: 'Custom history',
      content: <CustomHistory />,
    };
    const result = await renderWithProviders(
      <MemoizedHistoryItemDisplay
        item={item}
        terminalWidth={60}
        isPending={false}
        isStatic
      />,
      { width: 60 },
    );
    try {
      await act(async () => expand());
      await act(async () => {
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('expanded history');
      expect(result.generateSvg()).toContain(theme.text.primary.toLowerCase());
      await expect(result).toMatchSvgSnapshot({ name: 'custom-history-light' });
    } finally {
      result.unmount();
    }
  });

  it('refreshes cached list rows without resetting scroll or expanded state', async () => {
    const listRef = createRef<VirtualizedListRef<string>>();
    const expanders = new Map<string, () => void>();
    function Row({ label, color }: { label: string; color: string }) {
      const [expanded, setExpanded] = useState(false);
      expanders.set(label, () => setExpanded(true));
      return <Text color={color}>{label}{expanded ? ' expanded' : ''}</Text>;
    }
    const data = Array.from({ length: 10 }, (_, index) => `Row ${index}`);
    const result = await renderWithProviders(
      <Box height={4} width={40}>
        <VirtualizedList
          ref={listRef}
          data={data}
          width={40}
          containerHeight={4}
          estimatedItemHeight={() => 1}
          keyExtractor={(item) => item}
          renderItem={({ item }) => <Row label={item} color={theme.text.primary} />}
        />
      </Box>,
      { width: 40 },
    );
    try {
      await result.waitUntilReady();
      await act(async () => {
        listRef.current!.scrollTo(2);
        expanders.get('Row 2')!();
      });
      await result.waitUntilReady();
      const scrollState = listRef.current!.getScrollState();
      expect(scrollState.scrollTop).toBeGreaterThan(0);
      await act(async () => {
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(listRef.current!.getScrollState()).toEqual(scrollState);
      expect(result.lastFrame()).toContain('Row 2 expanded');
      expect(result.generateSvg()).toContain(theme.text.primary.toLowerCase());
      await expect(result).toMatchSvgSnapshot({ name: 'list-light' });
    } finally {
      result.unmount();
    }
  });

  it('cancels a scrollbar fade holding old palette colors', async () => {
    vi.useFakeTimers();
    const scrollBy = vi.fn();
    let scrollbar!: ReturnType<typeof useAnimatedScrollbar>;
    function Scrollbar() {
      scrollbar = useAnimatedScrollbar(true, scrollBy);
      return <Text color={scrollbar.scrollbarColor}>scrollbar</Text>;
    }
    const result = await renderWithProviders(<Scrollbar />);
    try {
      // Exercise the actual animation, not the hook's zero-duration test branch.
      vi.stubEnv('NODE_ENV', 'development');
      await act(async () => {
        scrollbar.scrollByWithAnimation(3);
        await vi.advanceTimersByTimeAsync(99);
      });
      expect(scrollBy).toHaveBeenCalledWith(3);
      expect(scrollbar.scrollbarColor).not.toBe(theme.ui.dark);
      await act(async () => {
        themeManager.setActiveTheme('Default Light');
      });
      expect(scrollbar.scrollbarColor).toBe(theme.ui.dark);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await result.waitUntilReady();
      expect(scrollbar.scrollbarColor).toBe(theme.ui.dark);
      await expect(result).toMatchSvgSnapshot({ name: 'scrollbar-light' });
    } finally {
      vi.unstubAllEnvs();
      result.unmount();
    }
  });

  it('recolors memoized diff fallback content', async () => {
    const result = await renderWithProviders(
      <DiffRenderer diffContent="" terminalWidth={60} />,
      { width: 60 },
    );
    try {
      await act(async () => {
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('No diff content.');
      expect(result.generateSvg()).toContain(theme.status.warning.toLowerCase());
      await expect(result).toMatchSvgSnapshot({ name: 'diff-fallback-light' });
    } finally {
      result.unmount();
    }
  });

  it('recolors a cached question view without losing its typed answer', async () => {
    const onSubmit = vi.fn();
    const result = await renderWithProviders(
      <AskUserDialog
        questions={[{
          question: 'Choose a language',
          header: 'Language',
          options: [{ label: 'TypeScript', description: '' }],
          multiSelect: false,
        }]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        width={80}
      />,
      { width: 80 },
    );
    try {
      await act(async () => result.stdin.write('\x1b[B'));
      await waitFor(() => expect(result.lastFrame()).toContain('Type something.'));
      await act(async () => result.stdin.write('retained answer'));
      await waitFor(() => expect(result.lastFrame()).toContain('retained answer'));
      await act(async () => {
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('retained answer');
      expect(result.generateSvg()).toContain(theme.text.primary.toLowerCase());
      await expect(result).toMatchSvgSnapshot({ name: 'question-light' });
      await act(async () => result.stdin.write('\r'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({ 'Choose a language': 'retained answer' });
      });
    } finally {
      result.unmount();
    }
  });

  it('refreshes the open theme dialog from the manager, not stale UIState', async () => {
    const settings = createMockSettings({ ui: { theme: 'auto' } });
    const result = await renderWithProviders(
      <ThemeDialog
        settings={settings}
        onSelect={vi.fn()}
        onHighlight={vi.fn()}
        onCancel={vi.fn()}
        terminalWidth={120}
        availableTerminalHeight={40}
      />,
      {
        width: 120,
        settings,
        uiState: { terminalBackgroundColor: '#000000' },
      },
    );
    try {
      await result.waitUntilReady();
      const autoLine = () =>
        result.lastFrame().split('\n').find((line) => line.includes('1. Auto'));
      expect(autoLine()).toContain('→ Default');
      await act(async () => {
        themeManager.setTerminalBackground('#ffffff');
      });
      await result.waitUntilReady();
      expect(autoLine()).toContain('→ Default Light');
      expect(autoLine()).toContain('❯');
    } finally {
      result.unmount();
    }
  });
});

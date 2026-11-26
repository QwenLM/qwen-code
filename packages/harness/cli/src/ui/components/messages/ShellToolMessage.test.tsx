/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { act } from 'react';
import {
  ShellExecutionStatus,
  ShellToolMessage,
  type ShellToolMessageProps,
} from './ShellToolMessage.js';
import {
  CoreToolCallStatus,
  makeFakeConfig,
} from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { waitFor } from '../../../test-utils/async.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SHELL_COMMAND_NAME } from '../../constants.js';
import { FoldLevel } from '../../constants/messageLayout.js';
import { theme } from '../../semantic-colors.js';
import { useFoldState } from '../../contexts/FoldStateContext.js';

vi.mock('../../hooks/useShellElapsedTime.js', () => ({
  useShellElapsedTime: (startedAt: number | undefined, active: boolean) => {
    const elapsedMs = active
      ? Math.max(0, Date.now() - (startedAt ?? Date.now()))
      : 0;
    return {
      elapsedMs,
      elapsedSeconds: Math.floor(elapsedMs / 1000),
    };
  },
}));

describe('<ShellToolMessage />', () => {
  const baseProps: ShellToolMessageProps = {
    callId: 'tool-123',
    name: SHELL_COMMAND_NAME,
    description: 'A shell command',
    resultDisplay: 'Test result',
    status: CoreToolCallStatus.Executing,
    terminalWidth: 80,
    confirmationDetails: undefined,
    emphasis: 'medium',
    isFirst: true,
    borderColor: 'green',
    borderDimColor: false,
    isExpandable: false,
    config: makeFakeConfig(),
  };

  const LONG_OUTPUT = Array.from(
    { length: 100 },
    (_, i) => `Line ${i + 1}`,
  ).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Snapshots', () => {
    it.each([
      [
        'renders in Executing state',
        { status: CoreToolCallStatus.Executing },
        undefined,
      ],
      [
        'renders in Success state (history mode)',
        { status: CoreToolCallStatus.Success },
        undefined,
      ],
      [
        'renders in Error state',
        { status: CoreToolCallStatus.Error, resultDisplay: 'Error output' },
        undefined,
      ],
      [
        'renders in Cancelled state with partial output',
        {
          status: CoreToolCallStatus.Cancelled,
          resultDisplay: 'Partial output before cancellation',
        },
        undefined,
      ],
      [
        'renders in Alternate Buffer mode while focused',
        {
          status: CoreToolCallStatus.Executing,
          executionId: 1,
        },
        {
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
          uiState: {
            activeShellId: 1,
          },
        },
      ],
      [
        'renders in Alternate Buffer mode while unfocused',
        {
          status: CoreToolCallStatus.Executing,
          executionId: 1,
        },
        {
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
          uiState: {
            activeShellId: 1,
          },
        },
      ],
    ])('%s', async (_, props, options) => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage {...baseProps} {...props} />,
        { ...options },
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });
  });

  describe('command header folding', () => {
    const MULTILINE_COMMAND = [
      'for i in $(seq 1 10); do',
      '  echo "Iteration $i:"',
      '  date # third-line-marker',
      'done # final-line-marker',
    ].join('\n');

    it('keeps the two-line preview and reveals the full command when fold state changes', async () => {
      let cycleFoldLevel: (() => void) | undefined;

      const Harness = () => {
        cycleFoldLevel = useFoldState().cycleFoldLevel;
        return (
          <ShellToolMessage
            {...baseProps}
            displayTitle={MULTILINE_COMMAND}
            resultDisplay=""
            status={CoreToolCallStatus.Success}
          />
        );
      };

      const { lastFrame, unmount } = await renderWithProviders(<Harness />, {
        initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
      });

      const compactFrame = lastFrame();
      expect(compactFrame).toContain('for i in $(seq 1 10); do');
      expect(compactFrame).toContain('echo "Iteration $i:"…');
      expect(compactFrame).not.toContain('third-line-marker');
      expect(compactFrame).not.toContain('final-line-marker');

      await act(async () => {
        cycleFoldLevel?.();
      });

      await waitFor(() => {
        expect(lastFrame()).toContain('third-line-marker');
      });
      const expandedFrame = lastFrame();
      expect(expandedFrame).toContain('final-line-marker');
      expect(expandedFrame).toMatchSnapshot();

      await act(async () => {
        cycleFoldLevel?.();
      });

      await waitFor(() => {
        expect(lastFrame()).not.toContain('third-line-marker');
      });
      const collapsedAgainFrame = lastFrame();
      expect(collapsedAgainFrame).toContain('echo "Iteration $i:"…');
      expect(collapsedAgainFrame).not.toContain('final-line-marker');
      unmount();
    });

    it('bypasses the 160-character limit when fully expanded', async () => {
      const endMarker = 'end-of-long-command-marker';
      const longCommand = `printf '${'x'.repeat(170)}${endMarker}'`;

      const compact = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          displayTitle={longCommand}
          resultDisplay=""
          status={CoreToolCallStatus.Success}
          terminalWidth={240}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
          width: 240,
        },
      );

      expect(compact.lastFrame()).toContain('…');
      expect(compact.lastFrame()).not.toContain(endMarker);
      compact.unmount();

      const expanded = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          displayTitle={longCommand}
          resultDisplay=""
          status={CoreToolCallStatus.Success}
          terminalWidth={240}
        />,
        {
          initialFoldLevel: FoldLevel.FullyExpanded,
          width: 240,
        },
      );

      expect(expanded.lastFrame()).toContain(endMarker);
      expanded.unmount();
    });
  });

  describe('Height Constraints', () => {
    // Note: ShellToolMessage uses FoldLevel (via FoldStateContext) to control
    // compact vs expanded view. The test provider defaults to FullyExpanded.
    // Compact view (3 lines) is tested via the fold-controlled path.

    it('shows elapsed time and the background hint only after two seconds', async () => {
      const startedAt = Date.now();
      const { lastFrame, unmount, waitUntilReady, rerender } =
        await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay=""
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={startedAt}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      expect(lastFrame()).toContain('Running…');
      expect(lastFrame()).not.toContain('Ctrl+B to run in background');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1900);
      });
      rerender(
        <ShellToolMessage
          {...baseProps}
          resultDisplay=""
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={startedAt}
        />,
      );
      await waitUntilReady();
      expect(lastFrame()).not.toContain('Ctrl+B to run in background');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      rerender(
        <ShellToolMessage
          {...baseProps}
          resultDisplay=""
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={startedAt}
        />,
      );
      await waitUntilReady();
      expect(lastFrame()).toContain('(2s)');
      expect(lastFrame()).toContain('Ctrl+B to run in background');

      unmount();
    });

    it('shows background hint instead of Ctrl+O hint for compact running shell output', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          renderOutputAsMarkdown={false}
          availableTerminalHeight={100}
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={Date.now() - 2000}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('Ctrl+B to run in background');
      expect(frame).not.toContain('Ctrl+O');
      expect(frame).toContain('+95 lines (2s)');
      expect(frame).not.toContain('… +95 lines');
      expect(frame).not.toContain('Running…');
      expect(frame).toContain('Line 96');
      expect(frame).toContain('Line 100');
      expect(frame).not.toContain('Line 95\n');
      unmount();
    });

    it('renders live output stats once in a single metadata row', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={Date.now() - 2000}
          shellProgress={{ totalLines: 100, totalBytes: 1024 }}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('~100 lines (2s) 1.0 KB');
      expect(frame.match(/100 lines/g)).toHaveLength(1);
      expect(frame).not.toContain('… +95 lines');
      expect(frame).not.toContain('Running…');
      unmount();
    });

    it('keeps output and bytes without inventing a temporarily unavailable line count', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={Date.now() - 2000}
          shellProgress={{ totalBytes: 1024 }}
        />,
        { initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed },
      );
      const frame = lastFrame();
      expect(frame).toContain('(2s) 1.0 KB');
      expect(frame).toContain('Line 100');
      expect(frame).not.toMatch(/(?:~|\+)\d+ lines/);
      expect(frame).not.toContain('0 lines');
      unmount();
    });

    it('omits byte size from client-initiated shell mode progress', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          status={CoreToolCallStatus.Executing}
          executionId={1}
          startedAt={Date.now() - 2000}
          shellProgress={{ totalLines: 100, totalBytes: 1024 }}
          isClientInitiated={true}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('~100 lines (2s)');
      expect(frame).not.toContain('1.0 KB');
      unmount();
    });

    it('keeps four completed output lines unfolded', async () => {
      const output = ['Line 1', 'Line 2', 'Line 3', 'Line 4'].join('\n');
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={output}
          status={CoreToolCallStatus.Success}
          isExpandable={true}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('Line 4');
      expect(frame).not.toContain('Ctrl+O');
      expect(frame).not.toContain('… +');
      unmount();
    });

    it('folds five completed lines with the accurate count and expand hint', async () => {
      const output = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'].join(
        '\n',
      );
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={output}
          status={CoreToolCallStatus.Success}
          isExpandable={true}
          shellProgress={{ totalLines: 6, totalBytes: 35 }}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('Line 1');
      expect(frame).toContain('Line 3');
      expect(frame).not.toContain('Line 4');
      expect(frame).toContain('… +2 lines (Ctrl+O to expand)');
      unmount();
    });

    it('keeps the output-cap reason visible when partial output is folded', async () => {
      const output = [
        'Command killed: output file exceeded 5GB.',
        'y',
        'y',
        'y',
        'y',
        'y',
      ].join('\n');
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={output}
          status={CoreToolCallStatus.Success}
          isExpandable={true}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('Command killed: output file exceeded 5GB.');
      expect(frame).toContain('… +3 lines (Ctrl+O to expand)');
      unmount();
    });

    it('applies the completed fold threshold to terminal-wrapped rows', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={'x'.repeat(75)}
          status={CoreToolCallStatus.Success}
          terminalWidth={20}
          isExpandable={true}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      expect(lastFrame()).toContain('… +2 lines');
      expect(lastFrame()).toContain('Ctrl+O');
      unmount();
    });

    it('uses a human-readable duration for long-running commands', () => {
      const rendered = ShellExecutionStatus({
        elapsedSeconds: 65,
        showDetails: true,
        shellProgress: undefined,
        showBackgroundHint: false,
        hasOutput: false,
        hiddenLineCount: 0,
      }) as React.ReactElement<{ children: React.ReactNode }>;
      const rows = React.Children.toArray(rendered.props.children);
      const statusRow = rows[0] as React.ReactElement<{
        children: React.ReactElement<{ children: string }>;
      }>;

      expect(statusRow.props.children.props.children).toBe('Running… (1m 5s)');
    });

    it('uses the secondary text color for long-running status text', () => {
      const rendered = ShellExecutionStatus({
        elapsedSeconds: 2,
        showDetails: true,
        shellProgress: undefined,
        showBackgroundHint: true,
        hasOutput: false,
        hiddenLineCount: 0,
      }) as React.ReactElement<{ children: React.ReactNode }>;
      const rows = React.Children.toArray(rendered.props.children);
      const colors = rows.map((row) => {
        const rowElement = row as React.ReactElement<{
          children: React.ReactNode;
        }>;
        const textElement = React.Children.only(
          rowElement.props.children,
        ) as React.ReactElement<{ color?: string }>;
        return textElement.props.color;
      });

      expect(colors).toEqual([theme.text.secondary, theme.text.secondary]);
    });

    it.each([
      ['empty string', ''],
      ['undefined', undefined],
    ])(
      'shows background hint for pure-blocking commands with %s output while executing',
      async (_label, resultDisplay) => {
        const { lastFrame, unmount } =
          await renderWithProviders(
            <ShellToolMessage
              {...baseProps}
              description="sleep 1000"
              resultDisplay={resultDisplay}
              renderOutputAsMarkdown={false}
              availableTerminalHeight={100}
              status={CoreToolCallStatus.Executing}
              executionId={1}
              startedAt={Date.now() - 2000}
            />,
            {
              initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
            },
          );

        const frame = lastFrame();
        expect(frame).toContain('Ctrl+B to run in background');
        expect(frame).not.toContain('(no output)');
        unmount();
      },
    );

    it('does not show background hint before an execution id is available', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          description="sleep 1000"
          resultDisplay=""
          status={CoreToolCallStatus.Executing}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      expect(lastFrame()).not.toContain('Ctrl+B to run in background');
      unmount();
    });

    it.each([
      CoreToolCallStatus.Scheduled,
      CoreToolCallStatus.Validating,
      CoreToolCallStatus.AwaitingApproval,
    ])('does not show background hint while shell is %s', async (status) => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          description="sleep 1000"
          resultDisplay=""
          status={status}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      expect(lastFrame()).not.toContain('Ctrl+B to run in background');
      unmount();
    });

    it('does not show background hint after shell completes with no output', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          description="sleep 1"
          resultDisplay=""
          renderOutputAsMarkdown={false}
          availableTerminalHeight={100}
          status={CoreToolCallStatus.Success}
        />,
        {
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).not.toContain('Ctrl+B to run in background');
      expect(frame).toContain('(no output)');
      unmount();
    });

    it('shows all output when FoldLevel is FullyExpanded', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          renderOutputAsMarkdown={false}
          availableTerminalHeight={100}
          executionId={1}
          status={CoreToolCallStatus.Executing}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({
            ui: { useAlternateBuffer: true },
          }),
          uiState: {
            activeShellId: 1,
            constrainHeight: false,
          },
        },
      );

      const frame = lastFrame();
      // FullyExpanded mode shows all output via ToolResultDisplay
      expect(frame.match(/Line \d+/g)?.length).toBe(100);
      expect(frame).toMatchSnapshot();
      unmount();
    });

    it('shows all output when constrainHeight is false (expanded mode)', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          renderOutputAsMarkdown={false}
          availableTerminalHeight={undefined}
          status={CoreToolCallStatus.Executing}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: false }),
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
          uiState: {
            constrainHeight: false,
            terminalHeight: 200,
          },
        },
      );

      const frame = lastFrame();
      // constrainHeight=false → expanded mode → all lines shown
      expect(frame.match(/Line \d+/g)?.length).toBe(100);
      unmount();
    });

    it('shows all output in alternate buffer mode when constrainHeight is false', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <ShellToolMessage
          {...baseProps}
          resultDisplay={LONG_OUTPUT}
          renderOutputAsMarkdown={false}
          availableTerminalHeight={undefined}
          status={CoreToolCallStatus.Success}
          isExpandable={true}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
          uiState: {
            constrainHeight: false,
          },
        },
      );

      const frame = lastFrame();
      // constrainHeight=false → expanded mode → all 100 lines
      expect(frame.match(/Line \d+/g)?.length).toBe(100);
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });
  });
});

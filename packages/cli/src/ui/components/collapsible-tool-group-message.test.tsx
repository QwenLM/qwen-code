/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Box, getFrameController } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { VirtualViewportContext } from '../contexts/VirtualViewportContext.js';
import { ToolDetailsExpandedProvider } from '../contexts/ToolDetailsExpandedContext.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../utils/measure-element-position.js';
import { ToolCallStatus } from '../types.js';
import {
  CollapsibleToolGroupMessage,
  HistoryItemDisplay,
} from './HistoryItemDisplay.js';
import { ToolGroupMessage } from './messages/ToolGroupMessage.js';

vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

vi.mock('../utils/measure-element-position.js', () => ({
  layoutRowForEvent: vi.fn(),
  measureElementPosition: vi.fn(),
}));

const emptySettingsFile = {
  path: '',
  settings: {},
  originalSettings: {},
};

const collapsedSettings = new LoadedSettings(
  emptySettingsFile,
  emptySettingsFile,
  {
    path: '',
    settings: { ui: { showToolCallDetails: false, useTerminalBuffer: true } },
    originalSettings: {},
  },
  emptySettingsFile,
  true,
  new Set(),
);

const tool = {
  callId: 'exec-1',
  name: 'exec',
  description: 'const veryLongSource = true;',
  resultDisplay: 'very long result',
  status: ToolCallStatus.Success,
  confirmationDetails: undefined,
};

const mouseEvent = (name: MouseEvent['name'], col: number): MouseEvent => ({
  name,
  col,
  row: 1,
  shift: false,
  meta: false,
  ctrl: false,
  button: 'left',
});

function renderCollapsedTool(viewport = true, tools = [tool]) {
  vi.mocked(useMouseEvents).mockClear();
  vi.mocked(measureElementPosition).mockReturnValue({
    x: 0,
    y: 0,
    width: 80,
    height: 1,
  });
  vi.mocked(layoutRowForEvent).mockImplementation((_node, row) => row - 1);
  const view = renderWithProviders(
    <VirtualViewportContext.Provider value={viewport}>
      <Box width={100}>
        <CollapsibleToolGroupMessage
          toolCalls={tools}
          groupId={1}
          contentWidth={96}
          isPending={false}
        />
      </Box>
    </VirtualViewportContext.Provider>,
    { settings: collapsedSettings, config: {} as Config },
  );
  return {
    ...view,
    handler: vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0],
  };
}

describe('<CollapsibleToolGroupMessage />', () => {
  it('opens successful commands as compact call rows with full output still reachable', () => {
    const calls = [1, 2].map((index) => ({
      ...tool,
      callId: `shell-${index}`,
      name: 'Shell',
      description: `printf command_${index}`,
      resultDisplay: `RAW_SHELL_OUTPUT_${index}`,
    }));
    const { handler, lastFrame } = renderCollapsedTool(true, calls);
    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });
    expect(lastFrame()).toContain('Ran printf command_1');
    expect(lastFrame()).toContain('Ran printf command_2');
    expect(lastFrame()).toContain('ctrl+o for details');
    expect(lastFrame()).not.toContain('RAW_SHELL_OUTPUT');

    const [expandedHandler] = vi.mocked(useMouseEvents).mock.calls.at(-1)!;
    act(() => {
      expandedHandler({ ...mouseEvent('left-press', 5), row: 2 });
      expandedHandler({ ...mouseEvent('left-release', 5), row: 2 });
    });
    expect(lastFrame()).toContain('click to collapse');

    const detailed = renderWithProviders(
      <CollapsibleToolGroupMessage
        toolCalls={calls}
        groupId={1}
        contentWidth={96}
        fullDetail
      />,
      { settings: collapsedSettings, config: {} as Config },
    );
    expect(detailed.lastFrame()).toContain('RAW_SHELL_OUTPUT_1');
    expect(detailed.lastFrame()).toContain('RAW_SHELL_OUTPUT_2');
  });

  it.each([ToolCallStatus.Error, ToolCallStatus.Canceled])(
    'keeps %s output visible outside the compact directory',
    (status) => {
      const { lastFrame } = renderWithProviders(
        <CollapsibleToolGroupMessage
          toolCalls={[{ ...tool, status }]}
          groupId={1}
          contentWidth={96}
        />,
        { settings: collapsedSettings, config: {} as Config },
      );
      expect(lastFrame()).toContain('very long result');
      expect(lastFrame()).not.toContain('click to expand');
    },
  );

  it('keeps its summary clickable so a second click collapses the body', () => {
    const { handler, lastFrame } = renderCollapsedTool();
    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });
    expect(lastFrame()).toContain('click to collapse');
    const [expandedHandler, options] = vi
      .mocked(useMouseEvents)
      .mock.calls.at(-1)!;
    expect(options.isActive).toBe(true);
    act(() => {
      expandedHandler(mouseEvent('left-press', 5));
      expandedHandler(mouseEvent('left-release', 5));
    });
    expect(lastFrame()).toContain('click to expand');
    expect(lastFrame()).not.toContain('very long result');
  });

  it('renders the underlying hidden-details row', () => {
    const { lastFrame } = renderWithProviders(
      <ToolGroupMessage
        toolCalls={[tool]}
        groupId={1}
        contentWidth={96}
        hideDetails
        expandHint="click to expand"
      />,
      { settings: collapsedSettings, config: {} as Config },
    );

    expect(lastFrame()).toContain('exec');
  });

  it('hides arguments and results in one-line mode', () => {
    const { lastFrame } = renderCollapsedTool();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('exec');
    expect(frame).toContain('click to expand');
    expect(frame).not.toContain('veryLongSource');
    expect(frame).not.toContain('very long result');
    expect(frame.split('\n')).toHaveLength(1);
    expect(vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1]).toMatchObject({
      isActive: true,
    });
  });

  it('expands after a complete click', () => {
    const { handler, lastFrame } = renderCollapsedTool();

    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });

    expect(lastFrame()).toContain('const veryLongSource = true;');
    expect(lastFrame()).toContain('very long result');
  });

  it('keeps a live tool expanded when its history row remounts', () => {
    vi.mocked(measureElementPosition).mockReturnValue({
      x: 0,
      y: 0,
      width: 80,
      height: 1,
    });
    vi.mocked(layoutRowForEvent).mockImplementation((_node, row) => row - 1);
    const toggleBatch = vi.fn();
    vi.mocked(useMouseEvents).mockClear();
    const pending = renderWithProviders(
      <ToolDetailsExpandedProvider
        value={{ expandedBatchIds: new Set<string>(), toggleBatch }}
      >
        <VirtualViewportContext.Provider value={true}>
          <HistoryItemDisplay
            item={{
              id: 0,
              type: 'tool_group',
              batchId: 'tool-batch-test-1',
              tools: [tool],
            }}
            terminalWidth={100}
            isPending
          />
        </VirtualViewportContext.Provider>
      </ToolDetailsExpandedProvider>,
      { settings: collapsedSettings, config: {} as Config },
    );
    const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];

    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });

    expect(toggleBatch).toHaveBeenCalledWith('tool-batch-test-1');
    pending.unmount();
    vi.mocked(useMouseEvents).mockClear();

    const committed = renderWithProviders(
      <ToolDetailsExpandedProvider
        value={{
          expandedBatchIds: new Set(['tool-batch-test-1']),
          toggleBatch,
        }}
      >
        <VirtualViewportContext.Provider value={true}>
          <HistoryItemDisplay
            item={{
              id: 1,
              type: 'tool_group',
              batchId: 'tool-batch-test-1',
              tools: [tool],
            }}
            terminalWidth={100}
            isPending={false}
          />
        </VirtualViewportContext.Provider>
      </ToolDetailsExpandedProvider>,
      { settings: collapsedSettings, config: {} as Config },
    );

    expect(committed.lastFrame()).toContain('very long result');
    expect(vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1]).toMatchObject({
      isActive: true,
    });
  });

  it('does not expand while selecting text', () => {
    const { handler, lastFrame } = renderCollapsedTool();

    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('move', 20));
      handler?.(mouseEvent('left-release', 20));
    });

    expect(lastFrame()).not.toContain('veryLongSource');
    expect(lastFrame()).not.toContain('very long result');
  });

  it('does not collapse an expanded header when a selection survives release', () => {
    const { handler, lastFrame, stdout } = renderCollapsedTool();
    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });
    const controller = getFrameController(
      stdout as unknown as NodeJS.WriteStream,
    )!;
    const expandedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    act(() => {
      expandedHandler(mouseEvent('left-press', 5));
      controller.setSelection({ sx: 4, sy: 0, ex: 12, ey: 0 });
      expandedHandler(mouseEvent('left-release', 5));
    });
    expect(lastFrame()).toContain('very long result');
    act(() => {
      controller.setSelection(null);
      expandedHandler(mouseEvent('left-press', 5));
      expandedHandler(mouseEvent('left-release', 5));
    });
    expect(lastFrame()).not.toContain('very long result');
    expect(lastFrame()).toContain('click to expand');
  });

  it.each([
    { sx: 4, sy: 0, ex: 12, ey: 0 },
    { sx: 4, sy: 0, ex: 4, ey: 0 },
    { sx: 0, sy: 0, ex: 40, ey: 0 },
  ])(
    'does not expand on a matching release with renderer selection %j',
    (selection) => {
      const { handler, lastFrame, stdout } = renderCollapsedTool();
      const controller = getFrameController(
        stdout as unknown as NodeJS.WriteStream,
      )!;

      act(() => {
        handler?.(mouseEvent('left-press', 5));
        controller.setSelection(selection);
        expect(controller.getSelection()).toEqual(selection);
        handler?.(mouseEvent('left-release', 5));
      });
      expect(lastFrame()).not.toContain('very long result');

      act(() => {
        controller.setSelection(null);
        handler?.(mouseEvent('left-press', 5));
        handler?.(mouseEvent('left-release', 5));
      });
      expect(lastFrame()).toContain('very long result');
    },
  );

  it('falls back to Ctrl+O when viewport clicking is unavailable', () => {
    const { lastFrame } = renderCollapsedTool(false);

    expect(lastFrame()).toContain('ctrl+o to expand');
    expect(vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1]).toMatchObject({
      isActive: false,
    });
  });

  it('lets Ctrl+O full detail override the setting', () => {
    const { lastFrame } = renderWithProviders(
      <CollapsibleToolGroupMessage
        toolCalls={[tool]}
        groupId={1}
        contentWidth={96}
        isPending={false}
        fullDetail
      />,
      { settings: collapsedSettings, config: {} as Config },
    );

    expect(lastFrame()).toContain('const veryLongSource = true;');
    expect(lastFrame()).toContain('very long result');
  });

  it('keeps user-initiated tools expanded', () => {
    const { lastFrame } = renderWithProviders(
      <CollapsibleToolGroupMessage
        toolCalls={[tool]}
        groupId={1}
        contentWidth={96}
        isPending={false}
        isUserInitiated
      />,
      { settings: collapsedSettings, config: {} as Config },
    );

    expect(lastFrame()).toContain('const veryLongSource = true;');
    expect(lastFrame()).toContain('very long result');
  });

  it('keeps approval prompts expanded', () => {
    const { lastFrame } = renderWithProviders(
      <CollapsibleToolGroupMessage
        toolCalls={[{ ...tool, status: ToolCallStatus.Confirming }]}
        groupId={1}
        contentWidth={96}
        isPending
      />,
      { settings: collapsedSettings, config: {} as Config },
    );

    expect(lastFrame()).toContain('const veryLongSource = true;');
    expect(lastFrame()).not.toContain('click to expand');
  });

  it('keeps a focused interactive shell expanded', () => {
    vi.mocked(useMouseEvents).mockClear();
    const { lastFrame } = renderWithProviders(
      <CollapsibleToolGroupMessage
        toolCalls={[{ ...tool, status: ToolCallStatus.Executing, ptyId: 42 }]}
        groupId={1}
        contentWidth={96}
        isPending
        embeddedShellFocused
        activeShellPtyId={42}
      />,
      { settings: collapsedSettings, config: {} as Config },
    );

    expect(lastFrame()).not.toContain('click to expand');
    expect(vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1]).toMatchObject({
      isActive: false,
    });
  });
});

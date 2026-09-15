/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders, withProviders } from '../../test-utils/render.js';
import { VirtualViewportContext } from '../contexts/VirtualViewportContext.js';
import { ToolDetailsExpandedProvider } from '../contexts/ToolDetailsExpandedContext.js';
import {
  ContextMenuProvider,
  useContextMenu,
} from '../context-menu/ContextMenuContext.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import { hyperlinkAtCell } from '../utils/hyperlink-at.js';
import type { MouseEvent } from '../utils/mouse.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../utils/measure-element-position.js';
import { ToolCallStatus } from '../types.js';
import { toggleInSet } from '../utils/toggle-in-set.js';
import { MULTI_CLICK_MS } from '../selection/use-text-selection.js';
import {
  CollapsibleToolGroupMessage,
  HistoryItemDisplay,
} from './HistoryItemDisplay.js';
import { ToolGroupMessage } from './messages/ToolGroupMessage.js';

const { toolGroupMountSpy } = vi.hoisted(() => ({
  toolGroupMountSpy: vi.fn(),
}));

vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

vi.mock('../utils/measure-element-position.js', () => ({
  layoutRowForEvent: vi.fn(),
  measureElementPosition: vi.fn(),
}));

vi.mock('../utils/hyperlink-at.js', () => ({
  hyperlinkAtCell: vi.fn(),
}));

vi.mock('./messages/ToolGroupMessage.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./messages/ToolGroupMessage.js')>();
  const react = await import('react');
  return {
    ...actual,
    ToolGroupMessage: (
      props: React.ComponentProps<typeof actual.ToolGroupMessage>,
    ) => {
      react.useEffect(() => {
        toolGroupMountSpy();
      }, []);
      return react.createElement(actual.ToolGroupMessage, props);
    },
  };
});

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

const mouseEvent = (
  name: MouseEvent['name'],
  col: number,
  row = 1,
): MouseEvent => ({
  name,
  col,
  row,
  shift: false,
  meta: false,
  ctrl: false,
  button: 'left',
});

function renderCollapsedTool(viewport = true) {
  const view = renderWithProviders(
    <VirtualViewportContext.Provider value={viewport}>
      <Box width={100}>
        <CollapsibleToolGroupMessage
          toolCalls={[tool]}
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
  beforeEach(() => {
    toolGroupMountSpy.mockClear();
    vi.mocked(useMouseEvents).mockClear();
    vi.mocked(measureElementPosition).mockReturnValue({
      x: 0,
      y: 0,
      width: 80,
      height: 1,
    });
    vi.mocked(layoutRowForEvent).mockImplementation((_node, row) => row - 1);
    vi.mocked(hyperlinkAtCell).mockReturnValue(undefined);
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

  it('collapses after clicking the expanded tool group again', () => {
    vi.useFakeTimers();
    try {
      const { handler, lastFrame } = renderCollapsedTool();

      act(() => {
        handler?.(mouseEvent('left-press', 5));
        handler?.(mouseEvent('left-release', 5));
      });
      expect(lastFrame()).toContain('very long result');
      vi.advanceTimersByTime(MULTI_CLICK_MS);

      const expandedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];
      act(() => {
        expandedHandler?.(mouseEvent('left-press', 5));
        expandedHandler?.(mouseEvent('left-release', 5));
      });

      const frame = lastFrame() ?? '';
      expect(frame).toContain('click to expand');
      expect(frame).not.toContain('veryLongSource');
      expect(frame).not.toContain('very long result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the group expanded when a second click completes a double-click', () => {
    vi.useFakeTimers();
    try {
      const { handler, lastFrame } = renderCollapsedTool();

      act(() => {
        handler?.(mouseEvent('left-press', 5));
        handler?.(mouseEvent('left-release', 5));
      });

      const expandedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];
      act(() => {
        expandedHandler?.(mouseEvent('left-press', 5));
        expandedHandler?.(mouseEvent('left-release', 5));
      });

      expect(lastFrame()).toContain('very long result');
      expect(lastFrame()).not.toContain('click to expand');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not collapse from a click below the expanded header row', () => {
    const { handler, lastFrame } = renderCollapsedTool();

    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });
    vi.mocked(measureElementPosition).mockReturnValue({
      x: 0,
      y: 0,
      width: 80,
      height: 3,
    });

    const expandedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];
    act(() => {
      expandedHandler?.(mouseEvent('left-press', 5, 2));
      expandedHandler?.(mouseEvent('left-release', 5, 2));
    });

    expect(lastFrame()).toContain('very long result');
  });

  it('does not collapse when the click opens a hyperlink', () => {
    vi.useFakeTimers();
    try {
      const { handler, lastFrame } = renderCollapsedTool();

      act(() => {
        handler?.(mouseEvent('left-press', 5));
        handler?.(mouseEvent('left-release', 5));
      });
      vi.advanceTimersByTime(MULTI_CLICK_MS);
      vi.mocked(hyperlinkAtCell).mockReturnValue('https://example.com');

      const expandedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];
      act(() => {
        expandedHandler?.(mouseEvent('left-press', 5));
        expandedHandler?.(mouseEvent('left-release', 5));
      });

      expect(lastFrame()).toContain('very long result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles a batch-linked tool group through shared state', () => {
    vi.useFakeTimers();
    try {
      const StatefulBatch = () => {
        const [expandedBatchIds, setExpandedBatchIds] = useState<
          ReadonlySet<string>
        >(() => new Set<string>());
        const toggleBatch = (batchId: string) => {
          setExpandedBatchIds((previous) => toggleInSet(previous, batchId));
        };

        return (
          <ToolDetailsExpandedProvider
            value={{ expandedBatchIds, toggleBatch }}
          >
            <VirtualViewportContext.Provider value={true}>
              <Box width={100}>
                <CollapsibleToolGroupMessage
                  toolCalls={[tool]}
                  groupId={1}
                  contentWidth={96}
                  isPending={false}
                  expansionKey="tool-batch-test-1"
                />
              </Box>
            </VirtualViewportContext.Provider>
          </ToolDetailsExpandedProvider>
        );
      };
      const { lastFrame } = renderWithProviders(<StatefulBatch />, {
        settings: collapsedSettings,
        config: {} as Config,
      });
      const collapsedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];

      act(() => {
        collapsedHandler?.(mouseEvent('left-press', 5));
        collapsedHandler?.(mouseEvent('left-release', 5));
      });
      expect(lastFrame()).toContain('very long result');
      vi.advanceTimersByTime(MULTI_CLICK_MS);

      const expandedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];
      act(() => {
        expandedHandler?.(mouseEvent('left-press', 5));
        expandedHandler?.(mouseEvent('left-release', 5));
      });

      expect(lastFrame()).toContain('click to expand');
      expect(lastFrame()).not.toContain('very long result');
    } finally {
      vi.useRealTimers();
    }
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

  it('does not collapse a live expanded batch', () => {
    const toggleBatch = vi.fn();
    const { lastFrame } = renderWithProviders(
      <ToolDetailsExpandedProvider
        value={{
          expandedBatchIds: new Set(['tool-batch-test-1']),
          toggleBatch,
        }}
      >
        <VirtualViewportContext.Provider value={true}>
          <CollapsibleToolGroupMessage
            toolCalls={[tool]}
            groupId={1}
            contentWidth={96}
            isPending
            expansionKey="tool-batch-test-1"
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

    expect(toggleBatch).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('very long result');
  });

  it('disables toggling while a context menu is open', async () => {
    const OpenMenu = () => {
      const { openMenu } = useContextMenu();
      useEffect(() => {
        openMenu([{ id: 'copy', label: 'Copy', onSelect: () => {} }], {
          x: 0,
          y: 0,
        });
      }, [openMenu]);
      return null;
    };

    renderWithProviders(
      <ContextMenuProvider>
        <OpenMenu />
        <VirtualViewportContext.Provider value={true}>
          <CollapsibleToolGroupMessage
            toolCalls={[tool]}
            groupId={1}
            contentWidth={96}
            isPending={false}
          />
        </VirtualViewportContext.Provider>
      </ContextMenuProvider>,
      { settings: collapsedSettings, config: {} as Config },
    );

    await vi.waitFor(() => {
      expect(vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1]).toMatchObject({
        isActive: false,
      });
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

  it('keeps expanded tool state mounted across full-detail changes', () => {
    const renderGroup = (fullDetail = false) => (
      <VirtualViewportContext.Provider value={true}>
        <Box width={100}>
          <CollapsibleToolGroupMessage
            toolCalls={[tool]}
            groupId={1}
            contentWidth={96}
            isPending={false}
            fullDetail={fullDetail}
          />
        </Box>
      </VirtualViewportContext.Provider>
    );
    const view = renderWithProviders(renderGroup(), {
      settings: collapsedSettings,
      config: {} as Config,
    });
    const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];

    act(() => {
      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('left-release', 5));
    });
    const mountsAfterExpansion = toolGroupMountSpy.mock.calls.length;

    view.rerender(
      withProviders(renderGroup(true), {
        settings: collapsedSettings,
        config: {} as Config,
      }),
    );
    view.rerender(
      withProviders(renderGroup(), {
        settings: collapsedSettings,
        config: {} as Config,
      }),
    );

    expect(mountsAfterExpansion).toBeGreaterThan(0);
    expect(toolGroupMountSpy).toHaveBeenCalledTimes(mountsAfterExpansion);
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

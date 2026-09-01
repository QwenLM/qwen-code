/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { VirtualViewportContext } from '../contexts/VirtualViewportContext.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../utils/measure-element-position.js';
import { ToolCallStatus } from '../types.js';
import { CollapsibleToolGroupMessage } from './HistoryItemDisplay.js';
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

function renderCollapsedTool(viewport = true) {
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

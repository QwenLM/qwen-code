/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatViewer, type ChatMessageData } from './ChatViewer.js';

vi.mock('../toolcalls/index.js', () => {
  const make = (id: string) => {
    const Component = (props: { toolCall: { kind: string } }) => (
      <div data-testid={id}>{props.toolCall.kind}</div>
    );
    Component.displayName = id;
    return Component;
  };
  return {
    GenericToolCall: make('generic'),
    ThinkToolCall: make('think'),
    SaveMemoryToolCall: make('save-memory'),
    EditToolCall: make('edit'),
    WriteToolCall: make('write'),
    SearchToolCall: make('search'),
    UpdatedPlanToolCall: make('updated-plan'),
    ShellToolCall: make('shell'),
    ReadToolCall: make('read'),
    WebFetchToolCall: make('fetch'),
    shouldShowToolCall: vi.fn(() => true),
  };
});

const render = (ui: React.ReactElement) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const createToolCallMessage = (kind: string): ChatMessageData => ({
  uuid: `${kind}-1`,
  timestamp: '2026-03-22T16:48:35.000Z',
  type: 'tool_call',
  toolCall: {
    toolCallId: `${kind}-tool-call`,
    kind,
    title: kind,
    status: 'completed',
    locations: [{ path: 'src/index.ts' }, { path: 'src/App.tsx' }],
  },
});

describe('ChatViewer tool call routing', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the matching tool call component for read', () => {
    const { container, unmount } = render(
      <ChatViewer
        messages={[createToolCallMessage('read')]}
        autoScroll={false}
      />,
    );

    expect(container.querySelector('[data-testid="read"]')).not.toBeNull();
    unmount();
  });

  it('routes read_many_files to ReadToolCall', () => {
    const { container, unmount } = render(
      <ChatViewer
        messages={[createToolCallMessage('read_many_files')]}
        autoScroll={false}
      />,
    );

    expect(container.querySelector('[data-testid="read"]')).not.toBeNull();
    unmount();
  });

  it('routes list_directory to ReadToolCall', () => {
    const { container, unmount } = render(
      <ChatViewer
        messages={[createToolCallMessage('list_directory')]}
        autoScroll={false}
      />,
    );

    expect(container.querySelector('[data-testid="read"]')).not.toBeNull();
    unmount();
  });
});

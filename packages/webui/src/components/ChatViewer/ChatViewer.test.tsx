/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ChatViewer } from './ChatViewer.js';
import type { ChatMessageData } from './ChatViewer.js';

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

const toolCallMessage: ChatMessageData = {
  uuid: 'tool-1',
  timestamp: new Date().toISOString(),
  type: 'tool_call',
  toolCall: {
    toolCallId: '1',
    kind: 'read',
    title: 'Read file',
    status: 'completed',
  },
};

describe('ChatViewer tool call routing', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the matching tool call component', () => {
    const { container, unmount } = render(
      <ChatViewer messages={[toolCallMessage]} autoScroll={false} />,
    );

    expect(container.querySelector('[data-testid="read"]')).not.toBeNull();
    unmount();
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// eslint-disable-next-line import/no-internal-modules
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatViewer, type ChatMessageData } from './ChatViewer.js';

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

describe('ChatViewer tool routing', () => {
  it('routes read_many_files to ReadToolCall', () => {
    const html = renderToStaticMarkup(
      <ChatViewer messages={[createToolCallMessage('read_many_files')]} />,
    );

    expect(html).toContain('ReadToolCall');
  });

  it('routes list_directory to ReadToolCall', () => {
    const html = renderToStaticMarkup(
      <ChatViewer messages={[createToolCallMessage('list_directory')]} />,
    );

    expect(html).toContain('ReadToolCall');
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  makeFakeConfig,
  modelMessageToAssistantPayload,
  type AssistantMessage,
  type Message,
  type UserMessage,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { waitFor } from '../../test-utils/async.js';
import { describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { TranscriptHistoryView } from './TranscriptHistoryView.js';
import { FoldLevel } from '../constants/messageLayout.js';

function makeAssistantMessage(prefix: string, index: number): AssistantMessage {
  const id = index.toString().padStart(3, '0');
  return {
    type: 'assistant',
    uuid: `${prefix}-uuid-${id}`,
    timestamp: `2026-07-11T00:00:${(index % 60).toString().padStart(2, '0')}.000Z`,
    message: modelMessageToAssistantPayload({
      messageId: `${prefix}-message-${id}`,

      model: 'test-model',
      stopReason: 'end_turn',

      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      blocks: [
        {
          type: 'text',
          text: `${prefix}-row-${id}`,
        },
      ],
    }),
  };
}

function makeMessages(prefix: string, count: number): Message[] {
  return Array.from({ length: count }, (_, index) =>
    makeAssistantMessage(prefix, index),
  );
}

function makeHiddenMessage(index: number): Message {
  return {
    type: 'user',
    uuid: `hidden-${index}`,
    timestamp: '2026-07-11T00:01:00.000Z',
    isMeta: true,
    message: {
      role: 'user',
      content: `hidden-${index}`,
    },
  };
}

function makeToolUseMessage(callId: string): AssistantMessage {
  const message = makeAssistantMessage('boundary-tool-use', 0);
  return {
    ...message,
    uuid: 'boundary-tool-use-uuid',
    message: {
      ...message.message,
      content: [
        {
          type: 'tool_use',
          id: callId,
          name: 'BoundaryHiddenTool',
          input: { path: '/hidden' },
        },
      ],
    },
  };
}

function makeToolResultMessage(callId: string): UserMessage {
  return {
    type: 'user',
    uuid: 'boundary-tool-result-uuid',
    timestamp: '2026-07-11T00:02:00.000Z',
    toolUseResult: 'boundary-hidden-tool-result',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: callId,
          content: 'boundary-hidden-tool-result',
          is_error: false,
        },
      ],
    },
  };
}

describe('<TranscriptHistoryView />', () => {
  it('shows CodeMode child arguments as results arrive in a running agent transcript', async () => {
    const callId = 'code';
    const assistant = makeAssistantMessage('code', 0);
    assistant.message.content = [
      {
        type: 'tool_use',
        id: callId,
        name: 'CodeMode',
        input: { code: 'text("done");' },
      },
    ];
    const completed: Message = {
      ...makeToolResultMessage(callId),
      toolUseResult: {
        type: 'code_mode',
        status: 'completed',
        output: 'done',
        calls: [
          {
            callId: 'read',
            name: 'Read',
            status: 'completed',
            args: { file_path: '/repo/a.ts', offset: 2, limit: 3 },
          },
          {
            callId: 'bash',
            name: 'Bash',
            status: 'completed',
            args: { command: 'wc -l /repo/a.ts', description: 'Count lines' },
          },
          {
            callId: 'mcp',
            name: 'mcp__demo__query',
            status: 'completed',
            args: { query: 'long…' },
            argsTruncated: true,
          },
        ],
      },
    };
    let appendResult: () => void;
    function LiveTranscript() {
      const [messages, setMessages] = useState<Message[]>([assistant]);
      appendResult = () => setMessages([assistant, completed]);
      return (
        <TranscriptHistoryView
          conversationKey="agent-code"
          messages={messages}
          taskStatus="running"
          inProgressToolUseIds={messages.length === 1 ? [callId] : []}
          terminalWidth={100}
        />
      );
    }
    const result = await renderWithProviders(<LiveTranscript />, {
      config: makeFakeConfig({ useAlternateBuffer: false }),
      settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
      initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
    });
    try {
      await result.waitUntilReady();
      await act(async () => appendResult());
      await waitFor(() =>
        expect(result.lastFrame()).toContain('Read(/repo/a.ts · lines 2-4)'),
      );
      const output = result.lastFrame();
      expect(output).toContain('Bash(Count lines)');
      expect(output).toContain(
        'query (demo MCP Server)({"query":"long…"} [arguments truncated])',
      );
      expect(output).toContain('Completed · 3 tool calls');
      expect(output).not.toContain('text("done")');
      expect(output).toMatchSnapshot();
    } finally {
      result.unmount();
    }
  });

  it('uses the production anchored render window', async () => {
    const result = await renderWithProviders(
      <TranscriptHistoryView
        conversationKey="agent-a"
        messages={makeMessages('a', 251)}
        terminalWidth={100}
      />,
    );

    await waitFor(() => expect(result.lastFrame()).toContain('a-row-250'));
    const output = result.lastFrame();
    expect(output).not.toContain('a-row-000');
    expect(output).not.toContain('a-row-050');
    expect(output).toContain('a-row-051');
    result.unmount();
  });

  it('renders the complete transcript when showAll is enabled', async () => {
    const result = await renderWithProviders(
      <TranscriptHistoryView
        conversationKey="preview-a"
        messages={makeMessages('preview', 251)}
        terminalWidth={100}
        showAll
      />,
    );

    await waitFor(() =>
      expect(result.lastFrame()).toContain('preview-row-250'),
    );
    expect(result.lastFrame()).toContain('preview-row-000');
    result.unmount();
  });

  it('limits raw protocol messages before converting display history', async () => {
    const messages = [
      ...makeMessages('raw', 100),
      ...Array.from({ length: 351 }, (_, index) => makeHiddenMessage(index)),
    ];
    const result = await renderWithProviders(
      <TranscriptHistoryView
        conversationKey="agent-raw"
        messages={messages}
        terminalWidth={100}
      />,
    );

    await waitFor(() => expect(result.lastFrame()).toContain('raw-row-099'));
    const output = result.lastFrame();
    expect(output).not.toContain('raw-row-050');
    expect(output).toContain('raw-row-051');
    result.unmount();
  });

  it('handles a tool result whose tool use falls outside the raw window', async () => {
    const callId = 'boundary-hidden-call';
    const messages = [
      ...Array.from({ length: 50 }, (_, index) => makeHiddenMessage(index)),
      makeToolUseMessage(callId),
      makeToolResultMessage(callId),
      makeAssistantMessage('boundary-visible', 0),
      ...Array.from({ length: 398 }, (_, index) =>
        makeHiddenMessage(index + 50),
      ),
    ];
    const result = await renderWithProviders(
      <TranscriptHistoryView
        conversationKey="agent-tool-boundary"
        messages={messages}
        terminalWidth={100}
      />,
    );

    await waitFor(() =>
      expect(result.lastFrame()).toContain('boundary-visible-row-000'),
    );
    const output = result.lastFrame();
    expect(output.match(/boundary-visible-row-000/g)).toHaveLength(1);
    expect(output).not.toContain('BoundaryHiddenTool');
    expect(output).not.toContain('boundary-hidden-tool-result');
    result.unmount();
  });

  it('keeps the anchor stable as the active transcript appends', async () => {
    const result = await renderWithProviders(
      <TranscriptHistoryView
        conversationKey="agent-a"
        messages={makeMessages('a', 251)}
        terminalWidth={100}
      />,
    );

    await waitFor(() => expect(result.lastFrame()).toContain('a-row-250'));
    result.rerender(
      <TranscriptHistoryView
        conversationKey="agent-a"
        messages={makeMessages('a', 252)}
        terminalWidth={100}
      />,
    );

    await waitFor(() => expect(result.lastFrame()).toContain('a-row-251'));
    expect(result.lastFrame().match(/a-row-251/g)).toHaveLength(1);
    result.unmount();
  });

  it('renders the new transcript in the active viewport after switching', async () => {
    const result = await renderWithProviders(
      <TranscriptHistoryView
        conversationKey="agent-a"
        messages={makeMessages('a', 251)}
        terminalWidth={100}
      />,
    );

    await waitFor(() => expect(result.lastFrame()).toContain('a-row-250'));
    result.rerender(
      <TranscriptHistoryView
        conversationKey="agent-b"
        messages={makeMessages('b', 220)}
        terminalWidth={100}
      />,
    );

    await waitFor(() => expect(result.lastFrame()).toContain('b-row-219'));
    const output = result.lastFrame();
    expect(output).toContain('b-row-200');
    expect(output).not.toContain('a-row-250');
    result.unmount();
  });
});

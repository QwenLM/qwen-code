/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { daemonTranscriptToUnifiedMessages } from './transcriptAdapter.js';

describe('daemonTranscriptToUnifiedMessages', () => {
  it('keeps system errors separate from assistant messages', () => {
    const [message] = daemonTranscriptToUnifiedMessages([
      {
        id: 'error-1',
        kind: 'error',
        text: 'SSE stream error',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(message).toMatchObject({
      type: 'tool_call',
      toolCall: {
        kind: 'system_error',
        status: 'failed',
        rawOutput: 'SSE stream error',
      },
    });
  });

  it('preserves cancelled and unknown daemon tool statuses', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      createToolBlock('cancelled-tool', 'cancelled'),
      createToolBlock('future-tool', 'waiting_for_input'),
    ]);

    expect(messages.map((message) => message.toolCall?.status)).toEqual([
      'cancelled',
      'in_progress',
    ]);
  });

  it('maps permission resolution outcomes to user-visible statuses', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      createPermissionBlock('pending-permission'),
      createPermissionBlock('allowed-permission', 'selected:allow'),
      createPermissionBlock('allowed-substring-permission', 'selected:deny-me'),
      createPermissionBlock('cancelled-permission', 'cancelled'),
      createPermissionBlock('denied-permission', 'denied'),
    ]);

    expect(messages.map((message) => message.toolCall?.status)).toEqual([
      'pending',
      'completed',
      'completed',
      'cancelled',
      'failed',
    ]);
  });

  it('sanitizes daemon-sourced text before passing it to React messages', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'assistant-1',
        kind: 'assistant',
        text: '\u202etxt.exe\u001b[31mred\x00',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'tool-1',
        kind: 'tool',
        toolCallId: 'tool-1',
        title: '\u202eRun',
        status: 'completed',
        preview: { kind: 'generic' },
        rawInput: { '\u202ecommand': '\u202enpm test' },
        rawOutput: '\u001b]0;bad\u0007ok',
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    expect(messages[0]?.content).toBe('txt.exered');
    expect(messages[1]?.toolCall).toMatchObject({
      title: 'Run',
      rawInput: { command: 'npm test' },
      rawOutput: 'ok',
    });
  });

  it('renders shell and status text as visible tool content', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'shell-1',
        kind: 'shell',
        text: '\u001b[31mstdout',
        stream: 'stdout',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'status-1',
        kind: 'status',
        text: '\u202econnected',
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    expect(messages[0]?.toolCall).toMatchObject({
      kind: 'bash',
      rawOutput: 'stdout',
      content: [{ content: { text: 'stdout' } }],
    });
    expect(messages[1]?.toolCall).toMatchObject({
      kind: 'status',
      rawOutput: 'connected',
      content: [{ content: { text: 'connected' } }],
    });
  });

  it('computes grouping after filtering debug blocks and renders status', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'user-1',
        kind: 'user',
        text: 'hi',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'debug-1',
        kind: 'debug',
        text: 'internal',
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'status-1',
        kind: 'status',
        text: 'connecting',
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: 'assistant-1',
        kind: 'assistant',
        text: 'hello',
        createdAt: 4,
        updatedAt: 4,
      },
    ]);

    expect(messages).toMatchObject([
      { id: 'user-1', isFirst: true, isLast: false },
      {
        id: 'status-1',
        type: 'tool_call',
        toolCall: {
          kind: 'status',
          rawOutput: 'connecting',
          content: [{ content: { text: 'connecting' } }],
        },
      },
      { id: 'assistant-1', isFirst: false, isLast: true },
    ]);
  });
});

function createToolBlock(
  toolCallId: string,
  status: string,
): Extract<DaemonTranscriptBlock, { kind: 'tool' }> {
  return {
    id: toolCallId,
    kind: 'tool',
    toolCallId,
    title: 'Tool',
    status,
    preview: { kind: 'generic' },
    createdAt: 1,
    updatedAt: 1,
  };
}

function createPermissionBlock(
  requestId: string,
  resolved?: string,
): Extract<DaemonTranscriptBlock, { kind: 'permission' }> {
  return {
    id: requestId,
    kind: 'permission',
    requestId,
    title: 'Permission',
    options: [],
    preview: { kind: 'generic' },
    createdAt: 1,
    updatedAt: 1,
    ...(resolved !== undefined ? { resolved } : {}),
  };
}

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
        clientReceivedAt: 1,
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

  it('maps daemon tool statuses without leaving terminal states spinning', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      createToolBlock('cancelled-tool', 'cancelled'),
      createToolBlock('waiting-tool', 'waiting_for_input'),
      createToolBlock('skipped-tool', 'skipped'),
      createToolBlock('timeout-tool', 'timeout'),
      createToolBlock('future-tool', 'future_status'),
    ]);

    expect(messages.map((message) => message.toolCall?.status)).toEqual([
      'cancelled',
      'pending',
      'cancelled',
      'failed',
      'failed',
    ]);
  });

  it('maps permission resolution outcomes to user-visible statuses', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      createPermissionBlock('pending-permission'),
      createPermissionBlock('allowed-permission', 'selected:allow'),
      createPermissionBlock('allowed-substring-permission', 'selected:deny-me'),
      createPermissionBlock('cancelled-substring-permission', 'selected:abort'),
      createPermissionBlock('grant-permission', 'selected:grant-access'),
      createPermissionBlock('reject-permission', 'selected:reject-policy'),
      createPermissionBlock('dismiss-permission', 'selected:dismiss-dialog'),
      createPermissionBlock('question-choice-permission', 'selected:beijing'),
      createPermissionBlock('disallowed-permission', 'selected:disallow'),
      createPermissionBlock('unblocked-permission', 'selected:unblock'),
      createPermissionBlock('cancelled-permission', 'cancelled'),
      createPermissionBlock('already-resolved-permission', 'already resolved'),
      createPermissionBlock('denied-permission', 'denied'),
      createPermissionBlock('unknown-permission', 'timed out'),
    ]);

    expect(messages.map((message) => message.toolCall?.status)).toEqual([
      'pending',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'failed',
      'completed',
      'cancelled',
      'cancelled',
      'failed',
      'failed',
    ]);
  });

  it('sanitizes daemon-sourced text before passing it to React messages', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'assistant-1',
        kind: 'assistant',
        text: '\u202etxt.exe\u001b[31mred\x00',
        clientReceivedAt: 1,
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
        rawInput: {
          '‮command': '‮npm test',
          apiKey: 'secret-input',
          headers: { Authorization: 'Bearer secret-auth' },
        },
        rawOutput: {
          token: 'secret-output',
          text: ']0;badok',
        },
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    expect(messages[0]?.content).toBe('txt.exered');
    expect(messages[1]?.toolCall).toMatchObject({
      title: 'Run',
      rawInput: {
        command: 'npm test',
        apiKey: '[redacted]',
        headers: { Authorization: '[redacted]' },
      },
      rawOutput: {
        token: '[redacted]',
        text: 'ok',
      },
    });
    expect(JSON.stringify(messages[1]?.toolCall)).not.toContain('secret-');
  });

  it('renders shell and status text as visible tool content', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'shell-1',
        kind: 'shell',
        text: '\u001b[31mstdout',
        stream: 'stdout',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'status-1',
        kind: 'status',
        text: '\u202econnected',
        clientReceivedAt: 2,
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

  it('preserves daemon tool content and locations for specialized renderers', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'tool-rich',
        kind: 'tool',
        toolCallId: 'tool-rich',
        title: 'Read file',
        status: 'completed',
        preview: { kind: 'generic' },
        content: [
          {
            type: 'content',
            content: { type: 'text', text: '\u202eread ok' },
          },
          {
            type: 'diff',
            path: '\u202esrc/index.ts',
            oldText: 'old',
            newText: '\u202enew',
          },
        ],
        locations: [{ path: '\u202esrc/index.ts', line: 3 }],
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(messages[0]?.toolCall).toMatchObject({
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'read ok' },
        },
        {
          type: 'diff',
          path: 'src/index.ts',
          oldText: 'old',
          newText: 'new',
        },
      ],
      locations: [{ path: 'src/index.ts', line: 3 }],
    });
  });

  it('truncates deeply nested daemon values instead of returning raw subtrees', () => {
    let nested: unknown = '\u202eraw';
    for (let i = 0; i < 20; i += 1) {
      nested = { child: nested };
    }

    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'tool-deep',
        kind: 'tool',
        toolCallId: 'tool-deep',
        title: 'Deep',
        status: 'completed',
        preview: { kind: 'generic' },
        rawOutput: nested,
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(messages[0]?.toolCall?.rawOutput).toMatchObject({
      child: expect.any(Object) as object,
    });
    expect(JSON.stringify(messages[0]?.toolCall?.rawOutput)).toContain(
      '[truncated]',
    );
    expect(JSON.stringify(messages[0]?.toolCall?.rawOutput)).not.toContain(
      '\u202e',
    );
  });

  it('computes grouping after filtering debug blocks and renders status', () => {
    const messages = daemonTranscriptToUnifiedMessages([
      {
        id: 'user-1',
        kind: 'user',
        text: 'hi',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'debug-1',
        kind: 'debug',
        text: 'internal',
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'status-1',
        kind: 'status',
        text: 'connecting',
        clientReceivedAt: 3,
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: 'assistant-1',
        kind: 'assistant',
        text: 'hello',
        clientReceivedAt: 4,
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
    clientReceivedAt: 1,
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
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(resolved !== undefined ? { resolved } : {}),
  };
}

describe('previewMarkdown preserves rawOutput (wenshao R3 qwen3.7-max)', () => {
  it('keeps rawOutput as original object and exposes previewMarkdown when enrich enabled', () => {
    const block: DaemonTranscriptBlock = {
      id: 'tool-1',
      kind: 'tool',
      toolCallId: 't',
      title: 'edit file',
      status: 'completed',
      rawInput: { path: '/x.ts', oldText: 'a', newText: 'b' },
      rawOutput: { ok: true, lines: 42, message: 'wrote' },
      preview: {
        kind: 'file_diff',
        path: '/x.ts',
        oldText: 'a',
        newText: 'b',
      },
      clientReceivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    } as DaemonTranscriptBlock;
    const [msg] = daemonTranscriptToUnifiedMessages([block], {
      enrichToolDetailsWithPreview: true,
    });
    const tc = (msg as unknown as { toolCall: Record<string, unknown> })
      .toolCall;
    expect(typeof tc['rawOutput']).toBe('object');
    expect(tc['rawOutput']).toMatchObject({ ok: true, lines: 42 });
    expect(typeof tc['previewMarkdown']).toBe('string');
    expect((tc['previewMarkdown'] as string).includes('/x.ts')).toBe(true);
  });
});

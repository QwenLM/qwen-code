/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChatRecord, Config } from '@qwen-code/qwen-code-core';
import { collectSessionData } from './collect.js';
import type { ExportConfig } from './types.js';

describe('collectSessionData', () => {
  const config = {
    getToolRegistry: vi.fn().mockReturnValue({
      getTool: vi.fn().mockReturnValue(null),
    }),
  } as unknown as Config;

  it('keeps oversized canonical tool results lossless in offline export', async () => {
    const source = `head-${'x'.repeat(499_999)}-tail`;
    const records: ChatRecord[] = [
      {
        uuid: 'assistant-large',
        parentUuid: null,
        sessionId: 'session-large',
        timestamp: '2026-08-03T00:00:00.000Z',
        type: 'assistant',
        cwd: '/workspace',
        version: '1.0.0',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-large',
                name: 'read_file',
                args: { path: '/workspace/large.txt' },
              },
            },
          ],
        },
      },
      {
        uuid: 'tool-large',
        parentUuid: 'assistant-large',
        sessionId: 'session-large',
        timestamp: '2026-08-03T00:00:01.000Z',
        type: 'tool_result',
        cwd: '/workspace',
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-large',
                name: 'read_file',
                response: { output: source },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-large',
          responseParts: [],
          resultDisplay: source,
        },
      },
    ];

    const data = await collectSessionData(
      {
        sessionId: 'session-large',
        startTime: '2026-08-03T00:00:00.000Z',
        messages: records,
      },
      config,
    );
    const toolCall = data.messages.find(
      (message) => message.type === 'tool_call',
    );
    const exportedText = (
      toolCall?.toolCall?.content?.[0] as
        | { content?: { text?: string } }
        | undefined
    )?.content?.text;

    expect(exportedText?.length).toBe(source.length);
    expect(
      createHash('sha256')
        .update(exportedText ?? '')
        .digest('hex'),
    ).toBe(createHash('sha256').update(source).digest('hex'));
  });

  it('skips line-count fallback for truncated saved-session previews', async () => {
    const records: ChatRecord[] = [
      {
        uuid: 'assistant-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'assistant',
        cwd: '',
        version: '1.0.0',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'edit_file',
                args: { file_path: '/test/file.ts' },
              },
            },
          ],
        },
      },
      {
        uuid: 'tool-1',
        parentUuid: 'assistant-1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:01.000Z',
        type: 'tool_result',
        cwd: '',
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'edit_file',
                response: { output: 'ok' },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-1',
          resultDisplay: {
            fileName: 'file.ts',
            fileDiff:
              '--- file.ts\n+++ file.ts\n@@ -1,2 +1,2 @@\n-old\n-preview\n+new\n+preview',
            originalContent: 'old\npreview',
            newContent: 'new\npreview',
            truncatedForSession: true,
          },
        },
      },
    ];

    const data = await collectSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: records,
      },
      config,
    );

    expect(data.metadata?.filesWritten).toBe(1);
    expect(data.metadata?.uniqueFiles).toEqual(['/test/file.ts']);
    expect(data.metadata?.linesAdded).toBe(0);
    expect(data.metadata?.linesRemoved).toBe(0);
  });

  it('accepts the minimal daemon export config shape', async () => {
    const minimalConfig: ExportConfig = {
      getChannel: () => 'web-shell',
    };

    const data = await collectSessionData(
      {
        sessionId: 'session-minimal',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'user-1',
            parentUuid: null,
            sessionId: 'session-minimal',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'user',
            cwd: '',
            version: '1.0.0',
            message: {
              role: 'user',
              parts: [{ text: 'hello' }],
            },
          },
        ],
      },
      minimalConfig,
    );

    expect(data.metadata?.channel).toBe('web-shell');
    expect(data.messages[0]?.message?.parts?.[0]?.text).toBe('hello');
  });

  it('exports a session whose transcript ends on an active goal', async () => {
    // The daemon export config is a Proxy that throws on any method it does not
    // implement, and it implements none of the /goal trust gates. Anything the
    // replayer asks of `config` beyond that shape takes the whole export down.
    const minimalConfig: ExportConfig = { getChannel: () => 'daemon' };

    const data = await collectSessionData(
      {
        sessionId: 'session-goal',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'goal-1',
            parentUuid: null,
            sessionId: 'session-goal',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'system',
            subtype: 'slash_command',
            cwd: '',
            version: '1.0.0',
            systemPayload: {
              phase: 'result',
              rawCommand: '/goal',
              outputHistoryItems: [
                { type: 'goal_status', kind: 'set', condition: 'ship it' },
              ],
            },
          } as unknown as ChatRecord,
        ],
      },
      minimalConfig,
    );

    expect(data.metadata?.channel).toBe('daemon');
  });

  it('replays tool calls when daemon export config has no tool registry', async () => {
    const minimalConfig: ExportConfig = {};

    const data = await collectSessionData(
      {
        sessionId: 'session-minimal-tool',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'assistant-tool-1',
            parentUuid: null,
            sessionId: 'session-minimal-tool',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'assistant',
            cwd: '',
            version: '1.0.0',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-minimal',
                    name: 'shell',
                    args: { command: 'pwd' },
                  },
                },
              ],
            },
          },
        ],
      },
      minimalConfig,
    );

    const toolCall = data.messages.find(
      (message) => message.type === 'tool_call',
    );
    expect(toolCall?.toolCall).toMatchObject({
      toolCallId: 'call-minimal',
      title: 'shell',
      status: 'failed',
    });
  });
});

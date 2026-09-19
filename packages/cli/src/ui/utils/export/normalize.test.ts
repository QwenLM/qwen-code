/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord, Config } from '@qwen-code/qwen-code-core';
import { collectSessionData } from './collect.js';
import { normalizeSessionData } from './normalize.js';
import type { ExportConfig } from './types.js';

describe('normalizeSessionData', () => {
  const config = {
    getToolRegistry: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  it.each(['thought-first', 'thought-last'])(
    'attaches assistant usage to the answer after collection (%s)',
    async (order) => {
      const records: ChatRecord[] = [
        {
          uuid: 'user-usage-1',
          parentUuid: null,
          sessionId: 'session-usage',
          timestamp: '2026-09-17T15:52:44.524Z',
          type: 'user',
          cwd: '',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'first question' }] },
        },
        {
          uuid: 'assistant-usage-1',
          parentUuid: 'user-usage-1',
          sessionId: 'session-usage',
          timestamp: '2026-09-17T15:52:48.291Z',
          type: 'assistant',
          cwd: '',
          version: '1.0.0',
          message: {
            role: 'model',
            parts: [
              { text: 'thinking about the first answer', thought: true },
              { text: 'the first answer' },
            ],
          },
          usageMetadata: { totalTokenCount: 222 },
        },
        {
          uuid: 'user-usage-2',
          parentUuid: 'assistant-usage-1',
          sessionId: 'session-usage',
          timestamp: '2026-09-17T15:53:10.000Z',
          type: 'user',
          cwd: '',
          version: '1.0.0',
          message: { role: 'user', parts: [{ text: 'second question' }] },
        },
        {
          uuid: 'assistant-usage-2',
          parentUuid: 'user-usage-2',
          sessionId: 'session-usage',
          timestamp: '2026-09-17T15:53:14.500Z',
          type: 'assistant',
          cwd: '',
          version: '1.0.0',
          message: {
            role: 'model',
            parts: [
              { text: 'thinking about the second answer', thought: true },
              { text: 'the second answer' },
            ],
          },
          usageMetadata: { totalTokenCount: 333 },
        },
      ];

      if (order === 'thought-last') {
        for (const record of records) {
          if (record.type === 'assistant') record.message?.parts?.reverse();
        }
      }

      const collected = await collectSessionData(
        {
          sessionId: 'session-usage',
          startTime: '2026-09-17T15:52:48.291Z',
          messages: records,
        },
        config,
      );
      expect(
        collected.messages.map((message) => message.message?.role),
      ).toEqual(
        order === 'thought-last'
          ? ['user', 'assistant', 'thinking', 'user', 'assistant', 'thinking']
          : ['user', 'thinking', 'assistant', 'user', 'thinking', 'assistant'],
      );
      const normalized = normalizeSessionData(collected, records, config);

      const thinkingMessages = normalized.messages.filter(
        (message) => message.message?.role === 'thinking',
      );
      const answerMessages = normalized.messages.filter(
        (message) => message.message?.role === 'assistant',
      );
      expect(thinkingMessages).toHaveLength(2);
      expect(thinkingMessages.every((message) => !message.usageMetadata)).toBe(
        true,
      );
      expect(
        answerMessages.map((message) => [
          message.uuid,
          message.usageMetadata?.totalTokenCount,
        ]),
      ).toEqual([
        ['assistant-usage-1', 222],
        ['assistant-usage-2', 333],
      ]);
    },
  );

  it.each([false, true])(
    'keeps usage on thinking when there is no answer (tool call: %s)',
    async (withToolCall) => {
      const record: ChatRecord = {
        uuid: 'assistant-thinking',
        parentUuid: null,
        sessionId: 'session-thinking',
        timestamp: '2026-09-17T15:52:48.291Z',
        type: 'assistant',
        cwd: '',
        version: '1.0.0',
        message: {
          role: 'model',
          parts: [
            { text: 'thinking before acting', thought: true },
            ...(withToolCall
              ? [
                  {
                    functionCall: {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: 'file.txt' },
                    },
                  },
                ]
              : []),
          ],
        },
        usageMetadata: { totalTokenCount: 222 },
      };
      const collected = await collectSessionData(
        {
          sessionId: record.sessionId,
          startTime: record.timestamp,
          messages: [record],
        },
        config,
      );
      const normalized = normalizeSessionData(collected, [record], config);
      const thinking = normalized.messages.filter(
        (message) => message.message?.role === 'thinking',
      );
      expect(thinking).toHaveLength(1);
      expect(thinking[0]).toMatchObject({
        uuid: record.uuid,
        usageMetadata: { totalTokenCount: 222 },
      });
      expect(
        normalized.messages.filter((message) => message.usageMetadata),
      ).toHaveLength(1);
      expect(
        normalized.messages.filter((message) => message.type === 'tool_call'),
      ).toHaveLength(withToolCall ? 1 : 0);
    },
  );

  it.each(['assistant', 'thinking'])(
    'preserves existing usage on the selected %s message',
    (role) => {
      const record: ChatRecord = {
        uuid: 'assistant-existing-usage',
        parentUuid: null,
        sessionId: 'session-usage',
        timestamp: '2026-09-17T15:52:48.291Z',
        type: 'assistant',
        cwd: '',
        version: '1.0.0',
        usageMetadata: { totalTokenCount: 222 },
      };
      const normalized = normalizeSessionData(
        {
          sessionId: record.sessionId,
          startTime: record.timestamp,
          messages: [
            {
              uuid: record.uuid,
              timestamp: record.timestamp,
              type: 'assistant',
              message: { role, parts: [{ text: 'existing message' }] },
              usageMetadata: { totalTokenCount: 111 },
            },
          ],
        },
        [record],
        config,
      );
      expect(normalized.messages[0].usageMetadata).toEqual({
        totalTokenCount: 111,
      });
    },
  );

  it('does not export truncated saved-session previews as full diffs', () => {
    const record: ChatRecord = {
      uuid: 'tool-1',
      parentUuid: null,
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
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
          fileName: '/test/file.ts',
          fileDiff:
            '--- /test/file.ts\n+++ /test/file.ts\n@@ -1 +1 @@\n-omitted\n+preview',
          originalContent: 'old preview',
          newContent: 'new preview',
          truncatedForSession: true,
          fileDiffLength: 200000,
          fileDiffTruncated: true,
        },
      },
    };

    const normalized = normalizeSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [],
      },
      [record],
      config,
    );

    expect(normalized.messages[0].toolCall?.content).toEqual([
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Full diff omitted from saved session history for /test/file.ts. Original fileDiff length: 200000 chars.',
        },
      },
    ]);
  });

  it('exports the diff path from filePath rather than the fileName basename', () => {
    const record: ChatRecord = {
      uuid: 'tool-2',
      parentUuid: null,
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_result',
      cwd: '',
      version: '1.0.0',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-2',
              name: 'edit_file',
              response: { output: 'ok' },
            },
          },
        ],
      },
      toolCallResult: {
        callId: 'call-2',
        resultDisplay: {
          fileName: 'Foo.kt',
          filePath: '/workspace/app/src/main/java/com/example/Foo.kt',
          fileDiff: '--- Foo.kt\n+++ Foo.kt\n',
          originalContent: 'old',
          newContent: 'new',
        },
      },
    };

    const normalized = normalizeSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [],
      },
      [record],
      config,
    );

    expect(normalized.messages[0].toolCall?.content).toEqual([
      {
        type: 'diff',
        path: '/workspace/app/src/main/java/com/example/Foo.kt',
        oldText: 'old',
        newText: 'new',
      },
    ]);
  });

  it('falls back to the fileName basename when filePath is absent (pre-fix persisted sessions)', () => {
    const record: ChatRecord = {
      uuid: 'tool-2b',
      parentUuid: null,
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_result',
      cwd: '',
      version: '1.0.0',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-2b',
              name: 'edit_file',
              response: { output: 'ok' },
            },
          },
        ],
      },
      toolCallResult: {
        callId: 'call-2b',
        resultDisplay: {
          fileName: 'Foo.kt',
          fileDiff: '--- Foo.kt\n+++ Foo.kt\n',
          originalContent: 'old',
          newContent: 'new',
        },
      },
    };

    const normalized = normalizeSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [],
      },
      [record],
      config,
    );

    expect(normalized.messages[0].toolCall?.content).toEqual([
      {
        type: 'diff',
        path: 'Foo.kt',
        oldText: 'old',
        newText: 'new',
      },
    ]);
  });

  it('accepts the minimal daemon export config shape', () => {
    const minimalConfig: ExportConfig = {};
    const record: ChatRecord = {
      uuid: 'tool-1',
      parentUuid: null,
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_result',
      cwd: '',
      version: '1.0.0',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'ok' },
            },
          },
        ],
      },
      toolCallResult: {
        callId: 'call-1',
        resultDisplay: 'read result',
      },
    };

    const normalized = normalizeSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [],
      },
      [record],
      minimalConfig,
    );

    expect(normalized.messages[0].toolCall?.title).toBe('read_file');
  });

  it.each([
    { failed: false, expectedStatus: 'completed' },
    { failed: true, expectedStatus: 'failed' },
  ] as const)(
    'exports the vision bridge disclosure when failed=$failed',
    ({ failed, expectedStatus }) => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: failed
          ? 'Failed to read PDF after rendering pages 20-23'
          : 'Transcribed PDF pages 20-23; remaining pages 24-25',
        notice: failed
          ? 'Vision bridge (qwen3-vl-plus) failed after sending images to dashscope.aliyuncs.com.'
          : 'Converted 4 images via qwen3-vl-plus (dashscope.aliyuncs.com).',
      };
      const output = failed
        ? 'Cannot extract text from PDF'
        : 'Page 20: transcribed content';
      const record: ChatRecord = {
        uuid: `tool-pdf-${expectedStatus}`,
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'tool_result',
        cwd: '',
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: `call-pdf-${expectedStatus}`,
                name: 'read_file',
                response: { output },
              },
            },
          ],
        },
        toolCallResult: {
          callId: `call-pdf-${expectedStatus}`,
          resultDisplay,
          ...(failed && { error: new Error('No extractable text layer.') }),
        },
      };

      const normalized = normalizeSessionData(
        {
          sessionId: 'session-1',
          startTime: '2025-01-01T00:00:00.000Z',
          messages: [],
        },
        [record],
        config,
      );

      expect(normalized.messages[0].toolCall?.status).toBe(expectedStatus);
      expect(normalized.messages[0].toolCall?.content).toEqual([
        {
          type: 'content',
          content: {
            type: 'text',
            text: `${resultDisplay.summary}\n${resultDisplay.notice}`,
          },
        },
        {
          type: 'content',
          content: { type: 'text', text: output },
        },
      ]);
    },
  );

  it('sanitizes terminal control characters in exported vision bridge disclosures', () => {
    const record: ChatRecord = {
      uuid: 'tool-pdf-sanitized',
      parentUuid: null,
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_result',
      cwd: '',
      version: '1.0.0',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-pdf-sanitized',
              name: 'read_file',
              response: { output: 'Page content' },
            },
          },
        ],
      },
      toolCallResult: {
        callId: 'call-pdf-sanitized',
        resultDisplay: {
          type: 'vision_bridge_notice',
          summary: 'Read PDF \u001b[31mreport.pdf\u001b[0m',
          notice: 'Converted via \u202eqwen-vl',
        },
      },
    };

    const normalized = normalizeSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [],
      },
      [record],
      config,
    );
    expect(normalized.messages[0].toolCall?.content?.[0]).toEqual({
      type: 'content',
      content: {
        type: 'text',
        text: 'Read PDF \\u001b[31mreport.pdf\\u001b[0m\nConverted via qwen-vl',
      },
    });
  });

  it('matches tool results by functionResponse id when callId is absent', () => {
    const record: ChatRecord = {
      uuid: 'tool-result-record',
      parentUuid: null,
      sessionId: 'session-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'tool_result',
      cwd: '',
      version: '1.0.0',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'function-response-call-id',
              name: 'read_file',
              response: { output: 'read result' },
            },
          },
        ],
      },
      toolCallResult: {
        resultDisplay: 'read result',
      },
    };

    const normalized = normalizeSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'tool-call-record',
            sessionId: 'session-1',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'tool_call',
            toolCall: {
              toolCallId: 'function-response-call-id',
              kind: 'other',
              title: 'read_file',
              status: 'in_progress',
            },
          },
        ],
      },
      [record],
      config,
    );

    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0].toolCall?.status).toBe('completed');
    expect(normalized.messages[0].toolCall?.content).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: 'read result' },
      },
    ]);
  });
});

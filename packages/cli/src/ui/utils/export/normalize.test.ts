/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord, Config } from '@qwen-code/qwen-code-core';
import { normalizeSessionData } from './normalize.js';
import type { ExportConfig } from './types.js';

describe('normalizeSessionData', () => {
  const config = {
    getToolRegistry: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

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
    const notice = normalized.messages[0].toolCall?.content?.[0];

    expect(notice).toMatchObject({
      type: 'content',
      content: { type: 'text' },
    });
    if (notice?.type !== 'content' || notice.content.type !== 'text') {
      throw new Error('Expected exported vision bridge notice text');
    }
    expect(notice.content.text).not.toContain('\u001b');
    expect(notice.content.text).not.toContain('\u202e');
    expect(notice.content.text).toContain('report.pdf');
    expect(notice.content.text).toContain('qwen-vl');
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

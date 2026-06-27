/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord, Config } from '@qwen-code/qwen-code-core';
import { normalizeSessionData } from './normalize.js';

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
});

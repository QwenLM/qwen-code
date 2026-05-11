/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord, Config } from '@qwen-code/qwen-code-core';
import { collectSessionData } from './collect.js';

describe('collectSessionData', () => {
  const config = {
    getToolRegistry: vi.fn().mockReturnValue({
      getTool: vi.fn().mockReturnValue(null),
    }),
  } as unknown as Config;

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
});

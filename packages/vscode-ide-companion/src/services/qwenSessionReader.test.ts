/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QwenSessionReader } from './qwenSessionReader.js';

describe('QwenSessionReader JSONL parsing', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('preserves thought parts separately from assistant content', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-session-reader-'));
    cleanup.push(tempDir);
    const sessionPath = path.join(tempDir, 'session.jsonl');

    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({
          sessionId: 'session-1',
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-03-06T12:00:01.000Z',
          message: {
            parts: [
              { text: 'thinking step', thought: true },
              { text: 'final answer' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const reader = new QwenSessionReader();
    const session = await (reader as unknown as {
      readJsonlSession(filePath: string, includeMessages: boolean): Promise<{
        messages: Array<{ content: string; thoughts?: unknown[] }>;
      } | null>;
    }).readJsonlSession(sessionPath, true);

    expect(session?.messages).toEqual([
      expect.objectContaining({
        content: 'final answer',
        thoughts: ['thinking step'],
      }),
    ]);
  });
});

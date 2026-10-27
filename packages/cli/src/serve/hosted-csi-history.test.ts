/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  collectHostedCsiHistory,
  HostedCsiHistoryLimitError,
} from './hosted-csi-session.js';

function record(text: string): ChatRecord {
  return {
    uuid: 'record',
    parentUuid: null,
    sessionId: 'session',
    timestamp: new Date(0).toISOString(),
    type: 'assistant',
    cwd: '/workspace',
    version: 'test',
    message: { role: 'model', parts: [{ text }] },
  };
}

describe('internal CSI bulk history', () => {
  it('preserves the complete small-history array response', async () => {
    const records = [record('first'), record('second')];
    expect(
      await collectHostedCsiHistory({
        async *[Symbol.asyncIterator]() {
          yield* records;
        },
      }),
    ).toEqual(records);
  });

  it('refuses an oversized stream explicitly and closes it without returning a short history', async () => {
    let closed = false;
    let read = 0;
    const text = 'x'.repeat(8 * 1024 * 1024);
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          for (let index = 0; index < 20; index++) {
            read++;
            yield { ...record(text), uuid: String(index) };
          }
        } finally {
          closed = true;
        }
      },
    };
    await expect(collectHostedCsiHistory(source)).rejects.toMatchObject({
      name: HostedCsiHistoryLimitError.name,
      code: 'csi_history_requires_pagination',
      status: 413,
      limitBytes: 64 * 1024 * 1024,
      message: expect.stringContaining('paged transcript'),
    });
    expect(read).toBe(8);
    expect(closed).toBe(true);
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  SessionTranscriptCursorState,
  SessionTranscriptRecordPage,
} from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryReplayer } from './history-replayer.js';
import {
  collectHistoryReplayUpdates,
  createReplayCumulativeUsage,
  replayTranscriptRecordPage,
} from './history-replay-page.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const TIMESTAMP = '2026-07-12T00:00:00.000Z';

function userRecord(): ChatRecord {
  return {
    uuid: 'user-record',
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: TIMESTAMP,
    type: 'user',
    cwd: '/workspace',
    version: '1.0.0',
    message: {
      role: 'user',
      parts: [{ text: 'hello' }],
    },
  };
}

function cursorState(): SessionTranscriptCursorState {
  return {
    v: 1,
    sessionId: SESSION_ID,
    fileIdentity: { dev: 1, ino: 2 },
    snapshotSize: 100,
    position: 1,
    leafUuid: 'next-record',
    startTime: TIMESTAMP,
    lastUpdated: TIMESTAMP,
  };
}

function recordPage(
  overrides: Partial<SessionTranscriptRecordPage> = {},
): SessionTranscriptRecordPage {
  return {
    sessionId: SESSION_ID,
    filePath: '/workspace/chats/session.jsonl',
    records: [],
    gaps: [],
    hasMore: false,
    startTime: TIMESTAMP,
    lastUpdated: TIMESTAMP,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('history replay page', () => {
  it('lifts record timestamps for bulk replay callers', async () => {
    const result = await collectHistoryReplayUpdates({
      sessionId: SESSION_ID,
      records: [userRecord()],
      cumulativeUsage: createReplayCumulativeUsage(),
    });

    expect(result.updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        timestamp: Date.parse(TIMESTAMP),
      }),
    ]);
  });

  it('filters malformed replay state before encoding the next cursor', async () => {
    const logger = { warn: vi.fn() };
    const encodeCursor = vi.fn(() => 'next-cursor');
    const page = recordPage({
      hasMore: true,
      nextCursorState: cursorState(),
      replay: {
        pendingToolCalls: [
          {
            callId: 'call-1',
            toolName: 'Read',
            recordId: 'record-1',
          },
          { callId: 1, toolName: 'invalid', recordId: 'record-2' },
        ],
        cumulativeUsage: {
          promptTokens: 1,
          cachedTokens: 2,
          candidateTokens: 3,
          apiTimeMs: 4,
        },
      },
    });

    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page,
      encodeCursor,
      logger,
    });

    expect(result).toMatchObject({
      updates: [],
      nextCursor: 'next-cursor',
      hasMore: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 of 2 malformed pending tool calls'),
    );
    expect(encodeCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        replay: {
          pendingToolCalls: [
            {
              callId: 'call-1',
              toolName: 'Read',
              recordId: 'record-1',
            },
          ],
          cumulativeUsage: {
            promptTokens: 1,
            cachedTokens: 2,
            candidateTokens: 3,
            apiTimeMs: 4,
          },
        },
      }),
    );
  });

  it('terminates pagination when replay conversion fails', async () => {
    vi.spyOn(HistoryReplayer.prototype, 'replayPage').mockRejectedValueOnce(
      new Error('replay failed'),
    );
    const encodeCursor = vi.fn(() => 'next-cursor');

    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        records: [userRecord()],
        hasMore: true,
        nextCursorState: cursorState(),
      }),
      encodeCursor,
    });

    expect(result).toMatchObject({
      updates: [],
      hasMore: false,
      partial: true,
      replayError: 'Replay conversion failed for this page',
    });
    expect(result.nextCursor).toBeUndefined();
    expect(encodeCursor).not.toHaveBeenCalled();
  });
});

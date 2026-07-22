/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  GoalRecord,
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

const GOAL: GoalRecord = {
  goalId: 'goal-1',
  revision: 1,
  objective: 'ship paged replay',
  status: 'active',
  evidenceCursor: { recordId: null },
  turnCount: 0,
  activeTimeMs: 0,
  createdAt: 100,
  updatedAt: 100,
};

function goalStateRecord(
  uuid: string,
  cause: 'create' | 'clear',
  goal: GoalRecord | null,
): ChatRecord {
  return {
    ...userRecord(),
    uuid,
    type: 'system',
    subtype: 'goal_state',
    message: undefined,
    systemPayload: {
      v: 2,
      cause,
      snapshot: { v: 2, activity: 'idle', goal },
    },
  };
}

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
  it('carries Goal state across pages so clear retains the old objective', async () => {
    let encodedState: SessionTranscriptCursorState | undefined;
    const first = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        records: [goalStateRecord('goal-create', 'create', GOAL)],
        hasMore: true,
        nextCursorState: cursorState(),
      }),
      encodeCursor: (state) => {
        encodedState = state;
        return 'next-cursor';
      },
    });

    expect(first.nextCursor).toBe('next-cursor');
    expect(encodedState?.replay).toMatchObject({
      goalState: { v: 2, goal: GOAL, activity: 'idle' },
    });

    const second = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        records: [goalStateRecord('goal-clear', 'clear', null)],
        replay: encodedState?.replay,
      }),
      encodeCursor: vi.fn(),
    });
    const meta = (second.updates[0] as unknown as { _meta: unknown })
      ._meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      goalState: { v: 2, goal: null, activity: 'idle' },
      goalStatus: { kind: 'cleared', condition: GOAL.objective },
      'qwen.session.recordId': 'goal-clear',
    });
  });

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

  it('uses authoritative v2 state before a bulk recent cutoff to project a clear', async () => {
    const result = await collectHistoryReplayUpdates({
      sessionId: SESSION_ID,
      records: [goalStateRecord('goal-clear', 'clear', null)],
      goalState: { v: 2, goal: GOAL, activity: 'idle' },
      cumulativeUsage: createReplayCumulativeUsage(),
    });

    const meta = (result.updates[0] as unknown as { _meta: unknown })
      ._meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      goalState: { v: 2, goal: null, activity: 'idle' },
      goalStatus: { kind: 'cleared', condition: GOAL.objective },
    });
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
          v: 1,
          pendingToolCalls: [
            {
              callId: 'call-1',
              toolName: 'Read',
              sourceRecordId: 'record-1',
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

  it('drops a malformed Goal snapshot from replay cursor state', async () => {
    const logger = { warn: vi.fn() };
    const encodeCursor = vi.fn(() => 'next-cursor');

    await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        hasMore: true,
        nextCursorState: cursorState(),
        replay: {
          goalState: {
            v: 2,
            goal: GOAL,
            activity: 'running',
          },
        },
      }),
      encodeCursor,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed Goal state'),
    );
    expect(encodeCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        replay: expect.not.objectContaining({ goalState: expect.anything() }),
      }),
    );
  });

  it('replays backward pages without pending forward tool state', async () => {
    const replayPage = vi
      .spyOn(HistoryReplayer.prototype, 'replayPage')
      .mockResolvedValueOnce({
        pendingToolCalls: [],
        replay: {
          v: 1,
          pendingToolCalls: [],
          cumulativeUsage: createReplayCumulativeUsage(),
        },
      });
    const encodeCursor = vi.fn(() => 'next-cursor');

    await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        direction: 'backward',
        hasMore: true,
        nextCursorState: cursorState(),
        replay: {
          goalState: { v: 2, goal: GOAL, activity: 'idle' },
          pendingToolCalls: [
            {
              callId: 'stale-call',
              toolName: 'Read',
              recordId: 'stale-record',
            },
          ],
        },
      }),
      encodeCursor,
    });

    expect(replayPage).toHaveBeenCalledWith([], {
      pendingToolCalls: [],
      finalizeDangling: true,
      gaps: [],
      goalState: { v: 2, goal: GOAL, activity: 'idle' },
    });
    expect(encodeCursor).toHaveBeenCalledWith(cursorState());
  });

  it('uses authoritative backward-page replay state to project a clear objective', async () => {
    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        direction: 'backward',
        records: [goalStateRecord('goal-clear', 'clear', null)],
        replay: {
          goalState: { v: 2, goal: GOAL, activity: 'idle' },
        },
      }),
      encodeCursor: vi.fn(),
    });

    const meta = (result.updates[0] as unknown as { _meta: unknown })
      ._meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      goalState: { v: 2, goal: null, activity: 'idle' },
      goalStatus: { kind: 'cleared', condition: GOAL.objective },
    });
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

  it('rejects an unknown replay cursor state version', async () => {
    await expect(
      replayTranscriptRecordPage({
        sessionId: SESSION_ID,
        page: recordPage({ replay: { v: 2 } }),
        encodeCursor: vi.fn(),
      }),
    ).rejects.toThrow('Unsupported transcript replay state version');
  });
});

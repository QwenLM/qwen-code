/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  GoalSnapshotV2,
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
const GOAL_STATE: GoalSnapshotV2 = {
  v: 2,
  activity: 'idle',
  goal: {
    goalId: 'goal-1',
    revision: 1,
    objective: 'ship it',
    status: 'active',
    evidenceCursor: { recordId: 'goal-state' },
    turnCount: 2,
    activeTimeMs: 1000,
    createdAt: 1,
    updatedAt: 2,
  },
};

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

  it('replays backward pages without forward replay state', async () => {
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
    });
    expect(encodeCursor).toHaveBeenCalledWith(cursorState());
  });

  it('passes authoritative Goal state into backward replay', async () => {
    const replayPage = vi
      .spyOn(HistoryReplayer.prototype, 'replayPage')
      .mockResolvedValueOnce({
        pendingToolCalls: [],
        replay: {
          v: 1,
          pendingToolCalls: [],
          cumulativeUsage: createReplayCumulativeUsage(),
          goalState: GOAL_STATE,
        },
      });

    await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        direction: 'backward',
        replay: { goalState: GOAL_STATE },
      }),
      encodeCursor: vi.fn(),
    });

    expect(replayPage).toHaveBeenCalledWith([], {
      pendingToolCalls: [],
      finalizeDangling: true,
      gaps: [],
      goalState: GOAL_STATE,
    });
  });

  it('drops a malformed goalState from replay state and warns', async () => {
    const logger = { warn: vi.fn() };
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

    await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        replay: { goalState: { v: 2, activity: 'bogus', goal: null } },
      }),
      encodeCursor: vi.fn(),
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[transcript] replay state dropped a malformed Goal state',
    );
    expect(replayPage).toHaveBeenCalledWith([], {
      pendingToolCalls: [],
      finalizeDangling: true,
      gaps: [],
    });
  });

  it('seeds backward replay so a cleared Goal keeps its prior condition', async () => {
    // Drives the real (unspied) replayPage: the authoritative pre-page Goal
    // state must seed the replay machine so a `clear` record still projects its
    // original condition, iteration count, and timing. Without the seed the
    // cleared card degrades to an empty condition.
    const priorGoalState: GoalSnapshotV2 = {
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'goal-1',
        revision: 1,
        objective: 'ship the transcript work',
        status: 'active',
        evidenceCursor: { recordId: 'goal-state' },
        turnCount: 3,
        activeTimeMs: 1234,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const goalClearRecord = {
      uuid: 'goal-clear',
      parentUuid: 'u2',
      sessionId: SESSION_ID,
      timestamp: TIMESTAMP,
      type: 'system',
      subtype: 'goal_state',
      cwd: '/workspace',
      version: '1.0.0',
      systemPayload: {
        v: 2,
        cause: 'clear',
        snapshot: { v: 2, activity: 'idle', goal: null },
      },
    } as unknown as ChatRecord;

    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        direction: 'backward',
        records: [goalClearRecord],
        replay: { goalState: priorGoalState },
      }),
      encodeCursor: vi.fn(),
    });

    const goalUpdate = result.updates.find((update) => {
      const meta = (update as { _meta?: Record<string, unknown> })._meta;
      return meta?.['goalStatus'] !== undefined;
    }) as { _meta?: Record<string, unknown> } | undefined;

    expect(goalUpdate?._meta).toMatchObject({
      goalState: { v: 2, goal: null, activity: 'idle' },
      goalStatus: {
        kind: 'cleared',
        condition: 'ship the transcript work',
        iterations: 3,
        setAt: 10,
        durationMs: 1234,
      },
    });
    expect(goalUpdate?._meta?.['goalStatus']).not.toHaveProperty('type');
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

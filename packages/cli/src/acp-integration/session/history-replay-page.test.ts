/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  GoalRecord,
  GoalSnapshotV2,
  SessionTranscriptCursorState,
  SessionTranscriptRecordPage,
} from '@qwen-code/qwen-code-core';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectAcpToolResultUpdate } from './acp-tool-result-text-projection.js';
import {
  HistoryReplayer,
  MISSING_TOOL_RESULT_MESSAGE,
} from './history-replayer.js';
import {
  collectHistoryReplayUpdates,
  createReplayCumulativeUsage,
  replayTranscriptRecordPage,
} from './history-replay-page.js';

const observeAcpProjectionMock = vi.hoisted(() => vi.fn());
vi.mock(
  '../../utils/tool-result-boundary-diagnostics.js',
  async (original) => ({
    ...(await original<
      typeof import('../../utils/tool-result-boundary-diagnostics.js')
    >()),
    observeAcpToolResultProjection: observeAcpProjectionMock,
  }),
);

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

function assistantRecord(): ChatRecord {
  return {
    ...userRecord(),
    uuid: 'assistant-record',
    parentUuid: 'user-record',
    type: 'assistant',
    message: {
      role: 'model',
      parts: [{ text: 'answer' }],
    },
  };
}

function toolCallRecord(): ChatRecord {
  return {
    uuid: 'tool-call-record',
    parentUuid: 'user-record',
    sessionId: SESSION_ID,
    timestamp: TIMESTAMP,
    type: 'assistant',
    cwd: '/workspace',
    version: '1.0.0',
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call-1',
            name: 'read_file',
            args: { path: '/workspace/file.txt' },
          },
        },
      ],
    },
  };
}

function toolResultRecord(): ChatRecord {
  return {
    uuid: 'tool-result-record',
    parentUuid: 'tool-call-record',
    sessionId: SESSION_ID,
    timestamp: TIMESTAMP,
    type: 'tool_result',
    cwd: '/workspace',
    version: '1.0.0',
    message: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            response: { result: 'contents' },
          },
        },
      ],
    },
    toolCallResult: {
      callId: 'call-1',
      responseParts: [],
      resultDisplay: 'contents',
      error: undefined,
      errorType: undefined,
    },
  };
}

function largeToolResultRecord(
  textParts: string[],
  resultDisplay: string,
): ChatRecord {
  return {
    uuid: 'tool-record',
    parentUuid: 'assistant-record',
    sessionId: SESSION_ID,
    timestamp: TIMESTAMP,
    type: 'tool_result',
    cwd: '/workspace',
    version: '1.0.0',
    message: {
      role: 'user',
      parts: textParts.map((output) => ({
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: { output },
        },
      })),
    },
    toolCallResult: {
      callId: 'call-1',
      responseParts: [],
      resultDisplay,
    },
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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
  it('bounds textual tool results collected for bulk replay', async () => {
    const source = 'x'.repeat(499_999);
    const result = await collectHistoryReplayUpdates({
      sessionId: SESSION_ID,
      records: [largeToolResultRecord([source], source)],
      cumulativeUsage: createReplayCumulativeUsage(),
    });
    const update = result.updates.find(
      (candidate) => candidate.sessionUpdate === 'tool_call_update',
    );

    expect(update).toBeDefined();
    const record = update as unknown as Record<string, unknown>;
    expect(jsonBytes(record['content'])).toBeLessThanOrEqual(65_536);
    expect(jsonBytes(record['rawOutput'])).toBeLessThanOrEqual(65_536);
    expect(projectAcpToolResultUpdate(update!)).toBe(update);
  });

  it('bounds multi-block textual tool results in paged replay', async () => {
    const page = recordPage({
      records: [
        largeToolResultRecord(
          ['a'.repeat(300_000), 'b'.repeat(300_000)],
          'r'.repeat(600_001),
        ),
      ],
    });
    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page,
      encodeCursor: vi.fn(),
    });
    const update = result.updates.find(
      (candidate) => candidate.sessionUpdate === 'tool_call_update',
    );

    expect(update).toBeDefined();
    const record = update as unknown as Record<string, unknown>;
    expect(jsonBytes(record['content'])).toBeLessThanOrEqual(65_536);
    expect(jsonBytes(record['rawOutput'])).toBeLessThanOrEqual(65_536);
    expect(
      (record['content'] as Array<{ content: { text: string } }>).map(
        (block) => block.content.text,
      ),
    ).toHaveLength(2);
  });

  it('lifts record timestamps for bulk replay callers', async () => {
    observeAcpProjectionMock.mockClear();
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
    const deliveredUpdate = result.updates[0];
    const projectionCall = observeAcpProjectionMock.mock.calls.find(
      ([, , sessionId]) => sessionId === SESSION_ID,
    );
    expect(projectionCall?.[3]).toBe(deliveredUpdate);
  });

  it('attaches the checkpoint only to the final chunk of a multi-chunk Assistant record', async () => {
    // One assistant record replays as text/thought/text. The checkpoint
    // marks the END of the record, so only the last visible assistant
    // chunk may expose the branch point.
    const multiChunk: ChatRecord = {
      ...assistantRecord(),
      message: {
        role: 'model',
        parts: [
          { text: 'first part' },
          { text: 'thinking', thought: true },
          { text: 'last part' },
        ],
      },
    };

    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        records: [multiChunk],
        branchPointsByAssistantUuid: {
          'assistant-record': 'checkpoint-record',
        },
      }),
      encodeCursor: vi.fn(),
    });

    const readBranchRecordId = (update: SessionUpdate): string | undefined => {
      const meta = (update as { _meta?: Record<string, unknown> })._meta;
      const transcript =
        meta && typeof meta['qwenTranscript'] === 'object'
          ? (meta['qwenTranscript'] as Record<string, unknown>)
          : undefined;
      const branchRecordId = transcript?.['branchRecordId'];
      return typeof branchRecordId === 'string' ? branchRecordId : undefined;
    };

    const decorated = result.updates.filter(
      (update) => readBranchRecordId(update) !== undefined,
    );
    expect(decorated).toHaveLength(1);
    expect(decorated[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'last part' },
    });

    const thoughtChunk = result.updates.find(
      (update) => update.sessionUpdate === 'agent_thought_chunk',
    );
    expect(thoughtChunk).toBeDefined();
    expect(readBranchRecordId(thoughtChunk!)).toBeUndefined();
    const firstChunk = result.updates.find(
      (update) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        (update as { content?: { text?: string } }).content?.text ===
          'first part',
    );
    expect(firstChunk).toBeDefined();
    expect(readBranchRecordId(firstChunk!)).toBeUndefined();
  });

  it('fails incrementally before collecting an update above the count limit', async () => {
    await expect(
      collectHistoryReplayUpdates({
        sessionId: SESSION_ID,
        records: [userRecord()],
        cumulativeUsage: createReplayCumulativeUsage(),
        limits: { maxBytes: Number.MAX_SAFE_INTEGER, maxUpdates: 0 },
      }),
    ).rejects.toMatchObject({
      name: 'HistoryReplayLimitError',
      reason: 'updates',
      observed: 1,
      limit: 0,
    });
  });

  it('fails incrementally before retaining serialized updates above the byte limit', async () => {
    await expect(
      collectHistoryReplayUpdates({
        sessionId: SESSION_ID,
        records: [userRecord()],
        cumulativeUsage: createReplayCumulativeUsage(),
        limits: { maxBytes: 2, maxUpdates: 1 },
      }),
    ).rejects.toMatchObject({
      name: 'HistoryReplayLimitError',
      reason: 'bytes',
      limit: 2,
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
          goalCause: 'verifier_reject',
        },
      });

    await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        direction: 'backward',
        replay: { goalState: GOAL_STATE, goalCause: 'verifier_reject' },
      }),
      encodeCursor: vi.fn(),
    });

    expect(replayPage).toHaveBeenCalledWith([], {
      pendingToolCalls: [],
      finalizeDangling: true,
      gaps: [],
      goalState: GOAL_STATE,
      goalCause: 'verifier_reject',
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

  it('drops a malformed goalCause from replay state and warns', async () => {
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
        replay: { goalState: GOAL_STATE, goalCause: 'bogus' },
      }),
      encodeCursor: vi.fn(),
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[transcript] replay state dropped a malformed Goal cause',
    );
    expect(replayPage).toHaveBeenCalledWith([], {
      pendingToolCalls: [],
      finalizeDangling: true,
      gaps: [],
      goalState: GOAL_STATE,
    });
  });

  it('keeps checkpoint bookkeeping suppressed across a page boundary', async () => {
    // Regression: the replay state carried across a page handoff must include
    // the last goal_state cause, or the next page's machine cannot tell a
    // shape-equal bookkeeping re-commit from a genuine rejection card.
    const goal = GOAL_STATE.goal as GoalRecord;
    const rejectedGoal = { ...goal, lastReason: 'More work remains' };
    const goalRecord = (
      uuid: string,
      cause: string,
      snapshotGoal: GoalRecord,
    ): ChatRecord =>
      ({
        uuid,
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: TIMESTAMP,
        type: 'system',
        subtype: 'goal_state',
        systemPayload: {
          v: 2,
          cause,
          snapshot: { v: 2, activity: 'idle', goal: snapshotGoal },
        },
      }) as unknown as ChatRecord;

    let nextReplay: unknown;
    const firstPage = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        hasMore: true,
        nextCursorState: cursorState(),
        records: [
          goalRecord('goal-create', 'create', goal),
          goalRecord('goal-reject', 'verifier_reject', rejectedGoal),
        ],
      }),
      encodeCursor: (state) => {
        nextReplay = state.replay;
        return 'next-cursor';
      },
    });
    expect(firstPage.updates).toHaveLength(2);
    expect(nextReplay).toMatchObject({ goalCause: 'verifier_reject' });

    const recommittedGoal = {
      ...rejectedGoal,
      activeTimeMs: goal.activeTimeMs + 100,
      updatedAt: goal.updatedAt + 1,
    };
    const secondPage = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        records: [
          goalRecord(
            'goal-reject-checkpoint',
            'verifier_reject',
            recommittedGoal,
          ),
        ],
        replay: nextReplay,
      }),
      encodeCursor: vi.fn(),
    });

    expect(secondPage.updates).toEqual([]);
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

  it.each([undefined, 'backward'] as const)(
    'keeps a dangling tool call in progress while its prompt is active (%s)',
    async (direction) => {
      const result = await replayTranscriptRecordPage({
        sessionId: SESSION_ID,
        page: recordPage({
          records: [toolCallRecord()],
          ...(direction ? { direction } : {}),
        }),
        encodeCursor: vi.fn(),
        finalizeDangling: false,
      });

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]).toMatchObject({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        status: 'in_progress',
      });
    },
  );

  it('keeps the missing-result diagnostic for an idle transcript', async () => {
    const result = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({ records: [toolCallRecord()] }),
      encodeCursor: vi.fn(),
    });

    expect(result.updates).toHaveLength(2);
    expect(result.updates[1]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: MISSING_TOOL_RESULT_MESSAGE },
        },
      ],
    });
  });

  it('replays the real tool result after an active transcript snapshot', async () => {
    const active = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({ records: [toolCallRecord()] }),
      encodeCursor: vi.fn(),
      finalizeDangling: false,
    });
    const completed = await replayTranscriptRecordPage({
      sessionId: SESSION_ID,
      page: recordPage({
        records: [toolCallRecord(), toolResultRecord()],
      }),
      encodeCursor: vi.fn(),
    });

    expect(active.updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        status: 'in_progress',
      }),
    ]);
    expect(completed.updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        status: 'in_progress',
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      }),
    ]);
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

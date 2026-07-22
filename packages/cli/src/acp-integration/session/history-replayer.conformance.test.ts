/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  prepareTranscriptRecords,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
} from '@qwen-code/sdk/daemon';
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import { finalizeOfflineDaemonTranscriptState } from '@qwen-code/sdk/daemon/ui/transcript';
import type { DaemonEvent } from '@qwen-code/sdk/daemon/types';
import { describe, expect, it } from 'vitest';
import { HistoryReplayer } from './history-replayer.js';
import type { SessionEmitterContext } from './types.js';

describe('HistoryReplayer projection conformance', () => {
  it('matches the SDK offline projection for the same prepared records', async () => {
    const records = [
      goalRecord('goal-create', null, 'create', 'active'),
      record('user', 'goal-create', 'user', {
        role: 'user',
        parts: [{ text: 'hello' }],
      }),
      record('assistant', 'user', 'assistant', {
        role: 'model',
        parts: [
          { text: 'checking', thought: true },
          {
            functionCall: {
              id: 'call-1',
              name: 'read_file',
              args: { path: '/tmp/a' },
            },
          },
        ],
      }),
      {
        ...record('result', 'assistant', 'tool_result', {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        }),
        toolCallResult: {
          callId: 'call-1',
          resultDisplay: 'contents',
        },
      },
      goalRecord('goal-complete', 'result', 'complete', 'complete'),
    ];

    const projection = projectChatRecordsToDaemonTranscript(records);
    const prepared = prepareTranscriptRecords(records);
    const updates: SessionUpdate[] = [];
    const context: SessionEmitterContext = {
      sessionId: 'session-1',
      sendUpdate: async (update) => {
        updates.push(update);
      },
    };
    await new HistoryReplayer(context).replay(
      prepared.records as readonly ChatRecord[] as ChatRecord[],
    );

    const goalUpdates = updates.filter((update) =>
      Boolean(
        (update._meta as Record<string, unknown> | undefined)?.['goalState'],
      ),
    );
    expect(goalUpdates).toHaveLength(2);
    expect(
      Object.keys(goalUpdates[1]?._meta as Record<string, unknown>).slice(0, 3),
    ).toEqual(['goalState', 'goalStatus', 'goalTerminal']);

    let state = createDaemonTranscriptState({
      maxBlocks: Number.MAX_SAFE_INTEGER,
      now: 0,
    });
    for (const update of updates) {
      const event: DaemonEvent = {
        v: 1,
        type: 'session_update',
        data: { update },
      };
      state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
        maxBlocks: Number.MAX_SAFE_INTEGER,
        now: 0,
      });
    }

    expect(finalizeOfflineDaemonTranscriptState(state).blocks).toEqual(
      projection.blocks,
    );
  });
});

function goalRecord(
  uuid: string,
  parentUuid: string | null,
  cause: 'create' | 'complete',
  status: 'active' | 'complete',
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: 'session-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    type: 'system',
    subtype: 'goal_state',
    cwd: '/tmp',
    version: '1',
    systemPayload: {
      v: 2,
      cause,
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'goal-1',
          revision: cause === 'create' ? 1 : 2,
          objective: 'ship it',
          status,
          evidenceCursor: { recordId: null },
          turnCount: status === 'complete' ? 1 : 0,
          activeTimeMs: status === 'complete' ? 100 : 0,
          createdAt: 100,
          updatedAt: status === 'complete' ? 200 : 100,
        },
      },
    },
  };
}

function record(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant' | 'tool_result',
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: 'session-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    type,
    cwd: '/tmp',
    version: '1',
    message,
  };
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
  TranscriptCursor,
} from './goal-protocol.js';
import {
  createGoalRuntime,
  MAX_GOAL_CONTINUATION_TURNS,
  type GoalJournal,
  type GoalTurnHost,
} from './goal-runtime.js';

function journal(): GoalJournal {
  let cursor: TranscriptCursor = { recordId: null };
  return {
    getTranscriptCursor: () => ({ ...cursor }),
    async recordGoalState(
      recordUuid: string,
      _payload: GoalStateRecordPayloadV2,
    ): Promise<void> {
      cursor = { recordId: recordUuid };
    },
  };
}

describe('Goal runtime host integration', () => {
  it('keeps sequential automatic admissions independent within the turn budget', async () => {
    const turns = MAX_GOAL_CONTINUATION_TURNS - 1;
    const started: GoalTurnPermit[] = [];
    const host: GoalTurnHost = {
      startGoalTurn: vi.fn(async ({ permit }) => {
        started.push(structuredClone(permit));
      }),
      preemptGoalTurn: vi.fn(),
    };
    const runtime = createGoalRuntime({ journal: journal() });
    runtime.bindHost(host);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    for (let turn = 0; turn < turns; turn += 1) {
      const permit = started[turn];
      expect(permit).toBeDefined();
      await runtime.finishTurn(permit!);
    }

    expect(started).toHaveLength(turns + 1);
    expect(new Set(started.map(({ turnId }) => turnId)).size).toBe(turns + 1);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'active', turnCount: turns },
    });
  });

  it('gives queued user input priority over automatic continuation', async () => {
    const started: GoalTurnPermit[] = [];
    const runtime = createGoalRuntime({ journal: journal() });
    runtime.bindHost({
      async startGoalTurn({ permit }) {
        started.push(structuredClone(permit));
      },
      preemptGoalTurn: vi.fn(),
    });
    await runtime.dispatch({ action: 'create', objective: 'ship' });
    const automaticPermit = started[0]!;

    expect(runtime.beginTurn('real-user-key')).toBeUndefined();
    await runtime.finishTurn(automaticPermit);

    const userPermit = runtime.permitForTurn('real-user-key');
    expect(userPermit).toBeDefined();
    expect(started).toHaveLength(1);
    await runtime.finishTurn(userPermit!);
    expect(started).toHaveLength(2);
  });
});

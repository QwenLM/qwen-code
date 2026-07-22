import { describe, expect, it } from 'bun:test';
import type { GoalSnapshotV2 } from '../../../../shared/types';
import { processEvent } from '../../processor';
import type { SessionState } from '../../types';

describe('goal_state events', () => {
  it('replaces the session Goal with the authoritative v2 snapshot', () => {
    const snapshot: GoalSnapshotV2 = {
      v: 2,
      goal: {
        goalId: 'goal-1',
        revision: 4,
        objective: 'Align every surface',
        status: 'paused',
        evidenceCursor: { recordId: 'record-4' },
        turnCount: 3,
        activeTimeMs: 12_000,
        createdAt: 1_000,
        updatedAt: 13_000,
      },
      activity: 'idle',
    };
    const state = {
      session: {
        id: 'session-1',
        messages: [],
        isProcessing: false,
      },
      streaming: null,
    } as unknown as SessionState;

    const result = processEvent(state, {
      type: 'goal_state',
      sessionId: 'session-1',
      snapshot,
    });

    expect(result.state.session.goalState).toEqual(snapshot);
    expect(result.effects).toEqual([]);
  });
});

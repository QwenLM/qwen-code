/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  coreEvents,
  GoalStatus,
  type Config,
  type Goal,
} from '@qwen-code/core';
import { installGoalEventBridge } from './goalControlProtocol.js';

function makeGoal(id: string): Goal {
  return {
    id,
    objective: id,
    status: GoalStatus.Active,
    turnsUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Goal event bridge Config ownership', () => {
  it('reads snapshots and session ids from the supplied Config, including after a session switch', () => {
    let sessionId = 'session-a';
    let goal = makeGoal('goal-a');
    const config = {
      getSessionId: () => sessionId,
      getGoalManager: () => ({ getGoal: () => goal }),
    } as unknown as Config;
    const writeNdjson = vi.fn();
    const dispose = installGoalEventBridge({ config, writeNdjson });
    try {
      coreEvents.emitGoalUpdated({ sessionId, goal });
      expect(writeNdjson).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subtype: 'goal_updated',
          session_id: 'session-a',
          goal: expect.objectContaining({ id: 'goal-a' }),
        }),
      );
      sessionId = 'session-c';
      goal = makeGoal('goal-c');
      coreEvents.emitGoalUpdated({ sessionId, goal });
      expect(writeNdjson).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subtype: 'goal_updated',
          session_id: 'session-c',
          goal: expect.objectContaining({ id: 'goal-c' }),
        }),
      );
      coreEvents.emitGoalCleared({
        sessionId,
        goalId: goal.id,
        timestamp: 1,
        reason: 'user',
      });
      expect(writeNdjson).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subtype: 'goal_cleared',
          session_id: 'session-c',
          goal_id: 'goal-c',
        }),
      );
      dispose();
      coreEvents.emitGoalUpdated({ sessionId, goal });
      expect(writeNdjson).toHaveBeenCalledTimes(3);
    } finally {
      dispose();
    }
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoalStatus } from '../../../goal/types.js';

import type { Config } from '../../../config/config.js';
import { getGoalStateAttachment } from '../goal-generators.js';

const mockGetGoalManager = vi.fn();
const config = { getGoalManager: mockGetGoalManager } as unknown as Config;

function makeManager(
  goal: {
    objective: string;
    status: GoalStatus;
    turnsUsed: number;
    maxTurns?: number;
    timeUsedSeconds: number;
  } | null,
) {
  return {
    getGoal: vi.fn().mockReturnValue(goal),
  };
}

describe('getGoalStateAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a goal_state attachment for an owned active goal', () => {
    mockGetGoalManager.mockReturnValue(
      makeManager({
        objective: 'Ship the feature',
        status: GoalStatus.Active,
        turnsUsed: 3,
        maxTurns: 20,
        timeUsedSeconds: 42,
      }),
    );

    const [attachment] = getGoalStateAttachment(config);

    expect(attachment).toMatchObject({
      type: 'goal_state',
      objective: 'Ship the feature',
      turnsUsed: 3,
      maxTurns: 20,
      timeUsedSeconds: 42,
    });
    // currentTime is stamped per turn so the model can reason about elapsed time.
    expect(attachment.currentTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('describes unlimited turns without an automatic-pause warning', () => {
    mockGetGoalManager.mockReturnValue(
      makeManager({
        objective: 'Keep working',
        status: GoalStatus.Active,
        turnsUsed: 150,
        maxTurns: -1,
        timeUsedSeconds: 42,
      }),
    );

    const [attachment] = getGoalStateAttachment(config);
    const reminder = JSON.stringify(attachment.toUserMessages());

    expect(reminder).toContain('150/unlimited turns used');
    expect(reminder).not.toContain('auto-paused');
    expect(reminder).not.toContain('limit reached');
  });

  it('emits nothing when there is no goal', () => {
    mockGetGoalManager.mockReturnValue(makeManager(null));
    expect(getGoalStateAttachment(config)).toEqual([]);
  });

  it('emits nothing for a paused goal', () => {
    mockGetGoalManager.mockReturnValue(
      makeManager({
        objective: 'Paused work',
        status: GoalStatus.Paused,
        turnsUsed: 20,
        maxTurns: 20,
        timeUsedSeconds: 10,
      }),
    );
    expect(getGoalStateAttachment(config)).toEqual([]);
  });
});

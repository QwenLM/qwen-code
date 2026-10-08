/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_PAUSE_REASON_COMMAND,
  type GoalRecord,
} from '@qwen-code/sdk/daemon';
import { buildGoalControlRequest } from './goalControlRequest';

const errors = {
  emptyObjective: 'empty objective',
  goalUnavailable: 'goal unavailable',
};

const goal = (over: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'g1',
  revision: 3,
  objective: 'ship it',
  status: 'active',
  evidenceCursor: { recordId: null },
  turnCount: 0,
  activeTimeMs: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('buildGoalControlRequest', () => {
  it('names the reason on a pause', () => {
    // A pause with no reason clears `lastReason`, and the Web Shell card
    // renders that field -- so an unreasoned pause here blanks the line the
    // user is reading.
    expect(buildGoalControlRequest('pause', goal(), undefined, errors)).toEqual(
      {
        action: 'pause',
        reason: GOAL_PAUSE_REASON_COMMAND,
        expectedGoalId: 'g1',
        expectedRevision: 3,
      },
    );
  });

  it('sends no reason on resume or clear', () => {
    // The daemon's parser rejects any key beyond the three on these actions,
    // so a reason must never leak onto them.
    for (const action of ['resume', 'clear'] as const) {
      const request = buildGoalControlRequest(
        action,
        goal(),
        undefined,
        errors,
      );
      expect(request).toEqual({
        action,
        expectedGoalId: 'g1',
        expectedRevision: 3,
      });
      expect('reason' in request).toBe(false);
    }
  });

  it('leaves the objective-bearing actions unchanged', () => {
    expect(buildGoalControlRequest('create', null, 'ship it', errors)).toEqual({
      action: 'create',
      objective: 'ship it',
    });
    expect(
      buildGoalControlRequest('replace', goal(), 'ship harder', errors),
    ).toEqual({
      action: 'replace',
      objective: 'ship harder',
      expectedGoalId: 'g1',
      expectedRevision: 3,
    });
    expect(buildGoalControlRequest('edit', goal(), 'refine', errors)).toEqual({
      action: 'edit',
      objective: 'refine',
      expectedGoalId: 'g1',
      expectedRevision: 3,
    });
  });

  it('refuses an action that needs a goal it does not have', () => {
    expect(() =>
      buildGoalControlRequest('pause', null, undefined, errors),
    ).toThrow(errors.goalUnavailable);
    expect(() =>
      buildGoalControlRequest('create', null, undefined, errors),
    ).toThrow(errors.emptyObjective);
  });
});

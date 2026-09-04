/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { goalTurnContext } from './goal-turn-context.js';
import type { GoalTurnPermit } from './goal-protocol.js';

it('keeps the exact Goal permit across asynchronous continuations', async () => {
  const permit: GoalTurnPermit = {
    goalId: 'goal-1',
    revision: 2,
    turnId: 'turn-3',
  };

  const observed = await goalTurnContext.run(permit, async () => {
    await Promise.resolve();
    return goalTurnContext.getStore();
  });

  expect(observed).toEqual(permit);
  expect(goalTurnContext.getStore()).toBeUndefined();
});

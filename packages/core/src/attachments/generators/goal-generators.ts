/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Goal state attachment generator.
 *
 * Goal state reaches the model through the message layer (a
 * <system-reminder> attachment), never through the system prompt: the turn
 * counter advances every turn, so folding goal state into the system prompt
 * would invalidate the prompt cache on every turn of a long goal loop.
 *
 * Unlike the plan reminder this one is NOT throttled — the turn budget drives
 * the hard-limit circuit breaker, so the model must see the current count on
 * every turn to be able to wrap up before the breaker trips.
 */

import type { Config } from '../../config/config.js';
import { GoalStatus } from '../../goal/types.js';
import { GoalStateAttachment } from '../types.js';

/**
 * Emit a goal_state attachment when this session has an active goal.
 *
 * Returns [] when there is no goal or the goal is not Active
 * (paused/complete). Goals are session-scoped, so whatever the manager loads
 * belongs to this session by construction.
 */
export function getGoalStateAttachment(
  config: Config | undefined,
): GoalStateAttachment[] {
  const mgr = config?.getGoalManager();
  const goal = mgr?.getGoal();
  if (!goal) return [];
  if (goal.status !== GoalStatus.Active) return [];

  return [
    new GoalStateAttachment({
      type: 'goal_state' as const,
      objective: goal.objective,
      turnsUsed: goal.turnsUsed,
      maxTurns: goal.maxTurns,
      timeUsedSeconds: goal.timeUsedSeconds,
      currentTime: new Date().toISOString(),
    }),
  ];
}

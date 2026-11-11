/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookInput, HookOutput } from '../hooks/types.js';
import type { Config } from '../config/config.js';
import {
  GoalStatus,
} from './types.js';


/**
 * Built-in Stop hook handler for goal mode.
 *
 * This hook is invoked when the agent is about to stop. It evaluates
 * the goal status to determine if the agent should continue iterating
 * or allow the stop to proceed.
 *
 * Each time the hook denies a stop (goal still active), it records one
 * interaction turn against the goal.
 *
 * Bounded `maxTurns` values are hard stop limits: once a goal reaches one the
 * hook force-pauses it and allows the stop. Explicitly unlimited goals skip
 * that turn-count pause while all other halt and resource-limit states remain
 * effective.
 */
export async function goalLoopStopHook(
  config: Config,
  _input: HookInput,
  _options?: { signal: AbortSignal },
): Promise<HookOutput | null> {
  const goalManager = config.getGoalManager();
  // Re-read persisted state so out-of-band changes (external cleanup, another
  // process resuming this session) are honored before deciding to block.
  goalManager.refresh();
  const goal = goalManager.getGoal();

  // No goal → allow stop
  if (!goal) {
    return { decision: 'allow' };
  }

  // Goal completed (model called update_goal(status="complete")) → clear and allow stop.
  if (goal.status === GoalStatus.Complete) {
    goalManager.clearGoal({
      reason: 'completed',
    });

    return { decision: 'allow', reason: 'Goal completed via update_goal tool' };
  }

  // Paused by user → allow stop
  if (goal.status === GoalStatus.Paused) {

    return { decision: 'allow', reason: 'Goal paused by user' };
  }

  // Blocked / usage-limited / budget-limited → allow stop. These halt states
  // are set via the SDK control plane or by budget/quota exhaustion; only an
  // explicit user action (/goal resume or an external set) can revive them.
  if (
    goal.status === GoalStatus.Blocked ||
    goal.status === GoalStatus.UsageLimited ||
    goal.status === GoalStatus.BudgetLimited
  ) {

    return { decision: 'allow', reason: `Goal halted: ${goal.status}` };
  }

  // Goal still active — record one interaction turn
  goalManager.recordTurn();

  // Hard ceiling reached → force-pause and allow stop. This is the always-on
  // circuit breaker that prevents unbounded credit burn when the model keeps
  // refusing to complete (e.g. dead-waiting on a background workflow).
  if (goalManager.isOverHardTurnLimit()) {
    await goalManager.pauseForSafetyLimit();

    return {
      decision: 'allow',
      reason: `Goal auto-paused after reaching the hard turn limit (${goalManager.hardTurnLimit()} turns). Use /goal resume to continue.`,
    };
  }

  // Pick the prompt cadence for this turn: the full instruction block only on
  // the first continuation turn and a periodic refresher, a short nudge in
  // between, and a wrap-up prompt as the budget runs out. Re-injecting the full
  // block every turn would pile up near-duplicate tokens for the whole loop.
  const prompt = goalManager.renderTurnPrompt();



  return {
    decision: 'deny',
    reason:
      'Goal still active - model has not called update_goal(status="complete")',
    modelInjection: prompt?.text ?? undefined,
  };
}

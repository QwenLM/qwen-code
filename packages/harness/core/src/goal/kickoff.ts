/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared builder for the synthetic prompt that kicks off the
 * goal loop. Used by `/goal <objective>` (TUI) and by the SDK `set_goal`
 * control request when it activates a goal on an idle session, so both entry
 * points drive the loop with identical content.
 */

import { isUnlimitedGoalTurns, type Goal } from './types.js';
import { renderFirstTurnTemplate } from './template-renderer.js';

/**
 * Render the kickoff prompt for a freshly created/activated goal. Carries the
 * full first-turn instruction block plus the current budget snapshot, and
 * tells the model the goal is already registered (no create_goal).
 */
export function renderGoalKickoffPrompt(goal: Goal): string {
  const limitStr =
    goal.maxTurns === undefined
      ? 'none'
      : isUnlimitedGoalTurns(goal.maxTurns)
        ? 'unlimited'
        : `${goal.maxTurns} turns — when the limit is reached the goal is force-paused automatically`;
  const creditsLimitStr = goal.creditsBudget
    ? `${goal.creditsBudget} credits — the goal stops with a wrap-up turn when exhausted`
    : 'none';
  const progressLimit =
    goal.maxTurns === undefined
      ? ''
      : `/${isUnlimitedGoalTurns(goal.maxTurns) ? 'unlimited' : goal.maxTurns}`;
  return `${renderFirstTurnTemplate(goal)}

Goal state: turns used ${goal.turnsUsed}${progressLimit} | turn limit: ${limitStr} | credits budget: ${creditsLimitStr} | current time: ${new Date().toISOString()}.
The goal is ALREADY registered in the goal system — do NOT call create_goal again. Start working towards this goal now, breaking it down into steps if needed.`;
}

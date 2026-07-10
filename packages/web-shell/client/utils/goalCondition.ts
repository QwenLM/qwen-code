/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Words the daemon reads as "drop the goal" rather than as a condition.
 *
 * Mirrors CLEAR_KEYWORDS in packages/cli/src/ui/commands/goalCommand.ts, which
 * is the authority. The test beside this file reads that source and fails on
 * drift — this client bundles for the browser and cannot import from core.
 */
export const GOAL_CLEAR_KEYWORDS: ReadonlySet<string> = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
]);

/** The argument of a `/goal …` command; `''` for a bare `/goal`. */
export function goalArgOf(text: string): string {
  return text.replace(/^\/goal\b/i, '').trim();
}

/** True when `text` is a `/goal <clear-keyword>` invocation. */
export function isGoalClearCommand(text: string): boolean {
  return isGoalClearKeyword(goalArgOf(text));
}

/**
 * True when a would-be goal condition is really a clear keyword. `/goal clear`
 * clears rather than sets, so a form that accepts "clear" as a condition would
 * silently start a session that immediately drops the goal.
 */
export function isGoalClearKeyword(condition: string): boolean {
  return GOAL_CLEAR_KEYWORDS.has(condition.trim().toLowerCase());
}

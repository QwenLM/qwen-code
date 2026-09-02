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

export type ParsedWebShellGoalCommand =
  | { kind: 'status' }
  | { kind: 'set' | 'edit'; objective: string }
  | { kind: 'pause' | 'resume' | 'clear' }
  | { kind: 'error'; keyword: 'set' | 'edit' };

/** The argument of a `/goal …` command; `''` for a bare `/goal`. */
export function goalArgOf(text: string): string {
  return text.replace(/^\/goal\b/i, '').trim();
}

/** Browser-side mirror of the CLI's Goal v3 command grammar. */
export function parseWebShellGoalCommand(
  text: string,
): ParsedWebShellGoalCommand {
  const input = goalArgOf(text);
  if (!input) return { kind: 'status' };

  const [head = '', ...tail] = input.split(/\s+/);
  const keyword = head.toLowerCase();
  const objective = tail.join(' ').trim();
  if (keyword === 'set' || keyword === 'edit') {
    // The message is the caller's to render: this module is imported by both
    // composers and must not bake in an untranslated English string.
    return objective
      ? { kind: keyword, objective }
      : { kind: 'error', keyword };
  }
  if (tail.length === 0) {
    if (keyword === 'pause') return { kind: 'pause' };
    if (keyword === 'resume') return { kind: 'resume' };
    if (GOAL_CLEAR_KEYWORDS.has(keyword)) return { kind: 'clear' };
  }
  return { kind: 'set', objective: input };
}

/**
 * True when `text` is a `/goal <clear-keyword>` invocation.
 *
 * The prefix is checked here rather than assumed. `goalArgOf` strips `/goal`
 * only when it is present and otherwise returns the text unchanged, so without
 * this guard a bare `"clear"` — a perfectly ordinary thing to type into a chat
 * box — would answer true to "is this a goal-clear command?".
 */
export function isGoalClearCommand(text: string): boolean {
  if (!/^\/goal\b/i.test(text.trim())) return false;
  return isGoalClearKeyword(goalArgOf(text.trim()));
}

/**
 * True when a would-be goal condition is really a clear keyword. `/goal clear`
 * clears rather than sets, so a form that accepts "clear" as a condition would
 * silently start a session that immediately drops the goal.
 */
export function isGoalClearKeyword(condition: string): boolean {
  return GOAL_CLEAR_KEYWORDS.has(condition.trim().toLowerCase());
}

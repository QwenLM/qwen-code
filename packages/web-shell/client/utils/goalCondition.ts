/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The standalone word the Goal v3 command reads as a lifecycle control rather
 * than as an objective.
 *
 * Mirrors `parseGoalCommand` in packages/cli/src/ui/commands/goalCommand.ts,
 * which is the authority. The test beside this file reads that source and
 * fails on drift — this client bundles for the browser and cannot import it.
 */
export const GOAL_CLEAR_KEYWORDS: ReadonlySet<string> = new Set(['clear']);

export type ParsedWebShellGoalCommand =
  | { kind: 'status' }
  | { kind: 'set' | 'edit'; objective: string }
  | { kind: 'pause' | 'resume' | 'clear' }
  | { kind: 'error'; message: string };

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
    return objective
      ? { kind: keyword, objective }
      : {
          kind: 'error',
          message: `/goal ${keyword} requires an objective.`,
        };
  }
  if (tail.length === 0) {
    if (keyword === 'pause') return { kind: 'pause' };
    if (keyword === 'resume') return { kind: 'resume' };
    if (keyword === 'clear') return { kind: 'clear' };
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
 * True when a command argument is the exact v3 clear operation. Words such as
 * "stop" and "cancel" are valid objectives now.
 */
export function isGoalClearKeyword(condition: string): boolean {
  return GOAL_CLEAR_KEYWORDS.has(condition.trim().toLowerCase());
}

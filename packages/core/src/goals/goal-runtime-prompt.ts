/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const GOAL_RUNTIME_PROMPT_PREFIX =
  'Continue working on the active Goal.\nUse get_goal for the authoritative objective and evidence state.\n';

export function isGoalRuntimePromptText(text: unknown): text is string {
  return (
    typeof text === 'string' && text.startsWith(GOAL_RUNTIME_PROMPT_PREFIX)
  );
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Internal Prompt ID utilities
 *
 * Centralises the set of prompt IDs used by background operations
 * (suggestion generation, forked queries) so that logging, recording,
 * and UI layers can consistently recognise and filter them.
 */

/** Prompt IDs that belong to internal background operations. */
const INTERNAL_PROMPT_IDS: ReadonlySet<string> = new Set([
  'prompt_suggestion',
  'forked_query',
]);

/**
 * Returns true if the prompt_id belongs to an internal background operation
 * whose events should not be recorded to the chatRecordingService,
 * OpenAI logs, or other persistent stores visible in the UI.
 *
 * Known internal IDs: `'prompt_suggestion'`, `'forked_query'`.
 */
export function isInternalPromptId(promptId: string): boolean {
  return INTERNAL_PROMPT_IDS.has(promptId);
}

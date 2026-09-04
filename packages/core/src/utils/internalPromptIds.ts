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
  'speculation',
]);

/**
 * Prefix for IDs minted by `runSideQuery`. Recognised as internal so new
 * side-query call sites don't have to opt in to filtering one-by-one.
 */
const SIDE_QUERY_PROMPT_PREFIX = 'side-query:';

/**
 * Returns true if the prompt_id belongs to an internal background operation
 * whose events should not be recorded to the chatRecordingService,
 * telemetry payloads, or other persistent stores visible in the UI.
 */
export function isInternalPromptId(promptId: string | undefined): boolean {
  if (!promptId) return false;
  return (
    INTERNAL_PROMPT_IDS.has(promptId) ||
    promptId.startsWith(SIDE_QUERY_PROMPT_PREFIX)
  );
}

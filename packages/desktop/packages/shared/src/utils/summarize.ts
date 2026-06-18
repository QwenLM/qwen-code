/**
 * Summarization utilities — DEPRECATED
 *
 * Constants, types, and summarization logic have moved to large-response.ts.
 * This file is kept only for resetSummarizationClient() (no-op, used by sessions.ts).
 *
 * New code should import from './large-response.ts' instead.
 */

import { debug } from './debug.ts';

/**
 * Reset the cached summarization client.
 * @deprecated No-op. Summarization now goes through agent.runMiniCompletion().
 */
export function resetSummarizationClient(): void {
  debug('[summarize] resetSummarizationClient called (no-op)');
}

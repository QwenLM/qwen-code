/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { canonicalToolName, ToolNames } from '../tools/tool-names.js';
import { ORPHAN_TOOL_USE_REPAIR_REASON } from '../core/geminiChat.js';
import { PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE } from '../core/plan-mode-entry-policy.js';
import {
  DUPLICATE_PROVIDER_TOOL_CALL_PREFIX,
  OPERATION_CANCELLED_PREFIX,
  PERMISSION_DECLINED_MESSAGE_PREFIX,
  SUPPRESSED_SIBLING_SKIP_PREFIX,
} from '../core/tool-result-markers.js';

/**
 * Deterministic proxies for the skill-review prompt's own admission criteria
 * ("trial and error, or changing course, or the user expected a different
 * method or outcome"). Used to gate `scheduleSkillReview` so a tool-call
 * count alone neither fires on read-only sessions nor misses short
 * debugging arcs.
 */
export interface ExperienceSignals {
  /** A failed tool result followed by success from the same tool. */
  retryArc: boolean;
  /** The user steered the agent mid-turn. Not derivable from history; the
   * caller (GeminiClient) sets it from its own steer tracking. */
  userSteer: boolean;
  /** At least one write/execute tool call — gates the count backstop so
   * read-only sessions never trigger a review. */
  hasSubstantiveWork: boolean;
}

export interface ExperienceSignalAccumulator
  extends Omit<ExperienceSignals, 'userSteer'> {
  /** Tools with a failure not yet followed by a confirmed success. */
  failedToolNames: ReadonlySet<string>;
}

const SUBSTANTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
]);

export function isSubstantiveToolCall(name: string): boolean {
  return SUBSTANTIVE_TOOL_NAMES.has(canonicalToolName(name));
}

function isFailedResponse(part: {
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}): boolean | null {
  const fr = part.functionResponse;
  if (!fr?.name || !fr.response) return null;
  const error = fr.response['error'];
  if (typeof error === 'string' && error.trim()) {
    // Synthesized non-failure markers carry `error` but are not genuine
    // failures: per-tool cancellation, interrupted-turn orphan repair, and
    // never-executed calls (policy denials, duplicate provider IDs, suppressed
    // structured-output siblings). Return `null` (unknown), not `false` — a
    // `false` would close a pending genuine-failure arc for the same tool.
    if (
      error.startsWith(OPERATION_CANCELLED_PREFIX) ||
      error.startsWith(DUPLICATE_PROVIDER_TOOL_CALL_PREFIX) ||
      error === ORPHAN_TOOL_USE_REPAIR_REASON ||
      // Prefix match, not exact equality: PostToolBatch hooks can append
      // `\n\n${additionalContext}` to a skipped sibling's error, and the
      // suffixed string must still classify as a never-executed skip.
      error.startsWith(PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE) ||
      error.startsWith(PERMISSION_DECLINED_MESSAGE_PREFIX) ||
      error.startsWith(SUPPRESSED_SIBLING_SKIP_PREFIX)
    ) {
      return null;
    }
    return true;
  }
  // No `error` key: the tool reports success-shaped semantics. In
  // particular, shell.ts only attaches `error` when `isShellExitError`
  // holds, so whitelisted exit-1 commands (grep/rg/diff/test) land here as
  // successes, matching the shell tool's own failure classification.
  return false;
}

/** Adds a history fragment to an accumulator that survives history compaction. */
export function accumulateExperienceSignals(
  history: Content[],
  initial: ExperienceSignalAccumulator = {
    retryArc: false,
    hasSubstantiveWork: false,
    failedToolNames: new Set(),
  },
): ExperienceSignalAccumulator {
  let { retryArc, hasSubstantiveWork } = initial;
  const failedToolNames = new Set(initial.failedToolNames);

  for (const content of history) {
    for (const part of content.parts ?? []) {
      // functionCall parts are model turns without outcomes; the sole
      // production call site feeds accepted ToolResult/Retry user turns
      // (functionResponse parts only). Substantive work is latched by
      // recordCompletedToolCall in the client, not from model turns.
      const failed = isFailedResponse(part);
      if (failed === null) continue;
      const toolName = part.functionResponse?.name;
      if (!toolName) continue;
      const canonicalName = canonicalToolName(toolName);
      if (failed) {
        failedToolNames.add(canonicalName);
      } else if (failedToolNames.delete(canonicalName)) {
        retryArc = true;
      }
    }
  }

  return { retryArc, hasSubstantiveWork, failedToolNames };
}

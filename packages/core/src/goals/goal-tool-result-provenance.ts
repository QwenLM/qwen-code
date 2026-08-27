/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RecordToolResultOptions } from '../services/chatRecordingService.js';
import { ToolNames } from '../tools/tool-names.js';
import type { GoalTurnPermit } from './goal-protocol.js';
import { goalTurnContext } from './goal-turn-context.js';

/** The slice of a tool-call request this reads. */
export interface GoalToolResultRequest {
  name: string;
  goalContext?: GoalTurnPermit;
}

/**
 * How a finished tool call should be recorded, so its result can become Goal
 * evidence.
 *
 * The evidence catalog derives a record's provenance from the Goal permit
 * stamped on it (`goal-evidence.ts`: no parsed goal context, no provenance,
 * no catalog entry). A tool result recorded without the stamp is therefore
 * invisible to the catalog -- and since `tool_result` is the only provenance
 * that maps to `external_fact`, an unstamped host produces a Goal that can
 * never prove anything about the world: completions citing only the model's
 * own words are refused by the verifier, and the `infeasible` and `external`
 * blockers, which require external evidence, are unreachable.
 *
 * `get_goal` and `update_goal` are stamped as `goal_runtime` instead: they are
 * the Goal's own bookkeeping, and a catalog that cited its own reads as proof
 * would be circular.
 *
 * Every site that records tool results during a Goal turn routes through
 * here -- the interactive scheduler, both TUI recording paths, headless, and
 * ACP -- so the rule cannot drift between them.
 */
export function goalToolResultProvenance(
  request: GoalToolResultRequest,
): RecordToolResultOptions | undefined {
  const { goalContext } = request;
  if (!goalContext) return undefined;
  if (
    request.name === ToolNames.GET_GOAL ||
    request.name === ToolNames.UPDATE_GOAL
  ) {
    return { goalContext: { ...goalContext }, provenance: 'goal_runtime' };
  }
  return { goalContext: { ...goalContext } };
}

/**
 * The same rule for a host that executes tools straight from the model's
 * function calls and so has no `ToolCallRequestInfo` to read a permit from.
 *
 * The permit comes from the ambient Goal turn context, which the host enters
 * around the whole turn -- including the tool calls it issues -- so a result
 * recorded here belongs to the turn that asked for it.
 */
export function ambientGoalToolResultProvenance(
  toolName: string,
): RecordToolResultOptions | undefined {
  const goalContext = goalTurnContext.getStore();
  return goalToolResultProvenance({
    name: toolName,
    ...(goalContext ? { goalContext } : {}),
  });
}

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../../tools/tool-names.js';
import { isTeammate } from '../team/identity.js';
import { getCurrentAgentId } from './agent-context.js';

export const SUBAGENT_PLAN_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  ToolNames.ENTER_PLAN_MODE,
  ToolNames.EXIT_PLAN_MODE,
]);

export function isSubagentLikeExecutionContext(): boolean {
  return getCurrentAgentId() !== null || isTeammate();
}

export function isSubagentPlanLifecycleTool(toolName: string): boolean {
  return SUBAGENT_PLAN_LIFECYCLE_TOOLS.has(toolName);
}

export function isPlanLifecycleToolUnavailableInSubagent(
  toolName: string,
): boolean {
  return (
    isSubagentLikeExecutionContext() && isSubagentPlanLifecycleTool(toolName)
  );
}

export function getSubagentPlanToolUnavailableMessage(
  toolName: string,
): string {
  return `${toolName} is not available inside subagents or team agents. Plan mode is owned by the caller/main session; return your plan, findings, or constraints to the caller in your normal response instead of entering or exiting plan mode.`;
}

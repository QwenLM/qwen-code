/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../../tools/tool-names.js';
import type { ToolResult } from '../../tools/tools.js';
import type { ApprovalMode, Config } from '../../config/config.js';
import { getTeammateContext, isTeammate } from '../team/identity.js';
import { getCurrentAgentId } from './agent-context.js';

const PLAN_MODE = 'plan' as ApprovalMode;

export const SUBAGENT_PLAN_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  ToolNames.ENTER_PLAN_MODE,
  ToolNames.EXIT_PLAN_MODE,
]);

export function isSubagentLikeExecutionContext(): boolean {
  return getCurrentAgentId() !== null || isTeammate();
}

export function isPlanRequiredTeammateContext(): boolean {
  return getTeammateContext()?.planModeRequired === true;
}

export function isPlanRequiredTeammateAwaitingApproval(
  config: Config,
): boolean {
  return (
    isPlanRequiredTeammateContext() && config.getApprovalMode() === PLAN_MODE
  );
}

export function isPlanLifecycleToolUnavailableInSubagent(
  toolName: string,
): boolean {
  if (!isSubagentLikeExecutionContext()) return false;
  if (toolName === ToolNames.ENTER_PLAN_MODE) return true;
  if (toolName === ToolNames.EXIT_PLAN_MODE) {
    return !isPlanRequiredTeammateContext();
  }
  return false;
}

export function shouldUsePlanOnlyReminderInSubagentContext(): boolean {
  return isSubagentLikeExecutionContext() && !isPlanRequiredTeammateContext();
}

export function isLeaderOnlyToolUnavailableInSubagent(
  toolName: string,
): boolean {
  return (
    isSubagentLikeExecutionContext() &&
    toolName === ToolNames.TEAM_PLAN_APPROVAL
  );
}

export function getLeaderOnlyToolUnavailableMessage(toolName: string): string {
  return `${toolName} is only available to the team leader. Subagents and teammates cannot approve teammate plans.`;
}

export function getPlanRequiredTeammatePreApprovalMessage(
  toolName: string,
): string {
  return `${toolName} is not available while this plan-required teammate is waiting for leader approval. Finish investigation, call exit_plan_mode with the proposed plan, and wait for the leader to approve it before taking execution actions.`;
}

export function isPlanRequiredTeammatePreApprovalAllowedTool(
  toolName: string,
  params: unknown,
): boolean {
  if (toolName === ToolNames.EXIT_PLAN_MODE) {
    return true;
  }
  if (toolName !== ToolNames.TASK_UPDATE) {
    return false;
  }
  return isPreApprovalClaimOnlyTaskUpdate(params);
}

function isPreApprovalClaimOnlyTaskUpdate(params: unknown): boolean {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return false;
  }

  const taskParams = params as Record<string, unknown>;
  const agentName = getTeammateContext()?.agentName;
  return (
    taskParams['status'] === 'in_progress' &&
    (taskParams['owner'] === undefined || taskParams['owner'] === agentName) &&
    taskParams['subject'] === undefined &&
    taskParams['description'] === undefined &&
    taskParams['activeForm'] === undefined &&
    taskParams['metadata'] === undefined &&
    isAbsentOrEmptyArray(taskParams['addBlocks']) &&
    isAbsentOrEmptyArray(taskParams['addBlockedBy'])
  );
}

function isAbsentOrEmptyArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

export function getSubagentPlanToolUnavailableMessage(
  toolName: string,
): string {
  return `${toolName} is not available inside subagents or team agents. Plan mode is owned by the caller/main session; return your plan, findings, or constraints to the caller in your normal response instead of entering or exiting plan mode.`;
}

export function buildSubagentPlanToolBlockedResult(
  toolName: string,
  logTag: string,
  logger: { warn(message: string): void },
): ToolResult {
  const message = getSubagentPlanToolUnavailableMessage(toolName);
  logger.warn(
    `[${logTag}] Blocked plan lifecycle tool call from subagent: ${toolName}`,
  );
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message },
  };
}

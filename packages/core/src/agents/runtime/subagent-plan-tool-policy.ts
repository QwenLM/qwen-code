/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../../tools/tool-names.js';
import type { ToolResult } from '../../tools/tools.js';
import { ApprovalMode } from '../../config/approval-mode.js';
import type { Config } from '../../config/config.js';
import { getTeammateContext, isTeammate } from '../team/identity.js';
import { getCurrentAgentId } from './agent-context.js';

export const SUBAGENT_PLAN_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  ToolNames.ENTER_PLAN_MODE,
  ToolNames.EXIT_PLAN_MODE,
]);

/**
 * Tools that must never be available to non-team subagents (including
 * forked agents spawned via the Agent tool). Moved here (from agent-core)
 * so the tool_call bridge (tools/tool-call.ts) can enforce the same
 * exclusion without a circular import (agent-core imports coreToolScheduler,
 * which imports tool-call).
 * - AgentTool is depth-gated rather than unconditionally excluded:
 *   `isExcluded()` in `prepareTools()` re-admits it while
 *   `canSpawnNestedAgent()` permits another nesting level, and consults
 *   this set only for every other tool. The entry here remains the
 *   fail-closed floor for consumers of the raw set.
 * - Cron tools are session-scoped and should only run from the main session.
 * - TaskStop and SendMessage are parent-side control-plane tools for managing
 *   background subagents; subagents have no agent IDs to manage natively, so
 *   exposing them only widens the surface for cross-agent interference if an
 *   ID leaks via prompt or transcript.
 * - Team management (team_create/team_delete) and task coordination
 *   (task_create/task_update/task_list) are leader/teammate tools. A
 *   non-team Agent subagent has no teammate identity, so isTeammate()
 *   returns false and these tools would treat it as the leader — letting
 *   it delete or rewrite the active team.
 * - Plan lifecycle tools are owned by the caller/main session. A subagent
 *   should return its plan to the caller instead of entering or exiting mode.
 * - Todo state is also parent-owned because subagents share the session's
 *   persisted Todo sidecar.
 */
export const EXCLUDED_TOOLS_FOR_SUBAGENTS: ReadonlySet<string> = new Set([
  ToolNames.AGENT,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  ToolNames.LIST_AGENTS,
  ToolNames.TASK_STOP,
  ToolNames.SEND_MESSAGE,
  ToolNames.TEAM_CREATE,
  ToolNames.TEAM_DELETE,
  ToolNames.TEAM_PLAN_APPROVAL,
  ToolNames.REQUEST_SHUTDOWN,
  ToolNames.TASK_CREATE,
  ToolNames.TASK_UPDATE,
  ToolNames.TASK_LIST,
  ToolNames.TODO_WRITE,
  ...SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  // Worktree management belongs to the parent session — a subagent must
  // never enter or exit the user's worktree state independently.
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
  // V1 session artifacts are owned by the parent daemon session.
  ToolNames.ARTIFACT,
  ToolNames.RECORD_ARTIFACT,
  // FIX-8 (SEC-I1): WORKFLOW is excluded to prevent unbounded recursive
  // fan-out: a subagent spawned by Workflow that calls Workflow would create
  // O(k^n) subagents.
  ToolNames.WORKFLOW,
]);

/**
 * Tools excluded from teammates. Teammates need send_message and the
 * task_* coordination tools to do their job, but they must not be able
 * to create or destroy the team itself — only the leader can do that.
 * Plan lifecycle tools remain caller-owned for teammates too.
 */
export const EXCLUDED_TOOLS_FOR_TEAMMATES: ReadonlySet<string> = new Set([
  ToolNames.AGENT,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  ToolNames.LIST_AGENTS,
  ToolNames.TASK_STOP,
  ToolNames.TEAM_CREATE,
  ToolNames.TEAM_DELETE,
  ToolNames.TEAM_PLAN_APPROVAL,
  ToolNames.REQUEST_SHUTDOWN,
  ToolNames.TODO_WRITE,
  ...SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  // Worktree management belongs to the parent session.
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
  // Same recursion guard as EXCLUDED_TOOLS_FOR_SUBAGENTS: the teammate
  // identity propagates through AsyncLocalStorage into anything it
  // spawns, so prepareTools() would keep choosing THIS exclusion set
  // for nested agents — without WORKFLOW here, a teammate-launched
  // workflow re-arms the O(k^n) fan-out the subagent set prevents.
  ToolNames.WORKFLOW,
]);

/**
 * The tool-exclusion set for the current execution context: subagents get
 * EXCLUDED_TOOLS_FOR_SUBAGENTS, teammates get EXCLUDED_TOOLS_FOR_TEAMMATES
 * (with EXIT_PLAN_MODE re-admitted for plan-required teammates). Shared by
 * prepareTools (declaration-level) and the tool_call bridge
 * (resolveDeferredToolCall, invocation-level) so both enforce the same set.
 */
export function getExcludedToolsForCurrentContext(): ReadonlySet<string> {
  if (!isTeammate()) {
    return EXCLUDED_TOOLS_FOR_SUBAGENTS;
  }
  if (!isPlanRequiredTeammateContext()) {
    return EXCLUDED_TOOLS_FOR_TEAMMATES;
  }

  const excluded = new Set(EXCLUDED_TOOLS_FOR_TEAMMATES);
  excluded.delete(ToolNames.EXIT_PLAN_MODE);
  return excluded;
}

export const READ_ONLY_INSPECTION_TOOLS: readonly string[] = [
  ToolNames.READ_FILE,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.LS,
  ToolNames.LSP,
  ToolNames.TOOL_SEARCH,
  ToolNames.READ_MCP_RESOURCE,
];

const PLAN_REQUIRED_TEAMMATE_PRE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  ToolNames.EXIT_PLAN_MODE,
  ToolNames.TASK_LIST,
  ...READ_ONLY_INSPECTION_TOOLS,
]);

const PRE_APPROVAL_TASK_CLAIM_KEYS: ReadonlySet<string> = new Set([
  'taskId',
  'status',
  'owner',
  'addBlocks',
  'addBlockedBy',
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
    isPlanRequiredTeammateContext() &&
    config.getApprovalMode() === ApprovalMode.PLAN
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
  if (PLAN_REQUIRED_TEAMMATE_PRE_APPROVAL_TOOLS.has(toolName)) {
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
  for (const key of Object.keys(taskParams)) {
    if (!PRE_APPROVAL_TASK_CLAIM_KEYS.has(key)) {
      return false;
    }
  }

  const agentName = getTeammateContext()?.agentName;
  return (
    typeof taskParams['taskId'] === 'string' &&
    taskParams['status'] === 'in_progress' &&
    (taskParams['owner'] === undefined || taskParams['owner'] === agentName) &&
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

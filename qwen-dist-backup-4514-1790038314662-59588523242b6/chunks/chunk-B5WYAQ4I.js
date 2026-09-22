// Force strict mode and setup for ESM
"use strict";
import {
  getCurrentAgentId
} from "./chunk-5FHOPPLZ.js";
import {
  getTeammateContext,
  isTeammate
} from "./chunk-S6LOFUVP.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/agents/runtime/subagent-plan-tool-policy.ts
init_esbuild_shims();
var SUBAGENT_PLAN_LIFECYCLE_TOOLS = /* @__PURE__ */ new Set([
  ToolNames.ENTER_PLAN_MODE,
  ToolNames.EXIT_PLAN_MODE
]);
var READ_ONLY_INSPECTION_TOOLS = [
  ToolNames.READ_FILE,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.LS,
  ToolNames.LSP,
  ToolNames.TOOL_SEARCH,
  ToolNames.READ_MCP_RESOURCE
];
var PLAN_REQUIRED_TEAMMATE_PRE_APPROVAL_TOOLS = /* @__PURE__ */ new Set([
  ToolNames.EXIT_PLAN_MODE,
  ToolNames.TASK_LIST,
  ...READ_ONLY_INSPECTION_TOOLS
]);
var PRE_APPROVAL_TASK_CLAIM_KEYS = /* @__PURE__ */ new Set([
  "taskId",
  "status",
  "owner",
  "addBlocks",
  "addBlockedBy"
]);
function isSubagentLikeExecutionContext() {
  return getCurrentAgentId() !== null || isTeammate();
}
__name(isSubagentLikeExecutionContext, "isSubagentLikeExecutionContext");
function isPlanRequiredTeammateContext() {
  return getTeammateContext()?.planModeRequired === true;
}
__name(isPlanRequiredTeammateContext, "isPlanRequiredTeammateContext");
function isPlanRequiredTeammateAwaitingApproval(config) {
  return isPlanRequiredTeammateContext() && config.getApprovalMode() === "plan" /* PLAN */;
}
__name(isPlanRequiredTeammateAwaitingApproval, "isPlanRequiredTeammateAwaitingApproval");
function isPlanLifecycleToolUnavailableInSubagent(toolName) {
  if (!isSubagentLikeExecutionContext()) return false;
  if (toolName === ToolNames.ENTER_PLAN_MODE) return true;
  if (toolName === ToolNames.EXIT_PLAN_MODE) {
    return !isPlanRequiredTeammateContext();
  }
  return false;
}
__name(isPlanLifecycleToolUnavailableInSubagent, "isPlanLifecycleToolUnavailableInSubagent");
function shouldUsePlanOnlyReminderInSubagentContext() {
  return isSubagentLikeExecutionContext() && !isPlanRequiredTeammateContext();
}
__name(shouldUsePlanOnlyReminderInSubagentContext, "shouldUsePlanOnlyReminderInSubagentContext");
function isLeaderOnlyToolUnavailableInSubagent(toolName) {
  return isSubagentLikeExecutionContext() && toolName === ToolNames.TEAM_PLAN_APPROVAL;
}
__name(isLeaderOnlyToolUnavailableInSubagent, "isLeaderOnlyToolUnavailableInSubagent");
function getLeaderOnlyToolUnavailableMessage(toolName) {
  return `${toolName} is only available to the team leader. Subagents and teammates cannot approve teammate plans.`;
}
__name(getLeaderOnlyToolUnavailableMessage, "getLeaderOnlyToolUnavailableMessage");
function getPlanRequiredTeammatePreApprovalMessage(toolName) {
  return `${toolName} is not available while this plan-required teammate is waiting for leader approval. Finish investigation, call exit_plan_mode with the proposed plan, and wait for the leader to approve it before taking execution actions.`;
}
__name(getPlanRequiredTeammatePreApprovalMessage, "getPlanRequiredTeammatePreApprovalMessage");
function isPlanRequiredTeammatePreApprovalAllowedTool(toolName, params) {
  if (PLAN_REQUIRED_TEAMMATE_PRE_APPROVAL_TOOLS.has(toolName)) {
    return true;
  }
  if (toolName !== ToolNames.TASK_UPDATE) {
    return false;
  }
  return isPreApprovalClaimOnlyTaskUpdate(params);
}
__name(isPlanRequiredTeammatePreApprovalAllowedTool, "isPlanRequiredTeammatePreApprovalAllowedTool");
function isPreApprovalClaimOnlyTaskUpdate(params) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return false;
  }
  const taskParams = params;
  for (const key of Object.keys(taskParams)) {
    if (!PRE_APPROVAL_TASK_CLAIM_KEYS.has(key)) {
      return false;
    }
  }
  const agentName = getTeammateContext()?.agentName;
  return typeof taskParams["taskId"] === "string" && taskParams["status"] === "in_progress" && (taskParams["owner"] === void 0 || taskParams["owner"] === agentName) && isAbsentOrEmptyArray(taskParams["addBlocks"]) && isAbsentOrEmptyArray(taskParams["addBlockedBy"]);
}
__name(isPreApprovalClaimOnlyTaskUpdate, "isPreApprovalClaimOnlyTaskUpdate");
function isAbsentOrEmptyArray(value) {
  return value === void 0 || Array.isArray(value) && value.length === 0;
}
__name(isAbsentOrEmptyArray, "isAbsentOrEmptyArray");
function getSubagentPlanToolUnavailableMessage(toolName) {
  return `${toolName} is not available inside subagents or team agents. Plan mode is owned by the caller/main session; return your plan, findings, or constraints to the caller in your normal response instead of entering or exiting plan mode.`;
}
__name(getSubagentPlanToolUnavailableMessage, "getSubagentPlanToolUnavailableMessage");
function buildSubagentPlanToolBlockedResult(toolName, logTag, logger) {
  const message = getSubagentPlanToolUnavailableMessage(toolName);
  logger.warn(
    `[${logTag}] Blocked plan lifecycle tool call from subagent: ${toolName}`
  );
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message }
  };
}
__name(buildSubagentPlanToolBlockedResult, "buildSubagentPlanToolBlockedResult");

export {
  SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  READ_ONLY_INSPECTION_TOOLS,
  isSubagentLikeExecutionContext,
  isPlanRequiredTeammateContext,
  isPlanRequiredTeammateAwaitingApproval,
  isPlanLifecycleToolUnavailableInSubagent,
  shouldUsePlanOnlyReminderInSubagentContext,
  isLeaderOnlyToolUnavailableInSubagent,
  getLeaderOnlyToolUnavailableMessage,
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammatePreApprovalAllowedTool,
  getSubagentPlanToolUnavailableMessage,
  buildSubagentPlanToolBlockedResult
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

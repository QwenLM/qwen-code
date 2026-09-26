/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import { ToolNames } from '../../tools/tool-names.js';
import {
  matchesMcpPattern,
  matchesToolPattern,
} from '../../permissions/rule-parser.js';
import type { ToolResult } from '../../tools/tools.js';
import type { ToolConfig } from './agent-types.js';
import { getToolExposure } from '../../tools/code-mode.js';
import { ApprovalMode } from '../../config/approval-mode.js';
import type { Config } from '../../config/config.js';
import type { ToolRegistrationStatus } from '../../permissions/permission-manager.js';
import { getTeammateContext, isTeammate } from '../team/identity.js';
import {
  getCurrentAgentId,
  isTopLevelSession,
  spawnBlockReason,
} from './agent-context.js';

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
  // V1 session artifacts and sources are owned by the parent daemon session.
  ToolNames.ARTIFACT,
  ToolNames.RECORD_ARTIFACT,
  ToolNames.RECORD_SOURCE,
  // FIX-8 (SEC-I1): WORKFLOW is excluded to prevent unbounded recursive
  // fan-out: a subagent spawned by Workflow that calls Workflow would create
  // O(k^n) subagents.
  ToolNames.WORKFLOW,
]);

/**
 * Whether an agent running with `toolConfig` is declared the Skill tool.
 *
 * This MIRRORS the declaration-level filters `AgentCore.prepareTools()`
 * applies — it does not re-run them, and parity is not automatic:
 * `prepareTools()` additionally consults the context-aware
 * `isToolExcludedForCurrentContext` and the `settings.tools.eager` allowlist.
 * The first answers for the currently running agent while this predicate is
 * also called from the parent's frame, so it checks the raw
 * `EXCLUDED_TOOLS_FOR_SUBAGENTS` set instead; the second cannot be read from
 * a `ToolConfig` at all, so it arrives as `options.skillRegistration`
 * (below). A third filter is not `prepareTools()`' at all: the
 * invocation-level allowlist the `deferred` arm below has to respect lives in
 * `AgentCore.isToolExecutionAllowed()`, and only its finite-list shape is
 * mirrored here. A filter added to `prepareTools()` propagates here only by
 * hand.
 *
 * Shared by `AgentCore.willHaveSkillTool()` (whether the agent is shown the
 * `<available_skills>` listing) and `SubagentManager.createAgentHeadless()`
 * (whether the agent's Config holds a `SkillManager`, which decides whether a
 * bundled reference reaches it as a pointer or inline). One predicate, so the
 * listing and the pointer cannot disagree about whether a skill can actually
 * be loaded — the disagreement #12424 reports.
 *
 * Matching is exact, as `prepareTools()`'s is: `SubagentManager` resolves
 * configured names to canonical tool names before they reach a `ToolConfig`,
 * and `matchesToolPattern` compares a non-MCP name by equality.
 *
 * - No `toolConfig`, a `'*'` entry, or an empty list inherits the registry,
 *   so the Skill tool is available unless the subagent exclusion set removes
 *   it. A list holding only inline declarations does NOT inherit: that is the
 *   explicit branch of `prepareTools()`, which declares no registry tool.
 * - An explicit list must name `skill` — or, under CodeModeOnly, name `exec`,
 *   which binds every code-mode-callable tool that survived `prepareTools()`'
 *   own filters, the Skill tool included.
 * - `disallowedTools` removes it at declaration. Under CodeModeOnly it also
 *   removes `exec`, and with it the only route to a code-mode-callable tool:
 *   `prepareTools()` declares nothing at all for such an agent, so naming
 *   `skill` there — or inheriting the registry — buys no way to load one.
 * - `options.skillRegistration` answers what the declarations cannot: how
 *   the Skill tool participates in the session's registry. Only a caller
 *   that can see the session's permission state knows this, so it arrives
 *   as an input — computed by {@link skillRegistrationStatusFor}. A
 *   `disabled` Skill tool is never registered, so nothing reaches it; a
 *   `deferred` one keeps its registration but loses its declaration, so the
 *   `tool_search` + `tool_call` bridge is the only route left — and that
 *   route exists only where these declarations leave both halves standing,
 *   still admit `skill` at invocation level, and the session is not under
 *   CodeModeOnly, which hides them.
 *
 * Where this cannot tell, it answers true: a wrong `true` costs a pointer the
 * agent cannot follow, a wrong `false` takes skills away from an agent that
 * could load them. `executionAllowedTools` is read only as that escape hatch:
 * its presence means a finite `tools` list is a fork's declaration snapshot
 * rather than the invocation allowlist, so the bridge is credited without
 * asking which names the fork may actually execute. Reading it correctly
 * under CodeModeOnly would need the same `exec` carve-out again, and forks
 * reuse the parent's declarations for cache reasons and never rebuild the
 * listing.
 */
export function toolConfigAllowsSkill(
  toolConfig: ToolConfig | undefined,
  options: {
    codeModeOnly?: boolean;
    skillRegistration?: ToolRegistrationStatus;
  } = {},
): boolean {
  if (EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.SKILL)) {
    return false;
  }
  // A `disabled` Skill tool — a `permissions.deny` rule or `excludeTools` —
  // is registered nowhere: not in the session registry, not in a rebuilt
  // subagent one. No declaration shape and no bridge can surface a name that
  // was never registered, so the listing must go dark for every agent.
  if (options.skillRegistration === 'disabled') {
    return false;
  }
  // A `deferred` Skill tool stays registered but is kept out of the eager
  // request, so `prepareTools()` declares neither it nor (under CodeModeOnly)
  // the bridge that reaches it. Reachability then depends on the declaration
  // shape, which only this predicate can see.
  const deferred = options.skillRegistration === 'deferred';
  const bridgeHidden = deferred && options.codeModeOnly === true;
  if (!toolConfig) {
    // No per-agent config inherits the whole registry — the bridge included,
    // unless CodeModeOnly hides it.
    return !bridgeHidden;
  }
  const isDisallowed = (toolName: string): boolean =>
    toolConfig.disallowedTools?.some((pattern) =>
      matchesToolPattern(pattern, toolName),
    ) === true;
  if (isDisallowed(ToolNames.SKILL)) {
    return false;
  }
  if (options.codeModeOnly === true && isDisallowed(ToolNames.EXEC)) {
    return false;
  }
  const names = toolConfig.tools.filter(
    (tool): tool is string => typeof tool === 'string',
  );
  const inlineDeclarations = toolConfig.tools.filter(
    (tool): tool is FunctionDeclaration => typeof tool !== 'string',
  );
  const inheritsRegistry =
    names.includes('*') ||
    (names.length === 0 && inlineDeclarations.length === 0);
  if (deferred) {
    // The eager allowlist drops `skill` from the declarations, so the route
    // lives or dies with the bridge, and `resolveBundledReferenceRoute` needs
    // BOTH halves to call it a route: with `tool_search` alone the schema can
    // be reviewed but never invoked. Leaving both halves standing is still
    // not enough. A finite `tools` list doubles as the invocation allowlist —
    // `AgentCore.getConfiguredToolExecutionAllowlist()` returns exactly the
    // declared names — and the scheduler re-gates the bridge's RESOLVED
    // target against it, so a list that omits `skill` resolves the call only
    // to refuse it with EXECUTION_DENIED. That allowlist is `undefined`, and
    // the invocation gate with it, exactly where the registry is inherited or
    // where the config carries its own `executionAllowedTools`; those two
    // shapes answer on the bridge alone. Only the declaration-level half of
    // this arm is mirrored from `prepareTools()`, so an explicit list that
    // never named the bridge cannot be told to use it (#12424).
    if (bridgeHidden) {
      return false;
    }
    const declaresBridge = (toolName: string): boolean =>
      (inheritsRegistry || names.includes(toolName)) && !isDisallowed(toolName);
    return (
      declaresBridge(ToolNames.TOOL_SEARCH) &&
      declaresBridge(ToolNames.TOOL_CALL) &&
      (inheritsRegistry ||
        names.includes(ToolNames.SKILL) ||
        toolConfig.executionAllowedTools !== undefined)
    );
  }
  const reachesSkillThroughExec =
    options.codeModeOnly === true &&
    names.includes(ToolNames.EXEC) &&
    getToolExposure(ToolNames.SKILL) === 'code-mode-callable';
  if (
    !inheritsRegistry &&
    !names.includes(ToolNames.SKILL) &&
    !reachesSkillThroughExec
  ) {
    return false;
  }
  return true;
}

/**
 * How the Skill tool participates in this session's registry — the value
 * every `options.skillRegistration` input must carry: the session's
 * `ToolRegistrationStatus` verdict for `skill`, with one adjustment.
 *
 * A `tools.visible` entry re-exposes a deferred schema, which makes the tool
 * declared again — the bridge is no longer the only route — so that reads as
 * `registered` here. It cannot do the same for `disabled`: a denied tool is
 * not registered at all, so there is nothing to expose. That is why the
 * `disabled` verdict is returned before the visibility check.
 *
 * The verdict comes from the session's PermissionManager, NOT from `config`'s
 * own registry: a manager-withholding agent's rebuilt registry has no
 * `skill` entry at all (config.ts registers the SkillTool factory only when
 * the override holds a manager), so a registry probe answers structurally
 * false at nesting depth ≥ 2 and hands the session manager back one level
 * down. `getPermissionManager()` resolves through the prototype chain to the
 * session's manager, whose answer does not depend on which registry is
 * asked.
 *
 * The tool mode is deliberately NOT consulted here. Whether a deferred Skill
 * tool is reachable is a property of the agent's declarations, so that
 * reasoning lives in {@link toolConfigAllowsSkill} — the only place that can
 * see the `ToolConfig`. Gating this probe on CodeModeOnly instead answered
 * `registered` for every Direct-mode agent, including one whose explicit
 * list named neither bridge half: the nested Agent tool then pointed at
 * `tool_search`/`tool_call` while `prepareTools()` declared neither, and the
 * `<available_skills>` listing stayed lit — the #12424 disagreement this
 * predicate exists to prevent.
 *
 * Where this cannot tell — no permission manager, no registration-status
 * probe — it answers `registered`, matching the predicate's documented
 * preference: a wrong `true` costs an unfollowable pointer, a wrong `false`
 * takes skills away from an agent that could load them.
 *
 * Shared by `SubagentManager.createAgentHeadless()` and the background
 * resume path (`subagentWillHaveSkillTool`) so the launch and the resume
 * cannot drift on what the session's permission state means for the same
 * agent.
 */
export async function skillRegistrationStatusFor(
  config: Config,
): Promise<ToolRegistrationStatus> {
  const status = await config
    .getPermissionManager?.()
    ?.getToolRegistrationStatus?.(ToolNames.SKILL);
  if (status === 'disabled') {
    return 'disabled';
  }
  if (config.getVisibleTools?.()?.has(ToolNames.SKILL)) {
    return 'registered';
  }
  return status === 'deferred' ? 'deferred' : 'registered';
}

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
  ToolNames.RECORD_SOURCE,
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

/**
 * Whether `toolName` matches a per-agent `disallowedTools` blocklist, with
 * the exact match semantics AgentCore.prepareTools() applies at declaration
 * level: MCP server-level patterns via {@link matchesMcpPattern} for `mcp__`
 * tools, exact match otherwise. Shared so a fork's inherited execution
 * allowlist (tools/agent/agent.ts) cannot drift from the parent's own
 * declaration/invocation enforcement.
 */
export function matchesAgentToolBlocklist(
  blocklist: readonly string[] | undefined,
  toolName: string,
): boolean {
  if (!blocklist?.length) {
    return false;
  }
  return blocklist.some((pattern) =>
    toolName.startsWith('mcp__')
      ? matchesMcpPattern(pattern, toolName)
      : pattern === toolName,
  );
}

/**
 * The effective exclusion test, shared by `prepareTools()` (declaration
 * level) and the tool_call bridge (`resolveDeferredToolCall`, invocation
 * level) so the two layers cannot drift.
 *
 * Deliberately NOT gated on isSubagentLikeExecutionContext(): prepareTools()
 * only ever serves agents and must fail closed on a missing agent frame
 * (isTopLevelSession() below), while the bridge wraps this predicate in its
 * own context gate so the top-level leader session stays unaffected.
 *
 * AgentTool is depth-gated rather than unconditionally excluded — mirroring
 * `prepareTools()`: while `spawnBlockReason()` permits another nesting level
 * inside a genuine agent frame, AgentTool is re-admitted even though it is a
 * member of the raw exclusion sets. The raw-set entry remains the fail-closed
 * floor: when `maxSubagentDepth` is unknown (undefined) AgentTool stays
 * excluded, as do teammate and fork contexts (spawnBlockReason reports
 * 'teammate'/'fork' for them).
 */
export function isToolExcludedForCurrentContext(
  toolName: string,
  maxSubagentDepth?: number,
): boolean {
  if (toolName === ToolNames.AGENT) {
    if (maxSubagentDepth === undefined) {
      return true;
    }
    const nestingAllowed =
      !isTopLevelSession() && spawnBlockReason(maxSubagentDepth) === null;
    return !nestingAllowed;
  }
  return getExcludedToolsForCurrentContext().has(toolName);
}

/**
 * The model-facing denial message for a tool refused by the exclusion set.
 * Shared by the tool_call bridge and tool_search's discovery-side filter so
 * both halves of the bridge report the same wording.
 */
export function getExcludedToolUnavailableMessage(toolName: string): string {
  return `Tool "${toolName}" is not available to this agent.`;
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

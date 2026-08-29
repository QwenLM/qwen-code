/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared permission flow (L3→L4) for tool execution.
 *
 * Used by both `CoreToolScheduler` (CLI mode) and `Session` (ACP mode)
 * to ensure consistent permission evaluation.
 *
 * L3: Tool's intrinsic default permission
 * L4: PermissionManager rule override
 *
 * L5 overrides (ApprovalMode: YOLO, AUTO_EDIT, PLAN) are handled by
 * the callers because some (plan mode, AUTO_EDIT) need
 * `confirmationDetails.type` which is only available after calling
 * `invocation.getConfirmationDetails()`.
 */

import type { AnyToolInvocation } from '../tools/tools.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  buildPermissionCheckContext,
  evaluatePermissionRules,
} from './permission-helpers.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';

export type PermissionFlowPermission = PermissionDecision;

export interface PermissionFlowResult {
  /** The tool's intrinsic L3 permission before PermissionManager rules. */
  defaultPermission: PermissionFlowPermission;
  /** The final permission after L3→L4 (allow | deny | ask | default) */
  finalPermission: PermissionFlowPermission;
  /** Whether PM forced 'ask' (hides "Always Allow" buttons) */
  pmForcedAsk: boolean;
  /** Deny message (only set when finalPermission === 'deny') */
  denyMessage?: string;
  /** Permission check context (needed for injectPermissionRulesIfMissing) */
  pmCtx: ReturnType<typeof buildPermissionCheckContext>;
  /** Whether automatic approval paths must be bypassed for this invocation. */
  requiresUserInteraction: boolean;
}

/**
 * Execute the L3→L4 permission flow.
 *
 * @param config - The CLI config
 * @param invocation - The tool invocation
 * @param toolName - Name of the tool being called
 * @param toolParams - Parameters passed to the tool
 * @returns The permission decision and related metadata.
 *   `finalPermission` can be 'allow', 'deny', 'ask', or 'default'.
 *   The 'default' state is produced when the tool's default permission
 *   returns something other than the standard values (e.g. an edge case
 *   in the tool's getDefaultPermission implementation).
 */
export async function evaluatePermissionFlow(
  config: Config,
  invocation: AnyToolInvocation,
  toolName: string,
  toolParams: Record<string, unknown>,
): Promise<PermissionFlowResult> {
  // ── L3: Tool's default permission ───────────────────────────────────
  const defaultPermission = await invocation.getDefaultPermission();

  // ── L4: PermissionManager override ──────────────────────────────────
  const pm = config.getPermissionManager?.();
  const toolRegistry = config.getToolRegistry?.();
  const mcpInvocation = invocation as AnyToolInvocation & {
    serverName?: unknown;
    serverToolName?: unknown;
  };
  const rawMcpToolName =
    toolName.startsWith('mcp__') &&
    typeof mcpInvocation.serverName === 'string' &&
    typeof mcpInvocation.serverToolName === 'string'
      ? `mcp__${mcpInvocation.serverName}__${mcpInvocation.serverToolName}`
      : undefined;

  const registryAliasResolver =
    toolRegistry?.getUnambiguousMcpPermissionAliases;
  const legacyAliases = invocation.permissionAliases;

  // Grant-safe aliases are deliberately collision-filtered. If we have an
  // authoritative raw MCP identity but an incomplete registry mock, fail
  // closed for grants by dropping lossy legacy aliases instead of restoring
  // the collision behavior this PR removes. If no raw identity is available,
  // retain the pre-existing aliases because there is no authoritative identity
  // to replace them with.
  const grantLegacyAliases =
    toolName.startsWith('mcp__') && legacyAliases
      ? toolRegistry && typeof registryAliasResolver === 'function'
        ? registryAliasResolver.call(toolRegistry, toolName, legacyAliases)
        : rawMcpToolName
          ? []
          : legacyAliases
      : legacyAliases;

  const permissionAliases = rawMcpToolName
    ? [...new Set([...(grantLegacyAliases ?? []), rawMcpToolName])]
    : grantLegacyAliases;
  const pmCtx = buildPermissionCheckContext(
    toolName,
    toolParams,
    config.getTargetDir?.() ?? '',
    permissionAliases,
  );

  let finalPermission: string = defaultPermission;
  let pmForcedAsk = false;
  let restrictiveMatchCtx: PermissionCheckContext | undefined;

  if (pm && defaultPermission !== 'deny' && rawMcpToolName) {
    // Ambiguous legacy aliases are unsafe as grants but must remain available
    // to restrictive rules. Evaluate restrictions against both identity
    // spellings: raw identity preserves collision resistance, while putting
    // the registered provider-safe name first preserves historical sanitized
    // deny/ask spellings. Ignore `allow` from these broad contexts and perform
    // the real grant evaluation only with `pmCtx` below.
    const fullAliases = [...new Set([rawMcpToolName, ...(legacyAliases ?? [])])];
    const restrictiveContexts = [
      buildPermissionCheckContext(
        toolName,
        toolParams,
        config.getTargetDir?.() ?? '',
        fullAliases,
      ),
      buildPermissionCheckContext(
        toolName,
        toolParams,
        config.getTargetDir?.() ?? '',
        [...new Set([toolName, rawMcpToolName, ...(legacyAliases ?? [])])],
      ),
    ];

    // PermissionManager guarantees deny > ask only within one evaluate call.
    // These contexts intentionally represent different MCP spellings, so keep
    // searching after an ask: a deny that matches a later spelling must still
    // win globally. The first matching ask is applied only if no deny exists.
    let restrictiveAskCtx: PermissionCheckContext | undefined;
    for (const ctx of restrictiveContexts) {
      if (!pm.hasRelevantRules(ctx)) continue;
      const decision = await pm.evaluate(ctx);
      if (decision === 'deny') {
        finalPermission = 'deny';
        restrictiveMatchCtx = ctx;
        break;
      }
      if (decision === 'ask' && !restrictiveAskCtx) {
        restrictiveAskCtx = ctx;
      }
    }

    if (!restrictiveMatchCtx && restrictiveAskCtx) {
      finalPermission = 'ask';
      restrictiveMatchCtx = restrictiveAskCtx;
      if (pm.hasMatchingAskRule(restrictiveAskCtx)) {
        pmForcedAsk = true;
      }
    }
  }

  if (!restrictiveMatchCtx) {
    const evaluated = await evaluatePermissionRules(
      pm,
      defaultPermission,
      pmCtx,
    );
    finalPermission = evaluated.finalPermission;
    pmForcedAsk = evaluated.pmForcedAsk;
  }

  const requiresUserInteraction =
    invocation.requiresUserInteraction?.() === true;
  const effectivePermission =
    requiresUserInteraction && finalPermission !== 'deny'
      ? 'ask'
      : finalPermission;

  // Build result
  const result: PermissionFlowResult = {
    defaultPermission,
    finalPermission: effectivePermission as PermissionFlowPermission,
    pmForcedAsk,
    pmCtx,
    requiresUserInteraction,
  };

  // Add deny message if denied
  if (finalPermission === 'deny') {
    if (defaultPermission === 'deny') {
      result.denyMessage = `Tool "${toolName}" is denied: the tool's default permission is 'deny'.`;
    } else {
      const matchingRule = pm?.findMatchingDenyRule(
        restrictiveMatchCtx ?? pmCtx,
      );
      const ruleInfo = matchingRule
        ? ` Matching deny rule: "${matchingRule}".`
        : '';
      result.denyMessage = `Tool "${toolName}" is denied by permission rules.${ruleInfo}`;
    }
  }

  return result;
}

/**
 * Check if the tool needs user confirmation based on the permission flow
 * result and the current ApprovalMode.
 *
 * This handles the YOLO mode override (L5) which doesn't require
 * confirmationDetails.
 *
 * Note: Plan mode and AUTO_EDIT mode are L5 overrides that need
 * confirmationDetails.type - callers must handle those separately.
 */
export function needsConfirmation(
  finalPermission: PermissionFlowPermission,
  approvalMode: ApprovalMode,
  toolName: string,
  requiresUserInteraction = false,
): boolean {
  if (finalPermission === 'deny') {
    return false;
  }
  if (requiresUserInteraction) {
    return true;
  }
  const isAskUserQuestionTool = toolName === ToolNames.ASK_USER_QUESTION;

  // YOLO mode auto-approves everything except ask_user_question
  if (approvalMode === ApprovalMode.YOLO && !isAskUserQuestionTool) {
    return false;
  }

  return finalPermission === 'ask' || finalPermission === 'default';
}

export function getEffectivePermissionForConfirmation(
  finalPermission: PermissionFlowPermission,
  forceConfirmationForAllow: boolean,
): PermissionFlowPermission {
  if (forceConfirmationForAllow && finalPermission === 'allow') {
    return 'ask';
  }
  return finalPermission;
}

/**
 * Check if plan mode blocks the tool execution.
 *
 * This must be called AFTER getting confirmationDetails because it needs
 * `confirmationDetails.type`.
 */
export function isPlanModeBlocked(
  isPlanMode: boolean,
  isExitPlanModeTool: boolean,
  isAskUserQuestionTool: boolean,
  confirmationDetails?: ToolCallConfirmationDetails,
  isEnterPlanModeTool?: boolean,
): boolean {
  return (
    isPlanMode &&
    !isExitPlanModeTool &&
    !isAskUserQuestionTool &&
    !isEnterPlanModeTool &&
    confirmationDetails?.type !== 'info'
  );
}

/**
 * Check if AUTO_EDIT mode auto-approves the tool.
 *
 * This must be called AFTER getting confirmationDetails because it needs
 * `confirmationDetails.type`.
 */
export function isAutoEditApproved(
  approvalMode: ApprovalMode,
  confirmationDetails?: ToolCallConfirmationDetails,
): boolean {
  return (
    approvalMode === ApprovalMode.AUTO_EDIT &&
    (confirmationDetails?.type === 'edit' ||
      confirmationDetails?.type === 'info')
  );
}

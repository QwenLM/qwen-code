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
import { parseRule } from '../permissions/rule-parser.js';
import type { PermissionDecision } from '../permissions/types.js';
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
  const pmCtx = buildPermissionCheckContext(
    toolName,
    toolParams,
    config.getTargetDir?.() ?? '',
    invocation.permissionAliases,
  );
  const { finalPermission, pmForcedAsk } = await evaluatePermissionRules(
    pm,
    defaultPermission,
    pmCtx,
  );
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
      const matchingRule = pm?.findMatchingDenyRule(pmCtx);
      const ruleInfo = matchingRule
        ? ` Matching deny rule: "${matchingRule}".`
        : '';
      // A specifier-scoped deny (e.g. `Bash(npm view *)`) blocks only this
      // invocation, not the whole tool. Say so explicitly so the model does
      // not abandon the tool entirely (issue #11405). Tool-wide catch-alls
      // (`Bash(*)`, `Read(//**)`, `WebFetch(*)`) block the tool entirely and
      // must NOT get this reassurance.
      const stillPermitted =
        matchingRule && !isToolWideDenyRule(matchingRule)
          ? ' Other uses of this tool are still permitted.'
          : '';
      result.denyMessage = `This "${toolName}" invocation was denied by permission rules.${ruleInfo}${stillPermitted}`;
    }
  }

  return result;
}

/**
 * Whether a raw deny-rule string blocks the tool as a whole (tool-wide)
 * rather than a single scoped invocation.
 *
 * Tool-wide forms are the bare tool name (`Bash`), an empty specifier
 * (`Bash()`), the command/domain catch-all (`Bash(*)`, `WebFetch(*)`), and
 * the filesystem-root path catch-all (`Read(//**)`). A rule like
 * `Bash(npm view *)` is scoped and returns false.
 */
function isToolWideDenyRule(raw: string): boolean {
  const rule = parseRule(raw);
  if (!rule.specifier) {
    // No specifier blocks the whole tool; a param-matcher-only rule
    // (e.g. `Agent(model:opus)`) is still scoped by its matchers.
    return !rule.toolParamMatchers?.length;
  }
  if (rule.specifierKind === 'path') {
    // `//**` resolves to the filesystem root (`/**`) and matches every path.
    return rule.specifier === '//**';
  }
  // `*` is the documented catch-all for command and domain specifiers.
  return rule.specifier === '*';
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

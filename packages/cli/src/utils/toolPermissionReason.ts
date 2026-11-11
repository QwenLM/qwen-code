/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolPermissionReason } from '@qwen-code/core';

export type CanUseToolDecisionReasonType =
  | 'rule'
  | 'mode'
  | 'subcommandResults'
  | 'permissionPromptTool'
  | 'hook'
  | 'asyncAgent'
  | 'sandboxOverride'
  | 'workingDir'
  | 'safetyCheck'
  | 'classifier'
  | 'other';

export function serializeCanUseToolDecisionReasonType(
  reason: ToolPermissionReason | undefined,
): CanUseToolDecisionReasonType | undefined {
  if (!reason) {
    return undefined;
  }
  switch (reason.attribution.type) {
    case 'managedRule':
      return 'rule';
    case 'rule':
    case 'mode':
    case 'hook':
    case 'classifier':
    case 'workingDir':
    case 'safetyCheck':
      return reason.attribution.type;
    case 'interaction':
    case 'other':
      return 'other';
    default:
      return undefined;
  }
}

export function getCanUseToolClassifierApprovable(
  reason: ToolPermissionReason | undefined,
): boolean | undefined {
  // Only a safety objection carries this: it says whether Auto's classifier is
  // allowed to approve the call despite the objection.
  if (reason?.attribution.type === 'safetyCheck') {
    return reason.attribution.classifierApprovable;
  }
  return undefined;
}

export function serializeCanUseToolDecisionReason(
  reason: ToolPermissionReason | undefined,
): string | undefined {
  if (!reason) {
    return undefined;
  }
  // A rule or a mode speaks for itself — naming it is the whole explanation,
  // and the free-text field would only repeat the type. The rest carry prose.
  switch (reason.attribution.type) {
    case 'managedRule':
      return reason.message;
    case 'rule':
    case 'mode':
      return undefined;
    case 'hook':
      return (
        reason.attribution.reason ?? `Hook: ${reason.attribution.hookName}`
      );
    default:
      return reason.attribution.reason;
  }
}

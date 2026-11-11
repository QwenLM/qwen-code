/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The PermissionDenied hook.
 *
 * Only an auto-mode classifier denial fires it: rule or mode refusals are
 * final. A denial's attribution marks the classifier source. When the hook
 * asks for a retry, the gate attaches `permissionDeniedHookRetry` to the
 * denied outcome and the executor surfaces it to the model; the fire is
 * therefore awaited.
 */

import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import { runLogger } from '../utils/runLogger.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';

type PermissionDeniedHookSystem = {
  firePermissionDeniedEvent?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    reason: string,
    signal?: AbortSignal,
    model?: string,
  ) => Promise<AggregatedHookResult | undefined>;
};

type RetryAwareHookOutput = {
  shouldRetry?: () => boolean;
};

/** A denial reason the auto-mode classifier authored. */
type AutoModeClassifierDenyReason = ToolPermissionReason & {
  attribution: {
    type: 'classifier';
    classifier: 'auto-mode';
    reason: string;
  };
};

/** Whether a denial reason is the auto-mode classifier's. */
export function isAutoModeClassifierDenyReason(
  reason: ToolPermissionReason | undefined,
): reason is AutoModeClassifierDenyReason {
  const attribution = reason?.attribution;
  return (
    attribution?.type === 'classifier' &&
    attribution.classifier === 'auto-mode'
  );
}

/**
 * Fire the PermissionDenied hook for an auto-mode classifier denial.
 *
 * Returns whether the hook asked for a retry. Anything else — a non-classifier
 * denial, no hook system, a hook that throws — returns false and the denial
 * stands as-is.
 */
export async function firePermissionDeniedHookForAutoModeClassifierDeny({
  hookSystem,
  reason,
  toolName,
  toolInput,
  toolUseId,
  signal,
  model,
  logPrefix = 'PermissionDenied',
}: {
  hookSystem: PermissionDeniedHookSystem | undefined;
  reason: ToolPermissionReason | undefined;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  signal?: AbortSignal;
  model?: string;
  logPrefix?: string;
}): Promise<boolean> {
  if (
    !isAutoModeClassifierDenyReason(reason) ||
    !hookSystem?.firePermissionDeniedEvent
  ) {
    return false;
  }

  try {
    // Classifier rationale first, then the denial wording.
    const hookReason =
      reason.attribution.reason ||
      reason.message ||
      'Permission denied by auto mode classifier.';
    const result = await hookSystem.firePermissionDeniedEvent(
      toolName,
      toolInput,
      toolUseId,
      hookReason,
      signal,
      model,
    );
    const output = result?.finalOutput as RetryAwareHookOutput | undefined;
    return output?.shouldRetry?.() === true;
  } catch (error) {
    runLogger.debug(
      `[${logPrefix}] PermissionDenied hook failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  calculateTokenWarningState,
  calculateTokenWarningStateForContextWindow,
  getEffectiveContextWindowSize,
  getRawContextWindowSize,
  type Model,
} from '@qwen-code/core';

/**
 * Returns the fraction of the model's raw context window currently used.
 * Used purely for display ("X% used") — auto-compact / blocking decisions
 * use the buffer-aware threshold helpers from core instead.
 */
export function getContextUsagePercentage(
  promptTokenCount: number,
  model: Model | undefined,
  resolvedContextWindow?: number,
): number {
  if (!model && resolvedContextWindow === undefined) {
    return 0;
  }
  const limit = getRawContextWindowSize(model, resolvedContextWindow);
  if (limit <= 0) {
    return 0;
  }
  return promptTokenCount / limit;
}

/**
 * True when usage has crossed the warning buffer above the auto-compact
 * threshold (the same ladder used for amber/red coloring).
 */
export function isContextUsageHigh(
  promptTokenCount: number,
  model: Model | undefined,
  resolvedContextWindow?: number,
): boolean {
  if (!model && resolvedContextWindow === undefined) {
    return false;
  }
  return resolvedContextWindow === undefined
    ? calculateTokenWarningState(promptTokenCount, model)
        .isAboveWarningThreshold
    : calculateTokenWarningStateForContextWindow(
        promptTokenCount,
        getEffectiveContextWindowSize(model, resolvedContextWindow),
      ).isAboveWarningThreshold;
}

/**
 * True when usage has hit the absolute blocking limit. The Composer uses this
 * to warn; the agent loop auto-compacts first and only refuses the final
 * request if it is still over the same limit.
 */
export function isAtBlockingLimit(
  promptTokenCount: number,
  model: Model | undefined,
  resolvedContextWindow?: number,
): boolean {
  if (!model && resolvedContextWindow === undefined) {
    return false;
  }
  return resolvedContextWindow === undefined
    ? calculateTokenWarningState(promptTokenCount, model).isAtBlockingLimit
    : calculateTokenWarningStateForContextWindow(
        promptTokenCount,
        getEffectiveContextWindowSize(model, resolvedContextWindow),
      ).isAtBlockingLimit;
}

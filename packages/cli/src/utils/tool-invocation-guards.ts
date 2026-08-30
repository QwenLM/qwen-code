/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  createManualDreamToolInvocationGuard,
  evaluateToolInvocationGuards,
  isManualDreamToolGuardTurn,
  MANUAL_DREAM_TOOL_GUARD_MARKER,
  type Config,
  type ToolInvocationGuard,
} from '@qwen-code/qwen-code-core';

export { MANUAL_DREAM_TOOL_GUARD_MARKER };

/**
 * Reconstruct the /dream guard for an interrupted API-history continuation.
 * Function values cannot be persisted in chat history, so /dream includes a
 * stable, restrictive-only provenance marker alongside its expanded prompt.
 * A user forging this marker can only opt into the tighter guard, not gain
 * authority.
 */
export function recoverManualDreamToolInvocationGuard(
  config: Config,
  history: readonly Content[],
): ToolInvocationGuard | undefined {
  return isManualDreamToolGuardTurn(history)
    ? createManualDreamToolInvocationGuard(config.getProjectRoot())
    : undefined;
}

/** Combine independently supplied turn guards without weakening any of them. */
export function combineToolInvocationGuards(
  guards: readonly ToolInvocationGuard[],
): ToolInvocationGuard | undefined {
  if (guards.length === 0) return undefined;
  if (guards.length === 1) return guards[0];
  return (context) => evaluateToolInvocationGuards(guards, context);
}

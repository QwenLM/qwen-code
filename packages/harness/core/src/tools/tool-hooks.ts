/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool hook pipeline: translates the existing HookSystem outputs into
 * structured hook results, and provides permission merge logic.
 *
 * This module bridges the existing HookSystem (hookSystem.ts) with the
 * structured lifecycle types (hook-types.ts). It does NOT replace the
 * existing hook infrastructure — it wraps it.
 *
 * Key functions:
 * - `translatePreToolHookOutput()` — Converts DefaultHookOutput → PreToolUseHookResult
 * - `translatePostToolHookOutput()` — Converts DefaultHookOutput → PostToolUseHookResult
 * - `resolveHookPermissionDecision()` — Merges hook + permission pipeline decisions
 * - `handlePostToolUseFailure()` — Placeholder for future failure hook support
 */

import {
  type DefaultHookOutput,
  PreToolUseHookOutput,
  type HookDecision,
} from '../hooks/types.js';
import type {
  PermissionDecision,
  PermissionDecisionKind,
} from './tool-types.js';
import type {
  PreToolUseHookResult,
  PostToolUseHookResult,
  PostToolUseFailureHookResult,
  HookPermissionResult,
} from './hook-types.js';
import type { ToolResult } from './tools.js';

// ---------------------------------------------------------------------------
// PreToolUse translation
// ---------------------------------------------------------------------------

/**
 * Maps HookDecision from the existing hook system to a HookPermissionResult.
 *
 * HookDecision: 'allow' | 'deny' | 'ask' | 'defer' | undefined
 * HookPermissionResult: 'allow' | 'deny' | 'ask' | 'none'
 */
export function mapHookDecisionToPermission(
  decision: HookDecision,
): HookPermissionResult {
  switch (decision) {
    case 'allow':
      return 'allow';
    case 'deny':
      return 'deny';
    case 'ask':
      return 'ask';
    case 'defer':
    case undefined:
    default:
      return 'none';
  }
}

/**
 * Translates a DefaultHookOutput (from PreToolUse hook event) into a
 * structured PreToolUseHookResult.
 *
 * @param output The raw hook output from hookSystem.firePreToolUseEvent()
 * @returns Structured PreToolUseHookResult, or undefined if output is null/undefined
 */
export function translatePreToolHookOutput(
  output: DefaultHookOutput | null | undefined,
): PreToolUseHookResult | undefined {
  if (!output) {
    return undefined;
  }

  const result: PreToolUseHookResult = {};

  result.hookPermissionResult = mapHookDecisionToPermission(output.decision);

  // Modified input (only available from PreToolUseHookOutput)
  if (output instanceof PreToolUseHookOutput) {
    const modifiedInput = output.getModifiedToolInput();
    if (modifiedInput) {
      result.hookUpdatedInput = modifiedInput;
    }
  }

  const additionalContext = output.getAdditionalContext();
  if (additionalContext) {
    result.additionalContext = additionalContext;
  }

  // Stop halts the session; also prevents continuation to avoid orphaned tool results.
  if (output.shouldStopExecution()) {
    result.stop = true;
    result.reason = output.getEffectiveReason();
    result.preventContinuation = true;
  } else if (output.isBlockingDecision()) {
    result.preventContinuation = true;
    result.reason = output.getEffectiveReason();
  }

  return result;
}

// ---------------------------------------------------------------------------
// PostToolUse translation
// ---------------------------------------------------------------------------

/**
 * Translates a DefaultHookOutput (from PostToolUse hook event) into a
 * structured PostToolUseHookResult.
 *
 * @param output The raw hook output from hookSystem.firePostToolUseEvent()
 * @returns Structured PostToolUseHookResult, or undefined if output is null/undefined
 */
export function translatePostToolHookOutput(
  output: DefaultHookOutput | null | undefined,
): PostToolUseHookResult | undefined {
  if (!output) {
    return undefined;
  }

  const result: PostToolUseHookResult = {};

  // Stop execution
  if (output.shouldStopExecution()) {
    result.stop = true;
    result.reason = output.getEffectiveReason();
  }

  // Blocking error
  const blockingError = output.getBlockingError();
  if (blockingError.blocked) {
    result.blockingError = blockingError.reason;
    result.reason = blockingError.reason;
  }

  // Additional context(s)
  const additionalContext = output.getAdditionalContext();
  if (additionalContext) {
    result.additionalContexts = [additionalContext];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Permission decision merge
// ---------------------------------------------------------------------------

/**
 * Resolved permission decision after merging hook and permission pipeline outcomes.
 */
export interface ResolvedPermissionDecision {
  /** Final decision kind. */
  readonly decision: PermissionDecisionKind;
  /** Human-readable reason for the decision. */
  readonly reason?: string;
  /** Which source determined the decision. */
  readonly source: 'hook' | 'permission' | 'default';
}

/**
 * Merges a hook permission result with a permission pipeline decision.
 *
 * Priority order (highest to lowest):
 * 1. Hook deny  → immediate deny (hook can always block)
 * 2. Rule deny  → deny (permission deny overrides hook allow)
 * 3. Hook allow → allow (but cannot override permission deny)
 * 4. Hook ask   → ask_user
 * 5. Hook none  → use permission decision as-is
 *
 * @param hookResult The hook's permission result (may be undefined = 'none')
 * @param permissionDecision The permission pipeline's decision (may be undefined = allow)
 * @returns The merged permission decision
 */
export function resolveHookPermissionDecision(
  hookResult?: HookPermissionResult,
  permissionDecision?: PermissionDecision,
): ResolvedPermissionDecision {
  const hookPerm = hookResult ?? 'none';
  const permKind = permissionDecision?.decision ?? 'allow';

  // 1. Hook deny → immediate deny (highest priority)
  if (hookPerm === 'deny') {
    return {
      decision: 'deny',
      reason: permissionDecision?.reason ?? 'Denied by hook',
      source: 'hook',
    };
  }

  // 2. Permission deny → deny (overrides hook allow)
  if (permKind === 'deny') {
    return {
      decision: 'deny',
      reason: permissionDecision?.reason ?? 'Denied by permission rule',
      source: 'permission',
    };
  }

  // 3. Hook allow → allow (permission is not deny, so hook can permit)
  if (hookPerm === 'allow') {
    return {
      decision: 'allow',
      reason: 'Allowed by hook',
      source: 'hook',
    };
  }

  // 4. Hook ask → ask_user
  if (hookPerm === 'ask') {
    return {
      decision: 'ask_user',
      reason: 'Hook requests user confirmation',
      source: 'hook',
    };
  }

  // 5. Hook none → use permission decision as-is
  return {
    decision: permKind,
    reason: permissionDecision?.reason,
    source: permKind === 'allow' ? 'default' : 'permission',
  };
}

// ---------------------------------------------------------------------------
// PostToolUseFailure handling
// ---------------------------------------------------------------------------

/**
 * Gives hooks a chance to recover from tool execution failure.
 * There is no dedicated failure event yet; this is the extension point for
 * future PostToolUseFailure support.
 */
export async function handlePostToolUseFailure(
  toolName: string,
  error: Error,
  toolInput: Record<string, unknown>,
  hookHandler?: (
    toolName: string,
    error: Error,
    toolInput: Record<string, unknown>,
  ) => Promise<PostToolUseFailureHookResult | undefined>,
): Promise<PostToolUseFailureHookResult | undefined> {
  if (!hookHandler) {
    return undefined;
  }

  try {
    return await hookHandler(toolName, error, toolInput);
  } catch {
    // Failure hook itself failed — swallow to avoid masking the original error.
    return undefined;
  }
}

/**
 * Applies a PostToolUseFailureHookResult to an error, producing either
 * a recovered ToolResult or an enhanced error.
 *
 * @param failureResult The failure hook result.
 * @param originalError The original execution error.
 * @returns An object with either a recovered ToolResult or an enhanced Error.
 */
export function applyFailureHookResult(
  failureResult: PostToolUseFailureHookResult | undefined,
  originalError: Error,
):
  | { recovered: true; result: ToolResult; additionalContexts?: string[] }
  | { recovered: false; error: Error; additionalContexts?: string[] } {
  if (!failureResult) {
    return { recovered: false, error: originalError };
  }

  const { additionalContexts } = failureResult;

  // Full recovery — replace the error entirely
  if (failureResult.recoveredResult) {
    return {
      recovered: true,
      result: failureResult.recoveredResult,
      additionalContexts,
    };
  }

  // Enhanced error — replace the message but still treat as failure
  if (failureResult.enhancedError) {
    const enhanced = new Error(failureResult.enhancedError);
    enhanced.cause = originalError;
    return { recovered: false, error: enhanced, additionalContexts };
  }

  return { recovered: false, error: originalError, additionalContexts };
}

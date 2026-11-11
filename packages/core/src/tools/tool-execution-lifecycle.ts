/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Composable execution pipeline for a single tool invocation.
 *
 * Stages: runtime validation → BeforeTool hooks → policy check →
 * confirmation (optional) → execution → AfterTool hooks.
 *
 * The pipeline is decoupled from scheduler state and diagnostics; callers
 * inject confirmation, policy and hooks through options.
 */

import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
  ToolResult,
} from './tools.js';
import type { ToolCallRequestInfo } from '../tool-executor/types.js';
import { toError, isCancelledError } from './abort-utils.js';
import type { PostToolUseFailureHookResult } from './hook-types.js';
import {
  handlePostToolUseFailure,
  applyFailureHookResult,
} from './tool-hooks.js';
import { runLogger } from '../utils/runLogger.js';
import type { ToolDenialKind } from '../protocol/schemas/common.js';
import type { ToolPermissionDecision } from '../protocol/schemas/common.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of the before-execution phase (hooks + policy + confirmation).
 *
 * - `'proceed'` — Execution should continue normally.
 * - `'denied'` — A user, policy, hook, or controller denied permission.
 * - `'cancelled'` — The prompt or turn was aborted without a permission answer.
 * - `'hook-error'` — Hook evaluation itself failed; `error` describes the failure.
 */
export type PreExecutionOutcome =
  | {
      status: 'proceed';
      modifiedArgs?: Record<string, unknown>;
    }
  | {
      status: 'denied';
      error: Error;
      errorType?: import('./tool-error.js').ToolErrorType;
      permissionDeniedHookRetry?: boolean;
      toolDenialKind?: ToolDenialKind;
      userFeedback?: string;
      decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
      decisionReason?: string;
    }
  | {
      status: 'cancelled';
      error: Error;
      toolDenialKind?: ToolDenialKind;
      userFeedback?: string;
      decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
      decisionReason?: string;
    }
  | { status: 'hook-error'; error: Error };

/**
 * Callback that performs the actual tool execution.
 * Receives the (possibly arg-modified) invocation and per-tool signal.
 * Returns the raw ToolResult.
 */
export type ExecuteFn = (
  invocation: AnyToolInvocation,
  signal: AbortSignal,
) => Promise<ToolResult>;

/**
 * Optional pre-execution gate callback.
 *
 * Called before execution to evaluate hooks, policy, and user confirmation.
 * The caller (typically the Scheduler) implements this to integrate with
 * its existing hook/policy/confirmation infrastructure.
 *
 * Returns a `PreExecutionOutcome` indicating whether execution should proceed.
 */
export type PreExecutionGateFn = (
  invocation: AnyToolInvocation,
  request: ToolCallRequestInfo,
  tool: AnyDeclarativeTool,
  signal: AbortSignal,
  toolUseContext?: import('./tool-types.js').ToolUseContext,
) => Promise<PreExecutionOutcome>;

/**
 * Optional post-execution callback.
 *
 * Called after successful execution to fire AfterTool hooks and perform
 * any cleanup or reporting. The result is provided for inspection but
 * must not be mutated.
 */
export type PostExecutionFn = (
  invocation: AnyToolInvocation,
  request: ToolCallRequestInfo,
  tool: AnyDeclarativeTool,
  result: ToolResult,
) => Promise<void>;

/**
 * Optional failure hook callback.
 *
 * Called when execution throws or returns an error, giving hooks a chance
 * to recover (return a ToolResult) or enhance the error message.
 */
export type FailureHookFn = (
  toolName: string,
  error: Error,
  toolInput: Record<string, unknown>,
) => Promise<PostToolUseFailureHookResult | undefined>;

/** Configuration for runToolUseLifecycle(). */
export interface ToolUseLifecycleOptions {
  /** The built tool invocation. */
  readonly invocation: AnyToolInvocation;
  /** The original tool call request info. */
  readonly request: ToolCallRequestInfo;
  /** The resolved tool definition. */
  readonly tool: AnyDeclarativeTool;
  /** Per-tool abort signal. */
  readonly signal: AbortSignal;
  /** Actual execution function — delegates to executeToolWithHooks or equivalent. */
  readonly execute: ExecuteFn;
  /**
   * Optional pre-execution gate (hooks, policy, confirmation).
   * If omitted, execution proceeds unconditionally.
   */
  readonly preExecutionGate?: PreExecutionGateFn;
  /**
   * Optional post-execution callback (after-hooks, diagnostics).
   * If omitted, no post-processing is performed.
   */
  readonly postExecution?: PostExecutionFn;
  /**
   * Optional failure hook (PostToolUseFailure).
   * Called when execution throws, enabling error recovery or enhancement.
   * If omitted, errors pass through unchanged.
   */
  readonly failureHook?: FailureHookFn;
  /**
   * Optional ToolUseContext forwarded to the pre-execution gate.
   * Carries skill permission overlays and other query-scoped state.
   */
  readonly toolUseContext?: import('./tool-types.js').ToolUseContext;
}

/** Result of the lifecycle pipeline. */
export interface ToolUseLifecycleResult {
  /** The raw ToolResult, or undefined if execution was blocked/cancelled. */
  readonly result: ToolResult | undefined;
  /** Error if the pipeline failed at any stage. */
  readonly error: Error | undefined;
  /** Whether the call ended by cancellation rather than a permission denial. */
  readonly cancelled: boolean;
  /** Invocation that was actually executed, after any pre-gate arg rewrite. */
  readonly invocation?: AnyToolInvocation;
  /**
   * Which stage produced the outcome:
   * - `'validation'` — A runtime precondition failed before permission checks.
   * - `'pre-gate'` — Blocked by hooks, policy, or user confirmation.
   * - `'build'` — Rebuilding the invocation after a pre-gate arg rewrite failed.
   * - `'execution'` — Produced by the execute callback.
   * - `'post-hook'` — After-hook failed (result is still available).
   * - `'abort'` — Cancelled by abort signal before execution started.
   */
  readonly stage:
    | 'validation'
    | 'pre-gate'
    | 'build'
    | 'execution'
    | 'post-hook'
    | 'abort';
  /** Pre-gate terminal status when the gate blocked execution. */
  readonly preExecutionStatus?: Exclude<
    PreExecutionOutcome['status'],
    'proceed'
  >;
  /** Error type supplied by policy/hook gates. */
  readonly errorType?: import('./tool-error.js').ToolErrorType;
  /** PermissionDenied hook requested that the model may retry this denied tool. */
  readonly permissionDeniedHookRetry?: boolean;
  /** Stable permission denial status produced by the pre-execution gate. */
  readonly toolDenialKind?: ToolDenialKind;
  /** 原始用户拒绝反馈；不得从工具结果或错误文案推断。 */
  readonly userFeedback?: string;
  /** Structured permission reason metadata produced by the pre-execution gate. */
  readonly decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
  readonly decisionReason?: string;
  /** Additional contexts from PostToolUseFailure hooks. */
  readonly failureAdditionalContexts?: string[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full lifecycle for a single tool invocation.
 *
 * This is the composable, pure-function pipeline that the STE's
 * `executeTool` callback should delegate to.
 *
 * @returns A ToolResult on success, or an error/cancellation result.
 */
export async function runToolUseLifecycle(
  options: ToolUseLifecycleOptions,
): Promise<ToolUseLifecycleResult> {
  const {
    invocation,
    request,
    tool,
    signal,
    execute,
    preExecutionGate,
    postExecution,
    failureHook,
  } = options;
  let effectiveInvocation = invocation;

  // -----------------------------------------------------------------------
  // 0. Abort check
  // -----------------------------------------------------------------------
  if (signal.aborted) {
    runLogger.debug(`[ToolLifecycle] "${tool.name}" aborted before start`);
    return {
      result: undefined,
      error: new Error('Operation cancelled'),
      cancelled: true,
      stage: 'abort',
      invocation: effectiveInvocation,
      toolDenialKind: 'cancelled',
    };
  }

  // -----------------------------------------------------------------------
  // 1. Runtime validation (before hooks, policy, confirmation)
  // -----------------------------------------------------------------------
  if (effectiveInvocation.validateBeforePermission) {
    try {
      const validationResult = await effectiveInvocation.validateBeforePermission({
        ...options.toolUseContext,
        signal,
        callId: request.callId,
      });
      if (validationResult) {
        const error = new Error(
          validationResult.error?.message ?? 'Tool validation failed',
        );
        runLogger.debug(
          `[ToolLifecycle] "${tool.name}" runtime validation failed: ${error.message}`,
        );
        return {
          result: validationResult,
          error,
          cancelled: false,
          stage: 'validation',
          invocation: effectiveInvocation,
        };
      }
    } catch (validationError) {
      const error = toError(validationError);
      const cancelled = isCancelledError(validationError, signal);
      runLogger.warn(
        `[ToolLifecycle] "${tool.name}" runtime validation threw: ${error.message}`,
      );
      return {
        result: undefined,
        error,
        cancelled,
        stage: 'validation',
        invocation: effectiveInvocation,
        ...(cancelled ? { toolDenialKind: 'cancelled' as const } : {}),
      };
    }
  }

  // -----------------------------------------------------------------------
  // 2. Pre-execution gate (hooks, policy, confirmation)
  // -----------------------------------------------------------------------
  if (preExecutionGate) {
    try {
      const gateOutcome = await preExecutionGate(
        effectiveInvocation,
        request,
        tool,
        signal,
        options.toolUseContext,
      );

      // PermissionRequest { interrupt: true } both denies this tool and aborts
      // the turn. Preserve that specific denial instead of rendering it as a
      // generic user cancellation; other outcomes keep the existing behavior.
      if (signal.aborted && gateOutcome.status !== 'denied') {
        return {
          result: undefined,
          error: new Error('Operation cancelled'),
          cancelled: true,
          stage: 'abort',
          invocation: effectiveInvocation,
          toolDenialKind: 'cancelled',
        };
      }

      switch (gateOutcome.status) {
        case 'proceed':
          // Continue to execution. Args may have been modified by hooks.
          if (gateOutcome.modifiedArgs) {
            try {
              request.args = gateOutcome.modifiedArgs;
              effectiveInvocation = tool.build(gateOutcome.modifiedArgs, options.toolUseContext);
            } catch (buildError) {
              const error = toError(buildError);
              runLogger.warn(
                `[ToolLifecycle] "${tool.name}" rebuild after pre-gate failed: ${error.message}`,
              );
              return {
                result: undefined,
                error,
                cancelled: false,
                stage: 'build',
              };
            }
          }
          runLogger.debug(`[ToolLifecycle] "${tool.name}" pre-gate: proceed`);
          break;
        case 'denied':
          runLogger.debug(
            `[ToolLifecycle] "${tool.name}" pre-gate: denied — ${gateOutcome.error.message}`,
          );
          return {
            result: undefined,
            error: gateOutcome.error,
            cancelled: false,
            stage: 'pre-gate',
            invocation: effectiveInvocation,
            preExecutionStatus: gateOutcome.status,
            errorType: gateOutcome.errorType,
            permissionDeniedHookRetry: gateOutcome.permissionDeniedHookRetry,
            toolDenialKind: gateOutcome.toolDenialKind,
            userFeedback: gateOutcome.userFeedback,
            decisionReasonType: gateOutcome.decisionReasonType,
            decisionReason: gateOutcome.decisionReason,
          };
        case 'cancelled':
          runLogger.debug(
            `[ToolLifecycle] "${tool.name}" pre-gate: cancelled — ${gateOutcome.error.message}`,
          );
          return {
            result: undefined,
            error: gateOutcome.error,
            cancelled: true,
            stage: 'pre-gate',
            invocation: effectiveInvocation,
            preExecutionStatus: gateOutcome.status,
            toolDenialKind: gateOutcome.toolDenialKind,
            userFeedback: gateOutcome.userFeedback,
            decisionReasonType: gateOutcome.decisionReasonType,
            decisionReason: gateOutcome.decisionReason,
          };
        case 'hook-error':
          runLogger.warn(
            `[ToolLifecycle] "${tool.name}" pre-gate: hook-error — ${gateOutcome.error.message}`,
          );
          return {
            result: undefined,
            error: gateOutcome.error,
            cancelled: false,
            stage: 'pre-gate',
            invocation: effectiveInvocation,
            preExecutionStatus: gateOutcome.status,
          };
        default:
          // Exhaustiveness check for future gate outcome additions
          break;
      }
    } catch (gateError) {
      // If the gate itself throws, treat as a pre-gate error
      runLogger.warn(
        `[ToolLifecycle] "${tool.name}" pre-gate threw: ${toError(gateError).message}`,
      );
      return {
        result: undefined,
        error: toError(gateError),
        cancelled: signal.aborted,
        stage: 'pre-gate',
        invocation: effectiveInvocation,
        ...(signal.aborted ? { toolDenialKind: 'cancelled' as const } : {}),
      };
    }
  }

  // -----------------------------------------------------------------------
  // 3. Execute
  // -----------------------------------------------------------------------
  let toolResult: ToolResult;
  let recoveredAdditionalContexts: string[] | undefined;
  const execStartMs = Date.now();
  try {
    toolResult = await execute(effectiveInvocation, signal);
    runLogger.debug(
      `[ToolLifecycle] "${tool.name}" executed in ${Date.now() - execStartMs}ms`,
    );
  } catch (execError) {
    const cancelled = isCancelledError(execError, signal);
    const execErr = toError(execError);
    runLogger.warn(
      `[ToolLifecycle] "${tool.name}" execution failed (${Date.now() - execStartMs}ms, cancelled=${cancelled}): ${execErr.message}`,
    );

    // --- Failure hook (PostToolUseFailure) ---
    if (!cancelled && failureHook) {
      const toolInput = (effectiveInvocation.params || {}) as Record<
        string,
        unknown
      >;
      const failureResult = await handlePostToolUseFailure(
        tool.name,
        execErr,
        toolInput,
        failureHook,
      );
      const applied = applyFailureHookResult(failureResult, execErr);
      if (applied.recovered) {
        // Hook fully recovered — treat as successful execution
        runLogger.debug(
          `[ToolLifecycle] "${tool.name}" failure-hook recovered execution error`,
        );
        toolResult = applied.result;
        recoveredAdditionalContexts = applied.additionalContexts;
        // Fall through to post-execution and success path below
      } else {
        return {
          result: undefined,
          error: applied.error,
          cancelled: false,
          stage: 'execution',
          invocation: effectiveInvocation,
          failureAdditionalContexts: applied.additionalContexts,
        };
      }
    } else {
      return {
        result: undefined,
        error: execErr,
        cancelled,
        stage: 'execution',
        invocation: effectiveInvocation,
        ...(cancelled ? { toolDenialKind: 'interrupted' as const } : {}),
      };
    }
  }

  // Check abort after execution
  if (signal.aborted) {
    return {
      result: toolResult,
      error: new Error('Operation cancelled during execution'),
      cancelled: true,
      stage: 'execution',
      invocation: effectiveInvocation,
      toolDenialKind: 'interrupted',
    };
  }

  // -----------------------------------------------------------------------
  // 4. Post-execution callback (after-hooks, diagnostics)
  // -----------------------------------------------------------------------
  if (postExecution) {
    try {
      await postExecution(effectiveInvocation, request, tool, toolResult);
    } catch (postError) {
      // Post-hook failure does not invalidate the result, but we report it.
      runLogger.warn(
        `[ToolLifecycle] "${tool.name}" post-hook failed: ${toError(postError).message}`,
      );
      return {
        result: toolResult,
        error: toError(postError),
        cancelled: false,
        stage: 'post-hook',
        invocation: effectiveInvocation,
      };
    }
  }

  // -----------------------------------------------------------------------
  // 5. Success
  // -----------------------------------------------------------------------
  return {
    result: toolResult,
    error: toolResult.error ? new Error(toolResult.error.message) : undefined,
    cancelled: false,
    stage: 'execution',
    invocation: effectiveInvocation,
    failureAdditionalContexts: recoveredAdditionalContexts,
  };
}

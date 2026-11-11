/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Online scheduler for streaming tool execution.
 *
 * State: queued → executing → completed → yielded.
 * Streaming adds start execution as concurrency allows: read-only tools may
 * overlap, mutating tools are exclusive barriers. Each tool has its own abort
 * controller linked to the parent signal; only unsafe tools may update shared
 * context, after their exclusive execution completes.
 */

import {
  createChildAbortController,
  toError,
  isCancelledError,
} from './abort-utils.js';
import { Stream } from '../utils/stream.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
  ToolResult,
} from './tools.js';
import type {
  ToolCallRequestInfo,
  ToolSettlement,
} from '../tool-executor/types.js';
import {
  runToolUseLifecycle,
  type PreExecutionGateFn,
} from './tool-execution-lifecycle.js';
import { ToolErrorType } from './tool-error.js';
import { isToolResultFailure } from './tool-result-utils.js';
import {
  createUnknownBuildDiagnosticData,
  getToolParameterDiagnosticData,
} from './tool-parameter-diagnostics.js';
import type { ToolResultMessage } from './tool-result-message.js';
import {
  ToolUseResultBuilder,
  partListUnionToContent,
} from './tool-use-result-builder.js';
import type { ToolUseContext } from './tool-types.js';
import { runLogger } from '../utils/runLogger.js';
import { PERMISSION_DENIED_HOOK_RETRY_MESSAGE } from '../protocol/schemas/common.js';



import type { ToolDenialKind } from '../protocol/schemas/common.js';
import type { ToolPermissionDecision } from '../protocol/schemas/common.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four states a tracked tool passes through.
 *
 * These are intentionally distinct from `CoreToolCallStatus` (Scheduler's
 * seven-state model). The STE collapses Validating/AwaitingApproval/Scheduled
 * into the `executing` phase via the `preExecutionGate` callback. The bridge
 * layer (`ste-bridge.ts`) maps between these states and CoreToolCallStatus
 * for UI rendering via ToolCallStateManager.
 */
export type TrackedToolStatus =
  | 'queued'
  | 'executing'
  | 'completed'
  | 'yielded';

/**
 * Result produced by the STE for each tool execution.
 * Intentionally minimal — the caller (Scheduler) converts this to its own
 * CompletedToolCall types.
 */
export interface ToolExecutionResult {
  settlement?: ToolSettlement;
  /** The request that was executed. */
  readonly request: ToolCallRequestInfo;
  /** The tool definition used, or undefined if unknown tool. */
  readonly tool: AnyDeclarativeTool | undefined;
  /** The invocation used for execution, if successfully built. */
  readonly invocation: AnyToolInvocation | undefined;
  /** The raw ToolResult from invocation.execute(), or undefined on error/cancel. */
  readonly result: ToolResult | undefined;
  /** Error if execution failed. */
  readonly error: Error | undefined;
  /** Whether the tool was cancelled (abort signal). */
  readonly cancelled: boolean;
  /** Duration in ms from start to completion. */
  readonly durationMs: number;

  /**
   * Ordered messages for conversation history injection.
   * Produced by ToolUseResultBuilder, carrying tool_result + hook context +
   * newMessages + stop messages in deterministic order.
   *
   * When undefined, the consumer falls back to constructing a single
   * tool_result from `result.llmContent` (backward compatible).
   */
  readonly resultMessages?: ToolResultMessage[];
  /** Stable permission denial status, when execution stopped at the gate. */
  readonly toolDenialKind?: ToolDenialKind;
  /** 原始用户拒绝反馈；仅由权限交互边界提供。 */
  readonly userFeedback?: string;
  /** Structured permission reason metadata, when execution stopped at the gate. */
  readonly decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
  readonly decisionReason?: string;
}

/** Internal tracking structure for each tool in the STE. */
interface TrackedTool {
  invocationStarted?: boolean;
  invocationSettled?: boolean;
  readonly index: number;
  readonly request: ToolCallRequestInfo;
  readonly tool: AnyDeclarativeTool | undefined;
  /** Cached once from the original schema-valid input when the call arrives. */
  readonly concurrencySafe: boolean;
  status: TrackedToolStatus;
  invocation: AnyToolInvocation | undefined;
  executionResult: ToolExecutionResult | undefined;
  /**
   * Anchors the async execution promise so it is not garbage-collected.
   * Results are consumed via `completionStream`, not by awaiting this.
   */
  completionPromise: Promise<void> | undefined;
  /** Child abort controller for this specific tool. */
  childAbortController: AbortController | undefined;
  childAbortCleanup: (() => void) | undefined;
  startedAtMonotonic: number | undefined;
}

function createInvalidToolParamsResult(
  error: Error,
  sourceError: unknown,
): ToolResult {
  const diagnosticData =
    getToolParameterDiagnosticData(sourceError) ??
    createUnknownBuildDiagnosticData();
  return {
    llmContent: error.message,
    returnDisplay: error.message,
    error: {
      type: ToolErrorType.INVALID_TOOL_PARAMS,
      message: error.message,
    },
    data: diagnosticData,
  };
}

/** Classify the original input once. Invalid input fails closed. */
function determineToolConcurrencySafety(
  tool: AnyDeclarativeTool | undefined,
  args: ToolCallRequestInfo['args'],
): boolean {
  // Unknown tools complete immediately and must not become a FIFO barrier.
  if (!tool) return true;
  try {
    // AJV may coerce values while validating. Classify the parsed snapshot,
    // but leave the request's original args untouched for the normal build.
    const parsedArgs = structuredClone(args);
    if (
      SchemaValidator.validate(tool.schema.parametersJsonSchema, parsedArgs)
    ) {
      return false;
    }
    return Boolean(
      tool.isConcurrencySafe(
        parsedArgs as Parameters<typeof tool.isConcurrencySafe>[0],
      ),
    );
  } catch {
    return false;
  }
}

/** Callback invoked when a tracked tool's status changes. */
export type StatusChangeCallback = (
  request: ToolCallRequestInfo,
  status: TrackedToolStatus,
  tool: AnyDeclarativeTool | undefined,
) => void;

/** Configuration for StreamingToolExecutor. */
export interface StreamingToolExecutorOptions {
  /** Parent abort signal — child controllers are linked to this. */
  parentSignal: AbortSignal;
  /**
   * Resolves tool name to its DeclarativeTool definition.
   * Typically backed by `ToolRegistry.getTool()`.
   */
  resolveTool: (name: string) => AnyDeclarativeTool | undefined;
  /**
   * Executes a single tool invocation. The STE delegates actual execution
   * to this callback so the caller can inject hooks, diagnostics, etc.
   *
   * The callback receives:
   * - `invocation`: the built ToolInvocation
   * - `request`: the original request info
   * - `tool`: the resolved DeclarativeTool
   * - `signal`: per-tool AbortSignal (child of parentSignal)
   *
   * Returns a ToolResult (success or error embedded in the result).
   * Throws on unhandled errors or abort.
   */
  executeTool: (
    invocation: AnyToolInvocation,
    request: ToolCallRequestInfo,
    tool: AnyDeclarativeTool,
    signal: AbortSignal,
    toolUseContext?: ToolUseContext,
  ) => Promise<ToolResult>;
  /**
   * Optional pre-execution gate. Called after building the invocation but
   * before `executeTool`. Implements hook evaluation, policy checks, and
   * user confirmation. If omitted, execution proceeds unconditionally.
   */
  preExecutionGate?: PreExecutionGateFn;
  /** Optional callback fired on status transitions. */
  onStatusChange?: StatusChangeCallback;
  /**
   * Optional notification fired the moment a tool transitions to 'completed'.
   *
   * This callback runs inside markCompleted(), before completionStream.enqueue()
   * and before tryStartQueued(). Keep implementations synchronous and short:
   * slow work here delays queued tools and result consumers. Do not
   * perform I/O or await heavy work; defer expensive follow-up yourself.
   */
  onToolCompleted?: (result: ToolExecutionResult) => void;
  /**
   * Initial ToolUseContext. Context modifiers from completed unsafe tools may
   * update this state. When omitted, a minimal context is constructed from
   * `parentSignal`.
   */
  initialContext?: ToolUseContext;
  /** Keep terminal results in request order for integration consumers. */
  preserveSubmissionOrder?: boolean;
  /** Maximum executing calls, including calls waiting for permission. */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// StreamingToolExecutor
// ---------------------------------------------------------------------------

export class StreamingToolExecutor {
  private readonly trackedTools: TrackedTool[] = [];
  private sealed = false;
  private stopped = false;
  private readonly maxConcurrency: number;
  /** O(1) counter for tools in 'queued' state. */
  private queuedCount = 0;
  /** O(1) counter for tools in 'executing' state. */
  private executingCount = 0;
  /** O(1) counter for tools in terminal states ('completed' or 'yielded'). */
  private terminalCount = 0;

  private readonly parentSignal: AbortSignal;
  private readonly preserveSubmissionOrder: boolean;
  private readonly resolveTool: (
    name: string,
  ) => AnyDeclarativeTool | undefined;
  private readonly executeTool: StreamingToolExecutorOptions['executeTool'];
  private readonly preExecutionGate: PreExecutionGateFn | undefined;
  private readonly onStatusChange: StatusChangeCallback | undefined;
  private readonly onToolCompleted:
    | ((result: ToolExecutionResult) => void)
    | undefined;

  /** Mutable ToolUseContext updated by completed unsafe tools. */
  private toolUseContext: ToolUseContext;

  /**
   * Stream used by `getRemainingResults()` to bridge the push-based
   * completion events into a pull-based async iterable.
   */
  private readonly completionStream = new Stream<void>();

  constructor(options: StreamingToolExecutorOptions) {
    if (
      options.maxConcurrency !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrency) ||
        options.maxConcurrency < 1)
    ) {
      throw new RangeError('maxConcurrency must be a positive safe integer');
    }
    this.maxConcurrency = options.maxConcurrency ?? Infinity;
    this.parentSignal = options.parentSignal;
    this.preserveSubmissionOrder = options.preserveSubmissionOrder ?? false;
    this.resolveTool = options.resolveTool;
    this.executeTool = options.executeTool;
    this.preExecutionGate = options.preExecutionGate;
    this.onStatusChange = options.onStatusChange;
    this.onToolCompleted = options.onToolCompleted;
    this.toolUseContext = options.initialContext ?? {
      signal: options.parentSignal,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Number of tracked tools. */
  get size(): number {
    return this.trackedTools.length;
  }

  /** Current queue depth, exposed for scheduler-level queue stats. */
  get queuedSize(): number {
    return this.queuedCount;
  }

  /** Current execution concurrency, exposed for queue stats. */
  get runningSize(): number {
    return this.executingCount;
  }

  /** Whether all tools have been yielded or the executor is empty. */
  get isDrained(): boolean {
    return (
      this.sealed &&
      this.trackedTools.every((tool) => tool.status === 'yielded')
    );
  }

  /**
   * Add a tool call request. The tool is resolved, validated, and queued.
   * If concurrency rules permit, execution starts immediately.
   *
   * Must not be called after {@link seal}.
   */
  addTool(request: ToolCallRequestInfo): void {
    if (this.sealed) {
      throw new Error('Cannot add tools after seal()');
    }
    if (this.stopped) {
      throw new Error('Cannot add tools after cancelAll()');
    }

    const tool = this.resolveTool(request.name);
    const concurrencySafe = determineToolConcurrencySafety(tool, request.args);

    const tracked: TrackedTool = {
      index: this.trackedTools.length,
      request,
      tool,
      concurrencySafe,
      status: 'queued',
      invocation: undefined,
      executionResult: undefined,
      completionPromise: undefined,
      childAbortController: undefined,
      childAbortCleanup: undefined,
      startedAtMonotonic: undefined,
    };

    this.trackedTools.push(tracked);
    this.queuedCount++;
    this.notifyStatusChange(tracked, 'queued');

    this.tryStartQueued();
  }

  /**
   * Signal that no more tools will be added.
   * This allows `getRemainingResults()` to know when to terminate.
   */
  seal(): void {
    this.sealed = true;
    // If all tools already finished (before seal was called), signal the stream.
    // We check allCompleted() rather than isDrained because tools may be
    // 'completed' but not yet 'yielded' at this point — the consumer hasn't
    // started pulling results yet.
    if (this.allCompleted()) {
      this.completionStream.done();
    }
  }

  /** Yield every currently completed result, stopping at an unsafe execution. */
  *getCompletedResults(): Generator<ToolExecutionResult> {
    for (const tracked of this.trackedTools) {
      if (tracked.status === 'yielded') continue;
      if (tracked.status === 'completed') {
        tracked.status = 'yielded';
        this.notifyStatusChange(tracked, 'yielded');
        yield tracked.executionResult!;
      } else if (
        this.preserveSubmissionOrder ||
        (tracked.status === 'executing' && !tracked.concurrencySafe)
      ) {
        break;
      }
    }
  }

  /**
   * Async generator that yields results as concurrency barriers permit,
   * waiting for executing tools to complete as needed. It may start before
   * {@link seal}; sealing is still required for the generator to terminate.
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecutionResult> {
    // First, yield anything already completed
    yield* this.getCompletedResults();

    // Then wait for more completions
    for await (const _ of this.completionStream) {
      yield* this.getCompletedResults();
    }

    // Final sweep — in case completions arrived between the last
    // stream event and the stream.done() call
    yield* this.getCompletedResults();
  }

  /**
   * Cancel all non-terminal tools.
   */
  cancelAll(
    reason = 'Operation cancelled',
    options?: { skipCallIds?: ReadonlySet<string> },
  ): void {
    // markCompleted re-enters scheduling. Close admission before completing any
    // queued call, including when cancellation originates in a completion hook.
    this.stopped = true;
    const skipCallIds = options?.skipCallIds;
    for (const tracked of this.trackedTools) {
      if (skipCallIds?.has(tracked.request.callId)) {
        continue;
      }

      if (tracked.status === 'queued') {
        this.markCompleted(tracked, {
          request: tracked.request,
          tool: tracked.tool,
          invocation: undefined,
          result: undefined,
          error: new Error(reason),
          cancelled: true,
          durationMs: 0,
          toolDenialKind: 'cancelled',
        });
      } else if (tracked.status === 'executing') {
        // Abort the child — the execution promise will handle the rest
        tracked.childAbortController?.abort(reason);
      }
    }
  }

  /** Expose current ToolUseContext for consumers (e.g., Scheduler). */
  get currentContext(): ToolUseContext {
    return this.toolUseContext;
  }

  // -----------------------------------------------------------------------
  // Private — concurrency control
  // -----------------------------------------------------------------------

  /**
   * Determines whether a queued tool can start executing.
   *
   * Rules:
   * 1. If no tools are currently executing, always yes.
   * 2. If the candidate tool is NOT concurrency-safe, no.
   * 3. If ALL currently executing tools are concurrency-safe AND the
   *    candidate is concurrency-safe, yes.
   */
  private canExecute(tracked: TrackedTool): boolean {
    if (
      this.stopped ||
      this.executingCount >= this.maxConcurrency
    ) {
      return false;
    }
    if (this.executingCount === 0) {
      return true;
    }

    if (!tracked.concurrencySafe) {
      return false;
    }

    // Must still scan executing tools to check their safety — but only when
    // we already know there are executing tools (executingCount > 0).
    return this.trackedTools.every((e) => {
      if (e.status !== 'executing') return true;
      return e.concurrencySafe;
    });
  }

  /**
   * Scan queued tools and start any that pass `canExecute()`.
   *
   * A blocked unsafe tool stops the scan and forms a FIFO barrier. Safe tools
   * are considered independently and may start together.
   */
  private tryStartQueued(): void {
    if (this.parentSignal.aborted || this.stopped) {
      // Do not recurse through cancelAll while it is already marking results.
      if (!this.stopped) this.cancelAll();
      return;
    }
    for (const tracked of this.trackedTools) {
      if (this.stopped || this.parentSignal.aborted) break;
      if (tracked.status !== 'queued') continue;
      if (this.canExecute(tracked)) this.startExecution(tracked);
      else if (!tracked.concurrencySafe) break;
    }
  }

  // -----------------------------------------------------------------------
  // Private — execution
  // -----------------------------------------------------------------------

  private startExecution(tracked: TrackedTool): void {
    this.queuedCount--;
    tracked.status = 'executing';
    tracked.startedAtMonotonic = performance.now();
    this.executingCount++;

    // Create per-tool abort controller
    const { controller, cleanup } = createChildAbortController(
      this.parentSignal,
    );
    tracked.childAbortController = controller;
    tracked.childAbortCleanup = cleanup;

    this.notifyStatusChange(tracked, 'executing');

    tracked.completionPromise = this.executeTracked(tracked);
  }

  private async executeTracked(tracked: TrackedTool): Promise<void> {
    await this.executeTrackedInSpan(tracked);
  }

  private async executeTrackedInSpan(tracked: TrackedTool): Promise<void> {
    const signal = tracked.childAbortController!.signal;
    const startedAtMonotonic = tracked.startedAtMonotonic!;

    try {
      // If tool is undefined (unresolved), produce an error result
      if (!tracked.tool) {
        const error = new Error(`Tool "${tracked.request.name}" not found.`);
        this.markCompleted(tracked, {
          request: tracked.request,
          tool: undefined,
          invocation: undefined,
          result: undefined,
          error,
          cancelled: false,
          durationMs: Math.round(performance.now() - startedAtMonotonic),
        });
        return;
      }


      // Build invocation (validate params)
      let invocation: AnyToolInvocation;
      try {
        invocation = tracked.tool.build(
          tracked.request.args,
          this.toolUseContext,
        );
        tracked.invocation = invocation;
      } catch (buildError) {
        const error = toError(buildError);
        const result = createInvalidToolParamsResult(error, buildError);
        this.markCompleted(tracked, {
          request: tracked.request,
          tool: tracked.tool,
          invocation: undefined,
          result,
          error,
          cancelled: false,
          durationMs: Math.round(performance.now() - startedAtMonotonic),
        });
        return;
      }

      // Check abort before starting
      if (signal.aborted) {
        const error = new Error('Operation cancelled');
        this.markCompleted(tracked, {
          request: tracked.request,
          tool: tracked.tool,
          invocation,
          result: undefined,
          error,
          cancelled: true,
          durationMs: Math.round(performance.now() - startedAtMonotonic),
          toolDenialKind: 'cancelled',
        });
        return;
      }

      const lifecycleResult = await runToolUseLifecycle({
        invocation,
        request: tracked.request,
        tool: tracked.tool!,
        signal,
        execute: async (effectiveInvocation, execSignal) => {
          tracked.invocationStarted = true;
          try {
            return await this.executeTool(
              effectiveInvocation,
              tracked.request,
              tracked.tool!,
              execSignal,
              this.toolUseContext,
            );
          } finally {
            tracked.invocationSettled = true;
          }
        },
        preExecutionGate: this.preExecutionGate,
        toolUseContext: this.toolUseContext,
      });

      if (lifecycleResult.invocation) {
        invocation = lifecycleResult.invocation;
        tracked.invocation = invocation;
      }

      if (!lifecycleResult.result) {
        const error =
          lifecycleResult.error ?? new Error('Tool execution failed');
        const isGateBlocked =
          lifecycleResult.preExecutionStatus === 'denied' ||
          lifecycleResult.preExecutionStatus === 'hook-error';

        const blockedResult: ToolResult | undefined = isGateBlocked
          ? {
              llmContent: error.message,
              returnDisplay: error.message,
              error: {
                type:
                  lifecycleResult.errorType ?? ToolErrorType.EXECUTION_FAILED,
                message: error.message,
              },
              ...(lifecycleResult.permissionDeniedHookRetry
                ? {
                    newMessages: [
                      {
                        role: 'user' as const,
                        content: PERMISSION_DENIED_HOOK_RETRY_MESSAGE,
                        isMeta: true,
                      },
                    ],
                  }
                : {}),
            }
          : lifecycleResult.stage === 'build'
            ? createInvalidToolParamsResult(error, lifecycleResult.error)
            : lifecycleResult.stage === 'validation'
              ? lifecycleResult.result
              : undefined;
        const blockedResultMessages = blockedResult
          ? new ToolUseResultBuilder(
              tracked.request.callId,
              tracked.request.name,
            )
              .addToolResult(
                partListUnionToContent(blockedResult.llmContent),
                !!blockedResult.error,
              )
              .addNewMessages(blockedResult.newMessages)
              .build()
          : undefined;

        this.markCompleted(tracked, {
          request: tracked.request,
          tool: tracked.tool,
          invocation:
            lifecycleResult.stage === 'build' ? undefined : invocation,
          result: blockedResult,
          error,
          cancelled: lifecycleResult.cancelled,
          durationMs: Math.round(performance.now() - startedAtMonotonic),
          resultMessages: blockedResultMessages,
          toolDenialKind: lifecycleResult.toolDenialKind,
          userFeedback: lifecycleResult.userFeedback,
          decisionReasonType: lifecycleResult.decisionReasonType,
          decisionReason: lifecycleResult.decisionReason,
        });
        return;
      }

      const result = lifecycleResult.result;
      const cancelled = lifecycleResult.cancelled;
      const failed = isToolResultFailure(result);

      // Build resultMessages via ToolUseResultBuilder
      const builder = new ToolUseResultBuilder(
        tracked.request.callId,
        tracked.request.name,
      );
      builder.addToolResult(
        partListUnionToContent(result.llmContent),
        failed,
        result.contextModifier,
      );
      builder.addNewMessages(result.newMessages);
      if (result.endsTurn) {
        builder.addStop(`Tool ${tracked.request.name} requested end of turn`);
      }

      const builtMessages = builder.build();
      runLogger.log(
        `[STE] Tool "${tracked.request.name}" (callId=${tracked.request.callId}): ` +
          `newMessages=${result.newMessages?.length ?? 0}, ` +
          `contextModifier=${!!result.contextModifier}, ` +
          `endsTurn=${!!result.endsTurn}, ` +
          `resultMessages=${builtMessages.length} ` +
          `(types: ${builtMessages.map((m) => m.message.type).join(', ')})`,
      );

      this.markCompleted(tracked, {
        request: tracked.request,
        tool: tracked.tool,
        invocation,
        result,
        error: lifecycleResult.error,
        cancelled,
        durationMs: Math.round(performance.now() - startedAtMonotonic),
        resultMessages: builtMessages,
        toolDenialKind: lifecycleResult.toolDenialKind,
        userFeedback: lifecycleResult.userFeedback,
        decisionReasonType: lifecycleResult.decisionReasonType,
        decisionReason: lifecycleResult.decisionReason,
      });
    } catch (execError) {
      const cancelled = isCancelledError(execError, signal);
      const err = toError(execError);
      if (!cancelled) {
        runLogger.warn(
          `[STE] Tool "${tracked.request.name}" (callId=${tracked.request.callId}) execution threw: ${err.message}`,
        );
      }

      this.markCompleted(tracked, {
        request: tracked.request,
        tool: tracked.tool,
        invocation: tracked.invocation,
        result: undefined,
        error: err,
        cancelled,
        durationMs: Math.round(performance.now() - startedAtMonotonic),
        ...(cancelled ? { toolDenialKind: 'interrupted' as const } : {}),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Private — completion bookkeeping
  // -----------------------------------------------------------------------

  private markCompleted(
    tracked: TrackedTool,
    result: ToolExecutionResult,
  ): void {
    // Guard: only transition from queued or executing
    if (tracked.status !== 'queued' && tracked.status !== 'executing') {
      return;
    }

    if (tracked.status === 'queued') {
      this.queuedCount--;
    } else if (tracked.status === 'executing') {
      this.executingCount--;
    }
    result.settlement = !tracked.invocationStarted
      ? 'not_started'
      : tracked.invocationSettled && !result.cancelled
        ? 'completed'
        : 'unknown';
    tracked.status = 'completed';
    tracked.executionResult = result;
    this.terminalCount++;
    this.notifyStatusChange(tracked, 'completed');

    // Clean up child abort controller
    tracked.childAbortCleanup?.();
    tracked.childAbortCleanup = undefined;

    // Shared context is mutable only behind an exclusive unsafe barrier.
    if (result.result?.contextModifier && !tracked.concurrencySafe) {
      try {
        this.toolUseContext = result.result.contextModifier(
          this.toolUseContext,
        );
      } catch (error) {
        runLogger.warn(
          `[STE] contextModifier failed for "${tracked.request.name}" (callId=${tracked.request.callId}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      this.onToolCompleted?.(result);
    } catch (error) {
      runLogger.warn(
        `[STE] onToolCompleted callback failed for "${tracked.request.name}" (callId=${tracked.request.callId}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Notify the completion stream so getRemainingResults() can make progress
    // Using void 0 to satisfy Stream<void> type - the value is not used, just the signal

    this.completionStream.enqueue(void 0 as unknown as void);

    // Now that a slot freed up, try starting queued tools
    this.tryStartQueued();

    // Check if we're fully drained
    if (this.sealed && this.allCompleted()) {
      this.completionStream.done();
    }
  }

  /** Check if all tracked tools are in a terminal state (completed or yielded). */
  private allCompleted(): boolean {
    return this.terminalCount >= this.trackedTools.length;
  }

  /** Status observers are notifications and must never control scheduling. */
  private notifyStatusChange(
    tracked: TrackedTool,
    status: TrackedToolStatus,
  ): void {
    try {
      this.onStatusChange?.(tracked.request, status, tracked.tool);
    } catch (error) {
      runLogger.warn(
        `[STE] onStatusChange callback failed for "${tracked.request.name}" (callId=${tracked.request.callId}, status=${status}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool-call lifecycle state and snapshot publishing.
 *
 * Tracks Validating → Scheduled → AwaitingApproval → Executing →
 * Success/Error/Cancelled and publishes snapshots for UI streaming.
 * Waiting calls carry `confirmationDetails` and a `correlationId` shared
 * with the CLI permission queue that resolves the user decision.
 */

import {
  CoreToolCallStatus,
  ROOT_TOOL_CALL_SCOPE_ID,
  type ToolCall,
  type Status,
  type WaitingToolCall,
  type CompletedToolCall,
  type SuccessfulToolCall,
  type ErroredToolCall,
  type CancelledToolCall,
  type ScheduledToolCall,
  type ValidatingToolCall,
  type ExecutingToolCall,
  type ToolCallResponseInfo,
} from './types.js';
import type {
  ToolConfirmationOutcome,
  ToolResultDisplay,
  ToolStatusResult,
  AnyToolInvocation,
  AnyDeclarativeTool,
} from '../tools/tools.js';
import { buildToolStatusResult } from '../tools/tools.js';
import type { SerializableConfirmationDetails } from '../tools/confirmation-details.js';
import {
  isToolCallResponseInfo,
  toToolStatusSummary,
} from '../utils/tool-utils.js';
import { getDiffStatFromPatch } from '../tools/diffOptions.js';
import type { ToolCallSnapshotPublisher } from './tool-call-snapshot.js';
import { REJECT_MESSAGE } from '../protocol/transcript/message-utils.js';
import { runLogger } from '../utils/runLogger.js';

/**
 * Handler for terminal tool calls.
 */
export type TerminalCallHandler = (call: CompletedToolCall) => void;

/**
 * Manages the state of tool calls.
 * Publishes state changes through ToolCallSnapshotPublisher.
 */
export class ToolCallStateManager {
  private readonly activeCalls = new Map<string, ToolCall>();
  private _completedBatch: CompletedToolCall[] = [];
  private readonly callOrder = new Map<string, number>();
  private nextCallOrder = 0;
  private readonly monotonicStarts = new Map<string, number>();

  constructor(
    private readonly toolCallSnapshots: ToolCallSnapshotPublisher,
    private readonly toolCallScopeId: string = ROOT_TOOL_CALL_SCOPE_ID,
    private readonly onTerminalCall?: TerminalCallHandler,
  ) {}

  getToolCall(callId: string): ToolCall | undefined {
    return (
      this.activeCalls.get(callId) ||
      this._completedBatch.find((c) => c.request.callId === callId)
    );
  }

  /**
   * Directly adds a tool call to activeCalls.
   * The STE manages its own concurrency, so there is no queue layer.
   */
  addActiveCall(call: ToolCall): void {
    if (!this.callOrder.has(call.request.callId)) {
      this.callOrder.set(call.request.callId, this.nextCallOrder++);
    }
    if (!this.monotonicStarts.has(call.request.callId)) {
      this.monotonicStarts.set(call.request.callId, performance.now());
    }
    this.activeCalls.set(call.request.callId, call);
    this.emitUpdate();
  }

  get isActive(): boolean {
    return this.activeCalls.size > 0;
  }

  get allActiveCalls(): ToolCall[] {
    return Array.from(this.activeCalls.values());
  }

  get activeCallCount(): number {
    return this.activeCalls.size;
  }

  get firstActiveCall(): ToolCall | undefined {
    return this.activeCalls.values().next().value;
  }

  /**
   * Updates the status of a tool call with specific auxiliary data required for certain states.
   */
  updateStatus(
    callId: string,
    status: CoreToolCallStatus.Success,
    data: ToolCallResponseInfo,
  ): void;
  updateStatus(
    callId: string,
    status: CoreToolCallStatus.Error,
    data: ToolCallResponseInfo,
  ): void;
  updateStatus(
    callId: string,
    status: CoreToolCallStatus.AwaitingApproval,
    data: {
      correlationId: string;
      confirmationDetails: SerializableConfirmationDetails;
    },
  ): void;
  updateStatus(
    callId: string,
    status: CoreToolCallStatus.Cancelled,
    data: string | ToolCallResponseInfo,
  ): void;
  updateStatus(
    callId: string,
    status: CoreToolCallStatus.Executing,
    data?: Partial<ExecutingToolCall>,
  ): void;
  updateStatus(
    callId: string,
    status: CoreToolCallStatus.Scheduled | CoreToolCallStatus.Validating,
  ): void;
  updateStatus(callId: string, status: Status, auxiliaryData?: unknown): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;
    // Completed calls can remain here until ordered result finalization. Late
    // output/PID updates must not restart their progress or heartbeat.
    if (this.isTerminalCall(call) && status === CoreToolCallStatus.Executing) {
      return;
    }

    const updatedCall = this.transitionCall(call, status, auxiliaryData);
    this.activeCalls.set(callId, updatedCall);

    this.emitUpdate();
  }

  finalizeCall(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    if (this.isTerminalCall(call)) {
      this._completedBatch.push(call);
      this.activeCalls.delete(callId);
      this.monotonicStarts.delete(callId);

      try {
        this.onTerminalCall?.(call);
      } catch (error) {
        runLogger.warn(
          '[ToolCallStateManager] terminal observer failed:',
          error,
        );
      }
      this.emitUpdate();
    }
  }

  updateArgs(
    callId: string,
    newArgs: Record<string, unknown>,
    newInvocation: AnyToolInvocation,
  ): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.status === CoreToolCallStatus.Error) return;

    this.activeCalls.set(
      callId,
      this.patchCall(call, {
        request: { ...call.request, args: newArgs },
        invocation: newInvocation,
      }),
    );
    this.emitUpdate();
  }

  setOutcome(callId: string, outcome: ToolConfirmationOutcome): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    this.activeCalls.set(callId, this.patchCall(call, { outcome }));
    this.emitUpdate();
  }

  getSnapshot(): ToolCall[] {
    return [
      ...this._completedBatch,
      ...Array.from(this.activeCalls.values()),
    ].sort(
      (a, b) =>
        (this.callOrder.get(a.request.callId) ?? Number.MAX_SAFE_INTEGER) -
        (this.callOrder.get(b.request.callId) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  clearBatch(): void {
    if (this._completedBatch.length === 0) return;
    for (const call of this._completedBatch) {
      this.callOrder.delete(call.request.callId);
    }
    this._completedBatch = [];
    this.resetCallOrderIfEmpty();
    this.emitUpdate();
  }

  /**
   * Clears all active calls. Used by the STE batch path to clean up
   * after the batch completes, since the STE manages its own lifecycle
   * and doesn't go through finalizeCall().
   */
  clearActiveCalls(): void {
    if (this.activeCalls.size === 0) return;
    for (const callId of this.activeCalls.keys()) {
      this.callOrder.delete(callId);
      this.monotonicStarts.delete(callId);
    }
    this.activeCalls.clear();
    this.resetCallOrderIfEmpty();
    this.emitUpdate();
  }

  /**
   * 按调用 ID 移除退场批次的状态，不制造新的工具终态。
   */
  removeCalls(callIds: ReadonlySet<string>): void {
    let changed = false;
    for (const callId of callIds) {
      let removed = this.activeCalls.delete(callId);
      const completedLength = this._completedBatch.length;
      this._completedBatch = this._completedBatch.filter(
        (call) => call.request.callId !== callId,
      );
      if (this._completedBatch.length !== completedLength) removed = true;
      if (!removed) continue;
      changed = true;
      this.callOrder.delete(callId);
      this.monotonicStarts.delete(callId);
    }
    if (!changed) return;
    this.resetCallOrderIfEmpty();
    this.emitUpdate();
  }

  get completedBatch(): CompletedToolCall[] {
    return [...this._completedBatch];
  }

  private emitUpdate() {
    const snapshot = this.getSnapshot();

    try {
      this.toolCallSnapshots.publishToolCallSnapshot({
        toolCalls: snapshot,
        toolCallScopeId: this.toolCallScopeId,
      });
    } catch (error) {
      runLogger.warn(
        '[ToolCallStateManager] snapshot observer failed:',
        error,
      );
    }
  }

  private resetCallOrderIfEmpty(): void {
    if (this.activeCalls.size === 0 && this._completedBatch.length === 0) {
      this.nextCallOrder = 0;
    }
  }

  private isTerminalCall(call: ToolCall): call is CompletedToolCall {
    const { status } = call;
    return (
      status === CoreToolCallStatus.Success ||
      status === CoreToolCallStatus.Error ||
      status === CoreToolCallStatus.Cancelled
    );
  }

  private transitionCall(
    call: ToolCall,
    newStatus: Status,
    auxiliaryData?: unknown,
  ): ToolCall {
    switch (newStatus) {
      case CoreToolCallStatus.Success: {
        if (!isToolCallResponseInfo(auxiliaryData)) {
          throw new Error(
            `Invalid data for 'success' transition (callId: ${call.request.callId})`,
          );
        }
        return this.toSuccess(call, auxiliaryData);
      }
      case CoreToolCallStatus.Error: {
        if (!isToolCallResponseInfo(auxiliaryData)) {
          throw new Error(
            `Invalid data for 'error' transition (callId: ${call.request.callId})`,
          );
        }
        return this.toError(call, auxiliaryData);
      }
      case CoreToolCallStatus.AwaitingApproval: {
        if (
          !auxiliaryData ||
          typeof auxiliaryData !== 'object' ||
          !('correlationId' in auxiliaryData) ||
          !('confirmationDetails' in auxiliaryData)
        ) {
          throw new Error(
            `Invalid data for 'awaiting_approval' transition (callId: ${call.request.callId})`,
          );
        }
        return this.toAwaitingApproval(
          call,
          auxiliaryData as {
            correlationId: string;
            confirmationDetails: SerializableConfirmationDetails;
          },
        );
      }
      case CoreToolCallStatus.Scheduled:
        return this.toScheduled(call);
      case CoreToolCallStatus.Cancelled: {
        if (
          typeof auxiliaryData !== 'string' &&
          !isToolCallResponseInfo(auxiliaryData)
        ) {
          throw new Error(
            `Invalid reason (string) or response for 'cancelled' transition (callId: ${call.request.callId})`,
          );
        }
        return this.toCancelled(call, auxiliaryData);
      }
      case CoreToolCallStatus.Validating:
        return this.toValidating(call);
      case CoreToolCallStatus.Executing: {
        if (
          auxiliaryData !== undefined &&
          !this.isExecutingToolCallPatch(auxiliaryData)
        ) {
          throw new Error(
            `Invalid patch for 'executing' transition (callId: ${call.request.callId})`,
          );
        }
        return this.toExecuting(call, auxiliaryData);
      }
      default: {
        const exhaustiveCheck: never = newStatus;
        return exhaustiveCheck;
      }
    }
  }

  private isExecutingToolCallPatch(
    data: unknown,
  ): data is Partial<ExecutingToolCall> {
    // A partial can be an empty object, but it must be a non-null object.
    return typeof data === 'object' && data !== null;
  }

  // --- Transition Helpers ---

  /** Extracts `startTime` from a ToolCall if present, else undefined. */
  private getStartTime(call: ToolCall): number | undefined {
    return 'startTime' in call ? call.startTime : undefined;
  }

  /**
   * Keep wall-clock timestamps for correlation, but measure elapsed time with
   * a monotonic clock. Clock corrections can make endTime - startTime differ.
   */
  private getTerminalTiming(call: ToolCall): {
    durationMs?: number;
    startTime?: number;
    endTime: number;
  } {
    const startTime = this.getStartTime(call);
    const endTime = Date.now();
    const monotonicStart = this.monotonicStarts.get(call.request.callId);
    return {
      durationMs:
        startTime !== undefined && monotonicStart !== undefined
          ? Math.max(0, Math.round(performance.now() - monotonicStart))
          : undefined,
      startTime,
      endTime,
    };
  }

  /**
   * Ensures the tool call has an associated tool and invocation before
   * transitioning to states that require them.
   */
  private validateHasToolAndInvocation(
    call: ToolCall,
    targetStatus: Status,
  ): asserts call is ToolCall & {
    tool: AnyDeclarativeTool;
    invocation: AnyToolInvocation;
  } {
    if (
      !('tool' in call && call.tool && 'invocation' in call && call.invocation)
    ) {
      throw new Error(
        `Invalid state transition: cannot transition to ${targetStatus} without tool/invocation (callId: ${call.request.callId})`,
      );
    }
  }

  private toSuccess(
    call: ToolCall,
    response: ToolCallResponseInfo,
  ): SuccessfulToolCall {
    this.validateHasToolAndInvocation(call, CoreToolCallStatus.Success);
    return {
      request: call.request,
      tool: call.tool,
      invocation: call.invocation,
      status: CoreToolCallStatus.Success,
      response,
      ...this.getTerminalTiming(call),
      outcome: call.outcome,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }

  private toError(
    call: ToolCall,
    response: ToolCallResponseInfo,
  ): ErroredToolCall {
    return {
      request: call.request,
      status: CoreToolCallStatus.Error,
      tool: 'tool' in call ? call.tool : undefined,
      response,
      ...this.getTerminalTiming(call),
      outcome: call.outcome,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }

  private toAwaitingApproval(
    call: ToolCall,
    data: {
      correlationId: string;
      confirmationDetails: SerializableConfirmationDetails;
    },
  ): WaitingToolCall {
    this.validateHasToolAndInvocation(
      call,
      CoreToolCallStatus.AwaitingApproval,
    );

    return {
      request: call.request,
      tool: call.tool,
      status: CoreToolCallStatus.AwaitingApproval,
      correlationId: data.correlationId,
      confirmationDetails: data.confirmationDetails,
      startTime: this.getStartTime(call),
      outcome: call.outcome,
      invocation: call.invocation,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }

  private toScheduled(call: ToolCall): ScheduledToolCall {
    this.validateHasToolAndInvocation(call, CoreToolCallStatus.Scheduled);
    return {
      request: call.request,
      tool: call.tool,
      status: CoreToolCallStatus.Scheduled,
      startTime: this.getStartTime(call),
      outcome: call.outcome,
      invocation: call.invocation,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }

  private toCancelled(
    call: ToolCall,
    reason: string | ToolCallResponseInfo,
  ): CancelledToolCall {
    const timing = this.getTerminalTiming(call);
    const tool = 'tool' in call ? call.tool : undefined;
    const invocation = 'invocation' in call ? call.invocation : undefined;

    let toolUseResult: ToolResultDisplay | ToolStatusResult | undefined =
      undefined;
    if (this.isWaitingToolCall(call)) {
      const details = call.confirmationDetails;
      if (
        details.type === 'edit' &&
        'fileDiff' in details &&
        'fileName' in details &&
        'filePath' in details &&
        'originalContent' in details &&
        'newContent' in details
      ) {
        toolUseResult = {
          fileDiff: details.fileDiff,
          fileName: details.fileName,
          filePath: details.filePath,
          originalContent: details.originalContent,
          newContent: details.newContent,
          // Derive stats from the patch if they aren't already present
          diffStat: details.diffStat ?? getDiffStatFromPatch(details.fileDiff),
        };
      }
    }

    if (isToolCallResponseInfo(reason)) {
      const finalResponse = { ...reason };
      finalResponse.toolUseResult ??=
        toolUseResult ??
        buildToolStatusResult(
          'cancelled',
          toToolStatusSummary(finalResponse.error?.message),
        );

      return {
        request: call.request,
        tool,
        invocation,
        status: CoreToolCallStatus.Cancelled,
        response: finalResponse,
        ...timing,
        outcome: call.outcome,
        toolCallScopeId: call.toolCallScopeId,
        planModeActive: call.planModeActive,
      };
    }

    return {
      request: call.request,
      tool,
      invocation,
      status: CoreToolCallStatus.Cancelled,
      response: {
        callId: call.request.callId,
        responseParts: [
          {
            functionResponse: {
              id: call.request.callId,
              name: call.request.originalRequestName ?? call.request.name,
              response: { output: REJECT_MESSAGE },
            },
          },
        ],
        resultDisplay: undefined,
        error: new Error(reason),
        errorType: undefined,
        contentLength: REJECT_MESSAGE.length,
        toolUseResult:
          toolUseResult ??
          buildToolStatusResult('cancelled', toToolStatusSummary(reason)),
      },
      ...timing,
      outcome: call.outcome,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }

  private isWaitingToolCall(call: ToolCall): call is WaitingToolCall {
    return call.status === CoreToolCallStatus.AwaitingApproval;
  }

  private patchCall<T extends ToolCall>(call: T, patch: Partial<T>): T {
    return { ...call, ...patch };
  }

  private toValidating(call: ToolCall): ValidatingToolCall {
    // Validating does not require invocation — it may not exist yet
    // when the STE path creates a pending placeholder before build().
    if (!('tool' in call && call.tool)) {
      throw new Error(
        `Invalid state transition: cannot transition to ${CoreToolCallStatus.Validating} without tool (callId: ${call.request.callId})`,
      );
    }
    return {
      request: call.request,
      tool: call.tool,
      status: CoreToolCallStatus.Validating,
      startTime: this.getStartTime(call),
      outcome: call.outcome,
      invocation: 'invocation' in call ? call.invocation : undefined,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }

  private toExecuting(call: ToolCall, data?: unknown): ExecutingToolCall {
    this.validateHasToolAndInvocation(call, CoreToolCallStatus.Executing);
    const execData = data as Partial<ExecutingToolCall> | undefined;
    const liveOutput =
      execData?.liveOutput ??
      ('liveOutput' in call ? call.liveOutput : undefined);
    const pid = execData?.pid ?? ('pid' in call ? call.pid : undefined);
    const progressMessage =
      execData?.progressMessage ??
      ('progressMessage' in call ? call.progressMessage : undefined);
    const progressPercent =
      execData?.progressPercent ??
      ('progressPercent' in call ? call.progressPercent : undefined);
    const progress =
      execData?.progress ?? ('progress' in call ? call.progress : undefined);
    const progressTotal =
      execData?.progressTotal ??
      ('progressTotal' in call ? call.progressTotal : undefined);
    const executionStartedAt =
      execData?.executionStartedAt ??
      ('executionStartedAt' in call ? call.executionStartedAt : Date.now());

    return {
      request: call.request,
      tool: call.tool,
      status: CoreToolCallStatus.Executing,
      startTime: this.getStartTime(call),
      outcome: call.outcome,
      invocation: call.invocation,
      liveOutput,
      pid,
      progressMessage,
      progressPercent,
      progress,
      progressTotal,
      executionStartedAt,
      toolCallScopeId: call.toolCallScopeId,
      planModeActive: call.planModeActive,
    };
  }
}

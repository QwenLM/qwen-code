/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { describeProgrammaticInput } from './tool-catalog.js';
import { snapshotCallArgs } from './call-args.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import {
  codeModeChildStatus,
  type AnyDeclarativeTool,
  type CodeModeChildDisplay,
  type NewToolMessage,
  type ToolResult,
} from '../tools/tools.js';
import { StreamingToolExecutor } from '../tools/streaming-tool-executor.js';
import { createChildAbortController } from '../tools/abort-utils.js';
import {
  markFileStateResultPartial,
  markFileStateResultScriptOnly,
} from '../utils/fileStateCache.js';
import { runLogger } from '../utils/runLogger.js';
import { isRecord } from '../utils/markdownUtils.js';
import {
  programmaticErrorMessage,
  projectProgrammaticResult,
  readImageContract,
} from './contracts.js';
import {
  SCRIPT_LIMITS,
  ScriptToolError,
  type JsonObject,
  type JsonValue,
  type ProgrammaticContract,
  type ScriptCallSummary,
  type ScriptStatus,
} from './types.js';
import { ToolCallStateManager } from '../tool-executor/state-manager.js';
import {
  completedToolCallToResult,
  createToolExecuteCallback,
  createToolPreExecutionGate,
  convertToolResultToCompletedToolCall,
  LocalToolCallExecutor,
} from '../tool-executor/index.js';
import type {
  ToolExecutionResult,
  ToolGateOptions,
} from '../tool-executor/index.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import { projectToolResultForHost } from '../engine/headless-projection.js';
import { formatUserRejection } from '../protocol/transcript/message-utils.js';

export interface ScopeSummary {
  calls: ScriptCallSummary[];
  children?: CodeModeChildDisplay[];
  stopReason?: string;
  endsTurn: boolean;
  newMessages: NewToolMessage[];
}
interface PendingCall {
  summary: ScriptCallSummary;
  contract?: ProgrammaticContract;
  resolve(value: JsonValue): void;
  reject(error: ScriptToolError): void;
}

function refreshArgs(
  summary: ScriptCallSummary,
  args: Record<string, unknown> | undefined,
): void {
  const preview = snapshotCallArgs(args ?? {});
  summary.args = preview.args;
  // Assigned even when undefined: a later snapshot may no longer be truncated.
  summary.argsTruncated = preview.argsTruncated;
}

/** Image blocks the script can pass to image(): MCP-style `content` entries or a projected image. */
function countImageBlocks(value: JsonValue): number {
  if (!isRecord(value)) return 0;
  if (value['type'] === 'image') return 1;
  const content = value['content'];
  return Array.isArray(content)
    ? content.filter((block) => isRecord(block) && block['type'] === 'image')
        .length
    : 0;
}

const RETIRED_TOOL_MESSAGE = 'Tool is no longer available';

// A tool that left the registry cannot come back within this script, so the
// denial is tagged as unavailable rather than a retryable execution failure.
const UNAVAILABLE_DENIAL = {
  status: 'denied',
  error: new Error(RETIRED_TOOL_MESSAGE),
  errorType: ToolErrorType.TOOL_NOT_REGISTERED,
} as const;

/**
 * Runs a script's tool calls on a child scheduler, never a recursive
 * submission to the waiting parent queue, and projects each final result
 * through the tool's programmatic contract.
 */
export class ToolExecutionScope {
  readonly tools: ReadonlyMap<string, AnyDeclarativeTool>;
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private readonly cleanup: () => void;
  private readonly executor: StreamingToolExecutor;
  private readonly drain: Promise<void>;
  private readonly pending = new Map<string, PendingCall>();
  private readonly calls: ScriptCallSummary[] = [];
  private readonly projectedResults = new WeakMap<
    object,
    { result: ToolResult; summary: ScriptCallSummary }
  >();
  private readonly messages: NewToolMessage[] = [];
  private readonly childDisplays = new Map<string, CodeModeChildDisplay>();
  private readonly schedulerState: ToolCallStateManager;
  private state: 'open' | 'closing' | 'closed' = 'open';
  private closePromise?: Promise<ScopeSummary>;
  private stopReason?: string;
  private endsTurn = false;
  private readonly approvalListeners = new Set<(waiting: boolean) => void>();
  private authorizing = 0;
  private readonly executing = new Set<string>();
  private readonly resolveTool: (
    name: string,
  ) => AnyDeclarativeTool | undefined;
  private approvalWaiting = false;

  constructor(
    private readonly parent: ToolUseContext,
    readonly toolCallScopeId = `codemode:${randomUUID()}`,
  ) {
    const context = parent.agentLoopContext;
    if (
      !context?.permission ||
      !parent.callId ||
      !parent.pendingHookAttachments ||
      !parent.pendingHookOutputs
    ) {
      throw new Error(
        'CodeMode requires an agent permission context, parent call ID and host hook channels',
      );
    }
    const { controller, cleanup } = createChildAbortController(parent.signal);
    this.controller = controller;
    this.cleanup = cleanup;
    this.signal = controller.signal;
    const registry = context.toolRegistry;
    const scriptTools = () => registry.getToolView(parent.modelKey).scriptTools;
    this.tools = new Map(scriptTools());
    const available = (name: string) =>
      this.tools.has(name) &&
      scriptTools().get(name) === this.tools.get(name) &&
      registry.getTool(name) === this.tools.get(name);
    const state = new ToolCallStateManager(
      {
        publishToolCallSnapshot: (snapshot) => {
          if (this.state === 'closed') return;
          context.toolCallSnapshots.publishToolCallSnapshot({
            ...snapshot,
            codeMode: {
              rootToolUseId: parent.callId!,
              parentToolUseId: context.parentToolUseId,
            },
          });
          let changed = false;
          for (const call of snapshot.toolCalls) {
            const { callId, name, args } = call.request;
            const child = this.childDisplays.get(callId);
            if (child?.status === call.status && child.args === args) continue;
            const summary = this.pending.get(callId)?.summary;
            if (summary && child && child.args !== args)
              refreshArgs(summary, args);
            changed = true;
            this.childDisplays.set(callId, {
              ...child,
              callId,
              name,
              args: args ?? {},
              status: call.status,
            });
          }
          if (changed) {
            parent.updateOutput?.({
              isCodeModeDisplay: true,
              status: 'running',
              children: this.displayChildren,
            });
          }
        },
      },
      this.toolCallScopeId,
    );
    this.schedulerState = state;
    const options: ToolGateOptions = {
      resolveTool: (name) =>
        available(name) ? registry.getTool(name) : undefined,
      toolExecutor: new LocalToolCallExecutor(context, context.agentId),
      state,
      config: context.config,
      context,
      toolCallScopeId: this.toolCallScopeId,
      parentCallId: parent.callId,
      subagent: context.agentId,
      resultConsumption: 'programmatic',
      isRetired: () => this.state === 'closed',
    };
    const gate = createToolPreExecutionGate(options);
    this.resolveTool = options.resolveTool;
    this.executor = new StreamingToolExecutor({
      parentSignal: this.signal,
      maxConcurrency: SCRIPT_LIMITS.concurrency,
      resolveTool: options.resolveTool,
      executeTool: createToolExecuteCallback(options),
      preExecutionGate: async (...args) => {
        const { name, callId } = args[1];
        if (!available(name)) return UNAVAILABLE_DENIAL;
        this.authorizing++;
        this.updateApprovalWait();
        try {
          const outcome = await gate(...args);
          if (outcome.status !== 'proceed') return outcome;
          if (!available(name)) return UNAVAILABLE_DENIAL;
          this.executing.add(callId);
          return outcome;
        } finally {
          this.authorizing--;
          this.updateApprovalWait();
        }
      },
      initialContext: {
        ...parent,
        signal: this.signal,
        toolCallScopeId: this.toolCallScopeId,
        resultConsumption: 'programmatic',
      },
      onStatusChange: (request, status, tool) => {
        if (this.state === 'closed' || status !== 'queued' || !tool) return;
        state.addActiveCall({
          status: CoreToolCallStatus.Validating,
          request,
          tool,
          toolCallScopeId: this.toolCallScopeId,
          startTime: Date.now(),
        });
      },
      onToolCompleted: (completed) => {
        if (this.executing.delete(completed.request.callId))
          this.updateApprovalWait();
        // Never throw through STE's observer guard: settle each promise even if
        // result projection fails, and close admission before STE starts more.
        this.publishCompletion(completed);
      },
    });
    const executor = this.executor;
    this.drain = (async () => {
      for await (const _result of executor.getRemainingResults()) {
        /* consumed only by this scope */
      }
    })();
    this.signal.addEventListener('abort', this.onAbort, { once: true });
    if (this.signal.aborted) this.onAbort();
  }

  subscribeApprovalWait(listener: (waiting: boolean) => void): () => void {
    this.approvalListeners.add(listener);
    if (this.approvalWaiting) listener(true);
    return () => this.approvalListeners.delete(listener);
  }

  /** Report the native tool outcome even if delivering the result to the script fails. */
  private publishCompletion(completed: ToolExecutionResult): void {
    // Settle the script promise before host projection so a display error cannot leave it pending.
    const summary = this.complete(completed);
    if (this.state === 'closed') return;
    let projected;
    try {
      projected = convertToolResultToCompletedToolCall(
        completed,
        this.toolCallScopeId,
        undefined,
      );
    } catch (error) {
      runLogger.warn('[CodeMode] Native result conversion failed', error);
      // Preserve the execution outcome when result details cannot be converted.
      projected = convertToolResultToCompletedToolCall(
        {
          ...completed,
          result: completed.result
            ? {
                llmContent: 'Tool result details are unavailable.',
                returnDisplay: '',
                isError: completed.result.isError,
                error: completed.result.error,
              }
            : undefined,
        },
        this.toolCallScopeId,
        undefined,
      );
    }
    let hostResult: NonNullable<CodeModeChildDisplay['hostResult']>;
    try {
      hostResult = projectToolResultForHost(
        completedToolCallToResult(projected),
      );
    } catch (error) {
      runLogger.warn('[CodeMode] Host result projection failed', error);
      hostResult = {
        content: 'Tool result details are unavailable.',
        is_error:
          projected.status !== CoreToolCallStatus.Success ||
          projected.response.isError === true,
      };
    }
    if (summary) {
      this.recordChild(completed, summary);
      const child = this.childDisplays.get(completed.request.callId)!;
      this.childDisplays.set(completed.request.callId, {
        ...child,
        status: projected.status,
        hostResult,
      });
    }
    projected.response = {
      ...projected.response,
      responseParts: [],
      toolUseResult: summary,
      resultDisplay: undefined,
      data: undefined,
      hostResult,
    };
    projected.resultMessages = [];
    this.schedulerState.addActiveCall(projected);
    this.schedulerState.finalizeCall(projected.request.callId);
  }

  /**
   * Authorization (PreToolUse hooks, permission checks, approval prompts)
   * pauses the script clock only while no child call is executing.
   */
  private updateApprovalWait(): void {
    const waiting = this.authorizing > 0 && this.executing.size === 0;
    if (waiting === this.approvalWaiting) return;
    this.approvalWaiting = waiting;
    for (const listener of this.approvalListeners) {
      try {
        listener(waiting);
      } catch (error) {
        runLogger.warn('[CodeMode] Approval wait listener failed', error);
      }
    }
  }

  private readonly onAbort = () => {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this.executor.cancelAll(this.stopReason ?? 'CodeMode cancelled');
  };

  private stop(reason: string, endsTurn: boolean): void {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this.stopReason ??= reason;
    this.endsTurn ||= endsTurn;
    // Close STE first; signal listeners may synchronously complete other calls.
    this.executor.cancelAll(reason);
    this.controller.abort(reason);
  }

  /**
   * Call count, argument and result byte budgets are enforced once, by the
   * ScriptRuntime transport that is the only caller of this scope.
   */
  async call(
    name: string,
    args: JsonObject,
    options?: { hostImageRead?: boolean },
  ): Promise<JsonValue> {
    if (this.state !== 'open' || this.signal.aborted)
      throw new ScriptToolError({
        kind: 'closed',
        toolName: name,
        message: this.stopReason ?? 'CodeMode scope is closed',
      });
    const tool = this.tools.get(name);
    // STE would fail an unresolvable tool at resolve time, before the gate can
    // tag it, so a tool that already left the registry is rejected here to keep
    // the script's error shape the same whenever a tool retires.
    if (!tool || !this.resolveTool(name))
      throw new ScriptToolError({
        kind: 'unavailable',
        toolName: name,
        message: tool
          ? RETIRED_TOOL_MESSAGE
          : 'Tool is not available to this script',
      });
    const callId = randomUUID();
    const summary: ScriptCallSummary = {
      callId,
      name,
      ...snapshotCallArgs(args),
      status: 'pending',
      settlement: 'not_started',
      readOnly: tool.isReadOnly,
    };
    this.calls.push(summary);
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(callId, {
        summary,
        contract: options?.hostImageRead ? readImageContract : undefined,
        resolve,
        reject,
      });
      try {
        this.executor.addTool({
          name,
          args,
          callId,
          parentCallId: this.parent.callId,
          toolCallScopeId: this.toolCallScopeId,
          prompt_id:
            this.parent.promptId ?? this.parent.agentLoopContext!.promptId,
          message_id: this.parent.messageId,
          requestId: this.parent.requestId,
          isWorkflowAgent: this.parent.isWorkflowAgent,
          hostImageRead: options?.hostImageRead,
        });
      } catch (error) {
        this.pending.delete(callId);
        summary.status = 'error';
        summary.kind = 'enqueue';
        summary.error =
          error instanceof Error ? error.message : 'Unable to enqueue tool';
        reject(
          new ScriptToolError({
            kind: 'enqueue',
            toolName: name,
            callId,
            message: summary.error,
          }),
        );
        this.publishCompletion({
          request: {
            callId,
            name,
            args,
            parentCallId: this.parent.callId,
            prompt_id:
              this.parent.promptId ?? this.parent.agentLoopContext!.promptId,
          },
          tool,
          invocation: undefined,
          result: undefined,
          cancelled: false,
          durationMs: 0,
          error: error instanceof Error ? error : new Error(summary.error),
          settlement: 'not_started',
        });
      }
    });
  }

  /** Child entries are replaced, never mutated, so they are shared without copying. */
  get displayChildren(): CodeModeChildDisplay[] {
    return [...this.childDisplays.values()];
  }

  private recordChild(
    completed: ToolExecutionResult,
    summary: ScriptCallSummary,
  ): void {
    const { callId, name, args } = completed.request;
    this.childDisplays.set(callId, {
      callId,
      name,
      args: args ?? {},
      status: codeModeChildStatus(summary.status),
      ...(completed.result?.returnDisplay !== undefined
        ? { resultDisplay: completed.result.returnDisplay }
        : {}),
      ...(summary.error ? { error: summary.error } : {}),
      ...(summary.notice ? { notice: summary.notice } : {}),
    });
  }

  private complete(
    completed: ToolExecutionResult,
  ): ScriptCallSummary | undefined {
    const callId = completed.request.callId;
    const pending = this.pending.get(callId);
    if (!pending) {
      if (completed.result) markFileStateResultPartial(completed.result);
      runLogger.log(
        `[CodeMode] Late child completion callId=${callId} settlement=${completed.settlement}`,
      );
      return this.calls.find((item) => item.callId === callId);
    }
    this.pending.delete(callId);
    const { summary } = pending;
    refreshArgs(summary, completed.request.args);
    summary.settlement = completed.settlement ?? 'unknown';
    summary.durationMs = completed.durationMs;
    summary.filePath = completed.result?.fileWrite?.filePath;
    const stoppedByHook = this.parent.pendingHookAttachments?.some(
      (item) =>
        item.type === 'hook_stopped_continuation' && item.toolUseID === callId,
    );
    if (completed.result?.endsTurn || stoppedByHook) {
      this.stop(
        completed.error?.message ?? 'Child tool requested a stop',
        true,
      );
    }
    if (completed.result?.newMessages)
      this.messages.push(...completed.result.newMessages);
    const contract = pending.contract ?? completed.tool?.programmatic;
    const hookNotices = completed.result?.hookNotices ?? [];
    // Only a tool's explicit domain-error contract may resolve an isError result.
    // Permission denials, thrown errors, cancellation and hook errors still reject.
    const executionFailed =
      completed.cancelled ||
      completed.error ||
      completed.toolDenialKind ||
      completed.result?.error ||
      !completed.result;
    try {
      if (
        executionFailed ||
        !completed.result ||
        (completed.result.isError &&
          !contract?.acceptsErrorResult?.(completed.result))
      ) {
        summary.status = completed.cancelled ? 'cancelled' : 'error';
        throw new Error(
          // Same wording a direct call returns to the model.
          completed.toolDenialKind === 'user-rejected'
            ? formatUserRejection(completed.userFeedback)
            : (completed.error?.message ??
              programmaticErrorMessage(contract, completed.result)),
        );
      }
      if (!contract)
        throw new Error('Tool has no programmatic result contract');
      const value = projectProgrammaticResult(contract, completed.result);
      markFileStateResultScriptOnly(completed.result);
      summary.status = 'completed';
      const images = countImageBlocks(value);
      if (images) summary.images = images;
      const notices = [
        contract.notice?.(
          value,
          (completed.request.args ?? {}) as JsonObject,
        ) ??
          (completed.result.isError
            ? programmaticErrorMessage(contract, completed.result)
            : undefined),
        ...hookNotices,
      ].filter(Boolean);
      summary.notice = notices.length ? notices.join('; ') : undefined;
      if (value && typeof value === 'object')
        this.projectedResults.set(value, { result: completed.result, summary });
      pending.resolve(value);
    } catch (error) {
      if (completed.result) markFileStateResultPartial(completed.result);
      if (summary.status === 'pending') summary.status = 'error';
      const errorType = completed.result?.error?.type;
      const invalidArgs = errorType === ToolErrorType.INVALID_TOOL_PARAMS;
      summary.kind =
        completed.toolDenialKind ??
        (invalidArgs
          ? 'invalid_args'
          : errorType === ToolErrorType.TOOL_NOT_REGISTERED
            ? 'unavailable'
            : executionFailed || completed.result?.isError
              ? completed.cancelled
                ? 'cancelled'
                : 'execution'
              : 'result_unavailable');
      summary.error = (
        error instanceof Error
          ? error.message
          : 'Programmatic result unavailable'
      ).slice(0, 4000);
      if (invalidArgs && completed.tool) {
        // A missing input key is easy to confuse with a similarly named output
        // field. Return the same input declaration the model originally saw.
        try {
          const input = describeProgrammaticInput(
            completed.tool.getSchema(this.parent.modelKey),
          );
          summary.error =
            `${summary.error.slice(0, 1000)}\nExpected call and input:\n${input}`.slice(
              0,
              4000,
            );
        } catch {
          // Diagnostic rendering must never prevent the failed call settling.
        }
      }
      if (hookNotices.length)
        summary.error = `${summary.error}\n${hookNotices.join('\n')}`.slice(
          0,
          4000,
        );
      pending.reject(
        new ScriptToolError({
          kind: summary.kind,
          toolName: summary.name,
          callId,
          message: summary.error,
        }),
      );
    }
    return summary;
  }

  discardResult(value: JsonValue): void {
    if (!value || typeof value !== 'object') return;
    const projected = this.projectedResults.get(value);
    if (projected) {
      markFileStateResultPartial(projected.result);
      projected.summary.status = 'error';
      projected.summary.kind = 'result_unavailable';
      projected.summary.error =
        'Tool executed, but its result was not delivered to the script';
      const child = this.childDisplays.get(projected.summary.callId);
      if (child)
        this.childDisplays.set(child.callId, {
          ...child,
          error: projected.summary.error,
        });
    }
    this.projectedResults.delete(value);
  }

  get callSummaries(): ScriptCallSummary[] {
    // Args are detached previews, replaced rather than mutated; readers share them.
    return this.calls.map((call) => ({ ...call }));
  }

  close(status: ScriptStatus): Promise<ScopeSummary> {
    if (this.closePromise) return this.closePromise;
    this.state = 'closing';
    if (status !== 'completed' || this.pending.size > 0)
      this.stop(
        this.stopReason ??
          `CodeMode ${status === 'completed' ? 'incomplete' : status}`,
        // Cancelling a cell only closes this scope. AgentLoop handles query
        // aborts; explicit child stops and unsettled calls still end the turn.
        false,
      );
    this.executor.seal();
    this.closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.drain,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SCRIPT_LIMITS.cleanupMs);
        }),
      ]);
      clearTimeout(timer);
      if (this.pending.size > 0) {
        this.endsTurn = true;
        this.stopReason =
          'Some tool executions have not settled; their effects are unknown';
        for (const [callId, pending] of this.pending) {
          pending.summary.settlement = 'unknown';
          pending.summary.status = 'cancelled';
          pending.summary.kind = 'unknown';
          const child = this.childDisplays.get(callId);
          if (child)
            this.childDisplays.set(callId, {
              ...child,
              status: CoreToolCallStatus.Cancelled,
            });
          pending.reject(
            new ScriptToolError({
              kind: 'unknown',
              toolName: pending.summary.name,
              callId,
              message: this.stopReason,
            }),
          );
          this.publishCompletion({
            request: {
              callId,
              name: pending.summary.name,
              args: child?.args ?? {},
              parentCallId: this.parent.callId,
              prompt_id:
                this.parent.promptId ?? this.parent.agentLoopContext!.promptId,
            },
            tool: this.tools.get(pending.summary.name),
            invocation: undefined,
            result: undefined,
            durationMs: pending.summary.durationMs ?? 0,
            cancelled: true,
            error: new Error(this.stopReason),
            settlement: 'unknown',
          });
          pending.summary.kind = 'unknown';
        }
        this.pending.clear();
      }
      this.state = 'closed';
      this.parent.agentLoopContext!.toolCallSnapshots.publishToolCallSnapshot({
        toolCallScopeId: this.toolCallScopeId,
        toolCalls: [],
        codeMode: {
          rootToolUseId: this.parent.callId!,
          parentToolUseId: this.parent.agentLoopContext!.parentToolUseId,
        },
      });
      this.approvalListeners.clear();
      this.signal.removeEventListener('abort', this.onAbort);
      this.cleanup();
      return {
        calls: this.callSummaries,
        children: this.displayChildren,
        stopReason: this.stopReason,
        endsTurn: this.endsTurn,
        newMessages: this.messages,
      };
    })();
    return this.closePromise;
  }
}

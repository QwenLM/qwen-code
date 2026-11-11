/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  CompletedToolCall,
} from '../types.js';
import { CoreToolCallStatus } from '../types.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import { DiscoveredMCPTool } from '../../mcp/tools/mcp-tool.js';
import {
  uiTelemetryService,
  ToolCallDecision,
} from '../../services/session-stats.js';
import { ToolCallStateManager } from '../state-manager.js';
import {
  createToolPreExecutionGate,
  convertToolResultToCompletedToolCall,
} from './pre-execution-gate.js';
import type { PreExecutionOutcome } from '../../tools/tool-execution-lifecycle.js';
import { LocalToolCallExecutor } from './tool-call-runner.js';
import { completedToolCallToResult } from './tool-result-conversion.js';
import { RepeatedToolCallController } from './repeated-tool-call.js';

import { DoomLoopGuard } from '../../core/doom-loop-guard.js';

import {
  CoreEvent,
  coreEvents,
  type McpProgressPayload,
} from '../../utils/events.js';
import { TERMINAL_TOOL_SETTLEMENT_MS } from '../../core/tool-stream-settlement.js';
import { getToolSuggestion } from '../../utils/tool-utils.js';
import { formatUserRejection } from '../../protocol/transcript/message-utils.js';
import { normalizeModelToolUseBlock } from '../../protocol/provider/tool-input.js';
import { getOriginalToolName } from '../../utils/tool-name-utils.js';
import type {
  ToolResultBlock,
  ToolPermissionDenial,
} from '../../core/tool-result.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import type { AnyDeclarativeTool, ToolResult } from '../../tools/tools.js';
import type { ToolExecutionResult } from './tool-execution-result.js';
import { partListUnionToContent } from '../../tools/tool-use-result-builder.js';
import {
  createUserMessage,
  toolResultPartToTranscriptBlock,
} from '../../protocol/transcript/conversions.js';
import { SchemaValidator } from '../../utils/schemaValidator.js';
import { createChildAbortController } from '../../tools/abort-utils.js';
import { attachIsHardFailure } from '../../tools/tool-result-hard-failure.js';
import { ToolErrorType } from '../../tools/tool-error.js';
import {
  REFUSAL_REASON,
  REFUSAL_UNKNOWN_TOOL_DISPLAY,
  REFUSAL_UNKNOWN_TOOL_MODEL_CONTENT,
  type ToolCallResult,
  type ToolExecuteContext,
  type ToolExecutionBatch,
  type ToolExecutor,
} from '../tool-executor.js';
import { runLogger } from '../../utils/runLogger.js';
import { createToolResultMessage } from '../../protocol/transcript/conversions.js';
import { prepareImageBlocks } from '../../hooks/imagePrepare.js';
import { randomUUID } from 'node:crypto';
import { ROOT_TOOL_CALL_SCOPE_ID } from '../types.js';
import {
  requestSetIdContext,
  businessInfoContext,
  sessionIdContext,
} from '../../utils/sessionIdContext.js';
import { waitForExecutionWithSubagentEvents } from './tool-execution-wait.js';
import {
  failedToolExecutions,
  summarizeToolExecutions,
  type ToolExecutionSummary,
} from './tool-execution-summary.js';
import type { QueryEvent } from '../../core/query-event.js';

interface Waiter {
  safe: boolean;
  signal: AbortSignal;
  resolve: () => void;
}

interface ResponseState {
  retired: boolean;
  callIds: Set<string>;
}

/** One model response's dispatched calls and its execution chain. */
interface ToolBatch {
  readonly agentContext: AgentLoopContext;
  readonly config: Config;
  readonly toolCallScopeId: string;
  readonly parentCallId?: string;
  readonly subagent?: string;
  readonly state: ToolCallStateManager;
  readonly singleCall: LocalToolCallExecutor;
  readonly gate: ReturnType<typeof createToolPreExecutionGate>;
  repeatedCalls?: RepeatedToolCallController;
  readonly response: ResponseState;
  readonly queue: Waiter[];
  running: number;
  unsafeActive: boolean;
  readonly maxConcurrency?: number;
  readonly sessionAllowedKeys?: Set<string>;
  readonly onCompletedToolCall?: (call: CompletedToolCall) => void;
  readonly blocks: ModelToolUseBlock[];
  readonly executions: Array<Promise<ToolCallResult>>;
  readonly unsubscribeMcpProgress: () => void;
}

/**
 * The root query runs on Config (or a Config-derived overlay), whose promptId
 * is the session ID. Every fork owns a distinct promptId.
 */
export function resolveToolCallScopeId(agent?: AgentLoopContext): string {
  if (agent?.agentId) return `${agent.promptId}:${agent.agentId}`;
  if (!agent || agent.promptId === agent.config.promptId) {
    return ROOT_TOOL_CALL_SCOPE_ID;
  }
  return agent.promptId;
}

/**
 * Session-level streaming tool executor. The only state it retains is the
 * in-flight batch of one model response; the batch is created when the first
 * call is dispatched and released when wait/stop settles it.
 */
export class StreamingToolExecutor implements ToolExecutor {
  private readonly batches = new Map<string, ToolBatch>();

  execute(
    block: ModelToolUseBlock,
    ctx: ToolExecuteContext,
  ): Promise<ToolCallResult> {
    const batch = this.batchFor(ctx);
    // run() 而非 enterWith()：工具链路（含 runSubagent）需要父 agent 的
    // requestSetId / businessInfo，同时不能污染父 scope。
    const execute = () => {
      const promise = ctx.executionDisabled
        ? Promise.reject(
            new Error(
              'Tool execution disabled in this fork (cache-alignment only)',
            ),
          )
        : this.runExecution(batch, block, ctx);
      // The loop settles this batch later; keep an earlier rejection from
      // surfacing as unhandled while the batch is in flight.
      promise.catch(() => undefined);
      batch.blocks.push(block);
      batch.executions.push(promise);
      return promise;
    };
    const sessionId = ctx.sessionId ?? ctx.toolUseContext.sessionId;
    if (!sessionId) return execute();
    return sessionIdContext.run(sessionId, () =>
      requestSetIdContext.run(ctx.requestSetId ?? '', () =>
        ctx.businessInfo
          ? businessInfoContext.run(ctx.businessInfo, execute)
          : execute(),
      ),
    );
  }

  async *waitForExecutions(
    batch: ToolExecutionBatch,
  ): AsyncGenerator<QueryEvent, ToolExecutionSummary> {
    const pending = this.batches.get(batch.responseId);
    let settled: ToolCallResult[];
    let failed = false;
    try {
      settled = yield* waitForExecutionWithSubagentEvents(
        batch.sessionId,
        [...(pending?.blocks ?? [])],
        Promise.all(pending?.executions ?? []),
        batch.signal,
        batch.includeSessionSnapshots ?? true,
      );
    } catch (error) {
      // Keep the batch when a call rejected: stopExecution settles it with the
      // real failure instead of an empty summary.
      failed = true;
      throw error;
    } finally {
      if (!failed) this.releaseBatch(batch.responseId);
    }
    return summarizeToolExecutions(pending?.blocks ?? [], settled, batch);
  }

  /** Turn is terminating: settle the started calls without forwarding subagent events. */
  async stopExecution(
    batch: ToolExecutionBatch,
  ): Promise<ToolExecutionSummary> {
    const pending = this.batches.get(batch.responseId);
    this.releaseBatch(batch.responseId);
    const blocks = pending?.blocks ?? [];
    if (batch.failure) {
      return failedToolExecutions(
        blocks,
        batch.failure.error,
        batch.failure.cancelled,
        batch,
      );
    }
    const deadline = Math.min(
      Date.now() + TERMINAL_TOOL_SETTLEMENT_MS,
      batch.settlementDeadlineMs ?? Infinity,
    );
    const settled = await settleWithin(
      Promise.all(pending?.executions ?? []),
      deadline,
    );
    if (!settled) {
      return failedToolExecutions(
        blocks,
        new Error('Tool execution did not settle before the turn ended.'),
        true,
        batch,
      );
    }
    return summarizeToolExecutions(blocks, settled, batch);
  }

  dispose(): void {
    for (const responseId of [...this.batches.keys()]) {
      this.releaseBatch(responseId);
    }
  }

  private releaseBatch(responseId: string): void {
    const batch = this.batches.get(responseId);
    if (!batch) return;
    this.batches.delete(responseId);
    batch.unsubscribeMcpProgress();
  }

  private batchFor(ctx: ToolExecuteContext): ToolBatch {
    const existing = this.batches.get(ctx.responseId);
    if (existing) return existing;
    const agent = ctx.agentContext;
    const toolCallScopeId = resolveToolCallScopeId(agent);
    const subagent = ctx.agentType ?? agent.agentType;
    const state = new ToolCallStateManager(
      agent.toolCallSnapshots,
      toolCallScopeId,
      recordToolCallStats,
    );
    const singleCall = new LocalToolCallExecutor(agent, subagent);
    const gate = createToolPreExecutionGate({
      resolveTool: (name) => agent.toolRegistry.getTool(name),
      toolExecutor: singleCall,
      state,
      config: agent.config,
      context: agent,
      toolCallScopeId,
      parentCallId: agent.parentToolUseId ?? ctx.parentCallId,
      subagent,
    });
    const response: ResponseState = { retired: false, callIds: new Set() };
    ctx.signal.addEventListener(
      'abort',
      () => {
        response.retired = ctx.signal.reason === REFUSAL_REASON;
      },
      { once: true },
    );
    const handleMcpProgress = (payload: McpProgressPayload) => {
      if (payload.sessionId !== agent.config.getSessionId()) return;
      const { callId } = payload;
      const call = state.getToolCall(callId);
      if (!call || call.status !== CoreToolCallStatus.Executing) return;
      const validTotal =
        payload.total !== undefined &&
        Number.isFinite(payload.total) &&
        payload.total > 0
          ? payload.total
          : undefined;
      const progressPercent = validTotal
        ? Math.min(100, (payload.progress / validTotal) * 100)
        : undefined;
      const current = call as {
        progressMessage?: string;
        progressPercent?: number;
        progress?: number;
      };
      if (
        current.progressMessage === payload.message &&
        current.progressPercent === progressPercent &&
        current.progress === payload.progress
      ) {
        return;
      }
      state.updateStatus(callId, CoreToolCallStatus.Executing, {
        progressMessage: payload.message,
        progressPercent,
        progress: payload.progress,
        progressTotal: validTotal,
      });
    };
    coreEvents.on(CoreEvent.McpProgress, handleMcpProgress);
    const batch: ToolBatch = {
      agentContext: agent,
      unsubscribeMcpProgress: () =>
        coreEvents.off(CoreEvent.McpProgress, handleMcpProgress),
      config: agent.config,
      toolCallScopeId,
      parentCallId: agent.parentToolUseId ?? ctx.parentCallId,
      subagent,
      state,
      singleCall,
      gate,
      response,
      queue: [],
      running: 0,
      unsafeActive: false,
      maxConcurrency: ctx.maxConcurrency,
      sessionAllowedKeys: ctx.repeatedCallAllowedKeys,
      onCompletedToolCall: ctx.onCompletedToolCall ?? agent.onCompletedToolCall,
      blocks: [],
      executions: [],
    };
    this.batches.set(ctx.responseId, batch);
    return batch;
  }

  private async runExecution(
    batch: ToolBatch,
    rawBlock: ModelToolUseBlock,
    ctx: ToolExecuteContext,
  ): Promise<ToolCallResult> {
    const normalized = normalizeModelToolUseBlock(rawBlock);
    const probeRequest = this.toRequest(batch, normalized, ctx);
    const response = batch.response;
    response.callIds.add(probeRequest.callId);

    if (response.retired || ctx.signal.aborted) {
      response.callIds.delete(probeRequest.callId);
      return this.settled(batch, probeRequest, normalized, ctx, 'unknown');
    }

    const repeated = await this.getRepeatedCalls(batch, ctx).check(normalized, {
      signal: ctx.signal,
      toolUseContext: ctx.toolUseContext,
      stats: ctx.repeatedCallStats,
    });
    if (!repeated.allowed) {
      response.callIds.delete(probeRequest.callId);
      return this.settled(
        batch,
        probeRequest,
        normalized,
        ctx,
        'not_started',
        repeated.message,
        repeated.terminalReason,
        repeated.denial,
      );
    }

    const block = repeated.block;
    const request = this.toRequest(batch, block, ctx);
    const tool = batch.agentContext.toolRegistry.getTool(request.name);
    if (!tool) {
      response.callIds.delete(request.callId);
      return this.settled(
        batch,
        request,
        block,
        ctx,
        'not_started',
        `Tool "${request.name}" not found.${getToolSuggestion(
          request.name,
          batch.agentContext.toolRegistry.getAllToolNames(),
        )}`,
      );
    }

    batch.state.addActiveCall({
      status: CoreToolCallStatus.Validating,
      request,
      tool,
      invocation: undefined,
      startTime: Date.now(),
      toolCallScopeId: batch.toolCallScopeId,
      planModeActive: batch.config.isPlanMode(),
    });

    const { controller, cleanup } = createChildAbortController(ctx.signal);
    let acquired = false;
    try {
      acquired = await this.acquireSlot(
        batch,
        isConcurrencySafe(tool, request.args),
        controller.signal,
      );
      if (controller.signal.aborted || response.retired) {
        return this.settled(batch, request, block, ctx, 'unknown');
      }
      return await this.runCall(
        batch,
        request,
        block,
        tool,
        ctx,
        controller.signal,
      );
    } finally {
      cleanup();
      if (acquired) this.releaseSlot(batch);
      response.callIds.delete(request.callId);
    }
  }

  private async runCall(
    batch: ToolBatch,
    request: ToolCallRequestInfo,
    block: ModelToolUseBlock,
    tool: AnyDeclarativeTool,
    ctx: ToolExecuteContext,
    signal: AbortSignal,
  ): Promise<ToolCallResult> {
    const startedAt = Date.now();
    const toolUseContext = this.toToolUseContext(ctx, signal);

    let invocation: ReturnType<AnyDeclarativeTool['build']>;
    try {
      invocation = tool.build(request.args, toolUseContext);
    } catch (error) {
      return this.settled(
        batch,
        request,
        block,
        ctx,
        'not_started',
        messageOf(error),
      );
    }

    let outcome: PreExecutionOutcome;
    try {
      outcome = await batch.gate(
        invocation,
        request,
        tool,
        signal,
        toolUseContext,
      );
    } catch (error) {
      return this.settled(
        batch,
        request,
        block,
        ctx,
        'not_started',
        messageOf(error),
      );
    }
    if (outcome.status !== 'proceed') {
      return this.settled(
        batch,
        request,
        block,
        ctx,
        outcome.status === 'cancelled' ? 'unknown' : 'not_started',
        outcome.error.message,
        undefined,
        this.denialFromOutcome(tool.name, request, outcome),
      );
    }

    const effectiveInvocation = outcome.modifiedArgs
      ? tool.build(outcome.modifiedArgs, toolUseContext)
      : invocation;
    batch.state.updateStatus(request.callId, CoreToolCallStatus.Executing);

    let result: ToolResult;
    let cancelled = false;
    try {
      const output = await batch.singleCall.execute({
        call: {
          status: CoreToolCallStatus.Executing,
          request,
          tool,
          invocation: effectiveInvocation,
          startTime: startedAt,
        },
        resultConsumption: 'model',
        signal,
        queryLifecycle: ctx.toolUseContext.queryLifecycle,
        sessionId: ctx.toolUseContext.sessionId,
        fileReadState:
          ctx.toolUseContext.fileReadState ?? batch.agentContext.fileReadState,
        skillPermissionOverlay: ctx.toolUseContext.skillPermissionOverlay,
        pendingHookAttachments: ctx.toolUseContext.pendingHookAttachments,
        pendingHookOutputs: ctx.toolUseContext.pendingHookOutputs,
        customContext: ctx.toolUseContext.customContext,
        modelDisplayName: ctx.toolUseContext.modelDisplayName,
        modelKey: ctx.toolUseContext.modelKey,
        modelEntry: ctx.modelEntry,
        outputUpdateHandler: ctx.updateOutput
          ? (_callId, output) => ctx.updateOutput?.(output)
          : undefined,
        onUpdateToolCall: () => undefined,
        callId: request.callId,
        toolCallScopeId: batch.toolCallScopeId,
      });
      result = output.result;
      cancelled = signal.aborted;
    } catch (error) {
      cancelled = signal.aborted;
      result = cancelled
        ? createFailureResult(
            'Operation cancelled',
            ToolErrorType.EXECUTION_FAILED,
          )
        : createFailureResult(
            messageOf(error),
            ToolErrorType.UNHANDLED_EXCEPTION,
          );
    }

    const steResult: ToolExecutionResult = {
      request,
      tool,
      invocation: effectiveInvocation,
      result,
      error: result.error ? new Error(result.error.message) : undefined,
      cancelled,
      durationMs: Date.now() - startedAt,
      settlement: cancelled ? 'unknown' : 'completed',
    };
    const completed = convertToolResultToCompletedToolCall(
      steResult,
      batch.toolCallScopeId,
      ctx.modelEntry,
    );
    this.publishTerminal(
      batch,
      request.callId,
      completed.status,
      completed.response,
    );
    this.notifyCompleted(batch, completed);
    if (completed.response.repeatNeutral === true) {
      this.getRepeatedCalls(batch, ctx).neutralize(block);
    }
    let resultBlock = completedToolCallToResult(completed);
    if (cancelled && ctx.signal.reason === REFUSAL_REASON) {
      // A refusal-retired call keeps an unknown outcome; do not report it as a
      // user cancellation.
      resultBlock = {
        type: 'tool_result',
        tool_use_id: block.id,
        content: REFUSAL_UNKNOWN_TOOL_MODEL_CONTENT,
        is_error: true,
        toolUseResult: REFUSAL_UNKNOWN_TOOL_DISPLAY,
      };
    }
    const stop = this.takeHookStop(toolUseContext);

    return {
      block: resultBlock,
      supplementaryMessages: await this.buildSupplementaryMessages(result, ctx),
      historyMessage: await this.buildHistoryMessage(resultBlock, ctx),
      control: {
        settlement: steResult.settlement ?? 'unknown',
        ...(result.endsTurn ? { stopRequested: true } : {}),
        ...(stop ? { attachments: [stop] } : {}),
        ...(result.contextModifier
          ? { contextModifier: result.contextModifier }
          : {}),
      },
    };
  }

  private getRepeatedCalls(
    batch: ToolBatch,
    ctx: ToolExecuteContext,
  ): RepeatedToolCallController {
    const sessionAllowedKeys =
      ctx.repeatedCallAllowedKeys ?? batch.sessionAllowedKeys;
    // The doom-loop streak outlives one response, so it belongs to the agent
    // context; the executor only borrows it.
    const guard = (batch.agentContext.doomLoopGuard ??= new DoomLoopGuard({
      sessionAllowedKeys,
    }));
    batch.repeatedCalls ??= new RepeatedToolCallController({
      config: batch.config,
      guard,
      sessionAllowedKeys,
    });
    return batch.repeatedCalls;
  }

  private async buildHistoryMessage(
    block: ToolResultBlock,
    ctx: ToolExecuteContext,
  ): Promise<ReturnType<typeof createToolResultMessage>> {
    let content = block.content;
    if (Array.isArray(content) && ctx.imagePreparation) {
      try {
        content = await prepareImageBlocks(content, {
          ...ctx.imagePreparation,
          signal: ctx.signal,
        });
      } catch (error) {
        if (!ctx.signal.aborted) throw error;
      }
    }
    return createToolResultMessage(
      [{ ...block, content }],
      ctx.assistantMessageUuid ?? randomUUID(),
      { promptId: ctx.promptId },
    );
  }

  private toRequest(
    batch: ToolBatch,
    block: ModelToolUseBlock,
    ctx: ToolExecuteContext,
  ): ToolCallRequestInfo {
    const toolUseContext = ctx.toolUseContext;
    const mcpInfo = toolUseContext.mcpToolIdentities?.get(block.id);
    const request: ToolCallRequestInfo = {
      callId: block.id,
      name: getOriginalToolName(block.name),
      args: block.input,
      ...(mcpInfo ? { mcpInfo: { ...mcpInfo } } : {}),
      prompt_id: ctx.promptId,
      toolCallScopeId: batch.toolCallScopeId,
      parentCallId: batch.parentCallId,
      requestId: toolUseContext.requestId,
      isWorkflowAgent: toolUseContext.isWorkflowAgent,
    };
    if (toolUseContext.messageId !== undefined) {
      request.message_id = toolUseContext.messageId;
    }
    return request;
  }

  private toToolUseContext(
    ctx: ToolExecuteContext,
    signal: AbortSignal,
  ): ToolUseContext {
    return {
      ...ctx.toolUseContext,
      signal,
      updateOutput: ctx.updateOutput,
      modelEntry: ctx.modelEntry,
    };
  }

  private takeHookStop(toolUseContext: ToolUseContext) {
    const attachments = toolUseContext.pendingHookAttachments;
    if (!attachments) return undefined;
    const index = attachments.findIndex(
      (attachment) => attachment.type === 'hook_stopped_continuation',
    );
    if (index < 0) return undefined;
    return attachments.splice(index, 1)[0];
  }

  private async buildSupplementaryMessages(
    result: ToolResult,
    ctx: ToolExecuteContext,
  ): Promise<Array<ReturnType<typeof createUserMessage>>> {
    const messages: Array<ReturnType<typeof createUserMessage>> = [];
    for (const message of result.newMessages ?? []) {
      let content = partListUnionToContent(message.content);
      if (Array.isArray(content) && ctx.imagePreparation) {
        try {
          content = await prepareImageBlocks(content, {
            ...ctx.imagePreparation,
            signal: ctx.signal,
          });
        } catch (error) {
          if (!ctx.signal.aborted) throw error;
        }
      }
      messages.push(
        createUserMessage(
          typeof content === 'string'
            ? content
            : content.map(toolResultPartToTranscriptBlock),
          { isMeta: true },
        ),
      );
    }
    return messages;
  }

  private async acquireSlot(
    batch: ToolBatch,
    safe: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    if (
      safe &&
      !batch.unsafeActive &&
      batch.running < this.maxConcurrency(batch)
    ) {
      batch.running++;
      return true;
    }
    await new Promise<void>((resolve) => {
      const waiter: Waiter = { safe, signal, resolve };
      batch.queue.push(waiter);
      signal.addEventListener(
        'abort',
        () => {
          const index = batch.queue.indexOf(waiter);
          if (index >= 0) batch.queue.splice(index, 1);
          resolve();
        },
        { once: true },
      );
      this.drainQueue(batch);
    });
    return !signal.aborted;
  }

  private releaseSlot(batch: ToolBatch): void {
    batch.running = Math.max(0, batch.running - 1);
    if (batch.running === 0) batch.unsafeActive = false;
    this.drainQueue(batch);
  }

  private drainQueue(batch: ToolBatch): void {
    while (batch.queue.length > 0) {
      const next = batch.queue[0];
      if (next.signal.aborted) {
        batch.queue.shift();
        next.resolve();
        continue;
      }
      if (next.safe && !batch.unsafeActive) {
        batch.queue.shift();
        batch.running++;
        next.resolve();
        continue;
      }
      if (!next.safe && batch.running === 0) {
        batch.queue.shift();
        batch.unsafeActive = true;
        batch.running++;
        next.resolve();
        continue;
      }
      return;
    }
  }

  private maxConcurrency(batch: ToolBatch): number {
    return batch.maxConcurrency ?? Infinity;
  }

  private settled(
    batch: ToolBatch,
    request: ToolCallRequestInfo,
    block: ModelToolUseBlock,
    ctx: ToolExecuteContext,
    settlement: ToolExecutionResult['settlement'],
    message?: string,
    terminalReason?: string,
    permissionDenial?: ToolPermissionDenial,
  ): ToolCallResult {
    const refused = ctx.signal.reason === REFUSAL_REASON;
    const userRejected = permissionDenial?.tool_denial_kind === 'user-rejected';
    const content = refused
      ? REFUSAL_UNKNOWN_TOOL_MODEL_CONTENT
      : userRejected
        ? formatUserRejection(permissionDenial.decision_reason)
        : `Error: ${message ?? 'Operation cancelled'}`;
    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: block.id,
      content,
      is_error: true,
      ...(permissionDenial?.tool_denial_kind
        ? { toolDenialKind: permissionDenial.tool_denial_kind }
        : {}),
      ...(userRejected && permissionDenial?.decision_reason
        ? { userFeedback: permissionDenial.decision_reason }
        : {}),
      ...(refused
        ? { toolUseResult: REFUSAL_UNKNOWN_TOOL_DISPLAY }
        : { toolUseResult: attachIsHardFailure(undefined, false) }),
    };
    batch.state.addActiveCall({
      status: CoreToolCallStatus.Error,
      request,
      response: {
        callId: request.callId,
        error: new Error(message ?? 'Operation cancelled'),
        responseParts: [],
        resultDisplay: content,
        errorType: ToolErrorType.TOOL_NOT_REGISTERED,
        contentLength: content.length,
      },
      durationMs: 0,
      toolCallScopeId: batch.toolCallScopeId,
    });
    batch.state.finalizeCall(request.callId);
    return {
      block: resultBlock,
      supplementaryMessages: [],
      historyMessage: createToolResultMessage(
        [resultBlock],
        ctx.assistantMessageUuid ?? randomUUID(),
        { promptId: ctx.promptId },
      ),
      control: {
        settlement: settlement ?? 'unknown',
        terminalReason,
        permissionDenial,
      },
    };
  }

  private denialFromOutcome(
    toolName: string,
    request: ToolCallRequestInfo,
    outcome: {
      error: Error;
      toolDenialKind?: string;
      decisionReasonType?: string;
      decisionReason?: string;
    },
  ): ToolPermissionDenial {
    return {
      tool_name: toolName,
      tool_use_id: request.callId,
      tool_input: request.args ?? {},
      message: outcome.error.message,
      ...(outcome.toolDenialKind &&
      outcome.toolDenialKind !== 'interrupted' &&
      outcome.toolDenialKind !== 'cancelled'
        ? {
            tool_denial_kind:
              outcome.toolDenialKind as ToolPermissionDenial['tool_denial_kind'],
          }
        : {}),
      ...(outcome.decisionReasonType
        ? {
            decision_reason_type:
              outcome.decisionReasonType as ToolPermissionDenial['decision_reason_type'],
          }
        : {}),
      ...(outcome.decisionReason
        ? { decision_reason: outcome.decisionReason }
        : {}),
    };
  }

  private notifyCompleted(batch: ToolBatch, call: CompletedToolCall): void {
    try {
      batch.onCompletedToolCall?.(call);
    } catch (error) {
      runLogger.warn(
        '[ToolExecutor] onCompletedToolCall observer failed:',
        error,
      );
    }
  }

  private publishTerminal(
    batch: ToolBatch,
    callId: string,
    status: CompletedToolCall['status'],
    response: ToolCallResponseInfo,
  ): void {
    try {
      switch (status) {
        case CoreToolCallStatus.Success:
          batch.state.updateStatus(
            callId,
            CoreToolCallStatus.Success,
            response,
          );
          break;
        case CoreToolCallStatus.Error:
          batch.state.updateStatus(callId, CoreToolCallStatus.Error, response);
          break;
        case CoreToolCallStatus.Cancelled:
          batch.state.updateStatus(
            callId,
            CoreToolCallStatus.Cancelled,
            response,
          );
          break;
        default:
          break;
      }
      batch.state.finalizeCall(callId);
    } catch (error) {
      runLogger.warn('[ToolExecutor] terminal status publish failed', error);
    }
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      resolve,
      Math.max(0, deadline - Date.now()),
    ) as unknown as ReturnType<typeof setTimeout>;
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Feeds a finished tool call into the local session stats shown by the UI.
 * Terminal-call observer for ToolCallStateManager; never reports off-machine.
 */
export function recordToolCallStats(call: CompletedToolCall): void {
  const success = call.status === CoreToolCallStatus.Success;
  // Same naming and line-count rules as the old reporter: MCP calls are keyed
  // by the discovered tool name, every other call by the requested name, and
  // diff stats only count for successful calls.
  const diffStat = success ? call.response.diffStat : undefined;
  uiTelemetryService.recordToolCall({
    name:
      call.tool instanceof DiscoveredMCPTool
        ? call.tool.name
        : call.request.name,
    success,
    durationMs: call.durationMs ?? 0,
    decision: toToolCallDecision(call.outcome),
    linesAdded: diffStat?.model_added_lines,
    linesRemoved: diffStat?.model_removed_lines,
  });
}

function toToolCallDecision(
  outcome: ToolConfirmationOutcome | undefined,
): ToolCallDecision | undefined {
  if (!outcome) return undefined;
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedOnce:
      return ToolCallDecision.ACCEPT;
    case ToolConfirmationOutcome.ProceedSession:
    case ToolConfirmationOutcome.ProceedPersist:
      return ToolCallDecision.AUTO_ACCEPT;
    case ToolConfirmationOutcome.ModifyWithEditor:
      return ToolCallDecision.MODIFY;
    default:
      return ToolCallDecision.REJECT;
  }
}

function isConcurrencySafe(
  tool: AnyDeclarativeTool,
  args: ToolCallRequestInfo['args'],
): boolean {
  try {
    const parsed = structuredClone(args);
    if (SchemaValidator.validate(tool.schema.parametersJsonSchema, parsed)) {
      return false;
    }
    return Boolean(tool.isConcurrencySafe(parsed as never));
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFailureResult(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { type, message },
  };
}

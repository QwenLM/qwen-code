/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentEventEmitter,
  ToolCallConfirmationDetails,
  ToolCallRequestInfo,
  ToolConfirmationPayload,
  ToolResultDisplay,
} from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { goalToolResultProvenance } from '@qwen-code/qwen-code-core/goals/goal-tool-result-provenance.js';
import { createToolLifecycle } from '@qwen-code/qwen-code-core/telemetry/tool-lifecycle.js';
import {
  canonicalToolName,
  ToolNames,
} from '@qwen-code/qwen-code-core/tools/tool-names.js';
import {
  evaluateToolInvocationGuard,
  type ToolInvocationGuard,
} from '@qwen-code/qwen-code-core/core/tool-invocation-guard.js';
import { enforceFunctionResponseBudget } from '@qwen-code/qwen-code-core/tools/tool-response-finalizer.js';
import {
  isShellProgressData,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { resolveDeferredToolCall } from '@qwen-code/qwen-code-core/tools/tool-call.js';
import { USER_CANCEL_ABORT_REASON } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  createSchedulerExecutor,
  type AgentLoopDuplicateState,
  type AgentLoopStopReason,
  type AgentLoopToolResult,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';
import type {
  ToolCall,
  WaitingToolCall,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { ToolExecutionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { Part } from '@google/genai';
import type { AnyDeclarativeTool } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { SharedLoopRound } from '../../ui/hooks/shared-loop-round.js';
import type { ToolCallEmitter } from './emitters/tool-call-emitter.js';
import type { MessageEmitter } from './emitters/MessageEmitter.js';
import {
  buildPermissionRequestContent,
  interactionMetaFields,
  resolvePermissionOutcome,
  toPermissionOptions,
  type PermissionPersistencePolicy,
} from './permissionUtils.js';
import { SubAgentTracker } from './SubAgentTracker.js';
import type { SessionContext } from './types.js';

const debugLogger = createDebugLogger('ACP_TOOL_BATCH');
export const deferredToolUpdateContext = new AsyncLocalStorage<true>();

/** A Session Workflow plan an `exit_plan_mode` approval carries. */
export interface TodoPlanApproval {
  revision: { planId: string; sourceCallId: string };
  generation: number;
}

/** What a tool batch needs of the ACP session. */
export interface AcpToolBatchHost {
  readonly ctx: SessionContext;
  readonly client: AgentSideConnection;
  readonly toolCallEmitter: ToolCallEmitter;
  readonly messageEmitter: MessageEmitter;
  /** The session's three trusted live tool instances, trusted by identity. */
  isTrustedLiveTool(tool: unknown): boolean;
  /**
   * The session's read-only response to a request that reached approval:
   * the call is refused with this message; no `session/request_permission`
   * leaves the session. Omit for ordinary sessions.
   */
  readonly readOnlyRefusalMessage?: string;
  /**
   * Evaluated at the batch's execution boundary after build, before execute;
   * a denial becomes `not_started`. Omit for ordinary sessions.
   */
  readonly invocationGuard?: ToolInvocationGuard;
  /**
   * Registry lookup the batch uses to bind a canonical name to its tool
   * instance; trusted-live checks ride on it.
   */
  getTool(name: string): unknown;
  sendUpdate(update: SessionUpdate): Promise<void>;
  /** `session/request_permission`, one at a time. */
  requestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  readonly permissionPersistencePolicy?: PermissionPersistencePolicy;
  sendModeUpdate(): Promise<void>;
  /** A tool entered plan mode. */
  onPlanModeEntered(): void;
  /** The plan an `exit_plan_mode` approval would carry now. */
  todoPlanApproval(): TodoPlanApproval | undefined;
  isTodoPlanApprovalStale(approval: TodoPlanApproval): boolean;
  /** A `todo_write` call settled. */
  onTodoWriteSettled(
    status: 'success' | 'error' | 'cancelled',
    resultDisplay: unknown,
  ): void;
  /** A `send_message` call to an agent started; returns its settle. */
  continueRelatedAgent(
    args: Record<string, unknown>,
  ): ((succeeded: boolean) => void) | undefined;
  sendTerminalSequence(terminalSequence: string): void;
  /** The session's own refusal of a call, e.g. a Goal tool it cannot own. */
  refuseToolCall(request: ToolCallRequestInfo): string | undefined;
}

export interface AcpToolBatchResult {
  parts: Part[];
  stop?: AgentLoopStopReason;
  /** A permission request was cancelled: the turn stops after the batch. */
  stopAfterPermissionCancel: boolean;
  /** Every result of the batch, in request order. */
  results: AgentLoopToolResult[];
}

interface CallState {
  name: string;
  lifecycle?: ReturnType<typeof createToolLifecycle>;
  execution?: { status: ToolExecutionStatus; durationMs: number };
  approvalModeAtStart?: ApprovalMode;
  settleRelatedAgent?: (succeeded: boolean) => void;
  invocation?: unknown;
  cleanupTracker?: () => void;
  readySent?: boolean;
  settled?: boolean;
  todoPlanApproval?: TodoPlanApproval;
  /** The approval changed the approval mode; the client hears before the start. */
  modeUpdateBeforeStart?: boolean;
  /** Why the session cancelled the call, shown on its card. */
  cancelMessage?: string;
}

/**
 * Runs one tool batch of an ACP prompt turn on the shared loop's batch, in
 * the `runAgentLoop` call of the round that requested it: one
 * `CoreToolScheduler` for the whole batch, whose state changes become ACP
 * `tool_call` updates and whose approvals become `session/request_permission`
 * requests.
 */
export async function runAcpToolBatch(
  host: AcpToolBatchHost,
  options: {
    requests: ToolCallRequestInfo[];
    /** The loop call of the round that requested `requests`. */
    loop: Pick<SharedLoopRound, 'runBatch'>;
    signal: AbortSignal;
    duplicates: AgentLoopDuplicateState;
    onFullTurnModel?: (model: string) => boolean;
  },
): Promise<AcpToolBatchResult> {
  const { config } = host.ctx;
  const { signal } = options;
  // Tools run under their own signal, so a cancelled permission request can
  // stop the rest of the batch without cancelling the turn.
  const tools = new AbortController();
  const abortTools = () => tools.abort(signal.reason);
  if (signal.aborted) abortTools();
  else signal.addEventListener('abort', abortTools, { once: true });

  let stopAfterPermissionCancel = false;
  let closed = false;
  let drainCompletedUpdates = false;
  const stopBatch = () => {
    if (closed) return;
    stopAfterPermissionCancel = true;
    tools.abort(USER_CANCEL_ABORT_REASON);
  };

  // A completed card can drain after cancellation without delaying the turn.
  let emissions = Promise.resolve();
  const emit = (
    task: () => Promise<unknown> | unknown,
    what: string,
    deliverAfterClose = false,
  ) => {
    emissions = emissions.then(async () => {
      if (closed && !(drainCompletedUpdates && deliverAfterClose)) return;
      try {
        await (closed ? deferredToolUpdateContext.run(true, task) : task());
      } catch (error) {
        debugLogger.debug(`Failed to emit ${what}`, error);
      }
    });
  };

  const states = new Map<string, CallState>();
  const stateOf = (request: ToolCallRequestInfo): CallState => {
    let state = states.get(request.callId);
    if (!state) {
      state = {
        name: request.name,
        ...(canonicalToolName(request.name) === ToolNames.TODO_WRITE
          ? {}
          : {
              lifecycle: createToolLifecycle(
                config,
                request.callId,
                request.name,
              ),
            }),
      };
      states.set(request.callId, state);
    }
    state.name = request.name;
    return state;
  };
  const latest = new Map<string, ToolCall>();
  const answered = new WeakSet<ToolCallConfirmationDetails>();
  // The scheduler runs the batch from the last answer's `onConfirm`, so an
  // approval runs beside the updates, not in their queue.
  const approvals = new Set<Promise<void>>();

  const resolvedTargets = new Map<string, AnyDeclarativeTool>();
  await Promise.all(
    options.requests.map(async (request) => {
      if (canonicalToolName(request.name) !== ToolNames.TOOL_CALL) return;
      const resolution = await resolveDeferredToolCall(
        config.getToolRegistry(),
        request.args,
        { maxSubagentDepth: config.getMaxSubagentDepth() },
      );
      if ('tool' in resolution) {
        resolvedTargets.set(request.callId, resolution.tool);
      }
    }),
  );

  const trackAgent = (call: ToolCall, state: CallState) => {
    if (
      canonicalToolName(call.request.name) !== ToolNames.AGENT ||
      !('invocation' in call) ||
      !call.invocation ||
      state.invocation === call.invocation
    ) {
      return;
    }
    state.cleanupTracker?.();
    state.invocation = call.invocation;
    const eventEmitter = (
      call.invocation as { eventEmitter?: AgentEventEmitter }
    ).eventEmitter;
    if (!eventEmitter) return;
    const tracker = new SubAgentTracker(
      host.ctx,
      host.client,
      call.request.callId,
      (call.request.args['subagent_type'] as string) ?? '',
      stopBatch,
      (params, requestSignal) => host.requestPermission(params, requestSignal),
      host.permissionPersistencePolicy,
    );
    const cleanups = tracker.setup(eventEmitter, tools.signal);
    state.cleanupTracker = () => cleanups.forEach((cleanup) => cleanup());
  };

  const cancel = (
    state: CallState,
    details: ToolCallConfirmationDetails,
    cancelMessage: string,
  ) => {
    state.cancelMessage = cancelMessage;
    return details.onConfirm(ToolConfirmationOutcome.Cancel, { cancelMessage });
  };

  const approve = async (call: WaitingToolCall, state: CallState) => {
    const details = call.confirmationDetails;
    const { request, tool, invocation } = call;
    const current = latest.get(request.callId);
    if (
      tools.signal.aborted ||
      current?.status !== 'awaiting_approval' ||
      current.confirmationDetails !== details
    ) {
      return;
    }
    const isExitPlanMode = request.name === ToolNames.EXIT_PLAN_MODE;
    const todoPlanApproval = isExitPlanMode
      ? host.todoPlanApproval()
      : undefined;
    const permissionOptions = toPermissionOptions(
      details,
      false,
      host.permissionPersistencePolicy,
    );
    const offeredOptions = permissionOptions.map((option) => ({ ...option }));
    const params: RequestPermissionRequest = {
      sessionId: host.ctx.sessionId,
      options: permissionOptions,
      toolCall: {
        toolCallId: request.callId,
        status: 'pending',
        title: invocation.getDescription(),
        content: buildPermissionRequestContent(details),
        locations: invocation.toolLocations(),
        kind: host.toolCallEmitter.mapToolKind(tool.kind, request.name),
        rawInput: request.args,
        _meta: {
          toolName: request.name,
          ...interactionMetaFields(details),
          ...(todoPlanApproval
            ? { qwenTodoApproval: todoPlanApproval.revision }
            : {}),
        },
      },
    };

    let output: RequestPermissionResponse & {
      answers?: Record<string, string>;
      expectedPlanExecutionMode?: string;
    };
    let outcome: ToolConfirmationOutcome;
    try {
      output = await host.requestPermission(params, tools.signal);
      outcome = resolvePermissionOutcome(output, offeredOptions);
    } catch (error) {
      // An aborted batch cancels the call itself.
      if (tools.signal.aborted) return;
      debugLogger.error(
        `Permission request failed for tool ${request.name}:`,
        error,
      );
      // Stopped first, so the calls already approved do not run either.
      stopBatch();
      await cancel(
        state,
        details,
        isExitPlanMode
          ? 'The host could not present plan-exit approval. Plan mode remains active; use the host mode selector or /plan exit to leave plan mode.'
          : `Permission request failed for "${request.name}": ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
      return;
    }
    if (tools.signal.aborted) return;
    if (todoPlanApproval && host.isTodoPlanApprovalStale(todoPlanApproval)) {
      stopBatch();
      await cancel(
        state,
        details,
        'Plan approval is stale because its Session Workflow revision changed. No action was taken.',
      );
      return;
    }
    if (outcome === ToolConfirmationOutcome.Cancel) {
      stopBatch();
      await cancel(
        state,
        details,
        `Tool "${request.name}" was canceled by the user.`,
      );
      return;
    }
    state.todoPlanApproval = todoPlanApproval;
    const payload: ToolConfirmationPayload = {
      answers: output.answers,
      ...(output.expectedPlanExecutionMode !== undefined
        ? { expectedPlanExecutionMode: output.expectedPlanExecutionMode }
        : {}),
    };
    if (outcome === ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault) {
      outcome = ToolConfirmationOutcome.ProceedOnce;
      config.setApprovalMode(ApprovalMode.DEFAULT);
      await host.sendModeUpdate();
      if (tools.signal.aborted) return;
    }
    state.modeUpdateBeforeStart =
      details.type === 'edit' &&
      outcome === ToolConfirmationOutcome.ProceedAlways;
    await details.onConfirm(outcome, payload);
  };

  const started = (callId: string, startedAt: number) => {
    const call = latest.get(callId);
    if (!call) return;
    const state = stateOf(call.request);
    state.approvalModeAtStart = config.getApprovalMode();
    if (canonicalToolName(call.request.name) === ToolNames.SEND_MESSAGE) {
      state.settleRelatedAgent = host.continueRelatedAgent(call.request.args);
    }
    if (state.modeUpdateBeforeStart) {
      state.modeUpdateBeforeStart = false;
      emit(() => host.sendModeUpdate(), 'mode update');
    }
    emit(
      () =>
        host.toolCallEmitter.emitStart({
          callId,
          toolName: call.request.name,
          args: call.request.args,
          status: 'in_progress',
          startedAt: call.startTime ?? startedAt,
        }),
      'tool start update',
    );
    const lifecycle = state.lifecycle?.start(startedAt, call.request.name);
    if (lifecycle) {
      emit(() => host.toolCallEmitter.emitLifecycle(lifecycle), 'lifecycle');
    }
  };

  const settle = (call: ToolCall & { response: ToolCallResponseLike }) => {
    const state = stateOf(call.request);
    if (state.settled) return;
    state.settled = true;
    const { request, response } = call;
    const status = call.status as 'success' | 'error' | 'cancelled';
    state.settleRelatedAgent?.(status === 'success');
    state.cleanupTracker?.();
    const isTodoWrite =
      canonicalToolName(request.name) === ToolNames.TODO_WRITE;
    if (isTodoWrite) {
      host.onTodoWriteSettled(status, response.resultDisplay);
    }
    const planModeChanged =
      status === 'success' &&
      (request.name === ToolNames.ENTER_PLAN_MODE ||
        request.name === ToolNames.EXIT_PLAN_MODE) &&
      state.approvalModeAtStart !== undefined &&
      config.getApprovalMode() !== state.approvalModeAtStart;
    if (planModeChanged) {
      if (config.getApprovalMode() === ApprovalMode.PLAN) {
        host.onPlanModeEntered();
      }
      emit(() => host.sendModeUpdate(), 'mode update');
    }
    if (response.visionBridgeNotice) {
      const notice = response.visionBridgeNotice;
      emit(
        () => host.messageEmitter.emitAgentMessage(notice),
        'vision bridge notice',
      );
    }
    const lifecycle = state.lifecycle?.finish(
      status,
      state.execution?.status ?? 'not_started',
      state.execution?.durationMs,
    );
    if (lifecycle) {
      emit(
        () => host.toolCallEmitter.emitLifecycle(lifecycle),
        'lifecycle',
        true,
      );
    }
    const executed = response.executionStatus !== 'not_started';
    if (!executed && !isTodoWrite) {
      emit(
        () =>
          host.toolCallEmitter.emitError(
            request.callId,
            request.name,
            response.error ??
              new Error(
                state.cancelMessage ??
                  responseErrorText(response.responseParts),
              ),
          ),
        'tool error update',
        true,
      );
      return;
    }
    const durationMs =
      call.startTime === undefined ? undefined : Date.now() - call.startTime;
    emit(
      () =>
        host.toolCallEmitter.emitResult({
          callId: request.callId,
          toolName: request.name,
          args: request.args,
          startedAt: call.startTime,
          durationMs,
          message: response.responseParts,
          resultDisplay: response.resultDisplay,
          error: response.error,
          success: status === 'success',
          artifacts: response.artifacts,
          persistedOutputFiles: response.persistedOutputFiles,
        }),
      'tool result update',
      // A todo result can publish a new plan revision, so it stays turn-scoped.
      !isTodoWrite,
    );
  };

  const onToolCallsUpdate = (calls: ToolCall[]) => {
    for (const call of calls) {
      latest.set(call.request.callId, call);
      const state = stateOf(call.request);
      switch (call.status) {
        case 'validating':
        case 'scheduled':
        case 'executing':
          trackAgent(call, state);
          break;
        case 'awaiting_approval':
          trackAgent(call, state);
          if (!answered.has(call.confirmationDetails)) {
            answered.add(call.confirmationDetails);
            const approval = emissions
              .then(() => approve(call, state))
              .catch((error) => {
                debugLogger.error(
                  `Approval of ${call.request.name} failed:`,
                  error,
                );
                // A call left awaiting would hold the batch open.
                stopBatch();
              });
            approvals.add(approval);
          }
          break;
        case 'success':
        case 'error':
        case 'cancelled':
          settle(call);
          break;
        default:
          break;
      }
    }
  };

  const outputUpdateHandler = (callId: string, chunk: ToolResultDisplay) => {
    const state = states.get(callId);
    if (!state || state.settled) return;
    if (
      canonicalToolName(state.name) === ToolNames.AGENT &&
      !state.readySent &&
      typeof chunk === 'object' &&
      chunk !== null &&
      'subagentSessionReady' in chunk &&
      chunk.subagentSessionReady === true
    ) {
      state.readySent = true;
      void host
        .sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          _meta: { toolName: state.name, subagentSessionReady: true },
        })
        .catch((error) =>
          debugLogger.debug(`Subagent readiness update failed: ${error}`),
        );
    }
    if (!isShellProgressData(chunk)) return;
    void host
      .sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'in_progress',
        _meta: { toolName: state.name, shellProgress: chunk },
      })
      .catch((error) =>
        debugLogger.debug(`Shell heartbeat update failed: ${error}`),
      );
  };

  const results = new Map<ToolCallRequestInfo, AgentLoopToolResult>();
  try {
    const batch = await options.loop.runBatch({
      ...options.duplicates,
      toolSignal: tools.signal,
      executor: createSchedulerExecutor(config, {
        onToolCallsUpdate,
        outputUpdateHandler,
        onToolExecutionStarted: started,
        onToolExecutionSettled: (callId, status, durationMs) => {
          const state = states.get(callId);
          if (state) state.execution = { status, durationMs };
        },
        onToolResultFullTurnModel: options.onFullTurnModel,
        refuseToolCall: (request) => {
          const sessionRefusal = host.refuseToolCall(request);
          if (sessionRefusal !== undefined) return sessionRefusal;
          const directTool = host.getTool(canonicalToolName(request.name));
          return directTool === undefined &&
            resolvedTargets.get(request.callId) === undefined
            ? `Tool "${request.name}" is not registered in this session.`
            : undefined;
        },
        onPermissionPromptTerminalSequence: (sequence) => {
          if (!closed) host.sendTerminalSequence(sequence);
        },
      }),
      beforeToolLaunch: async (request) => {
        const approval = states.get(request.callId)?.todoPlanApproval;
        if (approval && host.isTodoPlanApprovalStale(approval)) {
          stopBatch();
          return false;
        }
        const tool =
          resolvedTargets.get(request.callId) ??
          host.getTool(canonicalToolName(request.name));
        if (!host.isTrustedLiveTool(tool)) {
          if (host.readOnlyRefusalMessage !== undefined) {
            stopBatch();
            return false;
          }
          if (host.invocationGuard) {
            const decision = await evaluateToolInvocationGuard(
              host.invocationGuard,
              {
                callId: request.callId,
                toolName: canonicalToolName(request.name),
                args: request.args as Record<string, unknown>,
                signal: tools.signal,
                permissionChecked: true,
                sessionId: config.getSessionId(),
                cwd: config.getTargetDir(),
              },
            );
            if (tools.signal.aborted) return false;
            if (!decision.allowed) {
              debugLogger.debug(
                `Invocation guard denied ${request.name}: ${decision.reason}`,
              );
              return false;
            }
          }
        }
        return true;
      },
      onToolResult: (result) => {
        results.set(result.request, result);
        if (result.origin === 'replayed' || result.origin === 'duplicate') {
          emitDuplicate(host, result, (task, what) => emit(task, what, true));
        }
      },
    });
    // A batch that settles after an abort still returns its recorded
    // responses. At the deadline the kernel returns without them, and an
    // approval promise may still be running the tool.
    if (batch.stop === 'cancelled' && batch.responses === undefined) {
      // Keep the per-call responses already available at the deadline.
      // The scheduler's final batch hooks and budget can still be pending.
      const seen = new Set<string>();
      const completed: AgentLoopToolResult[] = [];
      for (const request of options.requests) {
        let result = results.get(request);
        if (!result && !seen.has(request.callId)) {
          const call = latest.get(request.callId);
          if (
            call?.status === 'success' ||
            call?.status === 'error' ||
            call?.status === 'cancelled'
          ) {
            result = {
              request,
              executionRequest: call.request,
              response: call.response,
              status: call.status,
              origin: 'executed',
            };
            if (call.response.executionStatus !== 'not_started') {
              config
                .getLlmClient()
                .recordCompletedToolCall(call.request.name, call.request.args);
            }
          }
        }
        seen.add(request.callId);
        if (result) completed.push(result);
      }
      // Budget the saved results without waiting for output persistence.
      const budgeted = enforceFunctionResponseBudget(
        completed.map(({ request, response, executionRequest }) => ({
          callId: request.callId,
          toolName: executionRequest.name,
          responseParts: response.responseParts,
          persistedOutputFiles: response.persistedOutputFiles,
          artifacts: response.artifacts,
        })),
        config.getToolOutputBatchBudget(),
        false,
        false,
      );
      const kept = completed.map((result, index) => {
        const { response, status, executionRequest } = result;
        const { responseParts } = budgeted[index];
        config.getChatRecordingService()?.recordToolResult(
          responseParts,
          {
            callId: result.request.callId,
            status,
            resultDisplay: response.resultDisplay,
            persistedOutputFiles: response.persistedOutputFiles,
            artifacts: response.artifacts,
            error: response.error,
            errorType: response.errorType,
            executionStatus: response.executionStatus,
          },
          goalToolResultProvenance(executionRequest, responseParts),
        );
        return { ...result, response: { ...response, responseParts } };
      });
      drainCompletedUpdates = true;
      return {
        parts: budgeted.flatMap(({ responseParts }) => responseParts),
        stop: batch.stop,
        stopAfterPermissionCancel,
        results: kept,
      };
    }
    if (
      !signal.aborted ||
      config.isEventBusAgentLoopEnabled?.('acp') !== true
    ) {
      await Promise.all(approvals);
    }
    await emissions;
    return {
      parts: batch.parts,
      stop: batch.stop,
      stopAfterPermissionCancel,
      results: options.requests.flatMap(
        (request) => results.get(request) ?? [],
      ),
    };
  } finally {
    closed = true;
    signal.removeEventListener('abort', abortTools);
    for (const state of states.values()) {
      if (!state.settled) state.settleRelatedAgent?.(false);
      state.cleanupTracker?.();
    }
  }
}

/** The error a response gives the model, for a call that has no `error`. */
function responseErrorText(parts: readonly Part[]): string {
  for (const { functionResponse } of parts) {
    const response = functionResponse?.response;
    const text = response?.['error'] ?? response?.['output'];
    if (typeof text === 'string') return text;
  }
  return 'The tool call did not run.';
}

type ToolCallResponseLike = AgentLoopToolResult['response'] & {
  visionBridgeNotice?: string;
};

/** A replayed or repeated call id is answered without running, as a failure. */
function emitDuplicate(
  host: AcpToolBatchHost,
  { request, response }: AgentLoopToolResult,
  emit: (task: () => Promise<unknown>, what: string) => void,
): void {
  if (request.name === ToolNames.TODO_WRITE) {
    emit(
      () =>
        host.sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: response.callId,
          status: 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: response.error?.message ?? String(response.resultDisplay),
              },
            },
          ],
          rawOutput: response.resultDisplay,
          _meta: { toolName: request.name, provenance: 'builtin' },
        }),
      'duplicate tool update',
    );
    return;
  }
  emit(
    () =>
      host.toolCallEmitter.emitResult({
        callId: response.callId,
        toolName: request.name,
        args: request.args,
        message: response.responseParts,
        resultDisplay: response.resultDisplay,
        error: response.error,
        success: false,
        artifacts: response.artifacts,
        persistedOutputFiles: response.persistedOutputFiles,
      }),
    'duplicate tool update',
  );
}

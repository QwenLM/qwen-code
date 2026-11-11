/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPromptTooLongError } from '../../compression-v2/ptl-retry.js';
import { createAttachmentMessage } from '../../attachments/factory.js';
import { addAnthropicUsage } from '../../protocol/provider/usage-converter.js';
import { createAssistantAPIErrorMessage } from '../../protocol/transcript/conversions.js';
import { getAssistantTextBlocks } from '../../protocol/transcript/message-utils.js';
import { findModelInferenceError } from '../../provider/modelInferenceError.js';



import { toError } from '../../tools/abort-utils.js';
import { getErrorStatus } from '../../utils/httpErrors.js';
import { getResultErrorCode } from '../../utils/resultErrorCode.js';
import { runLogger } from '../../utils/runLogger.js';
import { businessInfoContext } from '../../utils/sessionIdContext.js';
import {
  isMalformedToolUseRetryDisabled,
  MalformedToolUseError,
  MalformedToolUseExhaustedError,
} from '../../core/malformed-tool-use.js';
import { MaxOutputTokensError } from '../../core/max-output-tokens.js';
import { logLoopFinished, makeLoopId } from '../../core/query-diagnostics.js';
import { CONTENT_FILTERED_MESSAGE } from '../../core/query-event.js';
import { resolveHookAfterResult } from '../../core/query-hook-continuation.js';
import {
  buildMalformedToolUseRecoveryState,
  buildMaxOutputTokensEscalationState,
  buildMaxOutputTokensRecoveryState,
  buildPromptTooLongRecoveryState,
  shouldRecoverFromMaxOutputTokens,
} from '../../core/query-recovery.js';
import {
  createContinuationState,
  getPendingUserMessage,
  type QueryRuntimeState,
} from '../../core/query-runtime-state.js';
import { classifyStopFailureError } from '../../core/stream-errors.js';
import { TOOL_STREAM_RECOVERY_LIMIT } from '../../core/tool-stream-settlement.js';
import { servesCustomProvider } from '../llm/request-preparation.js';
import { attributeSessionRoute } from '../llm/result-assembly.js';
import type {
  ModelResult,
  QueryRound,
  QueryState,
  SettledRound,
} from '../state.js';
import type { ConversationContext } from './context.js';
import {
  buildModelRequestErrorNotification,
  buildStreamRecoveryMessages,
  createModelRefusalError,
  createUserInterruptionMessage,
  getModelRequestIds,
  modelErrorForTranscript,
} from './presentation.js';
import { markTaskStarted } from './submit.js';

/** Writes what request preparation changed; called for every settled round. */
export function writePrepared(state: QueryState, round: QueryRound): void {
  const result = round.modelResult!;
  const { prepared } = result;
  state.runtime = prepared.runtime;
  state.sessionContextReason = prepared.sessionContextReason;
  if (prepared.model ?? round.selection) {
    state.model = prepared.model ?? round.selection;
  }
  state.task.trigger ??= round.taskTrigger;
  if (prepared.requestSent) {
    state.requestIndex = round.requestIndex;
    state.lastRequestPrefixMessages = prepared.requestPrefixMessages;
    if (round.dispatch) state.toolUseContext = round.dispatch.toolUseContext;
  }
  markTaskStarted(state);
}

export function needsToolSettlement(
  state: QueryState,
  result: ModelResult,
): boolean {
  return (
    state.input.params.toolExecutor !== undefined &&
    (result.dispatchedToolUseBlocks.length > 0 ||
      result.toolUseBlocks.length > 0)
  );
}

export async function handleLlmSettled(
  ctx: ConversationContext,
  round: QueryRound,
): Promise<void> {
  const result = round.modelResult!;
  if (result.outcome === 'failed' && result.failure !== 'max_tokens_escalatable') {
    await handleFailedRequest(ctx, round, result);
    return;
  }
  await handleResponse(ctx, round, result);
}

function settledRound(
  state: QueryState,
  round: QueryRound,
  result: ModelResult,
): SettledRound {
  return {
    round,
    result,
    modelMessage: result.modelMessage,
    usage: result.usage,
    toolUseBlocks: result.toolUseBlocks,
    assistantMessages: result.assistantMessages,
    responseText: result.responseText,
    interrupted: result.interrupted,
    terminalInterruption: result.terminalInterruption,
    canonicalModelKey:
      result.prepared.canonicalModelKey ?? state.model?.key ?? '',
    modelRequestId: result.prepared.modelRequestId,
    nextTurnCount: result.prepared.nextTurnCount,
    loopId: makeLoopId(state.input.params.promptId, state.requestIndex),
    streamRecoveryMessages: [],
  };
}

async function handleFailedRequest(
  ctx: ConversationContext,
  round: QueryRound,
  result: ModelResult,
): Promise<void> {
  const { state } = ctx;
  const { input } = state;
  const options = input.params;
  const settled = settledRound(state, round, result);
  state.flow.settled = settled;
  const { nextTurnCount } = settled;
  const needsTools = needsToolSettlement(state, result);

  switch (result.failure) {
    case 'aborted_before_request':
      ctx.emit(createUserInterruptionMessage());
      await ctx.finish({
        reason: 'abort',
        abortKind: 'aborted_streaming',
        ...ctx.terminalBase(state.runtime.turnCount),
      });
      return;
    case 'context_limit': {
      const contextLimitError = toError(result.error);
      const errorType = classifyStopFailureError(contextLimitError);
      ctx.emit(
        createAssistantAPIErrorMessage({
          content: contextLimitError.message,
          error: errorType,
          errorDetails: contextLimitError.message,
          errorFallbackMessage: contextLimitError.message,
        }),
      );
      await ctx.fireStopFailure(
        errorType,
        { errorDetails: contextLimitError.message },
        state.model?.key,
      );
      await ctx.finish({
        reason: 'error',
        error: contextLimitError,
        ...ctx.terminalBase(state.runtime.turnCount),
      });
      return;
    }
    case 'reactive_compact_failed':
      await handleRequestError(ctx, result.error, false);
      return;
    case 'aborted':
      for (const message of result.assistantMessages) ctx.emit(message);
      if (needsTools) {
        ctx.cancelTools('request_failed');
        ctx.afterTools({ kind: 'abort_streaming' });
        return;
      }
      await finishAbortStreaming(ctx, nextTurnCount);
      return;
    default:
      break;
  }

  const err = result.error;

  if (isPromptTooLongError(err)) {
    // 0. Try PTL truncation — drop oldest API-round groups to shed tokens.
    const promptTooLongRecoveryState = buildPromptTooLongRecoveryState({
      state: state.runtime,
      error: err,
    });
    const recovery = promptTooLongRecoveryState
      ? ({ reason: 'ptl' } as const)
      : options.compressionPipeline && !state.runtime.hasAttemptedReactiveCompact
        ? ({ reason: 'reactive_compact', cause: err } as const)
        : undefined;
    if (recovery) {
      if (promptTooLongRecoveryState) {
        runLogger.debug(
          `[AgentLoop] PTL truncation recovery: rebuilding state to trim context`,
        );
        state.runtime = promptTooLongRecoveryState;
      }
      if (needsTools) {
        ctx.cancelTools('request_failed');
        ctx.afterTools({ kind: 'release_then_request', ...recovery });
        return;
      }
      await ctx.request(recovery.reason, 'cause' in recovery ? recovery.cause : undefined);
      return;
    }
  }
  await handleRequestError(ctx, err, needsTools);
}

async function finishAbortStreaming(
  ctx: ConversationContext,
  numTurns: number,
): Promise<void> {
  ctx.emit(createUserInterruptionMessage());
  await ctx.finish({
    reason: 'abort',
    abortKind: 'aborted_streaming',
    ...ctx.terminalBase(numTurns),
  });
}

async function handleRequestError(
  ctx: ConversationContext,
  err: unknown,
  needsTools: boolean,
): Promise<void> {
  ctx.emit(
    buildModelRequestErrorNotification(
      err,
      ctx.state.flow.settled!.canonicalModelKey,
      ctx.state.model?.resolution.model.source ?? '',
    ),
  );
  const isModelRefusal = getErrorStatus(err) === 406;
  if (needsTools) {
    for (const message of ctx.state.flow.settled!.result.assistantMessages) {
      ctx.emit(message);
    }
    ctx.cancelTools(isModelRefusal ? 'refusal' : 'request_failed');
    ctx.afterTools({ kind: 'request_error', error: err, isModelRefusal });
    return;
  }
  if (isModelRefusal) ctx.state.control.turnAbort.abort('Model response refused');
  await finishRequestError(ctx, err, isModelRefusal);
}

/** Persists the API error and terminates; called once tools are settled. */
export async function finishRequestError(
  ctx: ConversationContext,
  err: unknown,
  isModelRefusal: boolean,
): Promise<void> {
  const { state } = ctx;
  const settled = ctx.state.flow.settled!;
  // Shared error metadata for transcript persistence and hook notification
  const errorDetails =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  const errorCode = getResultErrorCode(err);
  const errorMessage = toError(err).message;
  const providerFailure = findModelInferenceError(err);
  const errorType = isModelRefusal
    ? 'invalid_request'
    : classifyStopFailureError(err);

  // Persist API error to transcript as a synthetic AssistantMessage
  ctx.emit(
    createAssistantAPIErrorMessage({
      content: errorMessage,
      error: errorType,
      errorDetails,
      displayErrorCode: errorCode,
      errorFallbackMessage: errorMessage,
      ...(providerFailure && state.model
        ? {
            modelError: modelErrorForTranscript(
              err,
              state.model.resolution.model.source,
            ),
          }
        : {}),
      isContentFilteredMessage: isModelRefusal,
    }),
  );

  const lastAssistantMsg = state.runtime.messages.findLast(
    (m): m is Extract<typeof m, { type: 'assistant' }> => m.type === 'assistant',
  );
  const lastAssistantText = lastAssistantMsg
    ? getAssistantTextBlocks(lastAssistantMsg).join('') || undefined
    : undefined;
  await ctx.fireStopFailure(
    errorType,
    { errorDetails, lastAssistantMessage: lastAssistantText },
    settled.canonicalModelKey,
  );

  // Keep the original Provider failure; hosts own presentation.
  await ctx.finish({
    reason: 'error',
    ...(isModelRefusal ? { modelStopReason: 'refusal' as const } : {}),
    error: toError(err),
    ...getModelRequestIds(err),
    ...ctx.terminalBase(settled.nextTurnCount),
  });
}

async function handleResponse(
  ctx: ConversationContext,
  round: QueryRound,
  result: ModelResult,
): Promise<void> {
  const { state } = ctx;
  const { input } = state;
  const options = input.params;
  const { promptId, permissionMode, maxTurns, toolRegistry } = options;
  const sid = input.sessionId;
  const lifecycle = state.lifecycle!;
  const settled = settledRound(state, round, result);
  state.flow.settled = settled;
  const modelMessage = result.modelMessage!;
  const usage = result.usage!;
  const {
    interrupted,
    toolUseBlocks,
    assistantMessages,
    responseText,
    nextTurnCount,
    canonicalModelKey,
    modelRequestId,
  } = settled;
  const needsTools = needsToolSettlement(state, result);
  const cancelled = state.control.abort.signal;

  lifecycle.changeBusinessState();
  state.usage = addAnthropicUsage(state.usage, usage);
  // The budget bounds consecutive interruptions, not a turn's total.
  if (!interrupted) state.toolStreamRecoveryCount = 0;

  const malformedToolUse = result.malformedToolUse;
  const wasMalformedToolUseRetry = state.runtime.malformedToolUseRetryCount === 1;
  if (wasMalformedToolUseRetry) {
    // On a retry turn: report the outcome, then clear the flag if we recovered.
    if (!malformedToolUse) {
      state.runtime = { ...state.runtime, malformedToolUseRetryCount: 0 };
    }
  }

  if (result.failure === 'max_tokens_escalatable') {
    runLogger.debug(
      `[AgentLoop] max-output-tokens escalation: ${state.runtime.maxOutputTokensOverride ?? state.model?.initialMaxOutputTokens} → ${result.nextMaxOutputTokens}, retrying`,
    );
    state.runtime = buildMaxOutputTokensEscalationState({
      state: state.runtime,
      nextMaxOutputTokens: result.nextMaxOutputTokens!,
    });
    state.cumulativeResponseText = '';
    await ctx.request('escalation');
    return;
  }

  for (const assistantMessage of assistantMessages) ctx.emit(assistantMessage);

  if (interrupted) {
    if (
      interrupted.failure.error instanceof MaxOutputTokensError &&
      (cancelled.aborted || interrupted.failure.kind === 'abort')
    ) {
      // 清理连接期间的用户取消优先于输出截断，原始原因仅保留在 cause 中。
      interrupted.failure.kind = 'abort';
      interrupted.failure.error = Object.assign(
        new Error('Operation aborted', { cause: interrupted.failure.error }),
        { name: 'AbortError' },
      );
    }
    const isRefusal = interrupted.failure.kind === 'refusal';
    const providerFailure = findModelInferenceError(interrupted.failure.error);
    const outputLimitPresentation =
      interrupted.failure.kind === 'terminal' &&
      interrupted.failure.error instanceof MaxOutputTokensError
        ? {
            displayErrorCode: interrupted.failure.error.code,
            fallbackMessage: interrupted.failure.error.message,
          }
        : undefined;
    if (isRefusal && !providerFailure) {
      // Normalize once for both empty snapshots and delivered-tool cleanup.
      interrupted.failure.error = createModelRefusalError(
        interrupted.failure.error,
      );
    }
    const errorDetails = isRefusal
      ? toError(interrupted.failure.error).message
      : String(interrupted.failure.error);
    const terminalInterruption = settled.terminalInterruption;
    const interruptionNotice = terminalInterruption
      ? 'Model response interrupted. Completed output is preserved; automatic continuation stopped.'
      : toolUseBlocks.length > 0
        ? 'Model response interrupted. Settling delivered tools before continuing.'
        : 'Model response interrupted. Continuing with the preserved output.';
    ctx.emit(
      createAssistantAPIErrorMessage({
        content:
          terminalInterruption && providerFailure
            ? providerFailure.message
            : outputLimitPresentation
              ? outputLimitPresentation.fallbackMessage
              : isRefusal
                ? errorDetails
                : interruptionNotice,
        error: classifyStopFailureError(interrupted.failure.error),
        errorDetails,
        isContentFilteredMessage: isRefusal,
        ...(outputLimitPresentation
          ? {
              displayErrorCode: outputLimitPresentation.displayErrorCode,
              errorFallbackMessage: outputLimitPresentation.fallbackMessage,
            }
          : {}),
        ...(isRefusal
          ? {
              displayErrorCode: 406,
              errorFallbackMessage: CONTENT_FILTERED_MESSAGE,
            }
          : {}),
        ...(terminalInterruption && providerFailure && state.model
          ? {
              modelError: modelErrorForTranscript(
                interrupted.failure.error,
                state.model.resolution.model.source,
              ),
              displayErrorCode: providerFailure.code,
              errorFallbackMessage: providerFailure.message,
            }
          : {}),
      }),
    );
    if (toolUseBlocks.length === 0 && terminalInterruption) {
      state.control.turnAbort.abort('Model stream interrupted');
      ctx.checkpointTurn();
      await ctx.fireStopFailure(
        classifyStopFailureError(interrupted.failure.error),
        {
          errorDetails,
          ...(isRefusal ? { lastAssistantMessage: responseText || undefined } : {}),
        },
        canonicalModelKey,
      );
      await ctx.finish({
        reason: interrupted.failure.kind === 'abort' ? 'abort' : 'error',
        ...(isRefusal ? { modelStopReason: 'refusal' as const } : {}),
        error: toError(interrupted.failure.error),
        ...ctx.terminalBase(nextTurnCount),
      });
      return;
    }
  }

  // A model refusal is a successful transport-level completion but a failed
  // agent turn. Preserve the partial assistant response and final usage, then
  // terminate before tools, recovery, memory refresh, or continuation hooks.
  if (!interrupted && modelMessage.stopReason === 'refusal') {
    if (needsTools) {
      ctx.cancelTools('refusal');
      ctx.afterTools({ kind: 'refusal' });
      return;
    }
    await finishRefusal(ctx);
    return;
  }

  if (malformedToolUse) {
    const retryDisabled = isMalformedToolUseRetryDisabled();
    const maxTurnsBlocked = maxTurns != null && nextTurnCount >= maxTurns;
    const toolCapabilityBlocked =
      !toolRegistry || result.prepared.toolSchemas.length === 0;
    const willRetry =
      !wasMalformedToolUseRetry &&
      !retryDisabled &&
      !maxTurnsBlocked &&
      !toolCapabilityBlocked;



    if (willRetry) {
      ctx.emit({ type: 'result_text_reset', reason: 'malformed_tool_use_retry' });
      const recovery = buildMalformedToolUseRecoveryState({
        state: state.runtime,
        assistantMessages,
        promptId,
        permissionMode,
        nextTurnCount,
      });
      ctx.emit(recovery.correctiveMessage);
      state.runtime = recovery.state;
      state.cumulativeResponseText = '';
      await ctx.request('malformed');
      return;
    }

    const malformedError = wasMalformedToolUseRetry
      ? new MalformedToolUseExhaustedError()
      : new MalformedToolUseError();
    const errorType = classifyStopFailureError(malformedError);
    ctx.emit(
      createAssistantAPIErrorMessage({
        content: malformedError.message,
        error: errorType,
        errorDetails: malformedError.message,
        errorFallbackMessage: malformedError.message,
      }),
    );
    await ctx.fireStopFailure(
      errorType,
      {
        errorDetails: malformedError.message,
        lastAssistantMessage: responseText || undefined,
      },
      canonicalModelKey,
    );
    logLoopFinished({
      sessionId: sid,
      promptId,
      loopId: settled.loopId,
      requestIndex: state.requestIndex,
      reason: 'malformed_tool_use',
      data: {
        stop_reason: modelMessage.stopReason,
        retry_exhausted: wasMalformedToolUseRetry,
      },
    });
    await ctx.finish({
      reason: 'error',
      modelStopReason: 'tool_use',
      error: malformedError,
      requestId: modelRequestId,
      ...ctx.terminalBase(nextTurnCount),
    });
    return;
  }

  if (!interrupted) ctx.checkpointTurn();

  const stateAfterAssistantBase: QueryRuntimeState = {
    ...state.runtime,
    messages: [...state.runtime.messages, ...assistantMessages],
    pendingUserMessageUuid: undefined,
    turnCount: nextTurnCount,
    transition: undefined,
    // PTL retries are bounded between successful main requests, not across
    // the whole query. A partial, interrupted response keeps its budget.
    compressionState: interrupted
      ? state.runtime.compressionState
      : { promptTooLongRetryCount: 0 },
  };
  state.runtime = stateAfterAssistantBase;
  state.cumulativeResponseText += responseText;

  if (toolUseBlocks.length === 0) {
    // Recovery path: if truncated by max_tokens, inject a continuation prompt
    // so the model can resume; the current recovery count bounds it.
    if (
      !cancelled.aborted &&
      !interrupted &&
      shouldRecoverFromMaxOutputTokens(modelMessage.stopReason ?? null)
    ) {
      const recoveryState = buildMaxOutputTokensRecoveryState({
        state: stateAfterAssistantBase,
        promptId,
        permissionMode,
      });
      if (recoveryState) {
        runLogger.debug(
          `[AgentLoop] max-output-tokens continuation: injecting resume prompt (recovery #${stateAfterAssistantBase.maxOutputTokensRecoveryCount ?? 0})`,
        );
        const recoveryMessage = getPendingUserMessage(recoveryState);
        if (recoveryMessage) ctx.emit(recoveryMessage);
        state.runtime = recoveryState;
        state.cumulativeResponseText = '';
        await ctx.request('truncation');
        return;
      }

      // 恢复预算耗尽后必须失败结算，不能落入无工具调用的成功出口。
      const error = new MaxOutputTokensError();
      const errorType = classifyStopFailureError(error);
      ctx.emit(
        createAssistantAPIErrorMessage({
          content: error.message,
          error: errorType,
          errorDetails: error.message,
          displayErrorCode: error.code,
          errorFallbackMessage: error.message,
        }),
      );
      await ctx.fireStopFailure(
        errorType,
        {
          errorDetails: error.message,
          lastAssistantMessage: responseText || undefined,
        },
        canonicalModelKey,
      );
      logLoopFinished({
        sessionId: sid,
        promptId,
        loopId: settled.loopId,
        requestIndex: state.requestIndex,
        reason: 'max_output_tokens',
        data: {
          stop_reason: modelMessage.stopReason,
          recovery_count: stateAfterAssistantBase.maxOutputTokensRecoveryCount,
        },
      });
      await ctx.finish({
        reason: 'error',
        modelStopReason: 'max_tokens',
        error,
        requestId: modelRequestId,
        ...ctx.terminalBase(nextTurnCount),
      });
      return;
    }
  }

  // Reset max-output-tokens state after the recovery escape hatch.
  const stateAfterAssistant: QueryRuntimeState = {
    ...stateAfterAssistantBase,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
  };
  state.runtime = stateAfterAssistant;
  settled.stateAfterAssistant = stateAfterAssistant;

  // An interrupted response continues in a new request that carries the
  // retained output, paired results for calls that never reached the
  // executor, and one request-level reminder.
  if (interrupted && state.model) {
    const model = state.model;
    const projectionOptions = result.prepared.projectionOptions ?? {};
    settled.streamRecoveryMessages = buildStreamRecoveryMessages({
      interrupted,
      message: modelMessage,
      attributeSessionRoute: (message) =>
        attributeSessionRoute(
          message,
          servesCustomProvider(model),
          projectionOptions,
        ),
      promptId,
      responseGroupId: result.prepared.responseGroupId!,
    });
  }
  const streamRecoveryMessages = settled.streamRecoveryMessages;

  if (cancelled.aborted && !interrupted) {
    if (needsTools) {
      ctx.afterTools({ kind: 'aborted_after_assistant' });
      return;
    }
    await finishAbortedAfterAssistant(ctx);
    return;
  }

  if (interrupted && toolUseBlocks.length === 0) {
    // Terminal interruptions without tools already finished above.
    for (const message of streamRecoveryMessages) ctx.emit(message);
    ctx.checkpointTurn(streamRecoveryMessages);
    logLoopFinished({
      sessionId: sid,
      promptId,
      loopId: settled.loopId,
      requestIndex: state.requestIndex,
      level: 'warn',
      reason: 'continue_after_interruption',
      data: { stop_reason: modelMessage.stopReason },
    });
    if (await waitBeforeContinuation(ctx, interrupted.failure.error)) return;
    state.cumulativeResponseText = '';
    state.runtime = createContinuationState(
      stateAfterAssistant,
      {
        messages: [...stateAfterAssistant.messages, ...streamRecoveryMessages],
        pendingUserMessageUuid: undefined,
      },
      { reason: 'next_turn' },
    );
    await ctx.request('stream_recovery');
    return;
  }

  if (toolUseBlocks.length === 0) {
    await runStopHook(ctx, stateAfterAssistant);
    return;
  }

  // If there is no tool executor, tool_use is unexpected
  if (!options.toolExecutor) {
    await ctx.finish({
      reason: 'error',
      error: new Error(
        'Unexpected tool_use: this loop does not support tool execution',
      ),
      ...ctx.terminalBase(nextTurnCount),
    });
    return;
  }

  if (interrupted && settled.terminalInterruption) {
    ctx.cancelTools('terminal_interruption');
  }
  ctx.afterTools({ kind: 'tool_results' });
}

/** Refusal after tools (if any) are settled. */
export async function finishRefusal(ctx: ConversationContext): Promise<void> {
  const { state } = ctx;
  const options = state.input.params;
  const settled = state.flow.settled!;
  const refusalError = createModelRefusalError(undefined);
  const errorType = classifyStopFailureError(refusalError);
  state.control.turnAbort.abort('Model response refused');
  if (state.round?.toolSummary) {
    for (const message of state.round.toolSummary.historyMessages) {
      ctx.emit(message);
    }
  }
  ctx.emit(
    createAssistantAPIErrorMessage({
      content: CONTENT_FILTERED_MESSAGE,
      error: errorType,
      errorDetails: refusalError.message,
      displayErrorCode: 406,
      errorFallbackMessage: CONTENT_FILTERED_MESSAGE,
      isContentFilteredMessage: true,
    }),
  );
  await ctx.fireStopFailure(
    errorType,
    {
      errorDetails: refusalError.message,
      lastAssistantMessage: settled.responseText || undefined,
    },
    settled.canonicalModelKey,
  );
  logLoopFinished({
    sessionId: state.input.sessionId,
    promptId: options.promptId,
    loopId: settled.loopId,
    requestIndex: state.requestIndex,
    reason: 'model_refusal',
    data: { stop_reason: settled.modelMessage?.stopReason },
  });
  await ctx.finish({
    reason: 'error',
    modelStopReason: 'refusal',
    error: refusalError,
    requestId: settled.modelRequestId,
    ...ctx.terminalBase(settled.nextTurnCount),
  });
}

export async function finishAbortedAfterAssistant(
  ctx: ConversationContext,
): Promise<void> {
  const { state } = ctx;
  const settled = state.flow.settled!;
  if (state.round?.toolSummary) {
    for (const message of state.round.toolSummary.historyMessages) {
      ctx.emit(message);
    }
  }
  ctx.emit(createUserInterruptionMessage());
  logLoopFinished({
    sessionId: state.input.sessionId,
    promptId: state.input.params.promptId,
    loopId: settled.loopId,
    requestIndex: state.requestIndex,
    reason: 'aborted_after_assistant',
    data: { stop_reason: settled.modelMessage?.stopReason },
  });
  await ctx.finish({
    reason: 'abort',
    abortKind: 'aborted_streaming',
    ...ctx.terminalBase(settled.nextTurnCount),
  });
}

export async function finishAbortStreamingAfterTools(
  ctx: ConversationContext,
): Promise<void> {
  const summary = ctx.state.round?.toolSummary;
  for (const message of summary?.historyMessages ?? []) ctx.emit(message);
  await finishAbortStreaming(ctx, ctx.state.flow.settled!.nextTurnCount);
}

/**
 * Continuation budget: continue only within consecutive interruptions.
 * Returns true when the query was finished instead.
 */
export async function waitBeforeContinuation(
  ctx: ConversationContext,
  error: unknown,
): Promise<boolean> {
  const { state } = ctx;
  const settled = ctx.state.flow.settled!;
  const maxTurns = state.input.params.maxTurns;
  // 没有剩余轮次就不退避：下一轮入口会按 max_turns 正常收尾。
  if (maxTurns != null && settled.nextTurnCount >= maxTurns) return false;
  if (state.toolStreamRecoveryCount >= TOOL_STREAM_RECOVERY_LIMIT) {
    await ctx.fireStopFailure(
      classifyStopFailureError(error),
      { errorDetails: String(error) },
      settled.canonicalModelKey,
    );
    await ctx.finish({
      reason: 'error',
      error: toError(error),
      ...ctx.terminalBase(settled.nextTurnCount),
    });
    return true;
  }
  state.toolStreamRecoveryCount++;
  return false;
}

async function runStopHook(
  ctx: ConversationContext,
  stateAfterAssistant: QueryRuntimeState,
): Promise<void> {
  const { state, hookCoordinator } = ctx;
  const { input } = state;
  const options = input.params;
  const settled = ctx.state.flow.settled!;
  const lifecycle = state.lifecycle!;
  const { promptId, permissionMode } = options;
  const finishData = (reason: string) =>
    logLoopFinished({
      sessionId: input.sessionId,
      promptId,
      loopId: settled.loopId,
      requestIndex: state.requestIndex,
      reason,
      data: { stop_reason: settled.modelMessage?.stopReason },
    });
  // No tool calls → done. Fire after-hook before returning.
  if (hookCoordinator) {
    const afterResult = await businessInfoContext.run(lifecycle.businessInfo, () =>
      hookCoordinator.fireAfter(
        promptId,
        input.promptText,
        state.cumulativeResponseText,
        {
          requestId: settled.modelRequestId,
          stopHookActive: stateAfterAssistant.stopHookActive,
          parentRequestSetId: lifecycle.requestSetId,
          parentBusinessInfo: lifecycle.businessInfo,
          customContext: options.customContext,
          model: settled.canonicalModelKey,
        },
      ),
    );
    for (const att of afterResult?.pendingAttachments ?? []) {
      ctx.emit(createAttachmentMessage(att));
    }
    const continuation = resolveHookAfterResult({
      afterResult,
      state: stateAfterAssistant,
      promptId,
      permissionMode,
    });
    if (continuation.terminalReason === 'stopped') {
      finishData('stopped_by_after_hook');
      await ctx.finish({
        reason: 'end_turn',
        terminalDetail: 'hook_stopped',
        ...ctx.terminalBase(settled.nextTurnCount),
      });
      return;
    }
    if (continuation.continuationMessage && continuation.nextState) {
      runLogger.debug(
        `[AgentLoop] after-hook requested continuation, re-entering loop`,
      );
      ctx.emit(continuation.continuationMessage);
      state.runtime = continuation.nextState;
      state.cumulativeResponseText = '';
      await ctx.request('stop_hook');
      return;
    }
  }
  finishData('end_turn');
  await ctx.finish({
    reason: 'end_turn',
    ...ctx.terminalBase(settled.nextTurnCount),
  });
}


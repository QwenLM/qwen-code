/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPromptTooLongError } from '../compression-v2/ptl-retry.js';
import { annotateContextUsageRatio } from '../protocol/provider/usage-converter.js';
import { getErrorStatus } from '../utils/httpErrors.js';
import {
  getDeliveredModelMessage,
  projectModelUsage,
} from '../core/model-response-to-query-event.js';
import {
  getEscalatedMaxOutputTokens,
  shouldRecoverFromMaxOutputTokens,
} from '../core/query-recovery.js';
import { TOOL_STREAM_RECOVERY_LIMIT } from '../core/tool-stream-settlement.js';
import type { QueryEventBus } from './bus.js';
import type { AnyBusEvent, LlmFailureKind } from './events.js';
import { emitOutput, publishFor } from './handler-support.js';
import { runInference, type InferenceResult } from './llm/inference-round.js';
import {
  prepareRequest,
  servesCustomProvider,
  type AssembledRequest,
  type LlmRoundContext,
} from './llm/request-preparation.js';
import {
  extractToolUseBlocks,
  splitAssistantMessage,
  attributeSessionRoute,
} from './llm/result-assembly.js';
import {
  currentRound,
  type ModelResult,
  type PreparedRequest,
  type QueryRound,
  type QueryState,
  type QueryStateStore,
} from './state.js';

/**
 * Prepares and runs one model request per llm.request. Writes only
 * round.modelResult and reports failures without recovering from them.
 */
export class LlmHandler {
  constructor(
    private readonly bus: QueryEventBus,
    private readonly store: QueryStateStore,
  ) {}

  register(): () => void {
    return this.bus.subscribe('llm', ['llm.request'], (event) =>
      this.handle(event),
    );
  }

  // Callbacks only start work; cancellation reaches inference through the state's signal.
  private handle(event: AnyBusEvent): void {
    const state = this.store.get(event.queryId);
    if (!state || event.type !== 'llm.request') return;
    const round = currentRound(state, event.roundId);
    if (!round) return;
    state.input.runInContext(() => {
      void this.runRound(state, round).catch((error: unknown) => {
        this.bus.reportFailure('llm', event, error);
      });
    });
  }

  private async runRound(state: QueryState, round: QueryRound): Promise<void> {
    const ctx: LlmRoundContext = {
      state,
      round,
      signal: state.control.abort.signal,
      emit: (output) => emitOutput(this.bus, state, output),
    };
    const preparation = await prepareRequest(ctx);
    if (preparation.kind === 'stopped') {
      this.settle(state, round, {
        ...emptyResult(preparation.prepared),
        outcome: 'failed',
        failure: preparation.failure,
        error: preparation.error,
      });
      return;
    }
    const inference = await runInference(
      ctx,
      preparation.request,
      (block, responseId, assistantMessageUuid) =>
        publishFor(
          this.bus,
          state,
          'llm.tool_use',
          { block, responseId, assistantMessageUuid },
          round.roundId,
        ),
    );
    this.settle(
      state,
      round,
      assembleModelResult(
        ctx,
        preparation.prepared,
        preparation.request,
        inference,
      ),
    );
  }

  private settle(state: QueryState, round: QueryRound, result: ModelResult) {
    if (this.store.get(state.input.queryId) !== state) return;
    if (state.round !== round || round.modelResult) return;
    round.modelResult = result;
    const assistantMessageUuid = result.assistantMessages.at(-1)?.uuid;
    publishFor(
      this.bus,
      state,
      'llm.settled',
      {
        outcome: result.outcome,
        ...(result.failure ? { failure: result.failure } : {}),
        ...(result.modelMessage?.stopReason
          ? { stopReason: result.modelMessage.stopReason }
          : {}),
        ...(result.nextMaxOutputTokens !== undefined
          ? { nextMaxOutputTokens: result.nextMaxOutputTokens }
          : {}),
        ...(assistantMessageUuid ? { assistantMessageUuid } : {}),
        toolUseIds: result.toolUseBlocks.map((block) => block.id),
        dispatchedToolUseIds: result.dispatchedToolUseBlocks.map(
          (block) => block.id,
        ),
        terminalInterruption: result.terminalInterruption,
        requestSent: result.prepared.requestSent,
      },
      round.roundId,
    );
  }
}

function emptyResult(prepared: PreparedRequest): ModelResult {
  return {
    outcome: 'failed',
    prepared,
    terminalInterruption: false,
    toolUseBlocks: [],
    dispatchedToolUseBlocks: [],
    responseText: '',
    malformedToolUse: false,
    assistantMessages: [],
    iterationHadThought: false,
  };
}

function classifyRequestFailure(
  error: unknown,
  signal: AbortSignal,
): LlmFailureKind {
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return 'aborted';
  }
  if (isPromptTooLongError(error)) return 'ptl';
  if (getErrorStatus(error) === 406) return 'refusal_406';
  return 'transport';
}

/** Classifies the response and splits it for history; writes nothing. */
function assembleModelResult(
  ctx: LlmRoundContext,
  prepared: PreparedRequest,
  assembled: AssembledRequest,
  inference: InferenceResult,
): ModelResult {
  const { state, signal } = ctx;
  const { config } = state.input;
  const { model, modelRequestId, responseGroupId, capturedMcpIdentities } =
    assembled;
  const base: ModelResult = {
    ...emptyResult(prepared),
    dispatchedToolUseBlocks: inference.dispatchedToolUseBlocks,
    iterationHadThought: inference.iterationHadThought,
  };
  const { outcome } = inference;
  if (outcome.kind === 'error') {
    return {
      ...base,
      outcome: 'failed',
      failure: classifyRequestFailure(outcome.error, signal),
      error: outcome.error,
      toolUseBlocks: inference.dispatchedToolUseBlocks,
      assistantMessages: inference.dispatchedAssistantMessages,
    };
  }

  const interrupted =
    outcome.kind === 'interrupted' ? outcome.value : undefined;
  const modelMessage = interrupted
    ? getDeliveredModelMessage(interrupted.message, interrupted.delivery)
    : outcome.value.message;
  const terminalInterruption = interrupted
    ? interrupted.failure.kind !== 'transport' ||
      state.toolStreamRecoveryCount >= TOOL_STREAM_RECOVERY_LIMIT ||
      signal.aborted
    : false;

  // 旧用量格式只在统计、Hook 与历史边界使用。
  const usage = projectModelUsage(modelMessage.usage, modelRequestId);
  if (!interrupted) {
    annotateContextUsageRatio(
      usage,
      model.resolution.config.context?.contextWindow ??
        model.resolution.model.limits.maxContextTokens,
    );
  }
  const toolUseBlocks = extractToolUseBlocks(
    modelMessage,
    config,
    capturedMcpIdentities,
  );
  let responseText = '';
  for (const block of modelMessage.blocks) {
    // Interrupted snapshots keep sparse block indexes.
    if (
      block !== null &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      responseText += block.text;
    }
  }
  // 复用已筛选的工具数量，停止原因直接读取标准模型结果。
  const malformedToolUse =
    !interrupted &&
    modelMessage.stopReason === 'tool_use' &&
    toolUseBlocks.length === 0;
  const result: ModelResult = {
    ...base,
    outcome: interrupted ? 'interrupted' : 'complete',
    modelMessage,
    interrupted,
    terminalInterruption,
    usage,
    toolUseBlocks,
    responseText,
    malformedToolUse,
  };

  if (
    !interrupted &&
    toolUseBlocks.length === 0 &&
    shouldRecoverFromMaxOutputTokens(modelMessage.stopReason ?? null)
  ) {
    const escalated = getEscalatedMaxOutputTokens({
      currentOverride: prepared.runtime.maxOutputTokensOverride,
      requestedMaxOutputTokens: model.initialMaxOutputTokens,
      modelMaxOutputTokens: model.resolution.model.limits.maxOutputTokens,
    });
    if (escalated !== null) {
      return {
        ...result,
        outcome: 'failed',
        failure: 'max_tokens_escalatable',
        nextMaxOutputTokens: escalated,
      };
    }
  }

  const assistantMessages = splitAssistantMessage(modelMessage, {
    requestId: modelRequestId,
    responseGroupId,
    usage,
    config,
    capturedMcpIdentities,
    interrupted: !!interrupted,
    includeEmpty: malformedToolUse,
    streamedToolAssistantMessages: new Map(
      inference.dispatchedToolUseBlocks.map((block, index) => [
        block.id,
        inference.dispatchedAssistantMessages[index]!,
      ]),
    ),
  });
  // Attribute the actual session route, independently of another session's catalog projection.
  for (const assistantMessage of assistantMessages) {
    attributeSessionRoute(
      assistantMessage,
      servesCustomProvider(model),
      assembled.projectionOptions,
    );
  }
  if (signal.aborted && modelMessage.stopReason === undefined) {
    for (const assistantMessage of assistantMessages) {
      assistantMessage.aborted = true;
    }
  }
  const requestTokenAnchor = assembled.completeRequestTokenAnchor(
    assistantMessages.flatMap((assistant) => assistant.message.content),
    modelRequestId,
  );
  for (const assistantMessage of assistantMessages) {
    assistantMessage.requestTokenAnchor = requestTokenAnchor;
  }
  return { ...result, assistantMessages };
}

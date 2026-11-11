/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  modelRequestObservationError,
  observationElapsedMs,
  observationMonotonicNow,
  observationWaitFailureStatus,
} from '../model-request/observation.js';
import {
  onModelRequestObservation,
  SINGLE_REQUEST_FORK,
  publishModelRequestObservation,
} from '../model-request/request-scope.js';
import { isResumableStreamFailure } from '../model-request/stream-interruption.js';
import type {
  ModelRequestDiagnostic,
  ModelRequestObserver,
  ModelRequestOutcome,
  ModelRequestRunnerEvent,
} from '../model-request/types.js';
import {
  areSystemPromptBlocksEnabled,
  systemPromptToText,
} from '../prompts/system-prompt.js';
import type { SystemPrompt } from '../prompts/types.js';
import {
  convertMessages,
  getMaxRequestImages,
} from '../protocol/provider/request-converter.js';
import {
  annotateContextUsageRatio,
  getThinkingTokenCount,
} from '../protocol/provider/usage-converter.js';
import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type {
  ModelPrompt,
  ModelStreamMessage,
  ModelStreamRequest,
  ModelStreamTool,
  ModelToolChoice,
} from '../provider/modelStreamRequest.js';
import type { ModelStreamResponse } from '../provider/modelStreamResponse.js';



import { raceSingleRequestResponseWithAbortSignal } from '../utils/abort-race.js';
import { emitModelRequestPrefix } from '../utils/diagnosticInterceptors.js';
import { isAbortErrorDeep } from '../utils/errors.js';
import { getErrorStatus } from '../utils/httpErrors.js';
import {
  convertModelResponse,
  createModelResponseDelivery,
  getDeliveredModelMessage,
  projectModelUsage,
} from './model-response-to-query-event.js';
import { classifyStopFailureError } from './stream-errors.js';

export function taskIdForQuerySource(
  querySource: string | undefined,
): string | undefined {
  if (querySource === 'prompt_suggestion') {
    return 'agent_summary';
  }
  return undefined;
}

/** Request observation context shared by the agent loop and single-request forks. */
interface ModelRequestExecutionContext {
  readonly onMainPromptTokenCount?: (inputTokens: number) => void;
  readonly diagnostic?: ModelRequestDiagnostic & {
    requestMessagesBuildDurationMs?: number;
  };
}

/**
 * Execute a single provider request as an async generator.
 *
 * Yields:
 *   - StreamEvent for every SSE frame
 *   - AssistantBlockEvent immediately before each content_block_stop frame
 *
 * Returns the complete response or an interrupted response snapshot.
 */
export async function* streamProviderRequest(
  config: Config | undefined,
  request: ModelStreamRequest & {
    readonly qoder: {
      readonly identity: {
        readonly sessionId?: string;
        readonly requestId: string;
        readonly requestSetId?: string;
      };
    };
  },
  context: ModelRequestExecutionContext,
): AsyncGenerator<ModelRequestRunnerEvent, ModelRequestOutcome> {
  const { diagnostic } = context;
  const signal = request.control?.signal;
  const model = request.resolution.model.key;
  const { requestSetId, requestId } = request.qoder.identity;
  if (!config?.hasModelProviderManager()) {
    throw new Error('A session ModelProvider is required for inference.');
  }
  const provider = config.getModelProviderManager();
  const contextWindow =
    request.resolution.config.context?.contextWindow ??
    request.resolution.model.limits.maxContextTokens;
  const startedAt = Date.now();
  const startedMonotonic = observationMonotonicNow();
  const observationIdentity = {
    sessionId: request.qoder.identity.sessionId ?? '',
    requestSetId: requestSetId ?? '',
    requestId,
  };
  let observationObserver: ModelRequestObserver | undefined;
  try {
    observationObserver = diagnostic?.onObservation;
  } catch {
    // Optional diagnostic access must not prevent inference.
  }
  let providerObservedAttempts = false;
  const observer = observationObserver;
  const unsubscribeObservation = observer
    ? onModelRequestObservation(observationIdentity, (record) => {
        if (record.kind === 'request_started') providerObservedAttempts = true;
        return observer(record);
      })
    : () => {};
  let firstEventAt: number | undefined;
  let fallbackObserved = false;
  // Providers with their own attempt observations own the complete sequence.
  // Others get one logical pair after their result is known, using the actual
  // start timestamp. No observation data is added to the inference request.
  const observeFallback = (
    status: 'success' | 'error' | 'abort',
    message?: ModelMessage,
    error?: unknown,
  ) => {
    try {
      if (!observationObserver || providerObservedAttempts || fallbackObserved)
        return;
      fallbackObserved = true;
      const completedAt = Date.now();
      const latencyMs =
        observationElapsedMs(startedMonotonic) ??
        Math.max(0, completedAt - startedAt);
      const usage: Record<string, number> = {};
      for (const [target, source] of [
        ['input_tokens', 'inputTokens'],
        ['output_tokens', 'outputTokens'],
        ['cache_read_tokens', 'cacheReadInputTokens'],
        ['cache_write_tokens', 'cacheCreationInputTokens'],
        ['thinking_tokens', 'reasoningTokens'],
      ] as const) {
        const value = message?.usage?.[source];
        if (typeof value === 'number' && Number.isFinite(value))
          usage[target] = value;
      }
      publishModelRequestObservation(observationIdentity, {
        kind: 'request_started',
        request_id: requestId,
        initial_request_id: requestId,
        model,
        at_ms: startedAt,
        attempt: 1,
        data: {
          request_start_at: startedAt,
          request_attempt: 1,
          retry_count: 0,
        },
      });
      publishModelRequestObservation(observationIdentity, {
        kind: 'request_finished',
        request_id: requestId,
        initial_request_id: requestId,
        model,
        at_ms: completedAt,
        attempt: 1,
        data: {
          status,
          latency_ms: latencyMs,
          ...(firstEventAt === undefined
            ? {}
            : { ttft_ms: Math.max(0, firstEventAt - startedAt) }),
          retry_count: 0,
          ...modelRequestObservationError(error),
          ...(message?.stopReason ? { finish_reason: message.stopReason } : {}),
          ...(Object.keys(usage).length ? { usage } : {}),
        },
      });
    } catch {
      // Fallback diagnostics never own a Provider result or cancellation.
    }
  };
  const delivery = createModelResponseDelivery();
  const finish = (finishReason?: string, error?: unknown) => {
    try {
      diagnostic?.onFinished?.({
        requestId,
        model,
        success: error === undefined,
        attemptCount: 1,
        retryCount: 0,
        finishReason,
        ...(error !== undefined
          ? { failureReason: classifyStopFailureError(error) }
          : {}),
      });
    } catch {
      // Observability callbacks must never affect the model request path.
    }
  };
  let response: ModelStreamResponse | undefined;
  let events: ReturnType<typeof convertModelResponse> | undefined;
  let settled = false;
  try {
    emitModelRequestPrefix({
      sessionId: request.qoder.identity.sessionId,
      requestId,
      prompt: request.prompt,
    });
    response = await (SINGLE_REQUEST_FORK in request
      ? raceSingleRequestResponseWithAbortSignal(
          provider.inference(request),
          signal,
        )
      : provider.inference(request));
    events = convertModelResponse({ response, requestId, signal, delivery });
    let next = await events.next();
    while (!next.done) {
      firstEventAt ??= Date.now();
      yield next.value;
      next = await events.next();
    }
    const message: ModelMessage = {
      ...next.value,
      model: next.value.model || model,
    };
    const stopReason = message.stopReason;
    if (!stopReason)
      throw new Error('Model stream ended without a stop reason');
    const usage = projectModelUsage(message.usage, requestId);
    annotateContextUsageRatio(usage, contextWindow);
    settled = true;
    const completedAt = Date.now();
    try {
      diagnostic?.onCompleted?.({
        requestId,
        model,
        ttftMs: (firstEventAt ?? completedAt) - startedAt,
        durationMs: completedAt - startedAt,
        usage,
        thinkingTokens: getThinkingTokenCount(usage),
        finishReason: stopReason,
      });
    } catch {
      // Observability callbacks must never affect the model request path.
    }
    finish(stopReason);
    observeFallback('success', message);
    context.onMainPromptTokenCount?.(usage.input_tokens);
    return { kind: 'complete', requestId, message };
  } catch (error) {
    settled = true;
    finish(undefined, error);
    observeFallback(
      observationWaitFailureStatus(error, signal) === 'aborted'
        ? 'abort'
        : 'error',
      undefined,
      error,
    );
    // Single-request forks never expose partial output or recover an interrupted turn.
    if (SINGLE_REQUEST_FORK in request) throw error;
    // Committed output (visible text, delivered tools) must not be dropped.
    if (!response || !delivery.committedOutput) throw error;
    const message = await response.partial;
    const delivered = getDeliveredModelMessage(message, delivery);
    const aborted = signal?.aborted === true || isAbortErrorDeep(error);
    const stopReason = delivered.stopReason;
    const resumable =
      !aborted &&
      stopReason !== 'refusal' &&
      stopReason !== 'max_tokens' &&
      isResumableStreamFailure(error);
    return {
      kind: 'interrupted',
      requestId,
      message,
      delivery,
      failure: {
        error,
        kind: aborted
          ? 'abort'
          : stopReason === 'refusal' || getErrorStatus(error) === 406
            ? 'refusal'
            : resumable
              ? 'transport'
              : 'terminal',
        usageSource: delivery.receivedUsage ? 'partial' : 'unavailable',
      },
    };
  } finally {
    // The consumer stopped early: release the provider stream.
    try {
      if (!settled) {
        try {
          await events?.return(undefined as never);
        } finally {
          observeFallback('abort');
        }
      }
    } finally {
      unsubscribeObservation();
    }
  }
}

/** 使用标准对话和工具声明准备 prompt，不装配协议或业务上下文。 */
export function buildModelPrompt(
  selected: ModelSelection,
  {
    system: systemPrompt,
    messages,
    tools,
    toolChoice,
    skipCacheWrite,
  }: {
    system?: SystemPrompt;
    messages: readonly ModelStreamMessage[];
    tools: ModelStreamTool[];
    toolChoice?: ModelToolChoice;
    skipCacheWrite?: boolean;
  },
): ModelPrompt {
  const reasoning = selected.config.reasoning;
  let conversation = convertMessages(messages, skipCacheWrite, {
    supportsVision: selected.model.capabilities.vision,
    maxRequestImages: getMaxRequestImages(),
  });
  if (reasoning?.preserve === false) {
    conversation = conversation.map(stripAssistantReasoning);
  }
  const systemBlocks =
    systemPrompt?.filter((block) => block.text.length > 0) ?? [];
  const system =
    systemBlocks.length === 0
      ? undefined
      : areSystemPromptBlocksEnabled()
        ? systemBlocks
        : systemPromptToText(systemBlocks);
  return {
    messages:
      system !== undefined
        ? [{ role: 'system', content: system }, ...conversation]
        : conversation,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  };
}

function stripAssistantReasoning(
  message: ModelStreamMessage,
): ModelStreamMessage {
  if (message.role !== 'assistant' || typeof message.content === 'string')
    return message;
  return {
    ...message,
    content: message.content.filter(
      (block) =>
        block.type !== 'thinking' && block.type !== 'redacted_thinking',
    ),
  };
}

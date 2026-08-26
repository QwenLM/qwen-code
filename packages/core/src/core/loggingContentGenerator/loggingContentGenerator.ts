/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  type Content,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentParameters,
  type GenerateContentResponseUsageMetadata,
  type ContentListUnion,
  type ContentUnion,
  type Part,
  type PartUnion,
  type FinishReason,
} from '@google/genai';
import type OpenAI from 'openai';
import { context, type Context, type Span } from '@opentelemetry/api';
import {
  ApiRequestEvent,
  ApiResponseEvent,
  ApiErrorEvent,
} from '../../telemetry/types.js';
import type { Config } from '../../config/config.js';
import {
  logApiError,
  logApiRequest,
  logApiResponse,
} from '../../telemetry/loggers.js';
import { isInternalPromptId } from '../../utils/internalPromptIds.js';
import { subagentNameContext } from '../../utils/subagentNameContext.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  InputModalities,
} from '../contentGenerator.js';
import { OpenAIContentConverter } from '../openaiContentGenerator/converter.js';
import { openaiRequestCaptureContext } from '../openaiContentGenerator/requestCaptureContext.js';
import type { RequestContext } from '../openaiContentGenerator/types.js';
import { OpenAILogger } from '../../utils/openaiLogger.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { runtimeDiagnostics } from '../../utils/runtimeDiagnostics.js';
import {
  getErrorMessage,
  getErrorStatus,
  getErrorType,
  isAbortError,
} from '../../utils/errors.js';
import {
  endLLMRequestSpan,
  areSensitiveSpanAttributesEnabled,
} from '../../telemetry/index.js';
import { startLLMRequestSpanWithContext } from '../../telemetry/session-tracing.js';
import { getSessionIdFromContext } from '../../telemetry/session-context.js';
import {
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE,
  API_CALL_FAILED_SPAN_STATUS_MESSAGE,
} from '../../telemetry/tracer.js';
import { hasUserVisibleContent } from './streamContentDetection.js';
import {
  retryContext,
  type RetryAttemptContext,
} from '../../utils/retryContext.js';
import {
  resolveGenAiOperationName,
  resolveGenAiOutputType,
  resolveGenAiProviderName,
} from '../../telemetry/gen-ai-provider.js';
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import {
  createGenAiExchange,
  type GenAiExchangeController,
} from '../../telemetry/gen-ai-request.js';

/**
 * Phase 4b — read the active retry context once, default attempt to 1 when
 * absent (warmup/side-queries/direct calls). Returns the fields in the exact
 * shape consumed by `endLLMRequestSpan` so callers can spread the result.
 *
 * Called in the SYNCHRONOUS PRELUDE of `generateContent` / `generateContentStream`
 * — before the first await — because the streaming path returns an
 * AsyncGenerator that's iterated AFTER `retryWithBackoff` has resolved and
 * the ALS frame has exited. The closure carries this snapshot to all later
 * endLLMRequestSpan callsites (success / error / idle-timeout / abort).
 */
function snapshotRetryMetadata(): {
  attempt: number;
  requestSetupMs?: number;
  retryTotalDelayMs?: number;
} {
  const ctx: RetryAttemptContext | undefined = retryContext.getStore();
  return {
    attempt: ctx?.attempt ?? 1,
    requestSetupMs: ctx?.requestSetupMs,
    retryTotalDelayMs: ctx?.retryTotalDelayMs,
  };
}

function bindAsyncGeneratorToContext<TYield, TReturn, TNext>(
  stream: AsyncGenerator<TYield, TReturn, TNext>,
  scopedContext: Context,
): AsyncGenerator<TYield, TReturn, TNext> {
  // An async generator starts executing on next(), after context.with() around
  // its construction has already returned. Bind every protocol operation so
  // provider iteration and wrapper-side telemetry retain the request context.
  return {
    next: (...args: [] | [TNext]) =>
      context.with(scopedContext, () => stream.next(...args)),
    return: (value: TReturn | PromiseLike<TReturn>) =>
      context.with(scopedContext, () => stream.return(value)),
    throw: (error: unknown) =>
      context.with(scopedContext, () => stream.throw(error)),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function usageSpanMetadata(
  usage: GenerateContentResponseUsageMetadata | undefined,
) {
  const provenance = getGenAiUsageProvenance(usage);
  return {
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    cachedInputTokens: usage?.cachedContentTokenCount,
    cachedInputTokensReported:
      provenance?.cachedInputTokensReported ??
      usage?.cachedContentTokenCount !== undefined,
    cacheCreationInputTokens: provenance?.cacheCreationInputTokens,
  };
}

function orderedFinishReasons(
  response: GenerateContentResponse,
): string[] | undefined {
  const reasons = (response.candidates ?? [])
    .map((candidate, position) => ({
      index: candidate.index ?? position,
      reason: candidate.finishReason
        ? String(candidate.finishReason)
        : undefined,
    }))
    .filter(
      (entry): entry is { index: number; reason: string } =>
        entry.reason !== undefined,
    )
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.reason);
  return reasons.length > 0 ? reasons : undefined;
}

const debugLogger = createDebugLogger('LOGGING_CONTENT_GENERATOR');

const MAX_RESPONSE_TEXT_LENGTH = 4096;
const RESPONSE_TEXT_TRUNCATION_SUFFIX = '...[truncated]';

/**
 * A decorator that wraps a ContentGenerator to add logging to API calls.
 */
export class LoggingContentGenerator implements ContentGenerator {
  private openaiLogger?: OpenAILogger;
  private schemaCompliance?: 'auto' | 'openapi_30';
  private modalities?: InputModalities;
  private splitToolMedia?: boolean;
  private toolResultContentFormat?: ContentGeneratorConfig['toolResultContentFormat'];
  private readonly generatorAuthType: ContentGeneratorConfig['authType'];
  private readonly genAiProviderName: string;
  private readonly genAiOperationName: 'chat' | 'generate_content';

  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly config: Config,
    generatorConfig: ContentGeneratorConfig,
  ) {
    this.modalities = generatorConfig.modalities;
    this.splitToolMedia = generatorConfig.splitToolMedia;
    this.toolResultContentFormat = generatorConfig.toolResultContentFormat;
    this.generatorAuthType = generatorConfig.authType;
    this.genAiProviderName = resolveGenAiProviderName(
      generatorConfig,
      process.env['DASHSCOPE_PROXY_BASE_URL'],
    );
    this.genAiOperationName = resolveGenAiOperationName(
      generatorConfig.authType,
    );

    // Extract fields needed for initialization from passed config
    // (config.getContentGeneratorConfig() may not be available yet during refreshAuth)
    if (generatorConfig.enableOpenAILogging) {
      this.openaiLogger = new OpenAILogger(
        generatorConfig.openAILoggingDir,
        config.getWorkingDir(),
      );
      this.schemaCompliance = generatorConfig.schemaCompliance;
    }
  }

  getWrapped(): ContentGenerator {
    return this.wrapped;
  }

  private logApiRequest(
    contents: Content[],
    model: string,
    promptId: string,
    sessionId: string,
  ): void {
    const requestText = JSON.stringify(contents);
    logApiRequest(
      this.config,
      new ApiRequestEvent(
        model,
        promptId,
        requestText,
        subagentNameContext.getStore(),
      ),
      sessionId,
    );
  }

  private _logApiResponse(
    responseId: string,
    durationMs: number,
    model: string,
    prompt_id: string,
    sessionId: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
    ttftMs?: number,
  ): void {
    logApiResponse(
      this.config,
      new ApiResponseEvent(
        responseId,
        model,
        durationMs,
        prompt_id,
        this.generatorAuthType,
        usageMetadata,
        responseText,
        subagentNameContext.getStore(),
        ttftMs,
      ),
      sessionId,
    );
  }

  private _logApiError(
    responseId: string | undefined,
    durationMs: number,
    error: unknown,
    model: string,
    prompt_id: string,
    sessionId: string,
  ): void {
    const errorMessage = getErrorMessage(error);
    const errorType = getErrorType(error);
    const errorResponseId =
      (error as { requestID?: string; request_id?: string })?.requestID ||
      (error as { requestID?: string; request_id?: string })?.request_id ||
      responseId;
    const errorStatus = getErrorStatus(error);

    logApiError(
      this.config,
      new ApiErrorEvent({
        responseId: errorResponseId,
        model,
        durationMs,
        promptId: prompt_id,
        authType: this.generatorAuthType,
        errorMessage,
        errorType,
        statusCode: errorStatus,
        subagentName: subagentNameContext.getStore(),
      }),
      sessionId,
    );
  }

  private safelyLogApiError(
    responseId: string | undefined,
    durationMs: number,
    error: unknown,
    model: string,
    prompt_id: string,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): void {
    // A user cancel is not an API error, so skip the api_error event entirely —
    // the span already records the cancellation through its aborted status, so
    // the signal isn't lost. Without this gate a user cancel is emitted as a
    // `qwen-code.api_error` event with error_type `APIUserAbortError`, which is
    // exactly what #8356 reported; `isAbortError` gating the debug log alone
    // does not cover this separate telemetry path.
    if (abortSignal?.aborted && isAbortError(error)) {
      return;
    }
    try {
      this._logApiError(
        responseId,
        durationMs,
        error,
        model,
        prompt_id,
        sessionId,
      );
    } catch (loggingError) {
      debugLogger.warn('Failed to log API error:', loggingError);
    }
  }

  private safelyLogApiResponse(
    responseId: string,
    durationMs: number,
    model: string,
    prompt_id: string,
    sessionId: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
    ttftMs?: number,
  ): void {
    try {
      this._logApiResponse(
        responseId,
        durationMs,
        model,
        prompt_id,
        sessionId,
        usageMetadata,
        responseText,
        ttftMs,
      );
    } catch (loggingError) {
      debugLogger.warn('Failed to log API response:', loggingError);
    }
  }

  async generateContent(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    // Phase 4b — snapshot retry context in the synchronous prelude BEFORE any
    // await. ALS frame from `retryWithBackoff` is guaranteed to be active here.
    const retrySnapshot = snapshotRetryMetadata();

    const ownerSessionId = this.config.getSessionId();
    const ownerUserId = this.config.getTelemetryUserId();
    const { span: llmSpan, context: llmContext } =
      startLLMRequestSpanWithContext(req.model, userPromptId, {
        operationName: this.genAiOperationName,
        providerName: this.genAiProviderName,
        outputType: resolveGenAiOutputType(this.generatorAuthType, req.config),
        sessionId: ownerSessionId,
        userId: ownerUserId,
      });
    const requestSessionId =
      getSessionIdFromContext(llmContext) ?? ownerSessionId;
    // Capture span context so the API call and logging activate it via
    // context.with(). Without this, nested OTel spans (HTTP instrumentation,
    // log-bridge spans) parent to session root instead of llm_request.
    const isInternal = isInternalPromptId(userPromptId);
    const exchange = createGenAiExchange(llmContext, llmSpan, {
      captureContent:
        !isInternal && this.shouldCollectSensitiveSpanAttributes(),
      sensitiveAttributeMaxLength:
        this.config.getTelemetrySensitiveSpanAttributeMaxLength(),
    });
    const spanContext = exchange.context;

    const startTime = Date.now();
    const session = this.startCaptureSession();
    let responseCompleted = false;
    let abortedBeforeResponseCompletion =
      req.config?.abortSignal?.aborted ?? false;
    const markResponseAborted = () => {
      if (!responseCompleted) abortedBeforeResponseCompletion = true;
    };
    req.config?.abortSignal?.addEventListener('abort', markResponseAborted, {
      once: true,
    });
    try {
      runtimeDiagnostics.recordGenerateContentRequest(req, {
        stream: false,
        source: 'generateContent',
      });
      const response = await context.with(spanContext, async () => {
        if (!isInternal) {
          this.logApiRequest(
            this.toContents(req.contents),
            req.model,
            userPromptId,
            requestSessionId,
          );
        }
        const result = await session.wrap(() =>
          this.wrapped.generateContent(req, userPromptId),
        );
        responseCompleted = true;
        const durationMs = Date.now() - startTime;
        const responseText = isInternal
          ? undefined
          : this.extractResponseText(result, MAX_RESPONSE_TEXT_LENGTH);
        if (!abortedBeforeResponseCompletion) {
          this.safelyLogApiResponse(
            result.responseId ?? '',
            durationMs,
            result.modelVersion || req.model,
            userPromptId,
            requestSessionId,
            result.usageMetadata,
            responseText,
          );
          try {
            await this.safelyLogOpenAIInteraction(
              await session.resolve(req),
              result,
              undefined,
              userPromptId,
            );
          } catch (loggingError) {
            debugLogger.warn('Failed to log OpenAI interaction:', loggingError);
          }
        }
        return result;
      });
      const cancelled = abortedBeforeResponseCompletion;
      const observedFinishReasons = exchange.controller.finalize(!cancelled);
      endLLMRequestSpan(llmSpan, {
        success: !cancelled,
        cancelled,
        ...usageSpanMetadata(response.usageMetadata),
        durationMs: Date.now() - startTime,
        responseId: response.responseId || undefined,
        responseModel: response.modelVersion || undefined,
        finishReasons: observedFinishReasons ?? orderedFinishReasons(response),
        thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
        subagentName: subagentNameContext.getStore() || undefined,
        error: cancelled ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE : undefined,
        ...retrySnapshot,
        config: this.config,
      });
      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const observedFinishReasons = exchange.controller.finalize(false);
      // End the span BEFORE the (potentially-throwing) logging block, so a
      // logging-side rejection cannot prevent span finalization. Mirrors the
      // streaming path order. A caller-driven abort is a cancellation, while
      // a real upstream failure that merely races an abort remains an error.
      const cancelled =
        (req.config?.abortSignal?.aborted ?? false) && isAbortError(error);
      endLLMRequestSpan(llmSpan, {
        success: false,
        cancelled,
        durationMs,
        error: cancelled
          ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
          : API_CALL_FAILED_SPAN_STATUS_MESSAGE,
        errorType: cancelled ? undefined : getErrorType(error),
        errorStatusCode: cancelled ? undefined : getErrorStatus(error),
        finishReasons: observedFinishReasons,
        subagentName: subagentNameContext.getStore() || undefined,
        ...retrySnapshot,
        config: this.config,
      });
      await context.with(spanContext, async () => {
        this.safelyLogApiError(
          '',
          durationMs,
          error,
          req.model,
          userPromptId,
          requestSessionId,
          req.config?.abortSignal,
        );
        try {
          await this.safelyLogOpenAIInteraction(
            await session.resolve(req),
            undefined,
            error,
            userPromptId,
          );
        } catch (loggingError) {
          debugLogger.warn('Failed to log OpenAI interaction:', loggingError);
        }
      });
      throw error;
    } finally {
      req.config?.abortSignal?.removeEventListener(
        'abort',
        markResponseAborted,
      );
    }
  }

  async generateContentStream(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    // Phase 4b — snapshot retry context in the synchronous prelude. This is
    // the only point where the ALS frame from `retryWithBackoff` is guaranteed
    // to be active for the streaming path: once this function returns the
    // AsyncGenerator, the caller iterates AFTER `retryWithBackoff` has
    // resolved and the frame has exited. Threaded as a parameter to
    // loggingStreamWrapper so its closure carries the snapshot to all later
    // endLLMRequestSpan callsites (success / error / idle-timeout / abort).
    const retrySnapshot = snapshotRetryMetadata();

    const ownerSessionId = this.config.getSessionId();
    const ownerUserId = this.config.getTelemetryUserId();
    const { span: llmSpan, context: llmContext } =
      startLLMRequestSpanWithContext(req.model, userPromptId, {
        operationName: this.genAiOperationName,
        providerName: this.genAiProviderName,
        outputType: resolveGenAiOutputType(this.generatorAuthType, req.config),
        sessionId: ownerSessionId,
        userId: ownerUserId,
      });
    const requestSessionId =
      getSessionIdFromContext(llmContext) ?? ownerSessionId;
    try {
      llmSpan.setAttribute('gen_ai.request.stream', true);
    } catch {
      /* best-effort */
    }

    // Capture the span context so the stream wrapper can activate it
    // during iteration — not just during generator creation.
    const isInternal = isInternalPromptId(userPromptId);
    const exchange = createGenAiExchange(llmContext, llmSpan, {
      captureContent:
        !isInternal && this.shouldCollectSensitiveSpanAttributes(),
      sensitiveAttributeMaxLength:
        this.config.getTelemetrySensitiveSpanAttributeMaxLength(),
    });
    const spanContext = exchange.context;

    const startTime = Date.now();
    const session = this.startCaptureSession();

    let streamRequest: {
      stream: AsyncGenerator<GenerateContentResponse>;
      requestIssuedAtMs: number;
    };
    try {
      runtimeDiagnostics.recordGenerateContentRequest(req, {
        stream: true,
        source: 'generateContentStream',
      });
      streamRequest = await context.with(spanContext, async () => {
        if (!isInternal) {
          this.logApiRequest(
            this.toContents(req.contents),
            req.model,
            userPromptId,
            requestSessionId,
          );
        }
        return session.wrap(async () => {
          const requestIssuedAtMs = performance.now();
          const stream = await this.wrapped.generateContentStream(
            req,
            userPromptId,
          );
          return { stream, requestIssuedAtMs };
        });
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const observedFinishReasons = exchange.controller.finalize(false);
      context.with(spanContext, () =>
        this.safelyLogApiError(
          '',
          durationMs,
          error,
          req.model,
          userPromptId,
          requestSessionId,
          req.config?.abortSignal,
        ),
      );
      const cancelled =
        (req.config?.abortSignal?.aborted ?? false) && isAbortError(error);
      endLLMRequestSpan(llmSpan, {
        success: false,
        cancelled,
        durationMs,
        error: cancelled
          ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
          : API_CALL_FAILED_SPAN_STATUS_MESSAGE,
        errorType: cancelled ? undefined : getErrorType(error),
        errorStatusCode: cancelled ? undefined : getErrorStatus(error),
        finishReasons: observedFinishReasons,
        subagentName: subagentNameContext.getStore() || undefined,
        ...retrySnapshot,
        config: this.config,
      });
      try {
        await this.safelyLogOpenAIInteraction(
          await session.resolve(req),
          undefined,
          error,
          userPromptId,
        );
      } catch (loggingError) {
        debugLogger.warn('Failed to log OpenAI interaction:', loggingError);
      }
      throw error;
    }
    const { stream, requestIssuedAtMs } = streamRequest;

    const openaiRequestPromise = this.openaiLogger
      ? session.resolve(req).catch((loggingError: unknown) => {
          debugLogger.warn('Failed to resolve OpenAI request:', loggingError);
          return undefined;
        })
      : undefined;

    return bindAsyncGeneratorToContext(
      this.loggingStreamWrapper(
        stream,
        startTime,
        requestIssuedAtMs,
        userPromptId,
        req.model,
        requestSessionId,
        openaiRequestPromise,
        llmSpan,
        req.config?.abortSignal,
        retrySnapshot,
        exchange.controller,
      ),
      spanContext,
    );
  }

  private startCaptureSession(): {
    wrap: <T>(fn: () => Promise<T>) => Promise<T>;
    resolve: (
      req: GenerateContentParameters,
    ) => Promise<OpenAI.Chat.ChatCompletionCreateParams | undefined>;
  } {
    let captured: OpenAI.Chat.ChatCompletionCreateParams | undefined;
    const skipCapture = !this.openaiLogger;
    return {
      wrap: <T>(fn: () => Promise<T>): Promise<T> =>
        skipCapture
          ? fn()
          : openaiRequestCaptureContext.run((built) => {
              captured = built;
            }, fn),
      resolve: async (req) =>
        this.openaiLogger
          ? (captured ?? (await this.buildOpenAIRequestForLogging(req)))
          : undefined,
    };
  }

  private async *loggingStreamWrapper(
    stream: AsyncGenerator<GenerateContentResponse>,
    startTime: number,
    requestIssuedAtMs: number,
    userPromptId: string,
    model: string,
    sessionId: string,
    openaiRequestPromise?: Promise<
      OpenAI.Chat.ChatCompletionCreateParams | undefined
    >,
    span?: Span,
    abortSignal?: AbortSignal,
    // Phase 4b — snapshot of retry context captured BEFORE the stream wrapper
    // returned, when the ALS frame from `retryWithBackoff` was still active.
    // Closure-carried to every endLLMRequestSpan callsite below so the
    // idle-timeout `setTimeout` callback sees the same values as the
    // entry-time read.
    retrySnapshot?: ReturnType<typeof snapshotRetryMetadata>,
    exchangeController?: GenAiExchangeController,
  ): AsyncGenerator<GenerateContentResponse> {
    const isInternal = isInternalPromptId(userPromptId);
    // Skip collecting full responses for internal prompts to avoid memory
    // overhead, unless OpenAI file logging needs them.
    const shouldCollectResponses = !isInternal || !!this.openaiLogger;
    const responses: GenerateContentResponse[] = [];
    let lastResponseForLogging: GenerateContentResponse | undefined;

    // Track first-seen IDs so _logApiResponse/_logApiError have accurate
    // values even when we skip collecting full responses for internal prompts.
    let firstResponseId = '';
    let firstModelVersion = '';
    let lastResponse: GenerateContentResponse | undefined;
    let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined;
    const refreshLateUsageMetadata = () => {
      if (lastResponse?.usageMetadata) {
        lastUsageMetadata = lastResponse.usageMetadata;
      }
    };
    let errorOccurred = false;
    let streamCompleted = false;
    let abortedBeforeStreamCompletion = abortSignal?.aborted ?? false;
    const markStreamAborted = () => {
      if (!streamCompleted) abortedBeforeStreamCompletion = true;
    };
    abortSignal?.addEventListener('abort', markStreamAborted, { once: true });
    const finishReasons = new Map<number, string>();
    let lastError: unknown;
    const subagentName = subagentNameContext.getStore();

    // Internal first-visible-output timing: wall-clock from the existing
    // generateContentStream startTime to the first chunk containing
    // user-visible content. This is distinct from the standard first-chunk
    // timer above.
    // Method-local closure variable — NEVER an instance field — because
    // LoggingContentGenerator is shared across concurrent generateContentStream
    // calls (one per ContentGenerator, see contentGenerator.ts:createContentGenerator).
    // See docs/design/telemetry-llm-request-timing-design.md (D1, D2).
    let ttftMs: number | undefined;
    let firstChunkObserved = false;
    // Tracks whether the idle timeout fired and ended the span. If so,
    // a resumed-after-timeout consumer must not call endLLMRequestSpan
    // again (the helper would no-op, but more importantly we skip the
    // redundant work and avoid resetting the timer further).
    let spanEndedByTimeout = false;

    // Idle timeout: if no chunks arrive for this duration the consumer has
    // likely abandoned the generator without calling .return(). Close the
    // span so it doesn't leak forever. The timer resets on every chunk,
    // so legitimately long-running streams are never affected.
    const STREAM_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes
    let spanEndTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetSpanTimeout = span
      ? () => {
          if (spanEndedByTimeout) return;
          if (spanEndTimeout !== undefined) clearTimeout(spanEndTimeout);
          spanEndTimeout = setTimeout(() => {
            refreshLateUsageMetadata();
            const cancelled =
              abortedBeforeStreamCompletion &&
              (lastError === undefined || isAbortError(lastError));
            try {
              span.setAttribute('stream.timed_out', true);
            } catch {
              // OTel errors must not interrupt the consumer.
            }
            const observedFinishReasons = exchangeController?.finalize(false);
            endLLMRequestSpan(span, {
              success: false,
              cancelled,
              ...usageSpanMetadata(lastUsageMetadata),
              durationMs: Date.now() - startTime,
              error: cancelled
                ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
                : lastError !== undefined
                  ? API_CALL_FAILED_SPAN_STATUS_MESSAGE
                  : 'Stream span timed out (idle)',
              errorType:
                lastError !== undefined && !cancelled
                  ? getErrorType(lastError)
                  : undefined,
              errorStatusCode:
                lastError !== undefined && !cancelled
                  ? getErrorStatus(lastError)
                  : undefined,
              responseId: firstResponseId || undefined,
              responseModel: firstModelVersion || undefined,
              finishReasons:
                observedFinishReasons ??
                (finishReasons.size > 0
                  ? [...finishReasons.entries()]
                      .sort(([left], [right]) => left - right)
                      .map(([, reason]) => reason)
                  : undefined),
              subagentName: subagentName || undefined,
              ...retrySnapshot,
              config: this.config,
            });
            spanEndedByTimeout = true;
            abortSignal?.removeEventListener('abort', markStreamAborted);
          }, STREAM_IDLE_TIMEOUT_MS);
          spanEndTimeout.unref();
        }
      : undefined;
    resetSpanTimeout?.();

    try {
      for await (const response of stream) {
        if (!firstChunkObserved && !spanEndedByTimeout) {
          firstChunkObserved = true;
          try {
            const timeToFirstChunk =
              Math.max(0, performance.now() - requestIssuedAtMs) / 1000;
            if (Number.isFinite(timeToFirstChunk)) {
              span?.setAttribute(
                'gen_ai.response.time_to_first_chunk',
                timeToFirstChunk,
              );
            }
          } catch {
            // OTel errors must not interrupt the consumer.
          }
        }
        lastResponse = response;
        if (!firstResponseId && response.responseId) {
          firstResponseId = response.responseId;
        }
        if (!firstModelVersion && response.modelVersion) {
          firstModelVersion = response.modelVersion;
        }
        const candidate = response.candidates?.[0];
        if (shouldCollectResponses) {
          lastResponseForLogging = response;
          if (
            (candidate?.content?.parts?.length ?? 0) > 0 ||
            candidate?.finishReason
          ) {
            responses.push(response);
          }
        }
        if (response.usageMetadata) {
          lastUsageMetadata = response.usageMetadata;
        }
        for (const [position, responseCandidate] of (
          response.candidates ?? []
        ).entries()) {
          if (responseCandidate.finishReason) {
            finishReasons.set(
              responseCandidate.index ?? position,
              String(responseCandidate.finishReason),
            );
          }
        }
        // Capture TTFT on the first stream chunk that contains user-visible
        // content. hasUserVisibleContent skips role-only / usageMetadata-only
        // chunks, so TTFT reflects "model produced something the operator can
        // attribute to user-perceived latency."
        if (ttftMs === undefined && hasUserVisibleContent(response)) {
          ttftMs = Date.now() - startTime;
        }
        resetSpanTimeout?.();
        yield response;
      }
      streamCompleted = true;
      refreshLateUsageMetadata();
      if (spanEndTimeout !== undefined) {
        clearTimeout(spanEndTimeout);
        spanEndTimeout = undefined;
      }
      // Only log successful API response if no error occurred
      const durationMs = Date.now() - startTime;
      if (
        lastResponseForLogging &&
        responses.at(-1) !== lastResponseForLogging
      ) {
        responses.push(lastResponseForLogging);
      }
      const consolidatedResponse = shouldCollectResponses
        ? this.consolidateLlmResponsesForLogging(responses)
        : undefined;
      if (consolidatedResponse) {
        consolidatedResponse.usageMetadata = lastUsageMetadata;
      }
      const streamResponseText = isInternal
        ? undefined
        : this.extractResponseText(
            consolidatedResponse,
            MAX_RESPONSE_TEXT_LENGTH,
          );
      // If the idle timeout already closed the span as failed, do not contradict
      // it with a "success" api_response log or model-output span attributes.
      // The OpenAI interaction log is also skipped — telemetry already carries
      // the timeout signal and a parallel "success" record would be confusing
      // during incident response.
      if (!spanEndedByTimeout && !abortedBeforeStreamCompletion) {
        this.safelyLogApiResponse(
          firstResponseId,
          durationMs,
          firstModelVersion || model,
          userPromptId,
          sessionId,
          lastUsageMetadata,
          streamResponseText,
          ttftMs,
        );
        const openaiRequest = await openaiRequestPromise;
        await this.safelyLogOpenAIInteraction(
          openaiRequest,
          consolidatedResponse,
          undefined,
          userPromptId,
        );
      }
    } catch (error) {
      errorOccurred = true;
      lastError = error;
      // Same gating as the success path above: if the idle timeout already
      // closed the span as failed, do not emit a parallel api_error log
      // (the span is the canonical signal). Otherwise we'd produce the
      // exact contradictory pair the timeout fix targets — span timed-out
      // + api_error log — just on the error branch.
      if (!spanEndedByTimeout) {
        const durationMs = Date.now() - startTime;
        this.safelyLogApiError(
          firstResponseId,
          durationMs,
          error,
          firstModelVersion || model,
          userPromptId,
          sessionId,
          abortSignal,
        );
        const openaiRequest = await openaiRequestPromise;
        await this.safelyLogOpenAIInteraction(
          openaiRequest,
          undefined,
          error,
          userPromptId,
        );
      }
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', markStreamAborted);
      if (spanEndTimeout !== undefined) {
        clearTimeout(spanEndTimeout);
      }
      refreshLateUsageMetadata();
      // If the idle timeout already ended the span, skip the redundant
      // endLLMRequestSpan call. The helper itself would no-op due to its
      // own ended guard, but we want to avoid pretending the final token
      // counts were recorded — they weren't, the span is the timeout one.
      if (span && !spanEndedByTimeout) {
        const cancelled =
          abortedBeforeStreamCompletion &&
          (lastError === undefined || isAbortError(lastError));
        const observedFinishReasons = exchangeController?.finalize(
          !errorOccurred && !cancelled && streamCompleted,
        );
        endLLMRequestSpan(span, {
          success: !errorOccurred && !cancelled,
          cancelled,
          ...usageSpanMetadata(lastUsageMetadata),
          ttftMs,
          durationMs: Date.now() - startTime,
          error: cancelled
            ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
            : errorOccurred
              ? API_CALL_FAILED_SPAN_STATUS_MESSAGE
              : undefined,
          responseId: firstResponseId || undefined,
          responseModel: firstModelVersion || undefined,
          finishReasons:
            observedFinishReasons ??
            (finishReasons.size > 0
              ? [...finishReasons.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([, reason]) => reason)
              : undefined),
          thoughtsTokenCount: lastUsageMetadata?.thoughtsTokenCount,
          subagentName: subagentName || undefined,
          errorType:
            lastError && !cancelled ? getErrorType(lastError) : undefined,
          errorStatusCode:
            lastError && !cancelled ? getErrorStatus(lastError) : undefined,
          ...retrySnapshot,
          config: this.config,
        });
      }
    }
  }

  private async buildOpenAIRequestForLogging(
    request: GenerateContentParameters,
  ): Promise<OpenAI.Chat.ChatCompletionCreateParams | undefined> {
    if (!this.openaiLogger) {
      return undefined;
    }

    const requestContext = this.createLoggingRequestContext(request.model);
    const messages = OpenAIContentConverter.convertLlmRequestToOpenAI(
      request,
      requestContext,
      {
        cleanOrphanToolCalls: false,
      },
    );

    const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: request.model,
      messages,
    };

    if (request.config?.tools) {
      openaiRequest.tools =
        await OpenAIContentConverter.convertLlmToolsToOpenAI(
          request.config.tools,
          this.schemaCompliance ?? 'auto',
        );
    }

    if (request.config?.temperature !== undefined) {
      openaiRequest.temperature = request.config.temperature;
    }
    if (request.config?.topP !== undefined) {
      openaiRequest.top_p = request.config.topP;
    }
    if (request.config?.maxOutputTokens !== undefined) {
      openaiRequest.max_tokens = request.config.maxOutputTokens;
    }
    if (request.config?.presencePenalty !== undefined) {
      openaiRequest.presence_penalty = request.config.presencePenalty;
    }
    if (request.config?.frequencyPenalty !== undefined) {
      openaiRequest.frequency_penalty = request.config.frequencyPenalty;
    }

    return openaiRequest;
  }

  private createLoggingRequestContext(model: string): RequestContext {
    return {
      model,
      modalities: this.modalities ?? {},
      // Mirror the pipeline default (see pipeline.ts createRequestContext) so the
      // --openai-logging fallback reconstruction reflects the same split as the
      // request actually sent. Opt out via generationConfig.splitToolMedia = false.
      splitToolMedia: this.splitToolMedia ?? true,
      toolResultContentFormat: this.toolResultContentFormat ?? 'parts',
      startTime: 0,
    };
  }

  private async logOpenAIInteraction(
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams | undefined,
    response?: GenerateContentResponse,
    error?: unknown,
    promptId?: string,
  ): Promise<void> {
    if (!this.openaiLogger || !openaiRequest) {
      return;
    }

    const openaiResponse = response
      ? this.convertLlmResponseToOpenAIForLogging(response, openaiRequest)
      : undefined;

    await this.openaiLogger.logInteraction(
      openaiRequest,
      openaiResponse,
      error instanceof Error
        ? error
        : error
          ? new Error(String(error))
          : undefined,
      promptId,
    );
  }

  private async safelyLogOpenAIInteraction(
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams | undefined,
    response?: GenerateContentResponse,
    error?: unknown,
    promptId?: string,
  ): Promise<void> {
    try {
      await this.logOpenAIInteraction(openaiRequest, response, error, promptId);
    } catch (loggingError) {
      debugLogger.warn('Failed to log OpenAI interaction:', loggingError);
    }
  }

  private convertLlmResponseToOpenAIForLogging(
    response: GenerateContentResponse,
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
  ): OpenAI.Chat.ChatCompletion {
    return OpenAIContentConverter.convertLlmResponseToOpenAI(
      response,
      this.createLoggingRequestContext(openaiRequest.model),
    );
  }

  private consolidateLlmResponsesForLogging(
    responses: GenerateContentResponse[],
  ): GenerateContentResponse | undefined {
    if (responses.length === 0) {
      return undefined;
    }

    const consolidated = new GenerateContentResponse();
    const combinedParts: Part[] = [];
    const functionCallIndex = new Map<string, number>();
    let finishReason: FinishReason | undefined;
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;

    for (const response of responses) {
      if (response.usageMetadata) {
        usageMetadata = response.usageMetadata;
      }

      const candidate = response.candidates?.[0];
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
      }

      const parts = candidate?.content?.parts ?? [];
      for (const part of parts as Part[]) {
        if (typeof part === 'string') {
          combinedParts.push({ text: part });
          continue;
        }

        if ('text' in part) {
          if (part.text) {
            combinedParts.push({
              text: part.text,
              ...(part.thought ? { thought: true } : {}),
              ...(part.thoughtSignature
                ? { thoughtSignature: part.thoughtSignature }
                : {}),
            });
          }
          continue;
        }

        if ('functionCall' in part && part.functionCall) {
          const callKey =
            part.functionCall.id || part.functionCall.name || 'tool_call';
          const existingIndex = functionCallIndex.get(callKey);
          const functionPart = { functionCall: part.functionCall };
          if (existingIndex !== undefined) {
            combinedParts[existingIndex] = functionPart;
          } else {
            functionCallIndex.set(callKey, combinedParts.length);
            combinedParts.push(functionPart);
          }
          continue;
        }

        if ('functionResponse' in part && part.functionResponse) {
          combinedParts.push({ functionResponse: part.functionResponse });
          continue;
        }

        combinedParts.push(part);
      }
    }

    const lastResponse = responses[responses.length - 1];
    const lastCandidate = lastResponse.candidates?.[0];

    consolidated.responseId = lastResponse.responseId;
    consolidated.createTime = lastResponse.createTime;
    consolidated.modelVersion = lastResponse.modelVersion;
    consolidated.promptFeedback = lastResponse.promptFeedback;
    consolidated.usageMetadata = usageMetadata;

    consolidated.candidates = [
      {
        content: {
          role: lastCandidate?.content?.role || 'model',
          parts: combinedParts,
        },
        ...(finishReason ? { finishReason } : {}),
        index: 0,
        safetyRatings: lastCandidate?.safetyRatings || [],
      },
    ];

    return consolidated;
  }

  private extractResponseText(
    response: GenerateContentResponse | undefined,
    maxLength: number,
  ): string | undefined {
    let text = '';
    let truncated = false;
    const maxPrefixLength = Math.max(
      0,
      maxLength - RESPONSE_TEXT_TRUNCATION_SUFFIX.length,
    );
    const hasText = this.forEachVisibleResponseText(response, (partText) => {
      if (truncated) {
        return;
      }

      const remaining = maxPrefixLength - text.length;
      if (partText.length <= remaining) {
        text += partText;
        return;
      }

      text += partText.slice(0, Math.max(0, remaining));
      truncated = true;
    });

    if (!hasText) {
      return undefined;
    }

    return truncated ? `${text}${RESPONSE_TEXT_TRUNCATION_SUFFIX}` : text;
  }

  private forEachVisibleResponseText(
    response: GenerateContentResponse | undefined,
    onText: (text: string) => void,
  ): boolean {
    const parts = response?.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      return false;
    }

    let hasText = false;
    for (const part of parts as Array<Part | string>) {
      const text = this.getVisibleResponsePartText(part);
      if (text === undefined) {
        continue;
      }

      hasText = true;
      onText(text);
    }
    return hasText;
  }

  private getVisibleResponsePartText(part: Part | string): string | undefined {
    if (typeof part === 'string') {
      return part;
    }
    if (
      'text' in part &&
      typeof part.text === 'string' &&
      !('thought' in part && part.thought)
    ) {
      return part.text;
    }
    return undefined;
  }

  private shouldCollectSensitiveSpanAttributes(): boolean {
    return areSensitiveSpanAttributesEnabled(this.config);
  }

  async embedContent(
    req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.wrapped.embedContent(req);
  }

  private toContents(contents: ContentListUnion): Content[] {
    if (Array.isArray(contents)) {
      // it's a Content[] or a PartsUnion[]
      return contents.map((c) => this.toContent(c));
    }
    // it's a Content or a PartsUnion
    return [this.toContent(contents)];
  }

  private toContent(content: ContentUnion): Content {
    if (Array.isArray(content)) {
      // it's a PartsUnion[]
      return {
        role: 'user',
        parts: this.toParts(content),
      };
    }
    if (typeof content === 'string') {
      // it's a string
      return {
        role: 'user',
        parts: [{ text: content }],
      };
    }
    if ('parts' in content) {
      // it's a Content - process parts to handle thought filtering
      return {
        ...content,
        parts: content.parts
          ? this.toParts(content.parts.filter((p) => p != null))
          : [],
      };
    }
    // it's a Part
    return {
      role: 'user',
      parts: [this.toPart(content as Part)],
    };
  }

  private toParts(parts: PartUnion[]): Part[] {
    return parts.map((p) => this.toPart(p));
  }

  private toPart(part: PartUnion): Part {
    if (typeof part === 'string') {
      // it's a string
      return { text: part };
    }

    // Handle thought parts for CountToken API compatibility
    // The CountToken API expects parts to have certain required "oneof" fields initialized,
    // but thought parts don't conform to this schema and cause API failures
    if ('thought' in part && part.thought) {
      const thoughtText = `[Thought: ${part.thought}]`;

      const newPart = { ...part };
      delete (newPart as Record<string, unknown>)['thought'];

      const hasApiContent =
        'functionCall' in newPart ||
        'functionResponse' in newPart ||
        'inlineData' in newPart ||
        'fileData' in newPart;

      if (hasApiContent) {
        // It's a functionCall or other non-text part. Just strip the thought.
        return newPart;
      }

      // If no other valid API content, this must be a text part.
      // Combine existing text (if any) with the thought, preserving other properties.
      const text = (newPart as { text?: unknown }).text;
      const existingText = text ? String(text) : '';
      const combinedText = existingText
        ? `${existingText}\n${thoughtText}`
        : thoughtText;

      return {
        ...newPart,
        text: combinedText,
      };
    }

    return part;
  }
}

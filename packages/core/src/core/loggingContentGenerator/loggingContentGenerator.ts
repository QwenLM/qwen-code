/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  type Content,
  type CountTokensParameters,
  type CountTokensResponse,
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
import { context, trace, type Context, type Span } from '@opentelemetry/api';
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
} from '../../utils/errors.js';
import {
  startLLMRequestSpan,
  endLLMRequestSpan,
  addSystemPromptAttributes,
  addToolSchemaAttributes,
  addModelOutputAttributes,
} from '../../telemetry/index.js';
import {
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE,
  API_CALL_FAILED_SPAN_STATUS_MESSAGE,
} from '../../telemetry/tracer.js';
import { hasUserVisibleContent } from './streamContentDetection.js';

const debugLogger = createDebugLogger('LOGGING_CONTENT_GENERATOR');

const MAX_RESPONSE_TEXT_LENGTH = 4096;
const RESPONSE_TEXT_TRUNCATION_SUFFIX = '...[truncated]';
const MAX_RESPONSE_TEXT_PREFIX_LENGTH =
  MAX_RESPONSE_TEXT_LENGTH - RESPONSE_TEXT_TRUNCATION_SUFFIX.length;

/**
 * A decorator that wraps a ContentGenerator to add logging to API calls.
 */
export class LoggingContentGenerator implements ContentGenerator {
  private openaiLogger?: OpenAILogger;
  private schemaCompliance?: 'auto' | 'openapi_30';
  private modalities?: InputModalities;
  private readonly generatorAuthType: ContentGeneratorConfig['authType'];

  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly config: Config,
    generatorConfig: ContentGeneratorConfig,
  ) {
    this.modalities = generatorConfig.modalities;
    this.generatorAuthType = generatorConfig.authType;

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
    );
  }

  private _logApiResponse(
    responseId: string,
    durationMs: number,
    model: string,
    prompt_id: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
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
      ),
    );
  }

  private _logApiError(
    responseId: string | undefined,
    durationMs: number,
    error: unknown,
    model: string,
    prompt_id: string,
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
    );
  }

  private safelyLogApiError(
    responseId: string | undefined,
    durationMs: number,
    error: unknown,
    model: string,
    prompt_id: string,
  ): void {
    try {
      this._logApiError(responseId, durationMs, error, model, prompt_id);
    } catch (loggingError) {
      debugLogger.warn('Failed to log API error:', loggingError);
    }
  }

  private safelyLogApiResponse(
    responseId: string,
    durationMs: number,
    model: string,
    prompt_id: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
  ): void {
    try {
      this._logApiResponse(
        responseId,
        durationMs,
        model,
        prompt_id,
        usageMetadata,
        responseText,
      );
    } catch (loggingError) {
      debugLogger.warn('Failed to log API response:', loggingError);
    }
  }

  async generateContent(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const llmSpan = startLLMRequestSpan(req.model, userPromptId);
    try {
      llmSpan.setAttribute('llm_request.stream', false);
    } catch {
      /* best-effort */
    }
    // Capture span context so the API call and logging activate it via
    // context.with(). Without this, nested OTel spans (HTTP instrumentation,
    // log-bridge spans) parent to session root instead of llm_request.
    const spanContext = trace.setSpan(context.active(), llmSpan);

    const startTime = Date.now();
    const isInternal = isInternalPromptId(userPromptId);
    const session = this.startCaptureSession();
    try {
      runtimeDiagnostics.recordGenerateContentRequest(req, {
        stream: false,
        source: 'generateContent',
      });
      if (!isInternal) {
        addSystemPromptAttributes(
          this.config,
          llmSpan,
          req.config?.systemInstruction,
        );
        addToolSchemaAttributes(
          this.config,
          llmSpan,
          req.config?.tools as unknown[] | undefined,
        );
      }
      const response = await context.with(spanContext, async () => {
        if (!isInternal) {
          this.logApiRequest(
            this.toContents(req.contents),
            req.model,
            userPromptId,
          );
        }
        const result = await session.wrap(() =>
          this.wrapped.generateContent(req, userPromptId),
        );
        const durationMs = Date.now() - startTime;
        const responseText = isInternal
          ? undefined
          : this.extractResponseText(result);
        if (!isInternal) {
          addModelOutputAttributes(this.config, llmSpan, responseText);
        }
        this.safelyLogApiResponse(
          result.responseId ?? '',
          durationMs,
          result.modelVersion || req.model,
          userPromptId,
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
        return result;
      });
      endLLMRequestSpan(llmSpan, {
        success: true,
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
        cachedInputTokens: response.usageMetadata?.cachedContentTokenCount,
        durationMs: Date.now() - startTime,
        responseId: response.responseId || undefined,
        finishReason:
          (response.candidates?.[0]?.finishReason as string) || undefined,
        thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
        subagentName: subagentNameContext.getStore() || undefined,
      });
      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      // End the span BEFORE the (potentially-throwing) logging block, so a
      // logging-side rejection cannot prevent span finalization. Mirrors the
      // streaming path order. Use abort-specific status message when the
      // caller's abortSignal fired, so trace backends can distinguish user
      // cancellations from real upstream failures.
      const aborted = req.config?.abortSignal?.aborted ?? false;
      endLLMRequestSpan(llmSpan, {
        success: false,
        durationMs,
        error: aborted
          ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
          : API_CALL_FAILED_SPAN_STATUS_MESSAGE,
        errorType: getErrorType(error),
        errorStatusCode: getErrorStatus(error),
        subagentName: subagentNameContext.getStore() || undefined,
      });
      await context.with(spanContext, async () => {
        this.safelyLogApiError('', durationMs, error, req.model, userPromptId);
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
    }
  }

  async generateContentStream(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const llmSpan = startLLMRequestSpan(req.model, userPromptId);
    try {
      llmSpan.setAttribute('llm_request.stream', true);
    } catch {
      /* best-effort */
    }

    // Capture the span context so the stream wrapper can activate it
    // during iteration — not just during generator creation.
    const spanContext = trace.setSpan(context.active(), llmSpan);

    const startTime = Date.now();
    const isInternal = isInternalPromptId(userPromptId);
    const session = this.startCaptureSession();

    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      runtimeDiagnostics.recordGenerateContentRequest(req, {
        stream: true,
        source: 'generateContentStream',
      });
      if (!isInternal) {
        addSystemPromptAttributes(
          this.config,
          llmSpan,
          req.config?.systemInstruction,
        );
        addToolSchemaAttributes(
          this.config,
          llmSpan,
          req.config?.tools as unknown[] | undefined,
        );
      }
      stream = await context.with(spanContext, async () => {
        if (!isInternal) {
          this.logApiRequest(
            this.toContents(req.contents),
            req.model,
            userPromptId,
          );
        }
        return session.wrap(() =>
          this.wrapped.generateContentStream(req, userPromptId),
        );
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      context.with(spanContext, () =>
        this.safelyLogApiError('', durationMs, error, req.model, userPromptId),
      );
      const aborted = req.config?.abortSignal?.aborted ?? false;
      endLLMRequestSpan(llmSpan, {
        success: false,
        durationMs,
        error: aborted
          ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
          : API_CALL_FAILED_SPAN_STATUS_MESSAGE,
        errorType: getErrorType(error),
        errorStatusCode: getErrorStatus(error),
        subagentName: subagentNameContext.getStore() || undefined,
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

    let resolvedRequest: OpenAI.Chat.ChatCompletionCreateParams | undefined;
    if (this.openaiLogger) {
      try {
        resolvedRequest = await session.resolve(req);
      } catch (loggingError) {
        debugLogger.warn('Failed to resolve OpenAI request:', loggingError);
      }
    }

    return context.with(spanContext, () =>
      this.loggingStreamWrapper(
        stream,
        startTime,
        userPromptId,
        req.model,
        resolvedRequest,
        llmSpan,
        spanContext,
        req.config?.abortSignal,
      ),
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
    userPromptId: string,
    model: string,
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
    span?: Span,
    spanContext?: Context,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const isInternal = isInternalPromptId(userPromptId);
    // Skip collecting full responses for internal prompts to avoid memory
    // overhead, unless OpenAI file logging needs them.
    const shouldCollectResponses = !isInternal || !!this.openaiLogger;
    const responses: GenerateContentResponse[] = [];

    // Track first-seen IDs so _logApiResponse/_logApiError have accurate
    // values even when we skip collecting full responses for internal prompts.
    let firstResponseId = '';
    let firstModelVersion = '';
    let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined;
    let errorOccurred = false;
    let lastFinishReason: string | undefined;
    let lastError: unknown;
    const subagentName = subagentNameContext.getStore();

    // TTFT (time to first token): wall-clock from generateContentStream
    // dispatch to the first stream chunk containing user-visible content.
    // Method-local closure variable — NEVER an instance field — because
    // LoggingContentGenerator is shared across concurrent generateContentStream
    // calls (one per ContentGenerator, see contentGenerator.ts:createContentGenerator).
    // See docs/design/telemetry-llm-request-timing-design.md (D1, D2).
    let ttftMs: number | undefined;
    // Tracks whether the idle timeout fired and ended the span. If so,
    // a resumed-after-timeout consumer must not call endLLMRequestSpan
    // again (the helper would no-op, but more importantly we skip the
    // redundant work and avoid resetting the timer further).
    let spanEndedByTimeout = false;

    // Helper to run code within the span context during iteration.
    // This ensures debug log lines emitted during stream processing
    // see the stream span as the active span.
    const runInSpan = <T>(fn: () => T): T =>
      spanContext ? context.with(spanContext, fn) : fn();

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
            try {
              span.setAttribute('stream.timed_out', true);
            } catch {
              // OTel errors must not interrupt the consumer.
            }
            endLLMRequestSpan(span, {
              success: false,
              durationMs: Date.now() - startTime,
              error: 'Stream span timed out (idle)',
              responseId: firstResponseId || undefined,
              subagentName: subagentName || undefined,
            });
            spanEndedByTimeout = true;
          }, STREAM_IDLE_TIMEOUT_MS);
          spanEndTimeout.unref();
        }
      : undefined;
    resetSpanTimeout?.();

    try {
      for await (const response of stream) {
        if (!firstResponseId && response.responseId) {
          firstResponseId = response.responseId;
        }
        if (!firstModelVersion && response.modelVersion) {
          firstModelVersion = response.modelVersion;
        }
        if (shouldCollectResponses) {
          responses.push(response);
        }
        if (response.usageMetadata) {
          lastUsageMetadata = response.usageMetadata;
        }
        const candidate = response.candidates?.[0];
        if (candidate?.finishReason) {
          lastFinishReason = candidate.finishReason as string;
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
      if (spanEndTimeout !== undefined) {
        clearTimeout(spanEndTimeout);
        spanEndTimeout = undefined;
      }
      // Only log successful API response if no error occurred
      const durationMs = Date.now() - startTime;
      const consolidatedResponse = shouldCollectResponses
        ? this.consolidateGeminiResponsesForLogging(responses)
        : undefined;
      const streamResponseText = isInternal
        ? undefined
        : this.extractResponseText(consolidatedResponse);
      // If the idle timeout already closed the span as failed, do not contradict
      // it with a "success" api_response log or model-output span attributes.
      // The OpenAI interaction log is also skipped — telemetry already carries
      // the timeout signal and a parallel "success" record would be confusing
      // during incident response .
      if (!spanEndedByTimeout) {
        runInSpan(() =>
          this.safelyLogApiResponse(
            firstResponseId,
            durationMs,
            firstModelVersion || model,
            userPromptId,
            lastUsageMetadata,
            streamResponseText,
          ),
        );
        if (!isInternal && span) {
          addModelOutputAttributes(this.config, span, streamResponseText);
        }
        await runInSpan(() =>
          this.safelyLogOpenAIInteraction(
            openaiRequest,
            consolidatedResponse,
            undefined,
            userPromptId,
          ),
        );
      }
    } catch (error) {
      errorOccurred = true;
      lastError = error;
      // Same gating as the success path above: if the idle timeout already
      // closed the span as failed, do not emit a parallel api_error log
      // (the span is the canonical signal). Otherwise we'd produce the
      // exact contradictory pair the timeout fix targets — span timed-out
      // + api_error log — just on the error branch ( review).
      if (!spanEndedByTimeout) {
        const durationMs = Date.now() - startTime;
        runInSpan(() =>
          this.safelyLogApiError(
            firstResponseId,
            durationMs,
            error,
            firstModelVersion || model,
            userPromptId,
          ),
        );
        await runInSpan(() =>
          this.safelyLogOpenAIInteraction(
            openaiRequest,
            undefined,
            error,
            userPromptId,
          ),
        );
      }
      throw error;
    } finally {
      if (spanEndTimeout !== undefined) {
        clearTimeout(spanEndTimeout);
      }
      // If the idle timeout already ended the span, skip the redundant
      // endLLMRequestSpan call. The helper itself would no-op due to its
      // own ended guard, but we want to avoid pretending the final token
      // counts were recorded — they weren't, the span is the timeout one.
      if (span && !spanEndedByTimeout) {
        const aborted = abortSignal?.aborted ?? false;
        endLLMRequestSpan(span, {
          success: !errorOccurred,
          inputTokens: lastUsageMetadata?.promptTokenCount,
          outputTokens: lastUsageMetadata?.candidatesTokenCount,
          cachedInputTokens: lastUsageMetadata?.cachedContentTokenCount,
          ttftMs,
          durationMs: Date.now() - startTime,
          error: errorOccurred
            ? aborted
              ? API_CALL_ABORTED_SPAN_STATUS_MESSAGE
              : API_CALL_FAILED_SPAN_STATUS_MESSAGE
            : undefined,
          responseId: firstResponseId || undefined,
          finishReason: lastFinishReason,
          thoughtsTokenCount: lastUsageMetadata?.thoughtsTokenCount,
          subagentName: subagentName || undefined,
          errorType: lastError ? getErrorType(lastError) : undefined,
          errorStatusCode: lastError ? getErrorStatus(lastError) : undefined,
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
    const messages = OpenAIContentConverter.convertGeminiRequestToOpenAI(
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
        await OpenAIContentConverter.convertGeminiToolsToOpenAI(
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
      ? this.convertGeminiResponseToOpenAIForLogging(response, openaiRequest)
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

  private convertGeminiResponseToOpenAIForLogging(
    response: GenerateContentResponse,
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
  ): OpenAI.Chat.ChatCompletion {
    return OpenAIContentConverter.convertGeminiResponseToOpenAI(
      response,
      this.createLoggingRequestContext(openaiRequest.model),
    );
  }

  private consolidateGeminiResponsesForLogging(
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
  ): string | undefined {
    const parts = response?.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      return undefined;
    }

    let text = '';
    let hasText = false;
    let truncated = false;
    const appendText = (partText: string) => {
      hasText = true;
      if (truncated) {
        return;
      }

      const remaining = MAX_RESPONSE_TEXT_PREFIX_LENGTH - text.length;
      if (partText.length <= remaining) {
        text += partText;
        return;
      }

      text += partText.slice(0, Math.max(0, remaining));
      truncated = true;
    };

    for (const part of parts as Part[]) {
      if (typeof part === 'string') {
        appendText(part);
        continue;
      }

      if (
        'text' in part &&
        typeof part.text === 'string' &&
        !('thought' in part && part.thought)
      ) {
        appendText(part.text);
      }
    }

    if (!hasText) {
      return undefined;
    }

    return truncated ? `${text}${RESPONSE_TEXT_TRUNCATION_SUFFIX}` : text;
  }

  async countTokens(req: CountTokensParameters): Promise<CountTokensResponse> {
    return this.wrapped.countTokens(req);
  }

  async embedContent(
    req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.wrapped.embedContent(req);
  }

  useSummarizedThinking(): boolean {
    return this.wrapped.useSummarizedThinking();
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

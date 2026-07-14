/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import {
  type GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { OpenAIContentConverter } from './converter.js';
import { DashScopeOpenAICompatibleProvider } from './provider/dashscope.js';
import { isDeepSeekHostname } from './provider/deepseek.js';
import { openaiRequestCaptureContext } from './requestCaptureContext.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import { TaggedThinkingParser } from './taggedThinkingParser.js';
import type { PipelineConfig, RequestContext } from './types.js';
import { redactProxyError } from '../../utils/runtimeFetchOptions.js';
import { runtimeDiagnostics } from '../../utils/runtimeDiagnostics.js';
import { createChildAbortController } from '../../utils/abortController.js';
import { reconcileMaxTokens } from '../tokenLimits.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
} from './constants.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { InvalidStreamError } from '../invalid-stream-error.js';
import { logProtocolTagSanitized } from '../../telemetry/loggers.js';
import { ProtocolTagSanitizedEvent } from '../../telemetry/types.js';

const debugLogger = createDebugLogger('OPENAI_PIPELINE');

/**
 * Error thrown when the API returns an error embedded as stream content
 * instead of a proper HTTP error. Some providers (e.g., certain OpenAI-compatible
 * endpoints) return throttling errors as a normal SSE chunk with
 * finish_reason="error_finish" and the error message in delta.content.
 */
export class StreamContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamContentError';
  }
}

/**
 * Thrown when a streaming response goes silent past the inactivity timeout.
 * `code: 'ETIMEDOUT'` makes `classifyRetryError` treat it as a retryable
 * transport error, identical to a real socket read timeout.
 */
export class StreamInactivityTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly idleMs: number,
    readonly chunksReceived: number,
    readonly streamLifetimeMs: number,
  ) {
    super(
      `No stream activity for ${idleMs}ms after ${chunksReceived} chunks ` +
        `(stream lifetime: ${streamLifetimeMs}ms). Set ` +
        `${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV} to increase this window ` +
        `(or 0 to disable it).`,
    );
    this.name = 'StreamInactivityTimeoutError';
  }
}

/**
 * Maximum bytes of response body to include in NonSSEResponseError diagnostics.
 */
const NON_SSE_BODY_PREFIX_LIMIT = 512;

/**
 * Content-type prefixes that are compatible with SSE streaming. Anything
 * outside this set (e.g. `text/html`) indicates the upstream did not return
 * an SSE stream — typically a gateway/proxy interception page.
 */
function isSSECompatibleContentType(contentType: string | null): boolean {
  if (!contentType) return true; // absence → assume SSE (SDK default)
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return (
    mediaType === 'text/event-stream' ||
    mediaType === 'application/x-ndjson' ||
    mediaType === 'application/stream+json'
  );
}

/**
 * Thrown when the HTTP 200 response to a streaming request has a content-type
 * incompatible with SSE (e.g. `text/html` from a gateway block page). Carries
 * bounded diagnostic metadata so the user/maintainer can distinguish "model
 * returned empty stream" from "upstream returned a non-SSE page".
 */
export class NonSSEResponseError extends Error {
  readonly status: number;
  readonly request_id: string | null;

  constructor(
    readonly contentType: string | null,
    readonly httpStatus: number,
    readonly bodyPrefix: string,
    readonly requestId: string | null,
  ) {
    const preview = bodyPrefix.length > 0 ? ` Body prefix: ${bodyPrefix}` : '';
    super(
      `Streaming request received a non-SSE response ` +
        `(HTTP ${httpStatus}, Content-Type: ${contentType || 'unknown'}).` +
        `${preview}`,
    );
    this.name = 'NonSSEResponseError';
    this.status = httpStatus;
    this.request_id = requestId;
  }
}

/**
 * Provider-specific output-budget keys that stand in for `max_tokens` on the
 * wire (e.g. GPT-5 / o-series use `max_completion_tokens`). When a user's
 * samplingParams already carries one of these, the window clamp must not also
 * inject `max_tokens`: sending the pair double-specifies the output budget and
 * some endpoints reject it.
 */
const PROVIDER_OUTPUT_BUDGET_KEYS = ['max_completion_tokens', 'max_new_tokens'];

function hasProviderOutputBudgetKey(samplingParams: {
  [key: string]: unknown;
}): boolean {
  return PROVIDER_OUTPUT_BUDGET_KEYS.some(
    (key) => samplingParams[key] !== undefined,
  );
}

/**
 * Clamp any provider-specific output-budget key (e.g. `max_completion_tokens`)
 * to the window's remaining room, mutating and returning the passed object.
 * An output budget is subject to `prompt + output ≤ window` regardless of the
 * key it travels under, so we shrink the key's value to `requestMaxTokens` when
 * it exceeds it — but we clamp the value in place rather than injecting a
 * separate `max_tokens`, which would double-specify the budget and be rejected
 * by endpoints like the o-series. When there is room (or no clamp value is
 * available), the user's value passes through unchanged.
 */
function clampProviderOutputBudgetKeys(
  samplingParams: { [key: string]: unknown },
  requestMaxTokens: number | undefined,
): { [key: string]: unknown } {
  if (typeof requestMaxTokens !== 'number') return samplingParams;
  for (const key of PROVIDER_OUTPUT_BUDGET_KEYS) {
    const value = samplingParams[key];
    if (typeof value === 'number' && value > requestMaxTokens) {
      samplingParams[key] = requestMaxTokens;
    }
  }
  return samplingParams;
}

/**
 * Resolve the effective streaming inactivity timeout (ms). Precedence:
 * explicit `ContentGeneratorConfig.streamIdleTimeoutMs` (programmatic, wins —
 * including `0` to disable) > the `QWEN_STREAM_IDLE_TIMEOUT_MS` env deployment
 * knob > the built-in default. A malformed env value is ignored (with a
 * `console.warn`) rather than failing the request.
 */
function resolveStreamIdleTimeoutMs(config: ContentGeneratorConfig): number {
  // 1. Explicit config field (programmatic) wins:
  //    - `<= 0` disables the watchdog (downstream `idleMs > 0` guard skips it).
  //    - Values above the JS timer ceiling are rejected: setTimeout silently
  //      compresses them to 1ms, which would fire near-immediately.
  //    - NaN/Infinity/non-integer are invalid.
  const fromConfig = config.streamIdleTimeoutMs;
  if (typeof fromConfig === 'number') {
    if (
      Number.isInteger(fromConfig) &&
      fromConfig <= MAX_STREAM_IDLE_TIMEOUT_MS
    ) {
      return fromConfig;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring out-of-range streamIdleTimeoutMs=${fromConfig} ` +
        `(expected an integer in (-∞, ${MAX_STREAM_IDLE_TIMEOUT_MS}]); ` +
        `falling back to ${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV}/default.`,
    );
  }
  // 2. Env deployment knob. Strict decimal integer only — reject hex/scientific
  //    notation/floats/signs so a typo can't silently become a surprising
  //    timeout. `0` disables; values above the timer ceiling are rejected.
  const raw = process.env[QWEN_STREAM_IDLE_TIMEOUT_MS_ENV];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (parsed <= MAX_STREAM_IDLE_TIMEOUT_MS) {
        return parsed;
      }
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring invalid ${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV}="${raw}" ` +
        `(expected an integer of milliseconds in [0, ${MAX_STREAM_IDLE_TIMEOUT_MS}]); ` +
        `using default ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms.`,
    );
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * Wraps a streaming chunk source with an inactivity watchdog. If no chunk
 * arrives for `idleMs`, `abortRequest()` is invoked (to abort the underlying
 * request and free the socket) and the iterator throws — a user `AbortError`
 * when the parent signal was cancelled, otherwise a retryable ETIMEDOUT. The
 * timer resets on every chunk (including thinking/reasoning deltas), so an
 * actively streaming model is never interrupted.
 */
async function* withStreamInactivityTimeout(
  source: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  idleMs: number,
  abortRequest: () => void,
  parentSignal: AbortSignal | undefined,
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  const it = source[Symbol.asyncIterator]();
  const streamStartedAt = Date.now();
  let chunksReceived = 0;
  try {
    while (true) {
      const nextPromise = it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (parentSignal?.aborted) {
            // Plain Error (not DOMException) so error redaction's prototype
            // clone cannot corrupt it; name 'AbortError' satisfies isAbortError.
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          } else {
            abortRequest();
            reject(
              new StreamInactivityTimeoutError(
                idleMs,
                chunksReceived,
                Date.now() - streamStartedAt,
              ),
            );
          }
        }, idleMs);
        timer.unref?.();
      });
      let result: IteratorResult<OpenAI.Chat.ChatCompletionChunk>;
      try {
        result = await Promise.race([nextPromise, timeout]);
      } catch (err) {
        // Once abortRequest() aborts the request, the orphaned next() rejects
        // with an AbortError; swallow it so it is not an unhandled rejection.
        void Promise.resolve(nextPromise).catch(() => {});
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) return;
      chunksReceived += 1;
      yield result.value;
    }
  } finally {
    abortRequest();
    try {
      await it.return?.();
    } catch {
      // The abort above is the cleanup that matters; ignore return failures.
    }
  }
}

export type { PipelineConfig } from './types.js';

export class ContentGenerationPipeline {
  client: OpenAI;
  private contentGeneratorConfig: ContentGeneratorConfig;
  // Resolved once (config field > env > default) so the env read + any
  // invalid-value warning happen per pipeline, not per streaming request.
  private readonly streamIdleTimeoutMs: number;

  constructor(private config: PipelineConfig) {
    this.contentGeneratorConfig = config.contentGeneratorConfig;
    this.client = this.config.provider.buildClient();
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(
      this.contentGeneratorConfig,
    );
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      false,
      async (openaiRequest, context) => {
        // Wrap in a per-request child so the OpenAI SDK's leaked abort
        // listener (client.mjs fetchWithTimeout — no {once:true}, no
        // removeEventListener) stays on a short-lived signal instead of
        // accumulating on the caller's long-lived round signal.
        const parentSignal = request.config?.abortSignal;
        const perRequestAc = parentSignal
          ? createChildAbortController(parentSignal)
          : undefined;
        try {
          const openaiResponse = (await this.client.chat.completions.create(
            openaiRequest,
            {
              signal: perRequestAc?.signal,
            },
          )) as OpenAI.Chat.ChatCompletion;

          const geminiResponse =
            OpenAIContentConverter.convertOpenAIResponseToGemini(
              openaiResponse,
              context,
            );

          return geminiResponse;
        } finally {
          perRequestAc?.abort();
        }
      },
    );
  }

  async executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      true,
      async (openaiRequest, context) => {
        // Always use a per-request controller so the inactivity watchdog can
        // abort the SDK request even when the caller did not provide a signal.
        const parentSignal = request.config?.abortSignal;
        const perRequestAc = createChildAbortController(parentSignal);
        let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
        try {
          // Stage 1: Create OpenAI stream. Wrapped in try so a network /
          // DNS / proxy error during the SDK call still cleans up the
          // per-request child (same pattern as the non-streaming path).
          //
          // Use withResponse() to access HTTP response headers — this allows
          // early detection of non-SSE responses (e.g. gateway block pages
          // returning text/html with HTTP 200).
          const createPromise = this.client.chat.completions.create(
            openaiRequest,
            { signal: perRequestAc.signal },
          );

          // withResponse() is available on APIPromise (the OpenAI SDK's
          // extended Promise). If unavailable (e.g. a mock), fall back.
          if (
            typeof (createPromise as { withResponse?: unknown })
              .withResponse === 'function'
          ) {
            const {
              data,
              response: httpResponse,
              request_id,
            } = await (
              createPromise as unknown as {
                withResponse(): Promise<{
                  data: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
                  response: Response;
                  request_id: string | null;
                }>;
              }
            ).withResponse();
            stream = data;

            // Validate content-type: a non-SSE content-type on a streaming
            // request means the upstream (gateway/proxy) returned something
            // other than an event stream — surface it immediately.
            const contentType =
              httpResponse.headers.get('content-type') ?? null;
            if (!isSSECompatibleContentType(contentType)) {
              // Read a bounded prefix of the body for diagnostics. The body
              // may already be consumed by the SDK's stream parser; in that
              // case we fall through with an empty prefix.
              let bodyPrefix = '';
              try {
                if (httpResponse.body) {
                  const reader = httpResponse.body.getReader();
                  const { value } = await reader.read();
                  reader.releaseLock();
                  if (value) {
                    bodyPrefix = new TextDecoder()
                      .decode(value)
                      .slice(0, NON_SSE_BODY_PREFIX_LIMIT);
                  }
                }
              } catch {
                // Body already consumed by the SDK — expected; proceed
                // without the prefix.
              }
              throw new NonSSEResponseError(
                contentType,
                httpResponse.status,
                bodyPrefix,
                request_id,
              );
            }
          } else {
            stream =
              (await createPromise) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
          }
        } catch (e) {
          perRequestAc.abort();
          throw e;
        }

        // Inactivity watchdog: the SDK `timeout` only bounds connect + first
        // response, so a stream that returns 200 then goes silent is otherwise
        // unbounded. Abort + surface a retryable ETIMEDOUT after `idleMs` of no
        // chunks. `<= 0` disables it.
        const idleMs = this.streamIdleTimeoutMs;
        const guarded =
          idleMs > 0
            ? withStreamInactivityTimeout(
                stream,
                idleMs,
                () => perRequestAc.abort(),
                parentSignal,
              )
            : stream;

        // Stage 2: Process stream with conversion and logging.
        // Wrap in an async generator that aborts the per-request controller
        // once the stream is fully consumed or abandoned, releasing the SDK
        // request and any parent listener.
        const innerStream = this.processStreamWithLogging(
          guarded,
          context,
          request,
          userPromptId,
        );
        async function* drainThenCleanup(): AsyncGenerator<GenerateContentResponse> {
          try {
            yield* innerStream;
          } finally {
            perRequestAc.abort();
          }
        }
        return drainThenCleanup();
      },
    );
  }

  /**
   * Stage 2: Process OpenAI stream with conversion and logging
   * This method handles the complete stream processing pipeline:
   * 1. Convert OpenAI chunks to Gemini format while preserving original chunks
   * 2. Filter empty responses
   * 3. Handle chunk merging for providers that send finishReason and usageMetadata separately
   * 4. Collect both formats for logging
   * 5. Handle success/error logging
   */
  private async *processStreamWithLogging(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    context: RequestContext,
    request: GenerateContentParameters,
    userPromptId: string,
  ): AsyncGenerator<GenerateContentResponse> {
    const collectedGeminiResponses: GenerateContentResponse[] = [];

    // State for handling chunk merging.
    // pendingFinishResponse holds a finish chunk waiting to be merged with
    // a subsequent usage-metadata chunk before yielding.
    // finishYielded is set to true once the merged finish response has been
    // yielded, so that any further trailing chunks are treated as normal
    // chunks instead of triggering another merge (which would duplicate the
    // function-call parts from the finish chunk).
    let pendingFinishResponse: GenerateContentResponse | null = null;
    let finishYielded = false;

    try {
      // Stage 2a: Convert and yield each chunk while preserving original
      for await (const chunk of stream) {
        // Detect API errors returned as stream content.
        // Some providers return errors (e.g., TPM throttling) as a normal SSE chunk
        // with finish_reason="error_finish" and the error in delta.content,
        // instead of returning a proper HTTP error status.
        if ((chunk.choices?.[0]?.finish_reason as string) === 'error_finish') {
          const errorContent =
            chunk.choices?.[0]?.delta?.content?.trim() ||
            'Unknown stream error';
          throw new StreamContentError(errorContent);
        }

        const response = OpenAIContentConverter.convertOpenAIChunkToGemini(
          chunk,
          context,
        );

        const sanitization = context.protocolTagSanitized;
        if (sanitization) {
          context.protocolTagSanitized = undefined;
          const event = new ProtocolTagSanitizedEvent({
            model: context.model,
            promptId: userPromptId,
            responseId: response.responseId,
            tagName: sanitization.tagName,
            toolCallCount: sanitization.toolCallCount,
          });
          debugLogger.warn('Sanitized a model protocol tag', {
            model: event.model,
            promptId: event.prompt_id,
            responseId: event.response_id,
            tagName: event.tag_name,
            handling: event.handling,
            toolCallCount: event.tool_call_count,
          });
          logProtocolTagSanitized(this.config.cliConfig, event);
        }

        // Stage 2b: Filter empty responses to avoid downstream issues
        if (
          response.candidates?.[0]?.content?.parts?.length === 0 &&
          !response.candidates?.[0]?.finishReason &&
          !response.usageMetadata
        ) {
          continue;
        }

        // Stage 2c: Handle chunk merging for providers that send
        // finishReason and usageMetadata in separate chunks.
        // Once the merged finish response has been yielded, skip
        // further merging so trailing chunks don't duplicate the
        // function-call parts carried by the finish chunk.
        if (finishYielded) {
          // Finish already yielded — absorb any remaining usage
          // metadata but do NOT yield another response.
          // Note: pendingFinishResponse is guaranteed non-null here because
          // finishYielded is only set to true inside the `if (pendingFinishResponse)`
          // block below. TypeScript cannot infer this through the callback
          // assignment in handleChunkMerging, so an explicit cast is needed.
          if (response.usageMetadata) {
            const pending =
              pendingFinishResponse as GenerateContentResponse | null;
            if (pending) {
              pending.usageMetadata = response.usageMetadata;
            }
          }
          collectedGeminiResponses.push(response);
          continue;
        }

        const shouldYield = this.handleChunkMerging(
          response,
          collectedGeminiResponses,
          (mergedResponse) => {
            pendingFinishResponse = mergedResponse;
          },
        );

        if (shouldYield) {
          // If we have a pending finish response, yield it instead
          if (pendingFinishResponse) {
            yield pendingFinishResponse;
            finishYielded = true;
            // Keep pendingFinishResponse alive so late-arriving usage
            // metadata can still be merged (see finishYielded block above).
          } else {
            yield response;
          }
        }
      }

      if (context.pendingThinkingTagCandidate) {
        throw new InvalidStreamError(
          'Model response leaked thinking tags.',
          'PROTOCOL_TAG_LEAK',
        );
      }

      // Stage 2d: If there's still a pending finish response at the end
      // (e.g. no usage chunk arrived after the finish chunk), yield it.
      if (pendingFinishResponse && !finishYielded) {
        yield pendingFinishResponse;
      }
    } catch (error) {
      if (error instanceof InvalidStreamError) {
        throw error;
      }

      // Re-throw StreamContentError directly so it can be handled by
      // the caller's retry logic (e.g., TPM throttling retry in sendMessageStream)
      if (error instanceof StreamContentError) {
        throw redactProxyError(error);
      }

      // Bypass handleError: it strips `code` from timeout errors, which would
      // prevent classifyRetryError from recognizing retryable ETIMEDOUT.
      if (error instanceof StreamInactivityTimeoutError) {
        debugLogger.warn('OpenAI stream inactivity timeout', {
          idleMs: error.idleMs,
          chunksReceived: error.chunksReceived,
          streamLifetimeMs: error.streamLifetimeMs,
        });
        throw redactProxyError(error);
      }

      // Use shared error handling logic
      await this.handleError(error, context, request);
    }
  }

  /**
   * Handle chunk merging for providers that send finishReason and usageMetadata separately.
   *
   * Strategy: When we encounter a finishReason chunk, we hold it and merge all subsequent
   * chunks into it until the stream ends. This ensures the final chunk contains both
   * finishReason and the most up-to-date usage information from any provider pattern.
   *
   * @param response Current Gemini response
   * @param collectedGeminiResponses Array to collect responses for logging
   * @param setPendingFinish Callback to set pending finish response
   * @returns true if the response should be yielded, false if it should be held for merging
   */
  private handleChunkMerging(
    response: GenerateContentResponse,
    collectedGeminiResponses: GenerateContentResponse[],
    setPendingFinish: (response: GenerateContentResponse) => void,
  ): boolean {
    const isFinishChunk = response.candidates?.[0]?.finishReason;

    // Check if we have a pending finish response from previous chunks
    const hasPendingFinish =
      collectedGeminiResponses.length > 0 &&
      collectedGeminiResponses[collectedGeminiResponses.length - 1]
        .candidates?.[0]?.finishReason;

    if (isFinishChunk) {
      if (hasPendingFinish) {
        // Duplicate finish chunk (e.g. from OpenRouter providers that send two
        // finish_reason chunks for tool calls). The first finish response owns
        // the candidates, including functionCall parts. Merge only usageMetadata
        // from later finish chunks.
        const lastResponse =
          collectedGeminiResponses[collectedGeminiResponses.length - 1];
        if (response.usageMetadata) {
          lastResponse.usageMetadata = response.usageMetadata;
        }
        setPendingFinish(lastResponse);
      } else {
        // This is a finish reason chunk
        collectedGeminiResponses.push(response);
        setPendingFinish(response);
      }
      return false; // Don't yield yet, wait for potential subsequent chunks to merge
    } else if (hasPendingFinish) {
      // We have a pending finish chunk, merge this chunk's data into it
      const lastResponse =
        collectedGeminiResponses[collectedGeminiResponses.length - 1];
      const mergedResponse = new GenerateContentResponse();

      // Keep the finish reason from the previous chunk
      mergedResponse.candidates = lastResponse.candidates;

      // Merge usage metadata if this chunk has it
      if (response.usageMetadata) {
        mergedResponse.usageMetadata = response.usageMetadata;
      } else {
        mergedResponse.usageMetadata = lastResponse.usageMetadata;
      }

      // Copy other essential properties from the current response
      mergedResponse.responseId = response.responseId;
      mergedResponse.createTime = response.createTime;
      mergedResponse.modelVersion = response.modelVersion;
      mergedResponse.promptFeedback = response.promptFeedback;

      // Update the collected responses with the merged response
      collectedGeminiResponses[collectedGeminiResponses.length - 1] =
        mergedResponse;

      setPendingFinish(mergedResponse);
      return true; // Yield the merged response
    }

    // Normal chunk - collect and yield
    collectedGeminiResponses.push(response);
    return true;
  }

  private async buildRequest(
    request: GenerateContentParameters,
    userPromptId: string,
    context: RequestContext,
    isStreaming: boolean,
  ): Promise<OpenAI.Chat.ChatCompletionCreateParams> {
    const messages = OpenAIContentConverter.convertGeminiRequestToOpenAI(
      request,
      context,
    );

    // Apply provider-specific enhancements
    const baseRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: context.model,
      messages,
      ...this.buildGenerateContentConfig(request),
    };

    if (isStreaming) {
      (
        baseRequest as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming
      ).stream = true;
      baseRequest.stream_options = { include_usage: true };
    } else {
      // Explicit false required: some gateways default to SSE when the field is absent.
      (
        baseRequest as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
      ).stream = false;
    }

    // Add tools if present and non-empty.
    // Some providers reject tools: [] (empty array), so skip when there are no tools.
    if (request.config?.tools && request.config.tools.length > 0) {
      baseRequest.tools =
        await OpenAIContentConverter.convertGeminiToolsToOpenAI(
          request.config.tools,
          this.contentGeneratorConfig.schemaCompliance ?? 'auto',
        );
    }

    // Let provider enhance the request (e.g., add metadata, cache control)
    const providerRequest = this.config.provider.buildRequest(
      baseRequest,
      userPromptId,
    );

    // Reasoning is disabled when either:
    //   - the per-request opt-out is set (forked queries for suggestions),
    //   - the config-level opt-out is set (`reasoning: false`).
    // In both cases we want the wire shape to actually disable thinking,
    // not just remove the effort knob — otherwise providers whose default
    // is "thinking enabled" (DeepSeek V4+, qwen3) keep paying thinking
    // latency/cost.
    const reasoningDisabled =
      request.config?.thinkingConfig?.includeThoughts === false ||
      this.contentGeneratorConfig.reasoning === false;
    if (reasoningDisabled) {
      const typed = providerRequest as unknown as Record<string, unknown>;
      // Provider buildRequest doesn't auto-inject `enable_thinking`, so a
      // guarded `in typed` check would never fire for default qwen3 configs.
      // Hostname + model-name gate avoids leaking this qwen-specific field
      // to non-qwen routings on the same DashScope hostname (GLM uses
      // `extra_body.thinking.enabled`, DeepSeek-on-DashScope uses
      // `thinking: { type: 'disabled' }`; sending `enable_thinking` to them
      // is at best a no-op, at worst forwarded upstream and rejected).
      //
      // Gate on the *wire* model (`context.model`, i.e.
      // `request.model || contentGeneratorConfig.model` — the same value
      // baseRequest.model is built from above), not on the config model. A
      // request-level model override would otherwise desync the gate from
      // what actually ships: a qwen config with a non-qwen request model
      // would leak the field, and a non-qwen config with a qwen request
      // model would miss the disable signal (the regression).
      //
      // `coder-model` is the QWEN_OAUTH default (DEFAULT_QWEN_MODEL in
      // config/models.ts, aliased to Qwen 3.6 Plus hybrid) — it doesn't
      // start with `qwen` but is the most common hybrid-thinking model
      // for first-time users, so it must be covered.
      const model = (context.model ?? '').toLowerCase();
      if (model.startsWith('qwen') || model === 'coder-model') {
        if (
          DashScopeOpenAICompatibleProvider.isDashScopeProvider(
            this.contentGeneratorConfig,
          )
        ) {
          typed['enable_thinking'] = false;
        } else {
          // Non-DashScope OpenAI-compatible servers (vLLM, SGLang, ...) render
          // the model's chat template server-side and read the thinking switch
          // from `chat_template_kwargs`, not a top-level `enable_thinking`
          // (which they silently ignore). Send it there so hybrid qwen models
          // actually stop emitting <think> when reasoning is disabled — e.g.
          // the auto-mode permission classifier's short structured-output
          // calls, which otherwise spend their small token budget on thinking
          // and fail closed. Servers that don't recognise `chat_template_kwargs`
          // ignore the unknown field, so the switch is a harmless no-op there.
          //
          // Drop any top-level `enable_thinking` a provider preset injected via
          // extra_body (provider-config.ts emits it for models configured with
          // `enableThinking: true`): leaving it would contradict the
          // `chat_template_kwargs` opt-out on servers that honour both, and
          // keeps this path from leaking the qwen-specific field top-level.
          delete typed['enable_thinking'];
          const existing = (typed['chat_template_kwargs'] ?? {}) as Record<
            string,
            unknown
          >;
          typed['chat_template_kwargs'] = {
            ...existing,
            enable_thinking: false,
          };
        }
      }
      // Strip reasoning config — extra_body could inject it, overriding
      // buildReasoningConfig's decision to return {} for disabled thinking.
      // The provider hook (e.g. DeepSeekOpenAICompatibleProvider.buildRequest
      // → translateReasoningEffort) runs earlier in this same pass and may
      // have flattened the nested `reasoning` into a top-level
      // `reasoning_effort`, so we strip both shapes here.
      if ('reasoning' in typed) {
        delete typed['reasoning'];
      }
      if ('reasoning_effort' in typed) {
        delete typed['reasoning_effort'];
      }
      // DeepSeek V4+ defaults `thinking.type` to `'enabled'`, so removing
      // the effort knob alone leaves thinking on. Emit the explicit
      // `thinking: { type: 'disabled' }` shape from DeepSeek's API spec.
      // Hostname-gated: self-hosted DeepSeek (sglang/vllm) or older
      // DeepSeek versions may not accept the V4 thinking parameter, so
      // we don't push it there. See https://api-docs.deepseek.com/.
      if (isDeepSeekHostname(this.contentGeneratorConfig)) {
        typed['thinking'] = { type: 'disabled' };
      }
    }

    return providerRequest;
  }

  private buildGenerateContentConfig(
    request: GenerateContentParameters,
  ): Record<string, unknown> {
    const defaultSamplingParams =
      this.config.provider.getDefaultGenerationConfig();
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;

    // Helper function to get parameter value with priority: config > request > default
    const getParameterValue = <T>(
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
    ): T | undefined => {
      const configValue = configSamplingParams?.[configKey] as T | undefined;
      const requestValue = requestKey
        ? (request.config?.[requestKey] as T | undefined)
        : undefined;
      const defaultValue = requestKey
        ? (defaultSamplingParams[requestKey] as T)
        : undefined;

      if (configValue !== undefined) return configValue;
      if (requestValue !== undefined) return requestValue;
      return defaultValue;
    };

    // Helper function to conditionally add parameter if it has a value
    const addParameterIfDefined = <T>(
      key: string,
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
    ): Record<string, T | undefined> => {
      const value = getParameterValue<T>(configKey, requestKey);

      return value !== undefined ? { [key]: value } : {};
    };

    // When samplingParams is set, its keys pass through to the wire verbatim.
    // This lets users target provider-specific parameter names
    // (e.g. `max_completion_tokens` for GPT-5 / o-series) without a client release.
    // No output budget escapes the window clamp, whatever key it travels under:
    //   - max_tokens is a ceiling, not an exemption — when both a config
    //     max_tokens and the (clamped) request maxOutputTokens are present the
    //     smaller wins; when samplingParams omits max_tokens the clamped request
    //     value is injected.
    //   - A provider-specific output-budget key (max_completion_tokens,
    //     max_new_tokens) is clamped in place to the window instead — we do NOT
    //     also inject max_tokens, since sending the pair double-specifies the
    //     budget and some endpoints (o-series) reject it. Its value only shrinks
    //     when the window is tight; when there is room it passes through as-is.
    // So `prompt + max_tokens ≤ window` holds for samplingParams users too,
    // matching the Anthropic path.
    if (configSamplingParams !== undefined) {
      const requestMaxTokens = request.config?.maxOutputTokens;
      const maxTokens =
        reconcileMaxTokens(configSamplingParams.max_tokens, requestMaxTokens) ??
        configSamplingParams.max_tokens ??
        (hasProviderOutputBudgetKey(configSamplingParams)
          ? undefined
          : requestMaxTokens);
      // Single exit: whatever the branch decided about max_tokens, any
      // provider-specific output-budget key in the result is clamped to the
      // window too — a config carrying both max_tokens and e.g.
      // max_completion_tokens must not leak the provider key unclamped.
      return clampProviderOutputBudgetKeys(
        maxTokens !== undefined
          ? { ...configSamplingParams, max_tokens: maxTokens }
          : { ...configSamplingParams },
        requestMaxTokens,
      );
    }

    const params: Record<string, unknown> = {
      // Parameters with request fallback but no defaults
      ...addParameterIfDefined('temperature', 'temperature', 'temperature'),
      ...addParameterIfDefined('top_p', 'top_p', 'topP'),

      // Max tokens (special case: different property names)
      ...addParameterIfDefined('max_tokens', 'max_tokens', 'maxOutputTokens'),

      // Config-only parameters (no request fallback)
      ...addParameterIfDefined('top_k', 'top_k', 'topK'),
      ...addParameterIfDefined('repetition_penalty', 'repetition_penalty'),
      ...addParameterIfDefined(
        'presence_penalty',
        'presence_penalty',
        'presencePenalty',
      ),
      ...addParameterIfDefined(
        'frequency_penalty',
        'frequency_penalty',
        'frequencyPenalty',
      ),
      ...this.buildReasoningConfig(request),
    };

    return params;
  }

  private buildReasoningConfig(
    request: GenerateContentParameters,
  ): Record<string, unknown> {
    // Reasoning configuration for OpenAI-compatible endpoints is highly fragmented.
    // For example, across common providers and models:
    //
    //   - deepseek-reasoner — thinking is enabled by default and cannot be disabled
    //   - glm-4.7 — thinking is enabled by default; can be disabled via `extra_body.thinking.enabled`
    //   - kimi-k2-thinking — thinking is enabled by default and cannot be disabled
    //   - gpt-5.x series — thinking is enabled by default; can be disabled via `reasoning.effort`
    //   - qwen3 series — model-dependent; emitted as `enable_thinking: false`
    //                           on DashScope endpoints when reasoning is disabled
    //
    // Given this inconsistency, we avoid mapping values and only pass through the
    // configured reasoning object when explicitly enabled. This keeps provider- and
    // model-specific semantics intact while honoring request-level opt-out.

    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return {};
    }

    const reasoning = this.contentGeneratorConfig.reasoning;

    if (reasoning === false || reasoning === undefined) {
      return {};
    }

    return { reasoning };
  }

  /**
   * Common error handling wrapper for execute methods
   */
  private async executeWithErrorHandling<T>(
    request: GenerateContentParameters,
    userPromptId: string,
    isStreaming: boolean,
    executor: (
      openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
      context: RequestContext,
    ) => Promise<T>,
  ): Promise<T> {
    const context = this.createRequestContext(request, isStreaming);

    try {
      const openaiRequest = await this.buildRequest(
        request,
        userPromptId,
        context,
        isStreaming,
      );

      // Position is load-bearing: capture must run after buildRequest (post
      // provider enhancement, post disable-reasoning) and before the SDK call
      // so the logger sees the exact bytes sent on the wire.
      openaiRequestCaptureContext.getStore()?.(openaiRequest);
      runtimeDiagnostics.recordOpenAIWireRequest(openaiRequest);

      const result = await executor(openaiRequest, context);
      return result;
    } catch (error) {
      // Use shared error handling logic
      return await this.handleError(error, context, request);
    }
  }

  /**
   * Shared error handling logic for both executeWithErrorHandling and processStreamWithLogging
   * This centralizes the common error processing steps to avoid duplication
   */
  private async handleError(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): Promise<never> {
    this.config.errorHandler.handle(redactProxyError(error), context, request);
  }

  /**
   * Create request context with common properties
   */
  private createRequestContext(
    request: GenerateContentParameters,
    isStreaming: boolean,
  ): RequestContext {
    const effectiveModel = request.model || this.contentGeneratorConfig.model;
    const providerOverrides =
      this.config.provider.getRequestContextOverrides?.() ?? {};
    const toolCallParser = isStreaming
      ? new StreamingToolCallParser()
      : undefined;
    const responseParsingOptions =
      this.config.provider.getResponseParsingOptions?.();
    const taggedThinkingParser =
      isStreaming && responseParsingOptions?.taggedThinkingTags
        ? new TaggedThinkingParser()
        : undefined;

    return {
      model: effectiveModel,
      modalities: this.contentGeneratorConfig.modalities ?? {},
      startTime: Date.now(),
      splitToolMedia:
        providerOverrides.splitToolMedia ??
        this.contentGeneratorConfig.splitToolMedia ??
        // Default true: the OpenAI Chat Completions spec only permits text on
        // `role: "tool"` messages, so tool-returned media (e.g. an image read
        // by read_file) embedded there is silently dropped or rejected by
        // strict providers (doubao / new-api / LM Studio) and the model never
        // sees it (QwenLM/qwen-code#4876). Splitting it into a follow-up user
        // message is spec-compliant and safe for permissive providers too.
        // Opt out via generationConfig.splitToolMedia = false.
        true,
      toolResultContentFormat:
        providerOverrides.toolResultContentFormat ??
        this.contentGeneratorConfig.toolResultContentFormat ??
        'parts',
      ...(toolCallParser ? { toolCallParser } : {}),
      ...(responseParsingOptions ? { responseParsingOptions } : {}),
      ...(taggedThinkingParser ? { taggedThinkingParser } : {}),
    };
  }
}

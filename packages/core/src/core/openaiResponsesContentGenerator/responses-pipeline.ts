/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse } from '@google/genai';
import type { GenerateContentParameters } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import type {
  ResponsesApiRequest,
  ResponsesApiReasoning,
  ResponsesSSEEvent,
  ResponsesSSEEventType,
} from './types.js';
import {
  ResponsesStreamState,
  convertResponsesEventToGemini,
  convertGeminiContentsToResponsesInput,
  convertGeminiToolsToResponsesTools,
  cleanOrphanedFunctionCalls,
} from './responses-converter.js';
import {
  buildRuntimeFetchOptions,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
} from '../openaiContentGenerator/constants.js';
import { createHash } from 'node:crypto';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('RESPONSES_PIPELINE');

/**
 * Thrown when the SSE read loop goes silent past the inactivity timeout.
 * `code: 'ETIMEDOUT'` makes `classifyRetryError` treat it as a retryable
 * transport error, identical to a real socket read timeout -- mirroring the
 * sibling Chat pipeline's StreamInactivityTimeoutError (which cannot be reused
 * directly here because it is typed to an OpenAI chunk async-iterable, whereas
 * this wire reads a raw byte ReadableStream).
 */
export class StreamInactivityTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly idleMs: number,
    readonly chunksReceived: number,
  ) {
    super(
      `No stream activity for ${idleMs}ms after ${chunksReceived} chunks. ` +
        `Set ${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV} to increase this window ` +
        `(or 0 to disable it).`,
    );
    this.name = 'StreamInactivityTimeoutError';
  }
}

// Resolve the streaming inactivity timeout (ms): explicit config field wins,
// then the env deployment knob, then the default -- mirroring the sibling Chat
// pipeline's resolveStreamIdleTimeoutMs. `<= 0` disables the watchdog; a value
// above the JS timer ceiling or a non-integer is rejected (setTimeout silently
// compresses oversized delays to ~1ms, which would fire near-immediately).
function resolveStreamIdleTimeoutMs(config: ContentGeneratorConfig): number {
  const fromConfig = config.streamIdleTimeoutMs;
  if (typeof fromConfig === 'number') {
    if (
      Number.isInteger(fromConfig) &&
      fromConfig <= MAX_STREAM_GUARD_TIMEOUT_MS
    ) {
      return fromConfig;
    }
  }
  const raw = process.env[QWEN_STREAM_IDLE_TIMEOUT_MS_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed <= MAX_STREAM_GUARD_TIMEOUT_MS) {
      return parsed;
    }
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

export class ResponsesPipeline {
  private readonly config: ContentGeneratorConfig;
  private readonly cliConfig: Config;
  // Resolved once (config field > env > default) so the env read happens per
  // pipeline, not per streaming request.
  private readonly streamIdleTimeoutMs: number;

  constructor(config: ContentGeneratorConfig, cliConfig: Config) {
    this.config = config;
    this.cliConfig = cliConfig;
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(config);
  }

  async *executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    yield* await this.connectStream(request, userPromptId, signal);
  }

  /**
   * Eagerly performs the connect phase (fetch + non-2xx handling + content-type
   * guard) and returns a lazy generator over the response body. Callers that
   * wrap the returned promise in retryWithBackoff (index.ts's
   * generateContentStream) then see connection-time HTTP errors -- a 500/502/504
   * or a 429 storm -- surface from the awaited promise and get retried, instead
   * of the errors escaping later during lazy iteration outside the retry
   * wrapper (a lazy `async *` generator resolves its promise before any network
   * I/O runs).
   */
  async connectStream(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const activeRequest = this.buildRequest(request, userPromptId);
    const streamState = new ResponsesStreamState();
    const reader = await this.connect(activeRequest, signal);
    return this.iterateBody(reader, streamState, signal);
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): Promise<GenerateContentResponse> {
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of this.executeStream(
      request,
      userPromptId,
      signal,
    )) {
      chunks.push(chunk);
    }
    return mergeStreamResponses(chunks);
  }

  private buildRequest(
    request: GenerateContentParameters,
    userPromptId: string,
  ): ResponsesApiRequest {
    const { instructions, input } =
      convertGeminiContentsToResponsesInput(request);
    const tools = convertGeminiToolsToResponsesTools(request);

    // History is always re-derived in full from this app's own Content[]
    // (matching every other content generator in this codebase) rather than
    // continued via previous_response_id, so context editing, compaction, and
    // mid-session model switching all keep working the same way they already
    // do for the other wires.
    const reasoning = this.buildReasoning();

    const apiRequest: ResponsesApiRequest = {
      model: this.config.model,
      input: cleanOrphanedFunctionCalls(input),
      instructions,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: true,
      prompt_cache_key: sanitizePromptCacheKey(userPromptId),
      // We never reference previous_response_id, so server-side storage of
      // the response buys nothing. The spec pairs reasoning.encrypted_content
      // with store:false as the intended stateless-replay recipe -- set it
      // unconditionally for consistency, not just when reasoning is on.
      store: false,
    };

    // Map Gemini-style toolConfig.functionCallingConfig.mode to the
    // Responses API's tool_choice, mirroring the Chat Completions and
    // Anthropic pipelines. Without this, structured side queries that force
    // tool use (e.g. baseLlmClient's respond_in_schema) fall back to
    // tool_choice:auto and reasoning-heavy models may skip the tool call
    // entirely.
    if (tools && tools.length > 0) {
      const fcMode = request.config?.toolConfig?.functionCallingConfig?.mode;
      if (fcMode === 'ANY') {
        apiRequest.tool_choice = 'required';
      } else if (fcMode === 'NONE') {
        apiRequest.tool_choice = 'none';
      }
    }

    if (reasoning) {
      apiRequest.reasoning = reasoning;
      // Request the encrypted reasoning blob so prior-turn thinking can be
      // replayed on the next turn via part.thoughtSignature. See
      // responses-converter.ts for the encode/decode side of this round trip.
      apiRequest.include = ['reasoning.encrypted_content'];
    }

    if (this.config.samplingParams) {
      if (this.config.samplingParams.temperature != null) {
        apiRequest.temperature = this.config.samplingParams.temperature;
      }
      if (this.config.samplingParams.top_p != null) {
        apiRequest.top_p = this.config.samplingParams.top_p;
      }
    }

    // The per-send output budget geminiChat window-clamps lives on
    // request.config.maxOutputTokens (issue #5950 invariant: prompt +
    // max_tokens <= window); it must win over the static samplingParams cap so
    // subagent budgets and the MAX_TOKENS escalation re-clamp reach this wire.
    const maxOut =
      request.config?.maxOutputTokens ?? this.config.samplingParams?.max_tokens;
    if (maxOut != null) {
      apiRequest.max_output_tokens = maxOut;
    }

    if (this.config.extra_body) {
      const requestRecord = apiRequest as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(this.config.extra_body)) {
        // apiRequest is built from an object literal, so optional fields
        // like `tools`/`instructions` are already present as keys even when
        // their value is undefined -- check the value, not just key presence,
        // so extra_body can still fill in a field nothing else set.
        if (!(key in requestRecord) || requestRecord[key] === undefined) {
          requestRecord[key] = value;
        }
      }
    }

    return apiRequest;
  }

  private buildReasoning(): ResponsesApiReasoning | undefined {
    const r = this.config.reasoning;
    if (r === false || r === undefined) return undefined;

    const reasoning: ResponsesApiReasoning = {};
    // The Responses API reasoning.effort enum (none, minimal, low, medium,
    // high, xhigh, max) is a superset of the unified ladder, so every tier
    // passes through verbatim with no clamping.
    if (r.effort) {
      reasoning.effort = r.effort;
      // 'auto' is required to receive reasoning_summary_text.delta events at
      // all; the unified reasoning config has no separate summary knob.
      reasoning.summary = 'auto';
    }

    return Object.keys(reasoning).length > 0 ? reasoning : undefined;
  }

  /**
   * Connect phase: build and send the request, validate the HTTP response, and
   * return a reader over the SSE body. Eagerly awaited so connection-time
   * failures (non-2xx, missing body, non-SSE content-type, transport errors)
   * reject the promise the caller can wrap in retryWithBackoff.
   */
  private async connect(
    apiRequest: ResponsesApiRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const baseUrl = (this.config.baseUrl || 'https://api.openai.com')
      .replace(/\/v1\/?$/, '')
      .replace(/\/$/, '');
    const url = `${baseUrl}/v1/responses`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    const apiKey =
      this.config.apiKey ??
      (this.config.apiKeyEnvKey
        ? process.env[this.config.apiKeyEnvKey]
        : undefined);
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    if (this.config.customHeaders) {
      Object.assign(headers, this.config.customHeaders);
    }

    const body = JSON.stringify(apiRequest);
    debugLogger.debug(`POST ${url}`, body.substring(0, 500));

    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers,
      body,
      signal,
    };

    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    if (runtimeOptions?.fetchOptions?.dispatcher) {
      fetchOpts.dispatcher = runtimeOptions.fetchOptions.dispatcher;
    }
    // Use the fetch buildRuntimeFetchOptions pins alongside the dispatcher
    // (same undici version as the dispatcher) rather than Node's global
    // fetch -- Node's built-in undici can be a different major version than
    // the bundled one, and handing it a foreign dispatcher throws `invalid
    // onError method`.
    const fetchFn =
      (runtimeOptions as { fetch?: typeof fetch } | undefined)?.fetch ?? fetch;

    let response: Response;
    try {
      response = await fetchFn(url, fetchOpts as RequestInit);
    } catch (error) {
      throw redactProxyError(error);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const err = new Error(
        `Responses API error ${response.status}: ${errBody.substring(0, 500)}`,
      );
      (err as ResponsesApiError).status = response.status;
      (err as ResponsesApiError).responseBody = errBody;
      throw redactProxyError(err);
    }

    if (!response.body) {
      throw new Error('Responses API returned no body');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType &&
      !/text\/event-stream|application\/x-ndjson|application\/stream\+json/.test(
        contentType,
      )
    ) {
      throw new Error(
        `Responses API returned non-SSE content-type: ${contentType}`,
      );
    }

    return response.body.getReader();
  }

  /**
   * Body-iteration phase: lazily drain the SSE reader, parse frames, and yield
   * Gemini responses. An idle watchdog around each `reader.read()` fails a
   * silent mid-stream stall with a retryable ETIMEDOUT (mirroring the Chat
   * pipeline's inactivity guard) instead of hanging forever; the timer resets
   * on every chunk, so an actively streaming model is never interrupted, and
   * `streamIdleTimeoutMs <= 0` disables it.
   */
  private async *iterateBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    streamState: ResponsesStreamState,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const idleMs = this.streamIdleTimeoutMs;
    let chunksReceived = 0;

    const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (idleMs <= 0) return reader.read();
      const readPromise = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // A user cancellation wins over the watchdog's retryable ETIMEDOUT.
          // Reject only -- do NOT cancel the reader here: cancel() resolves the
          // pending read() as { done: true } synchronously, which would win the
          // race over this rejection. The generator's finally cancels the
          // reader (freeing the socket) once this error propagates out.
          if (signal?.aborted) {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          } else {
            reject(new StreamInactivityTimeoutError(idleMs, chunksReceived));
          }
        }, idleMs);
        timer.unref?.();
      });
      return Promise.race([readPromise, timeout])
        .catch((err) => {
          // The orphaned read() rejects once the body is cancelled; swallow it
          // so it is not an unhandled rejection.
          void Promise.resolve(readPromise).catch(() => {});
          throw err;
        })
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
    };

    const convertParsedFrame = (
      eventType: ResponsesSSEEventType,
      data: Record<string, unknown>,
    ): GenerateContentResponse | null => {
      const sseEvent: ResponsesSSEEvent = { event: eventType, data };
      return convertResponsesEventToGemini(
        sseEvent,
        this.config.model,
        streamState,
      );
    };

    // Shared by both SSE framing styles this method has to accept: an
    // `event: ` line followed by a blank-line-terminated `data: ` block
    // (the standard-compliant shape), and a data-only `data: {"type":...}`
    // line with no `event: ` line (the shape the OpenAI Responses API
    // actually emits on the wire).
    const parseSSEFrame = (
      eventType: ResponsesSSEEventType,
      dataStr: string,
    ): GenerateContentResponse | null => {
      try {
        const data = JSON.parse(dataStr) as Record<string, unknown>;
        return convertParsedFrame(eventType, data);
      } catch (err) {
        if (err instanceof SyntaxError) {
          debugLogger.debug(
            `Failed to parse SSE data: ${dataStr.substring(0, 200)}`,
          );
          return null;
        }
        throw redactProxyError(err);
      }
    };

    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType: ResponsesSSEEventType | null = null;
    let dataAccumulator = '';

    try {
      while (true) {
        const { done, value } = await readChunk();
        if (done) break;
        chunksReceived += 1;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim() as ResponsesSSEEventType;
            dataAccumulator = '';
            continue;
          }

          if (line.startsWith('data: ')) {
            const dataContent = line.slice(6);
            if (dataContent === '[DONE]') continue;

            if (currentEventType) {
              dataAccumulator += (dataAccumulator ? '\n' : '') + dataContent;
            } else {
              try {
                const data = JSON.parse(dataContent) as Record<string, unknown>;
                const eventType = data['type'] as
                  | ResponsesSSEEventType
                  | undefined;
                if (eventType) {
                  const geminiResp = convertParsedFrame(eventType, data);
                  if (geminiResp) {
                    yield geminiResp;
                  }
                }
              } catch (err) {
                if (err instanceof SyntaxError) {
                  debugLogger.debug(
                    `Failed to parse SSE data: ${dataContent.substring(0, 200)}`,
                  );
                } else {
                  throw redactProxyError(err);
                }
              }
            }
            continue;
          }

          if (line.trim() === '' && currentEventType && dataAccumulator) {
            const geminiResp = parseSSEFrame(currentEventType, dataAccumulator);
            if (geminiResp) {
              yield geminiResp;
            }
            currentEventType = null;
            dataAccumulator = '';
          } else if (line.trim() === '') {
            currentEventType = null;
            dataAccumulator = '';
          }
        }
      }

      // A stream can also close with a final `data: ` line that has no
      // trailing newline at all -- distinct from the missing-blank-line
      // case below, since `buffer.split('\n')` never routes an
      // unterminated line through the main per-line loop above. Process
      // it here the same way that loop would, so a connection dropped
      // mid-frame doesn't silently lose the last frame.
      if (buffer.startsWith('data: ')) {
        const dataContent = buffer.slice(6);
        if (dataContent !== '[DONE]') {
          if (currentEventType) {
            dataAccumulator += (dataAccumulator ? '\n' : '') + dataContent;
          } else {
            try {
              const data = JSON.parse(dataContent) as Record<string, unknown>;
              const eventType = data['type'] as
                | ResponsesSSEEventType
                | undefined;
              if (eventType) {
                const geminiResp = convertParsedFrame(eventType, data);
                if (geminiResp) {
                  yield geminiResp;
                }
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                debugLogger.debug(
                  `Failed to parse SSE data: ${dataContent.substring(0, 200)}`,
                );
              } else {
                throw redactProxyError(err);
              }
            }
          }
        }
      }

      // The stream can close without a trailing blank line (a proxy that
      // strips trailing whitespace, or an interrupted connection) -- flush
      // any event still buffered so the final `response.completed` event
      // (carrying usageMetadata/finishReason) isn't silently dropped.
      if (currentEventType && dataAccumulator) {
        const geminiResp = parseSSEFrame(currentEventType, dataAccumulator);
        if (geminiResp) {
          yield geminiResp;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

function sanitizePromptCacheKey(key: string): string {
  if (key.length <= PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, PROMPT_CACHE_KEY_MAX_LENGTH);
}

interface ResponsesApiError extends Error {
  status: number;
  responseBody: string;
}

export function mergeStreamResponses(
  chunks: GenerateContentResponse[],
): GenerateContentResponse {
  if (chunks.length === 0) {
    const empty = new GenerateContentResponse();
    empty.candidates = [];
    return empty;
  }
  if (chunks.length === 1) return chunks[0]!;

  const allParts = chunks.flatMap(
    (c) => c.candidates?.[0]?.content?.parts ?? [],
  );

  const usageChunk = [...chunks].reverse().find((c) => c.usageMetadata);
  const finishChunk = [...chunks]
    .reverse()
    .find((c) => c.candidates?.[0]?.finishReason);
  const finishReason = finishChunk?.candidates?.[0]?.finishReason;

  const merged = new GenerateContentResponse();
  merged.responseId = chunks.find((c) => c.responseId)?.responseId;
  merged.modelVersion = chunks[0]?.modelVersion;
  merged.createTime = chunks[0]?.createTime;
  if (usageChunk?.usageMetadata) {
    merged.usageMetadata = usageChunk.usageMetadata;
  }

  merged.candidates = [
    {
      content: { parts: allParts, role: 'model' as const },
      index: 0,
      safetyRatings: [],
      ...(finishReason ? { finishReason } : {}),
    },
  ];
  return merged;
}

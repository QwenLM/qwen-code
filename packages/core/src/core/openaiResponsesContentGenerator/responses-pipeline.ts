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
  countReasoningItems,
  downgradeRejectedReasoningItems,
  parseReasoningIdRejection,
} from './responses-reasoning-rejection.js';
import {
  buildRuntimeFetchOptions,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  DISABLED_REQUEST_TIMEOUT_MS,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
  resolveRequestTimeout,
} from '../openaiContentGenerator/constants.js';
import { reconcileMaxTokens } from '../tokenLimits.js';
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

/**
 * Thrown when a single streaming response spends more than its total-lifetime
 * cap of ACCUMULATED upstream-wait (the time blocked on `reader.read()`, not
 * the consumer's drain time) without completing. Unlike the idle watchdog,
 * this cap is NOT reset by chunk arrival, so a non-compliant proxy or degraded
 * upstream drip-feeding one small chunk per idle window can no longer keep the
 * turn alive forever (issue #8597). `code: 'ETIMEDOUT'` makes
 * `classifyRetryError` treat it as a retryable transport error -- mirroring
 * the sibling Chat pipeline's StreamLifetimeExceededError.
 */
export class StreamLifetimeExceededError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly maxLifetimeMs: number,
    readonly chunksReceived: number,
  ) {
    super(
      `Stream exceeded its ${maxLifetimeMs}ms upstream-wait cap after ` +
        `${chunksReceived} chunks. Set ${QWEN_STREAM_MAX_LIFETIME_MS_ENV} ` +
        `to increase this window (or 0 to disable it).`,
    );
    this.name = 'StreamLifetimeExceededError';
  }
}

/**
 * Thrown when the connect phase (fetch until response headers arrive) exceeds
 * the configured request timeout. The pinned undici Agent runs with
 * `headersTimeout: 0, bodyTimeout: 0` and the idle watchdog only wraps
 * `reader.read()` (which starts AFTER connect resolves), so without this an
 * endpoint that completes TCP/TLS but never sends headers (hung LB, tarpitting
 * proxy, frozen local model) would block the turn forever. `code: 'ETIMEDOUT'`
 * makes it a retryable transport error, so retryWithBackoff around
 * connectStream can re-attempt.
 */
export class StreamConnectTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(readonly connectTimeoutMs: number) {
    super(
      `Responses API connect phase exceeded ${connectTimeoutMs}ms before any ` +
        `response headers arrived. Increase the model request timeout ` +
        `(or set it to 0 to disable this bound).`,
    );
    this.name = 'StreamConnectTimeoutError';
  }
}

/**
 * Thrown when reading a non-2xx response body exceeds the configured request
 * timeout. The connect timer stops the moment response headers arrive, so a
 * proxy that commits its status line and then stalls the body would otherwise
 * hold the turn open forever -- the SSE guards never run on this path, because
 * an error response never becomes a stream. `code: 'ETIMEDOUT'` makes
 * `classifyRetryError` treat it as a retryable transport error, matching the
 * other transport bounds on this wire.
 */
export class ErrorBodyTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly bodyTimeoutMs: number,
    readonly status: number,
  ) {
    super(
      `Responses API error response body (HTTP ${status}) did not complete ` +
        `within ${bodyTimeoutMs}ms. Increase the model request timeout ` +
        `(or set it to 0 to disable this bound).`,
    );
    this.name = 'ErrorBodyTimeoutError';
  }
}

function newAbortError(): Error {
  const abortErr = new Error('Aborted');
  abortErr.name = 'AbortError';
  return abortErr;
}

// responses-reasoning-rejection.ts refuses to classify any error body longer
// than 64,000 characters, so a COMPLETE body up to that size has to survive
// the read intact or replay recovery stops working.
const CLASSIFIABLE_ERROR_BODY_CHARS = 64_000;
// Read exactly one character past that ceiling. A body that reaches this cap
// is necessarily truncated, and its length alone then makes the classifier
// fail closed -- so a partial body can never be mistaken for the whole
// evidence, without the read having to signal truncation out of band.
const MAX_ERROR_BODY_CHARS = CLASSIFIABLE_ERROR_BODY_CHARS + 1;

/**
 * Resolve a stream-guard timeout (ms). Precedence, for both guards: explicit
 * `ContentGeneratorConfig` field (programmatic, wins -- including `0` to
 * disable) > the env deployment knob > the built-in default. A value above the
 * JS timer ceiling or a non-integer is rejected (setTimeout silently
 * compresses oversized delays to ~1ms, which would fire near-immediately) --
 * surfaced with a `console.warn` rather than silently discarded, mirroring the
 * sibling Chat pipeline's resolveStreamGuardMs.
 */
function resolveStreamGuardMs(
  fromConfig: number | undefined,
  configLabel: string,
  envName: string,
  defaultMs: number,
): number {
  if (typeof fromConfig === 'number') {
    if (
      Number.isInteger(fromConfig) &&
      fromConfig <= MAX_STREAM_GUARD_TIMEOUT_MS
    ) {
      return fromConfig;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring out-of-range ${configLabel}=${fromConfig} ` +
        `(expected an integer in (-∞, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); ` +
        `falling back to ${envName}/default.`,
    );
  }
  const raw = process.env[envName];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (parsed <= MAX_STREAM_GUARD_TIMEOUT_MS) {
        return parsed;
      }
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring invalid ${envName}="${raw}" ` +
        `(expected an integer of milliseconds in [0, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); ` +
        `using default ${defaultMs}ms.`,
    );
  }
  return defaultMs;
}

function resolveStreamIdleTimeoutMs(config: ContentGeneratorConfig): number {
  return resolveStreamGuardMs(
    config.streamIdleTimeoutMs,
    'streamIdleTimeoutMs',
    QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
}

function resolveStreamMaxLifetimeMs(config: ContentGeneratorConfig): number {
  return resolveStreamGuardMs(
    config.streamMaxLifetimeMs,
    'streamMaxLifetimeMs',
    QWEN_STREAM_MAX_LIFETIME_MS_ENV,
    DEFAULT_STREAM_MAX_LIFETIME_MS,
  );
}

export class ResponsesPipeline {
  private readonly config: ContentGeneratorConfig;
  private readonly cliConfig: Config;
  // Resolved once (config field > env > default) so the env read happens per
  // pipeline, not per streaming request.
  private readonly streamIdleTimeoutMs: number;
  // Total-lifetime cap for a single streaming response (accumulated
  // upstream-wait, never reset by chunk arrival). Companion to the idle
  // watchdog -- see StreamLifetimeExceededError / issue #8597.
  private readonly streamMaxLifetimeMs: number;
  // Connect-phase timeout (ms). Honors ContentGeneratorConfig.timeout the same
  // way the embed client does, via resolveRequestTimeout: undefined -> default,
  // `0`/negative -> disabled.
  private readonly connectTimeoutMs: number;

  constructor(config: ContentGeneratorConfig, cliConfig: Config) {
    this.config = config;
    this.cliConfig = cliConfig;
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(config);
    this.streamMaxLifetimeMs = resolveStreamMaxLifetimeMs(config);
    this.connectTimeoutMs = resolveRequestTimeout(config.timeout);
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
    const reader = await this.connectWithReasoningReplayRecovery(
      activeRequest,
      signal,
    );
    // One state per surviving stream: it is created only once a connect has
    // produced the reader that will actually be iterated.
    return this.iterateBody(reader, new ResponsesStreamState(), signal);
  }

  /**
   * Connect, and if the endpoint explicitly refuses a replayed reasoning item
   * id, send the same request once more with those items downgraded (issue
   * #9452).
   *
   * The first request always goes out exactly as built. Recovery matters
   * because the offending ids live in persisted history: without it, every
   * subsequent send in that session rebuilds the same ids and fails the same
   * way, so the session is permanently wedged against that endpoint.
   */
  private async connectWithReasoningReplayRecovery(
    apiRequest: ResponsesApiRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    let retryRequest: ResponsesApiRequest | undefined;
    try {
      return await this.connect(apiRequest, signal);
    } catch (error) {
      retryRequest = this.buildReasoningReplayRetry(apiRequest, error);
      if (!retryRequest) throw error;
    }
    // Reached only when the rejection was classified. This connect runs
    // OUTSIDE the catch above, so it is attempted exactly once and its own
    // failure propagates unchanged rather than triggering another recovery.
    return this.connect(retryRequest, signal);
  }

  /**
   * The retry request, or undefined when the error is not a reasoning-id
   * rejection or nothing in this body would change. Builds a new request
   * object -- the caller's request, the input array, and every item it holds
   * are left untouched.
   */
  private buildReasoningReplayRetry(
    apiRequest: ResponsesApiRequest,
    error: unknown,
  ): ResponsesApiRequest | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const { status, responseBody } = error as Partial<ResponsesApiError>;
    if (typeof status !== 'number') return undefined;

    const rejection = parseReasoningIdRejection(status, responseBody);
    if (!rejection) return undefined;

    const input = downgradeRejectedReasoningItems(apiRequest.input, rejection);
    if (input === apiRequest.input) return undefined;

    const reasoningItems = countReasoningItems(apiRequest.input);
    // Metadata only: no id, no encrypted content, no endpoint.
    debugLogger.debug(
      'Retrying once with downgraded reasoning replay',
      `namedIndex=${rejection.namedIndex}`,
      `maxLengthReported=${rejection.maxLength !== null}`,
      `reasoningItems=${reasoningItems}`,
      `downgradedItems=${reasoningItems - countReasoningItems(input)}`,
    );
    return { ...apiRequest, input };
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

  /**
   * Key the OpenAI prefix cache on the SESSION, not the turn.
   *
   * `userPromptId` is `${sessionId}########${counter}` -- it changes on every
   * send, so using it directly gives each turn its own cache namespace and no
   * request in a session can ever hit the prefix cache written by the one
   * before it. Nothing fails when that happens; the cost is silent, which is
   * why it survived until review.
   *
   * Matches the Chat wire's `applyOfficialOpenAIPromptCaching`
   * (openaiContentGenerator/prefix-caching.ts), which keys on
   * `qwen-code:${sessionId}` -- that landed on main in #8418 after this
   * branch forked, so the two wires would otherwise disagree on merge.
   *
   * `Config.getSessionId()` is typed `string`, so the guard below is for the
   * empty-string case only -- falling back to `userPromptId` there keeps a
   * per-request key rather than collapsing every session onto a bare
   * `qwen-code:` prefix.
   */
  private buildPromptCacheKey(userPromptId: string): string {
    const sessionId = this.cliConfig.getSessionId();
    return sanitizePromptCacheKey(
      sessionId ? `qwen-code:${sessionId}` : userPromptId,
    );
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
    const reasoning = this.buildReasoning(request);

    const apiRequest: ResponsesApiRequest = {
      model: this.config.model,
      input: cleanOrphanedFunctionCalls(input),
      instructions,
      tools,
      stream: true,
      prompt_cache_key: this.buildPromptCacheKey(userPromptId),
      // We never reference previous_response_id, so server-side storage of
      // the response buys nothing. The spec pairs reasoning.encrypted_content
      // with store:false as the intended stateless-replay recipe -- set it
      // unconditionally for consistency, not just when reasoning is on.
      store: false,
    };

    // tool_choice / parallel_tool_calls are emitted ONLY when tools are
    // present -- matching the sibling Chat wire, which skips tool_choice on a
    // toolless request. Toolless requests are reachable on this wire (chat
    // compaction via baseLlmClient.generateText with no config.tools, text-mode
    // side queries): sending tool_choice/parallel_tool_calls with no `tools`
    // key makes strict OpenAI-compatible endpoints reject the body with 400
    // ("A tool_choice was set on the request but no tools were specified"),
    // which can wedge compaction into a permanent retry loop.
    if (tools && tools.length > 0) {
      apiRequest.tool_choice = 'auto';
      apiRequest.parallel_tool_calls = true;
      // Map Gemini-style toolConfig.functionCallingConfig.mode to the
      // Responses API's tool_choice, mirroring the Chat Completions and
      // Anthropic pipelines. Without this, structured side queries that force
      // tool use (e.g. baseLlmClient's respond_in_schema) fall back to
      // tool_choice:auto and reasoning-heavy models may skip the tool call
      // entirely.
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

    // Static config wins, then the per-send request value, then omitted --
    // the same per-key precedence the sibling Chat wire applies through
    // addParameterIfDefined. `??` rather than a truthiness check, so a
    // deliberate `0` on either side survives.
    const temperature =
      this.config.samplingParams?.temperature ?? request.config?.temperature;
    if (temperature != null) {
      apiRequest.temperature = temperature;
    }
    const topP = this.config.samplingParams?.top_p ?? request.config?.topP;
    if (topP != null) {
      apiRequest.top_p = topP;
    }

    // Reconcile the user's configured max_tokens ceiling with the per-send
    // window-clamped budget (request.config.maxOutputTokens, issue #5950)
    // through the SAME centralized "smaller wins" invariant both sibling wires
    // call (tokenLimits.reconcileMaxTokens): a user max_tokens is a ceiling,
    // not an escape hatch, so a large window-clamped per-send value can never
    // silently reopen a smaller configured cap. When only one side is present,
    // reconcile returns undefined and we fall back to config-then-request,
    // matching the sibling.
    const configMaxTokens = this.config.samplingParams?.max_tokens;
    const requestMaxTokens = request.config?.maxOutputTokens;
    const maxOut =
      reconcileMaxTokens(configMaxTokens, requestMaxTokens) ??
      configMaxTokens ??
      requestMaxTokens;
    if (maxOut != null) {
      apiRequest.max_output_tokens = maxOut;
    }

    if (this.config.extra_body) {
      const thinkingOptOut =
        request.config?.thinkingConfig?.includeThoughts === false;
      const requestRecord = apiRequest as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(this.config.extra_body)) {
        // `enable_thinking` is a DashScope/Qwen-specific knob with no meaning
        // on the Responses API; buildReasoning() above already translates it
        // into `reasoning.effort` when present, so forwarding it verbatim
        // would only add an undefined field to the wire body.
        if (key === 'enable_thinking') continue;
        // An explicit per-send `thinkingConfig.includeThoughts:false` is
        // authoritative for the whole build, not just buildReasoning(): the
        // opt-out is precisely what leaves `reasoning`/`include` off the
        // request literal, so without this the fill-only merge below would
        // hand a configured extra_body the empty slot and put thinking back
        // on the wire the caller just turned off. `include` goes with it: the
        // encrypted-reasoning include exists only to round-trip reasoning.
        if (thinkingOptOut && (key === 'reasoning' || key === 'include')) {
          continue;
        }
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

  private buildReasoning(
    request: GenerateContentParameters,
  ): ResponsesApiReasoning | undefined {
    // A per-send opt-out, mirroring the sibling Chat wire's
    // buildReasoningConfig: `includeThoughts:false` is the caller saying this
    // particular request wants no thinking, and it outranks any static
    // configuration. Only the explicit `false` opts out -- no other value of
    // thinkingConfig is given a meaning on this wire.
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return undefined;
    }
    const r = this.config.reasoning;
    if (r === false) return undefined;
    // `extra_body.enable_thinking` is the DashScope/Qwen-specific on/off
    // toggle (predates the unified reasoning-effort ladder). It has no
    // meaning as a literal field on the Responses API and is stripped before
    // the wire request is sent (see the extra_body merge below), so a config
    // that only set it -- e.g. a settings.json carried over from another
    // wire -- would otherwise silently lose reasoning entirely on this wire.
    const legacyEnableThinking = this.config.extra_body?.['enable_thinking'];
    if (r === undefined && legacyEnableThinking !== true) return undefined;

    const reasoning: ResponsesApiReasoning = {};
    // The Responses API reasoning.effort enum (none, minimal, low, medium,
    // high, xhigh, max) is a superset of the unified ladder, so every tier
    // passes through verbatim with no clamping.
    if (r?.effort) {
      reasoning.effort = r.effort;
    } else if (legacyEnableThinking === true) {
      reasoning.effort = 'medium';
    }
    if (reasoning.effort) {
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

    // Compose the caller's AbortSignal with a connect-timeout controller so a
    // connect-phase timeout also aborts the in-flight fetch (freeing the
    // socket), while a user cancellation still propagates to the transport for
    // the whole request lifetime. The listener is registered `once` so it
    // self-cleans after firing.
    const connectController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        connectController.abort();
      } else {
        signal.addEventListener('abort', () => connectController.abort(), {
          once: true,
        });
      }
    }

    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers,
      body,
      signal: connectController.signal,
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

    // Connect-phase timeout: fetch() resolves once response headers arrive, so
    // an endpoint that completes TCP/TLS but never sends headers would block
    // the turn forever (the idle watchdog only wraps reader.read(), which runs
    // after connect resolves, and the pinned undici Agent sets
    // headersTimeout:0/bodyTimeout:0). resolveRequestTimeout maps `0`/negative
    // to DISABLED_REQUEST_TIMEOUT_MS, so a disabled timeout skips the race.
    const connectTimeoutMs = this.connectTimeoutMs;
    const timeoutActive =
      connectTimeoutMs > 0 && connectTimeoutMs < DISABLED_REQUEST_TIMEOUT_MS;

    let response: Response;
    if (timeoutActive) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // A user cancellation wins over the connect timeout's ETIMEDOUT.
          if (signal?.aborted) {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          } else {
            connectController.abort();
            reject(new StreamConnectTimeoutError(connectTimeoutMs));
          }
        }, connectTimeoutMs);
        timer.unref?.();
      });
      try {
        response = await Promise.race([
          fetchFn(url, fetchOpts as RequestInit),
          timeout,
        ]);
      } catch (error) {
        throw redactProxyError(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } else {
      try {
        response = await fetchFn(url, fetchOpts as RequestInit);
      } catch (error) {
        throw redactProxyError(error);
      }
    }

    if (!response.ok) {
      // Bounded: the connect timer has already been cleared, and an error
      // response never reaches the SSE guards, so this read is the last place
      // a stalled endpoint can hold the turn open. A caller cancellation and
      // the ETIMEDOUT bound both propagate rather than being swallowed into
      // an ordinary status error.
      const errBody = await this.readErrorResponseBody(
        response,
        signal,
        connectController,
      );
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
    // Only real SSE: this reader parses `event:`/`data:` frames and nothing
    // else, so accepting a line-delimited-JSON media type it cannot frame
    // yielded an empty, silently successful turn. Matched case-insensitively
    // and with the usual parameters (`; charset=utf-8`) allowed.
    if (contentType && !/^\s*text\/event-stream\s*(?:;|$)/i.test(contentType)) {
      throw new Error(
        `Responses API returned non-SSE content-type: ${contentType}`,
      );
    }

    return response.body.getReader();
  }

  /**
   * Read a non-2xx response body under three bounds: the configured request
   * timeout, the caller's AbortSignal, and a character cap.
   *
   * The whole body is kept when it fits inside the cap, because
   * responses-reasoning-rejection.ts classifies from the complete envelope; a
   * body that hits the cap is returned one character over the classifier's
   * own ceiling, so recovery fails closed on it rather than acting on a
   * prefix. The excerpt the surfaced message quotes is capped separately by
   * the caller, and nothing here logs the body.
   *
   * On either bound the body is cancelled and the request aborted, so the
   * socket is freed instead of draining a body nobody will read.
   */
  private async readErrorResponseBody(
    response: Response,
    signal: AbortSignal | undefined,
    requestController: AbortController,
  ): Promise<string> {
    const timeoutMs = this.connectTimeoutMs;
    const bounded = timeoutMs > 0 && timeoutMs < DISABLED_REQUEST_TIMEOUT_MS;

    let rejectTermination!: (error: Error) => void;
    const termination = new Promise<never>((_resolve, reject) => {
      rejectTermination = reject;
    });
    // Raced below, but rejected from timers/listeners that can fire before or
    // after any race: keep a permanent handler so it is never an unhandled
    // rejection.
    termination.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    if (signal?.aborted) {
      rejectTermination(newAbortError());
    } else if (signal) {
      onAbort = () => rejectTermination(newAbortError());
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (bounded) {
      timer = setTimeout(() => {
        // A user cancellation wins over the bound's ETIMEDOUT.
        rejectTermination(
          signal?.aborted
            ? newAbortError()
            : new ErrorBodyTimeoutError(timeoutMs, response.status),
        );
      }, timeoutMs);
      timer.unref?.();
    }

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    const body = response.body;
    if (!body) {
      // No stream to drain (a 204/304, or a transport that only exposes
      // text()). Still raced, so a mock or shim that never settles cannot
      // outlive the bound.
      try {
        const text = await Promise.race([
          Promise.resolve(response.text()).catch(() => ''),
          termination,
        ]);
        return text.slice(0, MAX_ERROR_BODY_CHARS);
      } finally {
        cleanup();
      }
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let completed = false;
    try {
      while (text.length < MAX_ERROR_BODY_CHARS) {
        const readPromise = reader.read();
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([readPromise, termination]);
        } catch (error) {
          // The orphaned read settles once the body is cancelled below;
          // swallow it so it is not an unhandled rejection.
          void Promise.resolve(readPromise).catch(() => {});
          throw error;
        }
        if (result.done) {
          completed = true;
          break;
        }
        text += decoder.decode(result.value, { stream: true });
      }
      if (completed) text += decoder.decode();
      return text.slice(0, MAX_ERROR_BODY_CHARS);
    } finally {
      cleanup();
      void reader.cancel().catch(() => {});
      // Truncated at the cap or terminated by a bound: the request is still
      // in flight and nothing else will end it.
      if (!completed) requestController.abort();
    }
  }

  /**
   * Body-iteration phase: lazily drain the SSE reader, parse frames, and yield
   * Gemini responses. Two guards wrap each `reader.read()`, mirroring the Chat
   * pipeline: an idle watchdog fails a silent mid-stream stall with a retryable
   * ETIMEDOUT (the timer resets on every chunk, so an actively streaming model
   * is never interrupted; `streamIdleTimeoutMs <= 0` disables it), and a
   * total-lifetime cap on accumulated upstream-wait (NOT reset by chunk
   * arrival) fails a drip-fed stream that keeps resetting the idle timer but
   * never completes (issue #8597; `streamMaxLifetimeMs <= 0` disables it).
   */
  private async *iterateBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    streamState: ResponsesStreamState,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const idleMs = this.streamIdleTimeoutMs;
    const maxLifetimeMs = this.streamMaxLifetimeMs;
    let chunksReceived = 0;
    // Accumulated upstream-wait (monotonic performance.now(), never Date.now()
    // so an NTP step can't kill a healthy stream): the time this loop spends
    // blocked in reader.read(), NOT the consumer's drain time after a yield.
    // The lifetime cap is charged against this, so a stream that finished and
    // buffered its bytes owes nothing however slowly the consumer drains.
    let upstreamMs = 0;

    const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      // Both guards off: pass the read through untouched.
      if (idleMs <= 0 && maxLifetimeMs <= 0) return reader.read();

      // Remaining lifetime budget. Unlike the idle window, it is NOT reset by
      // chunk arrival, so a drip-fed stream that keeps resetting the idle
      // timer still terminates once this is exhausted (issue #8597).
      const remainingLifetimeMs =
        maxLifetimeMs > 0
          ? maxLifetimeMs - upstreamMs
          : Number.POSITIVE_INFINITY;
      // Budget already spent: fail here rather than issuing another read.
      if (remainingLifetimeMs <= 0) {
        if (signal?.aborted) {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          return Promise.reject(abortErr);
        }
        return Promise.reject(
          new StreamLifetimeExceededError(maxLifetimeMs, chunksReceived),
        );
      }

      const readPromise = reader.read();
      const awaitedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        // At least one guard is positive here, so at least one is finite.
        const idleIn = idleMs > 0 ? idleMs : Number.POSITIVE_INFINITY;
        const wait = Math.min(idleIn, remainingLifetimeMs);
        timer = setTimeout(
          () => {
            // A user cancellation wins over the watchdog's retryable ETIMEDOUT.
            // Reject only -- do NOT cancel the reader here: cancel() resolves
            // the pending read() as { done: true } synchronously, which would
            // win the race over this rejection. The generator's finally cancels
            // the reader (freeing the socket) once this error propagates out.
            if (signal?.aborted) {
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            } else if (remainingLifetimeMs <= idleIn) {
              // The lifetime cap is the tighter bound for this wait.
              reject(
                new StreamLifetimeExceededError(maxLifetimeMs, chunksReceived),
              );
            } else {
              reject(new StreamInactivityTimeoutError(idleMs, chunksReceived));
            }
          },
          Math.max(wait, 0),
        );
        timer.unref?.();
      });
      return Promise.race([readPromise, timeout])
        .then((result) => {
          // Charge only the upstream-wait this chunk actually took toward the
          // lifetime cap.
          upstreamMs += performance.now() - awaitedAt;
          return result;
        })
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

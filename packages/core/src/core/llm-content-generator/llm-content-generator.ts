/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentConfig,
  ThinkingLevel,
  Content,
  FunctionResponsePart,
  Part,
  HttpOptions,
} from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  reportLlmChunk,
  reportLlmRequest,
  reportLlmResponse,
  type GenAiAttemptHandle,
} from '../../telemetry/gen-ai-request.js';
import type { Config } from '../../config/config.js';
import {
  getEffectiveReasoning,
  resolveReasoningForModel,
} from '../reasoning-overrides.js';
import { supportsGeminiXhigh } from '../gemini-reasoning.js';
import { buildSessionIdHeaders } from '../outbound-session-id.js';
import {
  expandDynamicHeaders,
  hasDynamicPlaceholder,
  warnIfDynamicHeadersDisabled,
} from '../outbound-dynamic-headers.js';
import { isResponsesReasoningSignature } from '../../utils/thoughtUtils.js';
import { retryContext } from '../../utils/retryContext.js';
import { getRetryDelayMs } from '../../utils/retryPolicy.js';
import {
  buildRuntimeFetchOptions,
  preloadRuntimeFetchModule,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import {
  DISABLED_REQUEST_TIMEOUT_MS,
  resolveRequestTimeout,
} from '../openaiContentGenerator/constants.js';
import {
  resolveStreamIdleTimeoutMs,
  resolveStreamMaxLifetimeMs,
  withStreamGuards,
} from '../stream-guards.js';
import { markRequestDispatched } from '../loggingContentGenerator/request-dispatch.js';

const debugLogger = createDebugLogger('GEMINI');

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_SDK_RETRY_ATTEMPTS = 5;
const DEFAULT_SDK_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_SDK_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_SDK_RETRY_JITTER_RATIO = 0.3;

/**
 * Strip redundant trailing `/v1beta` segment(s) (with optional trailing
 * slashes) from a Gemini base URL before passing it to `@google/genai`, which
 * appends its own `/v1beta/models/...` path prefix and would otherwise send
 * `/v1beta/v1beta/`.
 */
export function normalizeGeminiBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/(?:\/v1beta)+$/i, '');
}

/**
 * Thrown when the Gemini/Vertex connect phase (waiting for initial HTTP
 * response headers) exceeds the configured request timeout. Stamped with
 * `code: 'ETIMEDOUT'` so `classifyRetryError` classifies it as a retryable
 * transport timeout, matching `StreamConnectTimeoutError` on the Responses wire.
 */
export class GeminiConnectTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(readonly connectTimeoutMs: number) {
    super(
      `Gemini API connect phase exceeded ${connectTimeoutMs}ms before any ` +
        `response headers arrived. Increase the model request timeout ` +
        `(or set it to 0 to disable this bound).`,
    );
    this.name = 'GeminiConnectTimeoutError';
  }
}

type GeminiStreamPart = { responseInternal: Response };

type GeminiApiClient = {
  clientOptions?: {
    httpOptions?: HttpOptions;
  };
  apiCall?(url: string, init: RequestInit): Promise<Response>;
  processStreamResponse?(response: Response): AsyncGenerator<GeminiStreamPart>;
  includeExtraHttpOptionsToRequestInit(
    init: RequestInit,
    options: HttpOptions,
    url: string,
    signal?: AbortSignal,
  ): Promise<RequestInit>;
};

function isThirdPartyGeminiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname !== 'generativelanguage.googleapis.com';
  } catch {
    return true;
  }
}

function withoutDoneSentinel(
  stream: AsyncGenerator<GeminiStreamPart, void, unknown>,
  response: Response,
): AsyncGenerator<GeminiStreamPart, void, unknown> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      if (result.done) return result;
      const payload = await result.value.responseInternal.clone().text();
      if (payload.trim() !== '[DONE]') return result;
      await iterator.return?.();
      try {
        await response.body?.cancel();
      } catch {
        // A reset after a complete sentinel does not invalidate the response.
      }
      return { done: true, value: undefined };
    },
    async return() {
      if (iterator.return) return iterator.return();
      return { done: true, value: undefined };
    },
    async throw(error?: unknown) {
      if (iterator.throw) return iterator.throw(error);
      await iterator.return?.();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    return Promise.reject(abortErr);
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function installIsolatedTransport(
  client: GoogleGenAI,
  options: {
    apiKey?: string;
    getProxy?: () => string | undefined;
    connectTimeoutMs?: number;
  },
): boolean {
  // @google/genai 2.6 has no public fetch hook. Both model request paths use
  // this instance's final HTTP call after the SDK has built the URL and auth.
  const { apiClient } = client as unknown as {
    apiClient?: GeminiApiClient;
  };
  if (typeof apiClient?.apiCall !== 'function') return false;
  const destinations = new WeakMap<Response, string>();
  // apiCall shallow-copies RequestInit but preserves the Headers instance.
  const explicitNativeHeaderRequests = new WeakSet<Headers>();
  if (typeof apiClient.includeExtraHttpOptionsToRequestInit === 'function') {
    const includeExtraHttpOptionsToRequestInit =
      apiClient.includeExtraHttpOptionsToRequestInit.bind(apiClient);
    apiClient.includeExtraHttpOptionsToRequestInit = async (
      init,
      options,
      url,
      signal,
    ) => {
      // The SDK only observes abort events after it starts building the request.
      signal?.throwIfAborted();
      const hasExplicitNativeHeader = Object.keys(options.headers ?? {}).some(
        (name) => name.toLowerCase() === 'x-goog-api-key',
      );
      const request = await includeExtraHttpOptionsToRequestInit(
        init,
        options,
        url,
        signal,
      );
      if (hasExplicitNativeHeader && request.headers) {
        explicitNativeHeaderRequests.add(request.headers as Headers);
      }
      return request;
    };
  }
  apiClient.apiCall = async (url, init) => {
    const headers = new Headers(init.headers);
    let headersModified = false;
    if (options.apiKey && !client.vertexai && isThirdPartyGeminiBaseUrl(url)) {
      if (
        !headers.has('authorization') &&
        !explicitNativeHeaderRequests.has(init.headers as Headers)
      ) {
        headers.set('Authorization', `Bearer ${options.apiKey}`);
        headersModified = true;
      }
    }
    const connectTimeoutMs = options.connectTimeoutMs;
    const connectTimeoutActive =
      connectTimeoutMs !== undefined &&
      connectTimeoutMs > 0 &&
      connectTimeoutMs < DISABLED_REQUEST_TIMEOUT_MS;
    // Do not synthesize `X-Server-Timeout` from `connectTimeoutMs`: Gemini and
    // Vertex treat `X-Server-Timeout` as the total server-side RPC budget
    // (matching `@google/genai`'s `getHeadersInternal`, which only appends it
    // when an explicit overall `httpOptions.timeout` is configured). Sending
    // the connect-phase timeout here would prematurely truncate healthy
    // long-running SSE streams governed by `stream-guards`.
    const preparedInit: RequestInit = headersModified
      ? { ...init, headers }
      : init;

    // Route every Gemini/Vertex HTTP request through the bundled undici fetch +
    // dispatcher (headersTimeout: 0, bodyTimeout: 0) so Node.js 22+'s built-in
    // 300s undici timeouts cannot prematurely abort requests. (@google/genai's
    // internal Symbol.for('undici.globalDispatcher.1') scan is a no-op on
    // Node.js 22+.) Bound connect + initial response headers here and clear the
    // timer as soon as headers arrive so healthy long-running streams are
    // governed by stream-guards instead of being aborted mid-stream.
    await preloadRuntimeFetchModule();
    const runtimeOptions = buildRuntimeFetchOptions(
      'gemini',
      options.getProxy?.(),
    );
    const singleAttempt = Boolean(retryContext.getStore()?.singleAttempt);
    const fetchFn: typeof fetch = runtimeOptions.fetch ?? fetch;
    const parentSignal = preparedInit.signal ?? undefined;

    const executeSingleAttempt = async (): Promise<Response> => {
      const requestInit: RequestInit & { dispatcher?: unknown } = {
        ...preparedInit,
        ...(singleAttempt ? { redirect: 'error' as const } : {}),
        ...(runtimeOptions.fetchOptions?.dispatcher
          ? { dispatcher: runtimeOptions.fetchOptions.dispatcher }
          : {}),
      };

      if (!connectTimeoutActive) {
        try {
          return await fetchFn(url, requestInit);
        } catch (error) {
          throw redactProxyError(error);
        }
      }

      const connectController = new AbortController();
      // Combine via AbortSignal.any (Node >= 20.3; repo requires Node >= 22)
      // instead of registering a listener on `parentSignal`, avoiding listener
      // accumulation / MaxListenersExceededWarning across repeated retries and
      // turns while still propagating mid-stream user aborts.
      requestInit.signal = parentSignal
        ? AbortSignal.any([parentSignal, connectController.signal])
        : connectController.signal;

      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let fetchPromise: Promise<Response> | undefined;
      let timeoutPromise: Promise<never> | undefined;
      try {
        fetchPromise = fetchFn(url, requestInit);
        timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (parentSignal?.aborted) {
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            } else {
              timedOut = true;
              const err = new GeminiConnectTimeoutError(connectTimeoutMs);
              reject(err);
              connectController.abort(err);
            }
          }, connectTimeoutMs);
          timer.unref?.();
        });
        return await Promise.race([fetchPromise, timeoutPromise]);
      } catch (error) {
        void fetchPromise?.then(
          (lateResponse) => {
            void lateResponse.body?.cancel().catch(() => {});
          },
          () => {},
        );
        void timeoutPromise?.catch(() => {});
        if (timedOut && !parentSignal?.aborted) {
          throw new GeminiConnectTimeoutError(connectTimeoutMs);
        }
        throw redactProxyError(error);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };

    const retryOptions = apiClient.clientOptions?.httpOptions?.retryOptions;
    let response: Response;
    // Matches `@google/genai`'s `ApiClient.apiCall`: SDK-level retries are
    // strictly opt-in via `httpOptions.retryOptions` (omitting it performs a
    // single fetch so outer `retryWithBackoff` owns retries without multiplying
    // attempts); passing `{}` defaults `attempts` to `DEFAULT_SDK_RETRY_ATTEMPTS`.
    if (!singleAttempt && retryOptions) {
      const maxAttempts = Math.max(
        1,
        retryOptions.attempts ?? DEFAULT_SDK_RETRY_ATTEMPTS,
      );
      let attempt = 1;
      while (true) {
        response = await executeSingleAttempt();
        if (
          response.ok ||
          !RETRYABLE_HTTP_STATUS_CODES.has(response.status) ||
          attempt >= maxAttempts
        ) {
          break;
        }
        const delayMs = getRetryDelayMs({
          attempt,
          initialDelayMs: DEFAULT_SDK_RETRY_BASE_DELAY_MS,
          maxDelayMs: DEFAULT_SDK_RETRY_MAX_DELAY_MS,
          error: response,
          retryAfterMode:
            response.status === 429 || response.status === 503
              ? 'minimum'
              : 'ignore',
          retryAfterMaxDelayMs: DEFAULT_SDK_RETRY_MAX_DELAY_MS,
          jitterRatio: DEFAULT_SDK_RETRY_JITTER_RATIO,
        });
        try {
          await response.body?.cancel();
        } catch {
          // Ignore body cancel errors before retry.
        }
        await sleepWithSignal(delayMs, parentSignal);
        attempt += 1;
      }
    } else {
      response = await executeSingleAttempt();
    }
    destinations.set(response, url);
    return response;
  };
  if (typeof apiClient.processStreamResponse === 'function') {
    const processStreamResponse =
      apiClient.processStreamResponse.bind(apiClient);
    apiClient.processStreamResponse = (response) => {
      const stream = processStreamResponse(response);
      const destination = destinations.get(response) ?? response.url;
      return !client.vertexai && isThirdPartyGeminiBaseUrl(destination)
        ? withoutDoneSentinel(stream, response)
        : stream;
    };
  }
  return true;
}

interface ObserveStreamOptions {
  idleMs: number;
  maxLifetimeMs: number;
  abortRequest: () => void;
  callerSignal?: AbortSignal;
}

function observeLlmStream(
  stream: AsyncIterable<GenerateContentResponse>,
  telemetryAttempt: GenAiAttemptHandle | undefined,
  options: ObserveStreamOptions,
): AsyncGenerator<GenerateContentResponse> {
  const sourceIterator = stream[Symbol.asyncIterator]();
  const singleUseSource: AsyncIterable<GenerateContentResponse> = {
    [Symbol.asyncIterator]: () => sourceIterator,
  };
  const guardedStream =
    options.idleMs > 0 || options.maxLifetimeMs > 0
      ? withStreamGuards(
          singleUseSource,
          options.idleMs,
          options.maxLifetimeMs,
          options.abortRequest,
          options.callerSignal,
        )
      : singleUseSource;
  const iterator = guardedStream[Symbol.asyncIterator]();
  let started = false;
  return {
    async next() {
      started = true;
      const result = await iterator.next();
      if (!result.done) {
        reportLlmChunk(telemetryAttempt, result.value);
      } else {
        options.abortRequest();
      }
      return result;
    },
    async return(value?: GenerateContentResponse) {
      options.abortRequest();
      if (!started) {
        if (sourceIterator.return) return sourceIterator.return(value);
        return { done: true, value };
      }
      if (iterator.return) return iterator.return(value);
      return { done: true, value };
    },
    async throw(error?: unknown) {
      options.abortRequest();
      if (!started) {
        if (sourceIterator.throw) return sourceIterator.throw(error);
        await sourceIterator.return?.();
        throw error;
      }
      if (iterator.throw) return iterator.throw(error);
      await iterator.return?.();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function createRequestAbortScope(callerSignal?: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  let onCallerAbort: (() => void) | undefined;
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else if (callerSignal) {
    onCallerAbort = () => controller.abort(callerSignal.reason);
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const dispose = () => {
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener('abort', onCallerAbort);
      onCallerAbort = undefined;
    }
  };
  const abort = () => {
    dispose();
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  return { signal: controller.signal, abort, dispose };
}

/**
 * A wrapper for GoogleGenAI that implements the ContentGenerator interface.
 */
export class LlmContentGenerator implements ContentGenerator {
  private readonly googleGenAI: GoogleGenAI;
  private readonly hasIsolatedTransport: boolean;
  private readonly clientBaseUrl?: string;
  private readonly contentGeneratorConfig?: ContentGeneratorConfig;
  private readonly cliConfig?: Config;
  // Latch so the effort-clamp warning fires once per generator lifetime
  // instead of on every request that needs the downgrade.
  private effortClampWarned = false;

  constructor(
    options: {
      apiKey?: string;
      vertexai?: boolean;
      httpOptions?: HttpOptions;
    },
    contentGeneratorConfig?: ContentGeneratorConfig,
    cliConfig?: Config,
  ) {
    // Only placeholder-free entries may be baked into the client: a
    // placeholder value put here would be frozen at whatever the session
    // was when the client was built, and overriding it later would rely
    // on the SDK letting request-level headers win over client-level
    // ones. `buildHttpOptions` supplies the placeholder-bearing entries
    // per request instead, so the literal never reaches the client.
    const allCustomHeaders = contentGeneratorConfig?.customHeaders;
    if (cliConfig) warnIfDynamicHeadersDisabled(allCustomHeaders, cliConfig);
    const staticEntries = Object.entries(allCustomHeaders ?? {}).filter(
      ([, value]) => typeof value !== 'string' || !hasDynamicPlaceholder(value),
    );
    const customHeaders =
      staticEntries.length > 0 ? Object.fromEntries(staticEntries) : undefined;
    const finalOptions = customHeaders
      ? (() => {
          const baseHttpOptions = options.httpOptions;
          const baseHeaders = baseHttpOptions?.headers ?? {};

          return {
            ...options,
            httpOptions: {
              ...(baseHttpOptions ?? {}),
              headers: {
                ...baseHeaders,
                ...customHeaders,
              },
            },
          };
        })()
      : options;

    const configuredBaseUrl = finalOptions.httpOptions?.baseUrl;
    this.googleGenAI = new GoogleGenAI(finalOptions);
    const rawResolvedBaseUrl = finalOptions.httpOptions?.baseUrl;
    // The SDK writes any ambient base URL override back into its options.
    if (
      contentGeneratorConfig?.isolatedRoute &&
      !configuredBaseUrl &&
      rawResolvedBaseUrl
    ) {
      throw new Error('Configure baseUrl explicitly for this Google model.');
    }
    // Normalize any resolved baseUrl — including env-populated
    // GOOGLE_GEMINI_BASE_URL / GOOGLE_VERTEX_BASE_URL and direct constructor
    // callers — so `@google/genai` never appends `/v1beta` onto a trailing
    // `/v1beta` segment.
    const normalizedClientBaseUrl = rawResolvedBaseUrl
      ? normalizeGeminiBaseUrl(rawResolvedBaseUrl)
      : undefined;
    this.clientBaseUrl = normalizedClientBaseUrl;
    if (finalOptions.httpOptions && normalizedClientBaseUrl !== undefined) {
      finalOptions.httpOptions.baseUrl = normalizedClientBaseUrl;
    }
    const { apiClient } = this.googleGenAI as unknown as {
      apiClient?: GeminiApiClient;
    };
    const sdkHttpOptions = apiClient?.clientOptions?.httpOptions;
    if (sdkHttpOptions?.baseUrl) {
      sdkHttpOptions.baseUrl = normalizeGeminiBaseUrl(sdkHttpOptions.baseUrl);
    }
    const rawTimeout = contentGeneratorConfig?.timeout;
    const normalizedTimeout =
      typeof rawTimeout === 'number' &&
      (!Number.isFinite(rawTimeout) || rawTimeout > DISABLED_REQUEST_TIMEOUT_MS)
        ? undefined
        : rawTimeout;
    const connectTimeoutMs =
      finalOptions.httpOptions?.timeout === undefined
        ? resolveRequestTimeout(normalizedTimeout)
        : undefined;
    this.hasIsolatedTransport = installIsolatedTransport(this.googleGenAI, {
      apiKey: finalOptions.apiKey,
      getProxy: () => cliConfig?.getProxy?.() ?? contentGeneratorConfig?.proxy,
      connectTimeoutMs,
    });
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
  }

  private get models(): GoogleGenAI['models'] {
    if (retryContext.getStore()?.singleAttempt && !this.hasIsolatedTransport) {
      throw new Error(
        'Google GenAI transport does not support isolated requests.',
      );
    }
    return this.googleGenAI.models;
  }

  private buildHttpOptions(httpOptions?: HttpOptions): HttpOptions | undefined {
    if (!this.cliConfig) return httpOptions;

    // The placeholder-bearing entries were deliberately kept out of the
    // client options (see the constructor), so this is the only place
    // they are supplied — resolved fresh for each request.
    const dynamicHeaders = expandDynamicHeaders(
      this.contentGeneratorConfig?.customHeaders,
      this.cliConfig,
    );
    const destination = httpOptions?.baseUrl ?? this.clientBaseUrl;
    const sessionHeaders = destination
      ? buildSessionIdHeaders(this.cliConfig, destination)
      : {};
    if (
      Object.keys(sessionHeaders).length === 0 &&
      Object.keys(dynamicHeaders).length === 0
    ) {
      return httpOptions;
    }
    return {
      ...httpOptions,
      headers: {
        ...httpOptions?.headers,
        ...dynamicHeaders,
        ...sessionHeaders,
      },
    };
  }

  private buildGenerateContentConfig(
    request: GenerateContentParameters,
  ): GenerateContentConfig {
    const configSamplingParams = this.contentGeneratorConfig?.samplingParams;
    const requestConfig = request.config || {};
    const httpOptions = this.buildHttpOptions(requestConfig.httpOptions);

    // Helper function to get parameter value with priority: config > request > default
    const getParameterValue = <T>(
      configValue: T | undefined,
      requestKey: keyof GenerateContentConfig,
      defaultValue?: T,
    ): T | undefined => {
      const requestValue = requestConfig[requestKey] as T | undefined;

      if (configValue !== undefined) return configValue;
      if (requestValue !== undefined) return requestValue;
      return defaultValue;
    };

    return {
      ...requestConfig,
      ...(httpOptions ? { httpOptions } : {}),
      temperature: getParameterValue<number>(
        configSamplingParams?.temperature,
        'temperature',
        1,
      ),
      topP: getParameterValue<number>(
        configSamplingParams?.top_p,
        'topP',
        0.95,
      ),
      topK: getParameterValue<number>(configSamplingParams?.top_k, 'topK', 64),
      maxOutputTokens:
        configSamplingParams?.max_tokens !== undefined &&
        requestConfig.maxOutputTokens !== undefined
          ? Math.min(
              configSamplingParams.max_tokens,
              requestConfig.maxOutputTokens,
            )
          : (configSamplingParams?.max_tokens ?? requestConfig.maxOutputTokens),
      presencePenalty: getParameterValue<number>(
        configSamplingParams?.presence_penalty,
        'presencePenalty',
      ),
      frequencyPenalty: getParameterValue<number>(
        configSamplingParams?.frequency_penalty,
        'frequencyPenalty',
      ),
      seed: getParameterValue<number>(
        typeof configSamplingParams?.['seed'] === 'number'
          ? configSamplingParams['seed']
          : undefined,
        'seed',
      ),
      thinkingConfig: getParameterValue(
        this.buildThinkingConfig(request.model, requestConfig.thinkingConfig),
        'thinkingConfig',
        {
          includeThoughts: true,
          thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED' as ThinkingLevel,
        },
      ),
    };
  }

  private buildThinkingConfig(
    model?: string,
    requestThinking?: GenerateContentConfig['thinkingConfig'],
  ): GenerateContentConfig['thinkingConfig'] {
    const generation = this.contentGeneratorConfig;
    const resolved =
      generation && this.cliConfig
        ? resolveReasoningForModel(this.cliConfig, generation, model)
        : undefined;
    if (
      requestThinking?.includeThoughts === false &&
      (resolved || retryContext.getStore()?.singleAttempt)
    ) {
      return requestThinking;
    }
    const reasoning = generation
      ? getEffectiveReasoning(generation, resolved)
      : undefined;

    if (reasoning === false) {
      return { includeThoughts: false };
    }

    if (reasoning) {
      // Gemini's thinkingLevel ladder is MINIMAL / LOW / MEDIUM / HIGH, plus
      // XHIGH for models that support it (Gemini 4 Neon / Hydrogen, or routes
      // explicitly declaring xhigh). Unsupported stronger tiers clamp to the
      // model's ceiling; an unset effort stays UNSPECIFIED so the model picks
      // its own default.
      const allowsXhigh = resolved
        ? !resolved.toggleOnly && resolved.efforts.includes('xhigh')
        : supportsGeminiXhigh(model || generation?.model);
      let thinkingLevel: ThinkingLevel;
      switch (reasoning.effort) {
        case 'low':
          thinkingLevel = 'LOW' as ThinkingLevel;
          break;
        case 'medium':
          thinkingLevel = 'MEDIUM' as ThinkingLevel;
          break;
        case 'high':
          thinkingLevel = 'HIGH' as ThinkingLevel;
          break;
        case 'xhigh':
          if (allowsXhigh) {
            thinkingLevel = 'XHIGH' as ThinkingLevel;
          } else {
            if (!this.effortClampWarned) {
              debugLogger.warn(
                `reasoning.effort='xhigh' is not supported by Gemini; clamping to 'HIGH'.`,
              );
              this.effortClampWarned = true;
            }
            thinkingLevel = 'HIGH' as ThinkingLevel;
          }
          break;
        case 'max': {
          const fallback = allowsXhigh ? 'XHIGH' : 'HIGH';
          if (!this.effortClampWarned) {
            debugLogger.warn(
              `reasoning.effort='max' is not supported by Gemini; clamping to '${fallback}'.`,
            );
            this.effortClampWarned = true;
          }
          thinkingLevel = fallback as ThinkingLevel;
          break;
        }
        case undefined:
          // No effort set — let the model pick its own default.
          thinkingLevel = 'THINKING_LEVEL_UNSPECIFIED' as ThinkingLevel;
          break;
        default: {
          // Exhaustiveness guard: every ReasoningEffort tier (and undefined) is
          // handled above, so this is unreachable. Adding a new tier without a
          // matching case makes this a TypeScript compile error rather than a
          // silent fall-through to UNSPECIFIED. (A `default` is required here by
          // the eslint default-case rule.)
          const _exhaustive: never = reasoning.effort;
          void _exhaustive;
          thinkingLevel = 'THINKING_LEVEL_UNSPECIFIED' as ThinkingLevel;
          break;
        }
      }

      return {
        includeThoughts: true,
        thinkingLevel,
      };
    }

    return undefined;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const callerSignal = request.config?.abortSignal;
    const abortScope = callerSignal
      ? createRequestAbortScope(callerSignal)
      : undefined;
    const builtConfig = this.buildGenerateContentConfig(request);
    const finalRequest = {
      ...request,
      contents: this.stripUnsupportedFields(request.contents),
      config: abortScope
        ? { ...builtConfig, abortSignal: abortScope.signal }
        : builtConfig,
    };
    const telemetryAttempt = reportLlmRequest(finalRequest);
    try {
      const response = await this.models.generateContent(finalRequest);
      reportLlmResponse(telemetryAttempt, response);
      return response;
    } finally {
      abortScope?.dispose();
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const streamConfig = this.contentGeneratorConfig ?? {
      model: request.model,
    };
    const idleMs = resolveStreamIdleTimeoutMs(streamConfig);
    const maxLifetimeMs = resolveStreamMaxLifetimeMs(streamConfig);
    const callerSignal = request.config?.abortSignal;
    const abortScope = createRequestAbortScope(callerSignal);

    const config = {
      ...this.buildGenerateContentConfig(request),
      abortSignal: abortScope.signal,
    };
    const finalRequest = {
      ...request,
      contents: this.stripUnsupportedFields(request.contents),
      config,
    };
    const telemetryAttempt = reportLlmRequest(finalRequest);
    markRequestDispatched();
    let stream: AsyncIterable<GenerateContentResponse>;
    try {
      stream = await this.models.generateContentStream(finalRequest);
    } catch (error) {
      abortScope.abort();
      throw error;
    }
    return observeLlmStream(stream, telemetryAttempt, {
      idleMs,
      maxLifetimeMs,
      abortRequest: abortScope.abort,
      callerSignal,
    });
  }

  /**
   * Strip fields not supported by Gemini API (e.g., displayName in inlineData/fileData)
   */
  private stripUnsupportedFields(
    contents: GenerateContentParameters['contents'],
  ): GenerateContentParameters['contents'] {
    if (!contents) return contents;

    if (typeof contents === 'string') return contents;

    if (Array.isArray(contents)) {
      return contents.map((content) =>
        this.stripContentFields(content),
      ) as GenerateContentParameters['contents'];
    }

    return this.stripContentFields(
      contents,
    ) as GenerateContentParameters['contents'];
  }

  private stripContentFields(
    content: Content | Part | string,
  ): Content | Part | string {
    if (typeof content === 'string') {
      return content;
    }

    // Handle Part directly (for arrays of parts)
    if (!('role' in content) && !('parts' in content)) {
      return this.stripPartFields(content as Part);
    }

    // Handle Content object
    const contentObj = content as Content;
    if (!contentObj.parts) return contentObj;

    return {
      ...contentObj,
      parts: contentObj.parts.map((part) => this.stripPartFields(part)),
    };
  }

  private stripPartFields(part: Part): Part {
    if (typeof part === 'string') {
      return part;
    }

    const result = { ...part };

    // `partMetadata` is client-side bookkeeping only (the reattach boundary
    // from issue #11627), never part of the wire payload. The Gemini Developer
    // API route (`partToMldev`) copies it through, but the Vertex AI route
    // (`partToVertex`) rejects it unconditionally when building the request,
    // so drop it before the SDK sees it.
    delete result.partMetadata;

    // Strip displayName from inlineData
    if (result.inlineData) {
      const { displayName: _, ...inlineDataWithoutDisplayName } =
        result.inlineData as { displayName?: string; [key: string]: unknown };
      result.inlineData = inlineDataWithoutDisplayName as Part['inlineData'];
    }

    // Strip displayName from fileData
    if (result.fileData) {
      const { displayName: _, ...fileDataWithoutDisplayName } =
        result.fileData as { displayName?: string; [key: string]: unknown };
      result.fileData = fileDataWithoutDisplayName as Part['fileData'];
    }

    // `thoughtSignature` carries no origin marker, so a Responses-API
    // reasoning replay payload (`{"id":…,"encrypted_content":…}`) reaches the
    // Gemini wire unchanged after a provider switch. It is not a Gemini-native
    // signature, so drop it — wire-only, since `result` is a copy and the
    // caller's history keeps the payload for a later switch back. `thought`
    // and `text` are untouched, so the visible reasoning summary survives.
    // https://github.com/QwenLM/qwen-code/issues/9453
    if (isResponsesReasoningSignature(result.thoughtSignature)) {
      delete result.thoughtSignature;
    }

    // Gemini's FunctionResponsePart schema only permits `inlineData` and
    // `fileData` (oneof data, without displayName or unknown fields) — never
    // `text`. Convert unsupported audio/video to notes and move all text
    // entries (including compaction placeholders / disclosures) into
    // `functionResponse.response` so no invalid field reaches the wire in
    // `function_response.parts`.
    if (result.functionResponse?.parts) {
      const retainedParts: FunctionResponsePart[] = [];
      const extractedTexts: string[] = [];

      for (const nestedPart of result.functionResponse.parts as ReadonlyArray<
        Part | string
      >) {
        if (typeof nestedPart === 'string') {
          if (nestedPart.length > 0) extractedTexts.push(nestedPart);
          continue;
        }
        const converted = this.convertUnsupportedMediaToText(nestedPart);
        if (typeof converted.text === 'string' && converted.text.length > 0) {
          extractedTexts.push(converted.text);
        }
        if (converted.inlineData) {
          const { mimeType, data } = converted.inlineData;
          retainedParts.push({
            inlineData: {
              ...(mimeType !== undefined ? { mimeType } : {}),
              ...(data !== undefined ? { data } : {}),
            },
          });
        }
        if (converted.fileData) {
          const { fileUri, mimeType } = converted.fileData;
          retainedParts.push({
            fileData: {
              ...(fileUri !== undefined ? { fileUri } : {}),
              ...(mimeType !== undefined ? { mimeType } : {}),
            },
          });
        }
      }

      const { parts: _unusedParts, ...restFunctionResponse } =
        result.functionResponse;
      const nextFunctionResponse = {
        ...restFunctionResponse,
        ...(retainedParts.length > 0 ? { parts: retainedParts } : {}),
      };

      if (extractedTexts.length > 0) {
        const joinedText = extractedTexts.join('\n');
        const existingResponse = nextFunctionResponse.response ?? {};
        if (typeof existingResponse['output'] === 'string') {
          nextFunctionResponse.response = {
            ...existingResponse,
            output: existingResponse['output']
              ? `${existingResponse['output']}\n${joinedText}`
              : joinedText,
          };
        } else if (existingResponse['output'] === undefined) {
          nextFunctionResponse.response = {
            ...existingResponse,
            output: joinedText,
          };
        } else {
          let noteKey = 'notes';
          while (
            existingResponse[noteKey] !== undefined &&
            typeof existingResponse[noteKey] !== 'string'
          ) {
            noteKey = `_${noteKey}`;
          }
          const existingNote = existingResponse[noteKey];
          nextFunctionResponse.response = {
            ...existingResponse,
            [noteKey]:
              typeof existingNote === 'string' && existingNote
                ? `${existingNote}\n${joinedText}`
                : joinedText,
          };
        }
      }

      result.functionResponse = nextFunctionResponse;
    }

    return result;
  }

  /**
   * Convert unsupported media types (audio, video) to explanatory text for Gemini API
   */
  private convertUnsupportedMediaToText(part: Part): Part {
    if (typeof part === 'string') return part;

    const inlineMimeType = (part.inlineData?.mimeType || '').trim();
    const fileMimeType = (part.fileData?.mimeType || '').trim();
    const normalizedInlineMime = inlineMimeType.toLowerCase();
    const normalizedFileMime = fileMimeType.toLowerCase();

    if (
      normalizedInlineMime.startsWith('audio/') ||
      normalizedInlineMime.startsWith('video/')
    ) {
      const displayName = (part.inlineData as { displayName?: string })
        ?.displayName;
      const displayNameText = displayName ? ` (${displayName})` : '';
      return {
        text: `Unsupported media type for Gemini: ${inlineMimeType}${displayNameText}.`,
      };
    }

    if (
      normalizedFileMime.startsWith('audio/') ||
      normalizedFileMime.startsWith('video/')
    ) {
      const displayName = (part.fileData as { displayName?: string })
        ?.displayName;
      const displayNameText = displayName ? ` (${displayName})` : '';
      return {
        text: `Unsupported media type for Gemini: ${fileMimeType}${displayNameText}.`,
      };
    }

    return part;
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const httpOptions = this.buildHttpOptions(request.config?.httpOptions);
    return this.models.embedContent({
      ...request,
      ...(httpOptions ? { config: { ...request.config, httpOptions } } : {}),
    });
  }
}

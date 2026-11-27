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
  InputModalities,
} from '../contentGenerator.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { REATTACH_BOUNDARY_METADATA } from '../../services/image-payload-references.js';
import { normalizeMediaMimeType } from '../../utils/media-mime.js';
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
 * Strip redundant trailing API version segment(s) (`/v1beta` for Gemini
 * Developer API, `/v1beta1` for Vertex AI, with optional trailing slashes)
 * from a base URL before passing it to `@google/genai`, which appends its
 * own version prefix and would otherwise send `/v1beta/v1beta/` or
 * `/v1beta1/v1beta1/`.
 */
export function normalizeGeminiBaseUrl(
  baseUrl: string,
  vertexai = false,
): string {
  const versionPattern = vertexai ? /(?:\/v1beta1)+$/i : /(?:\/v1beta)+$/i;
  return baseUrl.trim().replace(/\/+$/, '').replace(versionPattern, '');
}

/**
 * Gemini 3+ models accept binary `audio/*` and `video/*` payloads directly
 * inside `functionResponse.parts` (`FunctionResponsePart`), whereas Gemini 2.5
 * and earlier return HTTP 400 `INVALID_ARGUMENT` for nested audio/video tool
 * outputs and require them on a top-level `user` turn.
 */
export function supportsGeminiFunctionResponseAudioVideo(
  model: string | undefined,
): boolean {
  if (!model) return false;
  const leaf = model.trim().split('/').pop()?.toLowerCase() ?? '';
  return /^gemini-([3-9]|\d{2,})(?:[.-]|$)/.test(leaf);
}

function getMediaModality(
  mimeType: string | undefined,
): keyof InputModalities | undefined {
  const normalized = normalizeMediaMimeType(mimeType);
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized === 'application/pdf') return 'pdf';
  return undefined;
}

function isUnsignedEmptyTextPart(part: Part | string): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }
  const definedKeys = Object.keys(part).filter(
    (key) => (part as Record<string, unknown>)[key] !== undefined,
  );
  return (
    definedKeys.length === 1 && definedKeys[0] === 'text' && part.text === ''
  );
}

function isReattachBoundaryPart(part: Part | string): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    part.partMetadata?.[REATTACH_BOUNDARY_METADATA] === true
  );
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

/**
 * Thrown when a non-streaming Gemini/Vertex request exceeds the configured
 * request timeout while reading the response body after headers have arrived.
 * Stamped with `code: 'ETIMEDOUT'` so `classifyRetryError` classifies it as a
 * retryable transport timeout.
 */
export class GeminiRequestTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(readonly timeoutMs: number) {
    super(
      `Gemini API non-streaming request exceeded ${timeoutMs}ms while reading ` +
        `the response body. Increase the model request timeout ` +
        `(or set it to 0 to disable this bound).`,
    );
    this.name = 'GeminiRequestTimeoutError';
  }
}

type NonStreamingHeaderCallback = (
  remainingMs: number,
  abortConnect: (reason: Error) => void,
) => void;

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
    nonStreamingHeaderCallbacks?: WeakMap<
      AbortSignal,
      NonStreamingHeaderCallback
    >;
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
  // Maps the SDK's per-request AbortSignal back to our non-streaming body
  // deadline callback registered under `abortScope.signal`.
  const sdkSignalToHeaderCallback = new WeakMap<
    AbortSignal,
    NonStreamingHeaderCallback
  >();
  if (typeof apiClient.includeExtraHttpOptionsToRequestInit === 'function') {
    const includeExtraHttpOptionsToRequestInit =
      apiClient.includeExtraHttpOptionsToRequestInit.bind(apiClient);
    apiClient.includeExtraHttpOptionsToRequestInit = async (
      init,
      httpOptions,
      url,
      signal,
    ) => {
      // The SDK only observes abort events after it starts building the request.
      signal?.throwIfAborted();
      const hasExplicitNativeHeader = Object.keys(
        httpOptions.headers ?? {},
      ).some((name) => name.toLowerCase() === 'x-goog-api-key');
      const request = await includeExtraHttpOptionsToRequestInit(
        init,
        httpOptions,
        url,
        signal,
      );
      if (hasExplicitNativeHeader && request.headers) {
        explicitNativeHeaderRequests.add(request.headers as Headers);
      }
      if (signal && request.signal) {
        const cb = options.nonStreamingHeaderCallbacks?.get(signal);
        if (cb) {
          sdkSignalToHeaderCallback.set(request.signal, cb);
        }
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
    let lastAttemptStartMs = Date.now();
    let lastConnectController: AbortController | undefined;

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

      lastAttemptStartMs = Date.now();
      const connectController = new AbortController();
      lastConnectController = connectController;
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
    if (connectTimeoutActive && parentSignal) {
      const onHeaders =
        sdkSignalToHeaderCallback.get(parentSignal) ??
        options.nonStreamingHeaderCallbacks?.get(parentSignal);
      if (onHeaders) {
        const remainingMs = Math.max(
          0,
          connectTimeoutMs - (Date.now() - lastAttemptStartMs),
        );
        const controller = lastConnectController;
        onHeaders(remainingMs, (reason) => {
          if (controller && !controller.signal.aborted) {
            controller.abort(reason);
          }
        });
      }
    }
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
      let result: IteratorResult<GenerateContentResponse>;
      try {
        result = await iterator.next();
      } catch (error) {
        options.abortRequest();
        throw error;
      }
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
  private readonly requestTimeoutMs?: number;
  private readonly nonStreamingHeaderCallbacks = new WeakMap<
    AbortSignal,
    NonStreamingHeaderCallback
  >();
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
    // callers — using the SDK's resolved vertexai mode so `@google/genai`
    // never doubles `/v1beta` (Developer API) or `/v1beta1` (Vertex AI).
    const isVertex = Boolean(this.googleGenAI.vertexai);
    const normalizedClientBaseUrl = rawResolvedBaseUrl
      ? normalizeGeminiBaseUrl(rawResolvedBaseUrl, isVertex)
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
      sdkHttpOptions.baseUrl = normalizeGeminiBaseUrl(
        sdkHttpOptions.baseUrl,
        isVertex,
      );
    }
    const rawTimeout = contentGeneratorConfig?.timeout;
    let normalizedTimeout: number | undefined;
    if (typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)) {
      normalizedTimeout = Math.min(rawTimeout, DISABLED_REQUEST_TIMEOUT_MS);
    }
    const connectTimeoutMs =
      finalOptions.httpOptions?.timeout === undefined
        ? resolveRequestTimeout(normalizedTimeout)
        : undefined;
    this.requestTimeoutMs = connectTimeoutMs;
    this.hasIsolatedTransport = installIsolatedTransport(this.googleGenAI, {
      apiKey: finalOptions.apiKey,
      getProxy: () => cliConfig?.getProxy?.() ?? contentGeneratorConfig?.proxy,
      connectTimeoutMs,
      nonStreamingHeaderCallbacks: this.nonStreamingHeaderCallbacks,
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
    const effectiveModel = request.model || this.contentGeneratorConfig?.model;
    const callerSignal = request.config?.abortSignal;
    const totalTimeoutMs =
      request.config?.httpOptions?.timeout === undefined
        ? this.requestTimeoutMs
        : undefined;
    const totalTimeoutActive =
      this.hasIsolatedTransport &&
      totalTimeoutMs !== undefined &&
      totalTimeoutMs > 0 &&
      totalTimeoutMs < DISABLED_REQUEST_TIMEOUT_MS;

    let abortScope: ReturnType<typeof createRequestAbortScope> | undefined;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      abortScope =
        callerSignal || totalTimeoutActive
          ? createRequestAbortScope(callerSignal)
          : undefined;
      const builtConfig = this.buildGenerateContentConfig(request);
      const finalRequest = {
        ...request,
        contents: this.stripUnsupportedFields(request.contents, effectiveModel),
        config: abortScope
          ? { ...builtConfig, abortSignal: abortScope.signal }
          : builtConfig,
      };
      const telemetryAttempt = reportLlmRequest(finalRequest);

      let response: GenerateContentResponse;
      if (totalTimeoutActive && abortScope) {
        let rejectBodyTimeout!: (error: Error) => void;
        const bodyTimeoutPromise = new Promise<never>((_resolve, reject) => {
          rejectBodyTimeout = reject;
        });
        void bodyTimeoutPromise.catch(() => {});

        const activeScope = abortScope;
        this.nonStreamingHeaderCallbacks.set(
          activeScope.signal,
          (remainingMs, abortConnect) => {
            if (bodyTimer !== undefined) {
              clearTimeout(bodyTimer);
            }
            bodyTimer = setTimeout(() => {
              if (callerSignal?.aborted) {
                const abortErr = new Error('Aborted');
                abortErr.name = 'AbortError';
                rejectBodyTimeout(abortErr);
              } else {
                const timeoutErr = new GeminiRequestTimeoutError(
                  totalTimeoutMs,
                );
                abortConnect(timeoutErr);
                activeScope.abort();
                rejectBodyTimeout(timeoutErr);
              }
            }, remainingMs);
            bodyTimer.unref?.();
          },
        );

        const requestPromise = this.models.generateContent(finalRequest);
        void requestPromise.catch(() => {});
        response = await Promise.race([requestPromise, bodyTimeoutPromise]);
      } else {
        response = await this.models.generateContent(finalRequest);
      }

      reportLlmResponse(telemetryAttempt, response);
      return response;
    } finally {
      if (bodyTimer !== undefined) {
        clearTimeout(bodyTimer);
      }
      abortScope?.dispose();
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const effectiveModel = request.model || this.contentGeneratorConfig?.model;
    const streamConfig = this.contentGeneratorConfig ?? {
      model: request.model,
    };
    const idleMs = resolveStreamIdleTimeoutMs(streamConfig);
    const maxLifetimeMs = resolveStreamMaxLifetimeMs(streamConfig);
    const callerSignal = request.config?.abortSignal;
    let abortScope: ReturnType<typeof createRequestAbortScope> | undefined;
    let telemetryAttempt: GenAiAttemptHandle | undefined;
    let stream: AsyncIterable<GenerateContentResponse>;
    try {
      abortScope = createRequestAbortScope(callerSignal);
      const config = {
        ...this.buildGenerateContentConfig(request),
        abortSignal: abortScope.signal,
      };
      const finalRequest = {
        ...request,
        contents: this.stripUnsupportedFields(request.contents, effectiveModel),
        config,
      };
      telemetryAttempt = reportLlmRequest(finalRequest);
      markRequestDispatched();
      stream = await this.models.generateContentStream(finalRequest);
    } catch (error) {
      abortScope?.abort();
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
   * Strip fields not supported by Gemini API (e.g., displayName in inlineData/fileData),
   * normalize media MIME types, enforce configured InputModalities (presence-as-true),
   * drop strictly unsigned empty-text parts, split trailing historical image
   * reattachment bundles off functionResponse turns, and promote tool-returned
   * audio/video to a follow-up user turn for Gemini 2.5 and earlier models.
   */
  private stripUnsupportedFields(
    contents: GenerateContentParameters['contents'],
    model?: string,
  ): GenerateContentParameters['contents'] {
    if (!contents) return contents;

    if (typeof contents === 'string') return contents;

    const allowNestedAudioVideo =
      supportsGeminiFunctionResponseAudioVideo(model);

    if (Array.isArray(contents)) {
      return contents.flatMap((content) =>
        this.stripContentFieldsList(content, allowNestedAudioVideo),
      ) as GenerateContentParameters['contents'];
    }

    const normalized = this.stripContentFieldsList(
      contents,
      allowNestedAudioVideo,
    );
    return (
      normalized.length === 1 ? normalized[0] : normalized
    ) as GenerateContentParameters['contents'];
  }

  private stripContentFieldsList(
    content: Content | Part | string,
    allowNestedAudioVideo: boolean,
  ): Array<Content | Part | string> {
    if (typeof content === 'string') {
      return [content];
    }

    // Handle Part directly (for arrays of parts)
    if (!('role' in content) && !('parts' in content)) {
      return [this.stripPartFields(content as Part, allowNestedAudioVideo)];
    }

    // Handle Content object
    const contentObj = content as Content;
    if (!contentObj.parts) return [contentObj];

    const rawParts = contentObj.parts;
    const reattachIndex = rawParts.findIndex(
      (part, idx) => idx > 0 && isReattachBoundaryPart(part),
    );
    const shouldSplitReattach =
      reattachIndex > 0 &&
      rawParts
        .slice(0, reattachIndex)
        .some(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            Boolean(part.functionResponse),
        ) &&
      !rawParts
        .slice(reattachIndex)
        .some(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            Boolean(part.functionResponse),
        );

    const promotedMediaParts: Part[] = [];

    if (shouldSplitReattach) {
      const headParts = this.sanitizeTurnParts(
        rawParts.slice(0, reattachIndex),
        allowNestedAudioVideo,
        promotedMediaParts,
      );
      const tailParts = this.sanitizeTurnParts(
        rawParts.slice(reattachIndex),
        allowNestedAudioVideo,
      );
      return [
        {
          ...contentObj,
          parts: headParts,
        },
        {
          role: 'user',
          parts:
            promotedMediaParts.length > 0
              ? [...promotedMediaParts, ...tailParts]
              : tailParts,
        },
      ];
    }

    const sanitizedParts = this.sanitizeTurnParts(
      rawParts,
      allowNestedAudioVideo,
      promotedMediaParts,
    );
    if (promotedMediaParts.length > 0) {
      return [
        {
          ...contentObj,
          parts: sanitizedParts,
        },
        {
          role: 'user',
          parts: [
            { text: 'Attached media from tool output:' },
            ...promotedMediaParts,
          ],
        },
      ];
    }

    return [
      {
        ...contentObj,
        parts: sanitizedParts,
      },
    ];
  }

  private sanitizeTurnParts(
    parts: Part[],
    allowNestedAudioVideo: boolean,
    promotedMediaParts?: Part[],
  ): Part[] {
    const stripped = parts.map((part) =>
      this.stripPartFields(part, allowNestedAudioVideo, promotedMediaParts),
    );
    const filtered = stripped.filter((part) => !isUnsignedEmptyTextPart(part));
    return filtered.length > 0 ? filtered : stripped;
  }

  private isMediaModalityDisabled(mimeType: string | undefined): boolean {
    const modalities = this.contentGeneratorConfig?.modalities;
    if (!modalities) {
      return false;
    }
    const modality = getMediaModality(mimeType);
    if (!modality) {
      return false;
    }
    return !modalities[modality];
  }

  private formatDisabledMediaNote(
    mimeType: string | undefined,
    displayName?: string,
  ): string {
    const normalized = normalizeMediaMimeType(mimeType) ?? '';
    const displayNameText = displayName ? ` (${displayName})` : '';
    return `Unsupported media type for Gemini: ${normalized}${displayNameText}.`;
  }

  private formatPromotedMediaNote(
    mimeType: string | undefined,
    displayName?: string,
  ): string {
    const normalized = normalizeMediaMimeType(mimeType) ?? '';
    const displayNameText = displayName ? ` (${displayName})` : '';
    return `Attached ${normalized}${displayNameText} in following user message.`;
  }

  private sanitizeTopLevelMedia<
    T extends { displayName?: string; mimeType?: string },
  >(media: T, disabledNotes: string[]): Omit<T, 'displayName'> | undefined {
    const { displayName, ...rest } = media;
    if (this.isMediaModalityDisabled(rest.mimeType)) {
      disabledNotes.push(
        this.formatDisabledMediaNote(rest.mimeType, displayName),
      );
      return undefined;
    }
    const normalizedMime = normalizeMediaMimeType(rest.mimeType);
    return {
      ...rest,
      ...(normalizedMime !== undefined ? { mimeType: normalizedMime } : {}),
    };
  }

  private processNestedFunctionResponseMedia(
    rawMimeType: string | undefined,
    displayName: string | undefined,
    buildCleanPart: (mimeType: string | undefined) => FunctionResponsePart,
    allowNestedAudioVideo: boolean,
    retainedParts: FunctionResponsePart[],
    extractedTexts: string[],
    promotedMediaParts?: Part[],
  ): void {
    if (this.isMediaModalityDisabled(rawMimeType)) {
      extractedTexts.push(
        this.formatDisabledMediaNote(rawMimeType, displayName),
      );
      return;
    }
    const modality = getMediaModality(rawMimeType);
    const isAudioOrVideo = modality === 'audio' || modality === 'video';
    const cleanPart = buildCleanPart(normalizeMediaMimeType(rawMimeType));
    if (isAudioOrVideo && !allowNestedAudioVideo) {
      if (promotedMediaParts) {
        promotedMediaParts.push(cleanPart);
        extractedTexts.push(
          this.formatPromotedMediaNote(rawMimeType, displayName),
        );
      } else {
        extractedTexts.push(
          this.formatDisabledMediaNote(rawMimeType, displayName),
        );
      }
      return;
    }
    retainedParts.push(cleanPart);
  }

  private stripPartFields(
    part: Part,
    allowNestedAudioVideo: boolean,
    promotedMediaParts?: Part[],
  ): Part {
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

    const disabledNotes: string[] = [];

    if (result.inlineData) {
      const sanitized = this.sanitizeTopLevelMedia(
        result.inlineData as {
          displayName?: string;
          mimeType?: string;
          [key: string]: unknown;
        },
        disabledNotes,
      );
      if (sanitized) {
        result.inlineData = sanitized as Part['inlineData'];
      } else {
        delete result.inlineData;
      }
    }

    if (result.fileData) {
      const sanitized = this.sanitizeTopLevelMedia(
        result.fileData as {
          displayName?: string;
          mimeType?: string;
          [key: string]: unknown;
        },
        disabledNotes,
      );
      if (sanitized) {
        result.fileData = sanitized as Part['fileData'];
      } else {
        delete result.fileData;
      }
    }

    if (disabledNotes.length > 0) {
      const joinedNotes = disabledNotes.join('\n');
      result.text = result.text
        ? `${result.text}\n${joinedNotes}`
        : joinedNotes;
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

    // Gemini's FunctionResponsePart schema permits `inlineData` and `fileData`
    // (oneof data, without displayName or unknown fields) — never `text`.
    // Retain native image/pdf payloads in `functionResponse.parts` on all
    // models; retain audio/video natively on Gemini 3+ models, and promote
    // audio/video to a follow-up `user` turn on Gemini 2.5 and earlier models
    // (which reject nested audio/video inside FunctionResponsePart with 400).
    // Disabled modalities and text entries move into `functionResponse.response`.
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
        if (typeof nestedPart.text === 'string' && nestedPart.text.length > 0) {
          extractedTexts.push(nestedPart.text);
        }
        if (nestedPart.inlineData) {
          const { mimeType: rawMimeType, data } = nestedPart.inlineData;
          const displayName = (
            nestedPart.inlineData as { displayName?: string }
          ).displayName;
          this.processNestedFunctionResponseMedia(
            rawMimeType,
            displayName,
            (mimeType) => ({
              inlineData: {
                ...(mimeType !== undefined ? { mimeType } : {}),
                ...(data !== undefined ? { data } : {}),
              },
            }),
            allowNestedAudioVideo,
            retainedParts,
            extractedTexts,
            promotedMediaParts,
          );
        }
        if (nestedPart.fileData) {
          const { fileUri, mimeType: rawMimeType } = nestedPart.fileData;
          const displayName = (nestedPart.fileData as { displayName?: string })
            .displayName;
          this.processNestedFunctionResponseMedia(
            rawMimeType,
            displayName,
            (mimeType) => ({
              fileData: {
                ...(fileUri !== undefined ? { fileUri } : {}),
                ...(mimeType !== undefined ? { mimeType } : {}),
              },
            }),
            allowNestedAudioVideo,
            retainedParts,
            extractedTexts,
            promotedMediaParts,
          );
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

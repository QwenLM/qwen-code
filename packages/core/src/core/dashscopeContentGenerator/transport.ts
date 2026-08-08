/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import type { DashScopeRequest, DashScopeResponsePayload } from './types.js';
import { parseDashScopeSse, type DashScopeSseFrame } from './sse.js';
import { toDashScopeApiError } from './errors.js';
import { resolveDashScopeGenerationEndpoint } from './endpoints.js';
import {
  buildRuntimeFetchOptions,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import {
  resolveRequestTimeout,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
} from '../openaiContentGenerator/constants.js';
import {
  resolveStreamGuardMs,
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
} from '../openaiContentGenerator/pipeline.js';

export interface DashScopeRequestOptions {
  signal: AbortSignal;
}

export interface DashScopeTransport {
  postJson(
    body: DashScopeRequest,
    opts: DashScopeRequestOptions,
  ): Promise<DashScopeResponsePayload>;
  postSse(
    body: DashScopeRequest,
    opts: DashScopeRequestOptions,
  ): Promise<AsyncGenerator<DashScopeSseFrame>>;
}

/**
 * The only I/O seam for the native DashScope provider: builds headers, applies
 * the shared proxy/timeout/runtime-fetch configuration, and wraps streaming
 * responses with inactivity/lifetime guards. `contentGeneratorConfig.apiKey`
 * is re-read on every request (never cached) since it may be refreshed.
 */
export class FetchDashScopeTransport implements DashScopeTransport {
  constructor(
    private readonly contentGeneratorConfig: ContentGeneratorConfig,
    private readonly cliConfig: Config,
  ) {}

  private buildHeaders(streaming: boolean): Record<string, string> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.contentGeneratorConfig.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': `QwenCode/${version} (${process.platform}; ${process.arch})`,
    };
    if (streaming) {
      headers['X-DashScope-SSE'] = 'enable';
    }
    const { customHeaders } = this.contentGeneratorConfig;
    if (customHeaders) {
      for (const [key, value] of Object.entries(customHeaders)) {
        headers[key] = value;
      }
    }
    return headers;
  }

  /**
   * Issues the fetch and returns both the response and a `clearRequestTimeout`
   * callback the caller must invoke once the request timeout's job — bounding
   * connect + first response, matching the OpenAI/Anthropic SDK clients — is
   * done for its use case. It is intentionally NOT cleared automatically here:
   * `postJson` needs the timeout to keep bounding its `response.text()` read
   * (mirroring the previous behavior for non-streaming calls), while `postSse`
   * must clear it the moment headers arrive so a healthy, actively-flowing SSE
   * body is never killed by `DEFAULT_TIMEOUT` — stream lifetime is the idle/
   * lifetime guards' job (see `withStreamGuards`), not the request timeout's.
   */
  private async request(
    body: DashScopeRequest,
    opts: DashScopeRequestOptions,
    streaming: boolean,
    extraSignal?: AbortSignal,
  ): Promise<{
    response: Response;
    clearRequestTimeout: () => void;
    normalizeRequestError: (error: unknown) => unknown;
  }> {
    const url = resolveDashScopeGenerationEndpoint(
      this.contentGeneratorConfig.baseUrl,
    );
    const headers = this.buildHeaders(streaming);
    const timeoutMs = resolveRequestTimeout(
      this.contentGeneratorConfig.timeout,
    );
    const timeoutController = new AbortController();
    const timeoutError = Object.assign(
      new Error(`DashScope request timed out after ${timeoutMs}ms.`),
      { code: 'ETIMEDOUT' as const },
    );
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(timeoutError);
    }, timeoutMs);
    timeoutTimer.unref?.();
    const clearRequestTimeout = () => clearTimeout(timeoutTimer);
    const normalizeRequestError = (error: unknown): unknown =>
      timeoutController.signal.aborted && !opts.signal.aborted
        ? timeoutError
        : redactProxyError(error);

    const signals = [opts.signal, timeoutController.signal];
    if (extraSignal) {
      signals.push(extraSignal);
    }
    const signal = AbortSignal.any(signals);

    const rt = buildRuntimeFetchOptions('anthropic', this.cliConfig.getProxy());
    const doFetch: typeof fetch = rt?.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        ...(rt?.fetchOptions ?? {}),
      });
    } catch (err) {
      clearRequestTimeout();
      throw normalizeRequestError(err);
    }

    if (!response.ok) {
      let raw: string;
      try {
        raw = await response.text();
      } catch (err) {
        clearRequestTimeout();
        throw normalizeRequestError(err);
      }
      clearRequestTimeout();
      throw toDashScopeApiError({
        status: response.status,
        rawBody: raw,
        headers: response.headers,
      });
    }
    return { response, clearRequestTimeout, normalizeRequestError };
  }

  async postJson(
    body: DashScopeRequest,
    opts: DashScopeRequestOptions,
  ): Promise<DashScopeResponsePayload> {
    const { response, clearRequestTimeout, normalizeRequestError } =
      await this.request(body, opts, false);
    let raw: string;
    try {
      raw = await response.text();
    } catch (err) {
      throw normalizeRequestError(err);
    } finally {
      clearRequestTimeout();
    }
    try {
      return JSON.parse(raw) as DashScopeResponsePayload;
    } catch {
      throw toDashScopeApiError({ status: response.status, rawBody: raw });
    }
  }

  async postSse(
    body: DashScopeRequest,
    opts: DashScopeRequestOptions,
  ): Promise<AsyncGenerator<DashScopeSseFrame>> {
    const guardController = new AbortController();
    const { response, clearRequestTimeout } = await this.request(
      body,
      opts,
      true,
      guardController.signal,
    );
    // Headers have arrived: the request timeout's job is done. From here on,
    // stream lifetime is bounded exclusively by the idle/lifetime guards
    // below, not by DEFAULT_TIMEOUT.
    clearRequestTimeout();
    if (!response.body) {
      throw toDashScopeApiError({
        status: response.status,
        rawBody: 'DashScope streaming response had no body.',
      });
    }
    return this.withStreamGuards(parseDashScopeSse(response.body), () =>
      guardController.abort(),
    );
  }

  private async *withStreamGuards(
    frames: AsyncGenerator<DashScopeSseFrame>,
    abortRequest: () => void,
  ): AsyncGenerator<DashScopeSseFrame> {
    const idleMs = resolveStreamGuardMs(
      this.contentGeneratorConfig.streamIdleTimeoutMs,
      'streamIdleTimeoutMs',
      QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    );
    const maxLifetimeMs = resolveStreamGuardMs(
      this.contentGeneratorConfig.streamMaxLifetimeMs,
      'streamMaxLifetimeMs',
      QWEN_STREAM_MAX_LIFETIME_MS_ENV,
      DEFAULT_STREAM_MAX_LIFETIME_MS,
    );

    if (idleMs <= 0 && maxLifetimeMs <= 0) {
      yield* frames;
      return;
    }

    const streamStartedAt = performance.now();
    let upstreamMs = 0;
    let chunksReceived = 0;
    let finishedNormally = false;

    try {
      while (true) {
        const remainingMs =
          maxLifetimeMs > 0
            ? maxLifetimeMs - upstreamMs
            : Number.POSITIVE_INFINITY;
        if (remainingMs <= 0) {
          abortRequest();
          throw new StreamLifetimeExceededError(
            maxLifetimeMs,
            chunksReceived,
            performance.now() - streamStartedAt,
          );
        }
        const nextPromise = frames.next();
        const awaitedAt = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          const idleIn = idleMs > 0 ? idleMs : Number.POSITIVE_INFINITY;
          timer = setTimeout(
            () => {
              abortRequest();
              reject(
                remainingMs <= idleIn
                  ? new StreamLifetimeExceededError(
                      maxLifetimeMs,
                      chunksReceived,
                      performance.now() - streamStartedAt,
                    )
                  : new StreamInactivityTimeoutError(
                      idleMs,
                      chunksReceived,
                      performance.now() - streamStartedAt,
                    ),
              );
            },
            Math.max(Math.min(idleIn, remainingMs), 0),
          );
          timer.unref?.();
        });

        let result: IteratorResult<DashScopeSseFrame>;
        try {
          result = await Promise.race([nextPromise, timeout]);
        } catch (err) {
          // If a guard fired first, the orphaned frames.next() may later
          // reject (e.g. once abortRequest() tears down the socket) —
          // swallow that so it never surfaces as an unhandled rejection.
          void Promise.resolve(nextPromise).catch(() => {});
          throw err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }

        if (result.done) {
          finishedNormally = true;
          return;
        }
        upstreamMs += performance.now() - awaitedAt;
        chunksReceived += 1;
        yield result.value;
      }
    } finally {
      if (!finishedNormally) {
        try {
          await frames.return?.(undefined);
        } catch {
          // Best-effort cleanup — a rejection here must not mask the
          // original guard/abort error propagating out of the generator.
        }
      }
    }
  }
}

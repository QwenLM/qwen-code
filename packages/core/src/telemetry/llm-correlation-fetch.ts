/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';
import type { Config } from '../config/config.js';

/**
 * Custom HTTP header attached to every outbound LLM service request when
 * telemetry is enabled. Product-namespaced (matching claude-code's
 * `X-Claude-Code-Session-Id` pattern from `src/services/api/client.ts:108`)
 * to avoid collision with generic `X-Session-Id` headers other tools may
 * inject. Server-side ingestion can use this to stitch its observation of
 * an LLM request back to the originating qwen-code session.
 */
export const SESSION_ID_HEADER = 'X-Qwen-Code-Session-Id';

/**
 * Loose fetch-like signature the wrapper internally programs against.
 *
 * Exists because the SDKs we wrap have **incompatible** Fetch types:
 *   - `openai@5.11`: `(input: string | URL | Request, init?) => Promise<Response>`
 *   - `@anthropic-ai/sdk`: `(input: RequestInfo, init?) => Promise<Response>`
 *     where `RequestInfo = string | Request` (NOT including URL).
 *
 * No single concrete signature satisfies both as a structural subtype, so the
 * public `wrapFetchWithCorrelation` is generic and preserves the caller's
 * exact type (the SDK's own Fetch). This type only describes the input shape
 * we touch inside the wrapper.
 */
type FetchLikeLoose = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Wrap a fetch implementation so every outbound request gets the
 * `X-Qwen-Code-Session-Id` correlation header populated from the **current**
 * session id, not the value captured when the SDK client was constructed.
 *
 * Why per-request and not `defaultHeaders`: SDK clients (and their static
 * `defaultHeaders`) are constructed once at content-generator init and are
 * NOT recreated on `/clear`-triggered session reset (`Config.resetSession()`
 * updates `this.sessionId` but doesn't rebuild the contentGenerator). A
 * static header would therefore go stale immediately after the first reset.
 * Reading `config.getSessionId()` from inside the wrapper on every call
 * gives the live value.
 *
 * The caller is responsible for choosing the base fetch — usually
 * `runtimeOptions?.fetch ?? globalThis.fetch` so proxy-aware fetch (set up
 * by `buildRuntimeFetchOptions`) is preserved when ProxyAgent is in use.
 *
 * When telemetry is disabled, returns baseFetch unchanged — no correlation
 * header added. (Consistent with #4367's gating: opt-out of telemetry means
 * no telemetry-related wire signal, including correlation.)
 *
 * Safety: the wrapper catches its own exceptions and falls through to
 * baseFetch on any internal error. Telemetry must never break the LLM
 * request path — if Config getters throw, header construction fails, etc.,
 * we still want the model call to proceed.
 */
export function wrapFetchWithCorrelation<TFetch extends FetchLikeLoose>(
  baseFetch: TFetch,
  config: Config,
): TFetch {
  const wrapped: FetchLikeLoose = async function correlationFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let headers: Headers;
    try {
      if (!config.getTelemetryEnabled()) {
        return baseFetch(input, init);
      }
      const sid = config.getSessionId();
      if (!sid) {
        // Defensive: empty header value is rejected by some HTTP middleware.
        // Skip injection rather than send `X-Qwen-Code-Session-Id: `.
        return baseFetch(input, init);
      }
      // Seed headers from BOTH the init.headers (if any) AND the Request's
      // own headers when input is a Request and init doesn't override.
      // Otherwise `new Headers(undefined)` would drop the Request's headers
      // (including Authorization) when we then pass `{...init, headers}`
      // back to baseFetch. See PR #4393 review feedback.
      headers = new Headers(init?.headers);
      if (init?.headers === undefined && input instanceof Request) {
        input.headers.forEach((value, key) => headers.set(key, value));
      }
      headers.set(SESSION_ID_HEADER, sid);
    } catch (err) {
      // Telemetry must never break the LLM request path. Log and fall through.
      diag.warn(
        `wrapFetchWithCorrelation: header construction failed, sending request without correlation header: ${err instanceof Error ? err.message : String(err)}`,
      );
      return baseFetch(input, init);
    }
    return baseFetch(input, { ...init, headers });
  };
  // Cast back to TFetch: runtime behavior matches whatever signature the
  // caller's baseFetch has (we delegate to it without altering shape).
  return wrapped as unknown as TFetch;
}

/**
 * Static correlation headers. Captures the session id at call time —
 * subject to staleness if the host SDK keeps these headers in a
 * captured-at-construction slot (e.g. `@google/genai`'s
 * `httpOptions.headers` — see design doc §8.6 for the known Gemini
 * limitation). Prefer `wrapFetchWithCorrelation` whenever the SDK exposes
 * a `fetch` hook.
 *
 * When telemetry is disabled, returns `{}` so the caller can spread it
 * unconditionally without changing wire behavior.
 */
export function staticCorrelationHeaders(
  config: Config,
): Record<string, string> {
  if (!config.getTelemetryEnabled()) return {};
  const sid = config.getSessionId();
  if (!sid) return {};
  return { [SESSION_ID_HEADER]: sid };
}

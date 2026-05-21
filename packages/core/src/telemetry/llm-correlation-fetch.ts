/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 */
export function wrapFetchWithCorrelation(
  baseFetch: typeof fetch,
  config: Config,
): typeof fetch {
  return async function correlationFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!config.getTelemetryEnabled()) {
      return baseFetch(input, init);
    }
    const sid = config.getSessionId();
    if (!sid) {
      // Defensive: empty header value is rejected by some HTTP middleware.
      // Skip injection rather than send `X-Qwen-Code-Session-Id: `.
      return baseFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set(SESSION_ID_HEADER, sid);
    return baseFetch(input, { ...init, headers });
  };
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

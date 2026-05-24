/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  DEFAULT_SESSION_ID_HEADER_HOSTS,
  extractRequestHost,
  matchesTrustedHost,
} from './trusted-llm-hosts.js';

/**
 * Custom HTTP header attached to outbound LLM service requests when
 * telemetry is enabled AND the destination is on the trusted-host
 * allowlist. Product-namespaced (matching claude-code's
 * `X-Claude-Code-Session-Id` pattern from `src/services/api/client.ts:108`)
 * to avoid collision with generic `X-Session-Id` headers other tools may
 * inject. Server-side ingestion can use this to stitch its observation of
 * an LLM request back to the originating qwen-code session.
 *
 * Scope: see `DEFAULT_SESSION_ID_HEADER_HOSTS` for the default destination
 * set and PR #4390 review (LaZzyMan) for the rationale behind not
 * broadcasting to every third-party LLM provider.
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
 * Wrap a fetch implementation so outbound requests to trusted LLM
 * destinations get the `X-Qwen-Code-Session-Id` correlation header
 * populated from the **current** session id, not the value captured
 * when the SDK client was constructed.
 *
 * Three gates, in order:
 *   1. Telemetry enabled (`config.getTelemetryEnabled()`)
 *   2. Destination host is on the trusted allowlist
 *      (`config.getTelemetrySessionIdHeaderHosts()` ?? default in-vendor set)
 *   3. Session id is non-empty
 *
 * Any failed gate falls through to `baseFetch(input, init)` unchanged —
 * no header attached, no behavior change. This means a request to
 * `api.openai.com` from a default-config install goes out exactly the
 * same as it did before this PR landed.
 *
 * Why per-request and not `defaultHeaders`: SDK clients (and their static
 * `defaultHeaders`) are constructed once at content-generator init and are
 * NOT recreated on `/clear`-triggered session reset (`Config.resetSession()`
 * updates `this.sessionId` but doesn't rebuild the contentGenerator). A
 * static header would therefore go stale immediately after the first reset.
 * Reading `config.getSessionId()` from inside the wrapper on every call
 * gives the live value.
 *
 * Note on `trustedHosts`: snapshotted once at wrap time, not read per
 * request. The session id is live-read but the allowlist is not — a
 * mid-session change to `telemetry.sessionIdHeaderHosts` in settings.json
 * takes effect at next content-generator init (any change that mutates
 * Config snapshot the wrapper retains is by definition a Config-level
 * concern, not a request-time concern). Operators tuning the scope live
 * should restart, or call the openai/anthropic clients via a fresh
 * provider after settings reload.
 *
 * The caller is responsible for choosing the base fetch — usually
 * `runtimeOptions?.fetch ?? globalThis.fetch` so proxy-aware fetch (set up
 * by `buildRuntimeFetchOptions`) is preserved when ProxyAgent is in use.
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
  // Resolve the host allowlist once at wrap time (Config snapshot).
  // Operators override via `telemetry.sessionIdHeaderHosts` in
  // settings.json (e.g. `["*.api.openai.com"]` for a specific OpenAI-
  // compatible proxy, or `["*"]` to restore the broadcast behavior the
  // initial design proposed).
  //
  // Defensive normalization (PR #4390 review feedback): qwen-code's
  // settings loader does not enforce JSON schema at runtime, so the
  // getter can legitimately return a malformed value — a bare string
  // ("dashscope.aliyuncs.com" instead of ["dashscope.aliyuncs.com"]),
  // an array containing non-strings, or whitespace-padded entries
  // (" * " or " dashscope.aliyuncs.com"). The chain below:
  //   1. catches a throwing getter (mock without stub, pre-getter Config)
  //   2. rejects a non-array value (bare string typo) → default allowlist
  //   3. filters out non-string elements ([null, "..."] typo placeholder)
  //   4. trims every surviving entry uniformly, so the `*` broadcast
  //      escape hatch and the host-pattern match path have parity
  // Violating any of these would let `.includes / .some / matchesTrustedHost`
  // throw at buildClient time — bricking the LLM session before the first
  // prompt and violating the "telemetry must never break the LLM request
  // path" contract that `staticCorrelationHeaders` already honors via its
  // end-to-end try/catch.
  let trustedHosts: readonly string[];
  try {
    const raw =
      config.getTelemetrySessionIdHeaderHosts?.() ??
      DEFAULT_SESSION_ID_HEADER_HOSTS;
    trustedHosts = Array.isArray(raw)
      ? raw
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
      : DEFAULT_SESSION_ID_HEADER_HOSTS;
  } catch {
    trustedHosts = DEFAULT_SESSION_ID_HEADER_HOSTS;
  }
  // Wildcard escape hatch so operators who want the old broadcast
  // behavior can opt in via `["*"]` without us extending the pattern
  // grammar in `matchesTrustedHost` (which would tempt other globbing).
  // Pre-trimmed above, so `.includes('*')` covers `["*"]` / `[" * "]` /
  // `["\t*\n"]` uniformly.
  const broadcastAll = trustedHosts.includes('*');

  const wrapped: FetchLikeLoose = async function correlationFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let headers: Headers;
    try {
      if (!config.getTelemetryEnabled()) {
        return baseFetch(input, init);
      }
      if (!broadcastAll) {
        // Host gate: skip injection for destinations not on the allowlist.
        // This is what scopes the "stable client fingerprint" exposure to
        // first-party endpoints only. PR #4390 review (LaZzyMan).
        const host = extractRequestHost(input);
        if (!host || !matchesTrustedHost(host, trustedHosts)) {
          return baseFetch(input, init);
        }
      }
      const sid = config.getSessionId();
      if (!sid) {
        // Defensive: empty header value is rejected by some HTTP middleware.
        // Skip injection rather than send `X-Qwen-Code-Session-Id: `.
        return baseFetch(input, init);
      }
      // Seed headers: prefer init.headers when caller provided them (their
      // intent overrides). Otherwise, if input is a Request, copy its own
      // headers so they aren't lost when we pass `{...init, headers}` back
      // to baseFetch — `new Headers(undefined)` would otherwise produce an
      // empty Headers and drop the Request's headers (including
      // Authorization). See PR #4393 review feedback.
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
 * Host scope: same trusted-host allowlist as `wrapFetchWithCorrelation`,
 * but evaluated once against the `destinationUrl` known at SDK
 * construction. Callers that can't determine the destination should pass
 * `undefined` — the helper returns `{}` (no header, same as telemetry off).
 *
 * When telemetry is disabled or the destination isn't trusted, returns
 * `{}` so the caller can spread it unconditionally without changing wire
 * behavior.
 */
export function staticCorrelationHeaders(
  config: Config,
  destinationUrl?: string,
): Record<string, string> {
  // Mirror the safety contract of `wrapFetchWithCorrelation`: telemetry must
  // never break the LLM request path. This helper is called from the Gemini
  // content-generator factory at construction time — a throw here would
  // propagate up and crash content-generator init for the entire session.
  // Fall through to `{}` instead. See PR #4390 review feedback (wenshao).
  try {
    if (!config.getTelemetryEnabled()) return {};
    if (!destinationUrl) return {};
    // Same defensive normalization as `wrapFetchWithCorrelation`. Bare
    // string / array-with-nulls / whitespace-padded entries from a
    // hand-edited settings.json would otherwise crash `.includes` /
    // `matchesTrustedHost`. See sibling helper for full rationale.
    const raw =
      config.getTelemetrySessionIdHeaderHosts?.() ??
      DEFAULT_SESSION_ID_HEADER_HOSTS;
    const trustedHosts: readonly string[] = Array.isArray(raw)
      ? raw
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
      : DEFAULT_SESSION_ID_HEADER_HOSTS;
    const broadcastAll = trustedHosts.includes('*');
    if (!broadcastAll) {
      let host: string;
      try {
        host = new URL(destinationUrl).hostname;
      } catch {
        // Unparseable destination → treat as not on allowlist (fail closed).
        return {};
      }
      if (!matchesTrustedHost(host, trustedHosts)) return {};
    }
    const sid = config.getSessionId();
    if (!sid) return {};
    return { [SESSION_ID_HEADER]: sid };
  } catch (err) {
    diag.warn(
      `staticCorrelationHeaders: config read failed, omitting correlation header: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

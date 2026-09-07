/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('OUTBOUND_CORRELATION');

export const SESSION_ID_HEADER = 'session_id';
export const SESSION_ID_HEADER_HOSTS: readonly string[] = [
  'routify.alibaba-inc.com',
  'routify-online.alibaba-inc.com',
  'routify-pub.alibaba-inc.com',
];

// Conservative HTTP token subset (letters, digits, dot, underscore,
// hyphen) — covers real header names like `x-opencode-session` while
// keeping anything a Headers implementation could reject, or that could
// smuggle a second header, out of the configured value.
const VALID_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// An invalid header name is a static misconfiguration, so warn once per
// distinct name rather than on every request to the trusted host.
const warnedInvalidHeaderNames = new Set<string>();

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function requestUrl(input: string | URL | Request): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

/**
 * The user-configured header name to send to `hostname`, or `undefined`
 * when the opt-in feature is off, the host is not trusted, or the name
 * is unusable.
 *
 * Never throws. `outboundCorrelation.sessionIdHeader` ships OFF, and the
 * built-in first-party branch ships ON — so this function is kept
 * structurally unable to affect that branch, including by raising on a
 * `Config` collaborator that predates `getOutboundSessionIdHeaderSettings`.
 */
function configuredSessionHeaderName(
  config: Config,
  hostname: string,
): string | undefined {
  try {
    const settings = config.getOutboundSessionIdHeaderSettings();
    // Explicitly `=== true`, not `!== false`: a settings object that
    // reaches here without an `enabled` field is treated as OFF. The
    // Config getter already gates on the flag; this re-check exists to
    // fail closed if that gate is ever refactored away, which it only
    // does if the absent case is off too.
    if (settings?.enabled !== true) return undefined;

    // Host match before name validation: a misconfigured header name
    // must not log on every outbound HTTPS request, only on the ones
    // actually destined for a host the user listed.
    const trusted = (settings.trustedHosts ?? []).some(
      (host) => host.trim().toLowerCase() === hostname,
    );
    if (!trusted) return undefined;

    const headerName = (settings.headerName ?? SESSION_ID_HEADER).trim();
    if (!VALID_HEADER_NAME.test(headerName)) {
      if (!warnedInvalidHeaderNames.has(headerName)) {
        warnedInvalidHeaderNames.add(headerName);
        debugLogger.warn(
          `Ignoring outboundCorrelation.sessionIdHeader.headerName "${headerName}": not a valid HTTP header name.`,
        );
      }
      return undefined;
    }
    return headerName;
  } catch (error) {
    debugLogger.warn(
      `Unable to resolve outboundCorrelation.sessionIdHeader: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

export function buildSessionIdHeaders(
  config: Config,
  destination: string | URL | Request,
): Record<string, string> {
  try {
    const url = requestUrl(destination);
    if (url?.protocol !== 'https:') {
      return {};
    }
    const hostname = url.hostname.toLowerCase();

    // Note: both allowlists are checked against the *initial* request
    // destination only. Standard fetch redirect behavior applies after
    // that, so a listed host can forward the header elsewhere by
    // redirecting — see the threat model in
    // docs/design/2026-09-03-outbound-session-id-header.md.
    const builtIn = SESSION_ID_HEADER_HOSTS.includes(hostname);
    const configuredHeader = configuredSessionHeaderName(config, hostname);

    if (!builtIn && configuredHeader === undefined) {
      return {};
    }
    const sessionId = config.getSessionId();
    if (!sessionId) {
      return {};
    }
    const headers: Record<string, string> = {};
    if (builtIn) {
      headers[SESSION_ID_HEADER] = sessionId;
    }
    // Header names are case-insensitive on the wire, so a configured
    // name that only differs in case from the built-in one would be the
    // same header — emit it once rather than as two record entries.
    if (
      configuredHeader !== undefined &&
      !(builtIn && configuredHeader.toLowerCase() === SESSION_ID_HEADER)
    ) {
      headers[configuredHeader] = sessionId;
    }
    return headers;
  } catch (error) {
    debugLogger.warn(
      `Unable to add ${SESSION_ID_HEADER} to outbound request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

export function wrapFetchWithSessionId<TFetch>(
  baseFetch: TFetch,
  config: Config,
): TFetch {
  const fetchLike = baseFetch as FetchLike;
  const wrapped: FetchLike = async (input, init) => {
    const sessionHeaders = buildSessionIdHeaders(config, input);
    const entries = Object.entries(sessionHeaders);
    if (entries.length === 0) return fetchLike(input, init);

    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    for (const [name, value] of entries) {
      headers.set(name, value);
    }
    return fetchLike(input, { ...init, headers });
  };

  return wrapped as TFetch;
}

export function buildSessionAwareFetch(
  runtimeFetch: unknown,
  config: Config,
): typeof globalThis.fetch {
  const baseFetch =
    (runtimeFetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch;
  return wrapFetchWithSessionId(baseFetch, config);
}

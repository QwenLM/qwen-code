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

    const builtIn = SESSION_ID_HEADER_HOSTS.includes(hostname);

    // User-configured branch (`outboundCorrelation.sessionIdHeader`):
    // exact-host allowlist, HTTPS only, disabled by default. `enabled`
    // is re-checked here even though the Config getter already gates on
    // it — this is a security-relevant send path, so it fails closed
    // against a settings object that says off. An invalid header name
    // skips this branch only — the built-in one still runs.
    const settings = config.getOutboundSessionIdHeaderSettings();
    let configuredHeader: string | undefined;
    if (settings && settings.enabled !== false) {
      const headerName = (settings.headerName ?? SESSION_ID_HEADER).trim();
      if (!VALID_HEADER_NAME.test(headerName)) {
        debugLogger.warn(
          `Ignoring outboundCorrelation.sessionIdHeader.headerName "${headerName}": not a valid HTTP header name.`,
        );
      } else {
        const trustedHosts = (settings.trustedHosts ?? [])
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host.length > 0);
        if (trustedHosts.includes(hostname)) {
          configuredHeader = headerName;
        }
      }
    }

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
    if (configuredHeader !== undefined) {
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

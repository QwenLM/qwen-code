/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { retryContext } from '../utils/retryContext.js';
import {
  applyDynamicHeaderValues,
  hasDynamicPlaceholder,
  warnIfDynamicHeadersDisabled,
} from './outbound-dynamic-headers.js';

const debugLogger = createDebugLogger('OUTBOUND_CORRELATION');

export const SESSION_ID_HEADER = 'session_id';
export const SESSION_ID_HEADER_HOSTS: readonly string[] = [
  'routify.alibaba-inc.com',
  'routify-online.alibaba-inc.com',
  'routify-pub.alibaba-inc.com',
];

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
    if (
      url?.protocol !== 'https:' ||
      !SESSION_ID_HEADER_HOSTS.includes(url.hostname.toLowerCase())
    ) {
      return {};
    }
    const sessionId = config.getSessionId();
    return sessionId ? { [SESSION_ID_HEADER]: sessionId } : {};
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
  customHeaders?: Record<string, string>,
): TFetch {
  const fetchLike = baseFetch as FetchLike;
  // Only providers with dynamic placeholders need to expand custom headers.
  const expandsHeaders = Object.values(customHeaders ?? {}).some(
    (value) => typeof value === 'string' && hasDynamicPlaceholder(value),
  );
  if (expandsHeaders) warnIfDynamicHeadersDisabled(customHeaders, config);
  const wrapped: FetchLike = async (input, init) => {
    const singleAttempt = retryContext.getStore()?.singleAttempt;
    const requestInit: RequestInit | undefined = singleAttempt
      ? { ...init, redirect: 'error' }
      : init;
    const sessionHeaders = buildSessionIdHeaders(config, input);
    const sessionId = sessionHeaders[SESSION_ID_HEADER];
    if (!sessionId && !expandsHeaders) return fetchLike(input, requestInit);

    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(requestInit?.headers).forEach((value, key) =>
      headers.set(key, value),
    );
    // Expand before the built-in header is written, so first-party
    // correlation still wins over anything the user configured — the
    // precedence documented for this wrapper (correlation > customHeaders).
    if (expandsHeaders) applyDynamicHeaderValues(headers, config);
    if (sessionId) headers.set(SESSION_ID_HEADER, sessionId);
    return fetchLike(input, { ...requestInit, headers });
  };

  return wrapped as TFetch;
}

export function buildSessionAwareFetch(
  runtimeFetch: unknown,
  config: Config,
  customHeaders?: Record<string, string>,
): typeof globalThis.fetch {
  const baseFetch =
    (runtimeFetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch;
  return wrapFetchWithSessionId(baseFetch, config, customHeaders);
}

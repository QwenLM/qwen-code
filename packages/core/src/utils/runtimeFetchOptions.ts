/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ProxyAgent, type Dispatcher } from 'undici';

import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('RUNTIME_FETCH');

/**
 * JavaScript runtime type
 */
export type Runtime = 'node' | 'bun' | 'unknown';

/**
 * Detect the current JavaScript runtime
 */
export function detectRuntime(): Runtime {
  if (typeof process !== 'undefined' && process.versions?.['bun']) {
    return 'bun';
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    return 'node';
  }
  return 'unknown';
}

/**
 * Runtime fetch options for OpenAI SDK
 */
export type OpenAIRuntimeFetchOptions =
  | {
      fetchOptions?: {
        dispatcher?: Dispatcher;
        timeout?: false;
      };
    }
  | undefined;

/**
 * Runtime fetch options for Anthropic SDK
 */
export type AnthropicRuntimeFetchOptions = {
  fetchOptions?: {
    dispatcher?: Dispatcher;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch?: any;
};

/**
 * SDK type identifier
 */
export type SDKType = 'openai' | 'anthropic';

/**
 * Build runtime-specific fetch options for OpenAI SDK
 */
export function buildRuntimeFetchOptions(
  sdkType: 'openai',
  proxyUrl?: string,
): OpenAIRuntimeFetchOptions;
/**
 * Build runtime-specific fetch options for Anthropic SDK
 */
export function buildRuntimeFetchOptions(
  sdkType: 'anthropic',
  proxyUrl?: string,
): AnthropicRuntimeFetchOptions;
/**
 * Build runtime-specific fetch options based on the detected runtime and SDK type
 * This function applies runtime-specific configurations to handle timeout differences
 * across Node.js and Bun, ensuring user-configured timeout works as expected.
 *
 * @param sdkType - The SDK type ('openai' or 'anthropic') to determine return type
 * @returns Runtime-specific options compatible with the specified SDK
 */
export function buildRuntimeFetchOptions(
  sdkType: SDKType,
  proxyUrl?: string,
): OpenAIRuntimeFetchOptions | AnthropicRuntimeFetchOptions {
  const runtime = detectRuntime();

  // When using a custom dispatcher (proxy mode), disable undici timeouts (set to 0)
  // to let SDK's timeout parameter control the total request time. This ensures
  // user-configured timeouts work as expected for long-running requests.
  // When no proxy is configured, the runtime's built-in fetch is used with its
  // default timeout behavior.

  switch (runtime) {
    case 'bun': {
      if (sdkType === 'openai') {
        // Bun: Disable built-in 300s timeout to let OpenAI SDK timeout control
        // This ensures user-configured timeout works as expected without interference
        return {
          fetchOptions: {
            timeout: false,
          },
        };
      } else {
        // Bun: Use custom fetch to disable built-in 300s timeout
        // This allows Anthropic SDK timeout to control the request
        // Note: Bun's fetch automatically uses proxy settings from environment variables
        // (HTTP_PROXY, HTTPS_PROXY, NO_PROXY), so proxy behavior is preserved
        const bunFetch: typeof fetch = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const bunFetchOptions: RequestInit = {
            ...init,
            // @ts-expect-error - Bun-specific timeout option
            timeout: false,
          };
          return fetch(input, bunFetchOptions);
        };
        return {
          fetch: bunFetch,
        };
      }
    }

    case 'node': {
      // Node.js: Use undici dispatcher for both SDKs.
      // This enables proxy support and disables undici timeouts so SDK timeout
      // controls the total request time.
      return buildFetchOptionsWithDispatcher(sdkType, proxyUrl);
    }

    default: {
      // Unknown runtime: treat as Node.js-like environment.
      return buildFetchOptionsWithDispatcher(sdkType, proxyUrl);
    }
  }
}

/**
 * Cache of shared dispatcher instances keyed by proxy URL.
 * Ensures preconnect and SDK clients share the same connection pool.
 */
const dispatcherCache = new Map<string, Dispatcher>();

/**
 * Proxy dispatcher creation failure counts keyed by sanitized host.
 */
const proxyFailureCounts = new Map<string, number>();

/**
 * Fallback return value when no custom dispatcher is used.
 * OpenAI SDK accepts `undefined` for fetchOptions to use runtime built-in fetch;
 * Anthropic SDK requires an empty object `{}`.
 */
const NO_DISPATCHER_FALLBACK = {
  openai: undefined,
  anthropic: {},
} as const;

/**
 * Get or create a shared undici dispatcher for the given proxy configuration.
 * The dispatcher is cached so that preconnect and subsequent SDK requests
 * share the same connection pool, enabling TCP+TLS connection reuse.
 *
 * @param proxyUrl - Proxy URL used to create a cached ProxyAgent
 * @returns A cached undici ProxyAgent dispatcher
 */
export function getOrCreateSharedDispatcher(proxyUrl: string): Dispatcher {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) {
    return cached;
  }

  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 60_000,
  });

  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Reset the dispatcher cache (for testing only)
 * @internal
 */
export function resetDispatcherCache(): void {
  dispatcherCache.clear();
  proxyFailureCounts.clear();
}

/**
 * Extract hostname (with port) from a proxy URL for deduplication.
 *
 * This function extracts just the host part from a proxy URL, removing any
 * credentials. This allows different credentials for the same host to be
 * logged separately when dispatcher creation fails, enabling administrators
 * to diagnose credential issues.
 *
 * Examples:
 * - `http://user:pass@proxy.example.com:8080` → `proxy.example.com:8080`
 * - `https://proxy.example.com:8080` → `proxy.example.com:8080`
 *
 * @param proxyUrl - Proxy URL that may contain credentials
 * @returns Hostname with port (credentials removed)
 */
export function extractHostnameFromProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.hostname) {
      return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    }
  } catch {
    // Fall through to the regex fallback below.
  }

  const match = proxyUrl.match(/@([^:/\s]+)(:\d+)?/);
  return match ? match[1] + (match[2] ?? '') : redactProxyCredentials(proxyUrl);
}

function hasPlausibleProxyPort(host: string): boolean {
  const portMatch = host.match(/:(\d{1,5})$/);
  if (!portMatch) {
    return false;
  }

  const port = Number(portMatch[1]);
  return port >= 80 && port <= 65535;
}

function hasLocalOrProxyLikeHost(host: string): boolean {
  const hostWithoutPort = host.replace(/:\d{1,5}$/, '').toLowerCase();
  if (hostWithoutPort === 'localhost') {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostWithoutPort)) {
    return true;
  }
  return hostWithoutPort
    .split(/[.-]/)
    .some((label) => /^(proxy|gateway|gw|squid)\d*$/.test(label));
}

function hasNetworkErrorContext(message: string, offset: number): boolean {
  const context = message.slice(Math.max(0, offset - 80), offset).toLowerCase();
  return /\b(connect|dispatcher|econnrefused|econnreset|enotfound|etimedout|proxy|tunnel)\b/.test(
    context,
  );
}

function shouldRedactTokenOnlyCredential(
  host: string,
  message: string,
  offset: number,
): boolean {
  return (
    hasPlausibleProxyPort(host) &&
    (hasLocalOrProxyLikeHost(host) || hasNetworkErrorContext(message, offset))
  );
}

/**
 * Redact proxy credentials from error messages to prevent credential leakage.
 *
 * Per RFC 3986, userinfo cannot contain unencoded '@', so `[^/\s]*` correctly
 * matches only the userinfo portion without over-consuming hostname or unrelated '@'.
 * The /g flag ensures all credential occurrences in multi-line error chains are redacted.
 *
 * Two patterns are supported:
 * - With scheme: `http://user:pass@proxy.local` → `http://<redacted>@proxy.local`
 * - Without scheme (Node.js native errors): `token@proxy.local:8080` → `<redacted>@proxy.local:8080`
 *
 * Scheme-less token-only credentials are only redacted when the host has a
 * plausible proxy port and either local/proxy-like host structure or nearby
 * network-error context. This avoids mangling email or SSH-like strings such
 * as `git@github.com:22` and `user@example.com:123`.
 *
 * @param message - Error message that may contain proxy URLs with credentials
 * @returns Message with all proxy credentials replaced by '<redacted>'
 */
export function redactProxyCredentials(message: string): string {
  // Primary: match URLs with scheme (http://user:pass@host or https://user:pass@host)
  let result = message.replace(/\/\/[^/\s]*@/g, '//<redacted>@');
  // Fallback: match bare credential patterns without scheme (e.g., Node.js
  // native errors). Redact password-bearing userinfo, or token-only userinfo
  // when the host has an explicit non-low port that looks like a proxy endpoint
  // rather than an SSH port or email line reference.
  result = result.replace(
    /(^|[\s([=:])([^\s/@()[\]=]+@[^@\s/()[\]=]+)/g,
    (
      match,
      prefix: string,
      candidate: string,
      offset: number,
      message: string,
    ) => {
      const atIndex = candidate.indexOf('@');
      const userInfo = candidate.slice(0, atIndex);
      const host = candidate.slice(atIndex + 1);

      if (
        !userInfo.includes(':') &&
        !shouldRedactTokenOnlyCredential(host, message, offset)
      ) {
        return match;
      }

      return `${prefix}<redacted>@${host}`;
    },
  );
  return result;
}

function recordProxyFailure(hostname: string): number {
  const failureCount = (proxyFailureCounts.get(hostname) ?? 0) + 1;
  proxyFailureCounts.set(hostname, failureCount);
  return failureCount;
}

function buildFetchOptionsWithDispatcher(
  sdkType: SDKType,
  proxyUrl?: string,
): OpenAIRuntimeFetchOptions | AnthropicRuntimeFetchOptions {
  // When no proxy is configured, skip the custom dispatcher and let the SDK
  // use the runtime's built-in fetch. This avoids version-mismatch issues
  // between the project's bundled undici and the Node.js built-in undici.
  // Re-verify compatibility if the bundled undici version changes.
  if (!proxyUrl) {
    return NO_DISPATCHER_FALLBACK[sdkType];
  }

  // Note: Without a custom dispatcher, Node.js built-in fetch uses its default
  // 300s bodyTimeout. This is sufficient for all current model streaming responses.
  try {
    const dispatcher = getOrCreateSharedDispatcher(proxyUrl);
    return { fetchOptions: { dispatcher } };
  } catch (error) {
    // Log dispatcher creation failure - requests will fallback to direct connection
    // bypassing the configured proxy. This is important for environments requiring
    // proxy for security controls (TLS inspection, traffic logging).
    // Log only the hostname (without credentials) to avoid credential leakage,
    // and do not deduplicate so that administrators can see each credential change
    // attempt's failure when debugging proxy issues.
    const hostname = extractHostnameFromProxyUrl(proxyUrl);
    const failureCount = recordProxyFailure(hostname);
    const failureLabel =
      failureCount === 1 ? 'first failure' : `failure #${failureCount}`;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const redactedMessage = redactProxyCredentials(errorMessage);
    const logMessage = `Failed to create proxy dispatcher for ${hostname} (${failureLabel}), falling back to direct connection: ${redactedMessage}`;
    debugLogger.warn(logMessage);
    // Dual logging: debugLogger writes to ~/.qwen/debug/ (for local debugging),
    // console.error writes to stderr (captured by container orchestrators and log aggregators).
    // This ensures visibility in production even when debug sessions are inactive.
    // eslint-disable-next-line no-console
    console.error(`[RUNTIME_FETCH] ${logMessage}`);
    return NO_DISPATCHER_FALLBACK[sdkType];
  }
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Agent, ProxyAgent, type Dispatcher } from 'undici';

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
 * Cache of shared dispatcher instances keyed by proxy URL (undefined = no proxy).
 * Ensures preconnect and SDK clients share the same connection pool.
 */
const dispatcherCache = new Map<string | undefined, Dispatcher>();

/**
 * Set of proxy URLs that have failed dispatcher creation.
 * Prevents duplicate error logging for the same broken proxy config.
 */
const rejectedProxyCache = new Set<string>();

/**
 * Get or create a shared undici dispatcher for the given proxy configuration.
 * The dispatcher is cached so that preconnect and subsequent SDK requests
 * share the same connection pool, enabling TCP+TLS connection reuse.
 *
 * @param proxyUrl - Optional proxy URL; undefined for direct connections
 * @returns A cached undici Dispatcher (Agent or ProxyAgent)
 */
export function getOrCreateSharedDispatcher(proxyUrl?: string): Dispatcher {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) {
    return cached;
  }

  const dispatcher = proxyUrl
    ? new ProxyAgent({
        uri: proxyUrl,
        headersTimeout: 0,
        bodyTimeout: 0,
        keepAliveTimeout: 60_000,
      })
    : new Agent({
        headersTimeout: 0,
        bodyTimeout: 0,
        keepAliveTimeout: 60_000,
      });

  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Reset the rejected proxy cache (for testing only)
 * @internal
 */
export function resetRejectedProxyCache(): void {
  rejectedProxyCache.clear();
}

/**
 * Reset the dispatcher cache (for testing only)
 * @internal
 */
export function resetDispatcherCache(): void {
  dispatcherCache.clear();
}

/**
 * Redact proxy credentials from error messages to prevent credential leakage.
 *
 * Per RFC 3986, userinfo cannot contain unencoded '@', so `[^/\s]*` correctly
 * matches only the userinfo portion without over-consuming hostname or unrelated '@'.
 * The /g flag ensures all credential occurrences in multi-line error chains are redacted.
 *
 * @param message - Error message that may contain proxy URLs with credentials
 * @returns Message with all proxy credentials replaced by '<redacted>'
 */
export function redactProxyCredentials(message: string): string {
  return message.replace(/\/\/[^/\s]*@/g, '//<redacted>@');
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
    return sdkType === 'openai' ? undefined : {};
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
    // Only log once per proxy URL to avoid duplicate warnings in long conversations.
    if (!rejectedProxyCache.has(proxyUrl)) {
      rejectedProxyCache.add(proxyUrl);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const redactedMessage = redactProxyCredentials(errorMessage);
      const logMessage = `Failed to create proxy dispatcher, falling back to direct connection: ${redactedMessage}`;
      debugLogger.warn(logMessage);
      // Dual logging: debugLogger writes to ~/.qwen/debug/ (for local debugging),
      // console.error writes to stderr (captured by container orchestrators and log aggregators).
      // This ensures visibility in production even when debug sessions are inactive.
      // eslint-disable-next-line no-console
      console.error(`[RUNTIME_FETCH] ${logMessage}`);
    }
    return sdkType === 'openai' ? undefined : {};
  }
}

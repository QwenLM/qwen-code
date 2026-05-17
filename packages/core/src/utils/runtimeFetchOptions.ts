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
      // Node.js: Use a custom undici dispatcher only when a proxy is configured.
      // Proxy dispatchers disable undici timeouts so SDK timeout controls the
      // total request time; no-proxy calls use the runtime's built-in fetch.
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

/**
 * Redact proxy credentials from thrown SDK errors in-place where possible.
 *
 * Preserving or cloning from the original error object keeps SDK-specific
 * fields such as status, code, and retry metadata intact while preventing
 * proxy credentials from leaking through message, stack, logs, or upstream
 * crash reports.
 *
 * @param error - Error-like value that may contain proxy credentials
 * @returns A redacted error value, reusing the original object when writable
 */
export function redactProxyError(error: unknown): unknown {
  return redactProxyErrorValue(error, new WeakMap<object, unknown>());
}

function redactProxyErrorValue(
  error: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof error === 'string') {
    return redactProxyCredentials(error);
  }

  if (!error || typeof error !== 'object') {
    return error;
  }

  if (seen.has(error)) {
    return seen.get(error);
  }

  const errorRecord = error as {
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const needsClone = shouldCloneForRedaction(error, errorRecord);
  const redactedMessage =
    typeof errorRecord.message === 'string'
      ? redactProxyCredentials(errorRecord.message)
      : undefined;
  const redactedStack =
    typeof errorRecord.stack === 'string'
      ? redactProxyCredentials(errorRecord.stack)
      : undefined;
  let redactedCause: unknown = errorRecord.cause;
  let redactedErrors: unknown = errorRecord.errors;

  if (needsClone) {
    const clone = Object.create(Object.getPrototypeOf(error));
    seen.set(error, clone);

    if (errorRecord.cause !== undefined) {
      redactedCause = redactProxyErrorValue(errorRecord.cause, seen);
    }
    if (errorRecord.errors !== undefined) {
      redactedErrors = redactProxyErrorCollection(errorRecord.errors, seen);
    }

    cloneErrorWithRedactedFields(
      error,
      clone,
      redactedMessage,
      redactedStack,
      redactedCause,
      redactedErrors,
    );
    return clone;
  }

  seen.set(error, error);

  try {
    if (redactedMessage !== undefined) {
      errorRecord.message = redactedMessage;
    }
    if (redactedStack !== undefined) {
      errorRecord.stack = redactedStack;
    }
    if (errorRecord.cause !== undefined) {
      redactedCause = redactProxyErrorValue(errorRecord.cause, seen);
      errorRecord.cause = redactedCause;
    }
    if (errorRecord.errors !== undefined) {
      redactedErrors = redactProxyErrorCollection(errorRecord.errors, seen);
      errorRecord.errors = redactedErrors;
    }
    return error;
  } catch {
    const clone = Object.create(Object.getPrototypeOf(error));
    seen.set(error, clone);
    if (errorRecord.cause !== undefined) {
      redactedCause = redactProxyErrorValue(errorRecord.cause, seen);
    }
    if (errorRecord.errors !== undefined) {
      redactedErrors = redactProxyErrorCollection(errorRecord.errors, seen);
    }
    cloneErrorWithRedactedFields(
      error,
      clone,
      redactedMessage,
      redactedStack,
      redactedCause,
      redactedErrors,
    );
    return clone;
  }
}

function redactProxyErrorCollection(
  errors: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (!Array.isArray(errors)) {
    return redactProxyErrorValue(errors, seen);
  }

  if (seen.has(errors)) {
    return seen.get(errors);
  }

  const redactedErrors: unknown[] = [];
  seen.set(errors, redactedErrors);
  for (const error of errors) {
    redactedErrors.push(redactProxyErrorValue(error, seen));
  }
  return redactedErrors;
}

function shouldCloneForRedaction(
  error: object,
  errorRecord: {
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
    errors?: unknown;
  },
): boolean {
  return (
    (typeof errorRecord.message === 'string' &&
      !canAssignProperty(error, 'message')) ||
    (typeof errorRecord.stack === 'string' &&
      !canAssignProperty(error, 'stack')) ||
    (errorRecord.cause !== undefined && !canAssignProperty(error, 'cause')) ||
    (errorRecord.errors !== undefined && !canAssignProperty(error, 'errors'))
  );
}

function canAssignProperty(target: object, key: PropertyKey): boolean {
  let current: object | null = target;

  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if ('writable' in descriptor) {
        return descriptor.writable === true;
      }
      return typeof descriptor.set === 'function';
    }
    current = Object.getPrototypeOf(current);
  }

  return Object.isExtensible(target);
}

function cloneErrorWithRedactedFields(
  error: object,
  clone: object,
  redactedMessage: string | undefined,
  redactedStack: string | undefined,
  redactedCause: unknown,
  redactedErrors: unknown,
): void {
  const copiedKeys = new Set<PropertyKey>();
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor) {
      continue;
    }

    copiedKeys.add(key);
    const updatedDescriptor = getRedactedPropertyDescriptor(
      key,
      descriptor,
      redactedMessage,
      redactedStack,
      redactedCause,
      redactedErrors,
    );

    try {
      Object.defineProperty(clone, key, updatedDescriptor);
    } catch {
      // Ignore non-critical metadata that cannot be copied.
    }
  }

  defineMissingRedactedValue(clone, copiedKeys, 'message', redactedMessage);
  defineMissingRedactedValue(clone, copiedKeys, 'stack', redactedStack);
  defineMissingRedactedValue(clone, copiedKeys, 'cause', redactedCause);
  defineMissingRedactedValue(clone, copiedKeys, 'errors', redactedErrors);
}

function getRedactedPropertyDescriptor(
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  redactedMessage: string | undefined,
  redactedStack: string | undefined,
  redactedCause: unknown,
  redactedErrors: unknown,
): PropertyDescriptor {
  const redactedValue =
    key === 'message'
      ? redactedMessage
      : key === 'stack'
        ? redactedStack
        : key === 'cause'
          ? redactedCause
          : key === 'errors'
            ? redactedErrors
            : undefined;

  if (redactedValue === undefined) {
    return { ...descriptor };
  }

  if ('value' in descriptor) {
    return { ...descriptor, value: redactedValue };
  }

  return {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    value: redactedValue,
    writable: true,
  };
}

function defineMissingRedactedValue(
  target: object,
  copiedKeys: Set<PropertyKey>,
  key: PropertyKey,
  value: unknown,
): void {
  if (value === undefined || copiedKeys.has(key)) {
    return;
  }

  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  } catch {
    // Ignore non-critical metadata that cannot be copied.
  }
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

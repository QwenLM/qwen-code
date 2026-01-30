/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Agent, ProxyAgent, type Dispatcher } from 'undici';

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

  // Always disable undici timeouts (set to 0) to let SDK's timeout parameter
  // control the total request time. bodyTimeout monitors intervals between data
  // chunks, headersTimeout waits for response headers, so we disable both to
  // ensure user-configured timeouts work as expected for long-running requests.

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

function buildFetchOptionsWithDispatcher(
  sdkType: SDKType,
  proxyUrl?: string,
): OpenAIRuntimeFetchOptions | AnthropicRuntimeFetchOptions {
  try {
    const dispatcher = proxyUrl
      ? new ProxyAgent({
          uri: proxyUrl,
          headersTimeout: 0,
          bodyTimeout: 0,
        })
      : new Agent({
          headersTimeout: 0,
          bodyTimeout: 0,
        });
    return { fetchOptions: { dispatcher } };
  } catch {
    return sdkType === 'openai' ? undefined : {};
  }
}

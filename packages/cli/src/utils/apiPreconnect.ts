/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API Preconnect - Warm API connections to reduce TCP+TLS handshake latency
 *
 * Principle: Fire a fire-and-forget HEAD request early in startup to warm
 * the TCP+TLS connection. Subsequent actual API calls reuse this connection,
 * saving 100-200ms.
 *
 * The preconnect uses the same shared undici dispatcher as the SDK clients,
 * ensuring the warmed TCP+TLS connection is reused by subsequent API calls.
 */

import {
  createDebugLogger,
  detectRuntime,
  getOrCreateSharedDispatcher,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('PRECONNECT');

let preconnectFired = false;

/**
 * Default API base URLs by AuthType
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
  'qwen-oauth': 'https://coding.dashscope.aliyuncs.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'vertex-ai': 'https://us-central1-aiplatform.googleapis.com',
};

/**
 * Check if preconnect should be skipped due to environment conditions
 */
function shouldSkipPreconnect(): boolean {
  // Skip for custom CA certificate (enterprise TLS inspection may interfere)
  if (process.env['NODE_EXTRA_CA_CERTS']) {
    debugLogger.debug('Skipping preconnect: custom CA certificate configured');
    return true;
  }

  return false;
}

/**
 * Check if running in sandbox mode
 * In sandbox mode, preconnect is ineffective because the process will restart
 */
function isInSandboxMode(): boolean {
  return process.env['SANDBOX'] !== undefined;
}

/**
 * Check if baseUrl is a default URL
 */
function isDefaultBaseUrl(baseUrl: string): boolean {
  const normalizedInput = baseUrl
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return Object.values(DEFAULT_BASE_URLS).some((defaultUrl) => {
    const normalizedDefault = defaultUrl
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    return (
      normalizedInput === normalizedDefault ||
      normalizedInput.startsWith(normalizedDefault + '/')
    );
  });
}

/**
 * Get the target URL for preconnect.
 * Uses the already-resolved base URL from the model config, falling back
 * to default URLs by authType.
 *
 * Only preconnects to known default URLs — custom URLs may not accept HEAD
 * requests or may require mTLS / private deployment configurations.
 */
function getPreconnectTargetUrl(
  authType: string | undefined,
  resolvedBaseUrl: string | undefined,
): string | undefined {
  // 1. Use the resolved base URL from model config (already incorporates
  //    modelProviders > cli > env > settings priority chain)
  if (resolvedBaseUrl) {
    if (isDefaultBaseUrl(resolvedBaseUrl)) {
      return resolvedBaseUrl;
    }
    debugLogger.debug(
      'Skipping preconnect: resolved baseUrl is not a default URL',
    );
    return undefined;
  }

  // 2. Fall back to default value by authType
  if (authType && DEFAULT_BASE_URLS[authType]) {
    return DEFAULT_BASE_URLS[authType];
  }

  return undefined;
}

/**
 * Execute API preconnect
 * Use HEAD request to establish TCP+TLS connection without sending actual request body.
 * Uses the shared undici dispatcher to ensure connection pool is shared with SDK clients.
 *
 * @param authType - Authentication type (openai, qwen-oauth, anthropic, etc.)
 * @param options - Configuration options
 */
export function preconnectApi(
  authType: string | undefined,
  options: {
    resolvedBaseUrl?: string;
    proxy?: string;
  } = {},
): void {
  if (preconnectFired) {
    return;
  }
  preconnectFired = true;

  // Check if disabled
  if (process.env['QWEN_CODE_DISABLE_PRECONNECT'] === '1') {
    debugLogger.debug('Preconnect disabled by environment variable');
    return;
  }

  // Check if in sandbox mode (process will restart, preconnect is ineffective)
  if (isInSandboxMode()) {
    debugLogger.debug('Skipping preconnect: sandbox mode detected');
    return;
  }

  // Check environment skip conditions (custom CA)
  if (shouldSkipPreconnect()) {
    return;
  }

  // Skip on non-Node runtimes (e.g. Bun) — they use independent connection
  // pools, so warming undici's pool provides no benefit.
  if (detectRuntime() !== 'node') {
    debugLogger.debug('Skipping preconnect: unsupported runtime');
    return;
  }

  const targetUrl = getPreconnectTargetUrl(authType, options.resolvedBaseUrl);

  if (!targetUrl) {
    debugLogger.debug('No target URL for preconnect');
    return;
  }

  debugLogger.debug(`Preconnecting to: ${targetUrl}`);

  // Build fetch options with shared dispatcher for connection pool reuse.
  // On Node.js, use the same undici dispatcher that SDK clients will use,
  // so the warmed TCP+TLS connection is reused by subsequent API calls.
  const dispatcherOptions: Record<string, unknown> =
    detectRuntime() === 'node'
      ? { dispatcher: getOrCreateSharedDispatcher(options.proxy) }
      : {};

  // Fire HEAD request to warm connection (fire-and-forget)
  fetch(targetUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(5_000),
    // Don't send any authentication info
    headers: {
      'User-Agent': 'QwenCode-Preconnect/1.0',
    },
    ...dispatcherOptions,
  })
    .then(() => {
      debugLogger.debug('Preconnect completed');
    })
    .catch((error) => {
      // Preconnect failure doesn't affect main flow
      debugLogger.debug(`Preconnect failed (ignored): ${error}`);
    });
}

/**
 * Reset preconnect state (for testing only)
 * @internal
 */
export function resetPreconnectState(): void {
  preconnectFired = false;
}

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
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';

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
 * Check if preconnect should be skipped
 */
function shouldSkipPreconnect(settings: { baseUrl?: string }): boolean {
  // 1. Check proxy environment variables
  // Note: If NO_PROXY is set and target URL is in it, we don't need to skip
  // But for simplicity: skip if any proxy config is present
  if (
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  ) {
    debugLogger.debug('Skipping preconnect: proxy environment variable set');
    return true;
  }

  // 2. Check custom CA certificate (may use enterprise TLS inspection)
  if (process.env['NODE_EXTRA_CA_CERTS']) {
    debugLogger.debug('Skipping preconnect: custom CA certificate configured');
    return true;
  }

  // 3. User explicitly configured custom baseUrl (may use mTLS or private deployment)
  if (settings.baseUrl && !isDefaultBaseUrl(settings.baseUrl)) {
    debugLogger.debug(
      'Skipping preconnect: custom baseUrl (may use mTLS or private deployment)',
    );
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
  const normalized = baseUrl.toLowerCase().replace(/\/+$/, '');
  return Object.values(DEFAULT_BASE_URLS).some((url) =>
    normalized.startsWith(url.toLowerCase()),
  );
}

/**
 * Environment variable to AuthType mapping
 */
const ENV_BASE_URL_MAP: Record<string, string> = {
  OPENAI_BASE_URL: 'openai',
  ANTHROPIC_BASE_URL: 'anthropic',
  GEMINI_BASE_URL: 'gemini',
};

/**
 * Get environment variable baseUrl for the given authType
 */
function getEnvBaseUrlForAuthType(
  authType: string | undefined,
): string | undefined {
  if (!authType) {
    return undefined;
  }

  // Lookup the corresponding environment variable based on authType
  for (const [envVar, mappedAuthType] of Object.entries(ENV_BASE_URL_MAP)) {
    if (mappedAuthType === authType) {
      return process.env[envVar];
    }
  }

  return undefined;
}

/**
 * Get the target URL for preconnect
 * Priority: settingsBaseUrl > environment variable > default value
 *
 * If custom baseUrl is set (non-default URL), return undefined to skip preconnect
 */
function getPreconnectTargetUrl(
  authType: string | undefined,
  settingsBaseUrl: string | undefined,
): string | undefined {
  // 1. Get from settings
  if (settingsBaseUrl) {
    // If it's a default URL, use it; otherwise skip
    if (isDefaultBaseUrl(settingsBaseUrl)) {
      return settingsBaseUrl;
    }
    return undefined;
  }

  // 2. Get from environment variable (lookup based on authType)
  const envBaseUrl = getEnvBaseUrlForAuthType(authType);
  if (envBaseUrl) {
    // If it's a default URL, use it; otherwise skip
    if (isDefaultBaseUrl(envBaseUrl)) {
      return envBaseUrl;
    }
    return undefined;
  }

  // 3. Use default value
  if (authType && DEFAULT_BASE_URLS[authType]) {
    return DEFAULT_BASE_URLS[authType];
  }

  return undefined;
}

/**
 * Execute API preconnect
 * Use HEAD request to establish TCP+TLS connection without sending actual request body
 *
 * @param authType - Authentication type (openai, qwen-oauth, anthropic, etc.)
 * @param options - Configuration options
 */
export function preconnectApi(
  authType: string | undefined,
  options: {
    settingsBaseUrl?: string;
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

  // Check skip conditions
  if (
    shouldSkipPreconnect({
      baseUrl: options.settingsBaseUrl,
    })
  ) {
    return;
  }

  const targetUrl = getPreconnectTargetUrl(authType, options.settingsBaseUrl);

  if (!targetUrl) {
    debugLogger.debug('No target URL for preconnect');
    return;
  }

  debugLogger.debug(`Preconnecting to: ${targetUrl}`);

  // Use AbortSignal.timeout to prevent long blocking
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  // Fire HEAD request to warm connection (fire-and-forget)
  fetch(targetUrl, {
    method: 'HEAD',
    signal: controller.signal,
    // Don't send any authentication info
    headers: {
      'User-Agent': 'QwenCode-Preconnect/1.0',
    },
  })
    .then(() => {
      clearTimeout(timeoutId);
      debugLogger.debug('Preconnect completed');
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      // Preconnect failure doesn't affect main flow
      debugLogger.debug(`Preconnect failed (ignored): ${error}`);
    });
}

/**
 * Reset preconnect state (for testing only)
 */
export function resetPreconnectState(): void {
  preconnectFired = false;
}

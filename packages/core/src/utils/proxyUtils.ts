/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalizes a proxy URL to ensure it has a valid protocol prefix.
 *
 * Many proxy tools and environment variables provide proxy addresses without
 * a protocol prefix (e.g., "127.0.0.1:7860" instead of "http://127.0.0.1:7860").
 * This function adds the "http://" prefix if missing, since HTTP proxies are
 * the most common default.
 *
 * Note: Only HTTP and HTTPS proxies are supported. SOCKS proxies (socks://,
 * socks4://, socks5://) are NOT supported because the underlying undici library
 * does not support them. See: https://github.com/nodejs/undici/issues/2224
 *
 * @param proxyUrl - The proxy URL to normalize
 * @returns The normalized proxy URL with protocol prefix, or undefined if input is undefined/empty
 * @throws Error if a SOCKS proxy URL is provided
 */
export function normalizeProxyUrl(
  proxyUrl: string | undefined,
): string | undefined {
  if (!proxyUrl) {
    return undefined;
  }

  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  // Check if the URL already has a protocol prefix
  // Only support http and https protocols (undici limitation)
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Reject SOCKS proxies - undici does not support them
  if (/^socks[45]?:\/\//i.test(trimmed)) {
    throw new Error(
      `SOCKS proxy is not supported. The underlying HTTP client (undici) only supports HTTP and HTTPS proxies. ` +
        `Please use an HTTP/HTTPS proxy instead, or set up a SOCKS-to-HTTP proxy converter. ` +
        `See: https://github.com/nodejs/undici/issues/2224`,
    );
  }

  // Add http:// prefix for proxy URLs without protocol
  // HTTP is the default for most proxy configurations
  return `http://${trimmed}`;
}

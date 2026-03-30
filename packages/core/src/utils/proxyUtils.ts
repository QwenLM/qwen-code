/**
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
 * @param proxyUrl - The proxy URL to normalize
 * @returns The normalized proxy URL with protocol prefix, or undefined if input is undefined/empty
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
  // Support http, https, socks, socks4, socks5 protocols
  if (/^(https?|socks[45]?):\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Add http:// prefix for proxy URLs without protocol
  // HTTP is the default for most proxy configurations
  return `http://${trimmed}`;
}

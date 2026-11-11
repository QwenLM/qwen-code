/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks5:',
  'socks5h:',
]);

export function normalizeProxyUrl(proxy: string): string {
  const trimmed = proxy.trim();
  const url = new URL(trimmed);

  if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new TypeError(
      'proxy must use http://, https://, socks://, socks5://, or socks5h://',
    );
  }

  if (!url.hostname) {
    throw new TypeError('proxy must include a host');
  }

  if (url.protocol !== 'socks5h:') {
    return trimmed;
  }

  return `socks5:${trimmed.slice(trimmed.indexOf(':') + 1)}`;
}

export function normalizeProxyUrlIfSupported(
  proxy: string | undefined,
): string | undefined {
  if (!proxy) {
    return undefined;
  }

  try {
    return normalizeProxyUrl(proxy);
  } catch {
    return undefined;
  }
}

/** Return a proxy URL that is safe to persist in diagnostic logs. */
export function redactProxyUrl(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[invalid proxy]';
  }
}

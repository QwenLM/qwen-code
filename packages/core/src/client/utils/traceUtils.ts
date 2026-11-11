/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ParsedUrlParts {
  origin?: string;
  pathname?: string;
  host: string;
  traceAttributes: Record<string, string>;
}

export function parseUrlParts(url: string): ParsedUrlParts {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname,
      host: parsed.host,
      traceAttributes: {
        'url.scheme': parsed.protocol.replace(/:$/, ''),
        'server.address': parsed.hostname,
        'url.path': parsed.pathname,
      },
    };
  } catch {
    return { host: url, traceAttributes: {} };
  }
}

/**
 * The log/telemetry-safe request url: origin + pure path, deliberately omitting
 * the query so credentials carried in query params never reach persistent logs
 * or error telemetry. Falls back to the bare path (or a sentinel) when the url
 * cannot be parsed into an origin.
 */
export function getRequestLogUrl(
  urlParts: ParsedUrlParts,
  requestPath: string,
): string {
  if (!urlParts.origin) return requestPath || '<invalid-url>';
  return `${urlParts.origin}${requestPath || urlParts.pathname || ''}`;
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leaf module for OTLP HTTP URL resolution (issue #4748).
 *
 * Kept free of `@opentelemetry/*` and any telemetry SDK dependency so both the
 * light facade (`sdk.ts`) and the heavy implementation (`sdk-impl.ts`) can
 * import it without forming a cycle between them.
 */

/**
 * Standard OTLP HTTP signal-specific paths per the OpenTelemetry specification.
 * gRPC uses service-based routing so no path appending is needed.
 */
const OTLP_SIGNAL_PATHS = {
  traces: 'v1/traces',
  logs: 'v1/logs',
  metrics: 'v1/metrics',
} as const;

export type OtlpSignal = keyof typeof OTLP_SIGNAL_PATHS;

/**
 * Resolve the final URL for an HTTP OTLP exporter.
 *
 * - If the URL path already ends with the signal-specific path (e.g., /v1/traces),
 *   use it as-is. This supports explicit full-path configuration.
 * - Otherwise, append the signal-specific path to the base URL.
 */
export function resolveHttpOtlpUrl(
  baseEndpoint: string,
  signal: OtlpSignal,
): string {
  const signalPath = OTLP_SIGNAL_PATHS[signal];
  const url = new URL(baseEndpoint);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (normalizedPath.endsWith(signalPath)) {
    return url.href;
  }
  // Append the signal path to the URL pathname, preserving query/hash.
  url.pathname = normalizedPath + '/' + signalPath;
  return url.href;
}

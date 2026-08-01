/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared logic for the esbuild plugin that stubs the OTLP exporter packages
 * `@opentelemetry/sdk-node` eagerly require()s for env-based auto-configuration
 * (issue #7264). Extracted from esbuild.config.js so the resolve decision — the
 * security-critical part that keeps both protocol chains out of the sdk-impl
 * static closure — is unit-testable without running a full bundle.
 */

// Exporter packages sdk-node eagerly require()s: the three OTLP signals across
// grpc/http/proto transports, plus zipkin and prometheus.
export const SDK_NODE_STUBBED_EXPORTERS = new RegExp(
  '^@opentelemetry/(' +
    [
      'exporter-trace-otlp-(grpc|http|proto)',
      'exporter-logs-otlp-(grpc|http|proto)',
      'exporter-metrics-otlp-(grpc|http|proto)',
      'exporter-zipkin',
      'exporter-prometheus',
    ].join('|') +
    ')$',
);

/**
 * Decide whether an esbuild import should resolve to the loud stub.
 *
 * True only when a stubbed exporter package is imported *by sdk-node itself* —
 * our own protocol modules keep resolving the real packages. The importer path
 * is normalized to forward slashes so the match holds on Windows (where esbuild
 * emits backslash-separated paths) as well as POSIX.
 */
export function isStubbedSdkNodeExporterImport(importPath, importer) {
  if (!SDK_NODE_STUBBED_EXPORTERS.test(importPath)) return false;
  if (typeof importer !== 'string' || importer.length === 0) return false;
  const normalizedImporter = importer.replace(/\\/g, '/');
  return normalizedImporter.includes('@opentelemetry/sdk-node');
}

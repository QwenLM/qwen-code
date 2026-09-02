/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTLP gRPC exporter chain (issue #7264, follow-up to #4748).
 *
 * Owns the gRPC protocol dependencies — @grpc/grpc-js, @grpc/proto-loader,
 * and protobufjs (~1.1 MiB bundled). It must only ever be loaded via the
 * dynamic `import()` in `sdk-impl.ts#startTelemetrySdk`, so telemetry-enabled
 * processes using the HTTP or file exporters skip the gRPC cluster entirely.
 * Do not import this module statically; `scripts/check-serve-fast-path-bundle.js`
 * guards the sdk-impl static closure against regressions.
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export interface GrpcExporters {
  spanExporter: OTLPTraceExporter;
  logExporter: OTLPLogExporter;
  metricReader: PeriodicExportingMetricReader;
}

export function createGrpcExporters(endpoint: string): GrpcExporters {
  return {
    spanExporter: new OTLPTraceExporter({
      url: endpoint,
      compression: CompressionAlgorithm.GZIP,
    }),
    logExporter: new OTLPLogExporter({
      url: endpoint,
      compression: CompressionAlgorithm.GZIP,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: endpoint,
        compression: CompressionAlgorithm.GZIP,
      }),
      exportIntervalMillis: 10000,
    }),
  };
}

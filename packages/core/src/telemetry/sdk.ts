/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { Metadata } from '@grpc/grpc-js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { LogRecord } from '@opentelemetry/sdk-logs';
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ExportResult } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Config } from '../config/config.js';
import { SERVICE_NAME } from './constants.js';
import { initializeMetrics } from './metrics.js';

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

let sdk: NodeSDK | undefined;
let telemetryInitialized = false;

export function isTelemetrySdkInitialized(): boolean {
  return telemetryInitialized;
}

function parseGrpcEndpoint(
  otlpEndpointSetting: string | undefined,
): string | undefined {
  if (!otlpEndpointSetting) {
    return undefined;
  }
  // Trim leading/trailing quotes that might come from env variables
  const trimmedEndpoint = otlpEndpointSetting.replace(/^["']|["']$/g, '');

  try {
    const url = new URL(trimmedEndpoint);
    // OTLP gRPC exporters expect an endpoint in the format scheme://host:port
    // The `origin` property provides this, stripping any path, query, or hash.
    return url.origin;
  } catch (error) {
    diag.error('Invalid OTLP endpoint URL provided:', trimmedEndpoint, error);
    return undefined;
  }
}

export function initializeTelemetry(config: Config): void {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return;
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]: process.version,
    'session.id': config.getSessionId(),
  });

  const otlpEndpoint = config.getTelemetryOtlpEndpoint();
  const grpcParsedEndpoint = parseGrpcEndpoint(otlpEndpoint);
  const useOtlp = !!grpcParsedEndpoint;

  const metadata = new Metadata();
  metadata.set(
    'Authentication',
    'gb4w8c3ygj@0c2aed5f1449f6f_gb4w8c3ygj@53df7ad2afe8301',
  );

  const spanExporter = useOtlp
    ? new OTLPTraceExporter({
        url: grpcParsedEndpoint,
        compression: CompressionAlgorithm.GZIP,
        metadata,
      })
    : {
        export: (
          spans: ReadableSpan[],
          callback: (result: ExportResult) => void,
        ) => callback({ code: 0 }),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      };

  // FIXME: Temporarily disable OTLP log export due to gRPC endpoint not supporting LogsService
  // const logExporter = useOtlp
  //   ? new OTLPLogExporter({
  //       url: grpcParsedEndpoint,
  //       compression: CompressionAlgorithm.GZIP,
  //       metadata: _metadata,
  //     })
  //   : new ConsoleLogRecordExporter();

  // Create a no-op log exporter to avoid cluttering console output
  const logExporter = {
    export: (logs: LogRecord[], callback: (result: ExportResult) => void) =>
      callback({ code: 0 }),
    shutdown: () => Promise.resolve(),
  };
  const metricReader = useOtlp
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: grpcParsedEndpoint,
          compression: CompressionAlgorithm.GZIP,
          metadata,
        }),
        exportIntervalMillis: 10000,
      })
    : new PeriodicExportingMetricReader({
        exporter: {
          export: (
            metrics: ResourceMetrics,
            callback: (result: ExportResult) => void,
          ) => callback({ code: 0 }),
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
        exportIntervalMillis: 10000,
      });

  sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(spanExporter)],
    logRecordProcessor: new BatchLogRecordProcessor(logExporter),
    metricReader,
    instrumentations: [new HttpInstrumentation()],
  });

  try {
    sdk.start();
    console.log('OpenTelemetry SDK started successfully.');
    telemetryInitialized = true;
    initializeMetrics(config);
  } catch (error) {
    console.error('Error starting OpenTelemetry SDK:', error);
  }

  process.on('SIGTERM', shutdownTelemetry);
  process.on('SIGINT', shutdownTelemetry);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!telemetryInitialized || !sdk) {
    return;
  }
  try {
    // ClearcutLogger.getInstance()?.shutdown();
    await sdk.shutdown();
    console.log('OpenTelemetry SDK shut down successfully.');
  } catch (error) {
    console.error('Error shutting down SDK:', error);
  } finally {
    telemetryInitialized = false;
  }
}

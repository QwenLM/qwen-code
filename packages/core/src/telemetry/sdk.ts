/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import type { DiagLogger } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import type { Config } from '../config/config.js';
import { SERVICE_NAME } from './constants.js';
import { initializeMetrics } from './metrics.js';
import {
  FileLogExporter,
  FileMetricExporter,
  FileSpanExporter,
} from './file-exporters.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { LogToSpanProcessor } from './log-to-span-processor.js';
import { createSessionRootContext } from './tracer.js';
import { setSessionContext } from './session-context.js';
import { endInteractionSpan } from './session-tracing.js';

function createTelemetryDiagLogger(): DiagLogger {
  const debugLogger = createDebugLogger('OTEL');
  return {
    error: (message, ...args) => debugLogger.error(message, ...args),
    warn: (message, ...args) => debugLogger.warn(message, ...args),
    info: (message, ...args) => debugLogger.info(message, ...args),
    debug: (message, ...args) => debugLogger.debug(message, ...args),
    verbose: (message, ...args) => debugLogger.debug(message, ...args),
  };
}

// For troubleshooting, set the log level to DiagLogLevel.DEBUG.
// OTel SDK diagnostics must not write to console because console output can be
// surfaced in user-visible UI. Keep diagnostics in the debug log instead.
diag.setLogger(createTelemetryDiagLogger(), DiagLogLevel.WARN);

/**
 * Standard OTLP HTTP signal-specific paths per the OpenTelemetry specification.
 * gRPC uses service-based routing so no path appending is needed.
 */
const OTLP_SIGNAL_PATHS = {
  traces: 'v1/traces',
  logs: 'v1/logs',
  metrics: 'v1/metrics',
} as const;

type OtlpSignal = keyof typeof OTLP_SIGNAL_PATHS;

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

// Ceiling for sdk.shutdown() when called directly (e.g. non-interactive mode).
// In interactive mode, runExitCleanup() imposes its own tighter per-function
// (2s) and overall (5s) timeouts, so this value is effectively unreachable there.
const SHUTDOWN_TIMEOUT_MS = 10_000;

let sdk: NodeSDK | undefined;
let telemetryInitialized = false;
let telemetryShutdownPromise: Promise<void> | undefined;

export function isTelemetrySdkInitialized(): boolean {
  return telemetryInitialized;
}

function parseOtlpEndpoint(
  otlpEndpointSetting: string | undefined,
  protocol: 'grpc' | 'http',
): string | undefined {
  if (!otlpEndpointSetting) {
    return undefined;
  }
  // Trim leading/trailing quotes that might come from env variables
  const trimmedEndpoint = otlpEndpointSetting.replace(/^["']|["']$/g, '');

  try {
    const url = new URL(trimmedEndpoint);
    if (protocol === 'grpc') {
      // OTLP gRPC exporters expect an endpoint in the format scheme://host:port
      // The `origin` property provides this, stripping any path, query, or hash.
      return url.origin;
    }
    // For http, use the full href.
    return url.href;
  } catch (error) {
    diag.error('Invalid OTLP endpoint URL provided:', trimmedEndpoint, error);
    return undefined;
  }
}

/**
 * Validate a URL string. Returns the URL if valid http(s), undefined otherwise.
 * Logs an error for invalid URLs instead of throwing.
 */
function validateUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      diag.error(
        `OTLP endpoint must use http or https, got ${parsed.protocol}`,
      );
      return undefined;
    }
    if (!parsed.hostname) {
      diag.error('OTLP endpoint missing hostname');
      return undefined;
    }
    return url;
  } catch {
    diag.error('Invalid OTLP signal endpoint URL, skipping:', url);
    return undefined;
  }
}

export function initializeTelemetry(config: Config): void {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return;
  }

  const debugLogger = createDebugLogger('OTEL');
  const resource = resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]:
      config.getCliVersion() || 'unknown',
    'session.id': config.getSessionId(),
  });

  const otlpEndpoint = config.getTelemetryOtlpEndpoint();
  const otlpProtocol = config.getTelemetryOtlpProtocol();
  const parsedEndpoint = parseOtlpEndpoint(otlpEndpoint, otlpProtocol);
  const telemetryOutfile = config.getTelemetryOutfile();
  const hasPerSignalEndpoint =
    !!config.getTelemetryOtlpTracesEndpoint() ||
    !!config.getTelemetryOtlpLogsEndpoint() ||
    !!config.getTelemetryOtlpMetricsEndpoint();
  const useOtlp =
    (!!parsedEndpoint || hasPerSignalEndpoint) && !telemetryOutfile;

  let spanExporter:
    | OTLPTraceExporter
    | OTLPTraceExporterHttp
    | FileSpanExporter
    | undefined;
  let logExporter:
    | OTLPLogExporter
    | OTLPLogExporterHttp
    | FileLogExporter
    | undefined;
  let metricReader: PeriodicExportingMetricReader | undefined;
  let logToSpanProcessor: LogToSpanProcessor | undefined;

  if (useOtlp) {
    if (otlpProtocol === 'http') {
      const tracesUrl = validateUrl(
        config.getTelemetryOtlpTracesEndpoint() ??
          (parsedEndpoint
            ? resolveHttpOtlpUrl(parsedEndpoint, 'traces')
            : undefined),
      );
      const logsUrl = validateUrl(
        config.getTelemetryOtlpLogsEndpoint() ??
          (parsedEndpoint
            ? resolveHttpOtlpUrl(parsedEndpoint, 'logs')
            : undefined),
      );
      const metricsUrl = validateUrl(
        config.getTelemetryOtlpMetricsEndpoint() ??
          (parsedEndpoint
            ? resolveHttpOtlpUrl(parsedEndpoint, 'metrics')
            : undefined),
      );

      debugLogger.debug(
        `OTLP HTTP endpoints: traces=${tracesUrl ?? 'none'}, logs=${logsUrl ?? 'none'}, metrics=${metricsUrl ?? 'none'}`,
      );

      if (tracesUrl) {
        spanExporter = new OTLPTraceExporterHttp({ url: tracesUrl });
      }
      if (logsUrl) {
        logExporter = new OTLPLogExporterHttp({ url: logsUrl });
      } else if (tracesUrl) {
        // Bridge: no logs endpoint but traces endpoint exists.
        // Convert log records to spans. Use a dedicated trace exporter so the
        // bridge owns its own forceFlush/shutdown lifecycle.
        logToSpanProcessor = new LogToSpanProcessor(
          new OTLPTraceExporterHttp({ url: tracesUrl }),
          {
            includeSensitiveSpanAttributes:
              config.getTelemetryIncludeSensitiveSpanAttributes(),
          },
        );
      }
      if (metricsUrl) {
        metricReader = new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporterHttp({ url: metricsUrl }),
          exportIntervalMillis: 10000,
        });
      }
    } else {
      // grpc — per-signal endpoints are not supported with gRPC protocol.
      if (!parsedEndpoint) {
        const warning =
          'Per-signal OTLP endpoints are only supported with HTTP protocol. ' +
          'Set otlpProtocol to "http" or provide a base otlpEndpoint for gRPC. ' +
          'Telemetry SDK startup was skipped because no supported gRPC endpoint was configured.';
        diag.warn(warning);
        debugLogger.warn(warning);
        return;
      } else {
        spanExporter = new OTLPTraceExporter({
          url: parsedEndpoint,
          compression: CompressionAlgorithm.GZIP,
        });
        logExporter = new OTLPLogExporter({
          url: parsedEndpoint,
          compression: CompressionAlgorithm.GZIP,
        });
        metricReader = new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: parsedEndpoint,
            compression: CompressionAlgorithm.GZIP,
          }),
          exportIntervalMillis: 10000,
        });
      }
    }
  } else if (telemetryOutfile) {
    spanExporter = new FileSpanExporter(telemetryOutfile);
    logExporter = new FileLogExporter(telemetryOutfile);
    metricReader = new PeriodicExportingMetricReader({
      exporter: new FileMetricExporter(telemetryOutfile),
      exportIntervalMillis: 10000,
    });
  }
  // If no exporter is configured for a signal, it is silently skipped.

  sdk = new NodeSDK({
    resource,
    // Disable async host/process/env resource detectors: they leave attributes
    // pending and trigger an OTel diag.error on any resource attribute read
    // before the detectors settle (e.g. during HttpInstrumentation span creation).
    autoDetectResources: false,
    spanProcessors: spanExporter ? [new BatchSpanProcessor(spanExporter)] : [],
    logRecordProcessors: logExporter
      ? [new BatchLogRecordProcessor(logExporter)]
      : logToSpanProcessor
        ? [logToSpanProcessor]
        : [],
    ...(metricReader && { metricReader }),
    instrumentations: [new HttpInstrumentation()],
  });

  try {
    sdk.start();
    debugLogger.debug('OpenTelemetry SDK started successfully.');
    telemetryInitialized = true;
    const sessionId = config.getSessionId();
    setSessionContext(createSessionRootContext(sessionId), sessionId);
    initializeMetrics(config);
  } catch (error) {
    debugLogger.error('Error starting OpenTelemetry SDK:', error);
  }
}

/**
 * Refresh the session root context with a new session ID.
 * Must be called whenever the session changes (e.g. /clear, /resume)
 * so that new spans inherit the correct traceId.
 */
export function refreshSessionContext(sessionId: string): void {
  if (!telemetryInitialized) return;
  try {
    setSessionContext(createSessionRootContext(sessionId), sessionId);
  } catch (error) {
    createDebugLogger('OTEL').warn('Failed to refresh session context:', error);
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (telemetryShutdownPromise) {
    return telemetryShutdownPromise;
  }
  if (!telemetryInitialized || !sdk) {
    return;
  }
  endInteractionSpan('cancelled');
  const currentSdk = sdk;
  const debugLogger = createDebugLogger('OTEL');
  telemetryShutdownPromise = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      // Wrap in Promise.resolve for safety — auto-mocked shutdown()
      // may return undefined in test environments.
      const sdkShutdown = Promise.resolve(currentSdk.shutdown());
      // Prevent unhandled rejection if sdk.shutdown() rejects after the
      // timeout wins the race — the process is exiting anyway.
      // Only log when the timeout actually won; otherwise the catch block
      // below handles the rejection with full diag.error logging.
      sdkShutdown.catch((err) => {
        if (timedOut) {
          debugLogger.warn(
            'SDK shutdown rejected after timeout:',
            err instanceof Error ? err.message : err,
          );
        }
        // If not timed out, the rejection will be caught by the
        // try/catch below via the Promise.race await.
      });
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([sdkShutdown, timeout]);
      clearTimeout(timer);
      if (result === 'timeout') {
        const msg = `Telemetry shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms.`;
        diag.warn(msg);
        debugLogger.warn(msg);
      } else {
        debugLogger.debug('OpenTelemetry SDK shut down successfully.');
      }
    } catch (error) {
      clearTimeout(timer);
      diag.error('Error shutting down SDK:', error);
      debugLogger.error('Error shutting down SDK:', error);
    } finally {
      telemetryInitialized = false;
      sdk = undefined;
      telemetryShutdownPromise = undefined;
      setSessionContext(undefined);
    }
  })();
  return telemetryShutdownPromise;
}

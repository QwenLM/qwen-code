/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Light facade of the telemetry SDK split (issue #4748).
 *
 * Hot-path modules (`loggers.ts`, `session-tracing.ts`) statically gate every
 * telemetry call on `isTelemetrySdkInitialized()`, so this module must stay
 * cheap: its only runtime `@opentelemetry/*` dependency is `@opentelemetry/api`.
 * All heavy SDK assembly (NodeSDK, instrumentations, and — one level further
 * down, per configured protocol — the OTLP exporter chains) lives in
 * `sdk-impl.ts` and is loaded via dynamic `import()` only when telemetry is
 * actually enabled.
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import type { DiagLogger } from '@opentelemetry/api';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { TelemetryRuntimeConfig } from './runtime-config.js';
import { initializeMetrics } from './metrics.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { createSessionRootContext } from './tracer.js';
import { setSessionContext } from './session-context.js';
import { setShellTracePropagation } from './trace-context.js';
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

// Ceiling for sdk.shutdown() when called directly (e.g. non-interactive mode).
// In interactive mode, runExitCleanup() imposes its own tighter per-function
// (2s) and overall (5s) timeouts, so this value is effectively unreachable there.
const SHUTDOWN_TIMEOUT_MS = 10_000;

let sdk: NodeSDK | undefined;
let telemetryInitialized = false;
let telemetryInitPromise: Promise<void> | undefined;
let telemetryShutdownPromise: Promise<void> | undefined;
let activeMetricReader: PeriodicExportingMetricReader | undefined;

export function isTelemetrySdkInitialized(): boolean {
  return telemetryInitialized;
}

export function initializeTelemetry(
  config: TelemetryRuntimeConfig,
): Promise<void> {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return Promise.resolve();
  }
  // Single-flight: concurrent callers share one in-flight init. The promise
  // is cleared in `finally` so a failed dynamic import can be retried, while
  // a successful init keeps returning early via `telemetryInitialized`.
  telemetryInitPromise ??= (async () => {
    const debugLogger = createDebugLogger('OTEL');
    try {
      // The heavy SDK assembly is loaded on demand so disabled-telemetry
      // processes — notably the ACP child on the daemon cold-start path —
      // never pay the module-load cost. `startTelemetrySdk` in turn loads
      // only the configured OTLP protocol chain (issue #7264). Both dynamic
      // imports stay inside the try so a chunk-load failure degrades telemetry
      // rather than rejecting — the daemon runtime awaits this without a catch.
      const { startTelemetrySdk } = await import('./sdk-impl.js');
      if (telemetryInitialized) return;
      const started = await startTelemetrySdk(config);
      if (!started) return;
      sdk = started.sdk;
      sdk.start();
      debugLogger.debug('OpenTelemetry SDK started successfully.');
      telemetryInitialized = true;
      activeMetricReader = started.metricReader;
      const sessionId = config.getSessionId();
      setSessionContext(createSessionRootContext(sessionId), sessionId);
      setShellTracePropagation(
        config.getOutboundCorrelationPropagateTraceContext(),
      );
      initializeMetrics(config);
    } catch (error) {
      debugLogger.error('Error starting OpenTelemetry SDK:', error);
    }
  })().finally(() => {
    telemetryInitPromise = undefined;
  });
  return telemetryInitPromise;
}

/**
 * Refresh the session context with a new session ID.
 * Must be called whenever the session changes (e.g. /clear, /resume)
 * so that SessionIdSpanProcessor stamps spans with the correct session.id.
 */
export function refreshSessionContext(sessionId: string): void {
  if (!telemetryInitialized) return;
  try {
    setSessionContext(createSessionRootContext(sessionId), sessionId);
  } catch (error) {
    createDebugLogger('OTEL').warn('Failed to refresh session context:', error);
  }
}

export function shutdownTelemetry(): Promise<void> {
  if (telemetryShutdownPromise) {
    return telemetryShutdownPromise;
  }
  // A fire-and-forget init (config bootstrap, startup prefetch) may still be
  // in flight. When nothing is initializing and nothing is initialized this is
  // a no-op; otherwise wait for that init inside the shutdown promise so we
  // tear down — and flush — whatever it registers, instead of racing past the
  // synchronous `telemetryInitialized` flag and leaking a started SDK.
  const pendingInit = telemetryInitPromise;
  if (!pendingInit && (!telemetryInitialized || !sdk)) {
    return Promise.resolve();
  }
  telemetryShutdownPromise = (async () => {
    if (pendingInit) {
      await pendingInit.catch(() => {});
    }
    if (!telemetryInitialized || !sdk) {
      // The awaited init did not finish initializing (telemetry disabled, no
      // usable exporter, or `sdk.start()` threw). Clear the promise we just set
      // so a later real shutdown isn't short-circuited by this stale no-op.
      telemetryShutdownPromise = undefined;
      return;
    }
    endInteractionSpan('cancelled');
    const currentSdk = sdk;
    const debugLogger = createDebugLogger('OTEL');
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
      activeMetricReader = undefined;
      telemetryShutdownPromise = undefined;
      setSessionContext(undefined);
      setShellTracePropagation(false);
    }
  })();
  return telemetryShutdownPromise;
}

const FORCE_FLUSH_TIMEOUT_MS = 2_000;

export async function forceFlushMetrics(): Promise<void> {
  if (!telemetryInitialized || !activeMetricReader) return;
  const flush = activeMetricReader.forceFlush();
  flush.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `forceFlushMetrics timed out after ${FORCE_FLUSH_TIMEOUT_MS}ms`,
          ),
        ),
      FORCE_FLUSH_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([flush, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

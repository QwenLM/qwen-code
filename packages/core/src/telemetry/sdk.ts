/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiagLogLevel, diag } from '@opentelemetry/api';
import type {
  Context,
  DiagLogger,
  TextMapPropagator,
} from '@opentelemetry/api';
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
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span as SdkSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import type { TelemetryRuntimeConfig } from './runtime-config.js';
import { SERVICE_NAME } from './constants.js';
import { initializeMetrics } from './metrics.js';
import {
  FileLogExporter,
  FileMetricExporter,
  FileSpanExporter,
} from './file-exporters.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { LogToSpanProcessor } from './log-to-span-processor.js';
import { getCurrentSessionId, setSessionContext } from './session-context.js';
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

/**
 * `TextMapPropagator` that emits nothing. Installed when
 * `outboundCorrelation.propagateTraceContext` is false (the default), so
 * trace context stays internal to the user's OTLP collector and is not
 * written into outbound `fetch` requests to third-party LLM providers.
 *
 * UndiciInstrumentation still creates client HTTP spans — the propagator
 * only governs whether `propagation.inject()` writes `traceparent` into
 * the outgoing request's header carrier. With this propagator installed,
 * inject is a no-op and outbound requests carry no trace headers. PR
 *  review : split outbound-wire behavior out of telemetry
 * default-on.
 */
const NOOP_PROPAGATOR: TextMapPropagator = {
  inject() {},
  extract(context: Context): Context {
    return context;
  },
  fields(): string[] {
    return [];
  },
};

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

class SessionIdSpanProcessor implements SpanProcessor {
  onStart(span: SdkSpan): void {
    try {
      if ((span as unknown as ReadableSpan).attributes?.['session.id']) return;
      const sessionId = getCurrentSessionId();
      if (sessionId) {
        span.setAttribute('session.id', sessionId);
      }
    } catch {
      // OTel processor errors must not break span creation
    }
  }
  onEnd(_span: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export function initializeTelemetry(config: TelemetryRuntimeConfig): void {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return;
  }

  const debugLogger = createDebugLogger('OTEL');
  // User-provided resource attributes (env + settings, already merged with
  // RESERVED stripping and OTEL_SERVICE_NAME precedence in the resolver).
  // We strip service.name/service.version here too as defense-in-depth, then
  // re-apply runtime-controlled values on top.
  const userAttrs = config.getTelemetryResourceAttributes() ?? {};
  const userServiceName = userAttrs['service.name'];
  // Strip keys we re-inject below (service.name, service.version) plus
  // session.id, which never belongs on the Resource — Resource attributes
  // auto-attach to every metric data point, which would bypass the metric
  // cardinality toggle. The resolver normally drops session.id from user
  // input already; this destructure is defense-in-depth for callers that
  // bypass the resolver (e.g. direct Config construction in tests).
  const {
    'service.name': _ignoredServiceName,
    'service.version': _ignoredServiceVersion,
    'session.id': _ignoredSessionId,
    ...nonReservedUserAttrs
  } = userAttrs;
  const resource = resourceFromAttributes({
    ...nonReservedUserAttrs,
    // `.trim() || SERVICE_NAME`: catches both empty string (`""`) and
    // whitespace-only values (`" "`, `"\t"`) that would otherwise produce
    // a blank service name on Resource (some backends reject these). Both
    // settings (no value trimming there) and env (`%20` decodes to `" "`)
    // can deliver whitespace-only values, so trim at the fallback point.
    [SemanticResourceAttributes.SERVICE_NAME]:
      userServiceName?.trim() || SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]:
      config.getCliVersion() || 'unknown',
  });

  // One-time user-visible summary of resource-attribute diagnostics
  // produced during config resolution. The per-warning `diag.warn` calls
  // route to the OTel debug log; without this summary, an operator whose
  // attributes are silently dropped has no console signal that anything
  // happened. Telemetry init runs before Ink renders, so console output
  // here does not interleave with the TUI.
  // `?? []` defends against test mocks (`vi.mock('../config/config.js')`)
  // that auto-stub Config methods to return undefined.
  const attrWarnings = config.getTelemetryResourceAttributeWarnings() ?? [];
  if (attrWarnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code telemetry] ${attrWarnings.length} resource attribute issue(s):`,
    );
    for (const w of attrWarnings) {
      // eslint-disable-next-line no-console
      console.warn(`  - ${w}`);
    }
  }

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
            // In interactive (TUI) mode, route bridge diagnostics to the OTEL
            // debug log file so they don't break out of the Ink render area
            // via raw stderr. In non-interactive mode, leave the default sink
            // alone so CI / scripts can still see export failures on stderr
            // the canonical diagnostic channel for batch runs.
            //
            // Caveat for interactive mode: when the user has explicitly
            // disabled file logging via QWEN_DEBUG_LOG_FILE=0, debugLogger.warn
            // silently no-ops and bridge diagnostics are fully lost — accepted
            // trade-off, since falling back to stderr would re-introduce the
            // TUI pollution this injection was added to prevent.
            ...(config.isInteractive() && {
              diagnosticsSink: (message: string) => debugLogger.warn(message),
            }),
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

  // Build OTLP exporter URL prefixes once. Both HttpInstrumentation (which
  // patches Node's built-in `http`/`https` — used by the OTLP HTTP exporter)
  // and UndiciInstrumentation (which patches `fetch` / undici — used by LLM
  // SDKs but also by some OTLP exporters when configured) must ignore
  // requests to these endpoints. Otherwise an upload would create a span
  // that gets exported, creating an infinite feedback loop. Use WHATWG URL
  // parsing so a parsed prefix is always { origin, pathname } — never the
  // dangerous bare `"http"` fallback that startsWith would match against
  // every HTTP URL on the wire. See PR review feedback (.
  function normalizeOtlpPrefix(
    raw: string | undefined,
  ): { origin: string; pathname: string } | undefined {
    if (!raw) return undefined;
    // Trim surrounding whitespace + ASCII quotes a user may have placed in
    // settings.json (`"value"` → `value`). Use the SAME lenient regex as
    // `parseOtlpEndpoint` (line 109) so any endpoint the exporter accepts
    // also gets a feedback-loop guard. Asymmetric quotes (e.g. `"value'`)
    // are almost certainly typos but `parseOtlpEndpoint` strips them too
    // mismatching here would let the exporter connect while the guard
    // returned `undefined`, reintroducing the parasitic-span loop. See PR
    //  review feedback (.
    const s = raw.trim().replace(/^["']|["']$/g, '');
    try {
      const u = new URL(s);
      // Drop ?query and #fragment — they're never part of the request
      // signature an instrumentation observer sees on outbound requests.
      // Strip a trailing `/` from path to keep prefix matching tight.
      const pathname = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
      return { origin: u.origin, pathname };
    } catch {
      // Unparseable URL (e.g. typo, placeholder). Reject entirely rather than
      // attempt a string-level fallback — a fallback like `"http"` from input
      // `"http"` would `startsWith`-match every outbound HTTP request and
      // silently disable all instrumentation. Returning undefined means this
      // misconfigured endpoint loses its feedback-loop guard, but the rest of
      // the system stays correct.
      diag.warn(
        `Telemetry OTLP endpoint "${raw}" is not a valid URL; instrumentation feedback-loop guard for it is disabled.`,
      );
      return undefined;
    }
  }
  const otlpUrlPrefixes = [
    config.getTelemetryOtlpEndpoint(),
    config.getTelemetryOtlpTracesEndpoint(),
    config.getTelemetryOtlpLogsEndpoint(),
    config.getTelemetryOtlpMetricsEndpoint(),
  ]
    .map(normalizeOtlpPrefix)
    .filter((u): u is { origin: string; pathname: string } => !!u);

  // Boundary-safe URL match. `url.startsWith(prefix)` is unsafe because:
  //   - port: prefix `http://host:4318` matches `http://host:43180/x`
  //   - path: prefix `http://host/v1` matches `http://host/v1foo/x`
  //   - host: prefix `https://otlp.example.com` matches `https://otlp.example.com.evil.net`
  // Comparing origin exactly + pathname with a path-boundary check avoids all
  // three. The next char after the prefix pathname must be `/`, `?`, `#`, or
  // end-of-string. See PR review feedback (.
  const matchesOtlpPrefix = (origin: string, path: string): boolean => {
    for (const prefix of otlpUrlPrefixes) {
      if (origin !== prefix.origin) continue;
      if (prefix.pathname === '') return true;
      if (!path.startsWith(prefix.pathname)) continue;
      const next = path.charAt(prefix.pathname.length);
      if (next === '' || next === '/' || next === '?' || next === '#') {
        return true;
      }
    }
    return false;
  };

  // Strip ?query / #fragment from a path. `indexOf` (not regex) for CodeQL
  // ReDoS hygiene.
  const stripPathSuffix = (path: string): string => {
    const qIdx = path.indexOf('?');
    const fIdx = path.indexOf('#');
    let cut = path.length;
    if (qIdx !== -1) cut = Math.min(cut, qIdx);
    if (fIdx !== -1) cut = Math.min(cut, fIdx);
    return path.slice(0, cut);
  };

  // Outbound trace-context propagation gate (PR review):
  // by default, install a no-op propagator so `traceparent` does NOT get
  // written onto outbound `fetch` requests to LLM providers. Operators
  // who want server-side trace stitching (e.g. ARMS+DashScope) opt in via
  // `outboundCorrelation.propagateTraceContext: true`, which leaves the
  // SDK's default W3C composite propagator in place. UndiciInstrumentation
  // still creates client HTTP spans either way — the propagator only
  // governs whether trace ids leak onto third-party request streams.
  const textMapPropagator: TextMapPropagator | undefined =
    config.getOutboundCorrelationPropagateTraceContext()
      ? undefined // undefined → NodeSDK keeps its default W3C propagator
      : NOOP_PROPAGATOR;

  sdk = new NodeSDK({
    resource,
    // Disable async host/process/env resource detectors: they leave attributes
    // pending and trigger an OTel diag.error on any resource attribute read
    // before the detectors settle (e.g. during HttpInstrumentation span creation).
    autoDetectResources: false,
    ...(textMapPropagator && { textMapPropagator }),
    spanProcessors: spanExporter
      ? [new SessionIdSpanProcessor(), new BatchSpanProcessor(spanExporter)]
      : [],
    logRecordProcessors: logExporter
      ? [new BatchLogRecordProcessor(logExporter)]
      : logToSpanProcessor
        ? [logToSpanProcessor]
        : [],
    ...(metricReader && { metricReader }),
    instrumentations: [
      new HttpInstrumentation({
        // OTLP HTTP exporter uses node:http (patched here, not by undici).
        // Without this, every OTLP upload batch creates a parasitic client
        // span that itself gets exported → feedback loop. See PR
        // review feedback (.
        ignoreOutgoingRequestHook: (req) => {
          if (otlpUrlPrefixes.length === 0) return false;
          // Protocol must be known to compare reliably. The previous
          // `|| 'http'` fallback silently mis-bucketed HTTPS requests as
          // HTTP when `req.protocol` was unset, so HTTPS OTLP endpoints
          // wouldn't match their prefix → guard bypassed → feedback loop.
          // Now: when proto can't be determined, fail open (return false →
          // request gets instrumented). Worst case is a parasitic client
          // span for an OTLP request — observable and recoverable, vs. the
          // unbounded feedback loop the previous default produced. See PR
          //  review feedback (.
          const proto = req.protocol
            ? String(req.protocol).replace(/:$/, '')
            : undefined;
          if (!proto) return false;
          // `req.host` may already include `:port` (e.g. `"collector:4318"`).
          // Naively concatenating `:${req.port}` below would yield
          // `"http://collector:4318:4318"`, which `new URL()` rejects → catch
          // returns false → silent guard bypass. Currently unreachable because
          // `@opentelemetry/otlp-exporter-base` always sets `hostname`, but
          // the fallback exists and must be correct. Strip the port — IPv6
          // literals like `"[::1]:443"` keep their bracketed host. See PR
          //  review feedback (.
          let host = req.hostname || '';
          if (!host && req.host) {
            const h = String(req.host);
            const bracketEnd = h.indexOf(']');
            const portIdx =
              bracketEnd !== -1 ? h.indexOf(':', bracketEnd) : h.indexOf(':');
            host = portIdx !== -1 ? h.slice(0, portIdx) : h;
          }
          const portPart =
            req.port !== undefined && req.port !== null && String(req.port)
              ? `:${req.port}`
              : '';
          // Route through `URL` so the reconstructed origin gets the same
          // default-port stripping (`:80` for http, `:443` for https) that
          // `normalizeOtlpPrefix` applies via `URL.origin`. Without this,
          // prefix `http://collector` (no explicit port) wouldn't match a
          // request to `http://collector:80/v1/traces` because `prefix.origin`
          // strips `:80` while the manually built string keeps it. See PR
          //  review feedback (.
          let origin: string;
          try {
            origin = new URL(`${proto}://${host}${portPart}`).origin;
          } catch {
            return false;
          }
          const path =
            typeof req.path === 'string' ? stripPathSuffix(req.path) : '';
          return matchesOtlpPrefix(origin, path);
        },
      }),
      // Modern fetch (`globalThis.fetch` / undici) is the HTTP layer used by
      // `openai`, `@google/genai`, and `@anthropic-ai/sdk`. Without this
      // instrumentation, outbound LLM requests carry no `traceparent` header
      // and the trace tree terminates at the qwen-code process boundary.
      new UndiciInstrumentation({
        ignoreRequestHook: (request) => {
          if (otlpUrlPrefixes.length === 0) return false;
          const path =
            typeof request.path === 'string'
              ? stripPathSuffix(request.path)
              : '';
          return matchesOtlpPrefix(request.origin, path);
        },
      }),
    ],
  });

  try {
    sdk.start();
    debugLogger.debug('OpenTelemetry SDK started successfully.');
    telemetryInitialized = true;
    const sessionId = config.getSessionId();
    setSessionContext(undefined, sessionId);
    initializeMetrics(config);
  } catch (error) {
    debugLogger.error('Error starting OpenTelemetry SDK:', error);
  }
}

/**
 * Refresh the session context with a new session ID.
 * Must be called whenever the session changes (e.g. /clear, /resume)
 * so that SessionIdSpanProcessor stamps spans with the correct session.id.
 */
export function refreshSessionContext(sessionId: string): void {
  if (!telemetryInitialized) return;
  setSessionContext(undefined, sessionId);
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

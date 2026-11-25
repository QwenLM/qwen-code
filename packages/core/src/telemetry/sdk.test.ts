/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  initializeTelemetry,
  isTelemetrySdkInitialized,
  shutdownTelemetry,
  refreshSessionContext,
} from './sdk.js';
import { resolveHttpOtlpUrl } from './otlp-urls.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  resetDebugLoggingState,
  setDebugLogSession,
} from '../utils/debugLogger.js';

const mockEndAllInteractionSpans = vi.hoisted(() => vi.fn());

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectOtelDebugLogLine(
  level: 'ERROR' | 'WARN',
  message: string,
): ReturnType<typeof expect.stringMatching> {
  return expect.stringMatching(
    new RegExp(
      `\\[${level}\\] \\[OTEL\\]( \\[trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}\\])? ${escapeRegExp(message)}`,
    ),
  );
}

vi.mock('@opentelemetry/exporter-trace-otlp-grpc');
vi.mock('@opentelemetry/exporter-logs-otlp-grpc');
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc');
vi.mock('@opentelemetry/exporter-trace-otlp-http');
vi.mock('@opentelemetry/exporter-logs-otlp-http');
vi.mock('@opentelemetry/exporter-metrics-otlp-http');
vi.mock('@opentelemetry/sdk-node');
vi.mock('@opentelemetry/instrumentation-http');
vi.mock('@opentelemetry/instrumentation-undici');
vi.mock('./gcp-exporters.js');
vi.mock('./log-to-span-processor.js');
vi.mock('./session-events.js', () => ({
  emitSessionEnd: vi.fn(),
  emitSessionStart: vi.fn(),
}));
vi.mock('./session-context.js');
vi.mock('./trace-context.js');
vi.mock('./session-tracing.js', () => ({
  endAllInteractionSpans: mockEndAllInteractionSpans,
}));
vi.mock('./tracer.js', () => ({
  createSessionRootContext: vi.fn((id: string) => ({ __sessionId: id })),
  shouldForceSampled: vi.fn((): boolean => true),
}));

import { LogToSpanProcessor } from './log-to-span-processor.js';
import {
  getCurrentSessionId,
  getSessionIdFromContext,
  setSessionContext,
} from './session-context.js';
import { setShellTracePropagation } from './trace-context.js';
import { createSessionRootContext } from './tracer.js';
import { emitSessionEnd, emitSessionStart } from './session-events.js';
import { extractDaemonHttpTraceContext } from './daemon-tracing.js';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { sessionIdContext } from '../utils/sessionIdContext.js';

/** The getters every describe's mockConfig starts from. */
const baseConfig = () => ({
  getTelemetryEnabled: () => true,
  getTelemetryOtlpEndpoint: () => 'http://localhost:4317',
  getTelemetryOtlpProtocol: () => 'grpc',
  getTelemetryOtlpTracesEndpoint: () => undefined,
  getTelemetryOtlpLogsEndpoint: () => undefined,
  getTelemetryOtlpMetricsEndpoint: () => undefined,
  getTelemetryTarget: () => 'local',
  getTelemetryOutfile: () => undefined,
  getTelemetryIncludeSensitiveSpanAttributes: () => false,
  getTelemetryResourceAttributes: () => ({}),
  getTelemetryMetricsIncludeSessionId: () => false,
  getTelemetryResourceAttributeWarnings: () => [],
  getDebugMode: () => false,
  getSessionId: () => 'test-session',
  getCliVersion: () => '1.0.0-test',
  getOutboundCorrelationPropagateTraceContext: () => false,
  isInteractive: () => false,
});

/** Runs `fn` with `vars` set (undefined deletes), then restores them. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const apply = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  const previous = Object.fromEntries(
    Object.keys(vars).map((name) => [name, process.env[name]]),
  );
  apply(vars);
  try {
    await fn();
  } finally {
    apply(previous);
  }
}

/** Runs `fn` with debug-log files on for `sessionId`, then resets logging. */
function withDebugLogFile(
  sessionId: string,
  fn: () => Promise<void>,
): Promise<void> {
  return withEnv({ QWEN_DEBUG_LOG_FILE: '1' }, async () => {
    try {
      setDebugLogSession({ getSessionId: () => sessionId });
      await fn();
    } finally {
      setDebugLogSession(null);
      resetDebugLoggingState();
    }
  });
}

describe('resolveHttpOtlpUrl', () => {
  /** Expects `base` to resolve to each given signal's URL. */
  const expectUrls = (
    base: string,
    urls: Partial<Record<Parameters<typeof resolveHttpOtlpUrl>[1], string>>,
  ) => {
    for (const [signal, url] of Object.entries(urls)) {
      expect(resolveHttpOtlpUrl(base, signal as keyof typeof urls)).toBe(url);
    }
  };

  it('appends signal path to base collector URL', () => {
    expectUrls('http://collector:4318', {
      traces: 'http://collector:4318/v1/traces',
      logs: 'http://collector:4318/v1/logs',
      metrics: 'http://collector:4318/v1/metrics',
    });
  });

  it('handles trailing slash in base URL', () => {
    expectUrls('http://collector:4318/', {
      traces: 'http://collector:4318/v1/traces',
      logs: 'http://collector:4318/v1/logs',
    });
  });

  it('preserves explicit full signal path URL', () => {
    for (const signal of ['traces', 'logs', 'metrics'] as const) {
      const url = `http://collector:4318/v1/${signal}`;
      expectUrls(url, { [signal]: url });
    }
  });

  it('appends signal path when URL has a non-signal custom path', () => {
    expectUrls('http://collector:4318/custom/prefix', {
      traces: 'http://collector:4318/custom/prefix/v1/traces',
    });
  });

  it('handles HTTPS URLs', () => {
    expectUrls('https://otel.example.com', {
      logs: 'https://otel.example.com/v1/logs',
    });
    expectUrls('https://otel.example.com:4318', {
      metrics: 'https://otel.example.com:4318/v1/metrics',
    });
  });

  it('preserves query strings when appending signal paths', () => {
    expectUrls('https://host/otlp?token=abc', {
      traces: 'https://host/otlp/v1/traces?token=abc',
    });
    expectUrls('https://host/otlp?token=abc&foo=bar', {
      logs: 'https://host/otlp/v1/logs?token=abc&foo=bar',
    });
  });
});

describe('Telemetry SDK', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentSessionId).mockReturnValue(undefined);
    vi.mocked(getSessionIdFromContext).mockReturnValue(undefined);
    mockConfig = baseConfig() as unknown as Config;
  });

  afterEach(async () => {
    vi.mocked(getCurrentSessionId).mockReturnValue(undefined);
    await shutdownTelemetry();
  });

  /** Stubs mockConfig getters to return the given values. */
  const stub = (values: Partial<Record<keyof Config, unknown>>) => {
    for (const [getter, value] of Object.entries(values)) {
      vi.spyOn(
        mockConfig as unknown as Record<string, () => unknown>,
        getter,
      ).mockReturnValue(value);
    }
  };
  /** OTLP over HTTP with `endpoint` as the base, plus any other stubs. */
  const viaHttp = (
    endpoint: string,
    values: Partial<Record<keyof Config, unknown>> = {},
  ) =>
    stub({
      getTelemetryOtlpProtocol: 'http',
      getTelemetryOtlpEndpoint: endpoint,
      ...values,
    });
  const TRACES_ONLY = {
    getTelemetryOtlpTracesEndpoint: 'http://traces-host/token/api/otlp/traces',
  };
  const NO_SIGNAL_ENDPOINTS = {
    getTelemetryOtlpTracesEndpoint: undefined,
    getTelemetryOtlpLogsEndpoint: undefined,
    getTelemetryOtlpMetricsEndpoint: undefined,
  };

  const sdkOptions = () => vi.mocked(NodeSDK).mock.calls[0]![0]!;
  function getResourceAttributes(): Record<string, string> {
    return (sdkOptions().resource as { attributes: Record<string, string> })
      .attributes;
  }

  /** Initializes, then starts a span via the session-id span processor. */
  async function startSessionSpan(
    attributes: Record<string, unknown> = {},
    run: (start: () => void) => void = (start) => start(),
  ) {
    await initializeTelemetry(mockConfig);
    const { spanProcessors } = sdkOptions() as {
      spanProcessors?: Array<{
        onStart: (span: unknown, parentContext: unknown) => void;
      }>;
    };
    const span = {
      attributes,
      setAttribute: vi.fn((key: string, value: unknown) => {
        attributes[key] = value;
      }),
    };
    run(() => spanProcessors![0]!.onStart(span, ROOT_CONTEXT));
    return span;
  }

  it('stamps automatic spans from scoped context before the global session', async () => {
    vi.mocked(getSessionIdFromContext).mockReturnValue('scoped-session');
    vi.mocked(getCurrentSessionId).mockReturnValue('stale-session');

    const span = await startSessionSpan();

    expect(span.setAttribute).toHaveBeenCalledWith(
      'session.id',
      'scoped-session',
    );
  });

  it('does not overwrite an explicit automatic-span session', async () => {
    vi.mocked(getSessionIdFromContext).mockReturnValue('scoped-session');

    const span = await startSessionSpan({ 'session.id': 'explicit-session' });

    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it('uses the per-request session before the global session', async () => {
    vi.mocked(getSessionIdFromContext).mockReturnValue(undefined);
    vi.mocked(getCurrentSessionId).mockReturnValue('stale-session');

    const span = await startSessionSpan({}, (start) =>
      sessionIdContext.run('request-session', start),
    );

    expect(span.setAttribute).toHaveBeenCalledWith(
      'session.id',
      'request-session',
    );
  });

  /** Expects the HTTP trace, log and metric exporters' URLs. */
  const expectHttpUrls = (traces: string, logs: string, metrics: string) => {
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({ url: traces });
    expect(OTLPLogExporterHttp).toHaveBeenCalledWith({ url: logs });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({ url: metrics });
  };

  it('should use gRPC exporters when protocol is grpc', async () => {
    await initializeTelemetry(mockConfig);

    for (const Exporter of [
      OTLPTraceExporter,
      OTLPLogExporter,
      OTLPMetricExporter,
    ]) {
      expect(Exporter).toHaveBeenCalledWith({
        url: 'http://localhost:4317',
        compression: 'gzip',
      });
    }
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ autoDetectResources: false }),
    );
  });

  it.each([
    ['unset limits', undefined, undefined, Infinity],
    ['span-specific priority', '256', '512', 256],
    ['invalid span-specific fallback', 'invalid', '384', 384],
    ['zero span-specific value', '0', '256', 0],
    ['negative span-specific value', '-1', '256', -1],
  ])(
    'pins the %s OTel attribute limit in the SDK',
    async (_name, spanLimit, generalLimit, expected) => {
      const env = {
        OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: spanLimit,
        OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: generalLimit,
      };
      await withEnv(env, async () => {
        await initializeTelemetry(mockConfig);

        expect(NodeSDK).toHaveBeenCalledWith(
          expect.objectContaining({
            spanLimits: { attributeValueLengthLimit: expected },
          }),
        );
      });
    },
  );

  describe('lazy init lifecycle', () => {
    it('shares a single in-flight init across concurrent callers', async () => {
      await Promise.all([
        initializeTelemetry(mockConfig),
        initializeTelemetry(mockConfig),
      ]);

      expect(NodeSDK).toHaveBeenCalledTimes(1);
      expect(NodeSDK.prototype.start).toHaveBeenCalledTimes(1);
      // One shared init means one settle-time catch-up, even with concurrent
      // callers.
      expect(emitSessionStart).toHaveBeenCalledTimes(1);
      expect(emitSessionStart).toHaveBeenCalledWith('test-session');
    });

    it('emits the initial session start after the SDK settles', async () => {
      await initializeTelemetry(mockConfig);

      expect(emitSessionStart).toHaveBeenCalledWith('test-session');
      expect(
        vi.mocked(emitSessionStart).mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        vi.mocked(NodeSDK.prototype.start).mock.invocationCallOrder[0],
      );
    });

    it('installs the daemon fallback propagator when the SDK initializes', async () => {
      // daemon-tracing.test.ts covers the pre-init state (no parent context).
      // This proves the other half: after init the sdk-impl chunk has injected
      // the W3C fallback, so inbound HTTP extraction finds a remote parent
      // though the global propagator stays a no-op (NodeSDK is mocked).
      await initializeTelemetry(mockConfig);

      const extracted = extractDaemonHttpTraceContext({
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      });
      expect(trace.getSpanContext(extracted!)?.traceId).toBe('3'.repeat(32));
      expect(trace.getSpanContext(extracted!)?.isRemote).toBe(true);
    });

    const exporterEnv = {
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'otlp',
    } as const;
    const exporterNames = Object.keys(exporterEnv) as Array<
      keyof typeof exporterEnv
    >;

    it('ignores external exporter selectors while starting explicit exporters', async () => {
      await withEnv(exporterEnv, async () => {
        expect(isTelemetrySdkInitialized()).toBe(false);
        let startCalled = false;
        const observedDuringStart: Record<string, string | undefined> = {};
        vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
          startCalled = true;
          for (const name of exporterNames) {
            observedDuringStart[name] = process.env[name];
          }
        });

        await initializeTelemetry(mockConfig);
        expect(startCalled).toBe(true);
        // Assert here, not inside the mocked start(): initializeTelemetry
        // catches start() failures, so an assertion thrown there would be
        // swallowed as an init failure and the test would still pass.
        for (const name of exporterNames) {
          expect(observedDuringStart[name]).toBeUndefined();
          expect(process.env[name]).toBe(exporterEnv[name]);
        }
      });
    });

    it('restores external exporter selectors when sdk.start() throws', async () => {
      await withEnv(exporterEnv, async () => {
        vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
          throw new Error('start failed');
        });

        await initializeTelemetry(mockConfig);
        expect(isTelemetrySdkInitialized()).toBe(false);
        for (const name of exporterNames) {
          expect(process.env[name]).toBe(exporterEnv[name]);
        }
      });
    });

    it('clears the in-flight promise so a failed init can be retried', async () => {
      vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      // A failed init must resolve (never reject) and leave telemetry off so a
      // later call can retry rather than reusing a poisoned single-flight promise.
      await expect(initializeTelemetry(mockConfig)).resolves.toBeUndefined();
      expect(isTelemetrySdkInitialized()).toBe(false);

      // The retry succeeds: reaching `initialized === true` requires the
      // continuation to have run `sdk.start()` again on a fresh SDK.
      await initializeTelemetry(mockConfig);
      expect(isTelemetrySdkInitialized()).toBe(true);
    });

    it('waits for an in-flight init before shutting down', async () => {
      // Regression guard for the shutdown/init race: shutdown must not no-op
      // past a not-yet-set `telemetryInitialized` and leak a started SDK whose
      // buffered spans/logs never flush.
      const initPromise = initializeTelemetry(mockConfig);
      const shutdownPromise = shutdownTelemetry();

      await Promise.all([initPromise, shutdownPromise]);

      expect(NodeSDK.prototype.start).toHaveBeenCalledTimes(1);
      expect(NodeSDK.prototype.shutdown).toHaveBeenCalledTimes(1);
      expect(isTelemetrySdkInitialized()).toBe(false);
    });

    it('clears the shutdown promise when it races an init that fails to start', async () => {
      vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      const initPromise = initializeTelemetry(mockConfig);
      const shutdownPromise = shutdownTelemetry();
      await Promise.all([initPromise, shutdownPromise]);
      expect(isTelemetrySdkInitialized()).toBe(false);

      // The no-op shutdown above resolved without an SDK; it must not leave a
      // stale shutdown promise that short-circuits a later real teardown.
      await initializeTelemetry(mockConfig);
      await shutdownTelemetry();
      expect(NodeSDK.prototype.shutdown).toHaveBeenCalledTimes(1);
      expect(isTelemetrySdkInitialized()).toBe(false);
    });

    it('ends the active session before the SDK shuts down', async () => {
      vi.mocked(getCurrentSessionId).mockReturnValueOnce('active-session');
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(mockEndAllInteractionSpans).toHaveBeenCalledWith('cancelled');
      expect(emitSessionEnd).toHaveBeenCalledWith('active-session');
      const shutdownOrder = vi.mocked(NodeSDK.prototype.shutdown).mock
        .invocationCallOrder[0];
      expect(
        mockEndAllInteractionSpans.mock.invocationCallOrder[0],
      ).toBeLessThan(shutdownOrder);
      expect(
        vi.mocked(emitSessionEnd).mock.invocationCallOrder[0],
      ).toBeLessThan(shutdownOrder);
    });

    it('does not end a session at shutdown when no session context exists', async () => {
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(emitSessionEnd).not.toHaveBeenCalled();
    });
  });

  it('should route OpenTelemetry diagnostics to debug log instead of console output', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const appendFileSpy = vi
      .spyOn(fs, 'appendFile')
      .mockResolvedValue(undefined);
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
    const symlinkSpy = vi.spyOn(fs, 'symlink').mockResolvedValue(undefined);
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const exportFailure =
      'Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED)';
    try {
      await withDebugLogFile(sessionId, async () => {
        diag.error(JSON.stringify({ message: exportFailure }));
        diag.error('A different OpenTelemetry diagnostic');
        diag.warn('An OpenTelemetry warning');

        await vi.waitFor(() => {
          expect(appendFileSpy).toHaveBeenCalledTimes(3);
        });

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(consoleWarnSpy).not.toHaveBeenCalled();
        expect(mkdirSpy).toHaveBeenCalled();
        for (const [level, message] of [
          ['ERROR', `{"message":"${exportFailure}"}`],
          ['ERROR', 'A different OpenTelemetry diagnostic'],
          ['WARN', 'An OpenTelemetry warning'],
        ] as const) {
          expect(appendFileSpy).toHaveBeenCalledWith(
            expect.stringContaining(sessionId),
            expectOtelDebugLogLine(level, message),
            'utf8',
          );
        }
      });
    } finally {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      mkdirSpy.mockRestore();
      appendFileSpy.mockRestore();
      unlinkSpy.mockRestore();
      symlinkSpy.mockRestore();
    }
  });

  it('should use HTTP exporters with signal-specific paths when protocol is http', async () => {
    viaHttp('http://localhost:4318', { getTelemetryEnabled: true });

    await initializeTelemetry(mockConfig);

    expectHttpUrls(
      'http://localhost:4318/v1/traces',
      'http://localhost:4318/v1/logs',
      'http://localhost:4318/v1/metrics',
    );
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ autoDetectResources: false }),
    );
  });

  it('should parse gRPC endpoint correctly', async () => {
    stub({ getTelemetryOtlpEndpoint: 'https://my-collector.com' });
    await initializeTelemetry(mockConfig);
    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com' }),
    );
  });

  it('should append signal paths to HTTP endpoint', async () => {
    viaHttp('https://my-collector.com');
    await initializeTelemetry(mockConfig);
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com/v1/traces' }),
    );
    expect(OTLPLogExporterHttp).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com/v1/logs' }),
    );
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com/v1/metrics' }),
    );
  });

  it('should use per-signal endpoint overrides when provided', async () => {
    viaHttp('http://default-collector:4318', {
      getTelemetryOtlpTracesEndpoint: 'http://traces-collector:4318/v1/traces',
    });

    await initializeTelemetry(mockConfig);

    // Traces uses its override; logs and metrics append paths to the base.
    expectHttpUrls(
      'http://traces-collector:4318/v1/traces',
      'http://default-collector:4318/v1/logs',
      'http://default-collector:4318/v1/metrics',
    );
  });

  it('should use per-signal overrides without base endpoint', async () => {
    // Logs has no override and no base endpoint.
    viaHttp('', {
      ...TRACES_ONLY,
      getTelemetryOtlpMetricsEndpoint:
        'http://metrics-host/token/api/otlp/metrics',
    });

    await initializeTelemetry(mockConfig);

    // Traces and metrics use per-signal override
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({
      url: 'http://traces-host/token/api/otlp/traces',
    });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({
      url: 'http://metrics-host/token/api/otlp/metrics',
    });
    // Logs falls back to LogToSpanProcessor (bridges logs → spans)
    expect(OTLPLogExporterHttp).not.toHaveBeenCalled();
    expect(LogToSpanProcessor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeSensitiveSpanAttributes: false }),
    );
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
  });

  it('passes sensitive span attribute config to the log-to-span bridge', async () => {
    viaHttp('', {
      ...TRACES_ONLY,
      getTelemetryIncludeSensitiveSpanAttributes: true,
    });

    await initializeTelemetry(mockConfig);

    expect(LogToSpanProcessor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeSensitiveSpanAttributes: true }),
    );
  });

  /** The options the last LogToSpanProcessor was constructed with. */
  const logToSpanOptions = () =>
    vi.mocked(LogToSpanProcessor).mock.calls.at(-1)?.[1] as {
      diagnosticsSink?: (m: string) => void;
    };

  it('in interactive mode, routes log-to-span diagnostics through the OTEL debug logger to avoid TUI pollution', async () => {
    viaHttp('', { ...TRACES_ONLY, isInteractive: true });
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const appendFileSpy = vi
      .spyOn(fs, 'appendFile')
      .mockResolvedValue(undefined);
    try {
      await withDebugLogFile('log-to-span-sink-test', async () => {
        await initializeTelemetry(mockConfig);

        const opts = logToSpanOptions();
        expect(typeof opts.diagnosticsSink).toBe('function');

        opts.diagnosticsSink?.('[LogToSpan] sink wiring smoke test');

        await vi.waitFor(() => {
          expect(appendFileSpy).toHaveBeenCalledWith(
            expect.stringContaining('log-to-span-sink-test'),
            expectOtelDebugLogLine(
              'WARN',
              '[LogToSpan] sink wiring smoke test',
            ),
            'utf8',
          );
        });
      });
    } finally {
      mkdirSpy.mockRestore();
      appendFileSpy.mockRestore();
    }
  });

  it('in non-interactive mode, leaves diagnostics on the default stderr sink so CI/scripts see export failures', async () => {
    viaHttp('', { ...TRACES_ONLY, isInteractive: false });

    await initializeTelemetry(mockConfig);

    // No explicit sink → processor falls back to its default (stderr).
    expect(logToSpanOptions().diagnosticsSink).toBeUndefined();

    // End-to-end: a real processor with no sink must report a failed export
    // on stderr, not drop it silently.
    const { LogToSpanProcessor: RealProcessor } = await vi.importActual<
      typeof import('./log-to-span-processor.js')
    >('./log-to-span-processor.js');
    const failingExporter = {
      export: (
        _spans: unknown,
        cb: (r: { code: number; error?: Error }) => void,
      ) => cb({ code: 1, error: new Error('boom') }),
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    const realProcessor = new RealProcessor(
      failingExporter as unknown as ConstructorParameters<
        typeof RealProcessor
      >[0],
      { flushIntervalMs: 60000 },
    );
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      realProcessor.onEmit({
        body: 'event',
        hrTime: [1000, 0] as [number, number],
        attributes: { 'event.name': 'event' },
      } as unknown as Parameters<typeof realProcessor.onEmit>[0]);
      await realProcessor.forceFlush();
      expect(stderrWrite).toHaveBeenCalledWith(
        '[LogToSpan] export failed: code=1 error="boom"\n',
      );
    } finally {
      stderrWrite.mockRestore();
      await realProcessor.shutdown();
    }
  });

  it('should warn and skip startup for gRPC per-signal endpoints without base endpoint', async () => {
    const diagWarnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    try {
      stub({
        getTelemetryOtlpProtocol: 'grpc',
        getTelemetryOtlpEndpoint: '',
        ...TRACES_ONLY,
      });

      await initializeTelemetry(mockConfig);

      expect(diagWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Telemetry SDK startup was skipped'),
      );
      expect(NodeSDK.prototype.start).not.toHaveBeenCalled();
      expect(isTelemetrySdkInitialized()).toBe(false);
    } finally {
      diagWarnSpy.mockRestore();
    }
  });

  it('explicitly disables metrics when no HTTP metrics endpoint is configured', async () => {
    viaHttp('', {
      getTelemetryOtlpTracesEndpoint: 'http://traces-host/v1/traces',
    });

    await initializeTelemetry(mockConfig);

    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ metricReaders: [] }),
    );
  });

  it('should not use OTLP exporters when telemetryOutfile is set', async () => {
    stub({ getTelemetryOutfile: path.join(os.tmpdir(), 'test.log') });
    await initializeTelemetry(mockConfig);

    expect(OTLPTraceExporter).not.toHaveBeenCalled();
    expect(OTLPLogExporter).not.toHaveBeenCalled();
    expect(OTLPMetricExporter).not.toHaveBeenCalled();
    expect(OTLPTraceExporterHttp).not.toHaveBeenCalled();
    expect(OTLPLogExporterHttp).not.toHaveBeenCalled();
    expect(OTLPMetricExporterHttp).not.toHaveBeenCalled();
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ autoDetectResources: false }),
    );
  });

  it('should not register async process shutdown handlers', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    try {
      await initializeTelemetry(mockConfig);

      for (const signal of ['SIGTERM', 'SIGINT', 'exit']) {
        expect(processOnSpy).not.toHaveBeenCalledWith(
          signal,
          expect.any(Function),
        );
      }
    } finally {
      processOnSpy.mockRestore();
    }
  });

  it('should mark telemetry uninitialized after shutdown', async () => {
    await initializeTelemetry(mockConfig);

    await shutdownTelemetry();

    expect(isTelemetrySdkInitialized()).toBe(false);
  });

  it('should set service.version to the application version, not Node.js version', async () => {
    await initializeTelemetry(mockConfig);

    const resource = getResourceAttributes();
    expect(resource['service.version']).toBe('1.0.0-test');
    expect(resource['service.version']).not.toBe(process.version);
  });

  it('should complete shutdown within timeout when SDK shutdown hangs', async () => {
    vi.useFakeTimers();
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockReturnValue(new Promise<void>(() => {}));
    const diagWarnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    try {
      await initializeTelemetry(mockConfig);

      const shutdownPromise = shutdownTelemetry();
      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_000);
      await shutdownPromise;

      expect(isTelemetrySdkInitialized()).toBe(false);
      expect(diagWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Telemetry shutdown timed out'),
      );
    } finally {
      shutdownSpy.mockRestore();
      diagWarnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should complete shutdown normally when SDK resolves before timeout', async () => {
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockResolvedValue();
    try {
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(isTelemetrySdkInitialized()).toBe(false);
    } finally {
      shutdownSpy.mockRestore();
    }
  });

  it('should log error when sdk.shutdown() rejects', async () => {
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockReturnValue(Promise.reject(new Error('shutdown failed')));
    const diagErrorSpy = vi.spyOn(diag, 'error').mockImplementation(() => {});
    try {
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(isTelemetrySdkInitialized()).toBe(false);
      expect(diagErrorSpy).toHaveBeenCalledWith(
        'Error shutting down SDK:',
        expect.any(Error),
      );
    } finally {
      shutdownSpy.mockRestore();
      diagErrorSpy.mockRestore();
    }
  });

  it('should fall back to "unknown" when getCliVersion returns undefined', async () => {
    stub({ getCliVersion: undefined });
    await initializeTelemetry(mockConfig);

    expect(getResourceAttributes()['service.version']).toBe('unknown');
  });

  describe('Resource attributes', () => {
    /** Initializes with `userAttributes` (if given); returns the Resource's. */
    const resourceWith = async (userAttributes?: Record<string, string>) => {
      if (userAttributes) {
        stub({ getTelemetryResourceAttributes: userAttributes });
      }
      await initializeTelemetry(mockConfig);
      return getResourceAttributes();
    };

    it('does not place session.id on the Resource', async () => {
      expect((await resourceWith())['session.id']).toBeUndefined();
    });

    it('always sets service.name and service.version from runtime', async () => {
      const attrs = await resourceWith();
      expect(attrs['service.name']).toBe('qwen-code');
      expect(attrs['service.version']).toBe('1.0.0-test');
    });

    it('attaches user-provided resource attributes', async () => {
      const attrs = await resourceWith({ team: 'platform', env: 'prod' });
      expect(attrs['team']).toBe('platform');
      expect(attrs['env']).toBe('prod');
    });

    it('user-provided service.name wins over default', async () => {
      const attrs = await resourceWith({ 'service.name': 'qwen-code-ci' });
      expect(attrs['service.name']).toBe('qwen-code-ci');
    });

    it('user-provided service.version is ignored (runtime value wins)', async () => {
      const attrs = await resourceWith({ 'service.version': '99.0.0-fake' });
      expect(attrs['service.version']).toBe('1.0.0-test');
    });

    it('empty-string service.name from settings falls back to default', async () => {
      // Reviewer caught: `??` would let "" pass; `||` correctly falls back
      // so backends never see a blank service name.
      const attrs = await resourceWith({ 'service.name': '' });
      expect(attrs['service.name']).toBe('qwen-code');
    });

    it('whitespace-only service.name from settings falls back to default', async () => {
      // Reviewer caught: plain `||` lets `" "` through; `.trim() ||
      // SERVICE_NAME` also covers whitespace (the env path yields it via `%20`).
      const attrs = await resourceWith({ 'service.name': '   ' });
      expect(attrs['service.name']).toBe('qwen-code');
    });

    it('emits a console summary when resource-attribute warnings are present', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      try {
        stub({
          getTelemetryResourceAttributeWarnings: [
            'OTEL_RESOURCE_ATTRIBUTES cannot override reserved key "service.version"; ignoring',
            'Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: "bogus"',
          ],
        });
        await initializeTelemetry(mockConfig);
        const header = consoleWarnSpy.mock.calls[0]?.[0] ?? '';
        expect(header).toContain('2 resource attribute issue');
        expect(
          consoleWarnSpy.mock.calls.some((c) =>
            String(c[0]).includes('reserved key'),
          ),
        ).toBe(true);
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it('no console output when warnings list is empty', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      try {
        await initializeTelemetry(mockConfig);
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it('user-provided session.id is stripped (defense-in-depth)', async () => {
      // A caller bypassing resolveTelemetrySettings() feeds raw input into
      // Config; session.id on the Resource would leak onto every data point.
      const attrs = await resourceWith({ 'session.id': 'spoofed', team: 'x' });
      expect(attrs['session.id']).toBeUndefined();
      expect(attrs['team']).toBe('x');
    });
  });

  describe('Outbound trace-context propagation gate', () => {
    function getTextMapPropagator(): unknown {
      return (sdkOptions() as { textMapPropagator?: unknown })
        .textMapPropagator;
    }

    it('installs a no-op TextMapPropagator by default (propagateTraceContext=false)', async () => {
      // Per PR #4390 R4 split, traceparent is NOT written onto the outbound
      // wire: inject() must be a no-op so Undici's propagation.inject(carrier)
      // writes nothing into outgoing request headers.
      await initializeTelemetry(mockConfig);
      const propagator = getTextMapPropagator() as
        | { inject: (...args: unknown[]) => void; fields: () => string[] }
        | undefined;
      expect(propagator).toBeDefined();
      expect(typeof propagator!.inject).toBe('function');
      // fields() is empty → no headers to clear / no propagator state.
      expect(propagator!.fields()).toEqual([]);
      // inject is a no-op — does not throw, does not mutate the carrier.
      const carrier: Record<string, string> = { existing: 'h' };
      expect(() =>
        propagator!.inject({} as never, carrier, {} as never),
      ).not.toThrow();
      expect(carrier).toEqual({ existing: 'h' });
    });

    it('uses the SDK default propagator when propagateTraceContext=true (operator opt-in)', async () => {
      stub({ getOutboundCorrelationPropagateTraceContext: true });
      await initializeTelemetry(mockConfig);
      // Omitted from NodeSDK options → the SDK installs its default W3C
      // trace-context + baggage CompositePropagator. Asserted as absence at
      // the constructor because sdk-node (which builds it) is auto-mocked.
      expect(getTextMapPropagator()).toBeUndefined();
    });
  });

  describe('Instrumentations', () => {
    const COLLECTOR = 'http://collector.example.com:4318';
    const OPENAI = ['https://api.openai.com', '/v1/chat/completions'] as const;

    /**
     * Initializes (over HTTP to `endpoint` when given); returns Undici's
     * ignoreRequestHook as (origin, path).
     */
    const undiciIgnores = async (...http: [] | Parameters<typeof viaHttp>) => {
      if (http.length) viaHttp(...http);
      await initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      return (origin: string, path: string) =>
        config.ignoreRequestHook({ origin, path });
    };

    /** Initializes over HTTP; returns HttpInstrumentation's outgoing hook. */
    const httpIgnores = async (endpoint: string) => {
      viaHttp(endpoint);
      await initializeTelemetry(mockConfig);
      const config = vi.mocked(HttpInstrumentation).mock.calls[0]![0]! as {
        ignoreOutgoingRequestHook: (req: {
          protocol?: string;
          host?: string;
          hostname?: string;
          port?: string | number;
          path: string;
        }) => boolean;
      };
      return (req: Parameters<typeof config.ignoreOutgoingRequestHook>[0]) =>
        config.ignoreOutgoingRequestHook(req);
    };

    it('registers both HttpInstrumentation and UndiciInstrumentation', async () => {
      await initializeTelemetry(mockConfig);
      const instrumentations = (sdkOptions().instrumentations ??
        []) as unknown[];
      // The mocks make HttpInstrumentation / UndiciInstrumentation auto-mocked
      // classes; instance-of checks against the mocked class still work.
      expect(
        instrumentations.some((i) => i instanceof HttpInstrumentation),
      ).toBe(true);
      expect(
        instrumentations.some((i) => i instanceof UndiciInstrumentation),
      ).toBe(true);
    });

    it('UndiciInstrumentation receives ignoreRequestHook that skips configured OTLP endpoints', async () => {
      const ignores = await undiciIgnores(COLLECTOR);
      // Configured OTLP endpoint must be skipped to avoid feedback loops.
      expect(ignores(COLLECTOR, '/v1/traces')).toBe(true);
      // Non-OTLP URLs (e.g. an LLM provider) must be traced.
      expect(
        ignores(
          'https://dashscope.aliyuncs.com',
          '/compatible-mode/v1/chat/completions',
        ),
      ).toBe(false);
    });

    it('ignoreRequestHook is a pure no-op when no OTLP endpoint is configured', async () => {
      stub({
        getTelemetryOtlpEndpoint: '',
        ...NO_SIGNAL_ENDPOINTS,
        getTelemetryOutfile: '/tmp/x',
      });
      const ignores = await undiciIgnores();
      // No OTLP endpoint → nothing to ignore. Returning false means every
      // request gets a client span (the desired behavior in outfile mode).
      expect(ignores(...OPENAI)).toBe(false);
    });

    it('ignoreRequestHook handles per-signal endpoint configuration', async () => {
      const ignores = await undiciIgnores('', {
        getTelemetryOtlpTracesEndpoint:
          'http://traces.example.com:4318/v1/traces',
        getTelemetryOtlpLogsEndpoint: 'http://logs.example.com:4318/v1/logs',
      });
      // Traces and logs endpoints match verbatim; an unrelated host does not.
      expect(ignores('http://traces.example.com:4318', '/v1/traces')).toBe(
        true,
      );
      expect(ignores('http://logs.example.com:4318', '/v1/logs')).toBe(true);
      expect(ignores(...OPENAI)).toBe(false);
    });

    it('ignoreRequestHook strips query string from incoming path for matching', async () => {
      // OTel SDK may append query params to OTLP requests; we still want
      // those to be ignored.
      const ignores = await undiciIgnores(COLLECTOR);
      expect(ignores(COLLECTOR, '/v1/traces?token=secret')).toBe(true);
    });

    it('ignoreRequestHook strips #fragment from incoming path for matching', async () => {
      const ignores = await undiciIgnores(COLLECTOR);
      expect(ignores(COLLECTOR, '/v1/traces#fragment')).toBe(true);
    });

    it('ignoreRequestHook normalizes endpoint config quoted in settings.json', async () => {
      // Quoted settings.json values (`"otlpEndpoint": "\"http://...\""`) would
      // otherwise miss the prefix match and reintroduce the feedback loop.
      // Per PR review feedback.
      const ignores = await undiciIgnores(`"${COLLECTOR}"`);
      expect(ignores(COLLECTOR, '/v1/traces')).toBe(true);
    });

    it('ignoreRequestHook strips #fragment from configured endpoint', async () => {
      const ignores = await undiciIgnores(`${COLLECTOR}/v1/traces#anchor`);
      expect(ignores(COLLECTOR, '/v1/traces')).toBe(true);
    });

    it('ignoreRequestHook does NOT bleed across port boundary (4318 vs 43180)', async () => {
      // A naive `url.startsWith(prefix)` would match `http://host:43180/...`
      // against prefix `http://host:4318`; origin comparison is exact, so a
      // different port must not match.
      const ignores = await undiciIgnores(COLLECTOR);
      expect(ignores(`${COLLECTOR}0`, '/v1/traces')).toBe(false);
    });

    it('ignoreRequestHook does NOT bleed across hostname boundary (otlp vs otlp.evil)', async () => {
      // Hostname suffix collision: origin comparison is exact, so prefix
      // `https://otlp.example.com` must NOT match `...example.com.evil.net`.
      const ignores = await undiciIgnores('https://otlp.example.com');
      expect(ignores('https://otlp.example.com.evil.net', '/v1/traces')).toBe(
        false,
      );
    });

    it('ignoreRequestHook does NOT bleed across path-segment boundary (/v1 vs /v1foo)', async () => {
      // Prefix `http://host/v1` must NOT match `http://host/v1foo/x`.
      const ignores = await undiciIgnores(`${COLLECTOR}/v1`);
      expect(ignores(COLLECTOR, '/v1foo/x')).toBe(false);
      // Sanity: same-origin match still works.
      expect(ignores(COLLECTOR, '/v1/traces')).toBe(true);
    });

    it('normalizeOtlpPrefix rejects unparseable URLs entirely (no dangerous "http" fallback)', async () => {
      // Critical fix: the old catch fallback turned a typo like `"http"` into
      // prefix `"http"`, which startsWith-matched every outbound request and
      // silently disabled all instrumentation. Now: undefined + diag warning.
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const ignores = await undiciIgnores(
        'not-a-valid-url',
        NO_SIGNAL_ENDPOINTS,
      );
      // No prefix → hook is a no-op, so outbound LLM requests are NOT masked
      // (the old "http" fallback masked everything).
      expect(ignores(...OPENAI)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('not a valid URL'),
      );
      warnSpy.mockRestore();
    });

    it('HttpInstrumentation also receives ignoreOutgoingRequestHook for OTLP exporter', async () => {
      // The OTLP HTTP exporter uses node:http (HttpInstrumentation, NOT
      // undici); without this guard every upload batch makes a parasitic
      // client span → feedback loop. PR #4390 review feedback.
      const ignores = await httpIgnores(COLLECTOR);
      // OTLP upload to configured collector → skipped.
      expect(
        ignores({
          protocol: 'http:',
          host: 'collector.example.com:4318',
          hostname: 'collector.example.com',
          port: 4318,
          path: '/v1/traces',
        }),
      ).toBe(true);
      // Unrelated LLM endpoint → traced.
      expect(
        ignores({
          protocol: 'https:',
          host: 'dashscope.aliyuncs.com',
          hostname: 'dashscope.aliyuncs.com',
          path: '/compatible-mode/v1/chat/completions',
        }),
      ).toBe(false);
    });

    it('matches default-port requests against a portless prefix (URL.origin parity)', async () => {
      // Regression: `URL.origin` drops `:80`, but the hook's manual
      // `${proto}://${host}${portPart}` kept it, so prefix and request origin
      // diverged → guard bypassed → feedback loop. PR #4390 review (wenshao).
      const ignores = await httpIgnores('http://collector.example.com');
      // Default port HTTP request to portless prefix → must match.
      expect(
        ignores({
          protocol: 'http:',
          hostname: 'collector.example.com',
          port: 80,
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('fails open when req.protocol is missing (no silent HTTPS guard bypass)', async () => {
      // Regression: the old `|| 'http'` fallback bucketed HTTPS requests
      // without `req.protocol` as HTTP, so HTTPS OTLP endpoints never matched
      // → guard bypassed → unbounded feedback loop. Now missing proto → false
      // → instrumented (worst case an observable parasitic span).
      // PR #4390 review feedback (wenshao).
      const ignores = await httpIgnores('https://collector.example.com:4318');
      expect(
        ignores({
          // protocol intentionally omitted
          hostname: 'collector.example.com',
          port: 4318,
          path: '/v1/traces',
        }),
      ).toBe(false);
    });

    it('strips port from req.host fallback to avoid `host:port:port` URL reject', async () => {
      // Without `req.hostname`, `req.host` may carry `:port` already;
      // appending `:${req.port}` gave `http://collector:4318:4318`, which URL
      // rejects → silent guard bypass. Unreachable today (otlp-exporter-base
      // always sets `hostname`) but the fallback must be correct.
      // PR #4390 review feedback (wenshao).
      const ignores = await httpIgnores(COLLECTOR);
      expect(
        ignores({
          protocol: 'http:',
          // hostname intentionally absent; host carries the port already
          host: 'collector.example.com:4318',
          port: 4318,
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('normalizeOtlpPrefix strips asymmetric quotes for parity with parseOtlpEndpoint', async () => {
      // parseOtlpEndpoint (line 109) strips asymmetric quotes with
      // /^["']|["']$/g; normalizeOtlpPrefix stripped only symmetric ones, so a
      // settings.json typo like `"value'` connected the exporter while the
      // guard got undefined → parasitic-span loop. PR #4390 review (wenshao).
      const ignores = await undiciIgnores(
        `"${COLLECTOR}'`,
        NO_SIGNAL_ENDPOINTS,
      );
      // Asymmetric-quoted endpoint normalized → guard matches OTLP traffic.
      expect(ignores(COLLECTOR, '/v1/traces')).toBe(true);
    });
  });
});

describe('refreshSessionContext', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    // This describe's config has no sensitive-span-attributes getter.
    const { getTelemetryIncludeSensitiveSpanAttributes: _omitted, ...fields } =
      baseConfig();
    mockConfig = fields as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('should update session context when telemetry is initialized', async () => {
    await initializeTelemetry(mockConfig);

    refreshSessionContext('new-session-id');

    expect(createSessionRootContext).toHaveBeenCalledWith('new-session-id');
    expect(setSessionContext).toHaveBeenCalledWith(
      { __sessionId: 'new-session-id' },
      'new-session-id',
    );
  });

  it('should be a no-op when telemetry is not initialized', () => {
    // Do NOT call initializeTelemetry — telemetryInitialized remains false
    refreshSessionContext('some-session');

    expect(createSessionRootContext).not.toHaveBeenCalled();
    expect(setSessionContext).not.toHaveBeenCalled();
  });

  it('should not throw when refreshing session context fails', async () => {
    await initializeTelemetry(mockConfig);
    vi.clearAllMocks();
    vi.mocked(createSessionRootContext).mockImplementationOnce(() => {
      throw new Error('session context failed');
    });

    expect(() => refreshSessionContext('bad-session')).not.toThrow();

    expect(createSessionRootContext).toHaveBeenCalledWith('bad-session');
    expect(setSessionContext).not.toHaveBeenCalled();
  });
});

describe('shell trace propagation wiring', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = baseConfig() as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('sets shell trace propagation on init based on config', async () => {
    const config = {
      ...mockConfig,
      getOutboundCorrelationPropagateTraceContext: () => true,
    } as unknown as Config;

    await initializeTelemetry(config);

    expect(setShellTracePropagation).toHaveBeenCalledWith(true);
  });

  it('resets shell trace propagation on shutdown', async () => {
    await initializeTelemetry(mockConfig);
    vi.mocked(setShellTracePropagation).mockClear();

    await shutdownTelemetry();

    expect(setShellTracePropagation).toHaveBeenCalledWith(false);
  });
});

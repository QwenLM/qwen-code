/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  initializeTelemetry,
  isTelemetrySdkInitialized,
  shutdownTelemetry,
  resolveHttpOtlpUrl,
  refreshSessionContext,
} from './sdk.js';
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
vi.mock('./session-context.js');
vi.mock('./tracer.js', () => ({
  createSessionRootContext: vi.fn((id: string) => ({ __sessionId: id })),
}));

import { LogToSpanProcessor } from './log-to-span-processor.js';
import { setSessionContext } from './session-context.js';
import { createSessionRootContext } from './tracer.js';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

describe('resolveHttpOtlpUrl', () => {
  it('appends signal path to base collector URL', () => {
    expect(resolveHttpOtlpUrl('http://collector:4318', 'traces')).toBe(
      'http://collector:4318/v1/traces',
    );
    expect(resolveHttpOtlpUrl('http://collector:4318', 'logs')).toBe(
      'http://collector:4318/v1/logs',
    );
    expect(resolveHttpOtlpUrl('http://collector:4318', 'metrics')).toBe(
      'http://collector:4318/v1/metrics',
    );
  });

  it('handles trailing slash in base URL', () => {
    expect(resolveHttpOtlpUrl('http://collector:4318/', 'traces')).toBe(
      'http://collector:4318/v1/traces',
    );
    expect(resolveHttpOtlpUrl('http://collector:4318/', 'logs')).toBe(
      'http://collector:4318/v1/logs',
    );
  });

  it('preserves explicit full signal path URL', () => {
    expect(
      resolveHttpOtlpUrl('http://collector:4318/v1/traces', 'traces'),
    ).toBe('http://collector:4318/v1/traces');
    expect(resolveHttpOtlpUrl('http://collector:4318/v1/logs', 'logs')).toBe(
      'http://collector:4318/v1/logs',
    );
    expect(
      resolveHttpOtlpUrl('http://collector:4318/v1/metrics', 'metrics'),
    ).toBe('http://collector:4318/v1/metrics');
  });

  it('appends signal path when URL has a non-signal custom path', () => {
    expect(
      resolveHttpOtlpUrl('http://collector:4318/custom/prefix', 'traces'),
    ).toBe('http://collector:4318/custom/prefix/v1/traces');
  });

  it('handles HTTPS URLs', () => {
    expect(resolveHttpOtlpUrl('https://otel.example.com', 'logs')).toBe(
      'https://otel.example.com/v1/logs',
    );
    expect(resolveHttpOtlpUrl('https://otel.example.com:4318', 'metrics')).toBe(
      'https://otel.example.com:4318/v1/metrics',
    );
  });

  it('preserves query strings when appending signal paths', () => {
    expect(resolveHttpOtlpUrl('https://host/otlp?token=abc', 'traces')).toBe(
      'https://host/otlp/v1/traces?token=abc',
    );
    expect(
      resolveHttpOtlpUrl('https://host/otlp?token=abc&foo=bar', 'logs'),
    ).toBe('https://host/otlp/v1/logs?token=abc&foo=bar');
  });
});

describe('Telemetry SDK', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
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
    } as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('should use gRPC exporters when protocol is grpc', () => {
    initializeTelemetry(mockConfig);

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4317',
      compression: 'gzip',
    });
    expect(OTLPLogExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4317',
      compression: 'gzip',
    });
    expect(OTLPMetricExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4317',
      compression: 'gzip',
    });
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ autoDetectResources: false }),
    );
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
    const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
    try {
      process.env['QWEN_DEBUG_LOG_FILE'] = '1';
      setDebugLogSession({ getSessionId: () => 'otel-diag-test-session' });

      diag.error(
        JSON.stringify({
          message:
            'Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED)',
        }),
      );

      diag.error('A different OpenTelemetry diagnostic');
      diag.warn('An OpenTelemetry warning');

      await vi.waitFor(() => {
        expect(appendFileSpy).toHaveBeenCalledTimes(3);
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).toHaveBeenCalled();
      expect(appendFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('otel-diag-test-session'),
        expectOtelDebugLogLine(
          'ERROR',
          '{"message":"Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED)"}',
        ),
        'utf8',
      );
      expect(appendFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('otel-diag-test-session'),
        expectOtelDebugLogLine('ERROR', 'A different OpenTelemetry diagnostic'),
        'utf8',
      );
      expect(appendFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('otel-diag-test-session'),
        expectOtelDebugLogLine('WARN', 'An OpenTelemetry warning'),
        'utf8',
      );
    } finally {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      mkdirSpy.mockRestore();
      appendFileSpy.mockRestore();
      unlinkSpy.mockRestore();
      symlinkSpy.mockRestore();
      setDebugLogSession(null);
      resetDebugLoggingState();
      if (previousDebugLogFileEnv === undefined) {
        delete process.env['QWEN_DEBUG_LOG_FILE'];
      } else {
        process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFileEnv;
      }
    }
  });

  it('should use HTTP exporters with signal-specific paths when protocol is http', () => {
    vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'http://localhost:4318',
    );

    initializeTelemetry(mockConfig);

    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/traces',
    });
    expect(OTLPLogExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/logs',
    });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/metrics',
    });
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ autoDetectResources: false }),
    );
  });

  it('should parse gRPC endpoint correctly', () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'https://my-collector.com',
    );
    initializeTelemetry(mockConfig);
    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com' }),
    );
  });

  it('should append signal paths to HTTP endpoint', () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'https://my-collector.com',
    );
    initializeTelemetry(mockConfig);
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

  it('should use per-signal endpoint overrides when provided', () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'http://default-collector:4318',
    );
    vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
      'http://traces-collector:4318/v1/traces',
    );

    initializeTelemetry(mockConfig);

    // Traces uses the per-signal override
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({
      url: 'http://traces-collector:4318/v1/traces',
    });
    // Logs and metrics use the base endpoint with paths appended
    expect(OTLPLogExporterHttp).toHaveBeenCalledWith({
      url: 'http://default-collector:4318/v1/logs',
    });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({
      url: 'http://default-collector:4318/v1/metrics',
    });
  });

  it('should use per-signal overrides without base endpoint', () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue('');
    vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
      'http://traces-host/token/api/otlp/traces',
    );
    vi.spyOn(mockConfig, 'getTelemetryOtlpMetricsEndpoint').mockReturnValue(
      'http://metrics-host/token/api/otlp/metrics',
    );
    // logs has no override and no base endpoint

    initializeTelemetry(mockConfig);

    // Traces and metrics use per-signal override
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({
      url: 'http://traces-host/token/api/otlp/traces',
    });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({
      url: 'http://metrics-host/token/api/otlp/metrics',
    });
    // Logs falls back to LogToSpanProcessor (bridges logs → spans)
    expect(OTLPLogExporterHttp).not.toHaveBeenCalled();
    expect(LogToSpanProcessor).toHaveBeenCalledWith(expect.anything(), {
      includeSensitiveSpanAttributes: false,
    });
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
  });

  it('passes sensitive span attribute config to the log-to-span bridge', () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue('');
    vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
      'http://traces-host/token/api/otlp/traces',
    );
    vi.spyOn(
      mockConfig,
      'getTelemetryIncludeSensitiveSpanAttributes',
    ).mockReturnValue(true);

    initializeTelemetry(mockConfig);

    expect(LogToSpanProcessor).toHaveBeenCalledWith(expect.anything(), {
      includeSensitiveSpanAttributes: true,
    });
  });

  it('should warn and skip startup for gRPC per-signal endpoints without base endpoint', () => {
    const diagWarnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    try {
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('grpc');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue('');
      vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
        'http://traces-host/token/api/otlp/traces',
      );

      initializeTelemetry(mockConfig);

      expect(diagWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Telemetry SDK startup was skipped'),
      );
      expect(NodeSDK.prototype.start).not.toHaveBeenCalled();
      expect(isTelemetrySdkInitialized()).toBe(false);
    } finally {
      diagWarnSpy.mockRestore();
    }
  });

  it('should not use OTLP exporters when telemetryOutfile is set', () => {
    vi.spyOn(mockConfig, 'getTelemetryOutfile').mockReturnValue(
      path.join(os.tmpdir(), 'test.log'),
    );
    initializeTelemetry(mockConfig);

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

  it('should not register async process shutdown handlers', () => {
    const processOnSpy = vi.spyOn(process, 'on');
    try {
      initializeTelemetry(mockConfig);

      expect(processOnSpy).not.toHaveBeenCalledWith(
        'SIGTERM',
        expect.any(Function),
      );
      expect(processOnSpy).not.toHaveBeenCalledWith(
        'SIGINT',
        expect.any(Function),
      );
      expect(processOnSpy).not.toHaveBeenCalledWith(
        'exit',
        expect.any(Function),
      );
    } finally {
      processOnSpy.mockRestore();
    }
  });

  it('should mark telemetry uninitialized after shutdown', async () => {
    initializeTelemetry(mockConfig);

    await shutdownTelemetry();

    expect(isTelemetrySdkInitialized()).toBe(false);
  });

  it('should set service.version to the application version, not Node.js version', () => {
    initializeTelemetry(mockConfig);

    const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
    const resource = constructorCall.resource as {
      attributes: Record<string, string>;
    };
    expect(resource.attributes['service.version']).toBe('1.0.0-test');
    expect(resource.attributes['service.version']).not.toBe(process.version);
  });

  it('should complete shutdown within timeout when SDK shutdown hangs', async () => {
    vi.useFakeTimers();
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockReturnValue(new Promise<void>(() => {}));
    const diagWarnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    try {
      initializeTelemetry(mockConfig);

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
      initializeTelemetry(mockConfig);

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
      initializeTelemetry(mockConfig);

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

  it('should fall back to "unknown" when getCliVersion returns undefined', () => {
    vi.spyOn(mockConfig, 'getCliVersion').mockImplementation(() => undefined);
    initializeTelemetry(mockConfig);

    const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
    const resource = constructorCall.resource as {
      attributes: Record<string, string>;
    };
    expect(resource.attributes['service.version']).toBe('unknown');
  });

  describe('Resource attributes', () => {
    function getResourceAttributes(): Record<string, string> {
      const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
      return (
        constructorCall.resource as { attributes: Record<string, string> }
      ).attributes;
    }

    it('does not place session.id on the Resource', () => {
      initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['session.id']).toBeUndefined();
    });

    it('always sets service.name and service.version from runtime', () => {
      initializeTelemetry(mockConfig);
      const attrs = getResourceAttributes();
      expect(attrs['service.name']).toBe('qwen-code');
      expect(attrs['service.version']).toBe('1.0.0-test');
    });

    it('attaches user-provided resource attributes', () => {
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        team: 'platform',
        env: 'prod',
      });
      initializeTelemetry(mockConfig);
      const attrs = getResourceAttributes();
      expect(attrs['team']).toBe('platform');
      expect(attrs['env']).toBe('prod');
    });

    it('user-provided service.name wins over default', () => {
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.name': 'qwen-code-ci',
      });
      initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.name']).toBe('qwen-code-ci');
    });

    it('user-provided service.version is ignored (runtime value wins)', () => {
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.version': '99.0.0-fake',
      });
      initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.version']).toBe('1.0.0-test');
    });

    it('empty-string service.name from settings falls back to default', () => {
      // Reviewer caught: `??` would let "" pass; `||` correctly falls back
      // so backends never see a blank service name.
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.name': '',
      });
      initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.name']).toBe('qwen-code');
    });

    it('whitespace-only service.name from settings falls back to default', () => {
      // Reviewer caught: plain `||` lets `" "` through (truthy). The
      // `.trim() || SERVICE_NAME` fallback covers both empty and
      // whitespace-only values (env path can produce these via `%20`).
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.name': '   ',
      });
      initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.name']).toBe('qwen-code');
    });

    it('emits a console summary when resource-attribute warnings are present', () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      try {
        vi.spyOn(
          mockConfig,
          'getTelemetryResourceAttributeWarnings',
        ).mockReturnValue([
          'OTEL_RESOURCE_ATTRIBUTES cannot override reserved key "service.version"; ignoring',
          'Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: "bogus"',
        ]);
        initializeTelemetry(mockConfig);
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

    it('no console output when warnings list is empty', () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      try {
        initializeTelemetry(mockConfig);
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it('user-provided session.id is stripped (defense-in-depth)', () => {
      // Simulates a caller that bypasses resolveTelemetrySettings() and feeds
      // raw user input straight into Config. Resource must still not carry
      // session.id, otherwise it would leak onto every metric data point.
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'session.id': 'spoofed',
        team: 'x',
      });
      initializeTelemetry(mockConfig);
      const attrs = getResourceAttributes();
      expect(attrs['session.id']).toBeUndefined();
      expect(attrs['team']).toBe('x');
    });
  });

  describe('Outbound trace-context propagation gate', () => {
    function getTextMapPropagator(): unknown {
      const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
      return (constructorCall as { textMapPropagator?: unknown })
        .textMapPropagator;
    }

    it('installs a no-op TextMapPropagator by default (propagateTraceContext=false)', () => {
      // Default behavior per PR #4390 R4 split: traceparent is NOT written
      // onto outbound wire. The propagator's inject() must be a no-op so
      // UndiciInstrumentation's `propagation.inject(carrier)` call writes
      // nothing into the outgoing request's headers.
      initializeTelemetry(mockConfig);
      const propagator = getTextMapPropagator() as
        | { inject: (...args: unknown[]) => void; fields: () => string[] }
        | undefined;
      expect(propagator).toBeDefined();
      expect(typeof propagator!.inject).toBe('function');
      // Sanity: fields() returns empty array → instrumentation knows there
      // are no headers to clear / no propagator state.
      expect(propagator!.fields()).toEqual([]);
      // inject is a no-op — does not throw, does not mutate the carrier.
      const carrier: Record<string, string> = { existing: 'h' };
      expect(() =>
        propagator!.inject({} as never, carrier, {} as never),
      ).not.toThrow();
      expect(carrier).toEqual({ existing: 'h' });
    });

    it('uses the SDK default propagator when propagateTraceContext=true (operator opt-in)', () => {
      vi.spyOn(
        mockConfig,
        'getOutboundCorrelationPropagateTraceContext',
      ).mockReturnValue(true);
      initializeTelemetry(mockConfig);
      // textMapPropagator is omitted from NodeSDK options → SDK installs
      // its default `CompositePropagator` (W3CTraceContextPropagator +
      // W3CBaggagePropagator). Test asserts the absence at the constructor
      // boundary because the default composite is constructed inside
      // @opentelemetry/sdk-node, which is auto-mocked here.
      expect(getTextMapPropagator()).toBeUndefined();
    });
  });

  describe('Instrumentations', () => {
    function getInstrumentations(): unknown[] {
      const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
      return (constructorCall.instrumentations ?? []) as unknown[];
    }

    it('registers both HttpInstrumentation and UndiciInstrumentation', () => {
      initializeTelemetry(mockConfig);
      const instrumentations = getInstrumentations();
      // The mocks make HttpInstrumentation / UndiciInstrumentation auto-mocked
      // classes; instance-of checks against the mocked class still work.
      expect(
        instrumentations.some((i) => i instanceof HttpInstrumentation),
      ).toBe(true);
      expect(
        instrumentations.some((i) => i instanceof UndiciInstrumentation),
      ).toBe(true);
    });

    it('UndiciInstrumentation receives ignoreRequestHook that skips configured OTLP endpoints', () => {
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      // Configured OTLP endpoint must be skipped to avoid feedback loops.
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces',
        }),
      ).toBe(true);
      // Non-OTLP URLs (e.g. an LLM provider) must be traced.
      expect(
        config.ignoreRequestHook({
          origin: 'https://dashscope.aliyuncs.com',
          path: '/compatible-mode/v1/chat/completions',
        }),
      ).toBe(false);
    });

    it('ignoreRequestHook is a pure no-op when no OTLP endpoint is configured', () => {
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue('');
      vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpLogsEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpMetricsEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOutfile').mockReturnValue('/tmp/x');
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      // No OTLP endpoint → nothing to ignore. Returning false means every
      // request gets a client span (the desired behavior in outfile mode).
      expect(
        config.ignoreRequestHook({
          origin: 'https://api.openai.com',
          path: '/v1/chat/completions',
        }),
      ).toBe(false);
    });

    it('ignoreRequestHook handles per-signal endpoint configuration', () => {
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue('');
      vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
        'http://traces.example.com:4318/v1/traces',
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpLogsEndpoint').mockReturnValue(
        'http://logs.example.com:4318/v1/logs',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      // Traces endpoint matched verbatim.
      expect(
        config.ignoreRequestHook({
          origin: 'http://traces.example.com:4318',
          path: '/v1/traces',
        }),
      ).toBe(true);
      // Logs endpoint matched verbatim.
      expect(
        config.ignoreRequestHook({
          origin: 'http://logs.example.com:4318',
          path: '/v1/logs',
        }),
      ).toBe(true);
      // Unrelated host not skipped.
      expect(
        config.ignoreRequestHook({
          origin: 'https://api.openai.com',
          path: '/v1/chat/completions',
        }),
      ).toBe(false);
    });

    it('ignoreRequestHook strips query string from incoming path for matching', () => {
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      // OTel SDK may append query params to OTLP requests; we still want
      // those to be ignored.
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces?token=secret',
        }),
      ).toBe(true);
    });

    it('ignoreRequestHook strips #fragment from incoming path for matching', () => {
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces#fragment',
        }),
      ).toBe(true);
    });

    it('ignoreRequestHook normalizes endpoint config quoted in settings.json', () => {
      // Defense against settings.json `"otlpEndpoint": "\"http://...\""` —
      // quoted strings would otherwise miss the prefix match and reintroduce
      // the feedback loop. Per PR review feedback.
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        '"http://collector.example.com:4318"',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('ignoreRequestHook strips #fragment from configured endpoint', () => {
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318/v1/traces#anchor',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('ignoreRequestHook does NOT bleed across port boundary (4318 vs 43180)', () => {
      // Defense against the URL prefix boundary collision: a naive
      // `url.startsWith(prefix)` would match `http://host:43180/...` against
      // prefix `http://host:4318`. Origin comparison is exact, so a
      // different port has a different origin and must not match.
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:43180',
          path: '/v1/traces',
        }),
      ).toBe(false);
    });

    it('ignoreRequestHook does NOT bleed across hostname boundary (otlp vs otlp.evil)', () => {
      // Defense against the hostname suffix collision: prefix
      // `https://otlp.example.com` must NOT match
      // `https://otlp.example.com.evil.net`. Origin comparison is exact.
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'https://otlp.example.com',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      expect(
        config.ignoreRequestHook({
          origin: 'https://otlp.example.com.evil.net',
          path: '/v1/traces',
        }),
      ).toBe(false);
    });

    it('ignoreRequestHook does NOT bleed across path-segment boundary (/v1 vs /v1foo)', () => {
      // Prefix `http://host/v1` must NOT match `http://host/v1foo/x`.
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318/v1',
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1foo/x',
        }),
      ).toBe(false);
      // Sanity: same-origin match still works.
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('normalizeOtlpPrefix rejects unparseable URLs entirely (no dangerous "http" fallback)', () => {
      // Critical fix: previously the catch fallback would let a typo like
      // `"http"` produce the prefix `"http"`, which startsWith-matches every
      // outbound HTTP request → silently disabled all instrumentation. The
      // fix returns undefined for unparseable URLs and warns via diag.
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'not-a-valid-url',
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpLogsEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpMetricsEndpoint').mockReturnValue(
        undefined,
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      // Unparseable endpoint produced NO prefix → hook is a no-op. Outbound
      // LLM requests are NOT erroneously masked (this is the danger we
      // prevent — the previous "http" fallback would mask everything).
      expect(
        config.ignoreRequestHook({
          origin: 'https://api.openai.com',
          path: '/v1/chat/completions',
        }),
      ).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('not a valid URL'),
      );
      warnSpy.mockRestore();
    });

    it('HttpInstrumentation also receives ignoreOutgoingRequestHook for OTLP exporter', () => {
      // The OTLP HTTP exporter uses node:http (patched by HttpInstrumentation,
      // NOT undici). Without this guard, every OTLP upload batch creates a
      // parasitic client span → feedback loop. PR #4390 review feedback.
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const httpInstrumentationConfig = vi.mocked(HttpInstrumentation).mock
        .calls[0]![0]! as {
        ignoreOutgoingRequestHook: (req: {
          protocol: string;
          host?: string;
          hostname?: string;
          port?: string | number;
          path: string;
        }) => boolean;
      };
      // OTLP upload to configured collector → skipped.
      expect(
        httpInstrumentationConfig.ignoreOutgoingRequestHook({
          protocol: 'http:',
          host: 'collector.example.com:4318',
          hostname: 'collector.example.com',
          port: 4318,
          path: '/v1/traces',
        }),
      ).toBe(true);
      // Unrelated LLM endpoint → traced.
      expect(
        httpInstrumentationConfig.ignoreOutgoingRequestHook({
          protocol: 'https:',
          host: 'dashscope.aliyuncs.com',
          hostname: 'dashscope.aliyuncs.com',
          path: '/compatible-mode/v1/chat/completions',
        }),
      ).toBe(false);
    });

    it('matches default-port requests against a portless prefix (URL.origin parity)', () => {
      // Regression: `URL.origin` strips `:80` from `http://collector` to give
      // `http://collector`. The hook's manual `${proto}://${host}${portPart}`
      // reconstruction kept `:80`, so prefix and request origin diverged →
      // guard bypassed → feedback loop. PR #4390 review feedback (wenshao).
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com',
      );
      initializeTelemetry(mockConfig);
      const httpInstrumentationConfig = vi.mocked(HttpInstrumentation).mock
        .calls[0]![0]! as {
        ignoreOutgoingRequestHook: (req: {
          protocol: string;
          host?: string;
          hostname?: string;
          port?: string | number;
          path: string;
        }) => boolean;
      };
      // Default port HTTP request to portless prefix → must match.
      expect(
        httpInstrumentationConfig.ignoreOutgoingRequestHook({
          protocol: 'http:',
          hostname: 'collector.example.com',
          port: 80,
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('fails open when req.protocol is missing (no silent HTTPS guard bypass)', () => {
      // Regression: previous `|| 'http'` fallback silently mis-bucketed HTTPS
      // requests as HTTP when `req.protocol` was unset, so HTTPS OTLP
      // endpoints never matched their prefix → guard bypassed. Now: missing
      // proto → return false → request gets instrumented (worst case is a
      // parasitic span, observable; the previous default produced an
      // unbounded feedback loop). PR #4390 review feedback (wenshao).
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'https://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const httpInstrumentationConfig = vi.mocked(HttpInstrumentation).mock
        .calls[0]![0]! as {
        ignoreOutgoingRequestHook: (req: {
          protocol?: string;
          host?: string;
          hostname?: string;
          port?: string | number;
          path: string;
        }) => boolean;
      };
      expect(
        httpInstrumentationConfig.ignoreOutgoingRequestHook({
          // protocol intentionally omitted
          hostname: 'collector.example.com',
          port: 4318,
          path: '/v1/traces',
        }),
      ).toBe(false);
    });

    it('strips port from req.host fallback to avoid `host:port:port` URL reject', () => {
      // Defensive: when `req.hostname` is absent and `req.host` already
      // includes `:port` (e.g. `"collector:4318"`), naively appending
      // `:${req.port}` produced `"http://collector:4318:4318"`, which
      // `URL` rejects → silent guard bypass. Currently unreachable in
      // practice (`@opentelemetry/otlp-exporter-base` always sets
      // `hostname`) but the fallback path must be correct. PR #4390
      // review feedback (wenshao).
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        'http://collector.example.com:4318',
      );
      initializeTelemetry(mockConfig);
      const httpInstrumentationConfig = vi.mocked(HttpInstrumentation).mock
        .calls[0]![0]! as {
        ignoreOutgoingRequestHook: (req: {
          protocol: string;
          host?: string;
          hostname?: string;
          port?: string | number;
          path: string;
        }) => boolean;
      };
      expect(
        httpInstrumentationConfig.ignoreOutgoingRequestHook({
          protocol: 'http:',
          // hostname intentionally absent; host carries the port already
          host: 'collector.example.com:4318',
          port: 4318,
          path: '/v1/traces',
        }),
      ).toBe(true);
    });

    it('normalizeOtlpPrefix strips asymmetric quotes for parity with parseOtlpEndpoint', () => {
      // parseOtlpEndpoint (line 109) uses /^["']|["']$/g which strips
      // asymmetric leading/trailing quotes. Previously normalizeOtlpPrefix
      // only stripped symmetric quotes, so settings.json typos like
      // `"value'` would let the exporter connect (parseOtlpEndpoint accepts)
      // while the guard returned undefined (normalizeOtlpPrefix rejected) →
      // parasitic-span loop. PR #4390 review feedback (wenshao).
      vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
      vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
        '"http://collector.example.com:4318\'',
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpTracesEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpLogsEndpoint').mockReturnValue(
        undefined,
      );
      vi.spyOn(mockConfig, 'getTelemetryOtlpMetricsEndpoint').mockReturnValue(
        undefined,
      );
      initializeTelemetry(mockConfig);
      const config = vi.mocked(UndiciInstrumentation).mock.calls[0]![0]! as {
        ignoreRequestHook: (req: { origin: string; path: string }) => boolean;
      };
      // Asymmetric-quoted endpoint normalized → guard matches OTLP traffic.
      expect(
        config.ignoreRequestHook({
          origin: 'http://collector.example.com:4318',
          path: '/v1/traces',
        }),
      ).toBe(true);
    });
  });
});

describe('refreshSessionContext', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getTelemetryEnabled: () => true,
      getTelemetryOtlpEndpoint: () => 'http://localhost:4317',
      getTelemetryOtlpProtocol: () => 'grpc',
      getTelemetryOtlpTracesEndpoint: () => undefined,
      getTelemetryOtlpLogsEndpoint: () => undefined,
      getTelemetryOtlpMetricsEndpoint: () => undefined,
      getTelemetryTarget: () => 'local',
      getTelemetryOutfile: () => undefined,
      getTelemetryResourceAttributes: () => ({}),
      getTelemetryMetricsIncludeSessionId: () => false,
      getTelemetryResourceAttributeWarnings: () => [],
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
      getCliVersion: () => '1.0.0-test',
      getOutboundCorrelationPropagateTraceContext: () => false,
    } as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('should update session context when telemetry is initialized', () => {
    initializeTelemetry(mockConfig);

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

  it('should not throw when refreshing session context fails', () => {
    initializeTelemetry(mockConfig);
    vi.clearAllMocks();
    vi.mocked(createSessionRootContext).mockImplementationOnce(() => {
      throw new Error('session context failed');
    });

    expect(() => refreshSessionContext('bad-session')).not.toThrow();

    expect(createSessionRootContext).toHaveBeenCalledWith('bad-session');
    expect(setSessionContext).not.toHaveBeenCalled();
  });
});

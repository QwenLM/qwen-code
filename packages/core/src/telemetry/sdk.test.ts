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
vi.mock('./gcp-exporters.js');
vi.mock('./log-to-span-processor.js');
vi.mock('./session-context.js');
vi.mock('./tracer.js', () => ({
  createSessionRootContext: vi.fn((id: string) => ({ __sessionId: id })),
}));

import { LogToSpanProcessor } from './log-to-span-processor.js';
import { setSessionContext } from './session-context.js';
import { createSessionRootContext } from './tracer.js';

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
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
      getCliVersion: () => '1.0.0-test',
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
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
      getCliVersion: () => '1.0.0-test',
    } as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('should update session context when telemetry is initialized', () => {
    initializeTelemetry(mockConfig);

    refreshSessionContext('new-session-id');

    expect(createSessionRootContext).toHaveBeenCalledWith('new-session-id');
    expect(setSessionContext).toHaveBeenCalledWith({
      __sessionId: 'new-session-id',
    });
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

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../config/config.js';
import { initializeTelemetry, shutdownTelemetry } from './sdk.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TelemetryTarget } from './index.js';

import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@opentelemetry/exporter-trace-otlp-grpc');
vi.mock('@opentelemetry/exporter-logs-otlp-grpc');
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc');
vi.mock('@opentelemetry/exporter-trace-otlp-http');
vi.mock('@opentelemetry/exporter-logs-otlp-http');
vi.mock('@opentelemetry/exporter-metrics-otlp-http');
vi.mock('@opentelemetry/sdk-node');
vi.mock('./gcp-exporters.js');

describe('Telemetry SDK', () => {
  let mockConfig: Config;
  // Save and clear Langfuse env vars so host environment doesn't affect assertions
  const LANGFUSE_VARS = [
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
  ] as const;
  const savedLangfuseEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear Langfuse keys to prevent host env from leaking into telemetry tests
    for (const key of LANGFUSE_VARS) {
      savedLangfuseEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockConfig = {
      getTelemetryEnabled: () => true,
      getTelemetryOtlpEndpoint: () => 'http://localhost:4317',
      getTelemetryOtlpProtocol: () => 'grpc',
      getTelemetryTarget: () => 'local',
      getTelemetryUseCollector: () => false,
      getTelemetryOutfile: () => undefined,
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
    // Restore Langfuse env vars
    for (const key of LANGFUSE_VARS) {
      if (savedLangfuseEnv[key] !== undefined) {
        process.env[key] = savedLangfuseEnv[key];
      } else {
        delete process.env[key];
      }
    }
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
  });

  it('should use HTTP exporters when protocol is http', () => {
    vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'http://localhost:4318',
    );

    initializeTelemetry(mockConfig);

    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/',
    });
    expect(OTLPLogExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/',
    });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/',
    });
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
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

  it('should parse HTTP endpoint correctly', () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'https://my-collector.com',
    );
    initializeTelemetry(mockConfig);
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com/' }),
    );
  });

  it('should use OTLP exporters when target is gcp but useCollector is true', () => {
    vi.spyOn(mockConfig, 'getTelemetryTarget').mockReturnValue(
      TelemetryTarget.GCP,
    );
    vi.spyOn(mockConfig, 'getTelemetryUseCollector').mockReturnValue(true);

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
  });

  describe('Langfuse BatchSpanProcessor', () => {
    it('is added when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';

      initializeTelemetry(mockConfig);

      // NodeSDK should be constructed with 2 span processors:
      // one for the primary OTLP exporter and one for Langfuse
      const sdkCalls = vi.mocked(NodeSDK).mock.calls;
      expect(sdkCalls.length).toBe(1);
      const spanProcessors = sdkCalls[0][0]?.spanProcessors;
      expect(spanProcessors).toBeDefined();
      expect(spanProcessors).toHaveLength(2);
    });

    it('is not added when env vars are absent', () => {
      // Langfuse env vars are already cleared by beforeEach
      initializeTelemetry(mockConfig);

      const sdkCalls = vi.mocked(NodeSDK).mock.calls;
      expect(sdkCalls.length).toBe(1);
      const spanProcessors = sdkCalls[0][0]?.spanProcessors;
      expect(spanProcessors).toBeDefined();
      expect(spanProcessors).toHaveLength(1);
    });

    it('is not added when only LANGFUSE_PUBLIC_KEY is set', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';

      initializeTelemetry(mockConfig);

      const sdkCalls = vi.mocked(NodeSDK).mock.calls;
      expect(sdkCalls.length).toBe(1);
      const spanProcessors = sdkCalls[0][0]?.spanProcessors;
      expect(spanProcessors).toHaveLength(1);
    });

    it('is not added when only LANGFUSE_SECRET_KEY is set', () => {
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';

      initializeTelemetry(mockConfig);

      const sdkCalls = vi.mocked(NodeSDK).mock.calls;
      expect(sdkCalls.length).toBe(1);
      const spanProcessors = sdkCalls[0][0]?.spanProcessors;
      expect(spanProcessors).toHaveLength(1);
    });

    it('uses default cloud.langfuse.com URL when LANGFUSE_BASE_URL is not set', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';

      initializeTelemetry(mockConfig);

      // The Langfuse exporter is an OTLPTraceExporterHttp — find the call
      // that targets the Langfuse OTLP endpoint (as opposed to the primary one).
      const httpExporterCalls = vi.mocked(OTLPTraceExporterHttp).mock.calls;
      const langfuseCall = httpExporterCalls.find((call) =>
        (call[0] as { url?: string })?.url?.includes('langfuse'),
      );
      expect(langfuseCall).toBeDefined();
      expect((langfuseCall![0] as { url: string }).url).toBe(
        'https://cloud.langfuse.com/api/public/otel/v1/traces',
      );
    });

    it('uses custom LANGFUSE_BASE_URL when set', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
      process.env['LANGFUSE_BASE_URL'] = 'https://my-langfuse.example.com';

      initializeTelemetry(mockConfig);

      const httpExporterCalls = vi.mocked(OTLPTraceExporterHttp).mock.calls;
      const langfuseCall = httpExporterCalls.find((call) =>
        (call[0] as { url?: string })?.url?.includes('langfuse'),
      );
      expect(langfuseCall).toBeDefined();
      expect((langfuseCall![0] as { url: string }).url).toBe(
        'https://my-langfuse.example.com/api/public/otel/v1/traces',
      );
    });

    it('sends Basic auth header with base64-encoded credentials', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';

      initializeTelemetry(mockConfig);

      const httpExporterCalls = vi.mocked(OTLPTraceExporterHttp).mock.calls;
      const langfuseCall = httpExporterCalls.find((call) =>
        (call[0] as { url?: string })?.url?.includes('langfuse'),
      );
      expect(langfuseCall).toBeDefined();

      const expectedCredentials = Buffer.from('pk-lf-test:sk-lf-test').toString(
        'base64',
      );
      expect(
        (langfuseCall![0] as { headers: Record<string, string> }).headers,
      ).toEqual({
        Authorization: `Basic ${expectedCredentials}`,
      });
    });

    it('still initializes telemetry when only Langfuse is configured and primary telemetry is disabled', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
      vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(false);

      initializeTelemetry(mockConfig);

      // Should still start the SDK because Langfuse processor is non-null
      expect(NodeSDK.prototype.start).toHaveBeenCalled();
    });
  });
});

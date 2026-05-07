/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseBooleanEnvFlag,
  parseTelemetryTargetValue,
  resolveTelemetrySettings,
} from './config.js';
import { TelemetryTarget } from './index.js';

describe('telemetry/config helpers', () => {
  describe('parseBooleanEnvFlag', () => {
    it('returns undefined for undefined', () => {
      expect(parseBooleanEnvFlag(undefined)).toBeUndefined();
    });

    it('parses true values', () => {
      expect(parseBooleanEnvFlag('true')).toBe(true);
      expect(parseBooleanEnvFlag('1')).toBe(true);
    });

    it('parses false/other values as false', () => {
      expect(parseBooleanEnvFlag('false')).toBe(false);
      expect(parseBooleanEnvFlag('0')).toBe(false);
      expect(parseBooleanEnvFlag('TRUE')).toBe(false);
      expect(parseBooleanEnvFlag('random')).toBe(false);
      expect(parseBooleanEnvFlag('')).toBe(false);
    });
  });

  describe('parseTelemetryTargetValue', () => {
    it('parses string values', () => {
      expect(parseTelemetryTargetValue('local')).toBe(TelemetryTarget.LOCAL);
      expect(parseTelemetryTargetValue('gcp')).toBe(TelemetryTarget.GCP);
    });

    it('accepts enum values', () => {
      expect(parseTelemetryTargetValue(TelemetryTarget.LOCAL)).toBe(
        TelemetryTarget.LOCAL,
      );
      expect(parseTelemetryTargetValue(TelemetryTarget.GCP)).toBe(
        TelemetryTarget.GCP,
      );
    });

    it('returns undefined for unknown', () => {
      expect(parseTelemetryTargetValue('other')).toBeUndefined();
      expect(parseTelemetryTargetValue(undefined)).toBeUndefined();
    });
  });

  describe('resolveTelemetrySettings', () => {
    it('falls back to settings when no argv/env provided', async () => {
      const settings = {
        enabled: false,
        target: TelemetryTarget.LOCAL,
        otlpEndpoint: 'http://localhost:4317',
        otlpProtocol: 'grpc' as const,
        logPrompts: false,
        includeSensitiveSpanAttributes: true,
        outfile: 'settings.log',
        useCollector: false,
      };
      const resolved = await resolveTelemetrySettings({ settings });
      expect(resolved).toEqual({
        ...settings,
        otlpTracesEndpoint: undefined,
        otlpLogsEndpoint: undefined,
        otlpMetricsEndpoint: undefined,
      });
    });

    it('uses env over settings and argv over env', async () => {
      const settings = {
        enabled: false,
        target: TelemetryTarget.LOCAL,
        otlpEndpoint: 'http://settings:4317',
        otlpProtocol: 'grpc' as const,
        logPrompts: false,
        includeSensitiveSpanAttributes: false,
        outfile: 'settings.log',
        useCollector: false,
      };
      const env = {
        QWEN_TELEMETRY_ENABLED: '1',
        QWEN_TELEMETRY_TARGET: 'gcp',
        QWEN_TELEMETRY_OTLP_ENDPOINT: 'http://env:4317',
        QWEN_TELEMETRY_OTLP_PROTOCOL: 'http',
        QWEN_TELEMETRY_LOG_PROMPTS: 'true',
        QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'true',
        QWEN_TELEMETRY_OUTFILE: 'env.log',
        QWEN_TELEMETRY_USE_COLLECTOR: 'true',
      } as Record<string, string>;
      const argv = {
        telemetry: false,
        telemetryTarget: 'local',
        telemetryOtlpEndpoint: 'http://argv:4317',
        telemetryOtlpProtocol: 'grpc',
        telemetryLogPrompts: false,
        telemetryOutfile: 'argv.log',
      };

      const resolvedEnv = await resolveTelemetrySettings({ env, settings });
      expect(resolvedEnv).toEqual({
        enabled: true,
        target: TelemetryTarget.GCP,
        otlpEndpoint: 'http://env:4317',
        otlpProtocol: 'http',
        otlpTracesEndpoint: undefined,
        otlpLogsEndpoint: undefined,
        otlpMetricsEndpoint: undefined,
        logPrompts: true,
        includeSensitiveSpanAttributes: true,
        outfile: 'env.log',
        useCollector: true,
      });

      const resolvedArgv = await resolveTelemetrySettings({
        argv,
        env,
        settings,
      });
      expect(resolvedArgv).toEqual({
        enabled: false,
        target: TelemetryTarget.LOCAL,
        otlpEndpoint: 'http://argv:4317',
        otlpProtocol: 'grpc',
        otlpTracesEndpoint: undefined,
        otlpLogsEndpoint: undefined,
        otlpMetricsEndpoint: undefined,
        logPrompts: false,
        includeSensitiveSpanAttributes: true,
        outfile: 'argv.log',
        useCollector: true, // from env as no argv option
      });
    });

    it('defaults includeSensitiveSpanAttributes to false', async () => {
      const resolved = await resolveTelemetrySettings({});

      expect(resolved.includeSensitiveSpanAttributes).toBe(false);
    });

    it('parses includeSensitiveSpanAttributes from settings and env', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: { includeSensitiveSpanAttributes: true },
      });
      expect(resolvedFromSettings.includeSensitiveSpanAttributes).toBe(true);

      const resolvedEnvTrue = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: '1',
        },
        settings: { includeSensitiveSpanAttributes: false },
      });
      expect(resolvedEnvTrue.includeSensitiveSpanAttributes).toBe(true);

      const resolvedEnvFalse = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'false',
        },
        settings: { includeSensitiveSpanAttributes: true },
      });
      expect(resolvedEnvFalse.includeSensitiveSpanAttributes).toBe(false);
    });

    it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT when GEMINI var is missing', async () => {
      const settings = {};
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4317',
      } as Record<string, string>;
      const resolved = await resolveTelemetrySettings({ env, settings });
      expect(resolved.otlpEndpoint).toBe('http://otel:4317');
    });

    it('throws on unknown protocol values', async () => {
      const env = { QWEN_TELEMETRY_OTLP_PROTOCOL: 'unknown' } as Record<
        string,
        string
      >;
      await expect(resolveTelemetrySettings({ env })).rejects.toThrow(
        /Invalid telemetry OTLP protocol/i,
      );
    });

    it('throws on unknown target values', async () => {
      const env = { QWEN_TELEMETRY_TARGET: 'unknown' } as Record<
        string,
        string
      >;
      await expect(resolveTelemetrySettings({ env })).rejects.toThrow(
        /Invalid telemetry target/i,
      );
    });

    it('resolves per-signal endpoints from OTEL_ env vars', async () => {
      const env = {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/v1/logs',
      } as Record<string, string>;

      const resolved = await resolveTelemetrySettings({ env });
      expect(resolved.otlpTracesEndpoint).toBe('http://traces:4318/v1/traces');
      expect(resolved.otlpLogsEndpoint).toBe('http://logs:4318/v1/logs');
      expect(resolved.otlpMetricsEndpoint).toBeUndefined();
    });

    it('QWEN_ env vars take precedence over OTEL_ vars for per-signal endpoints', async () => {
      const env = {
        QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT:
          'http://qwen-traces:4318/v1/traces',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-traces:4318/v1/traces',
      } as Record<string, string>;

      const resolved = await resolveTelemetrySettings({ env });
      expect(resolved.otlpTracesEndpoint).toBe(
        'http://qwen-traces:4318/v1/traces',
      );
    });

    it('resolves per-signal endpoints from settings', async () => {
      const settings = {
        otlpTracesEndpoint: 'http://traces-settings:4318/v1/traces',
        otlpMetricsEndpoint: 'http://metrics-settings:4318/v1/metrics',
      };

      const resolved = await resolveTelemetrySettings({ settings });
      expect(resolved.otlpTracesEndpoint).toBe(
        'http://traces-settings:4318/v1/traces',
      );
      expect(resolved.otlpLogsEndpoint).toBeUndefined();
      expect(resolved.otlpMetricsEndpoint).toBe(
        'http://metrics-settings:4318/v1/metrics',
      );
    });
  });
});

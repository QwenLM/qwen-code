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
        sensitiveSpanAttributeMaxLength: 1234,
        outfile: 'settings.log',
      };
      const resolved = await resolveTelemetrySettings({ settings });
      expect(resolved).toEqual({
        ...settings,
        otlpTracesEndpoint: undefined,
        otlpLogsEndpoint: undefined,
        otlpMetricsEndpoint: undefined,
        resourceAttributes: undefined,
        metrics: { includeSessionId: false },
        resourceAttributeWarnings: undefined,
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
        sensitiveSpanAttributeMaxLength: 1234,
        outfile: 'settings.log',
      };
      const env = {
        QWEN_TELEMETRY_ENABLED: '1',
        QWEN_TELEMETRY_TARGET: 'gcp',
        QWEN_TELEMETRY_OTLP_ENDPOINT: 'http://env:4317',
        QWEN_TELEMETRY_OTLP_PROTOCOL: 'http',
        QWEN_TELEMETRY_LOG_PROMPTS: 'true',
        QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'true',
        QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '2048',
        QWEN_TELEMETRY_OUTFILE: 'env.log',
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
        sensitiveSpanAttributeMaxLength: 2048,
        outfile: 'env.log',
        resourceAttributes: undefined,
        metrics: { includeSessionId: false },
        resourceAttributeWarnings: undefined,
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
        sensitiveSpanAttributeMaxLength: 2048,
        outfile: 'argv.log',
        resourceAttributes: undefined,
        metrics: { includeSessionId: false },
        resourceAttributeWarnings: undefined,
      });
    });

    it('defaults includeSensitiveSpanAttributes to false', async () => {
      const resolved = await resolveTelemetrySettings({});

      expect(resolved.includeSensitiveSpanAttributes).toBe(false);
    });

    it('defaults sensitiveSpanAttributeMaxLength to 1MiB', async () => {
      const resolved = await resolveTelemetrySettings({});

      expect(resolved.sensitiveSpanAttributeMaxLength).toBe(1024 * 1024);
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

    it('parses sensitiveSpanAttributeMaxLength from settings and env', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: { sensitiveSpanAttributeMaxLength: 65_536 },
      });
      expect(resolvedFromSettings.sensitiveSpanAttributeMaxLength).toBe(65_536);

      const resolvedFromEnv = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '131072',
        },
        settings: { sensitiveSpanAttributeMaxLength: 65_536 },
      });
      expect(resolvedFromEnv.sensitiveSpanAttributeMaxLength).toBe(131_072);
    });

    it('rejects invalid sensitiveSpanAttributeMaxLength settings', async () => {
      await expect(
        resolveTelemetrySettings({
          settings: { sensitiveSpanAttributeMaxLength: 0 },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength/i);

      await expect(
        resolveTelemetrySettings({
          settings: {
            sensitiveSpanAttributeMaxLength: 1.5,
          },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength/i);
    });

    it('rejects invalid sensitive span max length env values', async () => {
      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '',
          },
        }),
      ).rejects.toThrow(/QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH/);

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: 'abc',
          },
        }),
      ).rejects.toThrow(/QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH/);
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

  describe('resolveTelemetrySettings — resource attributes', () => {
    it('returns undefined resourceAttributes when nothing set', async () => {
      const resolved = await resolveTelemetrySettings({});
      expect(resolved.resourceAttributes).toBeUndefined();
    });

    it('parses OTEL_RESOURCE_ATTRIBUTES from env', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'team=platform,env=prod' },
      });
      expect(resolved.resourceAttributes).toEqual({
        team: 'platform',
        env: 'prod',
      });
    });

    it('merges settings on top of env (settings wins)', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'team=x,env=prod' },
        settings: { resourceAttributes: { team: 'y' } },
      });
      expect(resolved.resourceAttributes).toEqual({
        team: 'y',
        env: 'prod',
      });
    });

    it('reads service.name from OTEL_SERVICE_NAME alone', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_SERVICE_NAME: 'A' },
      });
      expect(resolved.resourceAttributes).toEqual({ 'service.name': 'A' });
    });

    it('reads service.name from OTEL_RESOURCE_ATTRIBUTES alone', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'service.name=B' },
      });
      expect(resolved.resourceAttributes).toEqual({ 'service.name': 'B' });
    });

    it('drops user-provided session.id from env with warning', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'session.id=spoofed,team=x' },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });

    it('drops user-provided session.id from settings with warning', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          resourceAttributes: { 'session.id': 'spoofed', team: 'x' },
        },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });

    it('trims whitespace-only OTEL_SERVICE_NAME (treats as unset)', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_SERVICE_NAME: '   ' },
      });
      // No user attrs → resourceAttributes stays undefined.
      expect(resolved.resourceAttributes).toBeUndefined();
    });

    it('exposes resourceAttributeWarnings when input has issues', async () => {
      const resolved = await resolveTelemetrySettings({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: 'bogus,service.version=1,team=ok',
        },
        settings: {
          resourceAttributes: {
            '': 'empty-key',
            // @ts-expect-error — runtime defensive path against bad JSON.
            count: 42,
          },
        },
      });
      expect(resolved.resourceAttributeWarnings).toBeDefined();
      // Expect at least: malformed pair, reserved service.version, empty key, non-string value.
      expect(resolved.resourceAttributeWarnings!.length).toBeGreaterThanOrEqual(
        4,
      );
    });

    it('leaves resourceAttributeWarnings undefined when input is clean', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'team=platform,env=prod' },
      });
      expect(resolved.resourceAttributeWarnings).toBeUndefined();
    });

    it('drops non-string settings values', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          resourceAttributes: {
            team: 'platform',
            // @ts-expect-error — runtime defensive path against bad JSON.
            count: 42,
          },
        },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'platform' });
    });

    it('OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES.service.name', async () => {
      const resolved = await resolveTelemetrySettings({
        env: {
          OTEL_SERVICE_NAME: 'A',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=B',
        },
      });
      expect(resolved.resourceAttributes?.['service.name']).toBe('A');
    });

    it('OTEL_SERVICE_NAME wins over settings.resourceAttributes.service.name', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_SERVICE_NAME: 'A' },
        settings: { resourceAttributes: { 'service.name': 'C' } },
      });
      expect(resolved.resourceAttributes?.['service.name']).toBe('A');
    });

    it('settings.service.name wins over env.OTEL_RESOURCE_ATTRIBUTES.service.name when no OTEL_SERVICE_NAME', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'service.name=B' },
        settings: { resourceAttributes: { 'service.name': 'C' } },
      });
      expect(resolved.resourceAttributes?.['service.name']).toBe('C');
    });

    it('strips service.version from env source', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'service.version=fake,team=x' },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });

    it('strips service.version from settings source', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          resourceAttributes: { 'service.version': 'fake', team: 'x' },
        },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });
  });

  describe('resolveTelemetrySettings — metrics.includeSessionId', () => {
    it('defaults to false', async () => {
      const resolved = await resolveTelemetrySettings({});
      expect(resolved.metrics?.includeSessionId).toBe(false);
    });

    it('reads from settings', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: { metrics: { includeSessionId: true } },
      });
      expect(resolved.metrics?.includeSessionId).toBe(true);
    });

    it('reads from env (override settings)', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID: 'true' },
        settings: { metrics: { includeSessionId: false } },
      });
      expect(resolved.metrics?.includeSessionId).toBe(true);
    });

    it('explicit env=false overrides settings=true', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID: 'false' },
        settings: { metrics: { includeSessionId: true } },
      });
      expect(resolved.metrics?.includeSessionId).toBe(false);
    });
  });
});

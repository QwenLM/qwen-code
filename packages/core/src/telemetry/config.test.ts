/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseBooleanEnvFlag,
  parseTelemetryTargetValue,
  resolveExtensionTelemetryProxy,
  resolveTelemetrySettings,
  resolveUsageStatisticsEnabled,
} from './config.js';
import {
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
  TelemetryTarget,
} from './index.js';

type Options = Parameters<typeof resolveTelemetrySettings>[0];

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
      for (const value of ['false', '0', 'TRUE', 'random', '']) {
        expect(parseBooleanEnvFlag(value)).toBe(false);
      }
    });
  });

  describe('resolveUsageStatisticsEnabled', () => {
    it('defaults to true when neither env nor settings are set', () => {
      expect(resolveUsageStatisticsEnabled(undefined, {})).toBe(true);
    });

    it('honors the settings value', () => {
      expect(resolveUsageStatisticsEnabled(false, {})).toBe(false);
      expect(resolveUsageStatisticsEnabled(true, {})).toBe(true);
    });

    it('prefers QWEN_USAGE_STATISTICS_ENABLED over settings', () => {
      const env = { QWEN_USAGE_STATISTICS_ENABLED: '0' };
      expect(resolveUsageStatisticsEnabled(true, env)).toBe(false);
      expect(
        resolveUsageStatisticsEnabled(false, {
          QWEN_USAGE_STATISTICS_ENABLED: '1',
        }),
      ).toBe(true);
    });

    it('treats unrecognized env values as false (parseBooleanEnvFlag semantics)', () => {
      expect(
        resolveUsageStatisticsEnabled(true, {
          QWEN_USAGE_STATISTICS_ENABLED: 'random',
        }),
      ).toBe(false);
    });
  });

  describe('resolveExtensionTelemetryProxy', () => {
    it('returns undefined when nothing is configured', () => {
      expect(resolveExtensionTelemetryProxy(undefined, {})).toBeUndefined();
    });

    it('prefers settings.proxy over every env key', () => {
      expect(
        resolveExtensionTelemetryProxy('http://settings:1', {
          HTTPS_PROXY: 'http://env:2',
        }),
      ).toBe('http://settings:1');
    });

    it('falls back to env keys in canonical order (uppercase first)', () => {
      expect(
        resolveExtensionTelemetryProxy(undefined, {
          HTTPS_PROXY: 'http://upper-https:1',
          https_proxy: 'http://lower-https:2',
          HTTP_PROXY: 'http://upper-http:3',
          http_proxy: 'http://lower-http:4',
        }),
      ).toBe('http://upper-https:1');
      // Each adjacent pair of the remaining terms is pinned on its own: this
      // chain mirrors the session's (`packages/cli/src/config/config.ts`), so
      // dropping or swapping a middle term has to red here instead of only
      // changing which hosts reach the sanctioned egress.
      expect(
        resolveExtensionTelemetryProxy(undefined, {
          https_proxy: 'http://lower-https:2',
          HTTP_PROXY: 'http://upper-http:3',
          http_proxy: 'http://lower-http:4',
        }),
      ).toBe('http://lower-https:2');
      expect(
        resolveExtensionTelemetryProxy(undefined, {
          HTTP_PROXY: 'http://upper-http:3',
          http_proxy: 'http://lower-http:4',
        }),
      ).toBe('http://upper-http:3');
      // `HTTP_PROXY` alone is the corporate/CI shape that exports no
      // `HTTPS_PROXY`: dropping that term sends the upload direct.
      expect(
        resolveExtensionTelemetryProxy(undefined, {
          HTTP_PROXY: 'http://upper-http:3',
        }),
      ).toBe('http://upper-http:3');
      expect(
        resolveExtensionTelemetryProxy(undefined, {
          http_proxy: 'http://lower-http:4',
        }),
      ).toBe('http://lower-http:4');
    });

    it('returns the raw value without normalizing (normalization lives in getTelemetryConfig)', () => {
      // A SOCKS value must pass through untouched: getTelemetryConfig drops
      // it in a try/catch so telemetry can never abort the mutation.
      expect(resolveExtensionTelemetryProxy('socks5h://h:1', {})).toBe(
        'socks5h://h:1',
      );
      expect(resolveExtensionTelemetryProxy('host:8080', {})).toBe('host:8080');
    });
  });

  describe('parseTelemetryTargetValue', () => {
    it('parses string values', () => {
      expect(parseTelemetryTargetValue('local')).toBe(TelemetryTarget.LOCAL);
      expect(parseTelemetryTargetValue('gcp')).toBe(TelemetryTarget.GCP);
    });

    it('accepts enum values', () => {
      for (const target of [TelemetryTarget.LOCAL, TelemetryTarget.GCP]) {
        expect(parseTelemetryTargetValue(target)).toBe(target);
      }
    });

    it('returns undefined for unknown', () => {
      expect(parseTelemetryTargetValue('other')).toBeUndefined();
      expect(parseTelemetryTargetValue(undefined)).toBeUndefined();
    });
  });

  describe('resolveTelemetrySettings', () => {
    const allSettings = {
      enabled: false,
      target: TelemetryTarget.LOCAL,
      otlpEndpoint: 'http://localhost:4317',
      otlpProtocol: 'grpc' as const,
      logPrompts: false,
      userId: 'settings-user',
      includeSensitiveSpanAttributes: true,
      sensitiveSpanAttributeMaxLength: 1234,
      outfile: 'settings.log',
    };
    // Resolved fields that none of the full-object cases set.
    const unsetFields = {
      otlpTracesEndpoint: undefined,
      otlpLogsEndpoint: undefined,
      otlpMetricsEndpoint: undefined,
      resourceAttributes: undefined,
      metrics: { includeSessionId: false },
      resourceAttributeWarnings: undefined,
    };

    it('falls back to settings when no argv/env provided', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: allSettings,
      });
      expect(resolved).toEqual({ ...allSettings, ...unsetFields });
    });

    it('uses env over settings and argv over env', async () => {
      const settings = {
        ...allSettings,
        otlpEndpoint: 'http://settings:4317',
        includeSensitiveSpanAttributes: false,
      };
      const env = {
        QWEN_TELEMETRY_ENABLED: '1',
        QWEN_TELEMETRY_TARGET: 'gcp',
        QWEN_TELEMETRY_OTLP_ENDPOINT: 'http://env:4317',
        QWEN_TELEMETRY_OTLP_PROTOCOL: 'http',
        QWEN_TELEMETRY_LOG_PROMPTS: 'true',
        QWEN_TELEMETRY_USER_ID: 'env-user',
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
      const fromEnv = {
        enabled: true,
        target: TelemetryTarget.GCP,
        otlpEndpoint: 'http://env:4317',
        otlpProtocol: 'http',
        logPrompts: true,
        userId: 'env-user',
        includeSensitiveSpanAttributes: true,
        sensitiveSpanAttributeMaxLength: 2048,
        outfile: 'env.log',
        ...unsetFields,
      };

      const resolvedEnv = await resolveTelemetrySettings({ env, settings });
      expect(resolvedEnv).toEqual(fromEnv);

      const resolvedArgv = await resolveTelemetrySettings({
        argv,
        env,
        settings,
      });
      // argv has no userId or sensitive-span flags, so those stay from env.
      expect(resolvedArgv).toEqual({
        ...fromEnv,
        enabled: false,
        target: TelemetryTarget.LOCAL,
        otlpEndpoint: 'http://argv:4317',
        otlpProtocol: 'grpc',
        logPrompts: false,
        outfile: 'argv.log',
      });
    });

    it('defaults includeSensitiveSpanAttributes to false', async () => {
      const resolved = await resolveTelemetrySettings({});

      expect(resolved.includeSensitiveSpanAttributes).toBe(false);
    });

    it('resolves and normalizes the telemetry user ID', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: { userId: '  user α  beta  ' },
      });
      expect(resolvedFromSettings.userId).toBe('user α  beta');

      const resolvedFromEnv = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_USER_ID: '  0  ' },
        settings: { userId: 'settings-user' },
      });
      expect(resolvedFromEnv.userId).toBe('0');
    });

    it('falls back to settings when the telemetry user ID env var is blank', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_USER_ID: '   ' },
        settings: { userId: ' settings-user ' },
      });

      expect(resolved.userId).toBe('settings-user');
    });

    it('omits the telemetry user ID when both sources are blank', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_USER_ID: '\t' },
        settings: { userId: ' ' },
      });

      expect(resolved.userId).toBeUndefined();
    });

    it('rejects a non-string telemetry user ID setting', async () => {
      await expect(
        resolveTelemetrySettings({
          settings: {
            // @ts-expect-error — runtime defensive path against bad JSON.
            userId: 42,
          },
        }),
      ).rejects.toThrow(/telemetry\.userId.*must be a string.*number/);
    });

    it('defaults sensitiveSpanAttributeMaxLength to 1MiB', async () => {
      const resolved = await resolveTelemetrySettings({});
      const resolvedMaxLength: number =
        resolved.sensitiveSpanAttributeMaxLength;

      expect(resolvedMaxLength).toBe(1024 * 1024);
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

    it('accepts sensitiveSpanAttributeMaxLength at the configured maximum', async () => {
      const max = SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT;
      for (const options of [
        { settings: { sensitiveSpanAttributeMaxLength: max } },
        {
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: String(max),
          },
        },
      ]) {
        const resolved = await resolveTelemetrySettings(options);
        expect(resolved.sensitiveSpanAttributeMaxLength).toBe(max);
      }
    });

    it('rejects invalid sensitiveSpanAttributeMaxLength settings', async () => {
      for (const [sensitiveSpanAttributeMaxLength, message] of [
        [0, /sensitiveSpanAttributeMaxLength.*got 0/i],
        [1.5, /sensitiveSpanAttributeMaxLength.*got 1\.5/i],
        [-1, /sensitiveSpanAttributeMaxLength.*got -1/i],
        [
          SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT + 1,
          /sensitiveSpanAttributeMaxLength.*104857600/i,
        ],
        [Number.NaN, /sensitiveSpanAttributeMaxLength.*got NaN/i],
      ] as const) {
        await expect(
          resolveTelemetrySettings({
            settings: { sensitiveSpanAttributeMaxLength },
          }),
        ).rejects.toThrow(message);
      }
    });

    it.each([
      ['string', '1024'],
      ['boolean', true],
    ])(
      'rejects non-number sensitiveSpanAttributeMaxLength settings (%s)',
      async (_type, value) => {
        const settings = {
          sensitiveSpanAttributeMaxLength: value,
        } as unknown as Parameters<
          typeof resolveTelemetrySettings
        >[0]['settings'];

        await expect(resolveTelemetrySettings({ settings })).rejects.toThrow(
          /sensitiveSpanAttributeMaxLength/i,
        );
      },
    );

    it('rejects invalid sensitive span max length env values', async () => {
      const name = 'QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH';
      const expectRejected = (value: string, message: RegExp) =>
        expect(
          resolveTelemetrySettings({ env: { [name]: value } }),
        ).rejects.toThrow(message);

      // None of these values holds a regex metacharacter.
      for (const value of ['', '   ', 'abc', '1e3', '0', '9007199254740992']) {
        await expectRejected(value, new RegExp(`${name}.*got '${value}'`));
      }
      await expectRejected(
        String(SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT + 1),
        new RegExp(`${name}.*104857600`),
      );
    });

    it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT when GEMINI var is missing', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4317' },
        settings: {},
      });
      expect(resolved.otlpEndpoint).toBe('http://otel:4317');
    });

    it('throws on unknown protocol values', async () => {
      await expect(
        resolveTelemetrySettings({
          env: { QWEN_TELEMETRY_OTLP_PROTOCOL: 'unknown' },
        }),
      ).rejects.toThrow(/Invalid telemetry OTLP protocol/i);
    });

    it('throws on unknown target values', async () => {
      await expect(
        resolveTelemetrySettings({ env: { QWEN_TELEMETRY_TARGET: 'unknown' } }),
      ).rejects.toThrow(/Invalid telemetry target/i);
    });

    it('resolves per-signal endpoints from OTEL_ env vars', async () => {
      const resolved = await resolveTelemetrySettings({
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/v1/logs',
        },
      });
      expect(resolved.otlpTracesEndpoint).toBe('http://traces:4318/v1/traces');
      expect(resolved.otlpLogsEndpoint).toBe('http://logs:4318/v1/logs');
      expect(resolved.otlpMetricsEndpoint).toBeUndefined();
    });

    it('QWEN_ env vars take precedence over OTEL_ vars for per-signal endpoints', async () => {
      const resolved = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT:
            'http://qwen-traces:4318/v1/traces',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
            'http://otel-traces:4318/v1/traces',
        },
      });
      expect(resolved.otlpTracesEndpoint).toBe(
        'http://qwen-traces:4318/v1/traces',
      );
    });

    it('resolves per-signal endpoints from settings', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          otlpTracesEndpoint: 'http://traces-settings:4318/v1/traces',
          otlpMetricsEndpoint: 'http://metrics-settings:4318/v1/metrics',
        },
      });
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

    it.each<[string, Options, Record<string, string>]>([
      [
        'parses OTEL_RESOURCE_ATTRIBUTES from env',
        { env: { OTEL_RESOURCE_ATTRIBUTES: 'team=platform,env=prod' } },
        {
          team: 'platform',
          env: 'prod',
        },
      ],
      [
        'merges settings on top of env (settings wins)',
        {
          env: { OTEL_RESOURCE_ATTRIBUTES: 'team=x,env=prod' },
          settings: { resourceAttributes: { team: 'y' } },
        },
        {
          team: 'y',
          env: 'prod',
        },
      ],
      [
        'reads service.name from OTEL_SERVICE_NAME alone',
        { env: { OTEL_SERVICE_NAME: 'A' } },
        { 'service.name': 'A' },
      ],
      [
        'reads service.name from OTEL_RESOURCE_ATTRIBUTES alone',
        { env: { OTEL_RESOURCE_ATTRIBUTES: 'service.name=B' } },
        { 'service.name': 'B' },
      ],
      [
        'drops user-provided session.id from env with warning',
        { env: { OTEL_RESOURCE_ATTRIBUTES: 'session.id=spoofed,team=x' } },
        { team: 'x' },
      ],
      [
        'drops user-provided session.id from settings with warning',
        {
          settings: {
            resourceAttributes: { 'session.id': 'spoofed', team: 'x' },
          },
        },
        { team: 'x' },
      ],
      [
        'drops non-string settings values',
        {
          settings: {
            resourceAttributes: {
              team: 'platform',
              // @ts-expect-error — runtime defensive path against bad JSON.
              count: 42,
            },
          },
        },
        { team: 'platform' },
      ],
      [
        'strips service.version from env source',
        { env: { OTEL_RESOURCE_ATTRIBUTES: 'service.version=fake,team=x' } },
        { team: 'x' },
      ],
      [
        'strips service.version from settings source',
        {
          settings: {
            resourceAttributes: { 'service.version': 'fake', team: 'x' },
          },
        },
        { team: 'x' },
      ],
    ])('%s', async (_title, options, attributes) => {
      const resolved = await resolveTelemetrySettings(options);
      expect(resolved.resourceAttributes).toEqual(attributes);
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

    it.each<[string, Options, string]>([
      [
        'OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES.service.name',
        {
          env: {
            OTEL_SERVICE_NAME: 'A',
            OTEL_RESOURCE_ATTRIBUTES: 'service.name=B',
          },
        },
        'A',
      ],
      [
        'OTEL_SERVICE_NAME wins over settings.resourceAttributes.service.name',
        {
          env: { OTEL_SERVICE_NAME: 'A' },
          settings: { resourceAttributes: { 'service.name': 'C' } },
        },
        'A',
      ],
      [
        'settings.service.name wins over env.OTEL_RESOURCE_ATTRIBUTES.service.name when no OTEL_SERVICE_NAME',
        {
          env: { OTEL_RESOURCE_ATTRIBUTES: 'service.name=B' },
          settings: { resourceAttributes: { 'service.name': 'C' } },
        },
        'C',
      ],
    ])('%s', async (_title, options, serviceName) => {
      const resolved = await resolveTelemetrySettings(options);
      expect(resolved.resourceAttributes?.['service.name']).toBe(serviceName);
    });
  });

  describe('resolveTelemetrySettings — metrics.includeSessionId', () => {
    it.each<[string, Options, boolean]>([
      ['defaults to false', {}, false],
      [
        'reads from settings',
        { settings: { metrics: { includeSessionId: true } } },
        true,
      ],
      [
        'reads from env (override settings)',
        {
          env: { QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID: 'true' },
          settings: { metrics: { includeSessionId: false } },
        },
        true,
      ],
      [
        'explicit env=false overrides settings=true',
        {
          env: { QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID: 'false' },
          settings: { metrics: { includeSessionId: true } },
        },
        false,
      ],
    ])('%s', async (_title, options, includeSessionId) => {
      const resolved = await resolveTelemetrySettings(options);
      expect(resolved.metrics?.includeSessionId).toBe(includeSessionId);
    });
  });
});

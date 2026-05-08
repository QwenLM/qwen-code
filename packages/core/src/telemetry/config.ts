/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TelemetrySettings } from '../config/config.js';
import { FatalConfigError } from '../utils/errors.js';
import { TelemetryTarget } from './index.js';

/**
 * Parse a boolean environment flag. Accepts 'true'/'1' as true.
 */
export function parseBooleanEnvFlag(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true' || value === '1';
}

/**
 * Normalize a telemetry target value into TelemetryTarget or undefined.
 */
export function parseTelemetryTargetValue(
  value: string | TelemetryTarget | undefined,
): TelemetryTarget | undefined {
  if (value === undefined) return undefined;
  if (value === TelemetryTarget.LOCAL || value === 'local') {
    return TelemetryTarget.LOCAL;
  }
  if (value === TelemetryTarget.GCP || value === 'gcp') {
    return TelemetryTarget.GCP;
  }
  return undefined;
}

export interface TelemetryArgOverrides {
  telemetry?: boolean;
  telemetryTarget?: string | TelemetryTarget;
  telemetryOtlpEndpoint?: string;
  telemetryOtlpProtocol?: string;
  telemetryLogPrompts?: boolean;
  telemetryOutfile?: string;
}

/**
 * Build TelemetrySettings by resolving from argv (highest), env, then settings.
 */
export async function resolveTelemetrySettings(options: {
  argv?: TelemetryArgOverrides;
  env?: Record<string, string | undefined>;
  settings?: TelemetrySettings;
}): Promise<TelemetrySettings> {
  const argv = options.argv ?? {};
  const env = options.env ?? {};
  const settings = options.settings ?? {};

  const enabled =
    argv.telemetry ??
    parseBooleanEnvFlag(env['QWEN_TELEMETRY_ENABLED']) ??
    settings.enabled;

  const rawTarget =
    (argv.telemetryTarget as string | TelemetryTarget | undefined) ??
    env['QWEN_TELEMETRY_TARGET'] ??
    (settings.target as string | TelemetryTarget | undefined);
  const target = parseTelemetryTargetValue(rawTarget);
  if (rawTarget !== undefined && target === undefined) {
    throw new FatalConfigError(
      `Invalid telemetry target: ${String(
        rawTarget,
      )}. Valid values are: local, gcp`,
    );
  }

  const otlpEndpoint =
    argv.telemetryOtlpEndpoint ??
    env['QWEN_TELEMETRY_OTLP_ENDPOINT'] ??
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
    settings.otlpEndpoint;

  const rawProtocol =
    (argv.telemetryOtlpProtocol as string | undefined) ??
    env['QWEN_TELEMETRY_OTLP_PROTOCOL'] ??
    settings.otlpProtocol;
  const otlpProtocol = (['grpc', 'http'] as const).find(
    (p) => p === rawProtocol,
  );
  if (rawProtocol !== undefined && otlpProtocol === undefined) {
    throw new FatalConfigError(
      `Invalid telemetry OTLP protocol: ${String(
        rawProtocol,
      )}. Valid values are: grpc, http`,
    );
  }

  const logPrompts =
    argv.telemetryLogPrompts ??
    parseBooleanEnvFlag(env['QWEN_TELEMETRY_LOG_PROMPTS']) ??
    settings.logPrompts;

  const includeSensitiveSpanAttributes =
    parseBooleanEnvFlag(
      env['QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES'],
    ) ??
    settings.includeSensitiveSpanAttributes ??
    false;

  const outfile =
    argv.telemetryOutfile ?? env['QWEN_TELEMETRY_OUTFILE'] ?? settings.outfile;

  const useCollector =
    parseBooleanEnvFlag(env['QWEN_TELEMETRY_USE_COLLECTOR']) ??
    settings.useCollector;

  // Per-signal endpoint overrides (HTTP only).
  // Priority: QWEN_ env var > standard OTEL_ env var > settings.json
  const otlpTracesEndpoint =
    env['QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT'] ??
    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
    settings.otlpTracesEndpoint;

  const otlpLogsEndpoint =
    env['QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT'] ??
    env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] ??
    settings.otlpLogsEndpoint;

  const otlpMetricsEndpoint =
    env['QWEN_TELEMETRY_OTLP_METRICS_ENDPOINT'] ??
    env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] ??
    settings.otlpMetricsEndpoint;

  return {
    enabled,
    target,
    otlpEndpoint,
    otlpProtocol,
    otlpTracesEndpoint,
    otlpLogsEndpoint,
    otlpMetricsEndpoint,
    logPrompts,
    includeSensitiveSpanAttributes,
    outfile,
    useCollector,
  };
}

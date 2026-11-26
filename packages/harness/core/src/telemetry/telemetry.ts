/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { isMainThread } from 'node:worker_threads';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  BRAND_CLI_NAME,
  BRAND_CLI_SLUG,
  BRAND_EVENT_NAMESPACE,
  BRAND_EVENT_PREFIX,
} from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';
import { getVersionSync } from '../utils/version.js';

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://api2.qoder.sh';

const ENDPOINT_ENV = 'QWEN_TELEMETRY_ENDPOINT';
const DISABLED_ENV = 'QWEN_TELEMETRY_DISABLED';
const EXPORT_TIMEOUT_MS = 3_000;
const FLUSH_TIMEOUT_MS = 800;
const BATCH_SCHEDULED_DELAY_MS = 1_000;
const LOG_SCHEMA_VERSION = 1;
const EVENT_SCHEMA_VERSION = '1.0';
const LOG_TYPE_ATTRIBUTE = `${BRAND_EVENT_NAMESPACE}.log.type`;
const LOG_SCHEMA_VERSION_ATTRIBUTE = `${BRAND_EVENT_NAMESPACE}.log.schema_version`;
const LOG_TYPE_ACTIVE_EVENT = 'active_event';

export const CLI_STARTED_EVENT_NAME =
  `${BRAND_EVENT_PREFIX}cli_started` as const;

export interface CliStartedEventFields {
  sessionId: string;
  usageStatisticsEnabled?: boolean;
}

let provider: LoggerProvider | undefined;

export function buildTelemetryLogsUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/otel/v1/logs') || base.endsWith('/v1/logs')) return base;
  if (base.endsWith('/otel')) return `${base}/v1/logs`;
  return `${base}/otel/v1/logs`;
}

export function getTelemetryEndpoint(): string {
  return process.env[ENDPOINT_ENV]?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
}

export function isTelemetryDisabled(): boolean {
  const value = process.env[DISABLED_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function createLoggerProvider(url: string): LoggerProvider {
  const forward = (message: string) => runLogger.debug('[telemetry]', message);
  diag.setLogger(
    {
      error: forward,
      warn: forward,
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.ERROR,
  );
  return new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': BRAND_CLI_SLUG,
      'service.namespace': BRAND_CLI_NAME,
      'service.version': getVersionSync() ?? 'unknown',
      'os.type': os.platform(),
      'os.version': os.release(),
      'host.arch': os.arch(),
    }),
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url, timeoutMillis: EXPORT_TIMEOUT_MS }),
        { scheduledDelayMillis: BATCH_SCHEDULED_DELAY_MS },
      ),
    ],
  });
}

function getTelemetryLogger(url: string): Logger {
  provider ??= createLoggerProvider(url);
  return provider.getLogger(BRAND_CLI_SLUG);
}

export function reportCliStartedEvent(fields: CliStartedEventFields): boolean {
  if (
    !isMainThread ||
    isTelemetryDisabled() ||
    fields.usageStatisticsEnabled === false
  ) {
    return false;
  }
  const url = buildTelemetryLogsUrl(getTelemetryEndpoint());
  if (!url) return false;
  try {
    getTelemetryLogger(url).emit({
      eventName: CLI_STARTED_EVENT_NAME,
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: { session_id: fields.sessionId },
      attributes: {
        [LOG_TYPE_ATTRIBUTE]: LOG_TYPE_ACTIVE_EVENT,
        [LOG_SCHEMA_VERSION_ATTRIBUTE]: LOG_SCHEMA_VERSION,
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: randomUUID(),
        event_ts: new Date().toISOString(),
        session_id: fields.sessionId,
        cli_version: getVersionSync() ?? 'unknown',
        auth_state: 'anonymous',
        privacy_mode: false,
      },
    });
    return true;
  } catch (error) {
    runLogger.debug(
      '[telemetry] cli_started emit failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export async function flushTelemetry(
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  const active = provider;
  if (!active) return true;
  provider = undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      active.shutdown().then(() => 'flushed' as const),
      timeout,
    ]);
    if (result === 'timeout') {
      runLogger.debug(
        `[telemetry] cli_started flush timed out after ${timeoutMs}ms; the record may be lost`,
      );
    }
    return result === 'flushed';
  } catch (error) {
    runLogger.debug(
      '[telemetry] cli_started flush failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function setTelemetryProviderForTesting(
  next: LoggerProvider | undefined,
): void {
  provider = next;
}

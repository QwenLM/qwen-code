/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND_EVENT_NAMESPACE, BRAND_EVENT_PREFIX } from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';
import {
  CLI_STARTED_EVENT_NAME,
  DEFAULT_TELEMETRY_ENDPOINT,
  buildTelemetryLogsUrl,
  flushTelemetry,
  getTelemetryEndpoint,
  isTelemetryDisabled,
  reportCliStartedEvent,
  setTelemetryProviderForTesting,
} from './telemetry.js';

// Literal names on purpose: the kill switch must not drift with the brand.
const ENV_ENDPOINT = 'QWEN_TELEMETRY_ENDPOINT';
const ENV_DISABLED = 'QWEN_TELEMETRY_DISABLED';

/** Installs a recording pipeline and returns the sink that receives records. */
function installRecordingProvider(
  delayMs = 0,
): InMemoryLogRecordExporter {
  const sink = new InMemoryLogRecordExporter();
  setTelemetryProviderForTesting(
    new LoggerProvider({
      processors: [
        new BatchLogRecordProcessor({
          // Defers delivery like a real HTTP round trip.
          export: (records, callback) => {
            setTimeout(() => sink.export(records, callback), delayMs);
          },
          // InMemoryLogRecordExporter.shutdown() wipes what it recorded.
          shutdown: () => Promise.resolve(),
        }),
      ],
    }),
  );
  return sink;
}

afterEach(() => {
  setTelemetryProviderForTesting(undefined);
  delete process.env[ENV_ENDPOINT];
  delete process.env[ENV_DISABLED];
  vi.restoreAllMocks();
});

describe('buildTelemetryLogsUrl', () => {
  it('appends the otel signal path to a bare origin', () => {
    expect(buildTelemetryLogsUrl('https://api2.qoder.sh')).toBe(
      'https://api2.qoder.sh/otel/v1/logs',
    );
  });

  it('keeps an already complete signal url', () => {
    expect(buildTelemetryLogsUrl('https://api2.qoder.sh/otel/v1/logs')).toBe(
      'https://api2.qoder.sh/otel/v1/logs',
    );
  });

  it('returns an empty string for an empty endpoint', () => {
    expect(buildTelemetryLogsUrl('   ')).toBe('');
  });

  it('handles the /otel and /v1/logs suffix branches', () => {
    expect(buildTelemetryLogsUrl('https://h/otel')).toBe(
      'https://h/otel/v1/logs',
    );
    expect(buildTelemetryLogsUrl('https://h/v1/logs')).toBe(
      'https://h/v1/logs',
    );
  });
});

describe('endpoint and switch resolution', () => {
  it('falls back to the default endpoint', () => {
    expect(getTelemetryEndpoint()).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    expect(isTelemetryDisabled()).toBe(false);
  });

  it('honours the endpoint and disabled overrides', () => {
    process.env[ENV_ENDPOINT] = 'http://127.0.0.1:4318';
    process.env[ENV_DISABLED] = 'true';

    expect(getTelemetryEndpoint()).toBe('http://127.0.0.1:4318');
    expect(isTelemetryDisabled()).toBe(true);
  });

  it.each(['1', 'true', 'TRUE', ' 1 '])('disables for %j', (value) => {
    process.env[ENV_DISABLED] = value;
    expect(isTelemetryDisabled()).toBe(true);
  });

  it.each(['0', 'false', ''])('stays enabled for %j', (value) => {
    process.env[ENV_DISABLED] = value;
    expect(isTelemetryDisabled()).toBe(false);
  });
});

describe('reportCliStartedEvent', () => {
  it('emits one branded cli_started log record', async () => {
    const sink = installRecordingProvider();

    expect(reportCliStartedEvent({ sessionId: 'session-1' })).toBe(true);
    await flushTelemetry();

    const records = sink.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.eventName).toBe(`${BRAND_EVENT_PREFIX}cli_started`);
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
    expect(record.severityText).toBe('INFO');
    expect(record.body).toEqual({ session_id: 'session-1' });
    expect(record.attributes).toMatchObject({
      [`${BRAND_EVENT_NAMESPACE}.log.type`]: 'active_event',
      [`${BRAND_EVENT_NAMESPACE}.log.schema_version`]: 1,
      schema_version: '1.0',
      session_id: 'session-1',
      auth_state: 'anonymous',
      privacy_mode: false,
    });
    expect(record.attributes['event_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.attributes['event_ts']).toEqual(expect.any(String));
  });

  it('keeps the event name branded for this product', () => {
    expect(CLI_STARTED_EVENT_NAME).toBe(`${BRAND_EVENT_PREFIX}cli_started`);
  });

  it('stays silent when the kill switch is set', async () => {
    const sink = installRecordingProvider();
    process.env[ENV_DISABLED] = '1';

    expect(reportCliStartedEvent({ sessionId: 'session-1' })).toBe(false);
    await flushTelemetry();
    expect(sink.getFinishedLogRecords()).toHaveLength(0);
  });

  it('stays silent when usage statistics are turned off in settings', async () => {
    const sink = installRecordingProvider();

    expect(
      reportCliStartedEvent({
        sessionId: 'session-1',
        usageStatisticsEnabled: false,
      }),
    ).toBe(false);
    await flushTelemetry();
    expect(sink.getFinishedLogRecords()).toHaveLength(0);
  });

  it('reports when the setting is left unset', async () => {
    const sink = installRecordingProvider();

    expect(
      reportCliStartedEvent({
        sessionId: 'session-1',
        usageStatisticsEnabled: undefined,
      }),
    ).toBe(true);
    await flushTelemetry();
    expect(sink.getFinishedLogRecords()).toHaveLength(1);
  });
});

describe('flushTelemetry', () => {
  it('flushes the pending export', async () => {
    const sink = installRecordingProvider();
    reportCliStartedEvent({ sessionId: 'session-1' });

    await expect(flushTelemetry()).resolves.toBe(true);
    expect(sink.getFinishedLogRecords()).toHaveLength(1);
  });

  it('waits for an in-flight export before resolving', async () => {
    const sink = installRecordingProvider(30);
    reportCliStartedEvent({ sessionId: 'session-1' });

    await expect(flushTelemetry()).resolves.toBe(true);
    expect(sink.getFinishedLogRecords()).toHaveLength(1);
  });

  it('reuses one provider across emits', async () => {
    const sink = installRecordingProvider();
    reportCliStartedEvent({ sessionId: 'session-1' });
    reportCliStartedEvent({ sessionId: 'session-2' });

    await flushTelemetry();
    expect(sink.getFinishedLogRecords()).toHaveLength(2);
  });

  it('resolves false and logs when the shutdown times out', async () => {
    const debug = vi.spyOn(runLogger, 'debug');
    setTelemetryProviderForTesting({
      getLogger: () => ({ emit: () => {} }),
      shutdown: () => new Promise<void>(() => {}),
    } as unknown as LoggerProvider);

    await expect(flushTelemetry(20)).resolves.toBe(false);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('[telemetry] cli_started flush timed out after 20ms'),
    );
  });

  it('resolves false and logs when the shutdown fails', async () => {
    const debug = vi.spyOn(runLogger, 'debug');
    setTelemetryProviderForTesting({
      getLogger: () => ({ emit: () => {} }),
      shutdown: () => Promise.reject(new Error('boom')),
    } as unknown as LoggerProvider);

    await expect(flushTelemetry()).resolves.toBe(false);
    expect(debug).toHaveBeenCalledWith(
      '[telemetry] cli_started flush failed:',
      'boom',
    );
  });

  it('resolves true when nothing was ever emitted', async () => {
    await expect(flushTelemetry()).resolves.toBe(true);
  });
});

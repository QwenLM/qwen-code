/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { BRAND_EVENT_NAMESPACE, BRAND_EVENT_PREFIX } from '../config/brand.js';
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

const mocks = vi.hoisted(() => ({ isMainThread: true, debug: vi.fn() }));
vi.mock('node:worker_threads', () => ({
  get isMainThread() {
    return mocks.isMainThread;
  },
}));
vi.mock('../utils/runLogger.js', () => ({ runLogger: { debug: mocks.debug } }));

function installRecordingProvider(delayMs = 0): InMemoryLogRecordExporter {
  const sink = new InMemoryLogRecordExporter();
  setTelemetryProviderForTesting(
    new LoggerProvider({
      processors: [
        new BatchLogRecordProcessor({
          export: (records, callback) => {
            setTimeout(() => sink.export(records, callback), delayMs);
          },
          shutdown: () => Promise.resolve(),
        }),
      ],
    }),
  );
  return sink;
}

afterEach(async () => {
  await flushTelemetry();
  setTelemetryProviderForTesting(undefined);
  mocks.isMainThread = true;
  mocks.debug.mockClear();
  vi.unstubAllEnvs();
});

describe('匿名启动上报', () => {
  it.each([
    ['https://h', 'https://h/otel/v1/logs'],
    ['https://h/', 'https://h/otel/v1/logs'],
    ['https://h/otel', 'https://h/otel/v1/logs'],
    ['https://h/v1/logs', 'https://h/v1/logs'],
    ['https://h/otel/v1/logs', 'https://h/otel/v1/logs'],
    ['   ', ''],
  ])('拼接端点 %s', (endpoint, expected) => {
    expect(buildTelemetryLogsUrl(endpoint)).toBe(expected);
  });

  it('使用默认端点并允许进程覆盖', () => {
    vi.stubEnv('QWEN_TELEMETRY_ENDPOINT', '');
    expect(getTelemetryEndpoint()).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    vi.stubEnv('QWEN_TELEMETRY_ENDPOINT', ' http://127.0.0.1:4318 ');
    expect(getTelemetryEndpoint()).toBe('http://127.0.0.1:4318');
  });

  it.each(['1', 'true', 'TRUE', ' 1 '])('禁用开关 %j 不发送', async (value) => {
    const sink = installRecordingProvider();
    vi.stubEnv('QWEN_TELEMETRY_DISABLED', value);
    expect(isTelemetryDisabled()).toBe(true);
    expect(reportCliStartedEvent({ sessionId: 'session-1' })).toBe(false);
    await flushTelemetry();
    expect(sink.getFinishedLogRecords()).toHaveLength(0);
  });

  it.each(['0', 'false', ''])('非禁用值 %j', (value) => {
    vi.stubEnv('QWEN_TELEMETRY_DISABLED', value);
    expect(isTelemetryDisabled()).toBe(false);
  });

  it('统计设置显式关闭时不发送', async () => {
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

  it('worker 不发送', async () => {
    const sink = installRecordingProvider();
    mocks.isMainThread = false;
    expect(reportCliStartedEvent({ sessionId: 'session-1' })).toBe(false);
    await flushTelemetry();
    expect(sink.getFinishedLogRecords()).toHaveLength(0);
  });

  it('发送匿名事件并等待在途导出', async () => {
    vi.stubEnv('QWEN_TELEMETRY_DISABLED', '');
    const sink = installRecordingProvider(20);
    expect(reportCliStartedEvent({ sessionId: 'session-1' })).toBe(true);
    await expect(flushTelemetry()).resolves.toBe(true);
    const records = sink.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.eventName).toBe(CLI_STARTED_EVENT_NAME);
    expect(record.eventName).toBe(`${BRAND_EVENT_PREFIX}cli_started`);
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
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
    expect(record.attributes).not.toHaveProperty('user_id');
  });

  it('flush 超时返回 false 并记录本地诊断', async () => {
    installRecordingProvider(30);
    reportCliStartedEvent({ sessionId: 'session-1' });
    await expect(flushTelemetry(1)).resolves.toBe(false);
    expect(mocks.debug).toHaveBeenCalledWith(
      expect.stringContaining('flush timed out'),
    );
  });

  it('发送失败不向启动路径抛错', () => {
    setTelemetryProviderForTesting({
      getLogger: () => {
        throw new Error('unavailable');
      },
    } as unknown as LoggerProvider);
    expect(reportCliStartedEvent({ sessionId: 'session-1' })).toBe(false);
    setTelemetryProviderForTesting(undefined);
  });

  it('shutdown 失败返回 false', async () => {
    setTelemetryProviderForTesting({
      shutdown: async () => {
        throw new Error('unavailable');
      },
    } as unknown as LoggerProvider);
    await expect(flushTelemetry()).resolves.toBe(false);
  });

  it('真实 OTLP HTTP 请求只发送到本地接收端且不带认证', async () => {
    let received:
      | { headers: Record<string, unknown>; body: string }
      | undefined;
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        received = { headers: request.headers, body };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('missing port');
      vi.stubEnv('QWEN_TELEMETRY_ENDPOINT', `http://127.0.0.1:${address.port}`);
      vi.stubEnv('QWEN_TELEMETRY_DISABLED', '');
      expect(reportCliStartedEvent({ sessionId: 'session-http' })).toBe(true);
      await expect(flushTelemetry()).resolves.toBe(true);
      expect(received).toBeDefined();
      expect(received!.headers).not.toHaveProperty('authorization');
      const payload = JSON.parse(received!.body);
      const records = payload.resourceLogs.flatMap(
        (resource: { scopeLogs: Array<{ logRecords: unknown[] }> }) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords),
      );
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records)).toContain('qwen_cli_started');
      expect(JSON.stringify(records)).toContain('anonymous');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

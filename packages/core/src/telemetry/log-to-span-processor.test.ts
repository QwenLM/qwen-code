/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import { LogToSpanProcessor } from './log-to-span-processor.js';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

interface ExportedSpan {
  name: string;
  kind: number;
  spanContext: () => { traceId: string; spanId: string; traceFlags: number };
  startTime: HrTime;
  endTime: HrTime;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string };
}

describe('LogToSpanProcessor', () => {
  let processor: LogToSpanProcessor;
  let mockExporter: SpanExporter;
  let exportedSpans: ExportedSpan[];

  beforeEach(() => {
    exportedSpans = [];
    mockExporter = {
      export: vi.fn((spans, cb) => {
        exportedSpans.push(...spans);
        cb({ code: 0 });
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    } as unknown as SpanExporter;
    processor = new LogToSpanProcessor(mockExporter, 60000);
  });

  afterEach(async () => {
    await processor.shutdown();
  });

  it('converts a log record to a span on flush', async () => {
    const logRecord = {
      body: 'test event',
      hrTime: [1000, 500000000] as [number, number],
      attributes: { key1: 'value1', key2: 42, key3: true },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans).toHaveLength(1);
    const span = exportedSpans[0];
    expect(span.name).toBe('test event');
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes['key1']).toBe('value1');
    expect(span.attributes['key2']).toBe(42);
    expect(span.attributes['key3']).toBe(true);
    expect(span.attributes['log.bridge']).toBe(true);
    expect(span.startTime).toEqual([1000, 500000000]);
    expect(span.endTime).toEqual([1000, 500000000]);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('uses duration_ms to compute span end time', async () => {
    const logRecord = {
      body: 'api response',
      hrTime: [1000, 0] as [number, number],
      attributes: { duration_ms: 250 },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].endTime).toEqual([1000, 250000000]);
  });

  it('handles duration_ms that causes second rollover', async () => {
    const logRecord = {
      body: 'long operation',
      hrTime: [1000, 900000000] as [number, number],
      attributes: { duration_ms: 500 },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].endTime).toEqual([1001, 400000000]);
  });

  it('serializes object attributes to JSON', async () => {
    const logRecord = {
      body: 'event with object',
      hrTime: [1000, 0] as [number, number],
      attributes: { metadata: { nested: true } },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].attributes['metadata']).toBe('{"nested":true}');
  });

  it('handles unserializable object attributes safely', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const logRecord = {
      body: 'event',
      hrTime: [1000, 0] as [number, number],
      attributes: { bad: circular },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].attributes['bad']).toBe('[unserializable]');
  });

  it('skips null and undefined attributes', async () => {
    const logRecord = {
      body: 'event',
      hrTime: [1000, 0] as [number, number],
      attributes: { valid: 'yes', nullVal: null, undefinedVal: undefined },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    const attrs = exportedSpans[0].attributes;
    expect(attrs['valid']).toBe('yes');
    expect(attrs).not.toHaveProperty('nullVal');
    expect(attrs).not.toHaveProperty('undefinedVal');
    expect(attrs['log.bridge']).toBe(true);
  });

  it('uses "unknown" as span name when body is missing', async () => {
    const logRecord = {
      body: undefined,
      hrTime: [1000, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].name).toBe('unknown');
  });

  it('generates unique trace IDs without session.id', async () => {
    const logRecord1 = {
      body: 'event1',
      hrTime: [1000, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord;
    const logRecord2 = {
      body: 'event2',
      hrTime: [1001, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord1);
    processor.onEmit(logRecord2);
    await processor.forceFlush();

    const ctx1 = exportedSpans[0].spanContext();
    const ctx2 = exportedSpans[1].spanContext();
    expect(ctx1.traceId).toHaveLength(32);
    expect(ctx1.spanId).toHaveLength(16);
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('derives same traceId from same session.id', async () => {
    const logRecord1 = {
      body: 'event1',
      hrTime: [1000, 0] as [number, number],
      attributes: { 'session.id': 'session-abc' },
    } as unknown as ReadableLogRecord;
    const logRecord2 = {
      body: 'event2',
      hrTime: [1001, 0] as [number, number],
      attributes: { 'session.id': 'session-abc' },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord1);
    processor.onEmit(logRecord2);
    await processor.forceFlush();

    const ctx1 = exportedSpans[0].spanContext();
    const ctx2 = exportedSpans[1].spanContext();
    expect(ctx1.traceId).toBe(ctx2.traceId);
    expect(ctx1.spanId).not.toBe(ctx2.spanId);
  });

  it('derives different traceIds from different session.ids', async () => {
    const logRecord1 = {
      body: 'event1',
      hrTime: [1000, 0] as [number, number],
      attributes: { 'session.id': 'session-abc' },
    } as unknown as ReadableLogRecord;
    const logRecord2 = {
      body: 'event2',
      hrTime: [1001, 0] as [number, number],
      attributes: { 'session.id': 'session-xyz' },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord1);
    processor.onEmit(logRecord2);
    await processor.forceFlush();

    const ctx1 = exportedSpans[0].spanContext();
    const ctx2 = exportedSpans[1].spanContext();
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('sets ERROR status for truthy error attributes', async () => {
    const logRecord = {
      body: 'api error',
      hrTime: [1000, 0] as [number, number],
      attributes: {
        error_message: 'connection refused',
        error_type: 'NETWORK',
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(exportedSpans[0].status.message).toBe('connection refused');
  });

  it('does not set ERROR for success: false (normal decline)', async () => {
    const logRecord = {
      body: 'tool call declined',
      hrTime: [1000, 0] as [number, number],
      attributes: { success: false, function_name: 'bash' },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it('does not set ERROR for falsy error attributes', async () => {
    const logRecord = {
      body: 'ok event',
      hrTime: [1000, 0] as [number, number],
      attributes: { error: null, error_message: '', error_type: '' },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it('preserves severity attributes', async () => {
    const logRecord = {
      body: 'event',
      hrTime: [1000, 0] as [number, number],
      attributes: {},
      severityNumber: 9,
      severityText: 'INFO',
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].attributes['log.severity_number']).toBe(9);
    expect(exportedSpans[0].attributes['log.severity_text']).toBe('INFO');
  });

  it('shutdown flushes remaining spans and shuts down exporter', async () => {
    const logRecord = {
      body: 'final event',
      hrTime: [1000, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.shutdown();

    expect(exportedSpans).toHaveLength(1);
    expect(mockExporter.shutdown).toHaveBeenCalled();
  });
});

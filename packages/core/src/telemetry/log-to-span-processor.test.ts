/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type HrTime,
  type SpanContext,
} from '@opentelemetry/api';
import { LogToSpanProcessor } from './log-to-span-processor.js';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

let mockCurrentSessionId: string | undefined = undefined;

vi.mock('./session-context.js', () => ({
  getCurrentSessionId: () => mockCurrentSessionId,
}));

interface ExportedSpan {
  name: string;
  kind: number;
  spanContext: () => { traceId: string; spanId: string; traceFlags: number };
  startTime: HrTime;
  endTime: HrTime;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string };
  parentSpanContext?: SpanContext;
}

describe('LogToSpanProcessor', () => {
  let processor: LogToSpanProcessor;
  let mockExporter: SpanExporter;
  let exportedSpans: ExportedSpan[];

  beforeEach(() => {
    exportedSpans = [];
    mockCurrentSessionId = undefined;
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
      attributes: {
        'event.name': 'test_event',
        key1: 'value1',
        key2: 42,
        key3: true,
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans).toHaveLength(1);
    const span = exportedSpans[0];
    expect(span.name).toBe('test_event');
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes['key1']).toBe('value1');
    expect(span.attributes['key2']).toBe(42);
    expect(span.attributes['key3']).toBe(true);
    expect(span.attributes['log.bridge']).toBe(true);
    expect(span.startTime).toEqual([1000, 500000000]);
    expect(span.endTime).toEqual([1000, 500000000]);
    expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
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

  it('ignores non-finite duration_ms values', async () => {
    const logRecord = {
      body: 'api response',
      hrTime: [1000, 0] as [number, number],
      attributes: { duration_ms: Infinity },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].endTime).toEqual([1000, 0]);
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

  it('drops sensitive attributes before exporting bridged spans', async () => {
    const logRecord = {
      body: 'event',
      hrTime: [1000, 0] as [number, number],
      attributes: {
        error: 'secret error',
        ['error.message']: 'secret error message',
        error_message: 'secret upstream error',
        prompt: 'secret prompt',
        function_args: '{"token":"secret"}',
        response_text: 'secret response',
        error_type: 'RateLimitError',
        safe: 'visible',
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    const attrs = exportedSpans[0].attributes;
    expect(attrs).not.toHaveProperty('error');
    expect(attrs).not.toHaveProperty('error.message');
    expect(attrs).not.toHaveProperty('error_message');
    expect(attrs).not.toHaveProperty('prompt');
    expect(attrs).not.toHaveProperty('function_args');
    expect(attrs).not.toHaveProperty('response_text');
    expect(attrs['error_type']).toBe('RateLimitError');
    expect(attrs['safe']).toBe('visible');
    expect(attrs['log.bridge']).toBe(true);
  });

  it('keeps sensitive attributes when explicitly enabled', async () => {
    await processor.shutdown();
    exportedSpans = [];
    processor = new LogToSpanProcessor(mockExporter, {
      flushIntervalMs: 60000,
      includeSensitiveSpanAttributes: true,
    });
    const logRecord = {
      body: 'event',
      hrTime: [1000, 0] as [number, number],
      attributes: {
        error: 'secret error',
        ['error.message']: 'secret error message',
        error_message: 'secret upstream error',
        prompt: 'secret prompt',
        function_args: '{"token":"secret"}',
        response_text: 'secret response',
        safe: 'visible',
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    const attrs = exportedSpans[0].attributes;
    expect(attrs['error']).toBe('secret error');
    expect(attrs['error.message']).toBe('secret error message');
    expect(attrs['error_message']).toBe('secret upstream error');
    expect(attrs['prompt']).toBe('secret prompt');
    expect(attrs['function_args']).toBe('{"token":"secret"}');
    expect(attrs['response_text']).toBe('secret response');
    expect(attrs['safe']).toBe('visible');
    expect(attrs['log.bridge']).toBe(true);
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

  it('uses a safe fallback span name when event name is missing', async () => {
    const logRecord = {
      body: undefined,
      hrTime: [1000, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].name).toBe('log.event');
  });

  it('truncates long span names', async () => {
    const longName = 'x'.repeat(200);
    const logRecord = {
      body: 'body is not used for span name',
      hrTime: [1000, 0] as [number, number],
      attributes: { 'event.name': longName },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].name).toBe(`${'x'.repeat(128)}...`);
  });

  it('uses event.name instead of raw log body for span names', async () => {
    const logRecord = {
      body: 'API error for test-model. Error: secret upstream failure.',
      hrTime: [1000, 0] as [number, number],
      attributes: {
        'event.name': 'api_error',
        error_message: 'secret upstream failure',
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].name).toBe('api_error');
    expect(exportedSpans[0].name).not.toContain('secret upstream failure');
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

  it('uses the log record span context as parent when available', async () => {
    const parentSpanContext: SpanContext = {
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    };
    const logRecord = {
      body: 'event',
      hrTime: [1000, 0] as [number, number],
      spanContext: parentSpanContext,
      attributes: {
        'event.name': 'child_event',
        'session.id': 'session-abc',
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    const span = exportedSpans[0];
    expect(span.spanContext().traceId).toBe(parentSpanContext.traceId);
    expect(span.parentSpanContext).toBe(parentSpanContext);
  });

  it('drops the oldest spans when the buffer exceeds the configured limit', async () => {
    await processor.shutdown();
    processor = new LogToSpanProcessor(mockExporter, 60000, 2);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      processor.onEmit({
        body: 'event1',
        hrTime: [1000, 0] as [number, number],
        attributes: { 'event.name': 'event1' },
      } as unknown as ReadableLogRecord);
      processor.onEmit({
        body: 'event2',
        hrTime: [1001, 0] as [number, number],
        attributes: { 'event.name': 'event2' },
      } as unknown as ReadableLogRecord);
      processor.onEmit({
        body: 'event3',
        hrTime: [1002, 0] as [number, number],
        attributes: { 'event.name': 'event3' },
      } as unknown as ReadableLogRecord);

      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          'dropped 1 oldest span(s) since last warning, 1 total',
        ),
      );

      await processor.forceFlush();

      expect(exportedSpans.map((span) => span.name)).toEqual([
        'event2',
        'event3',
      ]);
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('falls back to the default buffer size for invalid configured limits', async () => {
    await processor.shutdown();
    processor = new LogToSpanProcessor(mockExporter, 60000, 0);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      for (const body of ['event1', 'event2', 'event3']) {
        processor.onEmit({
          body,
          hrTime: [1000, 0] as [number, number],
          attributes: { 'event.name': body },
        } as unknown as ReadableLogRecord);
      }

      await processor.forceFlush();

      expect(exportedSpans.map((span) => span.name)).toEqual([
        'event1',
        'event2',
        'event3',
      ]);
      expect(stderrWrite).not.toHaveBeenCalledWith(
        expect.stringContaining('buffer exceeded max size'),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('floors fractional configured buffer limits', async () => {
    await processor.shutdown();
    processor = new LogToSpanProcessor(mockExporter, 60000, 2.9);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      for (const body of ['event1', 'event2', 'event3']) {
        processor.onEmit({
          body,
          hrTime: [1000, 0] as [number, number],
          attributes: { 'event.name': body },
        } as unknown as ReadableLogRecord);
      }

      await processor.forceFlush();

      expect(exportedSpans.map((span) => span.name)).toEqual([
        'event2',
        'event3',
      ]);
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          'dropped 1 oldest span(s) since last warning, 1 total',
        ),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('reports total dropped spans across overflow warnings', async () => {
    await processor.shutdown();
    processor = new LogToSpanProcessor(mockExporter, 60000, 2);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(31_001);

    try {
      for (const body of ['event1', 'event2', 'event3', 'event4']) {
        processor.onEmit({
          body,
          hrTime: [1000, 0] as [number, number],
          attributes: { 'event.name': body },
        } as unknown as ReadableLogRecord);
      }

      expect(stderrWrite).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(
          'dropped 1 oldest span(s) since last warning, 1 total',
        ),
      );
      expect(stderrWrite).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(
          'dropped 1 oldest span(s) since last warning, 2 total',
        ),
      );
    } finally {
      dateNow.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('emits pending dropped-span count during shutdown', async () => {
    await processor.shutdown();
    processor = new LogToSpanProcessor(mockExporter, 60000, 2);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1000);

    try {
      for (const body of ['event1', 'event2', 'event3', 'event4']) {
        processor.onEmit({
          body,
          hrTime: [1000, 0] as [number, number],
          attributes: { 'event.name': body },
        } as unknown as ReadableLogRecord);
      }

      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining(
          'dropped 1 oldest span(s) since last warning, 1 total',
        ),
      );

      await processor.shutdown();

      expect(stderrWrite).toHaveBeenCalledTimes(2);
      expect(stderrWrite).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(
          'dropped 1 oldest span(s) since last warning, 2 total',
        ),
      );
    } finally {
      dateNow.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('sets ERROR status for truthy error attributes', async () => {
    const logRecord = {
      body: 'api error',
      hrTime: [1000, 0] as [number, number],
      attributes: {
        error: 'raw error',
        ['error.message']: 'connection refused',
        error_message: 'connection refused',
        error_type: 'NETWORK',
      },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(exportedSpans[0].status.message).toBe('Log event recorded error');
    expect(exportedSpans[0].attributes).not.toHaveProperty('error');
    expect(exportedSpans[0].attributes).not.toHaveProperty('error.message');
    expect(exportedSpans[0].attributes).not.toHaveProperty('error_message');
    expect(exportedSpans[0].attributes['error_type']).toBe('NETWORK');
    expect(JSON.stringify(exportedSpans[0].status)).not.toContain(
      'connection refused',
    );
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

  it('sets ERROR when only error.message is present (OTel semantic convention)', async () => {
    const logRecord = {
      body: 'otel error',
      hrTime: [1000, 0] as [number, number],
      attributes: { ['error.message']: 'upstream timeout' },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    expect(exportedSpans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(exportedSpans[0].attributes).not.toHaveProperty('error.message');
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

  it('reuses in-flight exports and flushes queued spans afterwards', async () => {
    await processor.shutdown();
    exportedSpans = [];
    const exportCallbacks: Array<(result: { code: number }) => void> = [];
    let exportCallCount = 0;
    mockExporter = {
      export: vi.fn((spans, cb) => {
        exportCallCount += 1;
        exportedSpans.push(...spans);
        if (exportCallCount === 1) {
          exportCallbacks.push(cb);
        } else {
          cb({ code: 0 });
        }
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    } as unknown as SpanExporter;
    processor = new LogToSpanProcessor(mockExporter, 60000);

    processor.onEmit({
      body: 'first',
      hrTime: [1000, 0] as [number, number],
      attributes: { 'event.name': 'first' },
    } as unknown as ReadableLogRecord);
    const firstFlush = processor.forceFlush();
    await Promise.resolve();

    processor.onEmit({
      body: 'second',
      hrTime: [1001, 0] as [number, number],
      attributes: { 'event.name': 'second' },
    } as unknown as ReadableLogRecord);
    const secondFlush = processor.forceFlush();
    await Promise.resolve();

    expect(mockExporter.export).toHaveBeenCalledTimes(1);
    expect(exportedSpans.map((span) => span.name)).toEqual(['first']);

    exportCallbacks[0]({ code: 0 });
    await Promise.all([firstFlush, secondFlush]);

    expect(mockExporter.export).toHaveBeenCalledTimes(2);
    expect(exportedSpans.map((span) => span.name)).toEqual(['first', 'second']);
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

  it('does not collect or flush spans after shutdown', async () => {
    await processor.shutdown();

    processor.onEmit({
      body: 'late event',
      hrTime: [1000, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord);
    await processor.forceFlush();

    expect(exportedSpans).toHaveLength(0);
    expect(mockExporter.export).not.toHaveBeenCalled();
    expect(mockExporter.forceFlush).not.toHaveBeenCalled();
    expect(mockExporter.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shutdown is idempotent', async () => {
    await processor.shutdown();
    await processor.shutdown();

    expect(mockExporter.shutdown).toHaveBeenCalledTimes(1);
  });

  it('falls back to getCurrentSessionId when log record has no session.id', async () => {
    mockCurrentSessionId = 'session-from-context';
    const logRecord = {
      body: 'event without session attr',
      hrTime: [1000, 0] as [number, number],
      attributes: {},
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    // The traceId should be derived from the fallback session ID,
    // not a random one.
    const { deriveTraceId } = await import('./trace-id-utils.js');
    expect(exportedSpans[0].spanContext().traceId).toBe(
      deriveTraceId('session-from-context'),
    );
  });

  it('prefers log record session.id over getCurrentSessionId', async () => {
    mockCurrentSessionId = 'stale-session';
    const logRecord = {
      body: 'event with session attr',
      hrTime: [1000, 0] as [number, number],
      attributes: { 'session.id': 'fresh-session' },
    } as unknown as ReadableLogRecord;

    processor.onEmit(logRecord);
    await processor.forceFlush();

    const { deriveTraceId } = await import('./trace-id-utils.js');
    expect(exportedSpans[0].spanContext().traceId).toBe(
      deriveTraceId('fresh-session'),
    );
  });

  describe('export failure diagnostics', () => {
    function makeFailingProcessor(error: Error | undefined) {
      const failingExporter = {
        export: vi.fn((_spans, cb) => cb({ code: 1, error })),
        shutdown: vi.fn().mockResolvedValue(undefined),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      } as unknown as SpanExporter;
      return new LogToSpanProcessor(failingExporter, 60000);
    }

    async function flushOne(p: LogToSpanProcessor) {
      p.onEmit({
        body: 'event',
        hrTime: [1000, 0] as [number, number],
        attributes: { 'event.name': 'event' },
      } as unknown as ReadableLogRecord);
      await p.forceFlush();
    }

    it('falls back to error.name when message is empty (HTTP/2 / stripped reason phrase)', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error(''), {
        name: 'OTLPExporterError',
        code: 403,
        data: 'Forbidden: invalid license',
      });
      processor = makeFailingProcessor(err);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        expect(stderrWrite).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="OTLPExporterError" httpCode=403 data="Forbidden: invalid license"\n',
        );
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('JSON-escapes embedded newlines in message and data so the record stays on one line', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error('line1\nline2'), {
        name: 'OTLPExporterError',
        code: 500,
        data: '{\n  "error": "boom"\n}',
      });
      const sink = vi.fn();
      processor = new LogToSpanProcessor(
        {
          export: vi.fn((_s, cb) => cb({ code: 1, error: err })),
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, diagnosticsSink: sink },
      );

      await flushOne(processor);
      const msg = sink.mock.calls[0][0] as string;
      expect(msg).not.toContain('\n');
      expect(msg).toContain('error="line1\\nline2"');
      expect(msg).toContain('data="{\\n  \\"error\\": \\"boom\\"\\n}"');
    });

    it('truncates response data snippets to 200 characters before stringifying', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error(''), {
        name: 'OTLPExporterError',
        code: 500,
        data: 'x'.repeat(500),
      });
      processor = makeFailingProcessor(err);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        const msg = stderrWrite.mock.calls[0][0] as string;
        expect(msg).toContain('httpCode=500');
        expect(msg).toContain(`data="${'x'.repeat(200)}"`);
        expect(msg).not.toContain('x'.repeat(201));
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('omits httpCode when err.code is a non-numeric networking code (ECONNREFUSED)', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
        code: 'ECONNREFUSED',
      });
      processor = makeFailingProcessor(err);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        const msg = stderrWrite.mock.calls[0][0] as string;
        expect(msg).not.toContain('httpCode=');
        expect(msg).toContain('error="connect ECONNREFUSED 127.0.0.1"');
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('reports error="unknown" when result.error is missing', async () => {
      await processor.shutdown();
      processor = makeFailingProcessor(undefined);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        expect(stderrWrite).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="unknown"\n',
        );
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('omits data field when err.data is a non-string truthy value (e.g. Buffer)', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error('fail'), {
        code: 500,
        data: Buffer.from('binary'),
      });
      processor = makeFailingProcessor(err as unknown as Error);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        const msg = stderrWrite.mock.calls[0][0] as string;
        expect(msg).toContain('httpCode=500');
        expect(msg).not.toContain('data=');
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('falls back to "unknown" when both message and name are empty (e.g. minified Error)', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error(''), { name: '' });
      processor = makeFailingProcessor(err);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        expect(stderrWrite).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="unknown"\n',
        );
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('omits data field when err.data is an empty string (guards against length>0 loosening)', async () => {
      await processor.shutdown();
      const err = Object.assign(new Error('fail'), { code: 500, data: '' });
      processor = makeFailingProcessor(err);
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await flushOne(processor);
        const msg = stderrWrite.mock.calls[0][0] as string;
        expect(msg).toContain('httpCode=500');
        expect(msg).not.toContain('data=');
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('routes diagnostics to an injected sink without touching stderr', async () => {
      await processor.shutdown();
      const sink = vi.fn();
      const stderrWrite = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const failingExporter = {
        export: vi.fn((_spans, cb) =>
          cb({ code: 1, error: new Error('boom') }),
        ),
        shutdown: vi.fn().mockResolvedValue(undefined),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      } as unknown as SpanExporter;
      processor = new LogToSpanProcessor(failingExporter, {
        flushIntervalMs: 60000,
        diagnosticsSink: sink,
      });

      try {
        await flushOne(processor);
        expect(sink).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="boom"',
        );
        expect(stderrWrite).not.toHaveBeenCalled();
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('routes buffer-overflow warnings through the injected sink', async () => {
      await processor.shutdown();
      const sink = vi.fn();
      processor = new LogToSpanProcessor(
        {
          export: vi.fn((_s, cb) => cb({ code: 0 })),
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, maxBufferSize: 2, diagnosticsSink: sink },
      );

      for (const body of ['a', 'b', 'c']) {
        processor.onEmit({
          body,
          hrTime: [1000, 0] as [number, number],
          attributes: { 'event.name': body },
        } as unknown as ReadableLogRecord);
      }

      expect(sink).toHaveBeenCalledWith(
        expect.stringContaining('[LogToSpan] buffer exceeded max size'),
      );
    });

    it('routes export timeout through the injected sink', async () => {
      await processor.shutdown();
      vi.useFakeTimers();
      const sink = vi.fn();
      try {
        processor = new LogToSpanProcessor(
          {
            // Never invoke the callback — force the timeout branch.
            export: vi.fn(),
            shutdown: vi.fn().mockResolvedValue(undefined),
            forceFlush: vi.fn().mockResolvedValue(undefined),
          } as unknown as SpanExporter,
          { flushIntervalMs: 60000, diagnosticsSink: sink },
        );
        processor.onEmit({
          body: 'event',
          hrTime: [1000, 0] as [number, number],
          attributes: { 'event.name': 'event' },
        } as unknown as ReadableLogRecord);

        const flushPromise = processor.forceFlush();
        // EXPORT_TIMEOUT_MS is 30_000 — advance past it.
        await vi.advanceTimersByTimeAsync(31_000);
        await flushPromise;

        expect(sink).toHaveBeenCalledWith(
          expect.stringMatching(
            /^\[LogToSpan] export timeout after \d+ms \(\d+ span\(s\)\)$/,
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('routes export-threw (synchronous exporter exception) through the injected sink', async () => {
      await processor.shutdown();
      const sink = vi.fn();
      processor = new LogToSpanProcessor(
        {
          export: vi.fn(() => {
            throw new Error('exporter exploded synchronously');
          }),
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, diagnosticsSink: sink },
      );

      await flushOne(processor);
      expect(sink).toHaveBeenCalledWith(
        '[LogToSpan] export threw: error="exporter exploded synchronously"',
      );
    });

    it('surfaces httpCode/data when a sync-thrown error carries OTLPExporterError fields', async () => {
      await processor.shutdown();
      const sink = vi.fn();
      const err = Object.assign(new Error('Bad Request'), {
        name: 'OTLPExporterError',
        code: 400,
        data: 'malformed payload',
      });
      processor = new LogToSpanProcessor(
        {
          export: vi.fn(() => {
            throw err;
          }),
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, diagnosticsSink: sink },
      );

      await flushOne(processor);
      expect(sink).toHaveBeenCalledWith(
        '[LogToSpan] export threw: error="Bad Request" httpCode=400 data="malformed payload"',
      );
    });

    it('JSON-escapes export-threw payloads with embedded newlines (single-line invariant)', async () => {
      await processor.shutdown();
      const sink = vi.fn();
      processor = new LogToSpanProcessor(
        {
          export: vi.fn(() => {
            throw new Error('line1\nline2');
          }),
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, diagnosticsSink: sink },
      );

      await flushOne(processor);
      const msg = sink.mock.calls[0][0] as string;
      expect(msg).not.toContain('\n');
      expect(msg).toBe('[LogToSpan] export threw: error="line1\\nline2"');
    });

    it('handles non-Error throws (e.g. throw "string") in the export-threw path', async () => {
      await processor.shutdown();
      const sink = vi.fn();
      processor = new LogToSpanProcessor(
        {
          export: vi.fn(() => {
            // Deliberate non-Error throw to exercise the String(err) branch.
            // eslint-disable-next-line no-restricted-syntax
            throw 'raw string thrown';
          }),
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, diagnosticsSink: sink },
      );

      await flushOne(processor);
      expect(sink).toHaveBeenCalledWith(
        '[LogToSpan] export threw: error="raw string thrown"',
      );
    });

    it('keeps processing exports after the sink throws', async () => {
      await processor.shutdown();
      const sink = vi.fn(() => {
        throw new Error('sink exploded');
      });
      const exportFn = vi.fn(
        (_spans, cb: (r: { code: number; error?: Error }) => void) =>
          cb({ code: 1, error: new Error('boom') }),
      );
      processor = new LogToSpanProcessor(
        {
          export: exportFn,
          shutdown: vi.fn().mockResolvedValue(undefined),
          forceFlush: vi.fn().mockResolvedValue(undefined),
        } as unknown as SpanExporter,
        { flushIntervalMs: 60000, diagnosticsSink: sink },
      );

      await flushOne(processor);
      await flushOne(processor);

      expect(exportFn).toHaveBeenCalledTimes(2);
      expect(sink).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type HrTime,
  type SpanContext,
} from '@opentelemetry/api';
import { LogToSpanProcessor } from './log-to-span-processor.js';
import { deriveTraceId } from './trace-id-utils.js';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { sessionIdContext } from '../utils/sessionIdContext.js';

let mockCurrentSessionId: string | undefined = undefined;
let mockScopedSessionId: string | undefined = undefined;
let mockIsInNativeSubagentSpan = false;

vi.mock('./session-context.js', () => ({
  getCurrentSessionId: () => mockCurrentSessionId,
  getSessionIdFromContext: () => mockScopedSessionId,
}));

vi.mock('./session-tracing.js', () => ({
  isInNativeSubagentSpan: () => mockIsInNativeSubagentSpan,
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

// A log record at hrTime [1000, 0] unless `extra` overrides it.
const logRec = (
  body: string | undefined,
  attributes: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) =>
  ({
    body,
    hrTime: [1000, 0],
    attributes,
    ...extra,
  }) as unknown as ReadableLogRecord;

// A record whose event.name repeats its body.
const named = (name: string, seconds = 1000) =>
  logRec(name, { 'event.name': name }, { hrTime: [seconds, 0] });

const makeExporter = (exportMock: Mock = vi.fn()) =>
  ({
    export: exportMock,
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  }) as unknown as SpanExporter;

const spyStderr = () =>
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
type StderrSpy = ReturnType<typeof spyStderr>;

// Runs `body` with stderr stubbed, restoring it afterwards.
async function withStderr(
  body: (stderrWrite: StderrSpy) => Promise<void> | void,
) {
  const stderrWrite = spyStderr();
  try {
    await body(stderrWrite);
  } finally {
    stderrWrite.mockRestore();
  }
}

const dropped = (total: number) =>
  expect.stringContaining(
    `dropped 1 oldest span(s) since last warning, ${total} total`,
  );

const SENSITIVE = {
  error: 'secret error',
  ['error.message']: 'secret error message',
  error_message: 'secret upstream error',
  prompt: 'secret prompt',
  function_args: '{"token":"secret"}',
  request_text: 'secret request',
  response_text: 'secret response',
};

describe('LogToSpanProcessor', () => {
  let processor: LogToSpanProcessor;
  let mockExporter: SpanExporter;
  let exportedSpans: ExportedSpan[];

  // Emits one record, flushes, and returns the first exported span.
  const bridge = async (...args: Parameters<typeof logRec>) => {
    processor.onEmit(logRec(...args));
    await processor.forceFlush();
    return exportedSpans[0];
  };

  const emitNamed = (...names: string[]) => {
    for (const name of names) processor.onEmit(named(name));
  };

  // Swaps in a processor capped at `maxBufferSize` and runs `body` with
  // stderr stubbed.
  const withBufferLimit = async (
    maxBufferSize: number,
    body: (stderrWrite: StderrSpy) => Promise<void> | void,
  ) => {
    await processor.shutdown();
    processor = new LogToSpanProcessor(mockExporter, 60000, maxBufferSize);
    await withStderr(body);
  };

  // Flushes event1 and event2 (one second apart) and returns their contexts.
  const traceContexts = async (
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ) => {
    processor.onEmit(logRec('event1', first));
    processor.onEmit(logRec('event2', second, { hrTime: [1001, 0] }));
    await processor.forceFlush();
    return [exportedSpans[0].spanContext(), exportedSpans[1].spanContext()];
  };

  const expectSession = (span: ExportedSpan, sessionId: string) => {
    expect(span.attributes['session.id']).toBe(sessionId);
    expect(span.spanContext().traceId).toBe(deriveTraceId(sessionId));
  };

  beforeEach(() => {
    exportedSpans = [];
    mockCurrentSessionId = undefined;
    mockScopedSessionId = undefined;
    mockIsInNativeSubagentSpan = false;
    mockExporter = makeExporter(
      vi.fn((spans, cb) => {
        exportedSpans.push(...spans);
        cb({ code: 0 });
      }),
    );
    processor = new LogToSpanProcessor(mockExporter, 60000);
  });

  afterEach(async () => {
    await processor.shutdown();
  });

  it('converts a log record to a span on flush', async () => {
    const span = await bridge(
      'test event',
      { 'event.name': 'test_event', key1: 'value1', key2: 42, key3: true },
      { hrTime: [1000, 500000000] },
    );

    expect(exportedSpans).toHaveLength(1);
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
    const span = await bridge('api response', { duration_ms: 250 });

    expect(span.endTime).toEqual([1000, 250000000]);
  });

  it('ignores non-finite duration_ms values', async () => {
    const span = await bridge('api response', { duration_ms: Infinity });

    expect(span.endTime).toEqual([1000, 0]);
  });

  it('handles duration_ms that causes second rollover', async () => {
    const span = await bridge(
      'long operation',
      { duration_ms: 500 },
      { hrTime: [1000, 900000000] },
    );

    expect(span.endTime).toEqual([1001, 400000000]);
  });

  it('serializes object attributes to JSON', async () => {
    const span = await bridge('event with object', {
      metadata: { nested: true },
    });

    expect(span.attributes['metadata']).toBe('{"nested":true}');
  });

  it('handles unserializable object attributes safely', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const span = await bridge('event', { bad: circular });

    expect(span.attributes['bad']).toBe('[unserializable]');
  });

  it('drops sensitive attributes before exporting bridged spans', async () => {
    const { attributes: attrs } = await bridge('event', {
      ...SENSITIVE,
      error_type: 'RateLimitError',
      safe: 'visible',
    });

    for (const key of Object.keys(SENSITIVE)) {
      expect(attrs).not.toHaveProperty(key);
    }
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

    const { attributes: attrs } = await bridge('event', {
      ...SENSITIVE,
      safe: 'visible',
    });

    for (const [key, value] of Object.entries(SENSITIVE)) {
      expect(attrs[key]).toBe(value);
    }
    expect(attrs['safe']).toBe('visible');
    expect(attrs['log.bridge']).toBe(true);
  });

  it('skips null and undefined attributes', async () => {
    const { attributes: attrs } = await bridge('event', {
      valid: 'yes',
      nullVal: null,
      undefinedVal: undefined,
    });

    expect(attrs['valid']).toBe('yes');
    expect(attrs).not.toHaveProperty('nullVal');
    expect(attrs).not.toHaveProperty('undefinedVal');
    expect(attrs['log.bridge']).toBe(true);
  });

  it('uses a safe fallback span name when event name is missing', async () => {
    const span = await bridge(undefined);

    expect(span.name).toBe('log.event');
  });

  it('truncates long span names', async () => {
    const longName = 'x'.repeat(200);

    const span = await bridge('body is not used for span name', {
      'event.name': longName,
    });

    expect(span.name).toBe(`${'x'.repeat(128)}...`);
  });

  it('uses event.name instead of raw log body for span names', async () => {
    const span = await bridge(
      'API error for test-model. Error: secret upstream failure.',
      { 'event.name': 'api_error', error_message: 'secret upstream failure' },
    );

    expect(span.name).toBe('api_error');
    expect(span.name).not.toContain('secret upstream failure');
  });

  it('generates unique trace IDs without session.id', async () => {
    const [ctx1, ctx2] = await traceContexts({}, {});

    expect(ctx1.traceId).toHaveLength(32);
    expect(ctx1.spanId).toHaveLength(16);
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('derives same traceId from same session.id', async () => {
    const [ctx1, ctx2] = await traceContexts(
      { 'session.id': 'session-abc' },
      { 'session.id': 'session-abc' },
    );

    expect(ctx1.traceId).toBe(ctx2.traceId);
    expect(ctx1.spanId).not.toBe(ctx2.spanId);
  });

  it('derives different traceIds from different session.ids', async () => {
    const [ctx1, ctx2] = await traceContexts(
      { 'session.id': 'session-abc' },
      { 'session.id': 'session-xyz' },
    );

    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('uses the log record span context as parent when available', async () => {
    const parentSpanContext: SpanContext = {
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    };

    const span = await bridge(
      'event',
      { 'event.name': 'child_event', 'session.id': 'session-abc' },
      { spanContext: parentSpanContext },
    );

    expect(span.spanContext().traceId).toBe(parentSpanContext.traceId);
    expect(span.parentSpanContext).toBe(parentSpanContext);
  });

  it('drops the oldest spans when the buffer exceeds the configured limit', () =>
    withBufferLimit(2, async (stderrWrite) => {
      processor.onEmit(named('event1'));
      processor.onEmit(named('event2', 1001));
      processor.onEmit(named('event3', 1002));

      expect(stderrWrite).toHaveBeenCalledWith(dropped(1));

      await processor.forceFlush();

      expect(exportedSpans.map((span) => span.name)).toEqual([
        'event2',
        'event3',
      ]);
    }));

  it('falls back to the default buffer size for invalid configured limits', () =>
    withBufferLimit(0, async (stderrWrite) => {
      emitNamed('event1', 'event2', 'event3');

      await processor.forceFlush();

      expect(exportedSpans.map((span) => span.name)).toEqual([
        'event1',
        'event2',
        'event3',
      ]);
      expect(stderrWrite).not.toHaveBeenCalledWith(
        expect.stringContaining('buffer exceeded max size'),
      );
    }));

  it('floors fractional configured buffer limits', () =>
    withBufferLimit(2.9, async (stderrWrite) => {
      emitNamed('event1', 'event2', 'event3');

      await processor.forceFlush();

      expect(exportedSpans.map((span) => span.name)).toEqual([
        'event2',
        'event3',
      ]);
      expect(stderrWrite).toHaveBeenCalledWith(dropped(1));
    }));

  it('reports total dropped spans across overflow warnings', () =>
    withBufferLimit(2, (stderrWrite) => {
      const dateNow = vi
        .spyOn(Date, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(31_001);
      try {
        emitNamed('event1', 'event2', 'event3', 'event4');

        expect(stderrWrite).toHaveBeenNthCalledWith(1, dropped(1));
        expect(stderrWrite).toHaveBeenNthCalledWith(2, dropped(2));
      } finally {
        dateNow.mockRestore();
      }
    }));

  it('emits pending dropped-span count during shutdown', () =>
    withBufferLimit(2, async (stderrWrite) => {
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1000);
      try {
        emitNamed('event1', 'event2', 'event3', 'event4');

        expect(stderrWrite).toHaveBeenCalledTimes(1);
        expect(stderrWrite).toHaveBeenNthCalledWith(1, dropped(1));

        await processor.shutdown();

        expect(stderrWrite).toHaveBeenCalledTimes(2);
        expect(stderrWrite).toHaveBeenNthCalledWith(2, dropped(2));
      } finally {
        dateNow.mockRestore();
      }
    }));

  it('sets ERROR status for truthy error attributes', async () => {
    const span = await bridge('api error', {
      error: 'raw error',
      ['error.message']: 'connection refused',
      error_message: 'connection refused',
      error_type: 'NETWORK',
    });

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('Log event recorded error');
    expect(span.attributes).not.toHaveProperty('error');
    expect(span.attributes).not.toHaveProperty('error.message');
    expect(span.attributes).not.toHaveProperty('error_message');
    expect(span.attributes['error_type']).toBe('NETWORK');
    expect(JSON.stringify(span.status)).not.toContain('connection refused');
  });

  it('does not set ERROR for success: false (normal decline)', async () => {
    const span = await bridge('tool call declined', {
      success: false,
      function_name: 'bash',
    });

    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('keeps cancelled tool calls UNSET even when legacy errors are present', async () => {
    const span = await bridge('tool call cancelled', {
      'event.name': 'qwen-code.tool_call',
      status: 'cancelled',
      success: false,
      error: 'cancelled by user',
      error_type: 'unhandled_exception',
    });

    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('keeps ERROR for cancelled non-tool events that carry an error', async () => {
    const span = await bridge('auth cancelled with error', {
      'event.name': 'qwen-code.auth',
      status: 'cancelled',
      error_message: 'auth flow failed',
    });

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('does not set ERROR for falsy error attributes', async () => {
    const span = await bridge('ok event', {
      error: null,
      error_message: '',
      error_type: '',
    });

    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('sets ERROR when only error.message is present (OTel semantic convention)', async () => {
    const span = await bridge('otel error', {
      ['error.message']: 'upstream timeout',
    });

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).not.toHaveProperty('error.message');
  });

  it('preserves severity attributes', async () => {
    const span = await bridge(
      'event',
      {},
      { severityNumber: 9, severityText: 'INFO' },
    );

    expect(span.attributes['log.severity_number']).toBe(9);
    expect(span.attributes['log.severity_text']).toBe('INFO');
  });

  it('reuses in-flight exports and flushes queued spans afterwards', async () => {
    await processor.shutdown();
    exportedSpans = [];
    const exportCallbacks: Array<(result: { code: number }) => void> = [];
    let exportCallCount = 0;
    mockExporter = makeExporter(
      vi.fn((spans, cb) => {
        exportCallCount += 1;
        exportedSpans.push(...spans);
        if (exportCallCount === 1) {
          exportCallbacks.push(cb);
        } else {
          cb({ code: 0 });
        }
      }),
    );
    processor = new LogToSpanProcessor(mockExporter, 60000);

    processor.onEmit(named('first'));
    const firstFlush = processor.forceFlush();
    await Promise.resolve();

    processor.onEmit(named('second', 1001));
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
    processor.onEmit(logRec('final event'));
    await processor.shutdown();

    expect(exportedSpans).toHaveLength(1);
    expect(mockExporter.shutdown).toHaveBeenCalled();
  });

  it('does not collect or flush spans after shutdown', async () => {
    await processor.shutdown();

    processor.onEmit(logRec('late event'));
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

    const span = await bridge('event without session attr');

    // The traceId should be derived from the fallback session ID,
    // not a random one.
    expectSession(span, 'session-from-context');
  });

  it('prefers and stamps the scoped OTel session over the global fallback', async () => {
    mockCurrentSessionId = 'stale-session';
    mockScopedSessionId = 'scoped-session';

    processor.onEmit(logRec('scoped event'), ROOT_CONTEXT);
    await processor.forceFlush();

    expectSession(exportedSpans[0], 'scoped-session');
  });

  it('uses the per-request session before the global fallback', async () => {
    mockCurrentSessionId = 'stale-session';
    const logRecord = logRec('request-scoped event');

    sessionIdContext.run('request-session', () => processor.onEmit(logRecord));
    await processor.forceFlush();

    expectSession(exportedSpans[0], 'request-session');
  });

  it('prefers log record session.id over getCurrentSessionId', async () => {
    mockCurrentSessionId = 'stale-session';
    mockScopedSessionId = 'wrong-scoped-session';

    const span = await bridge('event with session attr', {
      'session.id': 'fresh-session',
    });

    expectSession(span, 'fresh-session');
  });

  describe('bridge skip-list (#3731 Phase 3)', () => {
    it('skips qwen-code.subagent_execution when native subagent span is active', async () => {
      mockIsInNativeSubagentSpan = true;

      await bridge(
        'subagent started',
        {
          'event.name': 'qwen-code.subagent_execution',
          subagent_name: 'Explore',
          status: 'started',
        },
        { hrTime: [2000, 0] },
      );

      expect(exportedSpans).toHaveLength(0);
      mockIsInNativeSubagentSpan = false;
    });

    it('bridges subagent_execution when no native span is active (e.g. runForkedAgent)', async () => {
      mockIsInNativeSubagentSpan = false;

      await bridge(
        'forked agent started',
        {
          'event.name': 'qwen-code.subagent_execution',
          subagent_name: 'dreamAgent',
          status: 'started',
        },
        { hrTime: [2500, 0] },
      );

      expect(exportedSpans).toHaveLength(1);
      expect(exportedSpans[0].name).toBe('qwen-code.subagent_execution');
    });

    it('still bridges other events normally (e.g. qwen-code.tool_call)', async () => {
      await bridge(
        'tool call',
        { 'event.name': 'qwen-code.tool_call', tool_name: 'read_file' },
        { hrTime: [3000, 0] },
      );

      // Sanity check: skip list is narrow — non-listed events still bridge.
      expect(exportedSpans).toHaveLength(1);
      expect(exportedSpans[0].name).toBe('qwen-code.tool_call');
    });
  });

  describe('export failure diagnostics', () => {
    const flushOne = () => bridge('event', { 'event.name': 'event' });

    // Swaps in a processor whose exporter fails with `error`, flushes one
    // record with stderr stubbed, and hands the spy and its first line to
    // `check`.
    const failWith = async (
      error: Error | undefined,
      check: (stderrWrite: StderrSpy, msg: string) => void,
    ) => {
      await processor.shutdown();
      processor = new LogToSpanProcessor(
        makeExporter(vi.fn((_spans, cb) => cb({ code: 1, error }))),
        60000,
      );
      await withStderr(async (stderrWrite) => {
        await flushOne();
        check(stderrWrite, stderrWrite.mock.calls[0]?.[0] as string);
      });
    };

    // Swaps in a processor exporting through `exportMock` whose diagnostics
    // go to `sink`.
    const installSink = async (
      exportMock: Mock,
      options: { maxBufferSize?: number } = {},
      sink: Mock = vi.fn(),
    ) => {
      await processor.shutdown();
      processor = new LogToSpanProcessor(makeExporter(exportMock), {
        flushIntervalMs: 60000,
        diagnosticsSink: sink,
        ...options,
      });
      return sink;
    };

    // Flushes one record through an exporter whose export() throws `thrown`.
    const sinkAfterThrow = async (thrown: unknown) => {
      const sink = await installSink(
        vi.fn(() => {
          throw thrown;
        }),
      );
      await flushOne();
      return sink;
    };

    it('falls back to error.name when message is empty (HTTP/2 / stripped reason phrase)', () =>
      failWith(
        Object.assign(new Error(''), {
          name: 'OTLPExporterError',
          code: 403,
          data: 'Forbidden: invalid license',
        }),
        (stderrWrite) => {
          expect(stderrWrite).toHaveBeenCalledWith(
            '[LogToSpan] export failed: code=1 error="OTLPExporterError" httpCode=403 data="Forbidden: invalid license"\n',
          );
        },
      ));

    it('JSON-escapes embedded newlines in message and data so the record stays on one line', async () => {
      const err = Object.assign(new Error('line1\nline2'), {
        name: 'OTLPExporterError',
        code: 500,
        data: '{\n  "error": "boom"\n}',
      });
      const sink = await installSink(
        vi.fn((_s, cb) => cb({ code: 1, error: err })),
      );

      await flushOne();
      const msg = sink.mock.calls[0][0] as string;
      expect(msg).not.toContain('\n');
      expect(msg).toContain('error="line1\\nline2"');
      expect(msg).toContain('data="{\\n  \\"error\\": \\"boom\\"\\n}"');
    });

    it('truncates response data snippets to 200 characters before stringifying', () =>
      failWith(
        Object.assign(new Error(''), {
          name: 'OTLPExporterError',
          code: 500,
          data: 'x'.repeat(500),
        }),
        (_, msg) => {
          expect(msg).toContain('httpCode=500');
          expect(msg).toContain(`data="${'x'.repeat(200)}"`);
          expect(msg).not.toContain('x'.repeat(201));
        },
      ));

    it('omits httpCode when err.code is a non-numeric networking code (ECONNREFUSED)', () =>
      failWith(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
          code: 'ECONNREFUSED',
        }),
        (_, msg) => {
          expect(msg).not.toContain('httpCode=');
          expect(msg).toContain('error="connect ECONNREFUSED 127.0.0.1"');
        },
      ));

    it('reports error="unknown" when result.error is missing', () =>
      failWith(undefined, (stderrWrite) => {
        expect(stderrWrite).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="unknown"\n',
        );
      }));

    it('omits data field when err.data is a non-string truthy value (e.g. Buffer)', () =>
      failWith(
        Object.assign(new Error('fail'), {
          code: 500,
          data: Buffer.from('binary'),
        }),
        (_, msg) => {
          expect(msg).toContain('httpCode=500');
          expect(msg).not.toContain('data=');
        },
      ));

    it('falls back to "unknown" when both message and name are empty (e.g. minified Error)', () =>
      failWith(Object.assign(new Error(''), { name: '' }), (stderrWrite) => {
        expect(stderrWrite).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="unknown"\n',
        );
      }));

    it('omits data field when err.data is an empty string (guards against length>0 loosening)', () =>
      failWith(
        Object.assign(new Error('fail'), { code: 500, data: '' }),
        (_, msg) => {
          expect(msg).toContain('httpCode=500');
          expect(msg).not.toContain('data=');
        },
      ));

    it('routes diagnostics to an injected sink without touching stderr', async () => {
      const sink = await installSink(
        vi.fn((_spans, cb) => cb({ code: 1, error: new Error('boom') })),
      );

      await withStderr(async (stderrWrite) => {
        await flushOne();
        expect(sink).toHaveBeenCalledWith(
          '[LogToSpan] export failed: code=1 error="boom"',
        );
        expect(stderrWrite).not.toHaveBeenCalled();
      });
    });

    it('routes buffer-overflow warnings through the injected sink', async () => {
      const sink = await installSink(
        vi.fn((_s, cb) => cb({ code: 0 })),
        {
          maxBufferSize: 2,
        },
      );

      emitNamed('a', 'b', 'c');

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
          // Never invoke the callback — force the timeout branch.
          makeExporter(vi.fn()),
          { flushIntervalMs: 60000, diagnosticsSink: sink },
        );
        processor.onEmit(named('event'));

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
      const sink = await sinkAfterThrow(
        new Error('exporter exploded synchronously'),
      );

      expect(sink).toHaveBeenCalledWith(
        '[LogToSpan] export threw: error="exporter exploded synchronously"',
      );
    });

    it('surfaces httpCode/data when a sync-thrown error carries OTLPExporterError fields', async () => {
      const sink = await sinkAfterThrow(
        Object.assign(new Error('Bad Request'), {
          name: 'OTLPExporterError',
          code: 400,
          data: 'malformed payload',
        }),
      );

      expect(sink).toHaveBeenCalledWith(
        '[LogToSpan] export threw: error="Bad Request" httpCode=400 data="malformed payload"',
      );
    });

    it('JSON-escapes export-threw payloads with embedded newlines (single-line invariant)', async () => {
      const sink = await sinkAfterThrow(new Error('line1\nline2'));

      const msg = sink.mock.calls[0][0] as string;
      expect(msg).not.toContain('\n');
      expect(msg).toBe('[LogToSpan] export threw: error="line1\\nline2"');
    });

    it('handles non-Error throws (e.g. throw "string") in the export-threw path', async () => {
      // Deliberate non-Error throw to exercise the String(err) branch.
      const sink = await sinkAfterThrow('raw string thrown');

      expect(sink).toHaveBeenCalledWith(
        '[LogToSpan] export threw: error="raw string thrown"',
      );
    });

    it('keeps processing exports after the sink throws', async () => {
      const sink = vi.fn(() => {
        throw new Error('sink exploded');
      });
      const exportFn = vi.fn(
        (_spans, cb: (r: { code: number; error?: Error }) => void) =>
          cb({ code: 1, error: new Error('boom') }),
      );
      await installSink(exportFn, {}, sink);

      await flushOne();
      await flushOne();

      expect(exportFn).toHaveBeenCalledTimes(2);
      expect(sink).toHaveBeenCalledTimes(2);
    });
  });
});

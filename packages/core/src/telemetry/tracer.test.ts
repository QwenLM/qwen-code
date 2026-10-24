/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import {
  withSpan,
  startSpanWithContext,
  createSessionRootContext,
} from './tracer.js';
import { deriveTraceId } from './trace-id-utils.js';

const mockState = vi.hoisted(() => ({
  getSpanReturn: undefined as unknown,
  lastParentCtx: undefined as unknown,
  activeContext: {} as unknown,
  throwOnSetStatus: false,
  throwOnEnd: false,
  nonWritableSetStatus: false,
}));
const debugWarnCalls = vi.hoisted((): unknown[][] => []);

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      debugWarnCalls.push(args);
    },
    error: () => {},
  }),
}));

// Collect span operations for assertions
interface SpanRecord {
  name: string;
  attributes: Record<string, string | number | boolean>;
  statuses: Array<{ code: number; message?: string }>;
  ended: boolean;
}

const spans: SpanRecord[] = [];

// Mock @opentelemetry/api to capture span behavior
vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );

  function createMockSpan(
    name: string,
    attributes: Record<string, string | number | boolean>,
  ) {
    const record: SpanRecord = { name, attributes, statuses: [], ended: false };
    spans.push(record);
    const span = {
      ...record,
      spanContext: () => ({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      }),
      setStatus(status: object) {
        if (mockState.throwOnSetStatus) {
          throw new Error('setStatus failed');
        }
        record.statuses.push(status as { code: number; message?: string });
      },
      setAttribute() {},
      end() {
        if (mockState.throwOnEnd) {
          throw new Error('end failed');
        }
        record.ended = true;
      },
    };
    if (mockState.nonWritableSetStatus) {
      Object.defineProperty(span, 'setStatus', { writable: false });
    }
    return span;
  }

  const mockTracer = {
    startActiveSpan(
      name: string,
      options: { attributes?: Record<string, string | number | boolean> },
      ctx: unknown,
      fn: (span: ReturnType<typeof createMockSpan>) => unknown,
    ) {
      mockState.lastParentCtx = ctx;
      const span = createMockSpan(name, options.attributes ?? {});
      return fn(span);
    },
    startSpan(
      name: string,
      options: { attributes?: Record<string, string | number | boolean> },
      ctx?: unknown,
    ) {
      mockState.lastParentCtx = ctx;
      return createMockSpan(name, options.attributes ?? {});
    },
  };

  return {
    ...actual,
    SpanStatusCode: actual.SpanStatusCode,
    TraceFlags: actual.TraceFlags,
    trace: {
      getTracer: () => mockTracer,
      getSpan: () => mockState.getSpanReturn,
      setSpan: (_ctx: unknown, span: unknown) => span,
      wrapSpanContext: (ctx: unknown) => ctx,
    },
    context: {
      active: () => mockState.activeContext,
      with: (_ctx: unknown, fn: () => unknown) => fn(),
    },
  };
});

beforeEach(() => {
  spans.length = 0;
  mockState.getSpanReturn = undefined;
  mockState.lastParentCtx = undefined;
  mockState.activeContext = {};
  mockState.throwOnSetStatus = false;
  mockState.throwOnEnd = false;
  mockState.nonWritableSetStatus = false;
  debugWarnCalls.length = 0;
});

const errorStatus = (message: string) => ({
  code: SpanStatusCode.ERROR,
  message,
});

// Asserts the single recorded span carries exactly `statuses` and has ended.
function expectOnlySpan(statuses: SpanRecord['statuses']) {
  expect(spans).toHaveLength(1);
  expect(spans[0].statuses).toEqual(statuses);
  expect(spans[0].ended).toBe(true);
}

// Runs withSpan on a callback that throws `message`; asserts the rejection.
async function expectSpanRejects(
  name: string,
  message: string,
  options?: { autoOkOnSuccess?: boolean },
) {
  await expect(
    withSpan(
      name,
      {},
      async () => {
        throw new Error(message);
      },
      options,
    ),
  ).rejects.toThrow(message);
}

describe('withSpan', () => {
  it('rate-limits repeated telemetry operation warnings and reports suppressed count', async () => {
    mockState.throwOnSetStatus = true;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);

      await withSpan('test.status-fail-1', {}, async () => 1);
      await withSpan('test.status-fail-2', {}, async () => 2);
      await withSpan('test.status-fail-3', {}, async () => 3);

      expect(debugWarnCalls).toHaveLength(1);
      expect(debugWarnCalls[0]?.[0]).toContain('OTel span setStatus failed');
      expect(debugWarnCalls[0]?.[0]).not.toContain('suppressed');

      vi.setSystemTime(30_001);
      await withSpan('test.status-fail-4', {}, async () => 4);

      expect(debugWarnCalls).toHaveLength(2);
      expect(debugWarnCalls[1]?.[0]).toContain(
        'suppressed 2 similar warning(s)',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets OK status when callback resolves without setting status', async () => {
    const result = await withSpan('test.op', { key: 'value' }, async () => 42);

    expect(result).toBe(42);
    expectOnlySpan([{ code: SpanStatusCode.OK }]);
    expect(spans[0].name).toBe('test.op');
  });

  it('preserves ERROR status set by callback (does not overwrite with OK)', async () => {
    // The callback returns normally; only its ERROR status may be present.
    await withSpan('test.handled-error', {}, async (span) => {
      span.setStatus(errorStatus('hook denied'));
    });

    expectOnlySpan([errorStatus('hook denied')]);
  });

  it('tracks explicit status without mutating non-writable spans', async () => {
    mockState.nonWritableSetStatus = true;

    await withSpan('test.non-writable-status', {}, async (span) => {
      span.setStatus(errorStatus('custom error'));
    });

    expectOnlySpan([errorStatus('custom error')]);
  });

  it('sets ERROR status when callback throws and no status was set', async () => {
    await expectSpanRejects('test.throw', 'something failed');

    expectOnlySpan([errorStatus('Operation failed')]);
    expect(JSON.stringify(spans[0].statuses)).not.toContain('something failed');
  });

  it('does not overwrite ERROR when callback throws after setting status', async () => {
    await expect(
      withSpan('test.throw-after-status', {}, async (span) => {
        span.setStatus(errorStatus('custom error'));
        throw new Error('exception');
      }),
    ).rejects.toThrow('exception');

    // Only the callback's status should be present
    expectOnlySpan([errorStatus('custom error')]);
  });

  it('ends the span even when callback throws', async () => {
    await expectSpanRejects('test.ensure-end', 'boom');

    expect(spans[0].ended).toBe(true);
  });

  it('does not let OK status failures mask a successful result', async () => {
    mockState.throwOnSetStatus = true;

    const result = await withSpan('test.status-fail', {}, async () => 42);

    expect(result).toBe(42);
    expect(spans[0].statuses).toEqual([]);
    expect(spans[0].ended).toBe(true);
    expect(debugWarnCalls[0]?.[0]).toContain('OTel span setStatus failed');
  });

  it('does not let ERROR status failures mask the original error', async () => {
    mockState.throwOnSetStatus = true;

    await expectSpanRejects('test.error-status-fail', 'original failure');

    expect(spans[0].statuses).toEqual([]);
    expect(spans[0].ended).toBe(true);
  });

  it('does not let span end failures mask the original error', async () => {
    mockState.throwOnEnd = true;

    await expectSpanRejects('test.end-fail', 'original failure');

    expect(spans[0].statuses).toEqual([errorStatus('Operation failed')]);
    expect(spans[0].ended).toBe(false);
  });

  it('passes attributes to the span', async () => {
    await withSpan(
      'test.attrs',
      { tool_name: 'read', call_id: '123' },
      async () => {},
    );

    expect(spans[0].attributes).toEqual({ tool_name: 'read', call_id: '123' });
  });

  describe('autoOkOnSuccess option', () => {
    it('does not auto-set OK when autoOkOnSuccess is false and callback resolves', async () => {
      await withSpan('test.no-auto-ok', {}, async () => 42, {
        autoOkOnSuccess: false,
      });

      expectOnlySpan([]);
    });

    it('still sets ERROR when callback throws and autoOkOnSuccess is false', async () => {
      await expectSpanRejects('test.throw-no-auto', 'fail', {
        autoOkOnSuccess: false,
      });

      expect(spans).toHaveLength(1);
      expect(spans[0].statuses).toEqual([errorStatus('Operation failed')]);
    });

    it('preserves caller-set ERROR with autoOkOnSuccess false', async () => {
      await withSpan(
        'test.error-no-auto',
        {},
        async (span) => {
          span.setStatus(errorStatus('hook denied'));
        },
        { autoOkOnSuccess: false },
      );

      expect(spans).toHaveLength(1);
      expect(spans[0].statuses).toEqual([errorStatus('hook denied')]);
    });

    it('allows caller to set OK explicitly with autoOkOnSuccess false', async () => {
      await withSpan(
        'test.explicit-ok',
        {},
        async (span) => {
          span.setStatus({ code: SpanStatusCode.OK });
          return 'done';
        },
        { autoOkOnSuccess: false },
      );

      expect(spans).toHaveLength(1);
      expect(spans[0].statuses).toEqual([{ code: SpanStatusCode.OK }]);
    });
  });
});

describe('startSpanWithContext', () => {
  it('returns a span and runInContext function', () => {
    const { span, runInContext } = startSpanWithContext('test.manual', {
      key: 'val',
    });

    expect(span).toBeDefined();
    expect(typeof runInContext).toBe('function');
  });

  it('runInContext executes the function and returns its result', () => {
    const { runInContext } = startSpanWithContext('test.ctx', {});
    const result = runInContext(() => 'hello');
    expect(result).toBe('hello');
  });
});

describe('createSessionRootContext', () => {
  // The mocked trace.setSpan/wrapSpanContext return the span context itself.
  const rootContext = (sessionId: string) =>
    createSessionRootContext(sessionId) as unknown as {
      traceId: string;
      spanId: string;
      traceFlags: number;
      isRemote: boolean;
    };

  it('derives a deterministic traceId from session ID (spanId is random)', () => {
    expect(rootContext('session-123').traceId).toBe(
      deriveTraceId('session-123'),
    );
  });

  it.each([
    [
      'uses TraceFlags.SAMPLED by default (no OTEL_TRACES_SAMPLER)',
      undefined,
      'session-123',
      TraceFlags.SAMPLED,
    ],
    [
      'uses TraceFlags.NONE when a custom sampler is configured',
      'traceidratio',
      'session-456',
      TraceFlags.NONE,
    ],
    [
      'uses TraceFlags.SAMPLED when OTEL_TRACES_SAMPLER=always_on',
      'always_on',
      'session-ao',
      TraceFlags.SAMPLED,
    ],
    [
      'uses TraceFlags.NONE when OTEL_TRACES_SAMPLER=always_off',
      'always_off',
      'session-aoff',
      TraceFlags.NONE,
    ],
    [
      'uses TraceFlags.SAMPLED when OTEL_TRACES_SAMPLER=parentbased_always_on',
      'parentbased_always_on',
      'session-789',
      TraceFlags.SAMPLED,
    ],
    [
      'uses TraceFlags.NONE when OTEL_TRACES_SAMPLER=parentbased_always_off',
      'parentbased_always_off',
      'session-off',
      TraceFlags.NONE,
    ],
    [
      'uses TraceFlags.SAMPLED for parentbased_traceidratio (parent flag gates children)',
      'parentbased_traceidratio',
      'session-pb-ratio',
      TraceFlags.SAMPLED,
    ],
  ])('%s', (_title, sampler, sessionId, expected) => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    if (sampler === undefined) delete process.env['OTEL_TRACES_SAMPLER'];
    else process.env['OTEL_TRACES_SAMPLER'] = sampler;
    try {
      expect(rootContext(sessionId).traceFlags).toBe(expected);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('generates a valid 16-char hex spanId', () => {
    expect(rootContext('session-123').spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces same traceId for same session ID', () => {
    expect(rootContext('session-abc').traceId).toBe(
      rootContext('session-abc').traceId,
    );
  });

  it('produces different traceId for different session IDs', () => {
    expect(rootContext('session-abc').traceId).not.toBe(
      rootContext('session-xyz').traceId,
    );
  });
});

describe('parent context selection', () => {
  it('always uses context.active() as parent', async () => {
    mockState.activeContext = { _sentinel: 'active' };

    await withSpan('test.active-parent', {}, async () => {});

    expect(mockState.lastParentCtx).toBe(mockState.activeContext);
  });

  it('uses context.active() even when no active span exists', async () => {
    const activeCtx = { _sentinel: 'empty-context' };
    mockState.getSpanReturn = undefined;
    mockState.activeContext = activeCtx;

    await withSpan('test.fallback', {}, async () => {});

    expect(mockState.lastParentCtx).toBe(activeCtx);
  });

  it('applies the same parent context logic for startSpanWithContext', () => {
    mockState.activeContext = { _sentinel: 'active-for-manual' };

    startSpanWithContext('test.manual', {});

    expect(mockState.lastParentCtx).toBe(mockState.activeContext);
  });
});

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
  sessionContext: undefined as unknown,
  activeContext: {} as unknown,
  throwOnSetStatus: false,
  throwOnEnd: false,
  nonWritableSetStatus: false,
}));
const debugWarnCalls = vi.hoisted((): unknown[][] => []);

vi.mock('./session-context.js', () => ({
  getSessionContext: () => mockState.sessionContext,
}));

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
  mockState.sessionContext = undefined;
  mockState.activeContext = {};
  mockState.throwOnSetStatus = false;
  mockState.throwOnEnd = false;
  mockState.nonWritableSetStatus = false;
  debugWarnCalls.length = 0;
});

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
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test.op');
    expect(spans[0].statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(spans[0].ended).toBe(true);
  });

  it('preserves ERROR status set by callback (does not overwrite with OK)', async () => {
    await withSpan('test.handled-error', {}, async (span) => {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'hook denied',
      });
      // Return normally without throwing
    });

    expect(spans).toHaveLength(1);
    // Only the ERROR status set by the callback should be present
    expect(spans[0].statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'hook denied' },
    ]);
    expect(spans[0].ended).toBe(true);
  });

  it('tracks explicit status without mutating non-writable spans', async () => {
    mockState.nonWritableSetStatus = true;

    await withSpan('test.non-writable-status', {}, async (span) => {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'custom error',
      });
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'custom error' },
    ]);
    expect(spans[0].ended).toBe(true);
  });

  it('sets ERROR status when callback throws and no status was set', async () => {
    const error = new Error('something failed');
    await expect(
      withSpan('test.throw', {}, async () => {
        throw error;
      }),
    ).rejects.toThrow('something failed');

    expect(spans).toHaveLength(1);
    expect(spans[0].statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'Operation failed' },
    ]);
    expect(JSON.stringify(spans[0].statuses)).not.toContain('something failed');
    expect(spans[0].ended).toBe(true);
  });

  it('does not overwrite ERROR when callback throws after setting status', async () => {
    await expect(
      withSpan('test.throw-after-status', {}, async (span) => {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'custom error',
        });
        throw new Error('exception');
      }),
    ).rejects.toThrow('exception');

    expect(spans).toHaveLength(1);
    // Only the callback's status should be present
    expect(spans[0].statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'custom error' },
    ]);
    expect(spans[0].ended).toBe(true);
  });

  it('ends the span even when callback throws', async () => {
    await expect(
      withSpan('test.ensure-end', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

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

    await expect(
      withSpan('test.error-status-fail', {}, async () => {
        throw new Error('original failure');
      }),
    ).rejects.toThrow('original failure');

    expect(spans[0].statuses).toEqual([]);
    expect(spans[0].ended).toBe(true);
  });

  it('does not let span end failures mask the original error', async () => {
    mockState.throwOnEnd = true;

    await expect(
      withSpan('test.end-fail', {}, async () => {
        throw new Error('original failure');
      }),
    ).rejects.toThrow('original failure');

    expect(spans[0].statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'Operation failed' },
    ]);
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

      expect(spans).toHaveLength(1);
      expect(spans[0].statuses).toEqual([]);
      expect(spans[0].ended).toBe(true);
    });

    it('still sets ERROR when callback throws and autoOkOnSuccess is false', async () => {
      await expect(
        withSpan(
          'test.throw-no-auto',
          {},
          async () => {
            throw new Error('fail');
          },
          { autoOkOnSuccess: false },
        ),
      ).rejects.toThrow('fail');

      expect(spans).toHaveLength(1);
      expect(spans[0].statuses).toEqual([
        { code: SpanStatusCode.ERROR, message: 'Operation failed' },
      ]);
    });

    it('preserves caller-set ERROR with autoOkOnSuccess false', async () => {
      await withSpan(
        'test.error-no-auto',
        {},
        async (span) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'hook denied',
          });
        },
        { autoOkOnSuccess: false },
      );

      expect(spans).toHaveLength(1);
      expect(spans[0].statuses).toEqual([
        { code: SpanStatusCode.ERROR, message: 'hook denied' },
      ]);
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
  it('derives a deterministic traceId from session ID (spanId is random)', () => {
    const ctx = createSessionRootContext('session-123') as unknown as {
      traceId: string;
      spanId: string;
      traceFlags: number;
      isRemote: boolean;
    };
    expect(ctx.traceId).toBe(deriveTraceId('session-123'));
  });

  it('uses TraceFlags.SAMPLED by default (no OTEL_TRACES_SAMPLER)', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    delete process.env['OTEL_TRACES_SAMPLER'];
    try {
      const ctx = createSessionRootContext('session-123') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.NONE when a custom sampler is configured', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'traceidratio';
    try {
      const ctx = createSessionRootContext('session-456') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.NONE);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.SAMPLED when OTEL_TRACES_SAMPLER=always_on', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'always_on';
    try {
      const ctx = createSessionRootContext('session-ao') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.NONE when OTEL_TRACES_SAMPLER=always_off', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'always_off';
    try {
      const ctx = createSessionRootContext('session-aoff') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.NONE);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.SAMPLED when OTEL_TRACES_SAMPLER=parentbased_always_on', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'parentbased_always_on';
    try {
      const ctx = createSessionRootContext('session-789') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.NONE when OTEL_TRACES_SAMPLER=parentbased_always_off', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'parentbased_always_off';
    try {
      const ctx = createSessionRootContext('session-off') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.NONE);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.SAMPLED for parentbased_traceidratio (parent flag gates children)', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'parentbased_traceidratio';
    try {
      const ctx = createSessionRootContext('session-pb-ratio') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('generates a valid 16-char hex spanId', () => {
    const ctx = createSessionRootContext('session-123') as unknown as {
      spanId: string;
    };
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces same traceId for same session ID', () => {
    const ctx1 = createSessionRootContext('session-abc') as unknown as {
      traceId: string;
    };
    const ctx2 = createSessionRootContext('session-abc') as unknown as {
      traceId: string;
    };
    expect(ctx1.traceId).toBe(ctx2.traceId);
  });

  it('produces different traceId for different session IDs', () => {
    const ctx1 = createSessionRootContext('session-abc') as unknown as {
      traceId: string;
    };
    const ctx2 = createSessionRootContext('session-xyz') as unknown as {
      traceId: string;
    };
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });
});

describe('parent context selection', () => {
  it('uses session context as parent when no active span exists', async () => {
    const sessionCtx = { _sentinel: 'session' };
    mockState.getSpanReturn = undefined;
    mockState.sessionContext = sessionCtx;

    await withSpan('test.session-parent', {}, async () => {});

    expect(mockState.lastParentCtx).toBe(sessionCtx);
  });

  it('prefers active span context over session context', async () => {
    const sessionCtx = { _sentinel: 'session' };
    mockState.getSpanReturn = { _sentinel: 'active-span' };
    mockState.sessionContext = sessionCtx;

    await withSpan('test.active-parent', {}, async () => {});

    expect(mockState.lastParentCtx).toBe(mockState.activeContext);
  });

  it('falls back to active context when neither active span nor session context exists', async () => {
    mockState.getSpanReturn = undefined;
    mockState.sessionContext = undefined;

    await withSpan('test.fallback', {}, async () => {});

    expect(mockState.lastParentCtx).toBe(mockState.activeContext);
  });

  it('applies the same parent context logic for startSpanWithContext', () => {
    const sessionCtx = { _sentinel: 'session' };
    mockState.getSpanReturn = undefined;
    mockState.sessionContext = sessionCtx;

    startSpanWithContext('test.manual-session', {});

    expect(mockState.lastParentCtx).toBe(sessionCtx);
  });
});

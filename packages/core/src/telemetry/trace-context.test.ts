/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import type { Span, Context } from '@opentelemetry/api';
import { getSessionContext } from './session-context.js';
import {
  getActiveSpanTraceContext,
  getSessionRootTraceContext,
  getTraceContext,
  formatTraceparent,
  setShellTracePropagation,
  isShellTracePropagationEnabled,
  ZERO_TRACE_ID,
} from './trace-context.js';

const { INVALID_TRACE, INVALID_SPAN } = vi.hoisted(() => ({
  INVALID_TRACE: '0'.repeat(32),
  INVALID_SPAN: '0'.repeat(16),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: vi.fn().mockReturnValue(undefined),
    getSpan: vi.fn().mockReturnValue(undefined),
  },
  INVALID_TRACEID: INVALID_TRACE,
  isSpanContextValid: vi
    .fn()
    .mockImplementation(
      (ctx: { traceId: string; spanId: string }) =>
        ctx.traceId !== INVALID_TRACE && ctx.spanId !== INVALID_SPAN,
    ),
}));

vi.mock('./session-context.js', () => ({
  getSessionContext: vi.fn().mockReturnValue(undefined),
}));

function mockSpan(
  traceId: string,
  spanId: string,
  traceFlags: number,
): Span {
  return {
    spanContext: () => ({ traceId, spanId, traceFlags }),
  } as unknown as Span;
}

describe('trace-context', () => {
  beforeEach(() => {
    vi.mocked(trace.getActiveSpan).mockReturnValue(undefined);
    vi.mocked(trace.getSpan).mockReturnValue(undefined);
    vi.mocked(getSessionContext).mockReturnValue(undefined);
    setShellTracePropagation(false);
  });

  describe('getActiveSpanTraceContext', () => {
    it('returns trace context from active span', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(
        mockSpan('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 1),
      );

      const ctx = getActiveSpanTraceContext();
      expect(ctx).toEqual({
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanId: 'bbbbbbbbbbbbbbbb',
        traceFlags: 1,
      });
    });

    it('returns null for NOOP span with zero traceId', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(
        mockSpan(ZERO_TRACE_ID, 'bbbbbbbbbbbbbbbb', 0),
      );

      expect(getActiveSpanTraceContext()).toBeNull();
    });

    it('returns null when no active span', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(undefined);
      expect(getActiveSpanTraceContext()).toBeNull();
    });

    it('returns null when getActiveSpan throws', () => {
      vi.mocked(trace.getActiveSpan).mockImplementation(() => {
        throw new Error('otel unavailable');
      });

      expect(getActiveSpanTraceContext()).toBeNull();
    });
  });

  describe('getSessionRootTraceContext', () => {
    it('returns trace context from session root span', () => {
      const sessionCtx = {} as Context;
      vi.mocked(getSessionContext).mockReturnValue(sessionCtx);
      vi.mocked(trace.getSpan).mockImplementation((ctx) =>
        ctx === sessionCtx
          ? mockSpan(
              'cccccccccccccccccccccccccccccccc',
              'dddddddddddddddd',
              1,
            )
          : undefined,
      );

      const ctx = getSessionRootTraceContext();
      expect(ctx).toEqual({
        traceId: 'cccccccccccccccccccccccccccccccc',
        spanId: 'dddddddddddddddd',
        traceFlags: 1,
      });
    });

    it('returns null when no session context', () => {
      vi.mocked(getSessionContext).mockReturnValue(undefined);
      expect(getSessionRootTraceContext()).toBeNull();
    });

    it('returns null when session span has zero traceId', () => {
      const sessionCtx = {} as Context;
      vi.mocked(getSessionContext).mockReturnValue(sessionCtx);
      vi.mocked(trace.getSpan).mockReturnValue(
        mockSpan(ZERO_TRACE_ID, 'dddddddddddddddd', 0),
      );

      expect(getSessionRootTraceContext()).toBeNull();
    });
  });

  describe('getTraceContext', () => {
    it('prefers active span over session root', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(
        mockSpan('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 1),
      );
      const sessionCtx = {} as Context;
      vi.mocked(getSessionContext).mockReturnValue(sessionCtx);
      vi.mocked(trace.getSpan).mockReturnValue(
        mockSpan('cccccccccccccccccccccccccccccccc', 'dddddddddddddddd', 1),
      );

      const ctx = getTraceContext();
      expect(ctx?.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('falls back to session root when no active span', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(undefined);
      const sessionCtx = {} as Context;
      vi.mocked(getSessionContext).mockReturnValue(sessionCtx);
      vi.mocked(trace.getSpan).mockImplementation((ctx) =>
        ctx === sessionCtx
          ? mockSpan(
              'cccccccccccccccccccccccccccccccc',
              'dddddddddddddddd',
              1,
            )
          : undefined,
      );

      const ctx = getTraceContext();
      expect(ctx?.traceId).toBe('cccccccccccccccccccccccccccccccc');
    });

    it('returns null when neither source has context', () => {
      expect(getTraceContext()).toBeNull();
    });
  });

  describe('formatTraceparent', () => {
    it('formats with traceFlags=0', () => {
      expect(
        formatTraceparent({
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanId: 'bbbbbbbbbbbbbbbb',
          traceFlags: 0,
        }),
      ).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00');
    });

    it('formats with traceFlags=1 (sampled)', () => {
      expect(
        formatTraceparent({
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanId: 'bbbbbbbbbbbbbbbb',
          traceFlags: 1,
        }),
      ).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
    });

    it('formats with traceFlags=255', () => {
      expect(
        formatTraceparent({
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanId: 'bbbbbbbbbbbbbbbb',
          traceFlags: 255,
        }),
      ).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-ff');
    });

    it('masks traceFlags to one byte', () => {
      expect(
        formatTraceparent({
          traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanId: 'bbbbbbbbbbbbbbbb',
          traceFlags: 0x1ff,
        }),
      ).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-ff');
    });
  });

  describe('shellTracePropagation', () => {
    it('defaults to false', () => {
      expect(isShellTracePropagationEnabled()).toBe(false);
    });

    it('can be enabled and disabled', () => {
      setShellTracePropagation(true);
      expect(isShellTracePropagationEnabled()).toBe(true);

      setShellTracePropagation(false);
      expect(isShellTracePropagationEnabled()).toBe(false);
    });
  });
});

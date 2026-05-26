/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  createDaemonBridgeTelemetry,
  extractDaemonTraceContext,
  hashDaemonWorkspace,
  injectDaemonTraceContext,
} from './daemon-tracing.js';

describe('daemon-tracing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts daemon trace context from reserved prompt metadata keys', () => {
    const traceId = '1'.repeat(32);
    const spanId = '2'.repeat(16);
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${traceId}-${spanId}-01`,
        [DAEMON_TRACESTATE_META_KEY]: 'vendor=value',
      },
    });

    expect(extracted).toBeDefined();
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe(spanId);
  });

  it('strips reserved metadata when no active daemon span exists', () => {
    const injected = injectDaemonTraceContext({
      prompt: [],
      _meta: {
        keep: true,
        [DAEMON_TRACEPARENT_META_KEY]: 'client-spoof',
      },
    });

    const meta = injected._meta as Record<string, unknown>;
    expect(meta['keep']).toBe(true);
    expect(meta[DAEMON_TRACEPARENT_META_KEY]).toBeUndefined();
    expect(meta[DAEMON_TRACESTATE_META_KEY]).toBeUndefined();
    expect(extractDaemonTraceContext(injected)).toBeUndefined();
  });

  it('hashes workspace paths without exposing the raw path', () => {
    const hash = hashDaemonWorkspace('/tmp/project');

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('project');
  });

  it('emits bridge events as standalone spans without an active span', () => {
    const addEvent = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const startSpan = vi.fn(
      () => ({ addEvent, setStatus, end }) as unknown as Span,
    );
    vi.spyOn(trace, 'getSpan').mockReturnValue(undefined);
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan,
    } as unknown as Tracer);

    createDaemonBridgeTelemetry().event('channel.exited', {
      'qwen-code.daemon.channel.session_count': 2,
    });

    expect(startSpan).toHaveBeenCalledWith(
      'qwen-code.daemon.bridge',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'event.name': 'channel.exited',
          'qwen-code.daemon.operation': 'event.channel.exited',
          'qwen-code.daemon.channel.session_count': 2,
        }),
      }),
    );
    expect(addEvent).toHaveBeenCalledWith('channel.exited', {
      'qwen-code.daemon.channel.session_count': 2,
    });
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(end).toHaveBeenCalled();
  });
});

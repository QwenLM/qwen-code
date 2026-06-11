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

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => true,
}));
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  addDaemonRequestAttribute,
  createDaemonBridgeTelemetry,
  extractDaemonTraceContext,
  hashDaemonWorkspace,
  injectDaemonTraceContext,
  withDaemonRequestSpan,
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

  function mockTracerStartActiveSpan() {
    const startActiveSpan = vi.fn(
      (_name: string, _opts: unknown, fn: (span: Span) => Promise<void>) =>
        fn({
          setStatus: vi.fn(),
          end: vi.fn(),
          setAttribute: vi.fn(),
          setAttributes: vi.fn(),
          recordException: vi.fn(),
        } as unknown as Span),
    );
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan,
    } as unknown as Tracer);
    return startActiveSpan;
  }

  it('includes clientId and permissionRequestId in request span attributes', async () => {
    const startActiveSpan = mockTracerStartActiveSpan();

    await withDaemonRequestSpan(
      {
        method: 'POST',
        route: 'POST /session/:id/permission/:requestId',
        workspaceHash: 'abc123',
        sessionId: 'sess-1',
        clientId: 'client-42',
        permissionRequestId: 'perm-99',
      },
      async () => {},
    );

    expect(startActiveSpan).toHaveBeenCalledWith(
      'qwen-code.daemon.request',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.request.method': 'POST',
          'http.route': 'POST /session/:id/permission/:requestId',
          'session.id': 'sess-1',
          'qwen-code.client_id': 'client-42',
          'qwen-code.daemon.permission.request_id': 'perm-99',
        }),
      }),
      expect.any(Function),
    );
  });

  it('omits clientId and permissionRequestId when not provided', async () => {
    const startActiveSpan = mockTracerStartActiveSpan();

    await withDaemonRequestSpan(
      { method: 'POST', route: 'POST /session' },
      async () => {},
    );

    const attrs = (
      startActiveSpan.mock.calls[0]![1] as {
        attributes: Record<string, unknown>;
      }
    ).attributes;
    expect(attrs).not.toHaveProperty('qwen-code.client_id');
    expect(attrs).not.toHaveProperty('qwen-code.daemon.permission.request_id');
  });

  it('addDaemonRequestAttribute sets attribute on the active span', () => {
    const setAttribute = vi.fn();
    vi.spyOn(trace, 'getSpan').mockReturnValue({
      setAttribute,
    } as unknown as Span);

    addDaemonRequestAttribute('qwen-code.prompt_id', 'test-prompt-id');

    expect(setAttribute).toHaveBeenCalledWith(
      'qwen-code.prompt_id',
      'test-prompt-id',
    );
  });

  it('addDaemonRequestAttribute is a no-op without an active span', () => {
    vi.spyOn(trace, 'getSpan').mockReturnValue(undefined);
    expect(() =>
      addDaemonRequestAttribute('qwen-code.prompt_id', 'orphan'),
    ).not.toThrow();
  });
});

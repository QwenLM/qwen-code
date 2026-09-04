/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

const coreMocks = vi.hoisted(() => ({
  emitDaemonLog: vi.fn(),
  extractDaemonHttpTraceContext: vi.fn((): unknown => undefined),
  extractInboundTraceId: vi.fn((): string | undefined => undefined),
  hashDaemonWorkspace: vi.fn((workspace: string) => `hash:${workspace}`),
  isTelemetrySdkInitialized: vi.fn(() => true),
  recordDaemonError: vi.fn(),
  recordDaemonHttpRequest: vi.fn(),
  recordDaemonHttpResponse: vi.fn(),
  spanSetAttribute: vi.fn(),
  withDaemonRequestSpan: vi.fn(
    (_attrs: unknown, fn: (span: unknown) => Promise<void>) =>
      fn({ setAttribute: coreMocks.spanSetAttribute }),
  ),
}));

// The middleware only touches the core helpers stubbed below (the import
// list of telemetry.ts); keep this mock surface in sync with that list so
// the test stays a pure unit on the `recordRequest` seam.
// `withDaemonRequestSpan` just runs the wrapped fn (which registers the res
// listeners and calls next()).
vi.mock('@qwen-code/qwen-code-core', () => ({
  ...coreMocks,
}));

import {
  daemonInboundTraceIdCaptureMiddleware,
  daemonTelemetryMiddleware,
  legacySessionTelemetryRoutes,
  resolveDaemonTelemetryRoute,
  setDaemonTelemetryWorkspace,
} from './telemetry.js';
// Deliberately imported from the context module (not telemetry.ts's
// re-export): the middleware must write and this getter must read the SAME
// symbol — if either side ever declares its own, the readback tests below
// fail (the access log reads through this exact seam).
import { getDaemonTelemetryInboundTraceId } from './telemetry-context.js';
import {
  getDeferredRuntimeRequestTiming,
  MAX_CLIENT_ID_LENGTH,
  setDeferredRuntimeRequestTiming,
} from './request-helpers.js';

function mockReq(
  method: string,
  path: string,
  headers?: Record<string, unknown>,
): Request {
  return {
    method,
    path,
    headers,
    get: () => undefined,
  } as unknown as Request;
}

function mockRes(statusCode: number): Response & EventEmitter {
  const res = new EventEmitter() as Response & EventEmitter;
  (res as { statusCode: number }).statusCode = statusCode;
  Object.defineProperty(res, 'headersSent', { value: true, writable: true });
  return res;
}

describe('daemonTelemetryMiddleware — recordRequest seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.hashDaemonWorkspace.mockImplementation(
      (workspace: string) => `hash:${workspace}`,
    );
    coreMocks.spanSetAttribute.mockImplementation(() => undefined);
  });

  it('has no deferred timing for ordinary requests', () => {
    expect(getDeferredRuntimeRequestTiming(mockReq('GET', '/health'))).toBe(
      undefined,
    );
  });

  it('calls recordRequest with (durationMs, statusCode) once the response finishes on a matched route', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;

    mw(mockReq('GET', '/session/abc/artifacts'), res, next);
    // next runs synchronously; the record fires only when the response finishes.
    expect(next).toHaveBeenCalledTimes(1);
    expect(recordRequest).not.toHaveBeenCalled();

    res.emit('finish');
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledWith(expect.any(Number), 200);
  });

  it('records the real status code (not just 200) on error responses', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(503);
    mw(
      mockReq('POST', '/session/abc/prompt'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');
    expect(recordRequest).toHaveBeenCalledWith(expect.any(Number), 503);
  });

  it('includes deferred runtime wait in the request span', () => {
    const req = mockReq('POST', '/session');
    const startedAt = new Date(Date.now() - 25);
    setDeferredRuntimeRequestTiming(req, {
      startedAt,
      path: 'joined',
      waitMs: 24.5,
    });
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      req,
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: startedAt,
        deferredRuntimeWaitMs: 24.5,
        deferredRuntimePath: 'joined',
      }),
      expect.any(Function),
    );
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledWith(
      expect.any(Number),
      'POST /session',
      200,
      'joined',
    );
  });

  it('links the request span to an inbound traceparent header when extraction succeeds', () => {
    const parentContext = { __remoteParent: true };
    coreMocks.extractDaemonHttpTraceContext.mockReturnValueOnce(parentContext);
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.extractDaemonHttpTraceContext).toHaveBeenCalledWith({
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
    });
    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({ parentContext }),
      expect.any(Function),
    );
  });

  it('omits the parent context when no valid traceparent header is present', () => {
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {}),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.extractDaemonHttpTraceContext).toHaveBeenCalledWith({});
    const options = coreMocks.withDaemonRequestSpan.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect('parentContext' in options).toBe(false);
    expect(coreMocks.emitDaemonLog).not.toHaveBeenCalled();
  });

  it('skips span-context extraction when the telemetry SDK is not initialized', () => {
    coreMocks.isTelemetrySdkInitialized.mockReturnValueOnce(false);
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    // Telemetry off: no span parent and no breadcrumb. The access-log
    // trace id capture lives in daemonInboundTraceIdCaptureMiddleware, not
    // here.
    expect(coreMocks.extractDaemonHttpTraceContext).not.toHaveBeenCalled();
    expect(coreMocks.extractInboundTraceId).not.toHaveBeenCalled();
    const options = coreMocks.withDaemonRequestSpan.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect('parentContext' in options).toBe(false);
    expect(coreMocks.emitDaemonLog).not.toHaveBeenCalled();
  });

  it('logs at debug severity when a present traceparent header is rejected', () => {
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', { traceparent: 'junk-header' }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.extractDaemonHttpTraceContext).toHaveBeenCalledWith({
      traceparent: 'junk-header',
    });
    expect(coreMocks.emitDaemonLog).toHaveBeenCalledWith(
      'Rejected invalid inbound traceparent header.',
      {
        'http.route': 'GET /daemon/status',
        'http.request.header.traceparent': 'junk-header',
      },
      {
        eventName: 'qwen-code.daemon.traceparent.invalid',
        severityNumber: 5,
      },
    );
    const options = coreMocks.withDaemonRequestSpan.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect('parentContext' in options).toBe(false);
  });

  it('truncates the rejected traceparent header value in the breadcrumb', () => {
    const longHeader = 'x'.repeat(300);
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', { traceparent: longHeader }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.emitDaemonLog).toHaveBeenCalledWith(
      'Rejected invalid inbound traceparent header.',
      expect.objectContaining({
        'http.request.header.traceparent': 'x'.repeat(128),
      }),
      expect.objectContaining({
        eventName: 'qwen-code.daemon.traceparent.invalid',
      }),
    );
  });

  it('neutralizes control characters in the rejected traceparent breadcrumb', () => {
    const forgedHeader = 'junk\u0000\u001bheader\nvalue';
    const res = mockRes(200);

    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', { traceparent: forgedHeader }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    // NUL and ESC collapse to spaces and the newline renders visibly, so a
    // crafted header cannot forge log line structure or inject ANSI codes.
    expect(coreMocks.emitDaemonLog).toHaveBeenCalledWith(
      'Rejected invalid inbound traceparent header.',
      expect.objectContaining({
        'http.request.header.traceparent': 'junk  header\\nvalue',
      }),
      expect.objectContaining({
        eventName: 'qwen-code.daemon.traceparent.invalid',
      }),
    );
  });

  it('rate-limits the rejected traceparent breadcrumb', () => {
    const mw = daemonTelemetryMiddleware(() => '/ws');
    for (let i = 0; i < 200; i += 1) {
      const res = mockRes(200);
      mw(
        mockReq('GET', '/daemon/status', { traceparent: 'junk-header' }),
        res,
        vi.fn() as unknown as NextFunction,
      );
      res.emit('finish');
    }
    // The per-instance burst budget (60, +2/s refill) caps a flood of
    // invalid headers; the loop runs well under a second, so refill is
    // negligible.
    expect(coreMocks.emitDaemonLog.mock.calls.length).toBeGreaterThan(0);
    expect(coreMocks.emitDaemonLog.mock.calls.length).toBeLessThan(200);
  });

  it('fails closed and settles the request when header extraction throws', () => {
    coreMocks.extractDaemonHttpTraceContext.mockImplementationOnce(() => {
      throw new Error('extract failed');
    });
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;

    expect(() =>
      daemonTelemetryMiddleware(() => '/ws')(
        mockReq('GET', '/daemon/status', {
          traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
        }),
        res,
        next,
      ),
    ).not.toThrow();
    res.emit('finish');

    // The request still settles normally through the telemetry pipeline.
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(1);
    const options = coreMocks.withDaemonRequestSpan.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect('parentContext' in options).toBe(false);
    // Fail-closed extraction counts as rejected, so the breadcrumb still
    // fires for the present-but-unparsed header.
    expect(coreMocks.emitDaemonLog).toHaveBeenCalledTimes(1);
  });

  it('does not log when extraction succeeds, no header, or an array header is sent', () => {
    const parentContext = { __remoteParent: true };
    coreMocks.extractDaemonHttpTraceContext.mockReturnValueOnce(parentContext);
    const resA = mockRes(200);
    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
      resA,
      vi.fn() as unknown as NextFunction,
    );
    resA.emit('finish');

    const resB = mockRes(200);
    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {}),
      resB,
      vi.fn() as unknown as NextFunction,
    );
    resB.emit('finish');

    // Array header values stay fail-closed (rejected) but are not the
    // "present-but-invalid string" breadcrumb case.
    const resC = mockRes(200);
    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {
        traceparent: [`00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`],
      }),
      resC,
      vi.fn() as unknown as NextFunction,
    );
    resC.emit('finish');

    expect(coreMocks.emitDaemonLog).not.toHaveBeenCalled();
  });

  it('fires exactly once even if both finish and close emit', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);
    mw(
      mockReq('GET', '/session/abc/artifacts'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');
    res.emit('close');
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(1);
    expect(coreMocks.recordDaemonHttpResponse).toHaveBeenCalledTimes(1);
  });

  it('does NOT call recordRequest for an unmatched route', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;
    mw(mockReq('GET', '/not-a-daemon-route'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.emit('finish');
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it('maps plural workspace session listing to the existing route label', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);

    mw(
      mockReq('GET', '/workspaces/ws-secondary/sessions'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspace/:id/sessions',
      }),
      expect.any(Function),
    );
  });

  it('maps the workspace live-state route to its own low-cardinality label', () => {
    expect(
      resolveDaemonTelemetryRoute(
        mockReq('GET', '/workspaces/ws-secondary/sessions/live-state'),
      ),
    ).toEqual({ route: 'GET /workspaces/:workspace/sessions/live-state' });
  });

  it('maps the sessionless language route', () => {
    expect(resolveDaemonTelemetryRoute(mockReq('POST', '/language'))).toEqual({
      route: 'POST /language',
    });
  });

  it('attributes workspace transcript reads to the target workspace and session', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/secondary');
    const res = mockRes(200);

    mw(
      mockReq('GET', '/workspaces/ws-secondary/session/session%2F1/transcript'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspaces/:workspace/session/:id/transcript',
        sessionId: 'session/1',
        workspaceHash: 'hash:/workspace/secondary',
      }),
      expect.any(Function),
    );
  });

  it('attributes workspace turn-index reads to the target workspace and session', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/secondary');
    const res = mockRes(200);

    mw(
      mockReq('GET', '/workspaces/ws-secondary/session/session%2F1/turn-index'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspaces/:workspace/session/:id/turn-index',
        sessionId: 'session/1',
        workspaceHash: 'hash:/workspace/secondary',
      }),
      expect.any(Function),
    );
  });

  it('attributes workspace session-info reads to the shared session-info route', () => {
    const mw = daemonTelemetryMiddleware(() => '/ws');
    const res = mockRes(200);

    mw(
      mockReq('GET', '/workspace/%2Fwork%2Fa/session-info'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspace/:id/session-info',
      }),
      expect.any(Function),
    );
  });

  it('attributes plural workspace session-info reads to the shared session-info route', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/secondary');
    const res = mockRes(200);

    mw(
      mockReq('GET', '/workspaces/ws-secondary/session-info'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspace/:id/session-info',
      }),
      expect.any(Function),
    );
  });

  it('attributes workspace exports to the target workspace and session', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/secondary');
    const res = mockRes(200);

    mw(
      mockReq('GET', '/workspaces/ws-secondary/session/session%2F1/export'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspaces/:workspace/session/:id/export',
        sessionId: 'session/1',
        workspaceHash: 'hash:/workspace/secondary',
      }),
      expect.any(Function),
    );
  });

  it('attributes archived workspace exports to the target workspace and session', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/secondary');
    const res = mockRes(200);

    mw(
      mockReq(
        'GET',
        '/workspaces/ws-secondary/session/session%2F1/archive/export',
      ),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspaces/:workspace/session/:id/archive/export',
        sessionId: 'session/1',
        workspaceHash: 'hash:/workspace/secondary',
      }),
      expect.any(Function),
    );
  });

  it('defers singular owner-routed workspace attribution until the handler selects a runtime', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/primary');

    for (const [method, path, route] of [
      [
        'GET',
        '/session/secondary-session/rewind/snapshots',
        'GET /session/:id/rewind/snapshots',
      ],
      ['POST', '/session/secondary-session/rewind', 'POST /session/:id/rewind'],
      ['POST', '/session/secondary-session/shell', 'POST /session/:id/shell'],
    ] as const) {
      const res = mockRes(200);
      mw(mockReq(method, path), res, vi.fn() as unknown as NextFunction);
      expect(coreMocks.withDaemonRequestSpan).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ workspaceHash: expect.anything() }),
        expect.any(Function),
      );
      setDaemonTelemetryWorkspace(res, '/workspace/secondary');
      res.emit('finish');
      expect(coreMocks.withDaemonRequestSpan).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method,
          route,
          sessionId: 'secondary-session',
        }),
        expect.any(Function),
      );
      expect(coreMocks.spanSetAttribute).toHaveBeenLastCalledWith(
        'qwen-code.workspace.hash',
        'hash:/workspace/secondary',
      );
    }
  });

  it('decodes session ids before span attribution', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/primary');
    const res = mockRes(200);

    mw(
      mockReq('POST', '/session/secondary%2Fsession/rewind'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'secondary/session' }),
      expect.any(Function),
    );
  });

  it('keeps malformed session id encodings without throwing', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/primary');
    const res = mockRes(200);

    expect(() => {
      mw(
        mockReq('POST', '/session/bad%ZZ/rewind'),
        res,
        vi.fn() as unknown as NextFunction,
      );
    }).not.toThrow();
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'bad%ZZ' }),
      expect.any(Function),
    );
  });

  it('normalizes plural workspace agent routes to stable route labels', () => {
    const mw = daemonTelemetryMiddleware(() => '/ws');
    for (const [method, path, route] of [
      ['GET', '/workspaces/ws-secondary/agents', 'GET /workspace/agents'],
      [
        'GET',
        '/workspaces/ws-secondary/agents/reviewer',
        'GET /workspace/agents/:agentType',
      ],
      ['POST', '/workspaces/ws-secondary/agents', 'POST /workspace/agents'],
      [
        'POST',
        '/workspaces/ws-secondary/agents/reviewer',
        'POST /workspace/agents/:agentType',
      ],
      [
        'DELETE',
        '/workspaces/ws-secondary/agents/reviewer',
        'DELETE /workspace/agents/:agentType',
      ],
    ] as const) {
      const res = mockRes(200);
      mw(mockReq(method, path), res, vi.fn() as unknown as NextFunction);
      res.emit('finish');
      expect(coreMocks.withDaemonRequestSpan).toHaveBeenLastCalledWith(
        expect.objectContaining({ method, route }),
        expect.any(Function),
      );
    }
  });

  it('normalizes the plural workspace upload route to a stable route label', () => {
    const mw = daemonTelemetryMiddleware(() => '/ws');
    const res = mockRes(200);
    mw(
      mockReq('POST', '/workspaces/ws-secondary/file/upload'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');
    expect(coreMocks.withDaemonRequestSpan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'POST',
        route: 'POST /workspace/file/upload',
      }),
      expect.any(Function),
    );
  });

  it('attributes plural workspace voice requests to the selected workspace', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/secondary');
    for (const [method, path, route] of [
      ['GET', '/workspaces/ws-secondary/voice', 'GET /workspace/voice'],
      ['POST', '/workspaces/ws-secondary/voice', 'POST /workspace/voice'],
      [
        'POST',
        '/workspaces/ws-secondary/voice/transcribe',
        'POST /workspace/voice/transcribe',
      ],
    ] as const) {
      const res = mockRes(200);
      mw(mockReq(method, path), res, vi.fn() as unknown as NextFunction);
      res.emit('finish');

      expect(coreMocks.withDaemonRequestSpan).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method,
          route,
          workspaceHash: 'hash:/workspace/secondary',
        }),
        expect.any(Function),
      );
    }
  });

  it('excludes the dashboard status poll (GET /daemon/status) from recordRequest', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);
    // GET /daemon/status IS a matched telemetry route, but the metrics ring must
    // not count the dashboard's own 5s poll as request traffic.
    mw(
      mockReq('GET', '/daemon/status'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');
    expect(recordRequest).not.toHaveBeenCalled();
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps heartbeat in OTel HTTP metrics but excludes it from the metrics ring', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);

    mw(
      mockReq('POST', '/session/abc/heartbeat'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(res, '/ws');
    res.emit('finish');

    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledWith(
      expect.any(Number),
      'POST /session/:id/heartbeat',
      200,
      undefined,
    );
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it('does not record successful SSE connection lifetime as HTTP request latency', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);

    mw(
      mockReq('GET', '/session/abc/events'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(res, '/ws');
    res.emit('close');

    expect(coreMocks.recordDaemonHttpResponse).toHaveBeenCalledTimes(1);
    expect(coreMocks.recordDaemonHttpRequest).not.toHaveBeenCalled();
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it('records request-scoped generation SSE duration as ordinary HTTP latency', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);

    mw(
      mockReq('POST', '/session/abc/generate'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(res, '/ws');
    res.emit('finish');

    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledWith(
      expect.any(Number),
      'POST /session/:id/generate',
      200,
      undefined,
    );
    expect(recordRequest).toHaveBeenCalledWith(expect.any(Number), 200);
  });

  it('counts a 200 SSE request that closes before response headers are sent', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
    const res = mockRes(200);
    (res as unknown as { headersSent: boolean }).headersSent = false;

    mw(
      mockReq('GET', '/session/abc/events'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('close');

    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledWith(
      expect.any(Number),
      'GET /session/:id/events',
      200,
      undefined,
    );
    expect(recordRequest).toHaveBeenCalledWith(expect.any(Number), 200);
  });

  it.each([400, 404, 429, 500])(
    'records an SSE handshake failure with status %s as an ordinary request',
    (statusCode) => {
      const recordRequest = vi.fn();
      const mw = daemonTelemetryMiddleware(() => '/ws', recordRequest);
      const res = mockRes(statusCode);

      mw(
        mockReq('GET', '/session/abc/events'),
        res,
        vi.fn() as unknown as NextFunction,
      );
      res.emit('finish');

      expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledWith(
        expect.any(Number),
        'GET /session/:id/events',
        statusCode,
        undefined,
      );
      expect(recordRequest).toHaveBeenCalledWith(
        expect.any(Number),
        statusCode,
      );
    },
  );

  it('is a silent no-op when recordRequest is omitted (the optional-chaining path)', () => {
    const mw = daemonTelemetryMiddleware(() => '/ws');
    const res = mockRes(200);
    expect(() => {
      mw(
        mockReq('GET', '/session/abc/artifacts'),
        res,
        vi.fn() as unknown as NextFunction,
      );
      res.emit('finish');
    }).not.toThrow();
  });

  it('settles normally when telemetry is disabled and no span is created', () => {
    const recordRequest = vi.fn();
    coreMocks.withDaemonRequestSpan.mockImplementationOnce(
      (_attrs: unknown, fn: (span: unknown) => Promise<void>) => fn(undefined),
    );
    const mw = daemonTelemetryMiddleware(
      () => '/workspace/primary',
      recordRequest,
    );
    const res = mockRes(200);

    mw(
      mockReq('POST', '/session/abc/prompt'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(res, '/workspace/secondary');
    expect(() => res.emit('finish')).not.toThrow();

    expect(coreMocks.hashDaemonWorkspace).not.toHaveBeenCalled();
    expect(coreMocks.recordDaemonHttpResponse).toHaveBeenCalledWith(
      undefined,
      200,
    );
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves workspace hash per request instead of closing over the primary workspace', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/primary');
    const firstRes = mockRes(200);

    mw(
      mockReq('POST', '/session'),
      firstRes,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(firstRes, '/workspace/one');
    firstRes.emit('finish');

    const secondRes = mockRes(200);
    mw(
      mockReq('POST', '/session/abc/prompt'),
      secondRes,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(secondRes, '/workspace/two');
    secondRes.emit('finish');

    expect(coreMocks.hashDaemonWorkspace).toHaveBeenNthCalledWith(
      1,
      '/workspace/one',
    );
    expect(coreMocks.hashDaemonWorkspace).toHaveBeenNthCalledWith(
      2,
      '/workspace/two',
    );
    expect(coreMocks.spanSetAttribute).toHaveBeenNthCalledWith(
      1,
      'qwen-code.workspace.hash',
      'hash:/workspace/one',
    );
    expect(coreMocks.spanSetAttribute).toHaveBeenNthCalledWith(
      2,
      'qwen-code.workspace.hash',
      'hash:/workspace/two',
    );
  });

  it('memoizes workspace hashes by resolved workspace cwd', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/one');
    const firstRes = mockRes(200);
    const secondRes = mockRes(200);

    mw(
      mockReq('POST', '/session'),
      firstRes,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(firstRes, '/workspace/one');
    firstRes.emit('finish');
    mw(
      mockReq('POST', '/session/abc/prompt'),
      secondRes,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(secondRes, '/workspace/one');
    secondRes.emit('finish');

    expect(coreMocks.hashDaemonWorkspace).toHaveBeenCalledTimes(1);
    expect(coreMocks.hashDaemonWorkspace).toHaveBeenCalledWith(
      '/workspace/one',
    );
  });

  it('settles a published workspace after its runtime is removed', () => {
    const resolveWorkspaceCwd = vi.fn(() => '/workspace/primary');
    const mw = daemonTelemetryMiddleware(resolveWorkspaceCwd);
    const runtimes = new Map([
      ['secondary', { workspaceCwd: '/workspace/secondary' }],
    ]);
    const runtime = runtimes.get('secondary')!;
    const res = mockRes(200);

    mw(
      mockReq('POST', '/session/abc/prompt'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    runtimes.delete('secondary');
    res.emit('finish');

    expect(resolveWorkspaceCwd).not.toHaveBeenCalled();
    expect(coreMocks.spanSetAttribute).toHaveBeenCalledWith(
      'qwen-code.workspace.hash',
      'hash:/workspace/secondary',
    );
  });

  it('uses first-selection-wins and clears deferred context after settlement', () => {
    const mw = daemonTelemetryMiddleware(() => '/workspace/primary');
    const res = mockRes(200);
    mw(
      mockReq('POST', '/session/abc/prompt'),
      res,
      vi.fn() as unknown as NextFunction,
    );

    setDaemonTelemetryWorkspace(res, '/workspace/first');
    setDaemonTelemetryWorkspace(res, '/workspace/first');
    setDaemonTelemetryWorkspace(res, '/workspace/second');
    res.emit('finish');
    setDaemonTelemetryWorkspace(res, '/workspace/after-finish');

    expect(coreMocks.spanSetAttribute).toHaveBeenCalledTimes(1);
    expect(coreMocks.spanSetAttribute).toHaveBeenCalledWith(
      'qwen-code.workspace.hash',
      'hash:/workspace/first',
    );
  });

  it('omits workspace hash when a dynamic target is never resolved', () => {
    const resolveWorkspaceCwd = vi.fn(() => '/workspace/primary');
    const mw = daemonTelemetryMiddleware(resolveWorkspaceCwd);
    const res = mockRes(404);

    mw(
      mockReq('POST', '/session/missing/prompt'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(resolveWorkspaceCwd).not.toHaveBeenCalled();
    expect(coreMocks.hashDaemonWorkspace).not.toHaveBeenCalled();
    expect(coreMocks.spanSetAttribute).not.toHaveBeenCalled();
  });

  it('keeps pre-resolved resolver failures from affecting request settlement', () => {
    const recordRequest = vi.fn();
    const next = vi.fn() as unknown as NextFunction;
    const mw = daemonTelemetryMiddleware(() => {
      throw new Error('resolver failed');
    }, recordRequest);
    const res = mockRes(200);

    expect(() => mw(mockReq('GET', '/daemon/status'), res, next)).not.toThrow();
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.not.objectContaining({ workspaceHash: expect.anything() }),
      expect.any(Function),
    );
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps late hash and span attribute failures from affecting metrics', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware(
      () => '/workspace/primary',
      recordRequest,
    );
    const hashFailureRes = mockRes(200);
    coreMocks.hashDaemonWorkspace.mockImplementationOnce(() => {
      throw new Error('hash failed');
    });

    mw(
      mockReq('POST', '/session/abc/prompt'),
      hashFailureRes,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(hashFailureRes, '/workspace/secondary');
    expect(() => hashFailureRes.emit('finish')).not.toThrow();

    const attributeFailureRes = mockRes(200);
    coreMocks.spanSetAttribute.mockImplementationOnce(() => {
      throw new Error('attribute failed');
    });
    mw(
      mockReq('POST', '/session/def/prompt'),
      attributeFailureRes,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(attributeFailureRes, '/workspace/secondary');
    expect(() => attributeFailureRes.emit('finish')).not.toThrow();

    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(2);
    expect(recordRequest).toHaveBeenCalledTimes(2);
  });

  it('is a safe no-op when workspace selection is published without middleware context', () => {
    const res = mockRes(200);
    expect(() =>
      setDaemonTelemetryWorkspace(res, '/workspace/secondary'),
    ).not.toThrow();
    expect(coreMocks.spanSetAttribute).not.toHaveBeenCalled();
  });

  it('continues a dynamic request when its Response cannot store telemetry context', () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = daemonTelemetryMiddleware(() => '/workspace/primary');
    const res = Object.preventExtensions(mockRes(200));

    expect(() =>
      mw(mockReq('POST', '/session/abc/prompt'), res, next),
    ).not.toThrow();
    expect(() =>
      setDaemonTelemetryWorkspace(res, '/workspace/secondary'),
    ).not.toThrow();
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(coreMocks.spanSetAttribute).not.toHaveBeenCalled();
    expect(coreMocks.recordDaemonHttpRequest).toHaveBeenCalledTimes(1);
  });
});

describe('legacy session telemetry route catalog', () => {
  it('contains 65 unique routes with the audited 63/2 attribution split', () => {
    const keys = legacySessionTelemetryRoutes.map(
      ({ method, path }) => `${method} ${path}`,
    );
    expect(keys).toHaveLength(65);
    expect(new Set(keys).size).toBe(65);
    expect(
      legacySessionTelemetryRoutes.filter(
        ({ attribution }) => attribution === 'handler_resolved',
      ),
    ).toHaveLength(63);
    expect(
      legacySessionTelemetryRoutes.filter(
        ({ attribution }) => attribution === 'pre_resolved',
      ),
    ).toHaveLength(2);
    expect(
      legacySessionTelemetryRoutes
        .filter(({ attribution }) => attribution === 'pre_resolved')
        .map(({ method, path }) => `${method} ${path}`)
        .sort(),
    ).toEqual(
      ['POST /permission/:requestId', 'POST /session/:id/a2ui-action'].sort(),
    );
    for (const entry of legacySessionTelemetryRoutes) {
      expect(entry.route).toBe(`${entry.method} ${entry.path}`);
    }
  });

  it('matches every catalog entry with its declared canonical attribution', () => {
    for (const entry of legacySessionTelemetryRoutes) {
      const path = entry.path.replace(
        /:([A-Za-z][A-Za-z0-9_]*)/g,
        (_match, name: string) => {
          if (name === 'id') return 'session-1';
          if (name === 'requestId') return 'request-1';
          return `${name}-1`;
        },
      );

      expect(resolveDaemonTelemetryRoute(mockReq(entry.method, path))).toEqual({
        route: entry.route,
        attribution: entry.attribution,
        ...(entry.path.includes('/:id') ? { sessionId: 'session-1' } : {}),
        ...(entry.path.includes('/:requestId')
          ? { permissionRequestId: 'request-1' }
          : {}),
      });
    }
  });

  it.each([
    ['POST', '/SeSsIoN/abc/PrOmPt/', 'POST /session/:id/prompt', 'abc'],
    [
      'POST',
      '/session/session%2Fchild/prompt',
      'POST /session/:id/prompt',
      'session/child',
    ],
    [
      'POST',
      '/session/session%252Fchild/prompt',
      'POST /session/:id/prompt',
      'session%2Fchild',
    ],
    [
      'GET',
      '/session/%E4%BD%A0%E5%A5%BD/status',
      'GET /session/:id/status',
      '你好',
    ],
    ['POST', '/session/bad%ZZ/rewind', 'POST /session/:id/rewind', 'bad%ZZ'],
  ])(
    'matches %s %s with a canonical label',
    (method, path, route, sessionId) => {
      expect(resolveDaemonTelemetryRoute(mockReq(method, path))).toMatchObject({
        route,
        sessionId,
      });
    },
  );

  it('decodes and validates permission request ids after segment matching', () => {
    expect(
      resolveDaemonTelemetryRoute(
        mockReq('POST', '/session/abc/permission/%72eq-1'),
      ),
    ).toMatchObject({
      route: 'POST /session/:id/permission/:requestId',
      sessionId: 'abc',
      permissionRequestId: 'req-1',
    });
    expect(
      resolveDaemonTelemetryRoute(
        mockReq('POST', '/session/abc/permission/req%2F1'),
      ),
    ).not.toHaveProperty('permissionRequestId');
    expect(
      resolveDaemonTelemetryRoute(mockReq('POST', '/permission/bad%ZZ')),
    ).not.toHaveProperty('permissionRequestId');
    expect(
      resolveDaemonTelemetryRoute(
        mockReq('POST', `/permission/${'a'.repeat(MAX_CLIENT_ID_LENGTH + 1)}`),
      ),
    ).not.toHaveProperty('permissionRequestId');
  });

  it.each([
    ['GET', '/session/abc/prompt'],
    ['POST', '/session/abc/prompt/extra'],
    ['POST', '/session/abc/prompt//'],
    ['POST', '/session//prompt'],
    ['HEAD', '/session/abc/status'],
  ])('does not match the wrong method or path: %s %s', (method, path) => {
    expect(resolveDaemonTelemetryRoute(mockReq(method, path))).toBeUndefined();
  });
});

describe('daemonInboundTraceIdCaptureMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the caller trace id from a valid traceparent header', () => {
    coreMocks.extractInboundTraceId.mockReturnValueOnce('3'.repeat(32));
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;

    daemonInboundTraceIdCaptureMiddleware(
      mockReq('GET', '/session/abc/prompt', {
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
      res,
      next,
    );

    expect(coreMocks.extractInboundTraceId).toHaveBeenCalledWith({
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
    });
    expect(getDaemonTelemetryInboundTraceId(res)).toBe('3'.repeat(32));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves the response untouched when no valid header parses', () => {
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;

    daemonInboundTraceIdCaptureMiddleware(
      mockReq('GET', '/session/abc/prompt', { traceparent: 'junk-header' }),
      res,
      next,
    );

    expect(getDaemonTelemetryInboundTraceId(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still calls next when extraction throws', () => {
    coreMocks.extractInboundTraceId.mockImplementationOnce(() => {
      throw new Error('extract failed');
    });
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;

    expect(() =>
      daemonInboundTraceIdCaptureMiddleware(
        mockReq('GET', '/anything', {}),
        res,
        next,
      ),
    ).not.toThrow();

    expect(getDaemonTelemetryInboundTraceId(res)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('capturing the trace id does not open the workspace attribution gate', () => {
    // Regression: capture used to create the telemetry response context,
    // whose mere presence is the opt-in for handler-resolved workspace
    // attribution — so a caller merely sending a traceparent header changed
    // the span's workspace.hash. Capture now stores the id under its own
    // symbol, and setDaemonTelemetryWorkspace stays a no-op here.
    coreMocks.extractInboundTraceId.mockReturnValueOnce('3'.repeat(32));
    const res = mockRes(200);

    daemonInboundTraceIdCaptureMiddleware(
      mockReq('GET', '/daemon/status', {
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('GET', '/daemon/status', {}),
      res,
      vi.fn() as unknown as NextFunction,
    );
    setDaemonTelemetryWorkspace(res, '/ws');
    res.emit('finish');

    expect(coreMocks.spanSetAttribute).not.toHaveBeenCalledWith(
      'qwen-code.workspace.hash',
      expect.anything(),
    );
  });

  it('keeps the captured trace id when the telemetry middleware initializes the workspace context', () => {
    coreMocks.extractInboundTraceId.mockReturnValueOnce('3'.repeat(32));
    const res = mockRes(200);

    daemonInboundTraceIdCaptureMiddleware(
      mockReq('POST', '/session', {
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
      res,
      vi.fn() as unknown as NextFunction,
    );
    daemonTelemetryMiddleware(() => '/ws')(
      mockReq('POST', '/session', {}),
      res,
      vi.fn() as unknown as NextFunction,
    );

    // The handler_resolved branch initializes the workspace context; the
    // captured trace id lives under its own symbol and must survive.
    expect(getDaemonTelemetryInboundTraceId(res)).toBe('3'.repeat(32));

    res.emit('finish');
  });
});

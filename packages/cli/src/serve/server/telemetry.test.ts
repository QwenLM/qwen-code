/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

const coreMocks = vi.hoisted(() => ({
  hashDaemonWorkspace: vi.fn((workspace: string) => `hash:${workspace}`),
  recordDaemonError: vi.fn(),
  recordDaemonHttpRequest: vi.fn(),
  recordDaemonHttpResponse: vi.fn(),
  spanSetAttribute: vi.fn(),
  withDaemonRequestSpan: vi.fn(
    (_attrs: unknown, fn: (span: unknown) => Promise<void>) =>
      fn({ setAttribute: coreMocks.spanSetAttribute }),
  ),
}));

// The middleware only touches these five core helpers; stub them so the test is
// a pure unit on the `recordRequest` seam. `withDaemonRequestSpan` just runs the
// wrapped fn (which registers the res listeners and calls next()).
vi.mock('@qwen-code/qwen-code-core', () => ({
  ...coreMocks,
}));

import {
  daemonTelemetryMiddleware,
  legacySessionTelemetryRoutes,
  resolveDaemonTelemetryRoute,
  setDaemonTelemetryWorkspace,
} from './telemetry.js';
import {
  getDeferredRuntimeRequestTiming,
  MAX_CLIENT_ID_LENGTH,
  setDeferredRuntimeRequestTiming,
} from './request-helpers.js';

function mockReq(method: string, path: string): Request {
  return { method, path, get: () => undefined } as unknown as Request;
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
  it('contains 48 unique routes with the audited 41/7 attribution split', () => {
    const keys = legacySessionTelemetryRoutes.map(
      ({ method, path }) => `${method} ${path}`,
    );
    expect(keys).toHaveLength(48);
    expect(new Set(keys).size).toBe(48);
    expect(
      legacySessionTelemetryRoutes.filter(
        ({ attribution }) => attribution === 'handler_resolved',
      ),
    ).toHaveLength(41);
    expect(
      legacySessionTelemetryRoutes.filter(
        ({ attribution }) => attribution === 'pre_resolved',
      ),
    ).toHaveLength(7);
    expect(
      legacySessionTelemetryRoutes
        .filter(({ attribution }) => attribution === 'pre_resolved')
        .map(({ method, path }) => `${method} ${path}`)
        .sort(),
    ).toEqual(
      [
        'GET /session/:id/export',
        'PATCH /session/:id/organization',
        'POST /permission/:requestId',
        'POST /session/:id/a2ui-action',
        'POST /sessions/archive',
        'POST /sessions/delete',
        'POST /sessions/unarchive',
      ].sort(),
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

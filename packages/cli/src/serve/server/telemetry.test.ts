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
  withDaemonRequestSpan: vi.fn(
    (_attrs: unknown, fn: (span: unknown) => Promise<void>) => fn({}),
  ),
}));

// The middleware only touches these five core helpers; stub them so the test is
// a pure unit on the `recordRequest` seam. `withDaemonRequestSpan` just runs the
// wrapped fn (which registers the res listeners and calls next()).
vi.mock('@qwen-code/qwen-code-core', () => ({
  ...coreMocks,
}));

import { daemonTelemetryMiddleware } from './telemetry.js';
import {
  getDeferredRuntimeRequestTiming,
  setDeferredRuntimeRequestTiming,
} from './request-helpers.js';

function mockReq(method: string, path: string): Request {
  return { method, path, get: () => undefined } as unknown as Request;
}

function mockRes(statusCode: number): Response & EventEmitter {
  const res = new EventEmitter() as Response & EventEmitter;
  (res as { statusCode: number }).statusCode = statusCode;
  return res;
}

describe('daemonTelemetryMiddleware — recordRequest seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      mockReq('GET', '/workspaces/ws-secondary/session/session-1/transcript'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: 'GET /workspaces/:workspace/session/:id/transcript',
        sessionId: 'session-1',
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

  it('attributes singular rewind and shell routes to the live session owner', () => {
    const resolveSessionWorkspaceCwd = vi.fn(() => '/workspace/secondary');
    const mw = daemonTelemetryMiddleware(
      () => '/workspace/primary',
      undefined,
      resolveSessionWorkspaceCwd,
    );

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
      res.emit('finish');
      expect(coreMocks.withDaemonRequestSpan).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method,
          route,
          sessionId: 'secondary-session',
          workspaceHash: 'hash:/workspace/secondary',
        }),
        expect.any(Function),
      );
    }

    expect(resolveSessionWorkspaceCwd).toHaveBeenCalledTimes(3);
    expect(resolveSessionWorkspaceCwd).toHaveBeenCalledWith(
      'secondary-session',
    );
  });

  it('decodes session ids before owner lookup and span attribution', () => {
    const resolveSessionWorkspaceCwd = vi.fn(() => '/workspace/secondary');
    const mw = daemonTelemetryMiddleware(
      () => '/workspace/primary',
      undefined,
      resolveSessionWorkspaceCwd,
    );
    const res = mockRes(200);

    mw(
      mockReq('POST', '/session/secondary%2Fsession/rewind'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');

    expect(resolveSessionWorkspaceCwd).toHaveBeenCalledWith(
      'secondary/session',
    );
    expect(coreMocks.withDaemonRequestSpan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'secondary/session' }),
      expect.any(Function),
    );
  });

  it('keeps malformed session id encodings without throwing', () => {
    const resolveSessionWorkspaceCwd = vi.fn(() => undefined);
    const mw = daemonTelemetryMiddleware(
      () => '/workspace/primary',
      undefined,
      resolveSessionWorkspaceCwd,
    );
    const res = mockRes(200);

    expect(() => {
      mw(
        mockReq('POST', '/session/bad%ZZ/rewind'),
        res,
        vi.fn() as unknown as NextFunction,
      );
    }).not.toThrow();
    res.emit('finish');

    expect(resolveSessionWorkspaceCwd).toHaveBeenCalledWith('bad%ZZ');
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
  });

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

  it('resolves workspace hash per request instead of closing over the primary workspace', () => {
    let workspace = '/workspace/one';
    const mw = daemonTelemetryMiddleware(() => workspace);
    const firstRes = mockRes(200);

    mw(
      mockReq('POST', '/session'),
      firstRes,
      vi.fn() as unknown as NextFunction,
    );
    firstRes.emit('finish');

    workspace = '/workspace/two';
    const secondRes = mockRes(200);
    mw(
      mockReq('POST', '/session/abc/prompt'),
      secondRes,
      vi.fn() as unknown as NextFunction,
    );
    secondRes.emit('finish');

    expect(coreMocks.hashDaemonWorkspace).toHaveBeenNthCalledWith(
      1,
      '/workspace/one',
    );
    expect(coreMocks.hashDaemonWorkspace).toHaveBeenNthCalledWith(
      2,
      '/workspace/two',
    );
    expect(coreMocks.withDaemonRequestSpan.mock.calls[0]?.[0]).toMatchObject({
      workspaceHash: 'hash:/workspace/one',
    });
    expect(coreMocks.withDaemonRequestSpan.mock.calls[1]?.[0]).toMatchObject({
      workspaceHash: 'hash:/workspace/two',
    });
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
    firstRes.emit('finish');
    mw(
      mockReq('POST', '/session/abc/prompt'),
      secondRes,
      vi.fn() as unknown as NextFunction,
    );
    secondRes.emit('finish');

    expect(coreMocks.hashDaemonWorkspace).toHaveBeenCalledTimes(1);
    expect(coreMocks.hashDaemonWorkspace).toHaveBeenCalledWith(
      '/workspace/one',
    );
  });
});

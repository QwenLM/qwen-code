/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

// The middleware only touches these five core helpers; stub them so the test is
// a pure unit on the `recordRequest` seam. `withDaemonRequestSpan` just runs the
// wrapped fn (which registers the res listeners and calls next()).
vi.mock('@qwen-code/qwen-code-core', () => ({
  hashDaemonWorkspace: () => 'ws-hash',
  recordDaemonError: vi.fn(),
  recordDaemonHttpRequest: vi.fn(),
  recordDaemonHttpResponse: vi.fn(),
  withDaemonRequestSpan: (
    _attrs: unknown,
    fn: (span: unknown) => Promise<void>,
  ) => fn({}),
}));

import { daemonTelemetryMiddleware } from './telemetry.js';

function mockReq(method: string, path: string): Request {
  return { method, path, get: () => undefined } as unknown as Request;
}

function mockRes(statusCode: number): Response & EventEmitter {
  const res = new EventEmitter() as Response & EventEmitter;
  (res as { statusCode: number }).statusCode = statusCode;
  return res;
}

describe('daemonTelemetryMiddleware — recordRequest seam', () => {
  it('calls recordRequest with (durationMs, statusCode) once the response finishes on a matched route', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware('/ws', recordRequest);
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;

    mw(mockReq('GET', '/daemon/status'), res, next);
    // next runs synchronously; the record fires only when the response finishes.
    expect(next).toHaveBeenCalledTimes(1);
    expect(recordRequest).not.toHaveBeenCalled();

    res.emit('finish');
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledWith(expect.any(Number), 200);
  });

  it('records the real status code (not just 200) on error responses', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware('/ws', recordRequest);
    const res = mockRes(503);
    mw(
      mockReq('POST', '/session/abc/prompt'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');
    expect(recordRequest).toHaveBeenCalledWith(expect.any(Number), 503);
  });

  it('fires exactly once even if both finish and close emit', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware('/ws', recordRequest);
    const res = mockRes(200);
    mw(
      mockReq('GET', '/daemon/status'),
      res,
      vi.fn() as unknown as NextFunction,
    );
    res.emit('finish');
    res.emit('close');
    expect(recordRequest).toHaveBeenCalledTimes(1);
  });

  it('does NOT call recordRequest for an unmatched route', () => {
    const recordRequest = vi.fn();
    const mw = daemonTelemetryMiddleware('/ws', recordRequest);
    const res = mockRes(200);
    const next = vi.fn() as unknown as NextFunction;
    mw(mockReq('GET', '/not-a-daemon-route'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.emit('finish');
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it('is a silent no-op when recordRequest is omitted (the optional-chaining path)', () => {
    const mw = daemonTelemetryMiddleware('/ws');
    const res = mockRes(200);
    expect(() => {
      mw(
        mockReq('GET', '/daemon/status'),
        res,
        vi.fn() as unknown as NextFunction,
      );
      res.emit('finish');
    }).not.toThrow();
  });
});

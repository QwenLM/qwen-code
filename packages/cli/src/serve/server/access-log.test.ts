/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { Application, RequestHandler } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonLogContext, DaemonLogger } from '../daemon-logger.js';
import { installAccessLogMiddleware } from './access-log.js';

function fakeLogger(): DaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    raw: vi.fn(),
    getLogPath: () => '',
    getDaemonId: () => 'daemon:test',
    getStatus: () => ({
      runId: '00000000000000000000000000000000',
      mode: 'stderr-only',
      health: 'ok',
      issues: [],
      droppedRecords: 0,
      droppedBytes: 0,
    }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function harness() {
  let middleware: RequestHandler | undefined;
  const app = {
    locals: {},
    use: vi.fn((handler: RequestHandler) => {
      middleware = handler;
    }),
  } as unknown as Application;
  const logger = fakeLogger();
  let now = 1_000;
  const controller = installAccessLogMiddleware(app, logger, () => now);

  const begin = (
    input: {
      path?: string;
      method?: string;
      status?: number;
      rawHeaders?: string[];
    } = {},
  ) => {
    if (!middleware) throw new Error('Access middleware was not installed');
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
    };
    response.statusCode = input.status ?? 200;
    const next = vi.fn();
    middleware(
      {
        method: input.method ?? 'GET',
        path: input.path ?? '/test',
        rawHeaders: input.rawHeaders ?? [],
      } as never,
      response as never,
      next,
    );
    return { response, next };
  };

  return {
    logger,
    controller,
    begin,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('installAccessLogMiddleware', () => {
  it('preserves exclusions and never changes HTTP admission', () => {
    const h = harness();
    for (const request of [
      { method: 'GET', path: '/health', status: 200 },
      { method: 'POST', path: '/session/s/heartbeat', status: 204 },
      { method: 'GET', path: '/session/s/events', status: 200 },
    ]) {
      const { response, next } = h.begin(request);
      expect(next).toHaveBeenCalledOnce();
      response.emit('finish');
    }
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('routes non-error responses to info and errors to warn', () => {
    const h = harness();
    h.begin({ path: '/success', status: 399 }).response.emit('finish');
    h.begin({ path: '/failure', status: 400 }).response.emit('finish');

    expect(h.logger.info).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({ route: 'GET /success', status: 399 }),
    );
    expect(h.logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({ route: 'GET /failure', status: 400 }),
    );
  });

  it('caps UTF-8 fields, uses the first raw client header, and tolerates clock retreat', () => {
    const h = harness();
    const sessionId = '你'.repeat(100);
    const routeSuffix = '界'.repeat(900);
    const firstClientId = '客'.repeat(100);
    const { response } = h.begin({
      path: `/session/${sessionId}/${routeSuffix}`,
      rawHeaders: [
        'X-Qwen-Client-Id',
        firstClientId,
        'x-qwen-client-id',
        'second-client',
      ],
    });
    h.setNow(900);
    response.emit('finish');

    const context = vi.mocked(h.logger.info).mock.calls[0]?.[1] as
      | DaemonLogContext
      | undefined;
    expect(context).toBeDefined();
    expect(
      Buffer.byteLength(String(context?.route), 'utf8'),
    ).toBeLessThanOrEqual(2 * 1024);
    expect(context?.['routeOriginalBytes']).toBeGreaterThan(2 * 1024);
    expect(
      Buffer.byteLength(String(context?.sessionId), 'utf8'),
    ).toBeLessThanOrEqual(256);
    expect(context?.['sessionIdOriginalBytes']).toBe(300);
    expect(
      Buffer.byteLength(String(context?.clientId), 'utf8'),
    ).toBeLessThanOrEqual(256);
    expect(context?.['clientIdOriginalBytes']).toBe(300);
    expect(context?.clientId).not.toBe('second-client');
    expect(context?.['durationMs']).toBe(0);
  });

  it('bounds bursts, emits summaries before individual records, and keeps fixed status buckets', () => {
    const h = harness();
    for (let i = 0; i < 60; i += 1) {
      h.begin({ path: `/burst/${i}` }).response.emit('finish');
    }
    for (const status of [201, 302, 404, 503, 700]) {
      h.begin({ path: `/suppressed/${status}`, status }).response.emit(
        'finish',
      );
    }
    expect(h.logger.info).toHaveBeenCalledTimes(60);

    h.setNow(1_500);
    h.begin({ path: '/summary-priority', status: 204 }).response.emit('finish');
    expect(h.logger.warn).toHaveBeenCalledWith('access logs suppressed', {
      suppressed: 5,
      status2xx: 1,
      status3xx: 1,
      status4xx: 1,
      status5xx: 1,
      statusOther: 1,
    });
    expect(h.logger.info).toHaveBeenCalledTimes(60);

    h.controller.sealAndFlushSuppressed();
    h.controller.sealAndFlushSuppressed();
    expect(h.logger.warn).toHaveBeenLastCalledWith('access logs suppressed', {
      suppressed: 1,
      status2xx: 1,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      statusOther: 0,
    });
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not move the token refill baseline backward with the clock', () => {
    const h = harness();
    for (let i = 0; i < 60; i += 1) {
      h.begin({ path: `/burst/${i}` }).response.emit('finish');
    }

    h.setNow(0);
    h.begin({ path: '/clock-retreat' }).response.emit('finish');
    h.setNow(1_200);
    h.begin({ path: '/small-forward-step' }).response.emit('finish');

    expect(h.logger.info).toHaveBeenCalledTimes(60);
    expect(h.logger.warn).not.toHaveBeenCalled();
    h.controller.sealAndFlushSuppressed();
    expect(h.logger.warn).toHaveBeenCalledWith('access logs suppressed', {
      suppressed: 2,
      status2xx: 2,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      statusOther: 0,
    });
  });

  it('ignores finish callbacks that arrive after sealing', () => {
    const h = harness();
    const pending = h.begin({ path: '/late', status: 500 });
    h.controller.sealAndFlushSuppressed();
    pending.response.emit('finish');
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});

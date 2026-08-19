/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  daemonRequest,
  probeHealth,
  DaemonHttpError,
  DaemonUnreachableError,
} from './daemonClient.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/rc/health') {
      return send(200, { status: 'ok' });
    }
    if (req.method === 'GET' && req.url === '/echo-auth') {
      return send(200, { auth: req.headers['authorization'] ?? null });
    }
    if (req.method === 'GET' && req.url === '/not-json') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('plain body');
    }
    if (req.method === 'POST' && req.url === '/echo-body') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () =>
        send(200, { body: JSON.parse(raw), ct: req.headers['content-type'] }),
      );
      return;
    }
    if (req.method === 'DELETE' && req.url === '/gone') {
      return send(200, { deleted: true });
    }
    if (req.method === 'GET' && req.url === '/slow') {
      return setTimeout(() => send(200, { late: true }), 500);
    }
    if (req.method === 'GET' && req.url === '/boom') {
      return send(500, { error: 'kaboom', code: 'internal' });
    }
    return send(404, { error: 'no such route', code: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('daemonRequest', () => {
  it('performs an authenticated GET and parses JSON', async () => {
    const r = await daemonRequest(
      { url: base, token: 'qwk_t' },
      { method: 'GET', path: '/echo-auth' },
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ auth: 'Bearer qwk_t' });
  });

  it('joins the path onto a base with a trailing slash', async () => {
    const r = await daemonRequest(
      { url: base + '/' },
      { method: 'GET', path: '/rc/health' },
    );
    expect((r.json as { status: string }).status).toBe('ok');
  });

  it('sends a JSON body with Content-Type on POST', async () => {
    const r = await daemonRequest(
      { url: base },
      {
        method: 'POST',
        path: '/echo-body',
        body: { transcript: 'include', fromEventId: 3 },
      },
    );
    expect(r.json).toEqual({
      body: { transcript: 'include', fromEventId: 3 },
      ct: 'application/json',
    });
  });

  it('supports DELETE without a body', async () => {
    const r = await daemonRequest(
      { url: base },
      {
        method: 'DELETE',
        path: '/gone',
      },
    );
    expect(r.json).toEqual({ deleted: true });
  });

  it('keeps non-JSON 2xx bodies as raw text', async () => {
    const r = await daemonRequest(
      { url: base },
      {
        method: 'GET',
        path: '/not-json',
      },
    );
    expect(r.json).toBe('plain body');
  });

  it('throws DaemonHttpError with status + code on non-2xx', async () => {
    try {
      await daemonRequest({ url: base }, { method: 'GET', path: '/boom' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonHttpError);
      const e = err as DaemonHttpError;
      expect(e.status).toBe(500);
      expect(e.code).toBe('internal');
      expect(e.message).toContain('500');
      expect(e.message).toContain('kaboom');
    }
  });

  it('throws DaemonUnreachableError for a refused connection', async () => {
    // Port 1 on localhost is closed on every sane machine.
    try {
      await daemonRequest(
        { url: 'http://127.0.0.1:1' },
        {
          method: 'GET',
          path: '/rc/health',
          timeoutMs: 2000,
        },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonUnreachableError);
    }
  });

  it('throws DaemonUnreachableError on timeout', async () => {
    const started = Date.now();
    try {
      await daemonRequest(
        { url: base },
        {
          method: 'GET',
          path: '/slow',
          timeoutMs: 50,
        },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonUnreachableError);
      expect(Date.now() - started).toBeLessThan(400);
    }
  });
});

describe('probeHealth', () => {
  it('reports ok for a 200 /rc/health', async () => {
    await expect(probeHealth(base, 2000)).resolves.toBe('ok');
  });

  it('reports unreachable for a dead daemon', async () => {
    await expect(probeHealth('http://127.0.0.1:1', 500)).resolves.toBe(
      'unreachable',
    );
  });
});

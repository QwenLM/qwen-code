/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { installRemoteSelfOriginMiddleware } from './self-origin.js';
import { bearerAuth, denyBrowserOriginCors } from '../auth.js';
import { tagListener } from '../local-control/listener-identity.js';

describe('remote same-origin authentication', () => {
  function app(bind = '0.0.0.0', token: string | undefined = 'secret') {
    const result = express();
    installRemoteSelfOriginMiddleware(result, bind, token);
    result.use(denyBrowserOriginCors);
    result.use(bearerAuth(token));
    result.post('/probe', (_req, res) => res.sendStatus(204));
    return result;
  }
  it.each([
    ['secret', 204],
    ['wrong', 401],
    ['', 401],
  ])('authenticates matching direct origin: %s', async (token, status) => {
    const response = await request(app())
      .post('/probe')
      .set('Host', '192.168.1.2:4170')
      .set('Origin', 'http://192.168.1.2:4170')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(status);
  });
  it.each([
    'null',
    'http://evil.test',
    'https://192.168.1.2:4170',
    'http://192.168.1.2:4170/',
    'http://192.168.1.2:4171',
  ])('retains origin wall for %s', async (origin) => {
    const response = await request(app())
      .post('/probe')
      .set('Host', '192.168.1.2:4170')
      .set('Origin', origin)
      .set('Authorization', 'Bearer secret')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'evil.test');
    expect(response.status).toBe(403);
  });
  it('allows public module scripts but keeps APIs and mutations authenticated', async () => {
    const result = express();
    installRemoteSelfOriginMiddleware(result, '0.0.0.0', 'secret');
    result.use(denyBrowserOriginCors);
    result.get('/assets/app.js', (_req, res) => res.sendStatus(200));
    result.use(bearerAuth('secret'));
    result.get('/capabilities', (_req, res) => res.sendStatus(200));
    result.post('/assets/app.js', (_req, res) => res.sendStatus(200));
    for (const [method, path, status] of [
      ['get', '/assets/app.js', 200],
      ['get', '/capabilities', 401],
      ['post', '/assets/app.js', 401],
    ] as const) {
      const response = await request(result)
        [method](path)
        .set('Host', '192.168.1.2:4170')
        .set('Origin', 'http://192.168.1.2:4170');
      expect(response.status).toBe(status);
    }
    expect(
      (
        await request(result)
          .get('/assets/app.js')
          .set('Host', '192.168.1.2:4170')
          .set('Origin', 'http://evil.test')
      ).status,
    ).toBe(403);
  });
  it('does not authorize tokenless embedded servers', async () => {
    const result = express();
    installRemoteSelfOriginMiddleware(result, '0.0.0.0', undefined);
    result.use(denyBrowserOriginCors);
    expect(
      (
        await request(result)
          .post('/probe')
          .set('Host', 'evil.test')
          .set('Origin', 'http://evil.test')
      ).status,
    ).toBe(403);
  });
  it('does not broaden loopback origins', async () => {
    expect(
      (
        await request(app('127.0.0.1'))
          .post('/probe')
          .set('Host', 'evil.test')
          .set('Origin', 'http://evil.test')
          .set('Authorization', 'Bearer secret')
      ).status,
    ).toBe(403);
  });
});

describe('remote same-origin Host normalization', () => {
  function app() {
    const result = express();
    installRemoteSelfOriginMiddleware(result, '0.0.0.0', 'secret');
    result.use(denyBrowserOriginCors);
    result.use(bearerAuth('secret'));
    result.post('/probe', (_req, res) => res.sendStatus(204));
    return result;
  }
  it('accepts a case-preserved Host from an intermediary', async () => {
    const authed = await request(app())
      .post('/probe')
      .set('Host', 'QwenBox.Local:4170')
      .set('Origin', 'http://qwenbox.local:4170')
      .set('Authorization', 'Bearer secret');
    expect(authed.status).toBe(204);
    const unauthed = await request(app())
      .post('/probe')
      .set('Host', 'Qwenbox.Local:4170')
      .set('Origin', 'http://qwenbox.local:4170');
    expect(unauthed.status).toBe(401);
  });
  it('accepts an explicit default port on Host', async () => {
    const response = await request(app())
      .post('/probe')
      .set('Host', '192.168.1.2:80')
      .set('Origin', 'http://192.168.1.2')
      .set('Authorization', 'Bearer secret');
    expect(response.status).toBe(204);
  });
  it('keeps the wall for a default-port Origin mismatch', async () => {
    const response = await request(app())
      .post('/probe')
      .set('Host', '192.168.1.2:80')
      .set('Origin', 'http://192.168.1.2:80')
      .set('Authorization', 'Bearer secret');
    expect(response.status).toBe(403);
  });
  it('excludes Local Control listeners from the exception', async () => {
    const handler = express();
    installRemoteSelfOriginMiddleware(handler, '0.0.0.0', 'secret');
    handler.use(denyBrowserOriginCors);
    handler.post('/probe', (_req, res) => res.sendStatus(204));
    const server = createServer(handler);
    tagListener(server, {
      kind: 'local-control',
      authority: '192.168.1.2:4170',
      origin: 'http://192.168.1.2:4170',
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const response = await request(server)
        .post('/probe')
        .set('Host', '192.168.1.2:4170')
        .set('Origin', 'http://192.168.1.2:4170')
        .set('Authorization', 'Bearer secret');
      expect(response.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { createServer } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowOriginCors,
  bearerAuth,
  parseAllowOriginPatterns,
} from '../auth.js';
import { CredentialStore } from '../local-control/credentials.js';
import { installRemoteSelfOriginMiddleware } from '../server/self-origin.js';
import { registerWebShellPairingRoutes } from './web-shell-pairing.js';
import { listLanCandidates } from '../local-control/lan-interfaces.js';
import { tagListener } from '../local-control/listener-identity.js';
import { createRateLimiter, type RateLimiterInstance } from '../rate-limit.js';
import type { DaemonLogger } from '../daemon-logger.js';
import { installAccessLogMiddleware } from '../server/access-log.js';

vi.mock('../local-control/lan-interfaces.js', () => ({
  listLanCandidates: vi.fn(() => []),
}));

const authority = 'qwen.test:4170';
const origin = `http://${authority}`;
const limiters: RateLimiterInstance[] = [];

function setup(
  hostname = '0.0.0.0',
  token: string | undefined = 'runtime-secret',
  options: {
    allowOrigins?: string[];
    rateLimit?: boolean;
    logger?: DaemonLogger;
  } = {},
) {
  const app = express();
  const credentials = new CredentialStore(token);
  if (options.logger) installAccessLogMiddleware(app, options.logger, () => 0);
  installRemoteSelfOriginMiddleware(
    app,
    hostname,
    token ? credentials : undefined,
  );
  app.use(
    allowOriginCors(parseAllowOriginPatterns(options.allowOrigins ?? [])),
  );
  const limiter = options.rateLimit
    ? createRateLimiter({
        hostname,
        tiers: {
          prompt: { windowMs: 60_000, max: 1 },
          mutation: { windowMs: 60_000, max: 2 },
          read: { windowMs: 60_000, max: 10 },
        },
      })
    : undefined;
  if (limiter) limiters.push(limiter);
  registerWebShellPairingRoutes(app, credentials, hostname, limiter);
  app.use(bearerAuth(credentials));
  if (limiter) app.use(limiter.middleware);
  app.post('/probe', (_req, res) => res.sendStatus(204));
  app.get('/probe', (_req, res) => res.sendStatus(204));
  const issue = () =>
    request(app)
      .post('/web-shell/pairing')
      .set('Host', authority)
      .set('Origin', origin)
      .set('Authorization', 'Bearer runtime-secret');
  const exchange = (code: string, host = authority) =>
    request(app)
      .post('/web-shell/pairing/exchange')
      .set('Host', host)
      .set('Origin', `http://${host}`)
      .set('Authorization', `Bearer ${code}`);
  return { app, credentials, issue, exchange };
}

function codeOf(response: { body: { url: string } }): string {
  return new URLSearchParams(new URL(response.body.url).hash.slice(1)).get(
    'pairing',
  )!;
}

afterEach(() => {
  for (const limiter of limiters.splice(0)) limiter.dispose();
  vi.restoreAllMocks();
  vi.mocked(listLanCandidates).mockReturnValue([]);
});

describe('Web Shell pairing', () => {
  it('preserves operator access logs after a throttled exchange flood', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const logger: DaemonLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      raw: vi.fn(),
      getLogPath: () => '',
      getDaemonId: () => 'pairing-test',
      getStatus: () => ({
        runId: 'pairing-test',
        mode: 'stderr-only',
        health: 'ok',
        issues: [],
        droppedRecords: 0,
        droppedBytes: 0,
      }),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const { app, exchange } = setup('0.0.0.0', 'runtime-secret', {
      rateLimit: true,
      logger,
    });
    for (let i = 0; i < 130; i++) {
      expect((await exchange('invalid')).status).toBe(i < 2 ? 401 : 429);
    }
    for (let i = 0; i < 6; i++) {
      await request(app)
        .get('/probe')
        .set('Host', authority)
        .set('Origin', origin)
        .set('Authorization', 'Bearer runtime-secret')
        .expect(204);
    }
    expect(logger.info).toHaveBeenCalledTimes(6);
    expect(logger.info).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({ route: 'GET /probe', status: 204 }),
    );
  });

  it('rejects an allowlisted foreign Origin without consuming the invitation', async () => {
    const allowedOrigin = 'http://allowed.test';
    const { issue, exchange } = setup('0.0.0.0', 'runtime-secret', {
      allowOrigins: [allowedOrigin],
    });
    const code = codeOf(await issue());
    const rejected = await exchange(code).set('Origin', allowedOrigin);
    expect(rejected.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(rejected.status).toBe(401);
    expect(
      (await exchange(code).set('Origin', 'http://evil.test')).status,
    ).toBe(403);
    expect((await exchange(code)).status).toBe(200);
  });

  it('rate-limits issuance after bearer authentication', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { issue } = setup('0.0.0.0', 'runtime-secret', { rateLimit: true });
    expect(
      (await issue().unset('Origin').set('Authorization', 'Bearer wrong'))
        .status,
    ).toBe(401);
    expect((await issue()).status).toBe(200);
    expect((await issue()).status).toBe(200);
    const rejected = await issue();
    expect(rejected.status).toBe(429);
    expect(rejected.body).toMatchObject({
      code: 'rate_limit_exceeded',
      tier: 'mutation',
    });
    expect(rejected.headers['retry-after']).toBe('30');
  });

  it('rate-limits invalid exchanges without consuming a throttled invitation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { credentials, issue, exchange } = setup(
      '0.0.0.0',
      'runtime-secret',
      { rateLimit: true },
    );
    const code = codeOf(await issue());
    for (const clientId of ['untrusted-1', 'untrusted-2']) {
      expect(
        (await exchange('invalid').set('X-Qwen-Client-Id', clientId)).status,
      ).toBe(401);
    }
    const throttled = await exchange(code).set(
      'X-Qwen-Client-Id',
      'untrusted-3',
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers['cache-control']).toBe('no-store');
    now.mockReturnValue(31_000);
    const paired = await exchange(code).set('X-Qwen-Client-Id', 'untrusted-4');
    expect(paired.status).toBe(200);
    expect(credentials.verify(paired.body.token, { kind: 'primary' })).toBe(
      true,
    );
  });

  it('issues by default and exchanges once for an independent primary credential', async () => {
    const { app, credentials, issue, exchange } = setup();
    const issued = await issue();
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({
      active: true,
      encrypted: false,
      expiresInMs: 60_000,
      qrText: expect.any(String),
    });
    expect(issued.body.url).not.toContain('runtime-secret');
    expect(issued.headers['cache-control']).toBe('no-store');
    const code = codeOf(issued);
    expect(credentials.verify(code, { kind: 'primary' })).toBe(false);
    const paired = await exchange(code);
    expect(paired.status).toBe(200);
    expect(paired.headers['cache-control']).toBe('no-store');
    expect(paired.body.token).not.toBe('runtime-secret');
    expect(
      credentials.verify(paired.body.token, { kind: 'local-control' }),
    ).toBe(false);
    expect((await exchange(code)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/probe')
          .set('Host', authority)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${paired.body.token}`)
      ).status,
    ).toBe(204);
  });

  it('expires invitations without expiring connected devices or invalidating in-progress scans', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { credentials, issue, exchange } = setup();
    const first = await issue();
    const unused = await issue();
    const inProgress = await issue();
    const paired = await exchange(codeOf(first));
    now.mockReturnValue(46_000);
    const fresh = await issue();
    expect(fresh.body.url).not.toBe(unused.body.url);
    expect((await exchange(codeOf(inProgress))).status).toBe(200);
    now.mockReturnValue(61_000);
    expect((await exchange(codeOf(unused))).status).toBe(401);
    expect((await exchange(codeOf(fresh))).status).toBe(200);
    expect(credentials.verify(paired.body.token, { kind: 'primary' })).toBe(
      true,
    );
  });

  it('denies unauthenticated issuance, invalid codes and wrong origins', async () => {
    const { app, issue, exchange } = setup();
    expect((await request(app).post('/web-shell/pairing')).status).toBe(401);
    expect((await exchange('invalid')).status).toBe(401);
    const issued = await issue();
    expect((await exchange(codeOf(issued), 'other.test:4170')).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .post('/web-shell/pairing/exchange')
          .set('Host', authority)
          .set('Origin', 'http://evil.test')
          .set('Authorization', `Bearer ${codeOf(issued)}`)
      ).status,
    ).toBe(403);
    expect((await exchange(codeOf(issued))).status).toBe(200);
  });

  it('keeps loopback on the existing Local Control path', async () => {
    const { app } = setup('127.0.0.1');
    const response = await request(app)
      .post('/web-shell/pairing')
      .set('Authorization', 'Bearer runtime-secret');
    expect(response.body).toEqual({ active: false });
  });

  it('never exchanges a primary invitation on the Local Control listener', async () => {
    const { app, credentials, issue } = setup();
    const issued = await issue();
    credentials.addPairingToken('local', 'local-token');
    const server = createServer(app);
    tagListener(server, { kind: 'local-control' });
    expect(
      (
        await request(server)
          .post('/web-shell/pairing/exchange')
          .set('Host', authority)
          .set('Authorization', `Bearer ${codeOf(issued)}`)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(server)
          .post('/web-shell/pairing')
          .set('Host', authority)
          .set('Authorization', 'Bearer local-token')
      ).body,
    ).toEqual({ active: false });
  });

  it('does not create pairing on an embedded tokenless non-loopback app', async () => {
    const app = express();
    registerWebShellPairingRoutes(app, new CredentialStore(), '0.0.0.0');
    expect((await request(app).post('/web-shell/pairing')).body).toEqual({
      active: false,
    });
  });

  it.each(['127.0.0.1', '0.0.0.0', '[::]'])(
    'offers a network choice for %s access and accepts only eligible addresses',
    async (host) => {
      const interfaces = [
        { interfaceName: 'en0', address: '192.168.1.2' },
        { interfaceName: 'en1', address: '10.0.0.2' },
      ];
      vi.mocked(listLanCandidates).mockReturnValue(interfaces);
      const { app } = setup();
      const issue = (address?: string) =>
        request(app)
          .post('/web-shell/pairing')
          .set('Host', `${host}:4170`)
          .set('Authorization', 'Bearer runtime-secret')
          .send({ address });
      expect((await issue()).body).toEqual({ active: true, interfaces });
      expect((await issue('evil.test')).body).toEqual({
        active: true,
        interfaces,
      });
      expect(new URL((await issue('10.0.0.2')).body.url).origin).toBe(
        'http://10.0.0.2:4170',
      );
    },
  );

  it('bounds invitations and refuses excess devices without revoking existing credentials', async () => {
    const { credentials, issue, exchange } = setup();
    const first = await issue();
    for (let index = 0; index < 64; index++) await issue();
    expect((await exchange(codeOf(first))).status).toBe(401);
    for (let index = 0; index < 128; index++)
      expect(credentials.addWebShellToken(`device-${index}`)).toBe(true);
    expect((await exchange(codeOf(await issue()))).status).toBe(409);
    expect(credentials.verify('device-0', { kind: 'primary' })).toBe(true);
  });
});

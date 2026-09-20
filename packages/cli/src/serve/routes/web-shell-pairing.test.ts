/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { createServer } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth, denyBrowserOriginCors } from '../auth.js';
import { CredentialStore } from '../local-control/credentials.js';
import { installRemoteSelfOriginMiddleware } from '../server/self-origin.js';
import { registerWebShellPairingRoutes } from './web-shell-pairing.js';
import { listLanCandidates } from '../local-control/lan-interfaces.js';
import { tagListener } from '../local-control/listener-identity.js';

vi.mock('../local-control/lan-interfaces.js', () => ({
  listLanCandidates: vi.fn(() => []),
}));

const authority = 'qwen.test:4170';
const origin = `http://${authority}`;

function setup(
  hostname = '0.0.0.0',
  token: string | undefined = 'runtime-secret',
) {
  const app = express();
  const credentials = new CredentialStore(token);
  installRemoteSelfOriginMiddleware(
    app,
    hostname,
    token ? credentials : undefined,
  );
  app.use(denyBrowserOriginCors);
  registerWebShellPairingRoutes(app, credentials, hostname);
  app.use(bearerAuth(credentials));
  app.post('/probe', (_req, res) => res.sendStatus(204));
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
  vi.restoreAllMocks();
  vi.mocked(listLanCandidates).mockReturnValue([]);
});

describe('Web Shell pairing', () => {
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

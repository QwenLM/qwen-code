/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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
    });
    // An empty qrText hides the QR panel entirely and leaves the operator
    // with no code to scan; the route initializes it to '' before the
    // qrcode callback assigns it.
    expect(typeof issued.body.qrText).toBe('string');
    expect(issued.body.qrText.length).toBeGreaterThan(0);
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

  it.each(['127.0.0.1', '127.1', '127.0.1', '::ffff:127.0.0.1'])(
    'keeps loopback on the existing Local Control path for %s',
    async (hostname) => {
      const { app } = setup(hostname);
      const response = await request(app)
        .post('/web-shell/pairing')
        .set('Authorization', 'Bearer runtime-secret');
      expect(response.body).toEqual({ active: false });
    },
  );

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

  it('answers an empty network choice when a wildcard bind has no LAN candidate', async () => {
    const { app } = setup();
    const response = await request(app)
      .post('/web-shell/pairing')
      .set('Host', '127.0.0.1:4170')
      .set('Authorization', 'Bearer runtime-secret');
    expect(response.status).toBe(200);
    // The client's no-network copy and its re-poll gate key on exactly this
    // shape.
    expect(response.body).toEqual({ active: true, interfaces: [] });
  });

  it('redeems an invitation only at the substituted bound origin', async () => {
    const { app, exchange } = setup('192.168.1.5');
    const issued = await request(app)
      .post('/web-shell/pairing')
      .set('Host', '127.0.0.1:4170')
      .set('Authorization', 'Bearer runtime-secret');
    expect(issued.status).toBe(200);
    expect(new URL(issued.body.url).origin).toBe('http://192.168.1.5:4170');
    const code = codeOf(issued);
    // The stored origin is the substituted one: redemption dialed back at
    // the loopback address fails, and only the bound address redeems.
    expect((await exchange(code, '127.0.0.1:4170')).status).toBe(401);
    expect((await exchange(code, '192.168.1.5:4170')).status).toBe(200);
  });

  it('auto-selects the only LAN candidate on a wildcard bind', async () => {
    vi.mocked(listLanCandidates).mockReturnValue([
      { interfaceName: 'en0', address: '192.168.1.2' },
    ]);
    const { app } = setup();
    const response = await request(app)
      .post('/web-shell/pairing')
      .set('Host', '127.0.0.1:4170')
      .set('Authorization', 'Bearer runtime-secret');
    expect(response.status).toBe(200);
    expect(response.body.interfaces).toBeUndefined();
    expect(new URL(response.body.url).origin).toBe('http://192.168.1.2:4170');
  });

  it.each(['0', '0.0', '[::0]', '::ffff:0.0.0.0'])(
    'offers the LAN choice on a wildcard bind spelled %s',
    async (hostname) => {
      const interfaces = [
        { interfaceName: 'en0', address: '192.168.1.2' },
        { interfaceName: 'en1', address: '10.0.0.2' },
      ];
      vi.mocked(listLanCandidates).mockReturnValue(interfaces);
      const { app } = setup(hostname);
      const response = await request(app)
        .post('/web-shell/pairing')
        .set('Host', '127.0.0.1:4170')
        .set('Authorization', 'Bearer runtime-secret');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ active: true, interfaces });
    },
  );

  it('substitutes the bound address when a specific bind is reached over loopback', async () => {
    const { app } = setup('192.168.1.5');
    const response = await request(app)
      .post('/web-shell/pairing')
      .set('Host', '127.0.0.1:4170')
      .set('Authorization', 'Bearer runtime-secret');
    expect(response.status).toBe(200);
    expect(new URL(response.body.url).origin).toBe('http://192.168.1.5:4170');
  });

  it('brackets a raw IPv6 bind when substituting the bound address', async () => {
    const { app } = setup('2001:db8::5');
    const response = await request(app)
      .post('/web-shell/pairing')
      .set('Host', '127.0.0.1:4170')
      .set('Authorization', 'Bearer runtime-secret');
    expect(response.status).toBe(200);
    // Assigning the unbracketed literal to URL.hostname would silently
    // no-op and leave the QR pointing at the browser's own loopback.
    expect(new URL(response.body.url).hostname).toBe('[2001:db8::5]');
  });

  it('evicts only the oldest live invitation at the cap', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { issue, exchange } = setup();
    const oldest = await issue();
    const second = await issue();
    for (let index = 0; index < 63; index++) await issue();
    expect((await exchange(codeOf(oldest))).status).toBe(401);
    expect((await exchange(codeOf(second))).status).toBe(200);
  });

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

describe('Web Shell pairing over TLS', () => {
  // Long-lived self-signed cert (CN=localhost, SAN IP:127.0.0.1), used only
  // to put a real TLSSocket under the route — `req.protocol` must come from
  // the socket, not a forwarded header. Not a real secret; the same fixture
  // as server/self-origin.test.ts.
  const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUfuVC8Ulq3HIg+1tf36JrjAa6dr4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYzMDAyMjIxOVoYDzIxMjYw
NjA2MDIyMjE5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCnEk5caJsr2ShJwi4bkAMr1/IzzueiUFbnnqs3XpaB
ANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2MVHoDMH3zx4V36VcXUaeR+/wZbFRN
94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATGJZkzmGT8+M5CqDCW4isHlpGvbn0T
SdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wTAOIM8e8HC1VTMw1OhXDAus6ro7z+
u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7kmYwT9J1Gyw9cQQj8vcipyLq6q3Hz
iMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIYshAYRsKNAgMBAAGjbzBtMB0GA1Ud
DgQWBBSM8bvfq77vXg5fsuhYGXsLuKjqxzAfBgNVHSMEGDAWgBSM8bvfq77vXg5f
suhYGXsLuKjqxzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAGUBgaBYEO119e28j61PTijfhw7mV
Q8AxlUjlv+HHx+IAPR+E8w7jiS97oxvFSIkmbV+FAQOWwTE+oNvrL5qSFlG7cI60
wj+Jxwxr+/SShV5Jm7JlynAGxOvOZ1mfxzyGrlm5cg4hoRvcoWAtB/qtiIyFIz/s
fDAdZiFXRoTaZnpyPWA6iydf3mc0ZOastHib+mlFb+aedKz9by/f2Z1CY6RfckEj
20c9Mar85RYkVtVTIWNSwItASmQVBaoXsXK33y4C0P1NmPoYBzyPSXsOlmIZXui5
WYj2mrPe2DL5gCeNUxMhmzgv0bgoYiksHmdyNjRmO5AQlcdjX/7CHg0zEQ==
-----END CERTIFICATE-----
`;
  const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCnEk5caJsr2ShJ
wi4bkAMr1/IzzueiUFbnnqs3XpaBANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2M
VHoDMH3zx4V36VcXUaeR+/wZbFRN94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATG
JZkzmGT8+M5CqDCW4isHlpGvbn0TSdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wT
AOIM8e8HC1VTMw1OhXDAus6ro7z+u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7k
mYwT9J1Gyw9cQQj8vcipyLq6q3HziMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIY
shAYRsKNAgMBAAECggEAQW/tG0qphEog+orAznDgnRqOtfYTScLX1w6RlzVIE60H
p3HPs/1B7HOHNyWxZtCPbxVI47NAAwfCbyVjSL6EhqgeQbI2N173GDmvKzH/7y3D
3GraM+L4tZOSw80KVTdpzqSObInk6IMuu4FceRX2cBLvjrIbne1l1yoFU8Yd3SCM
t8J46vMys7Rh4yR0iOl1hFeLYj8KolTdp6uNYTxaHMt363G7/TcJYRqjrLkpBpXJ
dJiP58a3WulvVKVHBjZYVmHLlkvla7LQ9tPRsk0gUQfzNpLzl6oBacrNrRv1F7Oe
keYqt+Kpy9HhZIHt57ahwKmjhjrfIUpyQadF/me0rQKBgQDVbLV6VngGjMSCPQOQ
VZcAMFZ+y1fgaHeVZwuFeRlCEHBDDmw5eWdUdUQNIRckpqf0IlU39aP/cLgjNZ0W
nmxfUwhdgEMam2aHZ/8eqrOl0HTa+F5PWz8NPLKsQ970vPb1XCsoEtDVXEsMqK+s
4h+zjRzy6lLy2cWvYZrDr/KwywKBgQDIZmitKO0MIJOWeqwI3MQvbBXCz9aEIG+3
0ISQreD/7Z/IEcwrMpDD+z1sOj9OUO2GFflECdhtqo416cv3uo8LLABxuzsYOgug
ZPgW9oPKVRLfqc43/n0JMtIvS+Na/7C/nCNwcZZZU91V+VG4+1rexINQybnCRbQw
cBZLcX8nBwKBgQDMdZhl2vChVbnsCwee/l/qjmROk/9bvLjTKCSheaH46Eaj9u03
IlcbUjwfV9QUCJReDYYWVf0GebXuBS64vIyVxbX93SJsGvPeRILjniT8dPd9zvKK
k5+TztJctaiiTWVJKUMu4NevjvtW5UNnHDnCiS1yiYltnbMEkTzyu1yEgQKBgAYk
pYbRX1rk0MFnJ0jqQ5VUkeIz7taEDAiterLYsbIGvcQrT3/vf+KSHBLqQjCLaIyY
tdhxGNJbzRo3/YmtjV8BTU4vOCOI+/xBvB0wF2AndXmnweuTgI+8oBbVE7YhanCl
P6zdvocke/97shailemISqI6XNhovJpThUtwwj4XAoGATwSvzX0VLRpoWwDl30oi
hxyfpb0iCzGik49j/oL+ZB5C8F8AdBpza8eTXJAeAVP7L5nvWffMgvcXs5sGMF7e
ARaOwZHpfsTw4Aq74yAWUKXumVGFXQpZMRj/QWgQEItTYF7rJVARIssv5miDbHvW
1Qm2tDpPnmCd1BedIYWCnHA=
-----END PRIVATE KEY-----
`;

  it('reports issued pairings as encrypted over a TLS socket', async () => {
    const { app } = setup();
    const server = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    // The fixture is self-signed; the client half of the handshake must not
    // anchor it while the server half keeps real TLSSocket semantics.
    const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const issued = await request(server)
        .post('/web-shell/pairing')
        .set('Host', authority)
        .set('Origin', `https://${authority}`)
        .set('Authorization', 'Bearer runtime-secret');
      expect(issued.status).toBe(200);
      // A TLS operator told "unencrypted" learns to ignore the warning that
      // matters on the plain-HTTP daemon next door.
      expect(issued.body.encrypted).toBe(true);
      expect(issued.body.url).toContain('https://');
    } finally {
      if (previous === undefined)
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
      server.close();
    }
  });
});

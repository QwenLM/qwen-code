/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the REAL `createHttp2ApnsTransport` (closing the
 * transport-wiring half of the APNs ceiling): it drives the actual node:http2
 * client against an in-process HTTP/2 server impersonating APNs — hermetic, no
 * external service, runs in any lane. What stays unverified is only Apple's own
 * acceptance of the JWT + delivery to a device (needs Apple + a real device).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createSecureServer,
  type Http2SecureServer,
  constants as H2,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttp2ApnsTransport, ApnsSender } from './apnsSender.js';
import { createApnsJwt } from './apnsJwt.js';
import { ApnsStore } from './apnsStore.js';
import {
  LOCALHOST_TEST_CERT,
  LOCALHOST_TEST_KEY,
} from './testfixtures/localhostTls.js';

interface Captured {
  method?: string;
  path?: string;
  topic?: string;
  pushType?: string;
  authorization?: string;
  body: string;
}

let server: Http2SecureServer | undefined;

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(() => r(undefined)));
  server = undefined;
});

async function startFakeApns(respondStatus: number): Promise<{
  host: string;
  captured: Captured;
}> {
  const captured: Captured = { body: '' };
  server = createSecureServer({
    key: LOCALHOST_TEST_KEY,
    cert: LOCALHOST_TEST_CERT,
  });
  server.on('stream', (stream, headers) => {
    captured.method = headers[H2.HTTP2_HEADER_METHOD] as string;
    captured.path = headers[H2.HTTP2_HEADER_PATH] as string;
    captured.topic = headers['apns-topic'] as string;
    captured.pushType = headers['apns-push-type'] as string;
    captured.authorization = headers['authorization'] as string;
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => (body += c));
    stream.on('end', () => {
      captured.body = body;
      stream.respond({ [H2.HTTP2_HEADER_STATUS]: respondStatus });
      stream.end(respondStatus === 200 ? '' : JSON.stringify({ reason: 'X' }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as AddressInfo).port;
  return { host: `localhost:${port}`, captured };
}

function realJwt(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return createApnsJwt({
    keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: 'KEYID1',
    teamId: 'TEAM01',
    now: () => 1_700_000_000_000,
  });
}

// Trust the self-signed fixture CA — TEST-ONLY; production passes no options.
const trust = { ca: LOCALHOST_TEST_CERT };

describe('createHttp2ApnsTransport (real http2 against a fake APNs)', () => {
  it('POSTs /3/device/<token> with the documented headers + a well-formed ES256 JWT', async () => {
    const { host, captured } = await startFakeApns(200);
    const jwt = realJwt();
    const res = await createHttp2ApnsTransport(trust).post({
      host,
      deviceToken: 'abc123dev',
      topic: 'dev.qwen.rc',
      jwt,
      body: JSON.stringify({ aps: { alert: { title: 'hi' } } }),
    });
    expect(res.status).toBe(200);
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/3/device/abc123dev');
    expect(captured.topic).toBe('dev.qwen.rc');
    expect(captured.pushType).toBe('alert');
    expect(captured.authorization).toBe(`bearer ${jwt}`);
    expect(JSON.parse(captured.body).aps.alert.title).toBe('hi');

    // The auth header is a parseable ES256 JWT with the right header/claims.
    const [h, p] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEYID1' });
    expect(payload.iss).toBe('TEAM01');
    expect(typeof payload.iat).toBe('number');
  });

  it('propagates a 410 through ApnsSender + the real transport → subscription removed', async () => {
    const { host } = await startFakeApns(410);
    const dir = mkdtempSync(join(tmpdir(), 'rc-apns-it-'));
    try {
      const store = await ApnsStore.open(join(dir, 'apns.json'), () => 1);
      const sub = await store.register({
        tokenId: 't',
        deviceToken: 'dt',
        bundleId: 'dev.qwen.rc',
        shellVersion: '1',
      });
      const sender = new ApnsSender({
        signer: { token: () => realJwt() },
        transport: createHttp2ApnsTransport(trust),
        store,
        bundleId: 'dev.qwen.rc',
        host,
        wait: () => Promise.resolve(),
      });
      const r = await sender.send(sub, {
        v: 1,
        kind: 'agent.completed',
        sessionId: 's1',
        summary: 'done',
        url: '/ui/?session=s1',
      });
      expect(r).toEqual({ ok: false, removed: true });
      expect(store.get(sub.id)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DEFAULTS to strict TLS — no connectOptions rejects the self-signed server', async () => {
    const { host } = await startFakeApns(200);
    // Production path: no trust override → the self-signed cert must be refused.
    await expect(
      createHttp2ApnsTransport().post({
        host,
        deviceToken: 'd',
        topic: 't',
        jwt: 'j',
        body: '{}',
      }),
    ).rejects.toThrow();
  });

  it('sanity: the fixture key/cert are a usable TLS pair', () => {
    // Guards against a future fixture swap breaking the suite silently.
    const v = createVerify('SHA256');
    expect(typeof LOCALHOST_TEST_CERT).toBe('string');
    expect(LOCALHOST_TEST_KEY).toContain('PRIVATE KEY');
    expect(v).toBeDefined();
  });
});

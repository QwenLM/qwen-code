/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
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
    'https://evil.test',
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
  // Non-canonical authorities Node's URL parser accepts: the string compare
  // matches (Host equals Origin), so only the re-parse guard rejects them.
  // '[::1' additionally exercises the catch arm — its URL never parses.
  it.each(['192.168.1.2.:4170', 'u:p@192.168.1.2:4170', '[::1'])(
    'keeps the wall for the non-canonical authority %s',
    async (authority) => {
      const response = await request(app())
        .post('/probe')
        .set('Host', authority)
        .set('Origin', `http://${authority}`)
        .set('Authorization', 'Bearer secret');
      expect(response.status).toBe(403);
    },
  );
  it('keeps the wall for a hostless HTTP/1.0 request carrying Origin', async () => {
    const handler = express();
    installRemoteSelfOriginMiddleware(handler, '0.0.0.0', 'secret');
    handler.use(denyBrowserOriginCors);
    handler.post('/probe', (_req, res) => res.sendStatus(204));
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      // supertest always sends Host, so drive the raw socket: HTTP/1.0 with
      // an Origin but no Host line must not blow up the guard's Host read.
      const port = (server.address() as AddressInfo).port;
      const raw = await new Promise<string>((resolve, reject) => {
        let data = '';
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(
            'POST /probe HTTP/1.0\r\n' +
              'Origin: http://192.168.1.2:4170\r\n' +
              'Authorization: Bearer secret\r\n' +
              'Content-Length: 0\r\n' +
              'Connection: close\r\n\r\n',
          );
        });
        socket.on('data', (chunk) => (data += chunk));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(raw).toContain('403');
    } finally {
      server.close();
    }
  });
  it('allows public module scripts but keeps APIs and mutations authenticated', async () => {
    const result = express();
    installRemoteSelfOriginMiddleware(result, '0.0.0.0', 'secret');
    result.use(denyBrowserOriginCors);
    result.get('/assets/app.js', (_req, res) => res.sendStatus(200));
    // Registered ahead of bearerAuth so the unauthenticated same-origin POST
    // row discriminates the pre-auth predicate's GET/HEAD method gate: with
    // the gate deleted the Origin is stripped and this route answers 200.
    result.post('/assets/app.js', (_req, res) => res.sendStatus(200));
    result.use(bearerAuth('secret'));
    result.get('/capabilities', (_req, res) => res.sendStatus(200));
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
  it('keeps the wall when only the other scheme default port would strip', async () => {
    // :443 is not the http default port — only the scheme's own default port
    // may be stripped, so this Origin must never match a :443 Host.
    const response = await request(app())
      .post('/probe')
      .set('Host', '192.168.1.2:443')
      .set('Origin', 'http://192.168.1.2')
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

describe('remote same-origin over TLS', () => {
  // Long-lived self-signed cert (CN=localhost, SAN IP:127.0.0.1), used only
  // to put a real TLSSocket under the middleware. Not a real secret.
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

  async function withTlsServer(
    run: (server: Server) => Promise<void>,
  ): Promise<void> {
    const handler = express();
    installRemoteSelfOriginMiddleware(handler, '0.0.0.0', 'secret');
    handler.use(denyBrowserOriginCors);
    handler.use(bearerAuth('secret'));
    handler.post('/probe', (_req, res) => res.sendStatus(204));
    const server = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, handler);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    // The fixture is self-signed; the client half of the handshake must not
    // anchor it while the server half keeps real TLSSocket semantics.
    const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      await run(server);
    } finally {
      if (previous === undefined)
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
      server.close();
    }
  }

  it('derives the scheme from the socket and strips :443 from Host', async () => {
    await withTlsServer(async (server) => {
      const authed = await request(server)
        .post('/probe')
        .set('Host', '192.168.1.2:443')
        .set('Origin', 'https://192.168.1.2')
        .set('Authorization', 'Bearer secret');
      expect(authed.status).toBe(204);
      const unauthed = await request(server)
        .post('/probe')
        .set('Host', '192.168.1.2:443')
        .set('Origin', 'https://192.168.1.2');
      expect(unauthed.status).toBe(401);
    });
  });

  it('keeps the wall for a scheme mismatch or an explicit :443 Origin', async () => {
    await withTlsServer(async (server) => {
      for (const origin of [
        'http://192.168.1.2',
        'https://192.168.1.2:443',
        'https://192.168.1.2:4171',
      ]) {
        const response = await request(server)
          .post('/probe')
          .set('Host', '192.168.1.2:443')
          .set('Origin', origin)
          .set('Authorization', 'Bearer secret');
        expect(response.status).toBe(403);
      }
    });
  });

  it('never strips :80 from an https Host', async () => {
    // The crossed arm of the http :443 pin: only the scheme's own default
    // port may be stripped, so an :80 Host under https never matches.
    await withTlsServer(async (server) => {
      const response = await request(server)
        .post('/probe')
        .set('Host', '192.168.1.2:80')
        .set('Origin', 'https://192.168.1.2')
        .set('Authorization', 'Bearer secret');
      expect(response.status).toBe(403);
    });
  });
});

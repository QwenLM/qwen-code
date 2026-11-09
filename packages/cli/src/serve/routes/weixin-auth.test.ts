/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, request as httpRequest, type Server } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWeixinAuthRoutes } from './weixin-auth.js';

const BOT_TOKEN = 'ilink-bot-token-must-never-leak';

/**
 * Loopback stand-in for the iLink Bot API. Scripted responses repeat their last
 * entry once exhausted, so a test only lists the transitions it cares about.
 */
class FakeIlink {
  qrResponses: Array<Record<string, unknown>> = [
    { qrcode: 'qr-1', qrcode_img_content: 'https://scan.example/qr-1' },
  ];
  statusResponses: Array<Record<string, unknown>> = [{ status: 'waiting' }];
  qrCalls = 0;
  statusCalls = 0;
  statusQrcodes: string[] = [];
  statusHttpCode = 200;
  /** Holds the mint open, so a client can vanish while it is in flight. */
  mintDelayMs = 0;
  private server: Server | undefined;
  private dispose: (() => void) | undefined;
  baseUrl = '';

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/ilink/bot/get_bot_qrcode') {
        const body =
          this.qrResponses[Math.min(this.qrCalls, this.qrResponses.length - 1)];
        this.qrCalls += 1;
        if (this.mintDelayMs > 0) {
          setTimeout(() => res.end(JSON.stringify(body)), this.mintDelayMs);
          return;
        }
        res.end(JSON.stringify(body));
        return;
      }
      if (url.pathname === '/ilink/bot/get_qrcode_status') {
        this.statusQrcodes.push(url.searchParams.get('qrcode') ?? '');
        const body =
          this.statusResponses[
            Math.min(this.statusCalls, this.statusResponses.length - 1)
          ];
        this.statusCalls += 1;
        res.statusCode = this.statusHttpCode;
        res.end(JSON.stringify(body));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  setDispose(dispose: () => void): void {
    this.dispose = dispose;
  }

  runDispose(): void {
    this.dispose?.();
  }
}

function mount(fake: FakeIlink) {
  const mutate =
    (_opts?: { strict?: boolean }): RequestHandler =>
    (req, res, next) => {
      if (req.header('authorization') !== 'Bearer secret') {
        res.status(401).json({ code: 'token_required' });
        return;
      }
      next();
    };
  const app = express();
  app.use(express.json());
  const dispose = registerWeixinAuthRoutes(app, mutate, {
    apiBaseUrl: fake.baseUrl,
  });
  fake.setDispose(dispose);
  return app;
}

const auth = (test: request.Test) => test.set('Authorization', 'Bearer secret');

/**
 * The flow view is `waiting` from the moment it is created, so waiting on that
 * status says nothing about the upstream loop having started — the first poll
 * lands a second later. Waiting on the upstream call itself is both the
 * liveness control the stop assertions need and a deterministic one: asserting
 * "at least one poll happened" right after a view read is a race that only
 * passes when the suite happens to be slow.
 */
async function waitForUpstreamPoll(
  fake: FakeIlink,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fake.statusCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(fake.statusCalls).toBeGreaterThan(0);
}

/**
 * A live flow polls once a second, so two consecutive windows tell a stopped
 * flow from a running one. The first window also lets a request that was
 * already airborne when the flow was dropped land: comparing a single
 * post-drop snapshot against a pre-drop one races that call and flakes under
 * load, which is a defect in the test rather than in the route.
 */
async function expectPollingStopped(fake: FakeIlink): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const settled = fake.statusCalls;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(fake.statusCalls).toBe(settled);
}

async function waitForStatus(
  app: express.Express,
  id: string,
  status: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await auth(request(app).get(`/auth/weixin/flows/${id}`));
    last = response.body as Record<string, unknown>;
    if (last['status'] === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `flow ${id} never reached ${status}; last view ${JSON.stringify(last)}`,
  );
}

describe('weixin auth routes', () => {
  let stateDir: string;
  let fake: FakeIlink;
  let app: express.Express;
  let bodies: string[];

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'weixin-auth-test-'));
    process.env['WEIXIN_STATE_DIR'] = stateDir;
    bodies = [];
    fake = new FakeIlink();
    await fake.start();
    app = mount(fake);
  });

  afterEach(async () => {
    fake.runDispose();
    await fake.stop();
    delete process.env['WEIXIN_STATE_DIR'];
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Every response body seen so far, for the token-leak assertions. */
  function record(response: request.Response): request.Response {
    recordView(response.body);
    return response;
  }

  function recordView(view: unknown): void {
    // A 204 carries no body; stringify(undefined) is undefined, not a string,
    // and would make the toContain assertion throw instead of passing.
    bodies.push(JSON.stringify(view) ?? 'null');
  }

  it('reports a logged-out account without calling upstream', async () => {
    const response = record(await auth(request(app).get('/auth/weixin')));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true, configured: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fake.qrCalls).toBe(0);
    expect(fake.statusCalls).toBe(0);
  });

  it('reports a stored account without echoing the token', async () => {
    const { saveAccount } = await import('@qwen-code/channel-weixin/accounts');
    saveAccount({
      token: BOT_TOKEN,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      userId: 'user-1',
      savedAt: '2026-11-09T00:00:00.000Z',
    });

    const response = record(await auth(request(app).get('/auth/weixin')));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      enabled: true,
      configured: true,
      userId: 'user-1',
      savedAt: '2026-11-09T00:00:00.000Z',
    });
    expect(JSON.stringify(response.body)).not.toContain(BOT_TOKEN);
  });

  it('starts a flow with a scannable QR and reaches ready', async () => {
    fake.statusResponses = [
      {
        status: 'confirmed',
        bot_token: BOT_TOKEN,
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'user-1',
      },
    ];

    const started = record(
      await auth(request(app).post('/auth/weixin/flows')).send({}),
    );
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      status: 'waiting',
      qrcodeUrl: 'https://scan.example/qr-1',
    });
    expect(typeof started.body['id']).toBe('string');
    expect(String(started.body['qrText']).length).toBeGreaterThan(0);

    const ready = await waitForStatus(
      app,
      started.body['id'] as string,
      'ready',
    );
    recordView(ready);
    expect(ready['status']).toBe('ready');

    const accountPath = join(stateDir, 'account.json');
    expect(existsSync(accountPath)).toBe(true);
    const saved = JSON.parse(readFileSync(accountPath, 'utf-8')) as {
      token: string;
      userId: string;
    };
    expect(saved.token).toBe(BOT_TOKEN);
    expect(saved.userId).toBe('user-1');
    expect(statSync(accountPath).mode & 0o777).toBe(0o600);

    // The whole point of the view contract: the credential is persisted, never
    // returned. Check every body observed across the sequence, not just the last.
    for (const body of bodies) expect(body).not.toContain(BOT_TOKEN);
  });

  it('advances through scanned before ready', async () => {
    fake.statusResponses = [
      { status: 'scaned' },
      { status: 'confirmed', bot_token: BOT_TOKEN },
    ];

    const started = record(
      await auth(request(app).post('/auth/weixin/flows')).send({}),
    );
    const id = started.body['id'] as string;

    const scanned = await waitForStatus(app, id, 'scanned');
    expect(scanned['status']).toBe('scanned');
    const ready = await waitForStatus(app, id, 'ready');
    expect(ready['status']).toBe('ready');
  });

  it('returns a JSON flow_not_found for an unknown id', async () => {
    const response = record(
      await auth(request(app).get('/auth/weixin/flows/nope')),
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: 'flow_not_found' });
  });

  it('serves the flow view with no-store', async () => {
    const started = await auth(request(app).post('/auth/weixin/flows')).send(
      {},
    );
    const view = await auth(
      request(app).get(`/auth/weixin/flows/${started.body['id'] as string}`),
    );

    expect(view.status).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
  });

  it('reports credentials_error when the account cannot be written', async () => {
    // A regular file where the state directory should be makes the credential
    // write throw. The login succeeded upstream, so reporting `ready` here
    // would claim an account that was never stored.
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, 'not a directory');
    fake.statusResponses = [{ status: 'confirmed', bot_token: BOT_TOKEN }];

    const started = await auth(request(app).post('/auth/weixin/flows')).send(
      {},
    );
    const view = await waitForStatus(
      app,
      started.body['id'] as string,
      'error',
    );

    expect(view).toMatchObject({
      status: 'error',
      errorCode: 'credentials_error',
    });
    expect(JSON.stringify(view)).not.toContain(BOT_TOKEN);
  });

  it('requires the mutation gate on start, cancel and revoke', async () => {
    const start = await request(app).post('/auth/weixin/flows').send({});
    const cancel = await request(app).delete('/auth/weixin/flows/nope');
    const revoke = await request(app).post('/auth/weixin/revoke');

    expect([start.status, cancel.status, revoke.status]).toEqual([
      401, 401, 401,
    ]);
    expect(fake.qrCalls).toBe(0);
  });

  it('stops polling upstream once a flow is cancelled', async () => {
    const started = record(
      await auth(request(app).post('/auth/weixin/flows')).send({}),
    );
    const id = started.body['id'] as string;
    // Liveness control: without at least one upstream poll before the drop,
    // "polling stopped" would also be true of a flow that never polled at all.
    await waitForStatus(app, id, 'waiting');
    await waitForUpstreamPoll(fake);

    const cancelled = await auth(
      request(app).delete(`/auth/weixin/flows/${id}`),
    );
    expect(cancelled.status).toBe(204);

    await expectPollingStopped(fake);
    const gone = await auth(request(app).get(`/auth/weixin/flows/${id}`));
    expect(gone.status).toBe(404);
  });

  it('revoke cancels in-flight flows and removes the account', async () => {
    const { saveAccount } = await import('@qwen-code/channel-weixin/accounts');
    saveAccount({
      token: BOT_TOKEN,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      savedAt: '2026-11-09T00:00:00.000Z',
    });
    const started = await auth(request(app).post('/auth/weixin/flows')).send(
      {},
    );
    const id = started.body['id'] as string;
    await waitForStatus(app, id, 'waiting');
    await waitForUpstreamPoll(fake);

    const revoked = await auth(request(app).post('/auth/weixin/revoke'));
    expect(revoked.status).toBe(204);
    expect(existsSync(join(stateDir, 'account.json'))).toBe(false);

    await expectPollingStopped(fake);
    const status = await auth(request(app).get('/auth/weixin'));
    expect(status.body).toMatchObject({ configured: false });
  });

  it('caps concurrent flows', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await auth(request(app).post('/auth/weixin/flows')).send(
        {},
      );
      expect(response.status).toBe(201);
      ids.push(response.body['id'] as string);
    }

    const fifth = await auth(request(app).post('/auth/weixin/flows')).send({});
    expect(fifth.status).toBe(429);
    expect(fifth.body).toEqual({ code: 'too_many_flows' });
    // A refused start must not spend an upstream QR request.
    expect(fake.qrCalls).toBe(4);
  });

  it('holds the cap under concurrent starts', async () => {
    // Sequential starts cannot expose the race: the cap must be checked and
    // the slot reserved without an intervening await, or every concurrent
    // request passes the check before any of them registers.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        auth(request(app).post('/auth/weixin/flows')).send({}),
      ),
    );

    const created = responses.filter((item) => item.status === 201);
    const refused = responses.filter((item) => item.status === 429);
    expect(created).toHaveLength(4);
    expect(refused).toHaveLength(2);
    for (const item of refused) {
      expect(item.body).toEqual({ code: 'too_many_flows' });
    }
    expect(fake.qrCalls).toBe(4);
  });

  it('drops a flow whose client vanished before the mint answered', async () => {
    // A tab refresh during login aborts the POST, so the client never learns
    // the id and can never cancel. The daemon must not keep the flow: a leaked
    // slot would leave one fewer real login able to start. The drop is
    // triggered by the upstream call actually arriving rather than by a sleep,
    // which would race the mint on a loaded machine and fail for the wrong
    // reason.
    const mintDelayMs = 1000;
    fake.mintDelayMs = mintDelayMs;
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const gone = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/auth/weixin/flows',
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
      });
      // The client disappearing is the point of the test, not a failure.
      gone.on('error', () => undefined);
      gone.end('{}');
      const deadline = Date.now() + 8000;
      while (fake.qrCalls === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fake.qrCalls).toBeGreaterThan(0);
      gone.destroy();
      // Let the delayed mint answer, so the drop is the only thing that could
      // have freed the slot.
      await new Promise((resolve) => setTimeout(resolve, mintDelayMs + 400));
    } finally {
      fake.mintDelayMs = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // All four slots are free again; a leak would make the fourth 429.
    fake.qrResponses = [
      { qrcode: 'qr-ok', qrcode_img_content: 'https://scan.example/ok' },
    ];
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const ok = await auth(request(app).post('/auth/weixin/flows')).send({});
      statuses.push(ok.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201]);
  });

  it('ends expired after the refresh budget', async () => {
    fake.statusResponses = [{ status: 'expired' }];
    fake.qrResponses = [
      { qrcode: 'qr-1', qrcode_img_content: 'https://scan.example/qr-1' },
      { qrcode: 'qr-2', qrcode_img_content: 'https://scan.example/qr-2' },
      { qrcode: 'qr-3', qrcode_img_content: 'https://scan.example/qr-3' },
    ];

    const started = await auth(request(app).post('/auth/weixin/flows')).send(
      {},
    );
    const view = await waitForStatus(
      app,
      started.body['id'] as string,
      'expired',
    );

    expect(view).toMatchObject({ status: 'expired', errorCode: 'qr_expired' });
    // One initial mint plus two refreshes; the third expiry terminates first.
    expect(fake.qrCalls).toBe(3);
    expect(fake.statusQrcodes).toContain('qr-2');
    expect(fake.statusQrcodes).toContain('qr-3');
  });

  it('maps an upstream failure to a stable error code', async () => {
    fake.statusHttpCode = 500;
    fake.statusResponses = [{ errmsg: 'internal upstream detail' }];

    const started = await auth(request(app).post('/auth/weixin/flows')).send(
      {},
    );
    const view = await waitForStatus(
      app,
      started.body['id'] as string,
      'error',
    );

    expect(view).toMatchObject({ status: 'error', errorCode: 'login_failed' });
    expect(JSON.stringify(view)).not.toContain('internal upstream detail');
  });

  it('reports qr_unavailable when the QR cannot be minted', async () => {
    fake.qrResponses = [{ qrcode: '' }];

    const response = record(
      await auth(request(app).post('/auth/weixin/flows')).send({}),
    );

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: 'qr_unavailable' });
    // A failed mint must not occupy a slot: four more starts still succeed.
    fake.qrResponses = [
      { qrcode: 'qr-ok', qrcode_img_content: 'https://scan.example/ok' },
    ];
    for (let i = 0; i < 4; i += 1) {
      const ok = await auth(request(app).post('/auth/weixin/flows')).send({});
      expect(ok.status).toBe(201);
    }
  });

  it('refuses a QR that carries no scannable URL', async () => {
    // A qrcode id alone is not a login: the flow would be live with neither a
    // QR to scan nor a link to open, and a live flow renders no retry action,
    // so the operator would be stuck until the deadline. The real encoder
    // failing is a different case and stays tolerated (next test).
    fake.qrResponses = [{ qrcode: 'qr-no-url' }];

    const response = record(
      await auth(request(app).post('/auth/weixin/flows')).send({}),
    );

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: 'qr_unavailable' });
    // The slot must be released: four more starts still succeed.
    fake.qrResponses = [
      { qrcode: 'qr-ok', qrcode_img_content: 'https://scan.example/ok' },
    ];
    for (let i = 0; i < 4; i += 1) {
      const ok = await auth(request(app).post('/auth/weixin/flows')).send({});
      expect(ok.status).toBe(201);
    }
  });

  it('keeps the flow usable when the QR is too long to render', async () => {
    // qrcode-terminal throws past its capacity; the flow must still carry the
    // raw URL and reach ready rather than failing the login.
    fake.qrResponses = [
      {
        qrcode: 'qr-1',
        qrcode_img_content: `https://scan.example/${'x'.repeat(4000)}`,
      },
    ];
    fake.statusResponses = [{ status: 'confirmed', bot_token: BOT_TOKEN }];

    const started = record(
      await auth(request(app).post('/auth/weixin/flows')).send({}),
    );

    expect(started.status).toBe(201);
    expect(started.body['qrText']).toBeUndefined();
    expect(String(started.body['qrcodeUrl']).length).toBeGreaterThan(4000);
    const ready = await waitForStatus(
      app,
      started.body['id'] as string,
      'ready',
    );
    expect(ready['status']).toBe('ready');
    for (const body of bodies) expect(body).not.toContain(BOT_TOKEN);
  });

  it('dispose aborts in-flight polling and closes the routes', async () => {
    const started = await auth(request(app).post('/auth/weixin/flows')).send(
      {},
    );
    const id = started.body['id'] as string;
    await waitForStatus(app, id, 'waiting');
    await waitForUpstreamPoll(fake);

    fake.runDispose();

    await expectPollingStopped(fake);
    const start = await auth(request(app).post('/auth/weixin/flows')).send({});
    expect(start.status).toBe(404);
    expect(start.body).toEqual({ code: 'weixin_unavailable' });
    const status = await auth(request(app).get('/auth/weixin'));
    expect(status.body).toMatchObject({ enabled: false });
  });
});

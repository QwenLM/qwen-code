/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { VapidStore } from './webpush/vapid.js';
import { PushStore } from './pushStore.js';
import { SnoozeStore } from './routing/snooze.js';
import { createGatewayApp } from './server.js';
import type { PushNotifier } from './webpush/notifier.js';
import { OWNER, SESSION_READ, APPROVE, WRITE } from './scopes.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function boot(stubOpts?: Parameters<typeof startStubDaemon>[0]): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
  auditPath: string;
  vapid: VapidStore;
  pushStore: PushStore;
  notifier: PushNotifier | undefined;
}> {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
  const auditPath = join(dir, 'audit.log');
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const pairing = new PairingService();
  const vapid = await VapidStore.open(join(dir, 'vapid.json'));
  const pushStore = await PushStore.open(join(dir, 'push.json'));
  const snooze = await SnoozeStore.open(join(dir, 'snooze.state'));
  const { app, notifier } = createGatewayApp({
    daemon,
    store,
    pairing,
    auditPath,
    vapid,
    pushStore,
    snooze,
  }); // `audit` is also returned; boot() does not need it here.
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    pairing,
    store,
    auditPath,
    vapid,
    pushStore,
    notifier,
  };
}

function readAudit(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const body = readFileSync(path, 'utf8').trim();
  return body ? body.split('\n').map((l) => JSON.parse(l)) : [];
}

async function pollAudit(
  path: string,
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2000;
  let rows = readAudit(path);
  while (!predicate(rows) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = readAudit(path);
  }
  return rows;
}

describe('gateway app', () => {
  it('happy path: redeem a code then stream events', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    });
    expect(redeem.status).toBe(200);
    const { token, scopes } = (await redeem.json()) as {
      token: string;
      scopes: string[];
    };
    expect(scopes).toEqual([SESSION_READ]);

    const events = await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(events.status).toBe(200);
    const text = await events.text();
    expect(text).toContain('"text":"one"');
  });

  it('rejects an invalid pairing code with 400', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bogus', label: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('401s the events route without a token', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    expect(res.status).toBe(401);
  });

  it('403s when the token lacks session:read', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([]); // grant no scopes
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'weak' }),
    });
    const { token } = (await redeem.json()) as { token: string };
    const res = await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('revoking a token evicts its open SSE stream', async () => {
    const { url, pairing } = await boot({ holdOpenMs: 5000 });

    const ownerCode = pairing.mint([OWNER, SESSION_READ]);
    const ownerRedeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ownerCode.code, label: 'owner' }),
    });
    const ownerToken = ((await ownerRedeem.json()) as { token: string }).token;

    const victimCode = pairing.mint([SESSION_READ]);
    const victimRedeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: victimCode.code, label: 'victim' }),
    });
    const victim = (await victimRedeem.json()) as { id: string; token: string };

    const ac = new AbortController();
    const stream = await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { Authorization: `Bearer ${victim.token}` },
      signal: ac.signal,
    });
    await stream.body!.getReader().read();

    const del = await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(del.status).toBe(204);

    const deadline = Date.now() + 5000;
    while (!stub!.eventsAbortedByClient && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stub!.eventsAbortedByClient).toBe(true);
    ac.abort();
  });

  it('writes audit lines for redeem and a bad-token request', async () => {
    const { url, pairing, auditPath } = await boot();
    const { code } = pairing.mint([OWNER, SESSION_READ]);
    await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { Authorization: 'Bearer not-a-token' },
    });

    const rows = await pollAudit(
      auditPath,
      (r) =>
        r.some((x) => x.action === 'pairing_redeemed') &&
        r.some((x) => x.action === 'auth_failed'),
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('pairing_redeemed');
    expect(actions).toContain('auth_failed');
    const auditText = readFileSync(auditPath, 'utf8');
    expect(auditText).not.toContain('not-a-token');
    // Structural no-secret guarantee: no bearer material ever lands in audit.
    expect(auditText).not.toContain('Bearer');
  });

  it('serves owner GET /rc/audit with recorded events', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([OWNER, SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/audit`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.some((r) => r.action === 'pairing_redeemed')).toBe(true);
  });

  it('createGatewayApp returns a notifier when push stores are supplied', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const pairing = new PairingService();
    const vapid = await VapidStore.open(join(dir, 'vapid.json'));
    const pushStore = await PushStore.open(join(dir, 'push.json'));

    const withStores = createGatewayApp({
      daemon,
      store,
      pairing,
      vapid,
      pushStore,
    });
    expect(withStores.notifier).toBeDefined();

    const withoutStores = createGatewayApp({ daemon, store, pairing });
    expect(withoutStores.notifier).toBeUndefined();
  });

  it('createGatewayApp returns the audit instance', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const pairing = new PairingService();

    const built = createGatewayApp({ daemon, store, pairing });
    expect(built.audit).toBeDefined();
    expect(typeof built.audit.record).toBe('function');
  });

  it('serves the web viewer at /ui/ without auth', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('qwen-rc viewer');
  });

  it('serves the push service worker at /ui/sw.js without auth', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('serves the enrollment UI at /ui/index.html', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/index.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="enable"');
    expect(body).toContain('sw.js');
  });

  it('404s unknown /ui assets', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ui/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it('routes an approve-scoped permission vote to the daemon', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER, APPROVE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const ownerToken = ((await redeem.json()) as { token: string }).token;

    const mint = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        scopes: [SESSION_READ, APPROVE],
        label: 'approver',
      }),
    });
    expect(mint.status).toBe(200);
    const approveToken = ((await mint.json()) as { token: string }).token;

    const vote = await fetch(`${url}/rc/session/sess-1/permission/req-1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${approveToken}`,
      },
      body: JSON.stringify({ outcome: 'cancelled' }),
    });
    expect(vote.status).toBe(200);
  });

  it('routes a write-scoped prompt to the daemon', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, WRITE]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'writer' }),
    });
    const writeToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeToken}`,
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).stopReason).toBe('end_turn');
  });

  it('403s a prompt from a session:read-only token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const readToken = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/session/s1/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readToken}`,
      },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('serves the push vapid + subscribe round-trip for a session:read token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const vapidRes = await fetch(`${url}/rc/push/vapid`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(vapidRes.status).toBe(200);
    const vapidBody = (await vapidRes.json()) as {
      applicationServerKey: string;
    };
    expect(vapidBody.applicationServerKey.length).toBeGreaterThan(0);

    const sub = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/1',
          keys: { p256dh: 'p', auth: 'a' },
        },
      }),
    });
    expect(sub.status).toBe(201);

    const list = await fetch(`${url}/rc/push/subscriptions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { subscriptions: unknown[] };
    expect(listBody.subscriptions).toHaveLength(1);
  });

  it('owner subscribes then POST /rc/push/test returns 200 {sent:1}', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const sub = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/owner-test',
          keys: { p256dh: 'p', auth: 'a' },
        },
      }),
    });
    expect(sub.status).toBe(201);

    const test = await fetch(`${url}/rc/push/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId: 'sess-test' }),
    });
    expect(test.status).toBe(200);
    const body = (await test.json()) as { sent: number };
    expect(body.sent).toBe(1);
  });

  it('owner can POST /rc/routing/snooze then GET reports active', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ, OWNER]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const post = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ durationSec: 60 }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { until: number; scope: string };
    expect(postBody.scope).toBe('all');

    const get = await fetch(`${url}/rc/routing/snooze`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { active: boolean };
    expect(getBody.active).toBe(true);
  });

  it('403s POST /rc/routing/snooze for a session:read-only token', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]); // no owner
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'reader' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/routing/snooze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ durationSec: 60 }),
    });
    expect(res.status).toBe(403);
  });

  it('403s the push vapid route for a token lacking session:read', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([OWNER]); // owner lacks session:read
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'owner-only' }),
    });
    const token = ((await redeem.json()) as { token: string }).token;

    const res = await fetch(`${url}/rc/push/vapid`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

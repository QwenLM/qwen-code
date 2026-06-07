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
import { createGatewayApp } from './server.js';
import { OWNER, SESSION_READ } from './scopes.js';

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
}> {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
  const auditPath = join(dir, 'audit.log');
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const pairing = new PairingService();
  const app = createGatewayApp({ daemon, store, pairing, auditPath });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, pairing, store, auditPath };
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
    expect(readFileSync(auditPath, 'utf8')).not.toContain('not-a-token');
  });
});

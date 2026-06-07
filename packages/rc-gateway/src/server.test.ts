/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { createGatewayApp } from './server.js';
import { SESSION_READ } from './scopes.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function boot(): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
}> {
  stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const path = join(mkdtempSync(join(tmpdir(), 'rc-srv-')), 'tokens.json');
  const store = await TokenStore.open(path);
  const pairing = new PairingService();
  const app = createGatewayApp({ daemon, store, pairing });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, pairing, store };
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
});

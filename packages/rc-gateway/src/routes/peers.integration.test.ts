/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end proof for `GET /rc/peers`, mounted through the REAL
 * `createGatewayApp` (real TokenStore/PairingService/requireScope(OWNER)
 * mount, real stub daemon over HTTP — though this route never calls the
 * daemon). Mirrors the harness in `policyExplain.integration.test.ts` (the
 * authoritative precedent for `startStubDaemon`/`TokenStore.open`/`.issue`/
 * `createGatewayApp`/server `.listen`). The `browsePeers` dep is stubbed so
 * the test never runs a real ~5s mDNS browse.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { DaemonRecord } from '../mdns/advert.js';
import type { BrowsePeers } from './peers.js';

const REC: DaemonRecord = {
  name: 'work',
  host: '192.168.1.9',
  port: 4123,
  version: '0.17.1',
  tlsRequired: false,
  workspace: 'myrepo',
};

let server: Server | undefined;
let runtimeBase: string;
let stub: StubDaemon | undefined;

async function boot(browsePeers: BrowsePeers) {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-peers-'));
  stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const { token: writer } = await store.issue(['write'], 'w');
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath: join(runtimeBase, 'audit.log'),
    browsePeers,
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/rc/peers`;
  return { owner, writer, url };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  if (runtimeBase) await rm(runtimeBase, { recursive: true, force: true });
});

describe('GET /rc/peers (integration)', () => {
  it('owner gets 200 with the discovered peers', async () => {
    const { owner, url } = await boot(async () => [REC]);
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ peers: [REC] });
  });

  it('503 mdns_unavailable when discovery is unavailable', async () => {
    const { owner, url } = await boot(async () => null);
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe(
      'mdns_unavailable',
    );
  });

  it('rejects a write-scope token with 403', async () => {
    const { writer, url } = await boot(async () => [REC]);
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(r.status).toBe(403);
  });
});

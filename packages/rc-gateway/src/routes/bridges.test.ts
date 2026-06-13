/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { BridgeRegistry } from '../bridges/registry.js';
import {
  createRegisterBridgeRoute,
  createListBridgesRoute,
  createDeregisterBridgeRoute,
  createBanSubActorRoute,
  createLiftBanRoute,
  createListBansRoute,
} from './bridges.js';
import { SubActorBanStore } from '../bridges/subActorBans.js';
import { OWNER, BRIDGE, SESSION_READ } from '../scopes.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

let server: Server | undefined;
let base: string;
let registry: BridgeRegistry;
let audit: ReturnType<typeof fakeAudit>;

/** Mount the bridge routes with a stub that injects a chosen rcClient. */
function mount(client: { id: string; scopes: string[] }) {
  registry = new BridgeRegistry();
  audit = fakeAudit();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = client;
    next();
  });
  let t = 1000;
  app.post(
    '/rc/bridges',
    createRegisterBridgeRoute(registry, audit, () => t++),
  );
  app.get('/rc/bridges', createListBridgesRoute(registry));
  app.delete('/rc/bridges/:id', createDeregisterBridgeRoute(registry, audit));
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      resolve();
    });
  });
}
afterEach(
  () => new Promise<void>((r) => (server ? server.close(() => r()) : r())),
);

async function post(body: unknown) {
  const res = await fetch(`${base}/rc/bridges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

const VALID = {
  id: 'telegram',
  displayName: 'Telegram',
  supportsActions: true,
  supportsMarkdown: true,
  maxMessageBytes: 4096,
};

describe('POST /rc/bridges (register/heartbeat)', () => {
  beforeEach(() => mount({ id: 'tkn-bridge', scopes: [BRIDGE, SESSION_READ] }));

  it('registers a bridge and audits the display name + capabilities', async () => {
    const { status, json } = await post(VALID);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      id: 'telegram',
      displayName: 'Telegram',
      supportsActions: true,
      supportsMarkdown: true,
      maxMessageBytes: 4096,
      tokenId: 'tkn-bridge',
    });
    expect(typeof json.registeredAt).toBe('number');
    expect(registry.get('telegram')?.displayName).toBe('Telegram');
    const rec = audit.calls.find((c) => c.action === 'bridge_registered');
    expect(rec?.target).toBe('telegram');
    expect(rec?.detail).toMatchObject({ displayName: 'Telegram' });
  });

  it('is idempotent on the stable id (re-POST updates + refreshes registeredAt)', async () => {
    const first = await post(VALID);
    const second = await post({ ...VALID, displayName: 'Telegram v2' });
    expect(second.status).toBe(200);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('telegram')?.displayName).toBe('Telegram v2');
    expect(second.json.registeredAt).toBeGreaterThan(first.json.registeredAt);
  });

  it('defaults capability flags to false and clamps maxMessageBytes', async () => {
    const { json } = await post({ id: 'discord', displayName: 'Discord' });
    expect(json.supportsActions).toBe(false);
    expect(json.supportsMarkdown).toBe(false);
    expect(json.maxMessageBytes).toBe(0);
  });

  it('400s an invalid id / display name / maxMessageBytes', async () => {
    expect((await post({ ...VALID, id: 'bad id!' })).status).toBe(400);
    expect((await post({ ...VALID, id: '' })).status).toBe(400);
    expect((await post({ ...VALID, displayName: '' })).status).toBe(400);
    expect((await post({ ...VALID, displayName: 'x\ny' })).status).toBe(400);
    expect((await post({ ...VALID, maxMessageBytes: -1 })).status).toBe(400);
  });
});

describe('POST /rc/bridges cross-token clobber', () => {
  it('409s when a different token claims an id another token registered', async () => {
    await mount({ id: 'tkn-A', scopes: [BRIDGE, SESSION_READ] });
    expect((await post(VALID)).status).toBe(200);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    // Re-mount with a DIFFERENT token but reuse the same registry instance.
    const reg = registry;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = {
        id: 'tkn-B',
        scopes: [BRIDGE, SESSION_READ],
      };
      next();
    });
    app.post('/rc/bridges', createRegisterBridgeRoute(reg));
    server = await new Promise<Server>((resolve) => {
      const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await post(VALID)).status).toBe(409);
  });
});

describe('DELETE /rc/bridges/:id (owner-or-self)', () => {
  it('lets the registering bridge (self) deregister', async () => {
    await mount({ id: 'tkn-bridge', scopes: [BRIDGE, SESSION_READ] });
    await post(VALID);
    const res = await fetch(`${base}/rc/bridges/telegram`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(registry.get('telegram')).toBeUndefined();
  });

  it('lets an OWNER deregister another token’s bridge', async () => {
    // Register under a bridge token, then deregister as an owner token.
    await mount({ id: 'tkn-bridge', scopes: [BRIDGE, SESSION_READ] });
    await post(VALID);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    const reg = registry;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = {
        id: 'tkn-owner',
        scopes: [OWNER, SESSION_READ],
      };
      next();
    });
    app.delete('/rc/bridges/:id', createDeregisterBridgeRoute(reg));
    server = await new Promise<Server>((resolve) => {
      const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/rc/bridges/telegram`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(reg.get('telegram')).toBeUndefined();
  });

  it('403s a different bridge token (not owner, not self)', async () => {
    await mount({ id: 'tkn-bridge', scopes: [BRIDGE, SESSION_READ] });
    await post(VALID);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    const reg = registry;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = {
        id: 'tkn-other',
        scopes: [BRIDGE, SESSION_READ],
      };
      next();
    });
    app.delete('/rc/bridges/:id', createDeregisterBridgeRoute(reg));
    server = await new Promise<Server>((resolve) => {
      const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/rc/bridges/telegram`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(reg.get('telegram')).toBeDefined(); // not removed
  });

  it('404s an unknown bridge id', async () => {
    await mount({ id: 'tkn-owner', scopes: [OWNER, SESSION_READ] });
    const res = await fetch(`${base}/rc/bridges/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('BridgeRegistry', () => {
  it('upserts, lists newest-first, and removes', () => {
    const r = new BridgeRegistry();
    r.register({
      id: 'a',
      tokenId: 't',
      displayName: 'A',
      supportsActions: false,
      supportsMarkdown: false,
      maxMessageBytes: 0,
      registeredAt: 1,
    });
    r.register({
      id: 'b',
      tokenId: 't',
      displayName: 'B',
      supportsActions: false,
      supportsMarkdown: false,
      maxMessageBytes: 0,
      registeredAt: 2,
    });
    expect(r.list().map((x) => x.id)).toEqual(['b', 'a']); // newest first
    expect(r.ownerTokenOf('a')).toBe('t');
    expect(r.remove('a')).toBe(true);
    expect(r.remove('a')).toBe(false);
    expect(r.list().map((x) => x.id)).toEqual(['b']);
  });
});

describe('sub-actor ban routes', () => {
  let bans: SubActorBanStore;
  let banAudit: ReturnType<typeof fakeAudit>;
  let banServer: Server | undefined;
  let banBase: string;

  beforeEach(() => {
    bans = new SubActorBanStore();
    banAudit = fakeAudit();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = {
        id: 'tkn-owner',
        scopes: [OWNER, SESSION_READ],
      };
      next();
    });
    app.get('/rc/bridges/bans', createListBansRoute(bans));
    app.post('/rc/bridges/:id/ban', createBanSubActorRoute(bans, banAudit));
    app.delete(
      '/rc/bridges/:id/ban/:subActor',
      createLiftBanRoute(bans, banAudit),
    );
    return new Promise<void>((resolve) => {
      banServer = app.listen(0, '127.0.0.1', () => {
        banBase = `http://127.0.0.1:${(banServer!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterEach(
    () =>
      new Promise<void>((r) => (banServer ? banServer.close(() => r()) : r())),
  );

  it('bans a sub-actor, lists it, and audits with the bridge id', async () => {
    const ban = await fetch(`${banBase}/rc/bridges/telegram/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subActor: 'telegram:evan' }),
    });
    expect(ban.status).toBe(200);
    expect(bans.isBanned('telegram:evan')).toBe(true);
    const list = await (await fetch(`${banBase}/rc/bridges/bans`)).json();
    expect(list.banned).toEqual(['telegram:evan']);
    const rec = banAudit.calls.find((c) => c.action === 'sub_actor_banned');
    expect(rec?.subActor).toBe('telegram:evan');
    expect(rec?.target).toBe('telegram');
  });

  it('400s a malformed subActor', async () => {
    const res = await fetch(`${banBase}/rc/bridges/telegram/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subActor: 'has space' }),
    });
    expect(res.status).toBe(400);
  });

  it('lifts a ban (204) and 404s lifting an unknown one', async () => {
    bans.ban('telegram:evan');
    const lift = await fetch(
      `${banBase}/rc/bridges/telegram/ban/telegram:evan`,
      { method: 'DELETE' },
    );
    expect(lift.status).toBe(204);
    expect(bans.isBanned('telegram:evan')).toBe(false);
    const again = await fetch(
      `${banBase}/rc/bridges/telegram/ban/telegram:evan`,
      { method: 'DELETE' },
    );
    expect(again.status).toBe(404);
  });
});

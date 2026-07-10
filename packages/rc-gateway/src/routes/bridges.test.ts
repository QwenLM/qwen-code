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
  createMintInviteRoute,
  createRedeemInviteRoute,
  createHeartbeatRoute,
  pruneStaleBridges,
  BRIDGE_STALE_MS,
} from './bridges.js';
import { SubActorBanStore } from '../bridges/subActorBans.js';
import { InviteStore } from '../bridges/inviteStore.js';
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
  supportsMarkdown: 'limited',
  supportsThreads: false,
  supportsEdits: false,
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
      supportsMarkdown: 'limited',
      supportsThreads: false,
      supportsEdits: false,
      maxMessageBytes: 4096,
      tokenId: 'tkn-bridge',
    });
    expect(typeof json.registeredAt).toBe('number');
    expect(json.heartbeatIntervalSec).toBe(60); // spec response field
    expect(registry.get('telegram')?.displayName).toBe('Telegram');
    const rec = audit.calls.find((c) => c.action === 'bridge_registered');
    expect(rec?.target).toBe('telegram');
    expect(rec?.detail).toMatchObject({
      displayName: 'Telegram',
      supportsMarkdown: 'limited',
    });
  });

  it('is idempotent on the stable id (re-POST updates + refreshes registeredAt)', async () => {
    const first = await post(VALID);
    const second = await post({ ...VALID, displayName: 'Telegram v2' });
    expect(second.status).toBe(200);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('telegram')?.displayName).toBe('Telegram v2');
    expect(second.json.registeredAt).toBeGreaterThan(first.json.registeredAt);
  });

  it('defaults capability flags conservatively when message limit is supplied', async () => {
    const { json } = await post({
      id: 'discord',
      displayName: 'Discord',
      maxMessageChars: 2000,
    });
    expect(json.supportsActions).toBe(false);
    expect(json.supportsMarkdown).toBe('none'); // enum default, not boolean
    expect(json.supportsThreads).toBe(false);
    expect(json.supportsEdits).toBe(false);
    expect(json.maxMessageBytes).toBe(0);
    expect(json.maxMessageChars).toBe(2000);
  });

  it('400s capabilities_invalid when neither maxMessageBytes nor maxMessageChars is provided', async () => {
    const { status, json } = await post({
      id: 'discord',
      displayName: 'Discord',
    });
    expect(status).toBe(400);
    expect(json.code).toBe('capabilities_invalid');
  });

  it('accepts maxMessageChars and returns it in the response', async () => {
    const { status, json } = await post({
      ...VALID,
      id: 'discord',
      maxMessageBytes: 0,
      maxMessageChars: 2000,
    });
    expect(status).toBe(200);
    expect(json.maxMessageChars).toBe(2000);
    expect(json.maxMessageBytes).toBe(0);
  });

  it('400s invalid_max_message_chars on a negative value', async () => {
    const r = await post({ ...VALID, maxMessageChars: -1 });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('invalid_max_message_chars');
  });

  it('audits bridge_registration_rejected on a bad registration', async () => {
    await post({ id: 'discord', displayName: 'Discord' }); // no limits → rejected
    const rec = audit.calls.find(
      (c) => c.action === 'bridge_registration_rejected',
    );
    expect(rec).toBeDefined();
    expect(rec?.detail).toMatchObject({ code: 'capabilities_invalid' });
  });

  it('accepts the markdown enum and the thread/edit flags', async () => {
    const { json } = await post({
      ...VALID,
      id: 'discord',
      supportsMarkdown: 'full',
      supportsThreads: true,
      supportsEdits: true,
    });
    expect(json.supportsMarkdown).toBe('full');
    expect(json.supportsThreads).toBe(true);
    expect(json.supportsEdits).toBe(true);
  });

  it('coerces an unrecognized supportsMarkdown (incl. a stale boolean) to none', async () => {
    expect(
      (await post({ ...VALID, supportsMarkdown: true })).json.supportsMarkdown,
    ).toBe('none');
    expect(
      (await post({ ...VALID, supportsMarkdown: 'fancy' })).json
        .supportsMarkdown,
    ).toBe('none');
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
      supportsMarkdown: 'none',
      supportsThreads: false,
      supportsEdits: false,
      maxMessageBytes: 0,
      maxMessageChars: 4096,
      registeredAt: 1,
    });
    r.register({
      id: 'b',
      tokenId: 't',
      displayName: 'B',
      supportsActions: false,
      supportsMarkdown: 'none',
      supportsThreads: false,
      supportsEdits: false,
      maxMessageBytes: 0,
      maxMessageChars: 4096,
      registeredAt: 2,
    });
    expect(r.list().map((x) => x.id)).toEqual(['b', 'a']); // newest first
    expect(r.ownerTokenOf('a')).toBe('t');
    expect(r.remove('a')).toBe(true);
    expect(r.remove('a')).toBe(false);
    expect(r.list().map((x) => x.id)).toEqual(['b']);
  });

  it('touch refreshes registeredAt; pruneStale drops the missed-heartbeat ones', () => {
    const r = new BridgeRegistry();
    const mk = (id: string, at: number) =>
      r.register({
        id,
        tokenId: 't',
        displayName: id,
        supportsActions: false,
        supportsMarkdown: 'none',
        supportsThreads: false,
        supportsEdits: false,
        maxMessageBytes: 0,
        maxMessageChars: 4096,
        registeredAt: at,
      });
    mk('fresh', 1000);
    mk('stale', 1000);
    expect(r.touch('fresh', 115_000)).toBe(true); // a heartbeat lands
    expect(r.touch('nope', 115_000)).toBe(false); // unknown id
    // staleMs window 10s relative to now=120000: 'stale' (last 1000) is gone,
    // 'fresh' (touched at 115000 → 5s ago) survives.
    const removed = r.pruneStale(120_000, 10_000);
    expect(removed).toEqual(['stale']);
    expect(r.get('fresh')).toBeDefined();
    expect(r.get('stale')).toBeUndefined();
  });
});

describe('pruneStaleBridges (reaper helper)', () => {
  it('removes stale bridges and audits each bridge_stale_deregistered', () => {
    const r = new BridgeRegistry();
    const audit = fakeAudit();
    r.register({
      id: 'dead',
      tokenId: 't',
      displayName: 'dead',
      supportsActions: false,
      supportsMarkdown: 'none',
      supportsThreads: false,
      supportsEdits: false,
      maxMessageBytes: 0,
      maxMessageChars: 4096,
      registeredAt: 0,
    });
    const removed = pruneStaleBridges(r, BRIDGE_STALE_MS + 1, audit);
    expect(removed).toEqual(['dead']);
    expect(
      audit.calls.find((c) => c.action === 'bridge_stale_deregistered')?.target,
    ).toBe('dead');
  });
});

describe('POST /rc/bridges/:id/heartbeat', () => {
  let hbServer: Server | undefined;
  let hbBase: string;
  let reg: BridgeRegistry;
  let hbAudit: ReturnType<typeof fakeAudit>;

  function mountHb(client: { id: string; scopes: string[] }, t = 5000) {
    reg = new BridgeRegistry();
    hbAudit = fakeAudit();
    reg.register({
      id: 'telegram',
      tokenId: 'tkn-bridge',
      displayName: 'Telegram',
      supportsActions: true,
      supportsMarkdown: 'limited',
      supportsThreads: false,
      supportsEdits: false,
      maxMessageBytes: 4096,
      maxMessageChars: 0,
      registeredAt: 1,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = client;
      next();
    });
    app.post(
      '/rc/bridges/:id/heartbeat',
      createHeartbeatRoute(reg, hbAudit, () => t),
    );
    return new Promise<void>((resolve) => {
      hbServer = app.listen(0, '127.0.0.1', () => {
        hbBase = `http://127.0.0.1:${(hbServer!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }
  afterEach(
    () =>
      new Promise<void>((r) => (hbServer ? hbServer.close(() => r()) : r())),
  );

  const beat = (id: string) =>
    fetch(`${hbBase}/rc/bridges/${id}/heartbeat`, { method: 'POST' });

  it('self refreshes registeredAt and returns the interval', async () => {
    await mountHb({ id: 'tkn-bridge', scopes: [BRIDGE, SESSION_READ] }, 5000);
    const res = await beat('telegram');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      id: 'telegram',
      registeredAt: 5000,
      heartbeatIntervalSec: 60,
    });
    expect(reg.get('telegram')?.registeredAt).toBe(5000);
  });

  it('404s an unknown bridge and audits bridge_heartbeat_unknown', async () => {
    await mountHb({ id: 'tkn-bridge', scopes: [BRIDGE, SESSION_READ] });
    const res = await beat('ghost');
    expect(res.status).toBe(404);
    expect(
      hbAudit.calls.some((c) => c.action === 'bridge_heartbeat_unknown'),
    ).toBe(true);
  });

  it('403s a different bridge token (not owner, not self)', async () => {
    await mountHb({ id: 'tkn-other', scopes: [BRIDGE, SESSION_READ] });
    const res = await beat('telegram');
    expect(res.status).toBe(403);
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
      body: JSON.stringify({ subActor: 'telegram:alice' }),
    });
    expect(ban.status).toBe(200);
    expect(bans.isBanned('telegram:alice')).toBe(true);
    const list = await (await fetch(`${banBase}/rc/bridges/bans`)).json();
    expect(list.banned).toEqual(['telegram:alice']);
    const rec = banAudit.calls.find((c) => c.action === 'sub_actor_banned');
    expect(rec?.subActor).toBe('telegram:alice');
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
    bans.ban('telegram:alice');
    const lift = await fetch(
      `${banBase}/rc/bridges/telegram/ban/telegram:alice`,
      { method: 'DELETE' },
    );
    expect(lift.status).toBe(204);
    expect(bans.isBanned('telegram:alice')).toBe(false);
    const again = await fetch(
      `${banBase}/rc/bridges/telegram/ban/telegram:alice`,
      { method: 'DELETE' },
    );
    expect(again.status).toBe(404);
  });
});

describe('invite routes (mint + redeem)', () => {
  let invites: InviteStore;
  let invAudit: ReturnType<typeof fakeAudit>;
  let invServer: Server | undefined;
  let invBase: string;

  beforeEach(() => {
    invites = new InviteStore();
    invAudit = fakeAudit();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = {
        id: 'tkn-owner',
        scopes: [OWNER, BRIDGE, SESSION_READ],
      };
      next();
    });
    app.post('/rc/bridges/invites', createMintInviteRoute(invites, invAudit));
    app.post(
      '/rc/bridges/:id/invite/redeem',
      createRedeemInviteRoute(invites, invAudit),
    );
    return new Promise<void>((resolve) => {
      invServer = app.listen(0, '127.0.0.1', () => {
        invBase = `http://127.0.0.1:${(invServer!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterEach(
    () =>
      new Promise<void>((r) => (invServer ? invServer.close(() => r()) : r())),
  );

  async function mint(body: unknown) {
    const res = await fetch(`${invBase}/rc/bridges/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: await res.json().catch(() => undefined),
    };
  }
  async function redeem(id: string, body: unknown) {
    const res = await fetch(`${invBase}/rc/bridges/${id}/invite/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: await res.json().catch(() => undefined),
    };
  }

  it('mints an inv_ token, audits the kind + session, NEVER logs the token', async () => {
    const { status, json } = await mint({
      kind: 'telegram',
      sessionId: 'sess_42',
    });
    expect(status).toBe(200);
    expect(json.token.startsWith('inv_')).toBe(true);
    expect(json).toMatchObject({ kind: 'telegram', sessionId: 'sess_42' });
    expect(typeof json.expiresAt).toBe('number');
    const rec = invAudit.calls.find((c) => c.action === 'bridge_invite_minted');
    expect(rec?.target).toBe('sess_42');
    expect(rec?.detail).toMatchObject({ kind: 'telegram' });
    // the one-time secret must not appear anywhere in the audit row
    expect(JSON.stringify(rec)).not.toContain(json.token);
  });

  it('400s an invalid kind or sessionId', async () => {
    expect((await mint({ kind: 'irc', sessionId: 's' })).status).toBe(400);
    expect((await mint({ kind: 'telegram', sessionId: '' })).status).toBe(400);
    expect((await mint({ kind: 'telegram', sessionId: 'a\nb' })).status).toBe(
      400,
    );
  });

  it('redeems a minted token to its session and audits with the bridge id', async () => {
    const { json } = await mint({ kind: 'discord', sessionId: 'sess_9' });
    const r = await redeem('discord', { token: json.token });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ sessionId: 'sess_9', kind: 'discord' });
    const rec = invAudit.calls.find(
      (c) => c.action === 'bridge_invite_redeemed',
    );
    expect(rec?.target).toBe('sess_9');
    expect(rec?.detail).toMatchObject({ kind: 'discord', bridgeId: 'discord' });
  });

  it('is single-use: a second redeem 400s with the spec error text', async () => {
    const { json } = await mint({ kind: 'matrix', sessionId: 'sess_x' });
    expect((await redeem('matrix', { token: json.token })).status).toBe(200);
    const second = await redeem('matrix', { token: json.token });
    expect(second.status).toBe(400);
    expect(second.json.error).toBe('Invalid or expired invite token');
    expect(
      invAudit.calls.some((c) => c.action === 'bridge_invite_redeem_failed'),
    ).toBe(true);
  });

  it('does NOT gate on kind — a telegram invite redeems via any bridge id', async () => {
    const { json } = await mint({ kind: 'telegram', sessionId: 'sess_k' });
    // redeemed through a bridge whose id differs from the invite kind: allowed.
    const r = await redeem('my-custom-bridge', { token: json.token });
    expect(r.status).toBe(200);
    expect(r.json.sessionId).toBe('sess_k');
  });

  it('400s an unknown / missing token with the spec error text', async () => {
    expect((await redeem('telegram', { token: 'inv_nope' })).status).toBe(400);
    const r = await redeem('telegram', {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('Invalid or expired invite token');
  });
});

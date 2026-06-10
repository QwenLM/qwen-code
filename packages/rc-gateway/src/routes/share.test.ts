/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { TokenStore } from '../tokenStore.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
import { SHARE, SESSION_READ, APPROVE } from '../scopes.js';
import { createShareRouter, createShareWhoamiHandler } from './share.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

let server: Server | undefined;
let store: TokenStore;
let registry: ConnectionRegistry & { evicted: string[] };
let audit: AuditRecorder & { calls: AuditEntry[] };

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rc-share-')), 'tokens.json');
  store = await TokenStore.open(path);
  const reg = new ConnectionRegistry() as ConnectionRegistry & {
    evicted: string[];
  };
  reg.evicted = [];
  const origEvict = reg.evict.bind(reg);
  reg.evict = (id: string) => {
    reg.evicted.push(id);
    origEvict(id);
  };
  registry = reg;
  audit = fakeAudit();
});

/** Mount the share router behind a stub that injects an OWNER rcClient. */
async function mount(): Promise<string> {
  const inject: RequestHandler = (req, _res, next) => {
    req.rcClient = { id: 'owner-1', scopes: ['owner'] };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(inject);
  app.use('/rc/share', createShareRouter(store, registry, audit));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('/rc/share routes', () => {
  it('POST view share → 201 {id,token,url,expiresAt} + share_created audit', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600, label: 'guest' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      token: string;
      url: string;
      expiresAt: number;
    };
    expect(typeof body.id).toBe('string');
    expect(typeof body.token).toBe('string');
    expect(body.url).toBe('/ui/share/' + body.token);
    expect(typeof body.expiresAt).toBe('number');

    // Issued token resolves with view scopes + the session lock.
    expect(store.resolve(`Bearer ${body.token}`)).toMatchObject({
      id: body.id,
      scopes: [SHARE, SESSION_READ],
      sessionLockId: 's1',
    });

    const created = audit.calls.find((c) => c.action === 'share_created');
    expect(created).toBeDefined();
    // Top-level shareId/shareLabel for the --share-id audit filter (L4).
    expect(created!.shareId).toBe(body.id);
    expect(created!.shareLabel).toBe('guest');
    expect(created!.detail).toMatchObject({
      shareId: body.id,
      sessionId: 's1',
      scope: 'view',
      label: 'guest',
    });
    // Never leaks the token or a hash.
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain(body.token);
    expect(serialized).not.toContain('tokenHash');
  });

  it('POST approve share → token resolves WITH approve scope', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600, scope: 'approve' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    expect(store.resolve(`Bearer ${body.token}`)?.scopes).toEqual([
      SHARE,
      SESSION_READ,
      APPROVE,
    ]);
  });

  it('POST with missing sessionId → 400 invalid_share', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlSec: 3600 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_share');
  });

  it('POST with ttlSec 0 → 400 invalid_share', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 0 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_share');
  });

  it('GET lists issued shares', async () => {
    const url = await mount();
    await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600 }),
    });
    const res = await fetch(`${url}/rc/share`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shares: Array<{ sessionLockId: string }>;
    };
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0].sessionLockId).toBe('s1');
  });

  it('DELETE → 204 + share_revoked audit + registry.evict called', async () => {
    const url = await mount();
    const created = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: 3600 }),
    });
    const { id } = (await created.json()) as { id: string };
    const res = await fetch(`${url}/rc/share/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(registry.evicted).toContain(id);
    expect(store.listShares()).toHaveLength(0);
    const revoked = audit.calls.find((c) => c.action === 'share_revoked');
    expect(revoked).toBeDefined();
    expect(revoked!.shareId).toBe(id);
    expect(revoked!.shareLabel).toBe('share'); // default label
    expect(revoked!.detail).toMatchObject({ shareId: id });
  });

  it('DELETE an unknown share id → 404', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share/does-not-exist`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('POST with maxUses persists a clamped value; out-of-range clamps to [1,100]', async () => {
    const url = await mount();
    const mk = (maxUses: unknown) =>
      fetch(`${url}/rc/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', ttlSec: 3600, maxUses }),
      });
    await mk(5);
    await mk(500); // clamps to 100
    await mk(0); // clamps to 1
    const shares = store.listShares();
    const byMax = shares.map((s) => s.maxUses).sort((a, b) => a! - b!);
    expect(byMax).toEqual([1, 5, 100]);
    const created = audit.calls.find((c) => c.action === 'share_created');
    expect(created!.detail).toMatchObject({ maxUses: 5 });
  });

  // A returned expiresAt minus "now" should be ~the granted TTL; the test runs
  // in well under a second, so a generous tolerance absorbs the elapsed ms.
  const mintTtl = async (url: string, ttlSec: unknown): Promise<number> => {
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec }),
    });
    expect(res.status).toBe(201);
    const { expiresAt } = (await res.json()) as { expiresAt: number };
    return expiresAt - Date.now();
  };

  it('clamps a huge ttlSec down to 30 days (2592000s)', async () => {
    const url = await mount();
    const remaining = await mintTtl(url, 999_999_999);
    expect(remaining).toBeLessThanOrEqual(2_592_000_000);
    expect(remaining).toBeGreaterThan(2_592_000_000 - 5_000);
    const created = audit.calls.find((c) => c.action === 'share_created');
    expect(created!.detail).toMatchObject({ ttlSec: 2_592_000 });
  });

  it('floors a tiny positive ttlSec up to 5 minutes (300s)', async () => {
    const url = await mount();
    const remaining = await mintTtl(url, 5);
    expect(remaining).toBeLessThanOrEqual(300_000);
    expect(remaining).toBeGreaterThan(300_000 - 5_000);
    const created = audit.calls.find((c) => c.action === 'share_created');
    expect(created!.detail).toMatchObject({ ttlSec: 300 });
  });

  it('passes an in-range ttlSec through unchanged', async () => {
    const url = await mount();
    const remaining = await mintTtl(url, 3600);
    expect(remaining).toBeLessThanOrEqual(3_600_000);
    expect(remaining).toBeGreaterThan(3_600_000 - 5_000);
    const created = audit.calls.find((c) => c.action === 'share_created');
    expect(created!.detail).toMatchObject({ ttlSec: 3600 });
  });

  it('a negative ttlSec is still rejected (400, not clamped)', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: -10 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_share');
  });

  it('a non-number ttlSec is still rejected (400, not clamped)', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', ttlSec: '3600' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_share');
  });
});

/** Mount the whoami redemption handler behind a stub injecting a share client. */
async function mountWhoami(client: {
  id: string;
  scopes: string[];
  sessionLockId?: string;
}): Promise<string> {
  const inject: RequestHandler = (req, _res, next) => {
    req.rcClient = client;
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(inject);
  app.get('/rc/share/whoami', createShareWhoamiHandler(store, audit));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /rc/share/whoami (redemption)', () => {
  it('first redemption → 200 metadata, bumps a use, sets a cookie, audits share_redeemed', async () => {
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
      maxUses: 2,
    });
    const url = await mountWhoami({
      id: share.id,
      scopes: [SHARE, SESSION_READ, APPROVE],
      sessionLockId: 's1',
    });
    const res = await fetch(`${url}/rc/share/whoami`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      scope: string;
      label: string;
      usesRemaining: number;
    };
    expect(body).toMatchObject({
      sessionId: 's1',
      scope: 'approve',
      label: 'guest',
      usesRemaining: 1,
    });
    expect(res.headers.get('set-cookie')).toContain('rc_share_' + share.id);
    expect(store.listShares()[0].uses).toBe(1);
    const redeemed = audit.calls.find((c) => c.action === 'share_redeemed');
    expect(redeemed!.shareId).toBe(share.id);
    expect(redeemed!.shareLabel).toBe('guest');
    expect(redeemed!.detail).toMatchObject({ shareId: share.id });
  });

  it('a refresh carrying the redemption cookie does NOT bump again', async () => {
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
      maxUses: 5,
    });
    const url = await mountWhoami({
      id: share.id,
      scopes: [SHARE, SESSION_READ],
      sessionLockId: 's1',
    });
    const first = await fetch(`${url}/rc/share/whoami`);
    // Node fetch has NO cookie jar — forward Set-Cookie by hand or the test
    // would pass vacuously (the cookie would never arrive on call 2).
    const cookie = first.headers.get('set-cookie')!;
    expect(store.listShares()[0].uses).toBe(1);

    const second = await fetch(`${url}/rc/share/whoami`, {
      headers: { Cookie: cookie },
    });
    expect(second.status).toBe(200);
    // No second bump: still 1 use consumed.
    expect(store.listShares()[0].uses).toBe(1);
    expect(
      audit.calls.filter((c) => c.action === 'share_redeemed'),
    ).toHaveLength(1);
  });

  it('a fresh browser session after exhaustion → 410 share_exhausted + audit', async () => {
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
      maxUses: 1,
    });
    const url = await mountWhoami({
      id: share.id,
      scopes: [SHARE, SESSION_READ],
      sessionLockId: 's1',
    });
    const first = await fetch(`${url}/rc/share/whoami`);
    expect(first.status).toBe(200);
    // A SECOND, cookie-less request models a different browser opening the link.
    const second = await fetch(`${url}/rc/share/whoami`);
    expect(second.status).toBe(410);
    expect(((await second.json()) as { code: string }).code).toBe(
      'share_exhausted',
    );
    const exhausted = audit.calls.find((c) => c.action === 'share_exhausted');
    expect(exhausted).toBeDefined();
    expect(exhausted!.shareId).toBe(share.id);
    expect(exhausted!.shareLabel).toBe('guest');

    // The already-redeemed session keeps working (its cookie still honored).
    const stillOk = await fetch(`${url}/rc/share/whoami`, {
      headers: { Cookie: first.headers.get('set-cookie')! },
    });
    expect(stillOk.status).toBe(200);
  });

  it('an unlimited share (no maxUses) returns usesRemaining null and never exhausts', async () => {
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    const url = await mountWhoami({
      id: share.id,
      scopes: [SHARE, SESSION_READ],
      sessionLockId: 's1',
    });
    const res = await fetch(`${url}/rc/share/whoami`);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { usesRemaining: number | null }).usesRemaining,
    ).toBeNull();
  });
});

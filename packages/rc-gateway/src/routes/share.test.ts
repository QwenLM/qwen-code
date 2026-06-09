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
import { createShareRouter } from './share.js';
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
    expect(revoked!.detail).toMatchObject({ shareId: id });
  });

  it('DELETE an unknown share id → 404', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/share/does-not-exist`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

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
import { TokenStore } from '../tokenStore.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
import { bearerResolve, requireScope } from '../auth.js';
import { OWNER, SESSION_READ } from '../scopes.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './tokens.js';

let server: Server | undefined;
let store: TokenStore;
let registry: ConnectionRegistry;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rc-tok-')), 'tokens.json');
  store = await TokenStore.open(path);
  registry = new ConnectionRegistry();
});

async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store));
  app.get('/rc/tokens', requireScope(OWNER), createListTokensRoute(store));
  app.post('/rc/tokens', requireScope(OWNER), createMintTokenRoute(store));
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER),
    createRevokeTokenRoute(store, registry),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('/rc/tokens routes', () => {
  it('GET lists tokens for an owner (metadata only)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });

  it('GET is forbidden for a session:read-only token', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(res.status).toBe(403);
  });

  it('POST mints a scoped token an owner is allowed to grant', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ], label: 'minted' }),
    });
    expect(res.status).toBe(200);
    const { token, scopes } = (await res.json()) as {
      token: string;
      scopes: string[];
    };
    expect(scopes).toEqual([SESSION_READ]);
    expect(store.resolve(`Bearer ${token}`)).not.toBeNull();
  });

  it('POST rejects an unknown scope with 400', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: ['session:write'] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST clamps: cannot grant a scope the caller lacks', async () => {
    const owner = await store.issue([OWNER], 'owner-no-read');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ] }),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE revokes a token (204) and evicts its registered streams', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const victim = await store.issue([SESSION_READ], 'victim');
    const ctrl = new AbortController();
    registry.register(victim.id, ctrl);
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(204);
    expect(ctrl.signal.aborted).toBe(true);
    expect(store.resolve(`Bearer ${victim.token}`)).toBeNull();
  });

  it('DELETE an unknown id returns 404', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/nope`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(404);
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativePushRouter, createAssetLinksRoute } from './nativePush.js';
import { ApnsStore } from '../nativePush/apnsStore.js';

let dir: string;
let store: ApnsStore;
let server: import('node:http').Server | undefined;

async function mount(client: { id: string; scopes: string[] }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = client;
    next();
  });
  app.use('/rc/native-push/apns', createNativePushRouter(store));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  server = s;
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rc-np-'));
  store = await ApnsStore.open(join(dir, 'apns.json'), () => 1000);
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

// A realistic APNs device token: 64 hex chars (32-byte classic token).
const REALISTIC_DEVICE_TOKEN = '0123456789abcdef'.repeat(4);

const reg = (over = {}) => ({
  deviceToken: REALISTIC_DEVICE_TOKEN,
  bundleId: 'dev.qwen.rc',
  shellVersion: '1.0.0',
  ...over,
});

describe('POST /rc/native-push/apns/register', () => {
  it('stores a subscription and returns 201 with its id', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reg()),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string };
    expect(body.id).toBeTruthy();
    expect(store.listAll()).toHaveLength(1);
    expect(store.listAll()[0].tokenId).toBe('tkn_a');
  });

  it('upserts: a second register for the same device token does not duplicate', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const first = await (
      await fetch(`${base}/rc/native-push/apns/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reg()),
      })
    ).json();
    const second = await (
      await fetch(`${base}/rc/native-push/apns/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reg({ shellVersion: '1.1.0' })),
      })
    ).json();
    expect((second as { id: string }).id).toBe((first as { id: string }).id);
    expect(store.listAll()).toHaveLength(1);
  });

  it('400s a registration missing required fields', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceToken: 'x' }),
    });
    expect(r.status).toBe(400);
  });

  it('accepts a realistic 64-hex-char device token (does not over-reject a real APNs token)', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reg()),
    });
    expect(r.status).toBe(201);
  });

  it('400s a deviceToken that is not hex (charset guard before it reaches the APNs :path)', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        reg({ deviceToken: 'not-a-hex-token'.padEnd(64, 'z') }),
      ),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { code?: string };
    expect(body.code).toBe('invalid_registration');
  });

  it('400s a deviceToken with control/injection characters (e.g. CRLF toward the :path)', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        reg({ deviceToken: `${REALISTIC_DEVICE_TOKEN}\r\n:evil-path` }),
      ),
    });
    expect(r.status).toBe(400);
  });

  it('400s an absurdly long deviceToken', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reg({ deviceToken: 'a'.repeat(500) })),
    });
    expect(r.status).toBe(400);
  });

  it('400s a bundleId with a control character', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reg({ bundleId: 'dev.qwen.rc\r\nInjected: 1' })),
    });
    expect(r.status).toBe(400);
  });

  it('400s an overlong bundleId', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reg({ bundleId: 'a'.repeat(300) })),
    });
    expect(r.status).toBe(400);
  });

  it('400s a shellVersion with an unsafe character', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const r = await fetch(`${base}/rc/native-push/apns/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reg({ shellVersion: '1.0.0 <script>' })),
    });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /rc/native-push/apns/register/:id', () => {
  it('lets a token delete its own subscription', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const rec = await store.register({
      tokenId: 'tkn_a',
      deviceToken: 'd',
      bundleId: 'b',
      shellVersion: '1',
    });
    const r = await fetch(`${base}/rc/native-push/apns/register/${rec.id}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(204);
    expect(store.listAll()).toHaveLength(0);
  });

  it('404s a non-owner deleting another token subscription (no existence leak)', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['session:read'] });
    const rec = await store.register({
      tokenId: 'someone_else',
      deviceToken: 'd',
      bundleId: 'b',
      shellVersion: '1',
    });
    const r = await fetch(`${base}/rc/native-push/apns/register/${rec.id}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(404);
    expect(store.listAll()).toHaveLength(1); // untouched
  });

  it('lets an owner delete any subscription', async () => {
    const base = await mount({ id: 'owner_tok', scopes: ['owner'] });
    const rec = await store.register({
      tokenId: 'someone_else',
      deviceToken: 'd',
      bundleId: 'b',
      shellVersion: '1',
    });
    const r = await fetch(`${base}/rc/native-push/apns/register/${rec.id}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(204);
    expect(store.listAll()).toHaveLength(0);
  });

  it('404s an unknown id', async () => {
    const base = await mount({ id: 'tkn_a', scopes: ['owner'] });
    const r = await fetch(`${base}/rc/native-push/apns/register/nope`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(404);
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  async function mountLinks(
    getLinks: () => Array<Record<string, unknown>> | null,
  ) {
    const app = express();
    app.get('/.well-known/assetlinks.json', createAssetLinksRoute(getLinks));
    const s = app.listen(0);
    await new Promise((r) => s.once('listening', r));
    server = s;
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it('serves the asset statement (public, no auth) when configured', async () => {
    const links = [{ relation: ['x'], target: { namespace: 'android_app' } }];
    const base = await mountLinks(() => links);
    const r = await fetch(`${base}/.well-known/assetlinks.json`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(links);
  });

  it('404s when no TWA is configured (shell falls back to Custom Tab)', async () => {
    const base = await mountLinks(() => null);
    const r = await fetch(`${base}/.well-known/assetlinks.json`);
    expect(r.status).toBe(404);
  });
});

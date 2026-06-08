/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RcScope } from '../scopes.js';
import { OWNER, SESSION_READ } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { VapidStore } from '../webpush/vapid.js';
import { PushStore } from '../pushStore.js';
import { createPushRouter } from './push.js';

let server: Server | undefined;
let vapid: VapidStore;
let store: PushStore;
let audit: AuditRecorder & { calls: AuditEntry[] };
let client: { id: string; scopes: RcScope[] };

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-pushroute-'));
  vapid = await VapidStore.open(join(dir, 'vapid.json'));
  store = await PushStore.open(join(dir, 'push.json'));
  audit = fakeAudit();
  client = { id: 'tokA', scopes: [SESSION_READ] };
});

async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = client;
    next();
  });
  app.use('/rc/push', createPushRouter(vapid, store, audit));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const VALID_SUB = {
  endpoint: 'https://push.example.com/secret-endpoint-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

describe('push routes', () => {
  it('GET /vapid returns the application server key', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/vapid`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applicationServerKey: string };
    expect(body.applicationServerKey).toBe(vapid.getApplicationServerKey());
  });

  it('POST /subscribe with a valid subscription returns 201 and audits', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: VALID_SUB }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();
    expect(store.get(id)).toBeDefined();

    const sub = audit.calls.find((c) => c.action === 'push_subscribed');
    expect(sub).toBeDefined();
    expect(sub!.detail).toEqual({ subscriptionId: id });
    // The endpoint (a sensitive capability URL) must never reach the audit log.
    expect(JSON.stringify(audit.calls)).not.toContain(VALID_SUB.endpoint);
  });

  it('POST /subscribe with a malformed body (missing keys.auth) returns 400', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/x',
          keys: { p256dh: 'p' },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_subscription');
  });

  it('GET /subscriptions lists only the callers own', async () => {
    const url = await mount();
    await store.add('tokA', VALID_SUB);
    await store.add('tokB', {
      endpoint: 'https://push.example.com/other',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const res = await fetch(`${url}/rc/push/subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; tokenId?: string }>;
    };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].tokenId).toBeUndefined();
  });

  it('GET /subscriptions?all=true requires owner (403 for non-owner)', async () => {
    const url = await mount();
    await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions?all=true`);
    expect(res.status).toBe(403);
  });

  it('GET /subscriptions?all=true as owner returns all with tokenId', async () => {
    client = { id: 'admin', scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    await store.add('tokA', VALID_SUB);
    await store.add('tokB', {
      endpoint: 'https://push.example.com/other',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const res = await fetch(`${url}/rc/push/subscriptions?all=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; tokenId: string }>;
    };
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions.map((s) => s.tokenId).sort()).toEqual([
      'tokA',
      'tokB',
    ]);
  });

  it('DELETE own subscription returns 204 and audits without the endpoint', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(store.get(rec.id)).toBeUndefined();
    const un = audit.calls.find((c) => c.action === 'push_unsubscribed');
    expect(un).toBeDefined();
    expect(un!.detail).toEqual({ subscriptionId: rec.id });
    expect(JSON.stringify(audit.calls)).not.toContain(VALID_SUB.endpoint);
  });

  it('DELETE another tokens subscription as non-owner returns 404 (hide existence)', async () => {
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(store.get(rec.id)).toBeDefined();
  });

  it('DELETE another tokens subscription as owner returns 204', async () => {
    client = { id: 'admin', scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(store.get(rec.id)).toBeUndefined();
  });

  it('DELETE an unknown id returns 404', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscriptions/nope`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

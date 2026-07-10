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
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { TokenStore } from '../tokenStore.js';
import { bearerResolve, requireScope } from '../auth.js';
import { APPROVE, SESSION_READ, SHARE } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createPermissionVoteRoute } from './permission.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;
let store: TokenStore;
let audit: AuditRecorder & { calls: AuditEntry[] };

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

beforeEach(async () => {
  store = await TokenStore.open(
    join(mkdtempSync(join(tmpdir(), 'rc-perm-')), 'tokens.json'),
  );
  audit = fakeAudit();
});

async function mount(daemon: DaemonClient): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store, audit));
  app.post(
    '/session/:id/permission/:requestId',
    requireScope(APPROVE, audit),
    createPermissionVoteRoute(daemon, audit),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postVote(
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${url}/session/sess-1/permission/req-1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('permission vote route', () => {
  it('accepts a selected vote with an approve token (200)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([SESSION_READ, APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, {
      outcome: 'selected',
      optionId: 'allow',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
    const voted = audit.calls.find((c) => c.action === 'permission_voted');
    expect(voted).toBeDefined();
    expect(voted!.detail).toMatchObject({
      requestId: 'req-1',
      accepted: true,
      // A human vote is always the 'client' decision_source (cycle 39).
      decisionSource: 'client',
    });
  });

  it('tags the permission_voted row with shareId+shareLabel for a guest', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ, APPROVE],
      label: 'review for Sam',
      sessionLockId: 'sess-1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    const url = await mount(daemon);
    await postVote(url, share.token, {
      outcome: 'selected',
      optionId: 'allow',
    });
    const voted = audit.calls.find((c) => c.action === 'permission_voted');
    expect(voted!.shareId).toBe(share.id);
    expect(voted!.shareLabel).toBe('review for Sam');
  });

  it('leaves shareId/shareLabel unset for a normal (non-share) token', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    await postVote(url, token, { outcome: 'selected', optionId: 'allow' });
    const voted = audit.calls.find((c) => c.action === 'permission_voted');
    expect(voted!.shareId).toBeUndefined();
    expect(voted!.shareLabel).toBeUndefined();
  });

  it('accepts a cancelled vote (200)', async () => {
    stub = await startStubDaemon({ permissionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, { outcome: 'cancelled' });
    expect(res.status).toBe(200);
  });

  it('400s an invalid vote (selected without optionId)', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, { outcome: 'selected' });
    expect(res.status).toBe(400);
  });

  it('403s a token without approve scope', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([SESSION_READ], 'phone');
    const url = await mount(daemon);
    const res = await postVote(url, token, {
      outcome: 'selected',
      optionId: 'allow',
    });
    expect(res.status).toBe(403);
  });

  it('404s when the daemon has no pending request', async () => {
    stub = await startStubDaemon({ permissionStatus: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const { token } = await store.issue([APPROVE], 'owner');
    const url = await mount(daemon);
    const res = await postVote(url, token, { outcome: 'cancelled' });
    expect(res.status).toBe(404);
  });
});

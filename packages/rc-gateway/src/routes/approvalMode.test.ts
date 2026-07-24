/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { WRITE } from '../scopes.js';

const SESSION_ID = 's1';

let server: Server | undefined;
let runtimeBase: string;
let auditPath: string;
let stub: StubDaemon | undefined;

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-approval-mode-'));
  auditPath = join(runtimeBase, 'audit.log');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

interface Ctx {
  baseUrl: string;
  stub: StubDaemon;
  writeToken: string;
  ownerToken: string;
  store: TokenStore;
}

async function setup(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
): Promise<Ctx> {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: writeToken } = await store.issue(['write'], 'w');
  const { token: ownerToken } = await store.issue(['owner'], 'o');

  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath,
  });

  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stub,
    writeToken,
    ownerToken,
    store,
  };
}

function post(baseUrl: string, token: string, body: unknown) {
  return fetch(`${baseUrl}/session/${SESSION_ID}/approval-mode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /session/:id/approval-mode', () => {
  it('write token sets plan → 200', async () => {
    const ctx = await setup({
      approvalModeResult: {
        mode: 'plan',
        previous: 'default',
        persisted: false,
      },
    });
    const res = await post(ctx.baseUrl, ctx.writeToken, { mode: 'plan' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      sessionId: SESSION_ID,
      mode: 'plan',
      previous: 'default',
      persisted: false,
      planExitedOutOfBand: false,
    });
  });

  it('write token + auto → 403 owner_scope_required (no daemon call)', async () => {
    const ctx = await setup();
    const res = await post(ctx.baseUrl, ctx.writeToken, { mode: 'auto' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('owner_scope_required');
    expect(ctx.stub.lastApprovalModeBody).toBeUndefined();
  });

  it('write token + persist:true → 403 owner_scope_required', async () => {
    const ctx = await setup();
    const res = await post(ctx.baseUrl, ctx.writeToken, {
      mode: 'plan',
      persist: true,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('owner_scope_required');
    expect(ctx.stub.lastApprovalModeBody).toBeUndefined();
  });

  it('a session-locked write share token is 403d on a DIFFERENT session (session_locked, no daemon call)', async () => {
    // Guards against a session-locked share token (write scope, locked to
    // "other-session") reaching an approval-mode change on SESSION_ID
    // ("s1") — cross-session integrity: enforceSessionLock must run on this
    // mount exactly as it does on the sibling fork/rewind mounts.
    const ctx = await setup();
    const share = await ctx.store.issueShare({
      scopes: [WRITE],
      label: 'locked-guest',
      sessionLockId: 'other-session',
      ttlSec: 3600,
      parentId: 'owner-token-id',
    });
    const res = await post(ctx.baseUrl, share.token, { mode: 'plan' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('session_locked');
    expect(ctx.stub.lastApprovalModeBody).toBeUndefined();
  });

  it('owner token + yolo → 200', async () => {
    const ctx = await setup({
      approvalModeResult: {
        mode: 'yolo',
        previous: 'default',
        persisted: false,
      },
    });
    const res = await post(ctx.baseUrl, ctx.ownerToken, { mode: 'yolo' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('yolo');
  });

  it('unknown mode → 400 invalid_approval_mode with allowed list', async () => {
    const ctx = await setup();
    const res = await post(ctx.baseUrl, ctx.writeToken, { mode: 'nope' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_approval_mode');
    expect(body.allowed).toContain('plan');
    expect(ctx.stub.lastApprovalModeBody).toBeUndefined();
  });

  it('non-boolean persist → 400 invalid_persist_flag', async () => {
    const ctx = await setup();
    const res = await post(ctx.baseUrl, ctx.writeToken, {
      mode: 'plan',
      persist: 'yes',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_persist_flag');
    expect(ctx.stub.lastApprovalModeBody).toBeUndefined();
  });

  it('daemon 403 trust-gate passes through unchanged, falls back to generic human message', async () => {
    const ctx = await setup({
      approvalModeStatus: 403,
      approvalModeBody: { code: 'trust_gate', errorKind: 'auth_env_error' },
    });
    const res = await post(ctx.baseUrl, ctx.ownerToken, { mode: 'auto' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('trust_gate');
    expect(body.errorKind).toBe('auth_env_error');
    // No human message in the daemon body → generic fallback string.
    expect(body.error).toBe('Approval mode blocked by folder trust');
  });

  it('daemon 403 with a human message → response error reflects the daemon message', async () => {
    const ctx = await setup({
      approvalModeStatus: 403,
      approvalModeBody: {
        code: 'trust_gate',
        errorKind: 'auth_env_error',
        error: 'Folder /repo/untrusted is not trusted',
      },
    });
    const res = await post(ctx.baseUrl, ctx.ownerToken, { mode: 'auto' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Folder /repo/untrusted is not trusted');
    // code/errorKind still pass through faithfully alongside the message.
    expect(body.code).toBe('trust_gate');
    expect(body.errorKind).toBe('auth_env_error');
  });

  it('daemon 404 → 502 approval_mode_unsupported', async () => {
    const ctx = await setup({ approvalModeStatus: 404 });
    const res = await post(ctx.baseUrl, ctx.writeToken, { mode: 'plan' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('approval_mode_unsupported');
  });

  it('planExitedOutOfBand true when previous was plan', async () => {
    const ctx = await setup({
      approvalModeResult: {
        mode: 'default',
        previous: 'plan',
        persisted: false,
      },
    });
    const res = await post(ctx.baseUrl, ctx.writeToken, { mode: 'default' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.planExitedOutOfBand).toBe(true);
  });

  it('writes a session_approval_mode_set audit row (no content)', async () => {
    const ctx = await setup({
      approvalModeResult: {
        mode: 'yolo',
        previous: 'default',
        persisted: false,
      },
    });
    const res = await post(ctx.baseUrl, ctx.ownerToken, { mode: 'yolo' });
    expect(res.status).toBe(200);

    // AuditLog derives its directory from dirname(auditPath) and writes
    // audit-YYYY-MM-DD.log files inside it (UTC date key).
    const dateKey = new Date().toISOString().slice(0, 10);
    const text = await readFile(
      join(runtimeBase, `audit-${dateKey}.log`),
      'utf8',
    );
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const rows = lines.filter((r) => r.action === 'session_approval_mode_set');
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({
      mode: 'yolo',
      previous: 'default',
      persisted: false,
      planExitedOutOfBand: false,
    });
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toMatch(/prompt|args|path/i);
  });
});

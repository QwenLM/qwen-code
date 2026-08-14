/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { createSessionCreateRoute } from './sessionCreate.js';
import { WorkspacePoolFullError, type SessionDaemon } from '../daemonPool.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
const tmpDirs: string[] = [];

/** Real existing directory for tests that exercise the cwd-must-exist check. */
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mountGateway(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = {
      id: 'tkn-owner',
      scopes: ['write', 'session:read'],
    };
    next();
  });
  app.post('/session', createSessionCreateRoute(daemon, audit));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function pollAudit(
  audit: ReturnType<typeof fakeAudit>,
  action: string,
): Promise<AuditEntry | undefined> {
  const deadline = Date.now() + 2000;
  while (
    !audit.calls.some((c) => c.action === action) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return audit.calls.find((c) => c.action === action);
}

describe('POST /session (create)', () => {
  it('creates a session and returns its id + workspace', async () => {
    const projDir = makeTmpDir('qwen-session-create-proj-');
    stub = await startStubDaemon({ workspaceCwd: projDir });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: projDir }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      workspaceCwd: string;
    };
    expect(body.sessionId).toBe('stub-agent-1');
    expect(body.workspaceCwd).toBe(projDir);
    // The cwd + default scope are forwarded to the daemon.
    expect(stub.lastCreateSessionBody).toMatchObject({
      cwd: projDir,
      sessionScope: 'single',
    });
  });

  it('audits session_created with the id + scope, never the cwd path', async () => {
    const secretDir = makeTmpDir('qwen-session-create-secret-');
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: secretDir }),
    });

    const row = await pollAudit(audit, 'session_created');
    expect(row).toBeDefined();
    expect(row!.actorTokenId).toBe('tkn-owner');
    expect(row!.target).toBe('stub-agent-1');
    expect(row!.detail).toEqual({ scope: 'single' });
    // Path hygiene: the cwd must never reach the audit record.
    expect(JSON.stringify(row)).not.toContain(secretDir);
  });

  it('rejects a create whose cwd is not an existing directory', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/does/not/exist', scope: 'thread' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_workspace');
    // Rejected before any daemon call.
    expect(stub.createdSessionCount).toBe(0);
  });

  it('returns 503 workspace_pool_full when the pool is full (not the generic 502)', async () => {
    const dir = makeTmpDir('qwen-session-create-full-');
    // A fake pool whose createOrAttachSession throws the pool's own
    // WorkspacePoolFullError (max concurrent workspace daemons, all busy) —
    // the route must map this to a distinct, retryable 503, not the generic
    // 502 daemon_unavailable used for every other daemon failure.
    const fullPool = {
      async createOrAttachSession() {
        throw new WorkspacePoolFullError(3);
      },
    } as unknown as SessionDaemon;
    const url = await mountGateway(fullPool);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: dir }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_pool_full');
  });

  it("defaults scope to 'single'; passes 'thread' through; omits empty cwd", async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    // Empty cwd → omitted on the wire (daemon falls back to bound workspace);
    // explicit thread scope → forwarded.
    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '', scope: 'thread' }),
    });
    expect(res.status).toBe(200);
    const sent = stub.lastCreateSessionBody as Record<string, unknown>;
    expect(sent.sessionScope).toBe('thread');
    expect('cwd' in sent).toBe(false); // empty cwd is stripped, not sent as ""
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ createSessionStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });
});

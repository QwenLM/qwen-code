/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { createSessionEndRoute } from './sessionEnd.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mountGateway(
  daemon: DaemonClient,
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
  app.post('/session/:id/end', createSessionEndRoute(daemon, audit));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('POST /session/:id/end', () => {
  it('returns 200 and audits session_ended on success', async () => {
    stub = await startStubDaemon({ endSessionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    const res = await fetch(`${url}/session/sess-1/end`, { method: 'POST' });
    expect(res.status).toBe(200);

    // Audit record is fire-and-forget; poll briefly.
    const deadline = Date.now() + 2000;
    while (
      !audit.calls.some((c) => c.action === 'session_ended') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const row = audit.calls.find((c) => c.action === 'session_ended');
    expect(row).toBeDefined();
    expect(row!.actorTokenId).toBe('tkn-owner');
    expect(row!.target).toBe('sess-1');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ endSessionStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/sess-1/end`, { method: 'POST' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });

  it('forwards the session id from the route param', async () => {
    stub = await startStubDaemon({ endSessionStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/my-session-42/end`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(stub.lastEndedSessionId).toBe('my-session-42');
  });
});

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
import { createSessionEventsRoute } from './sessionEvents.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
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
  app.get(
    '/rc/session/:id/events',
    createSessionEventsRoute(daemon, new ConnectionRegistry(), audit),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Read an SSE response body into discrete {id, data} frames. */
async function readFrames(
  res: Response,
): Promise<Array<{ id?: string; data: string }>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const lines = block.split('\n');
      const id = lines
        .find((l) => l.startsWith('id:'))
        ?.slice(3)
        .trim();
      const data = lines
        .find((l) => l.startsWith('data:'))!
        .slice(5)
        .trim();
      return { id, data };
    });
}

describe('session-events proxy', () => {
  it('relays daemon frames downstream preserving ids', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res);
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    expect(frames[0].data).toContain('"text":"one"');
  });

  it('forwards Last-Event-ID upstream to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { 'Last-Event-ID': '5' },
    });
    expect(stub.lastEventIdHeader).toBe('5');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ eventsStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    expect(res.status).toBe(502);
  });

  it('aborts the upstream subscription when the client disconnects', async () => {
    stub = await startStubDaemon({ holdOpenMs: 5000 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const ac = new AbortController();
    const res = await fetch(`${url}/rc/session/sess-1/events`, {
      signal: ac.signal,
    });
    // Read the first chunk so the stream is established, then disconnect.
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});

    // Poll until the stub observes its upstream request socket close.
    // Propagation is sub-50ms in practice; the generous deadline is pure
    // anti-flake margin.
    const deadline = Date.now() + 5000;
    while (!stub.eventsAbortedByClient && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stub.eventsAbortedByClient).toBe(true);
  });

  it('records session_attached then session_detached', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    await res.text();
    const deadline = Date.now() + 2000;
    while (
      !audit.calls.some((c) => c.action === 'session_detached') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const actions = audit.calls.map((c) => c.action);
    expect(actions).toContain('session_attached');
    expect(actions).toContain('session_detached');
    expect(actions.indexOf('session_attached')).toBeLessThan(
      actions.indexOf('session_detached'),
    );
    // Both entries carry the session id (target) per the spec.
    for (const c of audit.calls) {
      expect(c.target).toBe('sess-1');
    }
  });
});

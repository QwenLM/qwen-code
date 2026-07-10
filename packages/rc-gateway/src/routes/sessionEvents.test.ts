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
import { UsageTickBroadcaster } from '../cost/usageTickBroadcaster.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { TokenStore } from '../tokenStore.js';
import { bearerResolve } from '../auth.js';
import { SHARE, SESSION_READ, BRIDGE } from '../scopes.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWal } from '../wal.js';

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
  walDir?: string,
): Promise<string> {
  const app = express();
  app.get(
    '/session/:id/events',
    createSessionEventsRoute(
      daemon,
      new ConnectionRegistry(),
      audit,
      undefined,
      walDir,
    ),
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
    const res = await fetch(`${url}/session/sess-1/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res);
    // Filter to daemon frames only (presence frames have no id).
    const daemonFrames = frames.filter((f) => f.id !== undefined);
    expect(daemonFrames.map((f) => f.id)).toEqual(['1', '2']);
    expect(daemonFrames[0].data).toContain('"text":"one"');
  });

  it('injects a usage_tick frame to the session subscriber', async () => {
    const broadcaster = new UsageTickBroadcaster();
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'one' } }],
      holdOpenMs: 500,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        daemon,
        new ConnectionRegistry(),
        undefined,
        broadcaster,
      ),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;

    const resP = fetch(`http://127.0.0.1:${port}/session/sess-1/events`);
    // Wait for the relay to register its tick listener, then emit one.
    const start = Date.now();
    while (broadcaster.listenerCount('sess-1') === 0) {
      if (Date.now() - start > 2000) throw new Error('relay never registered');
      await new Promise((r) => setTimeout(r, 10));
    }
    broadcaster.emit({
      sessionId: 'sess-1',
      costMicrocentsSesTotal: 15,
      costMicrocentsPromptTotal: 3,
      tokensInTotal: 100,
      tokensOutTotal: 50,
    });
    const res = await resP;
    const frames = await readFrames(res);
    const tick = frames.find((f) => f.data.includes('usage_tick'));
    expect(tick).toBeDefined();
    expect(tick!.id).toBeUndefined(); // synthetic — must not advance the cursor
    expect(tick!.data).toContain('"costMicrocentsSesTotal":15');
  });

  it('enriches a permission_request frame with bridgeHints; leaves others untouched', async () => {
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'one' } },
        {
          id: 2,
          type: 'permission_request',
          data: {
            requestId: 'r1',
            toolCall: { name: 'run_shell', args: { cmd: 'ls' } },
          },
        },
        {
          id: 3,
          type: 'permission_request',
          data: {
            requestId: 'r2',
            toolCall: { name: 'set_env', args: { apiKey: 'sk-secret' } },
          },
        },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/sess-1/events`);
    const frames = await readFrames(res);
    // Filter to daemon frames only (presence frames have no id).
    const parsed = frames
      .filter((f) => f.id !== undefined)
      .map((f) => JSON.parse(f.data));
    // Non-permission frame: no bridgeHints added.
    expect(parsed[0].data.bridgeHints).toBeUndefined();
    // Clean tool-call → inline surface (run_shell is a mutating tool → medium).
    expect(parsed[1].data.bridgeHints.recommendedSurface).toBe('inline');
    expect(parsed[1].data.bridgeHints.sensitivity).toBe('medium');
    // Secret-looking args → high sensitivity → deeplink.
    expect(parsed[2].data.bridgeHints.sensitivity).toBe('high');
    expect(parsed[2].data.bridgeHints.recommendedSurface).toBe('deeplink');
    // Original fields are preserved.
    expect(parsed[2].data.requestId).toBe('r2');
  });

  it('tags attach/detach presence with kind:bridge for a bridge token, kind:client otherwise', async () => {
    // Mount with an injected rcClient so the route sees a bridge's scopes.
    async function mountWithClient(
      daemon: DaemonClient,
      scopes: string[],
      audit: AuditRecorder,
    ): Promise<string> {
      const app = express();
      app.use((req, _res, next) => {
        (req as { rcClient?: unknown }).rcClient = { id: 'tkn', scopes };
        next();
      });
      app.get(
        '/session/:id/events',
        createSessionEventsRoute(daemon, new ConnectionRegistry(), audit),
      );
      const s: Server = await new Promise((resolve) => {
        const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
      });
      gateway = s;
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    }

    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountWithClient(daemon, [BRIDGE, SESSION_READ], audit);
    await readFrames(await fetch(`${url}/session/sess-1/events`));
    const attached = audit.calls.find((c) => c.action === 'session_attached');
    const detached = audit.calls.find((c) => c.action === 'session_detached');
    expect(attached?.detail).toEqual({ kind: 'bridge' });
    expect(detached?.detail).toEqual({ kind: 'bridge' });
  });

  it('forwards Last-Event-ID upstream to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    await fetch(`${url}/session/sess-1/events`, {
      headers: { 'Last-Event-ID': '5' },
    });
    expect(stub.lastEventIdHeader).toBe('5');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ eventsStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/sess-1/events`);
    expect(res.status).toBe(502);
  });

  it('aborts the upstream subscription when the client disconnects', async () => {
    stub = await startStubDaemon({ holdOpenMs: 5000 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const ac = new AbortController();
    const res = await fetch(`${url}/session/sess-1/events`, {
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
    const res = await fetch(`${url}/session/sess-1/events`);
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

  it('tags attach/detach rows with shareId+shareLabel for a guest', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const store = await TokenStore.open(
      join(mkdtempSync(join(tmpdir(), 'rc-se-')), 'tokens.json'),
    );
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'review for Sam',
      sessionLockId: 'sess-1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    const app = express();
    app.use(bearerResolve(store, audit));
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(daemon, new ConnectionRegistry(), audit),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-1/events`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    await res.text();
    const deadline = Date.now() + 2000;
    while (
      !audit.calls.some((c) => c.action === 'session_detached') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const action of ['session_attached', 'session_detached']) {
      const row = audit.calls.find((c) => c.action === action);
      expect(row!.shareId).toBe(share.id);
      expect(row!.shareLabel).toBe('review for Sam');
    }
  });
});

describe('session-events presence frames', () => {
  it('emits a synthetic client_joined frame as the first SSE frame on attach', async () => {
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'hello' } }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/sess-1/events`);
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    // First frame must be the synthetic client_joined (no id: line).
    const first = frames[0];
    expect(first).toBeDefined();
    const parsed = JSON.parse(first!.data);
    expect(parsed.type).toBe('client_joined');
    expect(first!.id).toBeUndefined(); // synthetic — no id
    expect(typeof parsed.data.attachedAt).toBe('string');
  });

  it('emits a synthetic client_left frame after the connection closes', async () => {
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'bye' } }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    // We can verify client_left indirectly via the writable SSE response: the
    // stub ends the stream, so the gateway's finally block runs synchronously
    // and the audit record for 'session_detached' fires. The SSE client_left
    // frame goes to the client BEFORE the stream closes (written in finally).
    // Since the stream already ended, the response body is all we have;
    // verify that the frames include client_left at the end.
    const res = await fetch(`${url}/session/sess-1/events`);
    const frames = await readFrames(res);
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame).toBeDefined();
    const parsed = JSON.parse(lastFrame!.data);
    expect(parsed.type).toBe('client_left');
    expect(parsed.data.reason).toBe('disconnect');
    expect(lastFrame!.id).toBeUndefined();
  });
});

describe('session-events WAL integration', () => {
  it('appends daemon frames to WAL and replays them on reconnect', async () => {
    // Use a unique session id to avoid collisions with walRegistry singleton.
    const sessionId = 'wal-replay-sess';
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'one' } },
        { id: 2, type: 'session_update', data: { text: 'two' } },
      ],
    });
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon, undefined, walDir);

    // First connection: consume all frames (writes to WAL).
    const res1 = await fetch(`${url}/session/${sessionId}/events`);
    expect(res1.status).toBe(200);
    const frames1 = await readFrames(res1);
    // Filter to daemon frames only (presence frames have no id).
    const daemonFrames1 = frames1.filter((f) => f.id !== undefined);
    expect(daemonFrames1.map((f) => f.id)).toEqual(['1', '2']);

    // Verify WAL has the events.
    const wal = new SessionWal({ dir: walDir, sessionId });
    expect(wal.count()).toBe(2);
    wal.close();

    // Second connection with Last-Event-ID=1: should replay frame 2 from WAL.
    // Stub now has no frames to emit (daemon stream ends immediately).
    await stub.close();
    stub = await startStubDaemon({ frames: [] });
    const daemon2 = new DaemonClient({ baseUrl: stub.baseUrl });
    const url2 = await mountGateway(daemon2, undefined, walDir);

    const res2 = await fetch(`${url2}/session/${sessionId}/events`, {
      headers: { 'Last-Event-ID': '1' },
    });
    expect(res2.status).toBe(200);
    const frames2 = await readFrames(res2);
    // Filter to daemon frames only (presence frames have no id).
    const daemonFrames2 = frames2.filter((f) => f.id !== undefined);
    expect(daemonFrames2.map((f) => f.id)).toEqual(['2']);
    expect(daemonFrames2[0]!.data).toContain('"text":"two"');
  });

  it('returns 412 with replay_truncated when Last-Event-ID is before WAL horizon', async () => {
    const sessionId = 'wal-truncated-sess';
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));

    // Seed the WAL with events starting at id=10 so that a resume from id=5
    // is clearly before the WAL's earliest event. The route creates its own
    // SessionWal with default options, so we use the same defaults here.
    const wal = new SessionWal({ dir: walDir, sessionId });
    wal.append({ id: 10, v: 1, type: 'session_update', data: {} });
    wal.append({ id: 11, v: 1, type: 'session_update', data: {} });
    wal.close();

    stub = await startStubDaemon({ frames: [] });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    // Mount with a fresh app so the walRegistry picks up the pre-seeded dir.
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        daemon,
        new ConnectionRegistry(),
        undefined,
        undefined,
        walDir,
      ),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;

    // Resume from id=5 which is before the earliest retained (10) by > 1.
    const res = await fetch(
      `http://127.0.0.1:${port}/session/${sessionId}/events`,
      {
        headers: { 'Last-Event-ID': '5' },
      },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as {
      type: string;
      data: { earliestAvailableId: number | null; reason: string };
    };
    expect(body.type).toBe('replay_truncated');
    expect(body.data.reason).toBe('older_than_wal_horizon');
    expect(body.data.earliestAvailableId).toBe(10);
  });
});

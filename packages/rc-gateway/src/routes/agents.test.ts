/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { AgentLifecycle } from '../agents/agentLifecycle.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import {
  createSpawnAgentRoute,
  createListAgentsRoute,
  createGetAgentRoute,
  createAgentMessageRoute,
  createAgentCancelRoute,
  type AgentRoutesDeps,
} from './agents.js';

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

async function setup(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
  client: {
    id: string;
    scopes: string[];
    sessionLockId?: string;
  } = { id: 'tkn-owner', scopes: ['write', 'session:read'] },
) {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const dir = await mkdtemp(join(tmpdir(), 'agents-route-'));
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const ownerEvents = new OwnerEventBus();
  const ownerSeen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => ownerSeen.push(e));
  const lifecycle = new AgentLifecycle(registry, ownerEvents);
  const audit = fakeAudit();
  const deps: AgentRoutesDeps = {
    daemon,
    registry,
    lifecycle,
    audit,
    costFor: (sid) => (sid.startsWith('stub-agent') ? 5000 : undefined),
    promptAcceptWindowMs: 25,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = client;
    next();
  });
  app.post('/rc/agents', createSpawnAgentRoute(deps));
  app.get('/rc/agents', createListAgentsRoute(deps));
  app.get('/rc/agents/:id', createGetAgentRoute(deps));
  app.post('/rc/agents/:id/message', createAgentMessageRoute(deps));
  app.post('/rc/agents/:id/cancel', createAgentCancelRoute(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, registry, audit, ownerSeen };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('POST /rc/agents (spawn saga)', () => {
  it('creates a thread session, registers, prompts, audits, 201', async () => {
    // promptDelayMs keeps the agent running past the accept window.
    const { url, registry, audit, ownerSeen } = await setup({
      promptDelayMs: 500,
    });
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'run the tests', agentType: 'general' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agentId: string; sessionId: string };
    expect(body.sessionId).toBe('stub-agent-1');
    expect(registry.get(body.agentId)?.status).toBe('running');
    expect(stub!.lastCreateSessionBody).toMatchObject({
      sessionScope: 'thread',
    });
    expect(ownerSeen.map((e) => e.type)).toContain('agent_spawned');
    await waitFor(() => audit.calls.some((c) => c.action === 'agent_spawned'));
    const row = audit.calls.find((c) => c.action === 'agent_spawned')!;
    expect(row.actorTokenId).toBe('tkn-owner');
    expect(row.target).toBe(body.agentId);
    expect(JSON.stringify(row)).not.toContain('run the tests');
  });

  it('502 daemon_unavailable when session create fails; nothing registered', async () => {
    const { url, registry } = await setup({ createSessionStatus: 500 });
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'daemon_unavailable',
    );
    expect(registry.list()).toHaveLength(0);
  });

  it('rolls back on prompt-send failure: session ended, record failed, 502', async () => {
    const { url, registry } = await setup({ promptStatus: 500 });
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'prompt_send_failed',
    );
    expect(stub!.lastEndedSessionId).toBe('stub-agent-1');
    expect(registry.list({ status: 'failed' })).toHaveLength(1);
  });

  it('400 invalid_task on a missing/empty task', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /rc/agents + /rc/agents/:id', () => {
  it('lists with filters and read-time cost rollup', async () => {
    const { url, registry } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't', parentSessionId: 'p1' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };

    const list = await fetch(`${url}/rc/agents?status=running&parent=p1`);
    const listBody = (await list.json()) as {
      agents: Array<{ agentId: string; costMicrocents?: number }>;
    };
    expect(listBody.agents.map((a) => a.agentId)).toEqual([agentId]);
    expect(listBody.agents[0].costMicrocents).toBe(5000);

    const detail = await fetch(`${url}/rc/agents/${agentId}`);
    expect(detail.status).toBe(200);
    expect(
      ((await detail.json()) as { costMicrocents?: number }).costMicrocents,
    ).toBe(5000);

    const missing = await fetch(`${url}/rc/agents/nope`);
    expect(missing.status).toBe(404);
    expect(registry.get(agentId)?.parentSessionId).toBe('p1');
  });

  it('400 invalid_status on an unknown status filter', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/rc/agents?status=zombie`);
    expect(res.status).toBe(400);
  });

  it('session-locked share token: list confined to the locked session only; other sessions (incl. task text) never leak', async () => {
    const { url, registry } = await setup(
      {},
      {
        id: 'tkn-share',
        scopes: ['session:read', 'share'],
        sessionLockId: 'S1',
      },
    );
    // Own-session record: sessionId === lock.
    const own = await registry.register({
      sessionId: 'S1',
      parentSessionId: null,
      agentType: 'general',
      task: 'S1 own task',
      spawnedByTokenId: 'owner',
    });
    // Spawned-by-S1 record: parentSessionId === lock (own sessionId differs).
    const child = await registry.register({
      sessionId: 'S1-child',
      parentSessionId: 'S1',
      agentType: 'general',
      task: 'S1 child task',
      spawnedByTokenId: 'owner',
    });
    // Unrelated session's record — must never leak, not even its task text.
    await registry.register({
      sessionId: 'S2',
      parentSessionId: null,
      agentType: 'general',
      task: 'S2 SECRET task text',
      spawnedByTokenId: 'owner',
    });

    const res = await fetch(`${url}/rc/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents.map((a) => a.agentId).sort()).toEqual(
      [own.agentId, child.agentId].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('S2 SECRET task text');
  });

  it('non-locked owner token: list is unfiltered (all sessions)', async () => {
    const { url, registry } = await setup();
    await registry.register({
      sessionId: 'S1',
      parentSessionId: null,
      agentType: 'general',
      task: 'S1 task',
      spawnedByTokenId: 'owner',
    });
    await registry.register({
      sessionId: 'S2',
      parentSessionId: null,
      agentType: 'general',
      task: 'S2 task',
      spawnedByTokenId: 'owner',
    });

    const res = await fetch(`${url}/rc/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents).toHaveLength(2);
  });

  it("session-locked share token: detail on another session's agent → 404 (not the other session's task text); own session's agent → 200", async () => {
    const { url, registry } = await setup(
      {},
      {
        id: 'tkn-share',
        scopes: ['session:read', 'share'],
        sessionLockId: 'S1',
      },
    );
    const own = await registry.register({
      sessionId: 'S1',
      parentSessionId: null,
      agentType: 'general',
      task: 'S1 own task',
      spawnedByTokenId: 'owner',
    });
    const child = await registry.register({
      sessionId: 'S1-child',
      parentSessionId: 'S1',
      agentType: 'general',
      task: 'S1 child task',
      spawnedByTokenId: 'owner',
    });
    const other = await registry.register({
      sessionId: 'S2',
      parentSessionId: null,
      agentType: 'general',
      task: 'S2 SECRET task text',
      spawnedByTokenId: 'owner',
    });

    // Another session's agent, by id, must 404 — same shape as unknown id —
    // and must NEVER leak its task text in the response body.
    const otherRes = await fetch(`${url}/rc/agents/${other.agentId}`);
    expect(otherRes.status).toBe(404);
    const otherBody = (await otherRes.json()) as { code: string };
    expect(otherBody.code).toBe('agent_not_found');
    expect(JSON.stringify(otherBody)).not.toContain('S2 SECRET task text');

    // Own session's agent → 200.
    const ownRes = await fetch(`${url}/rc/agents/${own.agentId}`);
    expect(ownRes.status).toBe(200);
    expect(((await ownRes.json()) as { agentId: string }).agentId).toBe(
      own.agentId,
    );

    // Agent spawned FROM the locked session (parentSessionId tie) → 200.
    const childRes = await fetch(`${url}/rc/agents/${child.agentId}`);
    expect(childRes.status).toBe(200);
    expect(((await childRes.json()) as { agentId: string }).agentId).toBe(
      child.agentId,
    );
  });

  it("non-locked owner token: detail on any session's agent → 200 (unaffected)", async () => {
    const { url, registry } = await setup();
    const other = await registry.register({
      sessionId: 'S2',
      parentSessionId: null,
      agentType: 'general',
      task: 'S2 task',
      spawnedByTokenId: 'owner',
    });
    const res = await fetch(`${url}/rc/agents/${other.agentId}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agentId: string }).agentId).toBe(
      other.agentId,
    );
  });
});

describe('steer + cancel', () => {
  it('message: 202 + agent_message_sent audit; content never audited', async () => {
    const { url, audit } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };
    const res = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'sekrit-steer-text' }),
    });
    expect(res.status).toBe(202);
    await waitFor(() =>
      audit.calls.some((c) => c.action === 'agent_message_sent'),
    );
    const row = audit.calls.find((c) => c.action === 'agent_message_sent')!;
    expect(JSON.stringify(row)).not.toContain('sekrit-steer-text');
  });

  it('cancel: ends session, marks cancelled, emits agent_cancelled; second cancel 409', async () => {
    const { url, registry, ownerSeen } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId, sessionId } = (await spawn.json()) as {
      agentId: string;
      sessionId: string;
    };
    const res = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(stub!.lastEndedSessionId).toBe(sessionId);
    expect(registry.get(agentId)?.status).toBe('cancelled');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_cancelled');

    const again = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe(
      'agent_not_running',
    );
  });

  it('message on a terminal agent → 409 agent_not_running', async () => {
    const { url, registry } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };
    await registry.setStatus(agentId, 'completed');
    const res = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(409);
  });

  it('concurrent double-cancel: exactly one 200, one 409, one audit row', async () => {
    const { url, registry, audit } = await setup({ promptDelayMs: 500 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };

    const [a, b] = await Promise.all([
      fetch(`${url}/rc/agents/${agentId}/cancel`, { method: 'POST' }),
      fetch(`${url}/rc/agents/${agentId}/cancel`, { method: 'POST' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    expect(((await winner.json()) as { status: string }).status).toBe(
      'cancelled',
    );
    const loser = a.status === 200 ? b : a;
    expect(((await loser.json()) as { code: string }).code).toBe(
      'agent_not_running',
    );

    expect(registry.get(agentId)?.status).toBe('cancelled');
    await waitFor(() =>
      audit.calls.some((c) => c.action === 'agent_cancelled'),
    );
    expect(
      audit.calls.filter((c) => c.action === 'agent_cancelled'),
    ).toHaveLength(1);
  });

  it('steer serialization: two rapid messages hit the daemon sequentially, not overlapping', async () => {
    const { url } = await setup({ promptDelayMs: 150 });
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId, sessionId } = (await spawn.json()) as {
      agentId: string;
      sessionId: string;
    };

    const [m1, m2] = await Promise.all([
      fetch(`${url}/rc/agents/${agentId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'first' }),
      }),
      fetch(`${url}/rc/agents/${agentId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'second' }),
      }),
    ]);
    expect(m1.status).toBe(202);
    expect(m2.status).toBe(202);

    // Spawn's own prompt + two steers = 3 daemon prompt calls total, all
    // serialized against the same session.
    await waitFor(() => (stub!.promptCallLog.length ?? 0) >= 3, 5000);
    const calls = stub!.promptCallLog
      .filter((c) => c.sessionId === sessionId)
      .sort((x, y) => x.startedAt - y.startedAt);
    expect(calls).toHaveLength(3);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].startedAt).toBeGreaterThanOrEqual(calls[i - 1].endedAt);
    }
  });
});

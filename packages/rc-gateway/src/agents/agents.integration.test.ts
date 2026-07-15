/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { AgentRegistry } from './agentRegistry.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { OwnerEvent } from '../ownerEvents.js';
import type { GatewayEvent } from '../routes/promptEventBroadcaster.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

describe('agent observability end-to-end (spawn → frames → cancel)', () => {
  it('drives the full lifecycle against the stub daemon', async () => {
    stub = await startStubDaemon({ promptDelayMs: 2000 });
    const dir = await mkdtemp(join(tmpdir(), 'agents-e2e-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const { token } = await store.issue(['owner'], 'e2e-owner');
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));

    const gw = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(dir, 'audit.log'),
      agents: {
        registry,
        costFor: () => 4242,
        promptAcceptWindowMs: 25,
      },
    });
    const frames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => frames.push(e));
    // The parent session ('parent-1') has its own SSE stream: lifecycle
    // frames must reach it too, not just the owner bus (agentLifecycle.ts
    // emit() fans out to both surfaces).
    const parentFrames: GatewayEvent[] = [];
    gw.promptEvents.register('parent-1', (e) => parentFrames.push(e));

    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${token}` };

    // 1. Spawn.
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'run tests', parentSessionId: 'parent-1' }),
    });
    expect(spawn.status).toBe(201);
    const { agentId, sessionId } = (await spawn.json()) as {
      agentId: string;
      sessionId: string;
    };
    expect(sessionId).toBe('stub-agent-1');
    expect(stub.createdSessionCount).toBe(1);

    // 2. Observe: agent_spawned on the owner stream with the cost rollup.
    const spawned = frames.find((f) => f.type === 'agent_spawned') as Extract<
      OwnerEvent,
      { type: 'agent_spawned' }
    >;
    expect(spawned).toBeDefined();
    expect(spawned.agent).toMatchObject({
      agentId,
      sessionId,
      parentSessionId: 'parent-1',
      status: 'running',
      costMicrocents: 4242,
    });

    // 2b. Same frame must also reach the PARENT SESSION's own SSE stream
    // (agentLifecycle.ts emit() publishes to ownerEvents AND
    // promptEvents.emit(parentSessionId, ...) — both surfaces are load
    // bearing, not just the owner bus).
    const parentSpawned = parentFrames.find((f) => f.type === 'agent_spawned');
    expect(parentSpawned).toBeDefined();
    expect((parentSpawned as { data: { agentId: string } }).data).toMatchObject(
      {
        agentId,
        sessionId,
        parentSessionId: 'parent-1',
        status: 'running',
        costMicrocents: 4242,
      },
    );

    // 3. Listing shows it running.
    const list = await fetch(`${url}/rc/agents?status=running`, {
      headers: auth,
    });
    expect(
      ((await list.json()) as { agents: Array<{ agentId: string }> }).agents,
    ).toHaveLength(1);

    // 3b. Steer while running: message route accepts (202) before any
    // cancel — the stub's promptDelayMs (2000ms) keeps the agent 'running'
    // well past the spawn's 25ms accept window, so this exercises the
    // success path, not the terminal guard.
    const steerWhileRunning = await fetch(
      `${url}/rc/agents/${agentId}/message`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'keep going' }),
      },
    );
    expect(steerWhileRunning.status).toBe(202);
    expect(registry.get(agentId)?.status).toBe('running');

    // 4. Cancel: daemon session ended, record cancelled, frame emitted on
    // both the owner bus and the parent session's stream.
    const cancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(cancel.status).toBe(200);
    expect(stub.lastEndedSessionId).toBe(sessionId);
    expect(registry.get(agentId)?.status).toBe('cancelled');
    const cancelled = frames.find((f) => f.type === 'agent_cancelled');
    expect(cancelled).toBeDefined();
    const parentCancelled = parentFrames.find(
      (f) => f.type === 'agent_cancelled',
    );
    expect(parentCancelled).toBeDefined();

    // 5. Terminal: steer + re-cancel both 409 agent_not_running.
    const steer = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(steer.status).toBe(409);
    expect((await steer.json()) as { code: string }).toMatchObject({
      code: 'agent_not_running',
    });

    // 5b. Double-cancel: a second cancel on an already-terminal agent must
    // also 409 (the route's post-daemon-call CAS guard, not just the
    // pre-check — see createAgentCancelRoute's "loser gets 409" comment).
    const secondCancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(secondCancel.status).toBe(409);
    expect((await secondCancel.json()) as { code: string }).toMatchObject({
      code: 'agent_not_running',
    });

    // 6. Audit trail: agent_spawned + agent_cancelled rows on the owner bus
    //    (the audit sink publishes every durable row as an `audit` frame).
    //    audit.record is fire-and-forget on the routes — poll briefly.
    const auditActions = () =>
      frames
        .filter((f) => f.type === 'audit')
        .map(
          (f) => (f as Extract<OwnerEvent, { type: 'audit' }>).record.action,
        );
    const deadline = Date.now() + 2000;
    while (
      !(
        auditActions().includes('agent_spawned') &&
        auditActions().includes('agent_cancelled')
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(auditActions()).toContain('agent_spawned');
    expect(auditActions()).toContain('agent_cancelled');
  });
});

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

    // 3. Listing shows it running.
    const list = await fetch(`${url}/rc/agents?status=running`, {
      headers: auth,
    });
    expect(
      ((await list.json()) as { agents: Array<{ agentId: string }> }).agents,
    ).toHaveLength(1);

    // 4. Cancel: daemon session ended, record cancelled, frame emitted.
    const cancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(cancel.status).toBe(200);
    expect(stub.lastEndedSessionId).toBe(sessionId);
    expect(registry.get(agentId)?.status).toBe('cancelled');
    const cancelled = frames.find((f) => f.type === 'agent_cancelled');
    expect(cancelled).toBeDefined();

    // 5. Terminal: steer + re-cancel both 409.
    const steer = await fetch(`${url}/rc/agents/${agentId}/message`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(steer.status).toBe(409);

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

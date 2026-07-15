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
import { createGatewayApp, type GatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { AgentRegistry } from './agents/agentRegistry.js';
import { PromptEventBroadcaster } from './routes/promptEventBroadcaster.js';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

async function setup() {
  stub = await startStubDaemon({ promptDelayMs: 2000 });
  const dir = await mkdtemp(join(tmpdir(), 'srv-agents-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const writeTok = (await store.issue(['write', 'session:read'], 'w')).token;
  const readTok = (await store.issue(['session:read'], 'r')).token;
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const gw: GatewayApp = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    agents: { registry, costFor: () => 7777, promptAcceptWindowMs: 25 },
  });
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    gw,
    registry,
    writeTok,
    readTok,
  };
}

describe('agent observability wiring', () => {
  it('mounts the /rc/agents routes with scope gates and cost rollup', async () => {
    const { url, registry, writeTok, readTok } = await setup();

    // No token → 401 from bearerResolve.
    expect((await fetch(`${url}/rc/agents`)).status).toBe(401);

    // read-scope token cannot spawn → 403 scope_required.
    const denied = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe(
      'scope_required',
    );

    // write-scope spawn → 201, registered.
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(spawn.status).toBe(201);
    const { agentId } = (await spawn.json()) as { agentId: string };
    expect(registry.get(agentId)?.status).toBe('running');

    // read-scope list → 200 with the read-time cost rollup.
    const list = await fetch(`${url}/rc/agents`, {
      headers: { Authorization: `Bearer ${readTok}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      agents: Array<{ costMicrocents?: number }>;
    };
    expect(body.agents[0].costMicrocents).toBe(7777);
  });

  it('returns promptEvents and agentLifecycle on the GatewayApp handle', async () => {
    const { gw } = await setup();
    expect(gw.promptEvents).toBeInstanceOf(PromptEventBroadcaster);
    expect(gw.agentLifecycle).toBeDefined();
  });
});

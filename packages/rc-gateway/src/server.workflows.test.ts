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
import { createGatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { AgentRegistry } from './agents/agentRegistry.js';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import type { OwnerEvent } from './ownerEvents.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

describe('workflow wiring', () => {
  it('mounts /rc/workflows with scope gates', async () => {
    stub = await startStubDaemon({ promptDelayMs: 50 });
    const dir = await mkdtemp(join(tmpdir(), 'srv-wf-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const writeTok = (await store.issue(['write', 'session:read'], 'w')).token;
    const readTok = (await store.issue(['session:read'], 'r')).token;
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const gw = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(dir, 'audit.log'),
      agents: { registry },
      workflows: { runsDir: join(dir, 'runs') },
    });
    const frames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => frames.push(e));
    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    // read scope cannot start.
    const denied = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        script: `export const meta = { name: 'd', description: 'd' };\nreturn 1;`,
      }),
    });
    expect(denied.status).toBe(403);

    // write scope starts → 202.
    const started = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        script: `export const meta = { name: 'd', description: 'd' };\nreturn 1;`,
      }),
    });
    expect(started.status).toBe(202);
    expect(gw.workflowRuns).toBeDefined();
  });
});

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
import { AgentRegistry } from '../agents/agentRegistry.js';
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

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 15));
}

// A pipeline that fans one stage over three items → exactly three agents.
const THREE_AGENT_PIPELINE = `
export const meta = { name: 'triage', description: 'fan across three items', phases: [{ title: 'Scan' }] };
phase('Scan');
const out = await pipeline(['alpha', 'beta', 'gamma'], (item) => agent('scan ' + item));
return { scanned: out };
`;

describe('workflow orchestration end-to-end (3-agent pipeline)', () => {
  it('POST /rc/workflows spawns three per-agent sessions and completes', async () => {
    stub = await startStubDaemon({ promptDelayMs: 30 });
    const dir = await mkdtemp(join(tmpdir(), 'wf-e2e-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const { token } = await store.issue(['owner'], 'e2e');
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
    const auth = { Authorization: `Bearer ${token}` };

    // 1. Start.
    const started = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: THREE_AGENT_PIPELINE }),
    });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };

    // 2. Observe: started + phase, then completed.
    expect(frames.some((f) => f.type === 'workflow_started')).toBe(true);
    await waitFor(() => frames.some((f) => f.type === 'workflow_phase'));
    await waitFor(() => frames.some((f) => f.type === 'workflow_completed'));

    // 3. Three per-agent daemon sessions were created and tagged to the run.
    expect(stub!.createdSessionCount).toBe(3);
    expect(registry.list({ workflowRunId: runId })).toHaveLength(3);

    // 4. Detail exposes the per-agent (agentId ↔ sessionId) map.
    const detail = await fetch(`${url}/rc/workflows/${runId}`, {
      headers: auth,
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      status: string;
      agents: Array<{ agentId: string; sessionId: string }>;
    };
    expect(body.status).toBe('completed');
    expect(body.agents).toHaveLength(3);
    expect(new Set(body.agents.map((a) => a.sessionId)).size).toBe(3);

    // 5. Cancel on a terminal run → 409.
    const late = await fetch(`${url}/rc/workflows/${runId}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(late.status).toBe(409);

    // 6. List shows the completed run.
    const list = await fetch(`${url}/rc/workflows`, { headers: auth });
    const listBody = (await list.json()) as {
      workflows: Array<{ runId: string; status: string }>;
    };
    expect(listBody.workflows.find((w) => w.runId === runId)?.status).toBe(
      'completed',
    );
  });
});

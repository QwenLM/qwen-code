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
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { WorkflowRunRegistry } from '../workflows/workflowRegistry.js';
import {
  createStartWorkflowRoute,
  createListWorkflowsRoute,
  createGetWorkflowRoute,
  createCancelWorkflowRoute,
  type WorkflowRoutesDeps,
} from './workflows.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function setup() {
  stub = await startStubDaemon({ promptDelayMs: 50 });
  const dir = await mkdtemp(join(tmpdir(), 'wf-routes-'));
  const agentRegistry = await AgentRegistry.open(join(dir, 'agents.json'));
  const runRegistry = new WorkflowRunRegistry();
  const ownerEvents = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => seen.push(e));
  const deps: WorkflowRoutesDeps = {
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    agentRegistry,
    runRegistry,
    ownerEvents,
    runsDir: join(dir, 'runs'),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = {
      id: 'tk',
      scopes: ['write', 'session:read'],
    };
    next();
  });
  app.post('/rc/workflows', createStartWorkflowRoute(deps));
  app.get('/rc/workflows', createListWorkflowsRoute(deps));
  app.get('/rc/workflows/:runId', createGetWorkflowRoute(deps));
  app.post('/rc/workflows/:runId/cancel', createCancelWorkflowRoute(deps));
  gateway = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = gateway.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, runRegistry };
}

const SCRIPT = `export const meta = { name: 'demo', description: 'd' };\nphase('Go');\nreturn await agent('hi');`;

describe('POST /rc/workflows', () => {
  it('202 { runId } + workflow_started frame + audit', async () => {
    const audited: string[] = [];
    const { url, seen } = await setup();
    // (audit sink omitted here; server.test covers audit rows)
    const res = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SCRIPT }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    expect(seen.some((e) => e.type === 'workflow_started')).toBe(true);
    void audited;
  });

  it('400 invalid_workflow_script on a parse error', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: 'const broken = (;' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'invalid_workflow_script',
    );
  });
});

describe('cancel', () => {
  it('409 workflow_not_running on a terminal run', async () => {
    const { url, runRegistry } = await setup();
    const run = runRegistry.create({
      runId: 'r-term',
      name: 'x',
      scriptHash: 'h',
    });
    runRegistry.setStatus(run.runId, 'completed');
    const res = await fetch(`${url}/rc/workflows/${run.runId}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'workflow_not_running',
    );
  });
});

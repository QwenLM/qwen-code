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
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
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

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function setup(promptDelayMs = 50) {
  stub = await startStubDaemon({ promptDelayMs });
  const dir = await mkdtemp(join(tmpdir(), 'wf-routes-'));
  const agentRegistry = await AgentRegistry.open(join(dir, 'agents.json'));
  const runRegistry = new WorkflowRunRegistry();
  const ownerEvents = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => seen.push(e));
  const audit = fakeAudit();
  const deps: WorkflowRoutesDeps = {
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    agentRegistry,
    runRegistry,
    ownerEvents,
    audit,
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
  return { url: `http://127.0.0.1:${port}`, seen, runRegistry, audit };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SCRIPT = `export const meta = { name: 'demo', description: 'd' };\nphase('Go');\nreturn await agent('hi');`;

describe('POST /rc/workflows', () => {
  it('202 { runId } + workflow_started frame + audit (name + scriptHash, never the script source)', async () => {
    const { url, seen, audit } = await setup();
    const res = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: SCRIPT }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    expect(seen.some((e) => e.type === 'workflow_started')).toBe(true);

    await waitFor(() =>
      audit.calls.some((c) => c.action === 'workflow_started'),
    );
    const row = audit.calls.find((c) => c.action === 'workflow_started')!;
    expect(row.detail?.['name']).toBe('demo');
    expect(typeof row.detail?.['scriptHash']).toBe('string');
    expect((row.detail?.['scriptHash'] as string).length).toBeGreaterThan(0);

    // Security property: the raw script SOURCE text must never appear in any
    // audit record — only name + scriptHash are ever recorded (never the body).
    const serialized = JSON.stringify(audit.calls);
    expect(serialized).not.toContain(SCRIPT);
    expect(serialized).not.toContain("phase('Go')");
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

  it('concurrent double-cancel on a real in-flight run: exactly one 202, one 409, one workflow_cancelled audit row + one SSE frame', async () => {
    const { url, runRegistry, audit, seen } = await setup(500);
    // Two sequential agent() calls: the first is in-flight (500ms stub delay)
    // when cancel arrives — its spawn is aborted and resolves null (design:
    // "spawn failure -> agent() resolves null") — but by the time the script
    // reaches the SECOND agent() call the signal is already aborted, so the
    // sandbox synchronously rejects and the run surfaces as truly 'cancelled'
    // (scriptRunner.ts: `controller.signal.aborted ? 'cancelled' : 'failed'`).
    const TWO_AGENT_SCRIPT = `export const meta = { name: 'demo', description: 'd' };\nphase('Go');\nawait agent('first');\nreturn await agent('second');`;
    const start = await fetch(`${url}/rc/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: TWO_AGENT_SCRIPT }),
    });
    const { runId } = (await start.json()) as { runId: string };
    // Let the background engine progress past its journal-open await and
    // register its internal abort listener before we cancel — otherwise the
    // cancel can race ahead of listener registration and the engine would
    // never observe the abort at all (unrelated engine-internal timing, not
    // what this test is exercising).
    await new Promise((r) => setTimeout(r, 50));

    const [a, b] = await Promise.all([
      fetch(`${url}/rc/workflows/${runId}/cancel`, { method: 'POST' }),
      fetch(`${url}/rc/workflows/${runId}/cancel`, { method: 'POST' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);

    const winner = a.status === 202 ? a : b;
    expect(((await winner.json()) as { status: string }).status).toBe(
      'cancelling',
    );
    const loser = a.status === 202 ? b : a;
    expect(((await loser.json()) as { code: string }).code).toBe(
      'workflow_not_running',
    );

    // Exactly one audit row, written synchronously by the winning caller —
    // no need to wait for the background finish() path.
    expect(
      audit.calls.filter((c) => c.action === 'workflow_cancelled'),
    ).toHaveLength(1);

    // The run only reaches the terminal 'cancelled' status (and its
    // workflow_cancelled SSE frame) once the background engine's finish()
    // observes the aborted signal after in-flight sessions drain.
    await waitFor(() => runRegistry.get(runId)?.status === 'cancelled');
    expect(runRegistry.get(runId)?.status).toBe('cancelled');
    expect(
      seen.filter(
        (e) => e.type === 'workflow_cancelled' && e.workflow.runId === runId,
      ),
    ).toHaveLength(1);
  });
});

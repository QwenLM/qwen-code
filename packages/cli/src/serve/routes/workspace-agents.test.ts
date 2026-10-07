/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  enrollAgentHost,
  heartbeatAgentHost,
  issueAgentHostEnrollment,
  getAgentsDir,
  readWorkspaceAgents,
  updateWorkspaceAgents,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { createSquad } from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import type { SessionAgentLiveRunSummary } from '../session-agents/orchestrator.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceAgentRoutes } from './workspace-agents.js';

const liveRuns = vi.hoisted(() => ({
  value: undefined as SessionAgentLiveRunSummary[] | undefined,
}));

vi.mock('../session-agents/orchestrator.js', () => ({
  getSessionAgentOrchestrator: () =>
    liveRuns.value === undefined
      ? undefined
      : { liveRuns: async () => liveRuns.value },
}));

// The real probe runs `claude --version` and friends; the route only needs
// its answer.
vi.mock('../session-agents/program-probe.js', () => ({
  probeAgentPrograms: async () => [
    { program: 'qwen', available: true },
    { program: 'claude', available: true, version: '2.1.0' },
    { program: 'codex', available: false, reason: 'not found' },
  ],
}));

let runtimeDir: string;

function bridgeStub(sessions: Array<Record<string, string>> = []) {
  return {
    closeSession: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    listWorkspaceSessions: vi.fn(() => sessions),
  } as unknown as WorkspaceRuntime['bridge'];
}

function appFor(runtime: WorkspaceRuntime) {
  const app = express();
  app.use(express.json());
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });
  return app;
}

function runtimeAt(workspaceCwd: string, bridge = bridgeStub()) {
  return {
    workspaceId: 'workspace',
    workspaceCwd,
    primary: true,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
}

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-route-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  liveRuns.value = undefined;
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

it('answers 404 for a workspace whose settings have not opted in', async () => {
  const on = {
    workspaceId: 'on',
    workspaceCwd: path.join(runtimeDir, 'on'),
    primary: true,
    trusted: true,
    bridge: bridgeStub(),
  } as WorkspaceRuntime;
  const off = {
    workspaceId: 'off',
    workspaceCwd: path.join(runtimeDir, 'off'),
    primary: false,
    trusted: true,
    bridge: bridgeStub(),
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([on, off]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: (cwd) => cwd === on.workspaceCwd,
  });

  await request(app)
    .get('/workspaces/off/agent/agents')
    .expect(404, { error: 'agent_collaboration_disabled' });
  // The enabled workspace answers the same route normally.
  await request(app).get('/workspaces/on/agent/agents').expect(200);

  // Nothing is written into the opted-out workspace.
  await expect(fs.stat(getAgentsDir(off.workspaceCwd))).rejects.toThrow();
});

it('reports local programs and agent status from the live session-agent runs', async () => {
  const workspaceCwd = path.join(runtimeDir, 'status');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
    { id: 'ag_bob', name: 'bob', createdAt: 2 },
    {
      id: 'ag_codex',
      name: 'coder',
      createdAt: 3,
      execution: { mode: 'local', provider: 'codex' },
    },
  ]);
  liveRuns.value = [
    {
      sessionId: 's1',
      runId: 'r1',
      agentId: 'ag_alice',
      status: 'running',
    },
    { sessionId: 's1', runId: 'r2', agentId: 'ag_bob', status: 'queued' },
  ];

  const response = await request(appFor(runtimeAt(workspaceCwd)))
    .get('/workspaces/workspace/agent/agents')
    .expect(200);

  expect(response.body.runtime).toMatchObject({
    id: 'local',
    programs: ['qwen', 'claude'],
    runningTaskCount: 1,
    queuedTaskCount: 1,
  });
  expect(response.body.capabilities).toBeUndefined();
  const byId = Object.fromEntries(
    (response.body.agents as Array<{ id: string }>).map((agent) => [
      agent.id,
      agent,
    ]),
  );
  expect(byId['ag_alice']).toMatchObject({ status: 'working', waiting: 0 });
  expect(byId['ag_bob']).toMatchObject({ status: 'idle', waiting: 1 });
  // Codex is not installed here, so the agent cannot run.
  expect(byId['ag_codex']).toMatchObject({ status: 'offline' });
});

it('refuses to retire an agent while it has a live run', async () => {
  const workspaceCwd = path.join(runtimeDir, 'retire-live');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
  ]);
  liveRuns.value = [
    { sessionId: 's1', runId: 'r1', agentId: 'ag_alice', status: 'queued' },
  ];
  const app = appFor(runtimeAt(workspaceCwd));

  await request(app)
    .delete('/workspaces/workspace/agent/agents/ag_alice')
    .expect(409, { error: 'agent_has_live_work' });
  expect((await readWorkspaceAgents(workspaceCwd))[0]?.retiredAt).toBe(
    undefined,
  );

  liveRuns.value = [];
  await request(app)
    .delete('/workspaces/workspace/agent/agents/ag_alice')
    .expect(200);
  expect((await readWorkspaceAgents(workspaceCwd))[0]?.retiredAt).toEqual(
    expect.any(Number),
  );
});

it("closes only the retired agent's hidden sessions", async () => {
  const workspaceCwd = path.join(runtimeDir, 'retire-sessions');
  const bridge = bridgeStub([
    { sessionId: 'alice-session', sourceType: 'agent', sourceId: 'ag_alice' },
    { sessionId: 'bob-session', sourceType: 'agent', sourceId: 'ag_bob' },
  ]);
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
    { id: 'ag_bob', name: 'bob', createdAt: 2 },
  ]);

  await request(appFor(runtimeAt(workspaceCwd, bridge)))
    .delete('/workspaces/workspace/agent/agents/ag_bob')
    .expect(200);

  expect(bridge.closeSession).toHaveBeenCalledWith('bob-session');
  expect(bridge.closeSession).not.toHaveBeenCalledWith('alice-session');
});

it('refuses a local program this machine does not have', async () => {
  const workspaceCwd = path.join(runtimeDir, 'local-program');
  const app = appFor(runtimeAt(workspaceCwd));

  await request(app)
    .post('/workspaces/workspace/agent/agents')
    .send({ name: 'coder', execution: { mode: 'local', provider: 'codex' } })
    .expect(400, { error: 'program_unavailable' });
  await request(app)
    .post('/workspaces/workspace/agent/agents')
    .send({ name: 'claude', execution: { mode: 'local', provider: 'claude' } })
    .expect(200);
  expect((await readWorkspaceAgents(workspaceCwd))[0]?.execution).toEqual({
    mode: 'local',
    provider: 'claude',
  });
});

it('refuses an agent named like a squad', async () => {
  const workspaceCwd = path.join(runtimeDir, 'squad-name');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
  ]);
  await createSquad(workspaceCwd, { name: 'crew', leaderAgentId: 'ag_lead' });

  await request(appFor(runtimeAt(workspaceCwd)))
    .post('/workspaces/workspace/agent/agents')
    .send({ name: 'Crew' })
    .expect(409, { error: 'A squad named "Crew" already exists.' });
  expect(
    (await readWorkspaceAgents(workspaceCwd)).map((agent) => agent.name),
  ).toEqual(['lead']);
});

it('shows an online host offering the bound program when the first host is offline', async () => {
  const workspaceCwd = path.join(runtimeDir, 'multi-host');
  const hosts: Array<{ id: string }> = [];
  for (const [name, providers] of [
    ['offline', ['Qwen Code ACP']],
    ['wrong-program', ['Codex']],
    ['available', ['Qwen Code ACP']],
  ] as const) {
    const { token } = await issueAgentHostEnrollment(workspaceCwd);
    const enrolled = await enrollAgentHost(workspaceCwd, {
      token,
      name,
      workspaceCwd: `/remote/${name}`,
      providers: [...providers],
    });
    hosts.push(enrolled.host);
    if (name !== 'offline') {
      await heartbeatAgentHost(
        workspaceCwd,
        enrolled.host.id,
        enrolled.secret,
        {
          workspaceCwd: `/remote/${name}`,
          providers: [...providers],
        },
      );
    }
  }
  await updateWorkspaceAgents(workspaceCwd, () => [
    {
      id: 'ag_remote',
      name: 'remote',
      createdAt: 1,
      execution: {
        mode: 'managed-host',
        hostIds: hosts.map((host) => host.id),
        provider: 'qwen',
      },
    },
  ]);
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd,
    primary: true,
    trusted: true,
    bridge: bridgeStub(),
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => (_req, _res, next) => next(),
    isAgentCollaborationEnabledFor: () => true,
  });
  const response = await request(app)
    .get('/workspaces/workspace/agent/agents')
    .expect(200);
  expect(response.body.agents[0]).toMatchObject({
    status: 'idle',
    runtime: { id: hosts[2]!.id, label: 'available', status: 'online' },
  });
});

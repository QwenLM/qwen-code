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
  readAgentHosts,
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
  endRunsForRemovedHost: vi.fn(async () => 0),
}));

vi.mock('../session-agents/orchestrator.js', () => ({
  getSessionAgentOrchestrator: () =>
    liveRuns.value === undefined
      ? undefined
      : {
          liveRuns: async () => liveRuns.value,
          endRunsForRemovedHost: liveRuns.endRunsForRemovedHost,
        },
}));

// The orchestrator a roster change has to create for itself when this daemon
// has not made one yet (the state right after a restart).
const ensuring = vi.hoisted(() => ({
  orchestrator: undefined as
    | { liveRuns: () => Promise<SessionAgentLiveRunSummary[]> }
    | undefined,
}));

vi.mock('./session-agents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-agents.js')>()),
  ensureSessionAgentOrchestratorForRuntime: () => ensuring.orchestrator,
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
  ensuring.orchestrator = undefined;
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

it('refuses to move an agent while it has a live session-agent run', async () => {
  const workspaceCwd = path.join(runtimeDir, 'move-live');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
  ]);
  liveRuns.value = [
    { sessionId: 's1', runId: 'r1', agentId: 'ag_alice', status: 'running' },
  ];

  await request(appFor(runtimeAt(workspaceCwd)))
    .patch('/workspaces/workspace/agent/agents/ag_alice')
    .send({ execution: { mode: 'local', provider: 'claude' } })
    .expect(409, { error: 'agent_has_live_work' });
  expect(
    (await readWorkspaceAgents(workspaceCwd))[0]?.execution,
  ).toBeUndefined();
});

it('refuses to disable an agent whose queued run would be stranded', async () => {
  const workspaceCwd = path.join(runtimeDir, 'disable-queued');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
  ]);
  const app = appFor(runtimeAt(workspaceCwd));
  liveRuns.value = [
    { sessionId: 's1', runId: 'r1', agentId: 'ag_alice', status: 'queued' },
  ];

  // A disabled agent is not addressable, so that run can never start and
  // nothing settles it: the agent could then neither run nor be retired.
  await request(app)
    .patch('/workspaces/workspace/agent/agents/ag_alice')
    .send({ enabled: false })
    .expect(409, { error: 'agent_has_live_work' });
  expect((await readWorkspaceAgents(workspaceCwd))[0]?.enabled).not.toBe(false);

  // A run already executing does not block the disable: it finishes.
  liveRuns.value = [
    { sessionId: 's1', runId: 'r1', agentId: 'ag_alice', status: 'running' },
  ];
  await request(app)
    .patch('/workspaces/workspace/agent/agents/ag_alice')
    .send({ enabled: false })
    .expect(200);
  expect((await readWorkspaceAgents(workspaceCwd))[0]?.enabled).toBe(false);
});

it('sees a run an earlier daemon left queued before a roster change', async () => {
  const workspaceCwd = path.join(runtimeDir, 'restart-live');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
  ]);
  // This daemon has not created the workspace's orchestrator yet, so the
  // roster routes have to create one — its startup recovery is what adopts
  // that run — instead of reading "no live runs" and retiring over it.
  ensuring.orchestrator = {
    liveRuns: async () => [
      {
        sessionId: 's1',
        runId: 'run_persisted_1',
        agentId: 'ag_alice',
        status: 'queued',
      },
    ],
  };

  await request(appFor(runtimeAt(workspaceCwd)))
    .delete('/workspaces/workspace/agent/agents/ag_alice')
    .expect(409, { error: 'agent_has_live_work' });
  expect(
    (await readWorkspaceAgents(workspaceCwd))[0]?.retiredAt,
  ).toBeUndefined();

  ensuring.orchestrator = undefined;
  await request(appFor(runtimeAt(workspaceCwd)))
    .delete('/workspaces/workspace/agent/agents/ag_alice')
    .expect(200);
});

it('disables an agent and reports it offline', async () => {
  const workspaceCwd = path.join(runtimeDir, 'disable-agent');
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
  ]);
  const app = appFor(runtimeAt(workspaceCwd));

  await request(app)
    .patch('/workspaces/workspace/agent/agents/ag_alice')
    .send({ enabled: false })
    .expect(200, { id: 'ag_alice', enabled: false, updated: true });

  // The 200 echoes the patch; the roster proves it was written (the store
  // answers 'updated' even when nothing was).
  expect((await readWorkspaceAgents(workspaceCwd))[0]?.enabled).toBe(false);

  const listed = await request(app)
    .get('/workspaces/workspace/agent/agents')
    .expect(200);
  expect(listed.body.agents[0]).toMatchObject({
    id: 'ag_alice',
    enabled: false,
    status: 'offline',
  });
});

it('ends the runs a removed Host leaves stranded', async () => {
  const workspaceCwd = path.join(runtimeDir, 'remove-host');
  const { token } = await issueAgentHostEnrollment(workspaceCwd);
  const { host } = await enrollAgentHost(workspaceCwd, {
    token,
    name: 'gone',
    workspaceCwd: '/remote/gone',
    providers: ['Qwen Code ACP'],
  });
  await updateWorkspaceAgents(workspaceCwd, () => [
    {
      id: 'ag_alice',
      name: 'alice',
      createdAt: 1,
      execution: { mode: 'managed-host', hostIds: [host.id] },
    },
  ]);
  liveRuns.value = [];

  await request(appFor(runtimeAt(workspaceCwd)))
    .delete(`/workspaces/workspace/agent/hosts/${host.id}`)
    .expect(200, { agentsMadeLocal: ['ag_alice'] });
  expect(liveRuns.endRunsForRemovedHost).toHaveBeenCalledWith(host.id, [
    'ag_alice',
  ]);
});

it('answers a committed host removal even when ending its runs fails', async () => {
  const workspaceCwd = path.join(runtimeDir, 'remove-host-dirty-sessions');
  const { token } = await issueAgentHostEnrollment(workspaceCwd);
  const { host } = await enrollAgentHost(workspaceCwd, {
    token,
    name: 'gone',
    workspaceCwd: '/remote/gone',
    providers: ['Qwen Code ACP'],
  });
  await updateWorkspaceAgents(workspaceCwd, () => [
    {
      id: 'ag_alice',
      name: 'alice',
      createdAt: 1,
      execution: { mode: 'managed-host', hostIds: [host.id] },
    },
  ]);
  liveRuns.value = [];
  // The post-commit cleanup stumbles on a damaged session-agents file.
  liveRuns.endRunsForRemovedHost.mockRejectedValueOnce(
    new Error('Malformed JSON in sessions/s1.json'),
  );
  // The route logs the cleanup failure to stderr instead of answering 5xx.
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);

  try {
    await request(appFor(runtimeAt(workspaceCwd)))
      .delete(`/workspaces/workspace/agent/hosts/${host.id}`)
      .expect(200, { agentsMadeLocal: ['ag_alice'] });

    expect(
      stderr.mock.calls.some(([chunk]) =>
        String(chunk).includes('Malformed JSON in sessions/s1.json'),
      ),
    ).toBe(true);
  } finally {
    stderr.mockRestore();
  }

  expect(
    (await readAgentHosts(workspaceCwd)).some(
      (candidate) => candidate.id === host.id,
    ),
  ).toBe(false);
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
          protocol: 2,
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

it.each([undefined, 1])(
  'does not advertise or bind a Host with legacy protocol %s',
  async (protocol) => {
    const workspaceCwd = path.join(runtimeDir, 'legacy-host');
    const { token } = await issueAgentHostEnrollment(workspaceCwd);
    const enrolled = await enrollAgentHost(workspaceCwd, {
      token,
      name: 'legacy',
      workspaceCwd: '/remote/legacy',
      providers: ['Qwen Code ACP'],
    });
    await heartbeatAgentHost(workspaceCwd, enrolled.host.id, enrolled.secret, {
      workspaceCwd: '/remote/legacy',
      providers: ['Qwen Code ACP'],
      ...(protocol !== undefined ? { protocol } : {}),
    });
    await updateWorkspaceAgents(workspaceCwd, () => [
      { id: 'ag_local', name: 'local', createdAt: 1 },
    ]);
    const app = appFor(runtimeAt(workspaceCwd));
    const response = await request(app)
      .get('/workspaces/workspace/agent/agents')
      .expect(200);
    expect(response.body.runtimes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: enrolled.host.id,
          programs: [],
          status: 'offline',
        }),
      ]),
    );
    const execution = {
      mode: 'managed-host',
      hostIds: [enrolled.host.id],
    };
    await request(app)
      .post('/workspaces/workspace/agent/agents')
      .send({ name: 'remote', execution })
      .expect(400, { error: 'program_unavailable' });
    await request(app)
      .patch('/workspaces/workspace/agent/agents/ag_local')
      .send({ execution: { ...execution, provider: 'qwen' } })
      .expect(400, { error: 'program_unavailable' });
    expect(await readWorkspaceAgents(workspaceCwd)).toEqual([
      { id: 'ag_local', name: 'local', createdAt: 1 },
    ]);
  },
);

it.each(['qwen', 'claude'])(
  'allows inheriting an offline protocol-v2 Host program: %s',
  async (program) => {
    const workspaceCwd = path.join(runtimeDir, 'offline-v2-host');
    const { token } = await issueAgentHostEnrollment(workspaceCwd);
    const enrolled = await enrollAgentHost(workspaceCwd, {
      token,
      name: 'offline',
      workspaceCwd: '/remote/offline',
      providers: [program],
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      await heartbeatAgentHost(
        workspaceCwd,
        enrolled.host.id,
        enrolled.secret,
        {
          workspaceCwd: '/remote/offline',
          providers: [program],
          protocol: 2,
        },
      );
    } finally {
      clock.mockRestore();
    }
    const app = appFor(runtimeAt(workspaceCwd));
    const response = await request(app)
      .get('/workspaces/workspace/agent/agents')
      .expect(200);
    expect(response.body.runtimes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: enrolled.host.id,
          programs: [program],
          status: 'offline',
        }),
      ]),
    );
    const execution = { mode: 'managed-host', hostIds: [enrolled.host.id] };
    const created = await request(app)
      .post('/workspaces/workspace/agent/agents')
      .send({ name: 'remote', execution })
      .expect(200);
    await request(app)
      .patch(`/workspaces/workspace/agent/agents/${created.body.id}`)
      .send({ execution: { ...execution, provider: program } })
      .expect(200);
  },
);

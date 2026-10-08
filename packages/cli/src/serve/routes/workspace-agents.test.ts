/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  createThread,
  enrollAgentHost,
  heartbeatAgentHost,
  issueAgentHostEnrollment,
  getAgentsDir,
  readThread,
  readWorkspaceAgents,
  updateWorkspaceAgents,
  writeThread,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { createSquad } from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import type { ThreadRun } from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import { publishAgentEvent } from '../workspace-agents/agent-events.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { SessionAgentLiveRunSummary } from '../session-agents/orchestrator.js';
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
    recordHeartbeat: vi.fn(),
    spawnOrAttach: vi.fn().mockResolvedValue({ sessionId: 'agent-host' }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    listWorkspaceSessions: vi.fn(() => sessions),
    sendPrompt: vi.fn(),
    resumeSession: vi.fn(),
    getSessionStatsStatus: vi.fn(),
    getHeartbeatState: vi.fn(),
    enqueueMidTurnMessage: vi.fn(),
  } as unknown as WorkspaceRuntime['bridge'];
}

async function writeRunningThread(
  workspaceCwd: string,
  agentId: string,
  sessionId: string,
) {
  const thread = await createThread(workspaceCwd, { title: 'Running' });
  const run: ThreadRun = {
    id: 'rn_1',
    agentId,
    sessionId,
    status: 'running',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    queuedAt: 1,
    startedAt: 2,
    attempts: 1,
  };
  await writeThread(workspaceCwd, {
    ...thread,
    status: 'in_progress',
    runs: [run],
  });
  return thread;
}

const stopRecovery: Array<() => void> = [];

/**
 * Routes over one runtime with the thread recovery loop stopped, so a test
 * about the roster sees only the requests it makes. Stopped again after the
 * test: a request that dispatches starts a host-session owner after this
 * first stop, and the stop closure also stops every owner it finds.
 */
function appFor(runtime: WorkspaceRuntime) {
  const app = express();
  app.use(express.json());
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });
  const stop = app.locals['stopWorkspaceAgentRecovery'] as
    | (() => void)
    | undefined;
  if (stop) {
    stop();
    stopRecovery.push(stop);
  }
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
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-route-events-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  liveRuns.value = undefined;
});

afterEach(async () => {
  for (const stop of stopRecovery.splice(0)) stop();
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

it('answers 404 for a workspace whose settings have not opted in', async () => {
  const on = {
    workspaceId: 'on',
    workspaceCwd: path.join(runtimeDir, 'on'),
    primary: true,
    trusted: true,
  } as WorkspaceRuntime;
  const off = {
    workspaceId: 'off',
    workspaceCwd: path.join(runtimeDir, 'off'),
    primary: false,
    trusted: true,
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([on, off]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: (cwd) => cwd === on.workspaceCwd,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const disabled = await fetch(
      `http://127.0.0.1:${address.port}/workspaces/off/agent/events`,
    );
    expect(disabled.status).toBe(404);
    await expect(disabled.json()).resolves.toEqual({
      error: 'agent_collaboration_disabled',
    });

    // The enabled workspace answers the same route normally.
    const enabled = await fetch(
      `http://127.0.0.1:${address.port}/workspaces/on/agent/events`,
    );
    expect(enabled.status).toBe(200);
    await enabled.body?.cancel();

    // Recovery visits `on` (creating its store) before `off`; once it has,
    // the opted-out workspace must still have nothing written into it.
    await vi.waitFor(() => fs.stat(getAgentsDir(on.workspaceCwd)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.stat(getAgentsDir(off.workspaceCwd))).rejects.toThrow();
  } finally {
    (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('closes an event stream before a replacement runtime can publish to it', async () => {
  const primary = {
    workspaceId: 'primary',
    workspaceCwd: path.join(runtimeDir, 'primary'),
    primary: true,
    trusted: true,
  } as WorkspaceRuntime;
  const guard = createWorkspaceGenerationGuard();
  const secondary = {
    workspaceId: 'secondary',
    workspaceCwd: path.join(runtimeDir, 'secondary'),
    primary: false,
    trusted: true,
    generationGuard: guard,
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/workspaces/secondary/agent/events`,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: changed');
    await vi.waitFor(() => fs.stat(getAgentsDir(primary.workspaceCwd)));

    guard.close();
    publishAgentEvent(secondary.workspaceCwd, {
      type: 'progress',
      threadId: 'th_replacement',
      runId: 'rn_replacement',
      attempt: 1,
      sessionId: 'replacement',
      stage: 'responding',
      detail: '',
      outputText: 'private replacement output',
      thoughtText: '',
      activityAt: 1,
    });

    await expect(reader.read()).resolves.toMatchObject({ done: true });
  } finally {
    (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('cancels agent sessions before stranding runs when a workspace opts out', async () => {
  const workspaceCwd = path.join(runtimeDir, 'off-with-live-run');
  const bridge = bridgeStub([
    {
      sessionId: 'agent-session',
      sourceType: 'agent',
      sourceId: 'ag_alice',
    },
  ]);
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1 },
  ]);
  const created = await writeRunningThread(
    workspaceCwd,
    'ag_alice',
    'agent-session',
  );
  const runtime = {
    workspaceId: 'off',
    workspaceCwd,
    primary: true,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => false,
  });

  await vi.waitFor(() => {
    expect(bridge.cancelSession).toHaveBeenCalledWith('agent-session');
  });
  expect(bridge.closeSession).toHaveBeenCalledWith('agent-session');
  await expect(readThread(workspaceCwd, created.id)).resolves.toMatchObject({
    status: 'blocked',
    runs: [
      expect.objectContaining({
        status: 'failed',
        closeKind: 'stranded',
        failureStage: 'collaboration-disabled',
      }),
    ],
  });
  (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
});

it('tears down the owner after disabling the last addressable agent', async () => {
  const workspaceCwd = path.join(runtimeDir, 'last-agent-disabled');
  const bridge = bridgeStub();
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd,
    primary: true,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });

  const created = await request(app)
    .post('/workspaces/workspace/agent/agents')
    .send({ name: 'alice' })
    .expect(200);
  expect(bridge.spawnOrAttach).toHaveBeenCalledTimes(1);

  await request(app)
    .patch(`/workspaces/workspace/agent/agents/${created.body.id}`)
    .send({ enabled: false })
    .expect(200, {
      id: created.body.id,
      enabled: false,
      updated: true,
    });
  expect(bridge.closeSession).toHaveBeenCalledWith('agent-host');
  (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
});

it('keeps a running agent session alive when disabling the last agent', async () => {
  const workspaceCwd = path.join(runtimeDir, 'last-agent-running');
  const sessions: Array<Record<string, string>> = [];
  const bridge = bridgeStub(sessions);
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd,
    primary: true,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });

  const created = await request(app)
    .post('/workspaces/workspace/agent/agents')
    .send({ name: 'alice' })
    .expect(200);
  sessions.push({
    sessionId: 'agent-session',
    sourceType: 'agent',
    sourceId: created.body.id,
  });
  await writeRunningThread(workspaceCwd, created.body.id, 'agent-session');
  vi.mocked(bridge.closeSession).mockClear();

  await request(app)
    .patch(`/workspaces/workspace/agent/agents/${created.body.id}`)
    .send({ enabled: false })
    .expect(200);

  expect(bridge.closeSession).not.toHaveBeenCalled();
  expect(bridge.cancelSession).not.toHaveBeenCalled();
  (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
});

it('keeps another disabled agent running when retiring the last enabled agent', async () => {
  const workspaceCwd = path.join(runtimeDir, 'retire-with-running-peer');
  const sessions = [
    {
      sessionId: 'alice-session',
      sourceType: 'agent',
      sourceId: 'ag_alice',
    },
  ];
  const bridge = bridgeStub(sessions);
  await updateWorkspaceAgents(workspaceCwd, () => [
    { id: 'ag_alice', name: 'alice', createdAt: 1, enabled: false },
    { id: 'ag_bob', name: 'bob', createdAt: 2 },
  ]);
  await writeRunningThread(workspaceCwd, 'ag_alice', 'alice-session');
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd,
    primary: true,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([runtime]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });
  (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();

  await request(app)
    .delete('/workspaces/workspace/agent/agents/ag_bob')
    .expect(200);

  expect(bridge.closeSession).not.toHaveBeenCalledWith('alice-session');
  expect(bridge.cancelSession).not.toHaveBeenCalledWith('alice-session');
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
  try {
    const response = await request(app)
      .get('/workspaces/workspace/agent/agents')
      .expect(200);
    expect(response.body.agents[0]).toMatchObject({
      status: 'idle',
      runtime: { id: hosts[2]!.id, label: 'available', status: 'online' },
    });
  } finally {
    (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
  }
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

  // No thread runs here, so the counts are the session-agent runs alone.
  expect(response.body.runtime).toMatchObject({
    id: 'local',
    programs: ['qwen', 'claude'],
    runningTaskCount: 1,
    queuedTaskCount: 1,
  });
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

it('refuses to retire an agent while it has a live session-agent run', async () => {
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

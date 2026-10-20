/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerAgentHostRemoteConnectRoute,
  registerAgentHostRuntimeRoutes,
} from './agent-host-connection.js';

const {
  issueEnrollment,
  writeStderrLine,
  startConnection,
  stopConnection,
  saveConnection,
  removeConnection,
} = vi.hoisted(() => ({
  issueEnrollment: vi.fn(),
  writeStderrLine: vi.fn(),
  startConnection: vi.fn(),
  stopConnection: vi.fn(),
  saveConnection: vi.fn(),
  removeConnection: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/agents/workspace-agents/store.js', () => ({
  issueAgentHostEnrollment: issueEnrollment,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine }));
vi.mock('../agent-host-client.js', () => ({
  startAgentHostConnection: startConnection,
  stopAgentHostConnection: stopConnection,
  normalizeServerUrl: (value: string) => value.replace(/\/$/, ''),
}));
vi.mock('../agent-host-connections.js', () => ({
  saveAgentHostConnection: saveConnection,
  removeAgentHostConnection: removeConnection,
}));
vi.mock('../agent-host-programs.js', () => ({
  getHostProgramProbe: async () => [
    { program: 'qwen', available: true },
    { program: 'claude', available: true, version: '2.1.0' },
    { program: 'codex', available: false, reason: 'not installed' },
  ],
  availablePrograms: (probes: Array<{ program: string; available: boolean }>) =>
    probes.filter((probe) => probe.available).map((probe) => probe.program),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it.each(['service', 'enrollment'] as const)(
  'stops remote connect when the selected runtime changes during %s',
  async (stage) => {
    const original = {
      workspaceId: 'workspace',
      workspaceCwd: '/selected',
      generationGuard: createWorkspaceGenerationGuard(),
    } as WorkspaceRuntime;
    let current = original;
    const fetch = vi.fn(async () => {
      if (stage === 'service') current = { ...original };
      return new Response(JSON.stringify({ protocol: 2, providers: ['qwen'] }));
    });
    vi.stubGlobal('fetch', fetch);
    issueEnrollment.mockImplementation(async () => {
      current = { ...original };
      return { token: 'must-not-leave-this-runtime' };
    });
    const app = express();
    app.use(express.json());
    registerAgentHostRemoteConnectRoute(
      app,
      '/agent',
      () => current,
      () => (_req, _res, next) => next(),
    );
    const response = await request(app)
      .post('/agent/hosts/remote-connect')
      .send({
        remoteUrl: 'https://worker.example',
        serverUrl: 'https://coordinator.example',
        remoteCwd: '/remote',
        remoteToken: 'remote-token',
        provider: 'qwen',
      });
    expect(response.status).toBe(409);
    expect(fetch).toHaveBeenCalledOnce();
    expect(issueEnrollment).toHaveBeenCalledTimes(stage === 'service' ? 0 : 1);
  },
);

it.each([
  [
    'an http remote',
    'http://192.168.1.20:4170',
    'https://coordinator.example',
    true,
  ],
  [
    'an http callback',
    'https://worker.example',
    'http://192.168.1.10:4170',
    true,
  ],
  ['loopback http', 'http://127.0.0.1:4171', 'http://localhost:4170', false],
  ['https', 'https://worker.example', 'https://coordinator.example', false],
] as const)(
  'warns before issuing an enrollment token over %s only when cleartext leaves the machine',
  async (_label, remoteUrl, serverUrl, warns) => {
    const runtime = {
      workspaceId: 'workspace',
      workspaceCwd: '/selected',
      generationGuard: createWorkspaceGenerationGuard(),
    } as WorkspaceRuntime;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocol: 2,
              providers: ['qwen'],
              connected: true,
            }),
          ),
      ),
    );
    issueEnrollment.mockImplementation(async () => {
      expect(writeStderrLine).toHaveBeenCalledTimes(warns ? 1 : 0);
      return { token: 'enrollment-token' };
    });
    const app = express();
    app.use(express.json());
    registerAgentHostRemoteConnectRoute(
      app,
      '/agent',
      () => runtime,
      () => (_req, _res, next) => next(),
    );

    const response = await request(app)
      .post('/agent/hosts/remote-connect')
      .send({
        remoteUrl,
        serverUrl,
        remoteCwd: '/remote',
        remoteToken: 'remote-token',
        provider: 'qwen',
        allowHttp: true,
      });

    expect(response.status).toBe(200);
    expect(issueEnrollment).toHaveBeenCalledOnce();
    if (warns)
      expect(writeStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('enrollment token'),
      );
    else expect(writeStderrLine).not.toHaveBeenCalled();
  },
);

it('rejects a Host connection when the runtime has no generation guard', async () => {
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd: '/selected',
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerAgentHostRuntimeRoutes(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );

  const response = await request(app).post('/agent/hosts/connect').send({
    serverUrl: 'https://coordinator.example',
    workspaceId: 'workspace',
    enrollmentToken: 'fresh-token',
    provider: 'qwen',
  });

  expect(response.status).toBe(409);
});

function runtimeApp(runtime: WorkspaceRuntime) {
  const app = express();
  app.use(express.json());
  registerAgentHostRuntimeRoutes(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );
  return app;
}

const selected = () =>
  ({
    workspaceId: 'workspace',
    workspaceCwd: '/selected',
    generationGuard: createWorkspaceGenerationGuard(),
  }) as WorkspaceRuntime;

it('describes this daemon as a v2 Host with its probed programs', async () => {
  const response = await request(runtimeApp(selected())).get(
    '/agent/hosts/service',
  );

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    protocol: 2,
    workspaceCwd: '/selected',
    providers: ['qwen', 'claude'],
  });
  expect(response.body.programs).toHaveLength(3);
});

it('connects without a provider and remembers the connection', async () => {
  startConnection.mockResolvedValue(undefined);
  saveConnection.mockResolvedValue(undefined);

  const response = await request(runtimeApp(selected()))
    .post('/agent/hosts/connect')
    .send({
      serverUrl: 'https://coordinator.example/',
      workspaceId: 'ws_1',
      enrollmentToken: 'fresh-token',
    });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    connected: true,
    providers: ['qwen', 'claude'],
  });
  expect(startConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      serverUrl: 'https://coordinator.example',
      workspaceId: 'ws_1',
      enrollmentToken: 'fresh-token',
      allowHttp: false,
    }),
  );
  expect(saveConnection).toHaveBeenCalledWith({
    serverUrl: 'https://coordinator.example',
    workspaceId: 'ws_1',
    workspaceCwd: '/selected',
    allowHttp: false,
  });
});

it('disconnects and forgets a saved connection', async () => {
  stopConnection.mockReturnValue(false);
  removeConnection.mockResolvedValue(true);

  const response = await request(runtimeApp(selected()))
    .delete('/agent/hosts/connect')
    .send({ serverUrl: 'https://coordinator.example', workspaceId: 'ws_1' });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ disconnected: true });
  expect(removeConnection).toHaveBeenCalledWith({
    serverUrl: 'https://coordinator.example',
    workspaceId: 'ws_1',
    workspaceCwd: '/selected',
    allowHttp: false,
  });
});

it('refuses to pull in a remote that speaks the v1 Host protocol', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ protocol: 1, providers: ['qwen'] })),
    ),
  );
  const runtime = selected();
  const app = express();
  app.use(express.json());
  registerAgentHostRemoteConnectRoute(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );

  const response = await request(app).post('/agent/hosts/remote-connect').send({
    remoteUrl: 'https://worker.example',
    serverUrl: 'https://coordinator.example',
    remoteCwd: '/remote',
    remoteToken: 'remote-token',
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/older Agent Host protocol/);
  expect(issueEnrollment).not.toHaveBeenCalled();
});

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
import { registerAgentHostConnectionRoutes } from './agent-host-connection.js';

const { issueEnrollment, writeStderrLine } = vi.hoisted(() => ({
  issueEnrollment: vi.fn(),
  writeStderrLine: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/agents/workspace-agents/store.js', () => ({
  issueAgentHostEnrollment: issueEnrollment,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine }));
vi.mock('../agent-host-client.js', () => ({
  startAgentHostConnection: vi.fn(),
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
      return new Response(JSON.stringify({ protocol: 1, providers: ['qwen'] }));
    });
    vi.stubGlobal('fetch', fetch);
    issueEnrollment.mockImplementation(async () => {
      current = { ...original };
      return { token: 'must-not-leave-this-runtime' };
    });
    const app = express();
    app.use(express.json());
    registerAgentHostConnectionRoutes(
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
              protocol: 1,
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
    registerAgentHostConnectionRoutes(
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
  registerAgentHostConnectionRoutes(
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

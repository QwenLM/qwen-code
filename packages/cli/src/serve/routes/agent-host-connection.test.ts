/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { registerAgentHostConnectionRoutes } from './agent-host-connection.js';

const { issueEnrollment } = vi.hoisted(() => ({
  issueEnrollment: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/agents/workspace-agents/store.js', () => ({
  issueAgentHostEnrollment: issueEnrollment,
}));
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

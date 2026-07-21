/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerWorkspaceMcpControlRoutes } from './workspace-mcp-control.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';

function makeApp(trusted = true) {
  const app = express();
  app.use(express.json());
  const manageMcpServer = vi.fn(async (serverName, action) => ({
    serverName,
    action,
    ok: true as const,
  }));
  const workspaceRuntime = {
    workspaceCwd: '/workspace',
    trusted,
    bridge: {
      manageMcpServer,
      isChannelLive: () => true,
      getRuntimeEpoch: () => 1,
    },
    workspaceService: {
      getWorkspaceMcpStatus: vi.fn(async () => ({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        source: 'live',
        runtimeEpoch: 1,
        discoveryState: 'completed',
        servers: [],
      })),
    },
  } as never as WorkspaceRuntime;
  registerWorkspaceMcpControlRoutes(app, {
    boundWorkspace: '/workspace',
    workspaceRuntime,
    bridge: workspaceRuntime.bridge,
    workspace: {} as never,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    sendBridgeError: vi.fn(),
    parseAndValidateClientId: () => 'client-1',
  });
  return {
    app,
    manageMcpServer,
    coordinator: getWorkspaceRuntimeCoordinator(workspaceRuntime),
  };
}

describe('legacy primary MCP runtime control', () => {
  it.each(['enable', 'disable'] as const)(
    'preserves legacy %s behavior',
    async (action) => {
      const { app, manageMcpServer, coordinator } = makeApp();
      const runMcpRuntimeMutation = vi.spyOn(
        coordinator,
        'runMcpRuntimeMutation',
      );

      const response = await request(app).post(`/workspace/mcp/docs/${action}`);

      expect(response.status).toBe(200);
      expect(manageMcpServer).toHaveBeenCalledWith('docs', action, 'client-1');
      expect(runMcpRuntimeMutation).toHaveBeenCalledOnce();
    },
  );

  it('preserves approve semantics', async () => {
    const { app, manageMcpServer } = makeApp();

    const response = await request(app).post('/workspace/mcp/docs/approve');

    expect(response.status).toBe(200);
    expect(manageMcpServer).toHaveBeenCalledWith(
      'docs',
      'approve',
      'client-1',
      expect.any(String),
    );
  });

  it('rejects MCP control for an untrusted primary workspace', async () => {
    const { app, manageMcpServer } = makeApp(false);

    const response = await request(app).post('/workspace/mcp/docs/approve');

    expect(response.status).toBe(403);
    expect(manageMcpServer).not.toHaveBeenCalled();
  });
});

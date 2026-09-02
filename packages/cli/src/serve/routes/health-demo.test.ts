/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createSingleWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { createHealthDemoRoutes } from './health-demo.js';

function makeRuntime(): WorkspaceRuntime {
  return {
    workspaceId: 'ws-primary',
    workspaceCwd: '/work/primary',
    primary: true,
    trusted: true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {},
    workspaceService: {},
    routeFileSystemFactory: {},
    clientMcpSenderRegistry: {},
  } as unknown as WorkspaceRuntime;
}

function makeApp(workspaceRegistry: WorkspaceRegistry) {
  const app = express();
  const { register } = createHealthDemoRoutes({
    opts: { hostname: '127.0.0.1', requireAuth: false },
    getPort: () => 4321,
    workspaceRegistry,
    getActiveSseCount: () => 0,
    getRateLimiter: () => undefined,
  });
  register(app);
  return app;
}

describe('createHealthDemoRoutes /health', () => {
  it('returns 503 degraded when a workspace entry is blocked', async () => {
    const registry = createSingleWorkspaceRegistry(makeRuntime());
    registry.beginReplacement(registry.primaryEntry, 'policy-2');
    registry.blockReplacement(registry.primaryEntry, 'apply failed');
    const app = makeApp(registry);

    const res = await request(app).get('/health?deep=1');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'degraded',
      reason: 'workspace_runtime_blocked',
    });
  });

  it('returns 200 ok for a shallow probe regardless of entry state', async () => {
    const registry = createSingleWorkspaceRegistry(makeRuntime());
    registry.beginReplacement(registry.primaryEntry, 'policy-2');
    registry.blockReplacement(registry.primaryEntry, 'apply failed');
    const app = makeApp(registry);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

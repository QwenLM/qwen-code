/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { registerWorkspaceQualifiedLifecycleRoutes } from './workspace-lifecycle.js';
import {
  createSingleWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

function createTestRuntime(overrides?: {
  initWorkspace?: ReturnType<typeof vi.fn>;
  reload?: ReturnType<typeof vi.fn>;
}) {
  const initWorkspace =
    overrides?.initWorkspace ??
    vi.fn().mockResolvedValue({ action: 'created' });
  const reload =
    overrides?.reload ?? vi.fn().mockResolvedValue({ reloaded: true });
  return {
    runtime: {
      workspaceId: 'workspace-id',
      workspaceCwd: '/workspace',
      primary: true,
      trusted: true,
      removable: false,
      bridge: {},
      workspaceService: { initWorkspace, reload },
    } as unknown as WorkspaceRuntime,
    initWorkspace,
    reload,
  };
}

function createTestApp(runtime: WorkspaceRuntime) {
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedLifecycleRoutes(app, {
    workspaceRegistry: createSingleWorkspaceRegistry(runtime),
    mutate: () => (_req: Request, _res: Response, next: () => void) => next(),
    safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
    sendBridgeError: (res, error) => {
      res.status(500).json({ error: String(error) });
    },
    invalidateServeFeaturesCache: vi.fn(),
  });
  return app;
}

describe('workspace-qualified lifecycle routes', () => {
  it('reconciles trust on reload but not on init', async () => {
    const { runtime } = createTestRuntime();
    const app = createTestApp(runtime);
    const requestTrustReconcile = vi.fn().mockResolvedValue(undefined);
    app.locals['requestTrustReconcile'] = requestTrustReconcile;

    const init = await request(app)
      .post('/workspaces/workspace-id/init')
      .send({});
    expect(init.status).toBe(200);
    expect(requestTrustReconcile).not.toHaveBeenCalled();

    const reloadResponse = await request(app)
      .post('/workspaces/workspace-id/reload')
      .send({});
    expect(reloadResponse.status).toBe(200);
    expect(requestTrustReconcile).toHaveBeenCalledOnce();
  });

  it('reload succeeds even when trust reconciliation rejects', async () => {
    const { runtime, reload } = createTestRuntime();
    const app = createTestApp(runtime);
    const requestTrustReconcile = vi
      .fn()
      .mockRejectedValue(new Error('policy read failure'));
    app.locals['requestTrustReconcile'] = requestTrustReconcile;

    const reloadResponse = await request(app)
      .post('/workspaces/workspace-id/reload')
      .send({});
    expect(reloadResponse.status).toBe(200);
    expect(reloadResponse.body).toEqual({ reloaded: true });
    expect(requestTrustReconcile).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});

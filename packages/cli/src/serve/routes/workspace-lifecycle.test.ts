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

describe('workspace-qualified lifecycle routes', () => {
  it('reconciles trust on reload but not on init', async () => {
    const events: string[] = [];
    const initWorkspace = vi.fn().mockResolvedValue({ action: 'created' });
    const reload = vi.fn(async () => {
      events.push('reload');
      return { reloaded: true };
    });
    const runtime = {
      workspaceId: 'workspace-id',
      workspaceCwd: '/workspace',
      primary: true,
      trusted: true,
      removable: false,
      bridge: {},
      workspaceService: { initWorkspace, reload },
    } as unknown as WorkspaceRuntime;
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
    const requestTrustReconcile = vi.fn(async () => {
      events.push('reconcile');
    });
    app.locals['requestTrustReconcile'] = requestTrustReconcile;

    const init = await request(app)
      .post('/workspaces/workspace-id/init')
      .send({});
    expect(init.status).toBe(200);
    expect(initWorkspace).toHaveBeenCalledOnce();
    expect(requestTrustReconcile).not.toHaveBeenCalled();

    const reloadResponse = await request(app)
      .post('/workspaces/workspace-id/reload')
      .send({});
    expect(reloadResponse.status).toBe(200);
    expect(requestTrustReconcile).toHaveBeenCalledOnce();
    expect(events).toEqual(['reconcile', 'reload']);
  });
});

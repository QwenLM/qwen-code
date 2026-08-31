/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeWorkspaceRuntimeLifecycleSnapshot } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceQualifiedRuntimeRoutes,
  registerWorkspaceRuntimeRoutes,
} from './workspace-runtime.js';
import { WorkspaceRuntimeStillStartingError } from '../workspace-runtime-coordinator.js';

function createRuntime(workspaceCwd = '/workspace') {
  let snapshot: BridgeWorkspaceRuntimeLifecycleSnapshot = {
    state: 'cold',
    runtimeLive: false,
    runtimeEpoch: 0,
    activeWork: false,
  };
  const preheat = vi.fn(async () => {
    snapshot = {
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: snapshot.runtimeEpoch + 1,
      activeWork: false,
    };
  });
  return {
    workspaceCwd,
    workspaceId: `ws-${workspaceCwd}`,
    trusted: true,
    bridge: {
      sessionCount: 0,
      preheat,
      getWorkspaceRuntimeLifecycleSnapshot: () => snapshot,
      publishWorkspaceEvent: vi.fn(),
    },
  } as unknown as WorkspaceRuntime;
}

function createApp(
  runtime: WorkspaceRuntime,
  options: {
    denyStrictMutations?: boolean;
    runtimeState?: 'active' | 'transitioning';
  } = {},
) {
  const app = express();
  app.use(express.json());
  const workspaceRegistry = {
    primaryEntry: {
      state: options.runtimeState ?? 'active',
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      current: { runtime },
    },
  } as unknown as WorkspaceRegistry;
  registerWorkspaceRuntimeRoutes(app, {
    workspaceRegistry,
    mutate:
      (gateOptions) => (_req: Request, res: Response, next: NextFunction) => {
        if (gateOptions?.strict && options.denyStrictMutations) {
          res.status(401).json({ code: 'token_required' });
          return;
        }
        next();
      },
    safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
    sendBridgeError,
  });
  return app;
}

describe('workspace runtime routes', () => {
  it('starts the primary runtime without capability selection', async () => {
    const runtime = createRuntime();

    const response = await request(createApp(runtime)).post(
      '/workspace/runtime/ensure',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: 1,
    });
    expect(runtime.bridge.preheat).toHaveBeenCalledWith({
      keepAliveMs: 600_000,
    });
  });

  it('rejects parameters on the unified ensure route', async () => {
    const runtime = createRuntime();

    const response = await request(createApp(runtime))
      .post('/workspace/runtime/ensure')
      .send({ capabilities: ['mcp'] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(
      'workspace_runtime_ensure_takes_no_parameters',
    );
    expect(runtime.bridge.preheat).not.toHaveBeenCalled();
  });

  it('trust-gates the primary runtime routes', async () => {
    const runtime = createRuntime();
    (runtime as { trusted: boolean }).trusted = false;

    const response = await request(createApp(runtime)).get(
      '/workspace/runtime/status',
    );

    expect(response.status).toBe(403);
  });

  it('uses the ordinary mutation gate for ensure', async () => {
    const response = await request(
      createApp(createRuntime(), { denyStrictMutations: true }),
    ).post('/workspace/runtime/ensure');

    expect(response.status).toBe(200);
  });

  it('maps initialization failures to a retryable 503 response', async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.bridge.preheat).mockRejectedValue(
      new Error('child failed'),
    );

    const response = await request(createApp(runtime)).post(
      '/workspace/runtime/ensure',
    );

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).toEqual({
      error: 'Workspace runtime failed to initialize',
      code: 'runtime_initialization_failed',
    });
  });

  it('maps observer timeouts to a retryable 503 response', async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.bridge.preheat).mockRejectedValue(
      new WorkspaceRuntimeStillStartingError(),
    );

    const response = await request(createApp(runtime)).post(
      '/workspace/runtime/ensure',
    );

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).toEqual({
      error: 'Workspace runtime is still starting',
      code: 'runtime_still_starting',
    });
  });

  it.each([
    ['GET', '/workspace/runtime/status'],
    ['POST', '/workspace/runtime/ensure'],
  ])('returns 501 when %s %s is unsupported', async (method, path) => {
    const runtime = createRuntime();
    delete runtime.bridge.getWorkspaceRuntimeLifecycleSnapshot;
    const agent = request(createApp(runtime));

    const response =
      method === 'GET' ? await agent.get(path) : await agent.post(path);

    expect(response.status).toBe(501);
    expect(response.body.code).toBe('workspace_runtime_not_supported');
  });

  it.each([
    ['GET', '/workspace/runtime/status'],
    ['POST', '/workspace/runtime/ensure'],
  ])(
    'returns a retryable 503 while the primary runtime is transitioning for %s %s',
    async (method, path) => {
      const runtime = createRuntime();
      const agent = request(
        createApp(runtime, { runtimeState: 'transitioning' }),
      );

      const response =
        method === 'GET' ? await agent.get(path) : await agent.post(path);

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.body).toMatchObject({
        code: 'workspace_runtime_unavailable',
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
      });
      expect(runtime.bridge.preheat).not.toHaveBeenCalled();
    },
  );

  it('resolves a qualified runtime without falling back to primary', async () => {
    const primary = createRuntime('/primary');
    const secondary = createRuntime('/secondary');
    const registry = {
      primaryEntry: {
        state: 'active',
        workspaceId: primary.workspaceId,
        workspaceCwd: primary.workspaceCwd,
        current: { runtime: primary },
      },
      getEntryByWorkspaceId: vi.fn((workspaceId: string) =>
        workspaceId === secondary.workspaceId
          ? {
              state: 'active',
              workspaceId: secondary.workspaceId,
              workspaceCwd: secondary.workspaceCwd,
              current: { runtime: secondary },
            }
          : undefined,
      ),
    } as unknown as WorkspaceRegistry;
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedRuntimeRoutes(app, {
      workspaceRegistry: registry,
      mutate: () => (_req, _res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      sendBridgeError,
    });

    const selected = await request(app).get(
      `/workspaces/${encodeURIComponent(secondary.workspaceId)}/runtime/status`,
    );
    const missing = await request(app).get(
      '/workspaces/missing/runtime/status',
    );

    expect(selected.status).toBe(200);
    expect(selected.body.workspaceCwd).toBe('/secondary');
    expect(missing.status).toBe(400);
    expect(primary.bridge.preheat).not.toHaveBeenCalled();
  });
});

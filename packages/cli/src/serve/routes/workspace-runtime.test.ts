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
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { sendBridgeError } from '../server/error-response.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';
import {
  registerWorkspaceQualifiedRuntimeRoutes,
  registerWorkspaceRuntimeRoutes,
} from './workspace-runtime.js';

function createHarness(
  options: { denyStrictMutations?: boolean; mapBridgeErrors?: boolean } = {},
) {
  let live = false;
  const preheatAcpChild = vi.fn(async () => {
    live = true;
    return { ready: true, channelLive: true, durationMs: 1 };
  });
  const runtime = {
    workspaceCwd: '/workspace',
    trusted: true,
    bridge: {
      get sessionCount() {
        return 0;
      },
      isChannelLive: () => live,
      getRuntimeEpoch: () => (live ? 1 : 0),
      publishWorkspaceEvent: vi.fn(),
      getWorkspaceExtensionsStatus: vi.fn(async () => ({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: live,
        ...(live ? { runtimeEpoch: 1 } : {}),
        extensions: [],
      })),
      refreshWorkspaceExtensions: vi.fn(async () => ({
        refreshed: 0,
        failed: 0,
        generation: 1,
        runtimeEpoch: live ? 1 : 0,
      })),
      getWorkspaceToolsStatus: vi.fn(async () => ({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        runtimeEpoch: 1,
        tools: [],
      })),
      manageMcpServer: vi.fn(async (serverName, action) => ({
        serverName,
        action,
        ok: true,
        runtimeEpoch: live ? 1 : 0,
      })),
    },
    workspaceService: {
      preheatAcpChild,
      getWorkspaceSkillsStatus: vi.fn(async () => ({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        source: 'live',
        runtimeEpoch: 1,
        skills: [],
      })),
      getWorkspaceMcpStatus: vi.fn(async () => ({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        source: 'live',
        runtimeEpoch: 1,
        discoveryState: 'completed',
        servers: [
          {
            kind: 'mcp_server',
            name: 'docs',
            status: 'ok',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
            authenticationState: 'pending',
          },
        ],
      })),
    },
  } as unknown as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerWorkspaceRuntimeRoutes(app, {
    workspaceRuntime: runtime,
    mutate:
      (gateOptions) => (_req: Request, res: Response, next: NextFunction) => {
        if (gateOptions?.strict && options.denyStrictMutations) {
          res.status(401).json({ code: 'token_required' });
          return;
        }
        next();
      },
    safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
    sendBridgeError: (res, error, context) => {
      if (options.mapBridgeErrors) {
        sendBridgeError(res, error, context);
        return;
      }
      throw error;
    },
  });
  return {
    app,
    runtime,
    preheatAcpChild,
    setLive: (value: boolean) => {
      live = value;
    },
  };
}

describe('workspace runtime routes', () => {
  it('ensures the complete workspace runtime without caller-selected capabilities', async () => {
    const harness = createHarness();

    const response = await request(harness.app).post(
      '/workspace/runtime/ensure',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'idle',
      runtimeLive: true,
      capabilities: {
        extensions: { state: 'ready' },
        mcp: { state: 'ready' },
        skills: { state: 'ready' },
        tools: { state: 'ready' },
      },
    });
    expect(harness.preheatAcpChild).toHaveBeenCalledOnce();
  });

  it('rejects capability selection on the unified ensure route', async () => {
    const harness = createHarness();

    const response = await request(harness.app)
      .post('/workspace/runtime/ensure')
      .send({ capabilities: ['mcp'] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(
      'workspace_runtime_ensure_takes_no_parameters',
    );
    expect(harness.preheatAcpChild).not.toHaveBeenCalled();
  });

  it('trust-gates the primary workspace runtime API', async () => {
    const harness = createHarness();
    (harness.runtime as unknown as { trusted: boolean }).trusted = false;

    const response = await request(harness.app).get(
      '/workspace/runtime/status',
    );

    expect(response.status).toBe(403);
  });

  it('reads the extensions Catalog without starting the runtime', async () => {
    const harness = createHarness();

    const response = await request(harness.app).get(
      '/workspace/runtime/extensions',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      extensions: [],
    });
    expect(harness.preheatAcpChild).not.toHaveBeenCalled();
    expect(
      harness.runtime.bridge.getWorkspaceExtensionsStatus,
    ).toHaveBeenCalledOnce();
  });

  it('reads extensions from only the qualified workspace runtime', async () => {
    const primary = createHarness();
    const getSecondaryExtensions = vi.fn(async () => ({
      v: 1,
      workspaceCwd: '/secondary',
      initialized: true,
      runtimeEpoch: 7,
      extensions: [],
    }));
    const secondary = {
      ...primary.runtime,
      workspaceId: 'secondary-id',
      workspaceCwd: '/secondary',
      primary: false,
      bridge: {
        ...primary.runtime.bridge,
        getWorkspaceExtensionsStatus: getSecondaryExtensions,
      },
    } as WorkspaceRuntime;
    const registry = {
      primary: primary.runtime,
      getByWorkspaceId: (workspaceId: string) =>
        workspaceId === secondary.workspaceId ? secondary : undefined,
    } as unknown as WorkspaceRegistry;
    const app = express();
    registerWorkspaceQualifiedRuntimeRoutes(app, {
      workspaceRegistry: registry,
      mutate: () => (_req, _res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      sendBridgeError: (_res, error) => {
        throw error;
      },
    });

    const response = await request(app).get(
      '/workspaces/secondary-id/runtime/extensions',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceCwd: '/secondary',
      runtimeEpoch: 7,
    });
    expect(getSecondaryExtensions).toHaveBeenCalledOnce();
    expect(
      primary.runtime.bridge.getWorkspaceExtensionsStatus,
    ).not.toHaveBeenCalled();
    expect(primary.preheatAcpChild).not.toHaveBeenCalled();
  });

  it('ensures only the resolved qualified workspace runtime', async () => {
    const primary = createHarness();
    const selected = createHarness();
    Object.assign(selected.runtime, {
      workspaceId: 'secondary-id',
      workspaceCwd: '/secondary',
      primary: false,
    });
    const registry = {
      primary: primary.runtime,
      getByWorkspaceId: (workspaceId: string) =>
        workspaceId === 'secondary-id' ? selected.runtime : undefined,
    } as unknown as WorkspaceRegistry;
    const app = express();
    registerWorkspaceQualifiedRuntimeRoutes(app, {
      workspaceRegistry: registry,
      mutate: () => (_req, _res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      sendBridgeError: (_res, error) => {
        throw error;
      },
    });

    const response = await request(app).post(
      '/workspaces/secondary-id/runtime/ensure',
    );

    expect(response.status).toBe(200);
    expect(response.body.workspaceCwd).toBe('/secondary');
    expect(selected.preheatAcpChild).toHaveBeenCalledOnce();
    expect(primary.preheatAcpChild).not.toHaveBeenCalled();
  });

  it('strict-gates runtime initialization', async () => {
    const harness = createHarness({ denyStrictMutations: true });

    const ensured = await request(harness.app).post(
      '/workspace/runtime/ensure',
    );
    expect(ensured.status).toBe(401);
    expect(ensured.body.code).toBe('token_required');
    expect(harness.preheatAcpChild).not.toHaveBeenCalled();
  });

  it('maps coordinator drain admission to the standard 503 response', async () => {
    const harness = createHarness({ mapBridgeErrors: true });
    getWorkspaceRuntimeCoordinator(harness.runtime).beginDrain();

    const response = await request(harness.app)
      .post('/workspace/runtime/ensure')
      .send({});

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).toMatchObject({
      code: 'workspace_draining',
      workspaceCwd: '/workspace',
    });
  });
});

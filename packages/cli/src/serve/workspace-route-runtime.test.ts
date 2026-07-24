/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  createSingleWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import { resolveWorkspaceRuntimeFromParam } from './workspace-route-runtime.js';

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

function makeResponse(): Response {
  const response = {
    set: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as unknown as Response;
}

describe('resolveWorkspaceRuntimeFromParam', () => {
  it('returns retryable unavailable for a registered transitioning workspace', () => {
    const registry = createSingleWorkspaceRegistry(makeRuntime());
    registry.beginReplacement(registry.primaryEntry, 'policy-2');
    const response = makeResponse();

    expect(
      resolveWorkspaceRuntimeFromParam(
        registry,
        { params: { workspace: 'ws-primary' } } as unknown as Request,
        response,
      ),
    ).toBeNull();
    expect(response.set).toHaveBeenCalledWith('Retry-After', '1');
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Workspace runtime is not active.',
      code: 'workspace_runtime_unavailable',
      workspaceCwd: '/work/primary',
      workspaceId: 'ws-primary',
    });
  });

  it('keeps unknown workspaces distinct from unavailable registrations', () => {
    const registry = createSingleWorkspaceRegistry(makeRuntime());
    const response = makeResponse();

    expect(
      resolveWorkspaceRuntimeFromParam(
        registry,
        { params: { workspace: 'missing' } } as unknown as Request,
        response,
      ),
    ).toBeNull();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: '`:workspace` must decode to a workspace id or absolute path',
      code: 'workspace_mismatch',
    });
  });
});

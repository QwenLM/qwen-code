/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import type { WorkspaceGitState } from '../workspace-git-state.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceGitRoutes,
  registerWorkspaceQualifiedGitRoutes,
} from './workspace-git.js';

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
  } as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

describe('workspace Git routes', () => {
  it('returns Git status for the bound workspace', async () => {
    const app = express();
    const bridge = runtime('primary', '/work/main', true).bridge;
    const getStatus = vi.fn(async () => ({
      v: 1 as const,
      workspaceCwd: '/work/main',
      branch: 'main',
    }));
    registerWorkspaceGitRoutes(app, {
      boundWorkspace: '/work/main',
      bridge,
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      branch: 'main',
    });
    expect(getStatus).toHaveBeenCalledWith('/work/main', bridge, {
      wait: false,
    });
  });

  it('passes wait:true through to the bound workspace git state', async () => {
    const app = express();
    const bridge = runtime('primary', '/work/main', true).bridge;
    const getStatus = vi.fn(async () => ({
      v: 1 as const,
      workspaceCwd: '/work/main',
      branch: 'main',
    }));
    registerWorkspaceGitRoutes(app, {
      boundWorkspace: '/work/main',
      bridge,
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git?wait=1');

    expect(response.status).toBe(200);
    expect(getStatus).toHaveBeenCalledWith('/work/main', bridge, {
      wait: true,
    });
  });

  it('returns a structured error when bound Git status fails', async () => {
    const app = express();
    const bridge = runtime('primary', '/work/main', true).bridge;
    const getStatus = vi.fn(async () => {
      throw Object.assign(new Error('git failed'), {
        code: 'git_status_failed',
      });
    });
    registerWorkspaceGitRoutes(app, {
      boundWorkspace: '/work/main',
      bridge,
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'git failed',
      code: 'git_status_failed',
    });
  });

  it('uses the selected trusted workspace runtime', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const secondary = runtime('secondary', '/work/secondary', true);
    const getStatus = vi.fn(async () => ({
      v: 1 as const,
      workspaceCwd: secondary.workspaceCwd,
      branch: 'feature/web-shell',
    }));
    registerWorkspaceQualifiedGitRoutes(app, {
      workspaceRegistry: registry([primary, secondary]),
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/secondary/git');

    expect(response.status).toBe(200);
    expect(response.body.branch).toBe('feature/web-shell');
    expect(getStatus).toHaveBeenCalledWith(
      secondary.workspaceCwd,
      secondary.bridge,
      { wait: false },
    );
  });

  it('passes wait:true through to the qualified workspace git state', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const getStatus = vi.fn(async () => ({
      v: 1 as const,
      workspaceCwd: primary.workspaceCwd,
      branch: 'main',
    }));
    registerWorkspaceQualifiedGitRoutes(app, {
      workspaceRegistry: registry([primary]),
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/git?wait=1');

    expect(response.status).toBe(200);
    expect(getStatus).toHaveBeenCalledWith(
      primary.workspaceCwd,
      primary.bridge,
      {
        wait: true,
      },
    );
  });

  it('rejects an untrusted workspace before reading Git status', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const untrusted = runtime('untrusted', '/work/untrusted', false);
    const getStatus = vi.fn();
    registerWorkspaceQualifiedGitRoutes(app, {
      workspaceRegistry: registry([primary, untrusted]),
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/untrusted/git');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('rejects an unknown workspace before reading Git status', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const getStatus = vi.fn();
    registerWorkspaceQualifiedGitRoutes(app, {
      workspaceRegistry: registry([primary]),
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/missing/git');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'workspace_mismatch',
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('returns a structured error when qualified Git status fails', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const getStatus = vi.fn(async () => {
      throw Object.assign(new Error('qualified git failed'), {
        data: { reason: 'watcher' },
      });
    });
    registerWorkspaceQualifiedGitRoutes(app, {
      workspaceRegistry: registry([primary]),
      gitState: { getStatus } as unknown as WorkspaceGitState,
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/git');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: 'qualified git failed',
      data: { reason: 'watcher' },
    });
  });
});

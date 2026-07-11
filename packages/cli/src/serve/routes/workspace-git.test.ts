/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { WorkspaceGitState } from '../workspace-git-state.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
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
  return {
    primary: runtimes[0]!,
    list: () => runtimes,
    getByWorkspaceCwd: (cwd) =>
      runtimes.find((item) => item.workspaceCwd === cwd),
    getByWorkspaceId: (id) => runtimes.find((item) => item.workspaceId === id),
    resolveWorkspaceCwd: (cwd) =>
      cwd === undefined
        ? runtimes[0]
        : runtimes.find((item) => item.workspaceCwd === cwd),
    resolveLiveSessionOwner: () => ({ kind: 'not_found' }),
    add: () => {},
  };
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
    });

    const response = await request(app).get('/workspace/git');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      branch: 'main',
    });
    expect(getStatus).toHaveBeenCalledWith('/work/main', bridge);
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
    });

    const response = await request(app).get('/workspaces/secondary/git');

    expect(response.status).toBe(200);
    expect(response.body.branch).toBe('feature/web-shell');
    expect(getStatus).toHaveBeenCalledWith(
      secondary.workspaceCwd,
      secondary.bridge,
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
    });

    const response = await request(app).get('/workspaces/untrusted/git');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(getStatus).not.toHaveBeenCalled();
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listGitWorktrees,
  pruneGitWorktrees,
  removeGitWorktree,
} from '@qwen-code/qwen-code-core/utils/git-worktrees.js';
import { getGitWorkingTreeStatus } from '@qwen-code/qwen-code-core/utils/gitDiff.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceQualifiedGitWorktreeRoutes } from './workspace-git-worktrees.js';

vi.mock('@qwen-code/qwen-code-core/utils/git-worktrees.js', () => ({
  listGitWorktrees: vi.fn(),
  pruneGitWorktrees: vi.fn(),
  removeGitWorktree: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/utils/gitDiff.js', () => ({
  getGitWorkingTreeStatus: vi.fn(),
}));

const listMock = vi.mocked(listGitWorktrees);
const pruneMock = vi.mocked(pruneGitWorktrees);
const removeMock = vi.mocked(removeGitWorktree);
const statusMock = vi.mocked(getGitWorkingTreeStatus);

const passthroughMutate = () =>
  ((_req: unknown, _res: unknown, next: () => void) => next()) as never;

const MAIN = {
  path: '/work/main',
  head: 'a'.repeat(40),
  branch: 'main',
  detached: false,
  bare: false,
  isMain: true,
};
const LINKED = {
  path: '/work/main/.qwen/worktrees/swift-fox',
  head: 'b'.repeat(40),
  branch: 'qwen/swift-fox',
  detached: false,
  bare: false,
  isMain: false,
};
const OUTSIDE = {
  path: '/elsewhere/scratch',
  head: 'c'.repeat(40),
  branch: null,
  detached: true,
  bare: false,
  isMain: false,
};

const CLEAN = {
  branch: 'qwen/swift-fox',
  detached: false,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  stashCount: 0,
};

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
  liveSessions: Array<{ worktree?: { path: string } }> = [],
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    env: { mode: 'parent-process', overlayKeys: [], effectiveEnv: {} },
    bridge: {
      publishWorkspaceEvent: vi.fn(),
      listWorkspaceSessions: () => liveSessions,
    } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

function mount(runtimes: WorkspaceRuntime[]) {
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedGitWorktreeRoutes(app, {
    workspaceRegistry: registry(runtimes),
    sendBridgeError,
    mutate: passthroughMutate,
  });
  return app;
}

describe('workspace git worktree routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([MAIN, LINKED, OUTSIDE]);
    statusMock.mockResolvedValue(CLEAN);
    removeMock.mockResolvedValue(undefined);
    pruneMock.mockResolvedValue(undefined);
  });

  it('lists worktrees of the selected workspace with workspace and slug marks', async () => {
    const app = mount([
      runtime('primary', '/work/other', true),
      runtime('secondary', '/work/main', true),
    ]);
    const response = await request(app).get(
      '/workspaces/secondary/git/worktrees',
    );
    expect(response.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith('/work/main', {});
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      available: true,
      worktrees: [
        { ...MAIN, isWorkspace: true },
        { ...LINKED, isWorkspace: false, slug: 'swift-fox' },
        { ...OUTSIDE, isWorkspace: false },
      ],
    });
  });

  it('reports available:false when git cannot list the repository', async () => {
    listMock.mockRejectedValue(new Error('not a git repository'));
    const app = mount([runtime('primary', '/work/main', true)]);
    const response = await request(app).get(
      '/workspaces/primary/git/worktrees',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      available: false,
      worktrees: [],
    });
  });

  it('refuses an untrusted workspace', async () => {
    const app = mount([runtime('primary', '/work/main', false)]);
    const response = await request(app).get(
      '/workspaces/primary/git/worktrees',
    );
    expect(response.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns the working-tree status of a listed worktree only', async () => {
    const app = mount([runtime('primary', '/work/main', true)]);
    const ok = await request(app).get(
      `/workspaces/primary/git/worktrees/status?path=${encodeURIComponent(LINKED.path)}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      v: 1,
      path: LINKED.path,
      available: true,
      staged: 0,
      untracked: 0,
    });
    expect(statusMock).toHaveBeenCalledWith(LINKED.path);

    const unknown = await request(app).get(
      '/workspaces/primary/git/worktrees/status?path=%2Fnot%2Fa%2Fworktree',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('worktree_not_found');
    expect(statusMock).toHaveBeenCalledTimes(1);

    const missing = await request(app).get(
      '/workspaces/primary/git/worktrees/status',
    );
    expect(missing.status).toBe(400);
  });

  it('removes a clean, idle linked worktree', async () => {
    const app = mount([runtime('primary', '/work/main', true)]);
    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: true, path: LINKED.path });
    expect(removeMock).toHaveBeenCalledWith(
      '/work/main',
      LINKED.path,
      { force: false },
      {},
    );
  });

  it('never removes the main worktree or a registered workspace', async () => {
    const app = mount([
      runtime('primary', '/work/main', true),
      runtime('secondary', OUTSIDE.path, true),
    ]);
    const main = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: MAIN.path, force: true });
    expect(main.status).toBe(409);
    expect(main.body.code).toBe('worktree_is_main');

    const workspace = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: OUTSIDE.path, force: true });
    expect(workspace.status).toBe(409);
    expect(workspace.body.code).toBe('worktree_is_workspace');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('refuses a dirty worktree until force is given, then force-removes it', async () => {
    statusMock.mockResolvedValue({ ...CLEAN, unstaged: 2, untracked: 1 });
    const app = mount([runtime('primary', '/work/main', true)]);
    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'worktree_dirty', changes: 3 });
    expect(removeMock).not.toHaveBeenCalled();

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });
    expect(forced.status).toBe(200);
    expect(removeMock).toHaveBeenCalledWith(
      '/work/main',
      LINKED.path,
      { force: true },
      {},
    );
  });

  it('refuses a worktree with live sessions until force is given', async () => {
    const app = mount([
      runtime('primary', '/work/main', true, [
        { worktree: { path: LINKED.path } },
        { worktree: { path: '/work/main/.qwen/worktrees/other' } },
        {},
      ]),
    ]);
    const refused = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'worktree_in_use',
      sessions: 1,
    });
    expect(statusMock).not.toHaveBeenCalled();

    const forced = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path, force: true });
    expect(forced.status).toBe(200);
  });

  it('prunes instead of removing when the directory is already gone', async () => {
    listMock.mockResolvedValue([
      MAIN,
      { ...LINKED, prunable: 'gitdir file points to non-existent location' },
    ]);
    const app = mount([runtime('primary', '/work/main', true)]);
    const response = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: LINKED.path });
    expect(response.status).toBe(200);
    expect(pruneMock).toHaveBeenCalledWith('/work/main', {});
    expect(removeMock).not.toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown path and a missing body path', async () => {
    const app = mount([runtime('primary', '/work/main', true)]);
    const unknown = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({ path: '/not/listed' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('worktree_not_found');

    const missing = await request(app)
      .post('/workspaces/primary/git/worktrees/remove')
      .send({});
    expect(missing.status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });
});

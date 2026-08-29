/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSingleWorkspaceRegistry,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import {
  resolveContainedCwd,
  resolveContainedCwdOrFail,
  resolveSessionManagedGitCwd,
  resolveSessionManagedGitCwdForRoute,
  resolveRegisteredWorkspaceRuntimeByPathSelector,
  resolveTrustedRuntime,
  resolveWorkspaceRuntimeFromParam,
  resolveWorkspaceRuntimeWithLiveCompatibilityFromParam,
} from './workspace-route-runtime.js';
import { createWorkspaceRuntimeSessionService } from './workspace-runtime-storage.js';

function fakeReq(cwd?: unknown): Request {
  return { query: cwd !== undefined ? { cwd } : {} } as Request;
}

describe('resolveContainedCwd', () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns workspaceCwd when cwd is absent', () => {
    expect(resolveContainedCwd(fakeReq(), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd when cwd is an empty string', () => {
    expect(resolveContainedCwd(fakeReq(''), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd when cwd is not a string (array)', () => {
    expect(resolveContainedCwd(fakeReq(['a', 'b']), workspace)).toBe(workspace);
  });

  it('returns the resolved path for a valid subdirectory', () => {
    const sub = path.join(workspace, 'sub');
    fs.mkdirSync(sub);
    expect(resolveContainedCwd(fakeReq(sub), workspace)).toBe(
      fs.realpathSync(sub),
    );
  });

  it('returns the resolved path for a contained directory starting with dotdot', () => {
    const sub = path.join(workspace, '..build');
    fs.mkdirSync(sub);
    expect(resolveContainedCwd(fakeReq(sub), workspace)).toBe(
      fs.realpathSync(sub),
    );
  });

  it('accepts the workspace root itself', () => {
    expect(resolveContainedCwd(fakeReq(workspace), workspace)).toBe(
      fs.realpathSync(workspace),
    );
  });

  it('returns workspaceCwd for a path outside the workspace', () => {
    expect(resolveContainedCwd(fakeReq(outside), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd for a symlink escaping the workspace', () => {
    const link = path.join(workspace, 'link');
    fs.symlinkSync(outside, link);
    expect(resolveContainedCwd(fakeReq(link), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd when the path does not exist', () => {
    const missing = path.join(workspace, 'missing');
    expect(resolveContainedCwd(fakeReq(missing), workspace)).toBe(workspace);
  });
});

describe('resolveContainedCwdOrFail', () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns workspaceCwd when cwd is genuinely absent', () => {
    expect(resolveContainedCwdOrFail(fakeReq(), workspace)).toBe(workspace);
  });

  it('fails closed when cwd is an array (a duplicated ?cwd= param)', () => {
    expect(
      resolveContainedCwdOrFail(fakeReq(['/a', '/b']), workspace),
    ).toBeNull();
  });

  it('fails closed when cwd is an empty string', () => {
    expect(resolveContainedCwdOrFail(fakeReq(''), workspace)).toBeNull();
  });

  it('fails closed when cwd is an object', () => {
    expect(resolveContainedCwdOrFail(fakeReq({}), workspace)).toBeNull();
  });

  it('returns the resolved path for a valid contained cwd', () => {
    const sub = path.join(workspace, 'sub');
    fs.mkdirSync(sub);
    expect(resolveContainedCwdOrFail(fakeReq(sub), workspace)).toBe(
      fs.realpathSync(sub),
    );
  });

  it('returns the resolved path for a contained cwd starting with dotdot', () => {
    const sub = path.join(workspace, '..build');
    fs.mkdirSync(sub);
    expect(resolveContainedCwdOrFail(fakeReq(sub), workspace)).toBe(
      fs.realpathSync(sub),
    );
  });

  it('fails closed for a cwd that escapes the workspace', () => {
    expect(resolveContainedCwdOrFail(fakeReq(outside), workspace)).toBeNull();
  });

  it('fails closed for a symlink escaping the workspace', () => {
    const link = path.join(workspace, 'link');
    fs.symlinkSync(outside, link);
    expect(resolveContainedCwdOrFail(fakeReq(link), workspace)).toBeNull();
  });

  it('fails closed when the path does not exist', () => {
    const missing = path.join(workspace, 'missing');
    expect(resolveContainedCwdOrFail(fakeReq(missing), workspace)).toBeNull();
  });
});

describe('resolveSessionManagedGitCwd', () => {
  let repo: string;
  let runtimeBase: string;
  const sessionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-cwd-'));
    runtimeBase = fs.mkdtempSync(
      path.join(os.tmpdir(), 'managed-git-runtime-'),
    );
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(runtimeBase, { recursive: true, force: true });
  });

  it('authorizes only the live session that owns the managed worktree', () => {
    const worktree = path.join(repo, '.qwen', 'worktrees', 'branch-a');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'worktree-branch-a', worktree, 'HEAD'],
      { cwd: repo },
    );
    fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);
    const runtime = {
      workspaceId: 'primary',
      workspaceCwd: repo,
      sessionRuntimeBaseDir: runtimeBase,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionExecutionSnapshot: () => ({
          workspaceCwd: repo,
          effectiveCwd: worktree,
          worktree: {
            slug: 'branch-a',
            path: worktree,
            branch: 'worktree-branch-a',
          },
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sidecarPath =
      createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
        sessionId,
      );
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        slug: 'branch-a',
        worktreePath: worktree,
        worktreeBranch: 'worktree-branch-a',
        originalCwd: repo,
        originalBranch: 'main',
        originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim(),
      }),
    );

    const owned = {
      query: { cwd: worktree, sessionId },
    } as unknown as Request;
    expect(resolveSessionManagedGitCwd(owned, runtime)).toBe(
      fs.realpathSync(worktree),
    );

    const nested = path.join(worktree, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    const nestedOwned = {
      query: { cwd: nested, sessionId },
    } as unknown as Request;
    expect(resolveSessionManagedGitCwd(nestedOwned, runtime)).toBe(
      fs.realpathSync(nested),
    );

    fs.writeFileSync(path.join(worktree, '.qwen-session'), 'x'.repeat(257));
    expect(resolveSessionManagedGitCwd(owned, runtime)).toBeNull();
    fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);

    const validSidecar = fs.readFileSync(sidecarPath, 'utf8');
    fs.writeFileSync(sidecarPath, '{ malformed');
    const response = makeResponse();
    const sendBridgeError = vi.fn();
    expect(
      resolveSessionManagedGitCwdForRoute(
        owned,
        response,
        runtime,
        'GET /workspaces/:workspace/git',
        sendBridgeError,
      ),
    ).toBeUndefined();
    expect(sendBridgeError).toHaveBeenCalledWith(
      response,
      expect.any(SyntaxError),
      { route: 'GET /workspaces/:workspace/git' },
    );
    expect(response.status).not.toHaveBeenCalled();
    fs.writeFileSync(sidecarPath, validSidecar);

    const unbound = { query: { cwd: worktree } } as unknown as Request;
    expect(resolveSessionManagedGitCwd(unbound, runtime)).toBeNull();

    fs.writeFileSync(path.join(worktree, '.qwen-session'), 'another-session');
    expect(resolveSessionManagedGitCwd(owned, runtime)).toBeNull();

    if (process.platform !== 'win32') {
      const target = path.join(worktree, 'marker-target');
      fs.writeFileSync(target, sessionId);
      fs.rmSync(path.join(worktree, '.qwen-session'));
      fs.symlinkSync(target, path.join(worktree, '.qwen-session'));
      expect(resolveSessionManagedGitCwd(owned, runtime)).toBeNull();
    }

    fs.rmSync(path.join(worktree, '.qwen-session'));
    fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);
    const otherWorktree = path.join(repo, '.qwen', 'worktrees', 'branch-other');
    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-q',
        '-b',
        'worktree-branch-other',
        otherWorktree,
        'HEAD',
      ],
      { cwd: repo },
    );
    fs.writeFileSync(
      path.join(worktree, '.git'),
      fs.readFileSync(path.join(otherWorktree, '.git'), 'utf8'),
    );
    expect(resolveSessionManagedGitCwd(owned, runtime)).toBeNull();
  });

  it('accepts an existing sidecar whose original cwd is a repo subdirectory', () => {
    const workspace = path.join(repo, 'packages', 'app');
    fs.mkdirSync(workspace, { recursive: true });
    const worktree = path.join(repo, '.qwen', 'worktrees', 'branch-b');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'worktree-branch-b', worktree, 'HEAD'],
      { cwd: repo },
    );
    fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);
    const runtime = {
      workspaceId: 'primary',
      workspaceCwd: workspace,
      sessionRuntimeBaseDir: runtimeBase,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionExecutionSnapshot: () => ({
          workspaceCwd: workspace,
          effectiveCwd: worktree,
          worktree: {
            slug: 'branch-b',
            path: worktree,
            branch: 'worktree-branch-b',
          },
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sidecarPath =
      createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
        sessionId,
      );
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        slug: 'branch-b',
        worktreePath: worktree,
        worktreeBranch: 'worktree-branch-b',
        originalCwd: workspace,
        originalBranch: 'main',
        originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim(),
      }),
    );

    const request = {
      query: { cwd: worktree, sessionId },
    } as unknown as Request;
    expect(resolveSessionManagedGitCwd(request, runtime)).toBe(
      fs.realpathSync(worktree),
    );
  });

  it('rejects a standalone repository under the managed worktree root', () => {
    const worktree = path.join(repo, '.qwen', 'worktrees', 'standalone');
    fs.mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);
    const runtime = {
      workspaceId: 'primary',
      workspaceCwd: repo,
      sessionRuntimeBaseDir: runtimeBase,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionExecutionSnapshot: () => ({
          workspaceCwd: repo,
          effectiveCwd: worktree,
          worktree: {
            slug: 'standalone',
            path: worktree,
            branch: 'worktree-standalone',
          },
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sidecarPath =
      createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
        sessionId,
      );
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        slug: 'standalone',
        worktreePath: worktree,
        worktreeBranch: 'worktree-standalone',
        originalCwd: repo,
        originalBranch: 'main',
        originalHeadCommit: '0'.repeat(40),
      }),
    );

    const request = {
      query: { cwd: worktree, sessionId },
    } as unknown as Request;
    expect(resolveSessionManagedGitCwd(request, runtime)).toBeNull();
  });

  it('fails closed when the workspace git probe fails', () => {
    const subdirectory = path.join(repo, 'packages', 'app');
    fs.mkdirSync(subdirectory, { recursive: true });
    const runtime = {
      workspaceCwd: repo,
    } as unknown as WorkspaceRuntime;
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      expect(
        resolveSessionManagedGitCwd(fakeReq(subdirectory), runtime),
      ).toBeNull();
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('allows a contained cwd when the workspace is deterministically non-git', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
    const subdirectory = path.join(workspace, 'packages', 'app');
    fs.mkdirSync(subdirectory, { recursive: true });
    try {
      expect(
        resolveSessionManagedGitCwd(fakeReq(subdirectory), {
          workspaceCwd: workspace,
        } as unknown as WorkspaceRuntime),
      ).toBe(fs.realpathSync(subdirectory));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

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
  it.each(['ws-live', '/work/conversations'])(
    'treats internal selector %s as an ordinary workspace mismatch',
    (selector) => {
      const primary = makeRuntime();
      const internal = {
        ...makeRuntime(),
        workspaceId: 'ws-live',
        workspaceCwd: '/work/conversations',
        primary: false,
        provenance: 'live-conversation' as const,
        removable: false,
      };
      const registry = createWorkspaceRegistry([primary, internal]);
      const response = makeResponse();
      const json = vi.mocked(response.json);

      expect(
        resolveWorkspaceRuntimeFromParam(
          registry,
          { params: { workspace: selector } } as unknown as Request,
          response,
        ),
      ).toBeNull();
      expect(
        resolveRegisteredWorkspaceRuntimeByPathSelector(
          registry,
          internal.workspaceCwd,
        ),
      ).toBeUndefined();
      expect(response.status).toHaveBeenCalledWith(400);
      expect(JSON.stringify(json.mock.calls)).not.toContain(
        internal.workspaceCwd,
      );
      expect(JSON.stringify(json.mock.calls)).not.toContain(
        internal.workspaceId,
      );
    },
  );

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

describe('resolveTrustedRuntime', () => {
  it('returns an active trusted runtime', () => {
    const runtime = makeRuntime();
    const registry = createSingleWorkspaceRegistry(runtime);

    expect(
      resolveTrustedRuntime(
        registry,
        {
          params: { workspace: runtime.workspaceId },
        } as unknown as Request,
        makeResponse(),
      ),
    ).toBe(runtime);
  });

  it('rejects an active untrusted runtime', () => {
    const runtime = { ...makeRuntime(), trusted: false };
    const registry = createSingleWorkspaceRegistry(runtime);
    const response = makeResponse();

    expect(
      resolveTrustedRuntime(
        registry,
        {
          params: { workspace: runtime.workspaceId },
        } as unknown as Request,
        response,
      ),
    ).toBeNull();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Workspace is not trusted.',
      code: 'untrusted_workspace',
    });
  });
});

describe('resolveWorkspaceRuntimeWithLiveCompatibilityFromParam', () => {
  function setup() {
    const primary = makeRuntime();
    const internal = {
      ...makeRuntime(),
      workspaceId: 'ws-live',
      workspaceCwd: '/work/conversations',
      primary: false,
      provenance: 'live-conversation' as const,
      removable: false,
    };
    return {
      internal,
      registry: createWorkspaceRegistry([primary, internal]),
    };
  }

  it.each(['ws-live', '/work/conversations'])(
    'allows the exact internal selector %s only through the explicit seam',
    (selector) => {
      const { internal, registry } = setup();

      expect(
        resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(
          registry,
          { params: { workspace: selector } } as unknown as Request,
          makeResponse(),
        ),
      ).toBe(internal);
    },
  );

  it('does not allow a path alias for the internal runtime', () => {
    const { registry } = setup();
    const response = makeResponse();

    expect(
      resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(
        registry,
        {
          params: { workspace: '/work/conversations/.' },
        } as unknown as Request,
        response,
      ),
    ).toBeNull();
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it('returns a sanitized unavailable response for inactive internal state', () => {
    const { internal, registry } = setup();
    registry.beginDrain(internal);
    const response = makeResponse();

    expect(
      resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(
        registry,
        { params: { workspace: internal.workspaceId } } as unknown as Request,
        response,
      ),
    ).toBeNull();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: 'The Conversations runtime is temporarily unavailable.',
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
  });
});

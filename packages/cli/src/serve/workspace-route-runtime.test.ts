/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSingleWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import {
  resolveContainedCwd,
  resolveContainedCwdOrFail,
  resolveWorkspaceRuntimeFromParam,
} from './workspace-route-runtime.js';

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

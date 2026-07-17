/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGitWorkingTreeStatus,
  resolveBranchName,
  watchRepoBranch,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { WorkspaceGitState } from './workspace-git-state.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  getGitWorkingTreeStatus: vi.fn(),
  resolveBranchName: vi.fn(),
  watchRepoBranch: vi.fn(),
}));

const getGitWorkingTreeStatusMock = vi.mocked(getGitWorkingTreeStatus);
const resolveBranchNameMock = vi.mocked(resolveBranchName);
const watchRepoBranchMock = vi.mocked(watchRepoBranch);

describe('WorkspaceGitState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no working-tree summary, so getStatus returns the branch-only
    // v2 shape. Tests that exercise enriched fields override this.
    getGitWorkingTreeStatusMock.mockResolvedValue(null);
  });

  it('returns the current branch and publishes only real changes', async () => {
    let onChange: (() => void) | undefined;
    const dispose = vi.fn();
    const publishWorkspaceEvent = vi.fn();
    resolveBranchNameMock
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('feature/web-shell');
    watchRepoBranchMock.mockImplementation(async (_cwd, callback) => {
      onChange = callback;
      return dispose;
    });
    const state = new WorkspaceGitState();

    await expect(
      state.getStatus('/workspace', {
        publishWorkspaceEvent,
      } as unknown as AcpSessionBridge),
    ).resolves.toEqual({
      v: 2,
      workspaceCwd: '/workspace',
      branch: 'main',
    });

    onChange?.();
    await vi.waitFor(() =>
      expect(resolveBranchNameMock).toHaveBeenCalledTimes(2),
    );
    expect(publishWorkspaceEvent).not.toHaveBeenCalled();

    onChange?.();
    await vi.waitFor(() =>
      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'git_branch_changed',
        data: { workspaceCwd: '/workspace', branch: 'feature/web-shell' },
      }),
    );

    state.dispose();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it('degrades to the branch-only shape when the working-tree summary throws', async () => {
    resolveBranchNameMock.mockResolvedValue('main');
    watchRepoBranchMock.mockResolvedValue(() => {});
    // Not a graceful `null` — an actual rejection (e.g. an unexpected
    // child_process failure). The `.catch(() => null)` in getStatus must
    // convert it into the branch-only v2 response instead of a thrown error
    // that would 500 every `GET /workspace/git`.
    getGitWorkingTreeStatusMock.mockRejectedValueOnce(
      new Error('git exploded'),
    );
    const state = new WorkspaceGitState();

    await expect(
      state.getStatus('/workspace', {
        publishWorkspaceEvent: vi.fn(),
      } as unknown as AcpSessionBridge),
    ).resolves.toEqual({
      v: 2,
      workspaceCwd: '/workspace',
      branch: 'main',
    });
  });

  it('returns null and keeps the watcher shared for a non-git workspace', async () => {
    resolveBranchNameMock.mockResolvedValue(undefined);
    watchRepoBranchMock.mockResolvedValue(() => {});
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;

    const [first, second] = await Promise.all([
      state.getStatus('/plain', bridge),
      state.getStatus('/plain', bridge),
    ]);

    expect(first.branch).toBeNull();
    expect(second.branch).toBeNull();
    expect(resolveBranchNameMock).toHaveBeenCalledOnce();
    expect(watchRepoBranchMock).toHaveBeenCalledOnce();
  });

  it('retries after entry creation fails', async () => {
    resolveBranchNameMock
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockResolvedValueOnce('main');
    watchRepoBranchMock.mockResolvedValue(() => {});
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;

    await expect(state.getStatus('/retry', bridge)).rejects.toThrow(
      'git unavailable',
    );
    await expect(state.getStatus('/retry', bridge)).resolves.toEqual({
      v: 2,
      workspaceCwd: '/retry',
      branch: 'main',
    });
    expect(resolveBranchNameMock).toHaveBeenCalledTimes(2);
    expect(watchRepoBranchMock).toHaveBeenCalledOnce();
  });

  it('merges the working-tree summary into the v2 status', async () => {
    resolveBranchNameMock.mockResolvedValue('main');
    watchRepoBranchMock.mockResolvedValue(() => {});
    getGitWorkingTreeStatusMock.mockResolvedValue({
      branch: 'main',
      detached: false,
      hasUpstream: true,
      ahead: 2,
      behind: 1,
      staged: 3,
      unstaged: 4,
      untracked: 5,
      conflicted: 7,
      stashCount: 6,
      operation: 'rebase',
    });
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;

    const status = await state.getStatus('/workspace', bridge);
    expect(status).toMatchObject({
      v: 2,
      workspaceCwd: '/workspace',
      branch: 'main',
      detached: false,
      hasUpstream: true,
      ahead: 2,
      behind: 1,
      staged: 3,
      unstaged: 4,
      untracked: 5,
      conflicted: 7,
      stashCount: 6,
      operation: 'rebase',
    });
    expect(typeof status.computedAt).toBe('number');
  });

  it('omits operation when no operation is in progress', async () => {
    resolveBranchNameMock.mockResolvedValue('main');
    watchRepoBranchMock.mockResolvedValue(() => {});
    getGitWorkingTreeStatusMock.mockResolvedValue({
      branch: 'main',
      detached: false,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      stashCount: 0,
    });
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;

    const status = await state.getStatus('/workspace', bridge);
    expect(status).not.toHaveProperty('operation');
  });

  it('prefers the watcher branch over the summary branch when detached', async () => {
    // resolveBranchName yields the short SHA for a detached HEAD; the summary
    // reports branch=null + detached. The chip should still show the SHA.
    resolveBranchNameMock.mockResolvedValue('a1b2c3d');
    watchRepoBranchMock.mockResolvedValue(() => {});
    getGitWorkingTreeStatusMock.mockResolvedValue({
      branch: null,
      detached: true,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      stashCount: 0,
    });
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;

    await expect(state.getStatus('/workspace', bridge)).resolves.toMatchObject({
      branch: 'a1b2c3d',
      detached: true,
    });
  });

  it('disposes only the removed workspace watcher', async () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    resolveBranchNameMock.mockResolvedValue('main');
    watchRepoBranchMock
      .mockResolvedValueOnce(firstDispose)
      .mockResolvedValueOnce(secondDispose);
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;
    await state.getStatus('/first', bridge);
    await state.getStatus('/second', bridge);

    state.disposeWorkspace('/first');
    await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledOnce());
    expect(secondDispose).not.toHaveBeenCalled();

    state.dispose();
    await vi.waitFor(() => expect(secondDispose).toHaveBeenCalledOnce());
  });

  it('keeps a replacement entry when the disposed creation later fails', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstBranch = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    resolveBranchNameMock
      .mockReturnValueOnce(firstBranch)
      .mockResolvedValue('main');
    watchRepoBranchMock.mockResolvedValue(vi.fn());
    const state = new WorkspaceGitState();
    const bridge = {
      publishWorkspaceEvent: vi.fn(),
    } as unknown as AcpSessionBridge;

    const first = state.getStatus('/same', bridge);
    state.disposeWorkspace('/same');
    await expect(state.getStatus('/same', bridge)).resolves.toMatchObject({
      branch: 'main',
    });
    rejectFirst(new Error('old watcher failed'));
    await expect(first).rejects.toThrow('old watcher failed');

    await expect(state.getStatus('/same', bridge)).resolves.toMatchObject({
      branch: 'main',
    });
    expect(resolveBranchNameMock).toHaveBeenCalledTimes(2);
    state.dispose();
  });
});

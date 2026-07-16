/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBranchName, watchRepoBranch } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { WorkspaceGitState } from './workspace-git-state.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  resolveBranchName: vi.fn(),
  watchRepoBranch: vi.fn(),
}));

const resolveBranchNameMock = vi.mocked(resolveBranchName);
const watchRepoBranchMock = vi.mocked(watchRepoBranch);

describe('WorkspaceGitState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      v: 1,
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
      v: 1,
      workspaceCwd: '/retry',
      branch: 'main',
    });
    expect(resolveBranchNameMock).toHaveBeenCalledTimes(2);
    expect(watchRepoBranchMock).toHaveBeenCalledOnce();
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

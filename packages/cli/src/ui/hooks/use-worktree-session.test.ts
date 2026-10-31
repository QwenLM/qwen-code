/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { WorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { useWorktreeSession } from './useWorktreeSession.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn<(path: string) => Promise<WorktreeSession | null>>(),
  mkdir: vi.fn(),
  watch: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/services/worktreeSessionService.js', () => ({
  readWorktreeSession: mocks.read,
}));
vi.mock('node:fs', () => ({ default: { watch: mocks.watch } }));
vi.mock('node:fs/promises', () => ({ default: { mkdir: mocks.mkdir } }));

const worktree: WorktreeSession = {
  slug: 'one',
  worktreePath: '/repo/.worktrees/one',
  worktreeBranch: 'worktree/one',
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHeadCommit: 'a'.repeat(40),
};

describe('useWorktreeSession session ownership', () => {
  let sessionId: string;
  let config: Config;
  let watchers: Array<{
    notify: (event: string, file: string | null) => void;
    close: ReturnType<typeof vi.fn>;
  }>;
  beforeEach(() => {
    vi.clearAllMocks();
    sessionId = 'first';
    config = {
      getSessionId: () => sessionId,
      getSessionService: () => ({
        getWorktreeSessionPath: (id: string) => `/sessions/${id}.worktree.json`,
      }),
      getShellExecutionSandbox: () => undefined,
    } as unknown as Config;
    watchers = [];
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.read.mockResolvedValue(worktree);
    mocks.watch.mockImplementation((_path, notify) => {
      const watcher = { notify, close: vi.fn() };
      watchers.push(watcher);
      return watcher;
    });
  });

  it('rebinds the sidecar and clears the old value before a resumed session loads', async () => {
    const { result, rerender, unmount } = renderHook(() =>
      useWorktreeSession(config),
    );
    await waitFor(() => expect(result.current).toBe(worktree));
    await waitFor(() => expect(watchers).toHaveLength(1));
    let resolveSecond!: (value: WorktreeSession | null) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    sessionId = 'second';
    rerender();
    expect(result.current).toBeNull();
    expect(watchers[0].close).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenLastCalledWith(
      '/sessions/second.worktree.json',
    );
    const next = { ...worktree, slug: 'two', worktreeBranch: 'worktree/two' };
    await act(async () => resolveSecond(next));
    expect(result.current).toBe(next);
    await waitFor(() => expect(watchers).toHaveLength(2));
    unmount();
    expect(watchers[1].close).toHaveBeenCalledOnce();
  });

  it('ignores a late read from the previous session', async () => {
    let finishOld!: (value: WorktreeSession | null) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const { result, rerender } = renderHook(() => useWorktreeSession(config));
    const next = { ...worktree, slug: 'new' };
    mocks.read.mockResolvedValue(next);
    sessionId = 'second';
    rerender();
    await waitFor(() => expect(result.current).toBe(next));
    await act(async () => finishOld(worktree));
    expect(result.current).toBe(next);
  });

  it('does not install the old watcher if mkdir resolves after session replacement', async () => {
    let finishMkdir!: () => void;
    mocks.mkdir.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishMkdir = resolve;
        }),
    );
    const { rerender, unmount } = renderHook(() => useWorktreeSession(config));
    sessionId = 'second';
    rerender();
    await waitFor(() => expect(watchers).toHaveLength(1));
    await act(async () => finishMkdir());
    expect(watchers).toHaveLength(1);
    unmount();
    expect(watchers[0].close).toHaveBeenCalledOnce();
  });

  it('reloads on the owned sidecar or an unnamed directory event and handles deletion', async () => {
    const { result } = renderHook(() => useWorktreeSession(config));
    await waitFor(() => expect(watchers).toHaveLength(1));
    await waitFor(() => expect(result.current).toBe(worktree));
    act(() => watchers[0].notify('rename', 'unrelated.worktree.json'));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    mocks.read.mockResolvedValueOnce(null);
    await act(async () => watchers[0].notify('rename', 'first.worktree.json'));
    expect(result.current).toBeNull();
    await act(async () => watchers[0].notify('change', null));
    expect(result.current).toBe(worktree);
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it('does not access host sidecars while tool sandboxing is active', async () => {
    config = {
      ...config,
      getShellExecutionSandbox: () => ({ network: 'closed' }),
    } as Config;
    const { result } = renderHook(() => useWorktreeSession(config));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
  });
});

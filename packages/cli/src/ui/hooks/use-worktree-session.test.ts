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
import { prepareFileWatchersForProcessExit } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';
import { useWorktreeSession } from './useWorktreeSession.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn<(path: string) => Promise<WorktreeSession | null>>(),
  mkdir: vi.fn(),
  watch: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/services/worktreeSessionService.js', () => ({
  readWorktreeSession: mocks.read,
}));
vi.mock('node:fs', () => ({
  default: {
    watch: mocks.watch,
    watchFile: mocks.watchFile,
    unwatchFile: mocks.unwatchFile,
  },
}));
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
  let subscriptions: Array<{ path: string; notify: () => void }>;
  beforeEach(() => {
    vi.resetAllMocks();
    sessionId = 'first';
    config = {
      getSessionId: () => sessionId,
      getSessionService: () => ({
        getWorktreeSessionPath: (id: string) => `/sessions/${id}.worktree.json`,
      }),
      getShellExecutionSandbox: () => undefined,
    } as unknown as Config;
    subscriptions = [];
    mocks.read.mockResolvedValue(worktree);
    mocks.watchFile.mockImplementation((path, _options, notify) => {
      subscriptions.push({ path, notify });
    });
  });

  it('rebinds the sidecar and clears the old value before a resumed session loads', async () => {
    const { result, rerender, unmount } = renderHook(() =>
      useWorktreeSession(config),
    );
    await waitFor(() => expect(result.current).toBe(worktree));
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
    expect(mocks.unwatchFile).toHaveBeenCalledWith(
      '/sessions/first.worktree.json',
      subscriptions[0].notify,
    );
    expect(mocks.read).toHaveBeenLastCalledWith(
      '/sessions/second.worktree.json',
    );
    const next = { ...worktree, slug: 'two', worktreeBranch: 'worktree/two' };
    await act(async () => resolveSecond(next));
    expect(result.current).toBe(next);
    expect(subscriptions).toHaveLength(2);
    unmount();
    expect(mocks.unwatchFile).toHaveBeenLastCalledWith(
      '/sessions/second.worktree.json',
      subscriptions[1].notify,
    );
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
    const calls = mocks.read.mock.calls.length;
    act(() => subscriptions[0].notify());
    expect(mocks.read).toHaveBeenCalledTimes(calls);
  });

  it('subscribes before the initial missing-file read without creating its parent', async () => {
    mocks.read.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useWorktreeSession(config));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    expect(result.current).toBeNull();
    expect(mocks.watchFile).toHaveBeenCalledWith(
      '/sessions/first.worktree.json',
      { persistent: false, interval: 500 },
      subscriptions[0].notify,
    );
    expect(mocks.watchFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.read.mock.invocationCallOrder[0],
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
    await act(async () => subscriptions[0].notify());
    expect(result.current).toBe(worktree);
  });

  it('reloads the exact subscribed sidecar and handles deletion', async () => {
    const { result } = renderHook(() => useWorktreeSession(config));
    await waitFor(() => expect(result.current).toBe(worktree));
    mocks.read.mockResolvedValueOnce(null);
    await act(async () => subscriptions[0].notify());
    expect(result.current).toBeNull();
    await act(async () => subscriptions[0].notify());
    expect(result.current).toBe(worktree);
    expect(mocks.read.mock.calls).toEqual([
      ['/sessions/first.worktree.json'],
      ['/sessions/first.worktree.json'],
      ['/sessions/first.worktree.json'],
    ]);
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
    expect(mocks.watchFile).not.toHaveBeenCalled();
  });

  it('isolates a new Config with the same session ID before its read completes', async () => {
    const { result, rerender } = renderHook(() => useWorktreeSession(config));
    await waitFor(() => expect(result.current).toBe(worktree));
    let finishNext!: (value: WorktreeSession | null) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNext = resolve;
        }),
    );
    config = {
      ...config,
      getSessionService: () => ({
        getWorktreeSessionPath: () => '/other/first.worktree.json',
      }),
    } as unknown as Config;
    rerender();
    expect(result.current).toBeNull();
    const next = { ...worktree, slug: 'other-owner' };
    await act(async () => finishNext(next));
    expect(result.current).toBe(next);
    expect(mocks.read).toHaveBeenLastCalledWith('/other/first.worktree.json');
  });

  it('detaches only its listener when two owners subscribe to the same file', async () => {
    const first = renderHook(() => useWorktreeSession(config));
    const second = renderHook(() => useWorktreeSession(config));
    await waitFor(() => expect(second.result.current).toBe(worktree));
    expect(subscriptions).toHaveLength(2);
    first.unmount();
    expect(mocks.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      subscriptions[0].path,
      subscriptions[0].notify,
    );
    const calls = mocks.read.mock.calls.length;
    act(() => subscriptions[0].notify());
    expect(mocks.read).toHaveBeenCalledTimes(calls);
    mocks.read.mockResolvedValueOnce(null);
    await act(async () => subscriptions[1].notify());
    expect(second.result.current).toBeNull();
    second.unmount();
    expect(mocks.unwatchFile).toHaveBeenLastCalledWith(
      subscriptions[1].path,
      subscriptions[1].notify,
    );
  });

  it('ignores an in-flight read and retained listener after unmount', async () => {
    let finish!: (value: WorktreeSession | null) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderHook(() => useWorktreeSession(config));
    view.unmount();
    await act(async () => finish(worktree));
    act(() => subscriptions[0].notify());
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      subscriptions[0].path,
      subscriptions[0].notify,
    );
  });

  it('keeps read failures null without dropping the subscription', async () => {
    const { result } = renderHook(() => useWorktreeSession(config));
    await waitFor(() => expect(result.current).toBe(worktree));
    mocks.read.mockRejectedValueOnce(new Error('unreadable'));
    await act(async () => subscriptions[0].notify());
    expect(result.current).toBeNull();
    await act(async () => subscriptions[0].notify());
    expect(result.current).toBe(worktree);
  });

  it('detaches the stat listener on unmount after final-exit preparation', async () => {
    // prepareFileWatchersForProcessExit only marks the process on Darwin.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { result, unmount } = renderHook(() => useWorktreeSession(config));
      await waitFor(() => expect(result.current).toBe(worktree));
      prepareFileWatchersForProcessExit();
      unmount();
      expect(mocks.unwatchFile).toHaveBeenCalledExactlyOnceWith(
        '/sessions/first.worktree.json',
        subscriptions[0].notify,
      );
      expect(mocks.watch).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

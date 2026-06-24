/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { resolveBranchName, watchRepoBranch } from '@qwen-code/qwen-code-core';
import { useGitBranchName } from './useGitBranchName.js';

// The hook is a thin wrapper over core's gitDirect helpers; the direct-read
// logic itself is covered by core's gitDirect.test.ts. Here we mock those two
// functions and exercise the hook's wiring and lifecycle.
vi.mock('@qwen-code/qwen-code-core', () => ({
  resolveBranchName: vi.fn(),
  watchRepoBranch: vi.fn(),
}));

const mockResolve = resolveBranchName as Mock;
const mockWatch = watchRepoBranch as Mock;

const CWD = '/test/project';

async function flushAsyncEffects() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('useGitBranchName', () => {
  beforeEach(() => {
    mockResolve.mockReset();
    mockWatch.mockReset();
    // Default: the watcher registers and hands back a no-op disposer.
    mockWatch.mockResolvedValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the branch name on mount', async () => {
    mockResolve.mockResolvedValue('main');

    const { result } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      await flushAsyncEffects();
    });

    expect(result.current).toBe('main');
  });

  it('is undefined when not in a git repository', async () => {
    mockResolve.mockResolvedValue(undefined);

    const { result } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      await flushAsyncEffects();
    });

    expect(result.current).toBeUndefined();
  });

  it('subscribes to branch changes for the given cwd', async () => {
    mockResolve.mockResolvedValue('main');

    renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      await flushAsyncEffects();
    });

    expect(mockWatch).toHaveBeenCalledWith(CWD, expect.any(Function));
  });

  it('refreshes the branch name when the watcher fires', async () => {
    mockResolve.mockResolvedValueOnce('main').mockResolvedValueOnce('develop');
    let fire: (() => void) | undefined;
    mockWatch.mockImplementation(async (_cwd: string, onChange: () => void) => {
      fire = onChange;
      return () => {};
    });

    const { result } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      await flushAsyncEffects();
    });
    expect(result.current).toBe('main');

    await act(async () => {
      fire?.();
      await flushAsyncEffects();
    });
    expect(result.current).toBe('develop');
  });

  it('disposes the watcher on unmount', async () => {
    mockResolve.mockResolvedValue('main');
    const dispose = vi.fn();
    mockWatch.mockResolvedValue(dispose);

    const { unmount } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      await flushAsyncEffects();
    });

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes immediately if the watcher resolves after unmount', async () => {
    mockResolve.mockResolvedValue('main');
    const dispose = vi.fn();
    let resolveWatch!: (d: () => void) => void;
    mockWatch.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveWatch = resolve;
        }),
    );

    const { unmount } = renderHook(() => useGitBranchName(CWD));
    // Let init() progress past the initial read to the pending watch setup.
    await act(async () => {
      await flushAsyncEffects();
    });
    unmount();

    await act(async () => {
      resolveWatch(dispose);
      await flushAsyncEffects();
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes when cwd changes', async () => {
    mockResolve.mockResolvedValue('main');
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();
    mockWatch.mockResolvedValueOnce(dispose1).mockResolvedValueOnce(dispose2);

    const { rerender } = renderHook(({ cwd }) => useGitBranchName(cwd), {
      initialProps: { cwd: '/repo-a' },
    });
    await act(async () => {
      await flushAsyncEffects();
    });
    expect(mockWatch).toHaveBeenCalledWith('/repo-a', expect.any(Function));

    rerender({ cwd: '/repo-b' });
    await act(async () => {
      await flushAsyncEffects();
    });

    // The old repo's watcher is disposed, and the new cwd is resolved + watched.
    expect(dispose1).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith('/repo-b');
    expect(mockWatch).toHaveBeenCalledWith('/repo-b', expect.any(Function));
  });

  it('still renders the branch if watcher setup rejects', async () => {
    mockResolve.mockResolvedValue('main');
    mockWatch.mockRejectedValue(new Error('watch boom'));

    const { result } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      await flushAsyncEffects();
    });

    // The initial read still rendered; the rejected setup is swallowed by the
    // hook's .catch() (no unhandled rejection).
    expect(result.current).toBe('main');
  });
});

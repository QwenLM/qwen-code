/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { useGitBranchName } from './useGitBranchName.js';
import { fs, vol } from 'memfs'; // For mocking fs
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isCommandAvailable, execCommand } from '@qwen-code/qwen-code-core';

// Mock @qwen-code/qwen-code-core
vi.mock('@qwen-code/qwen-code-core', async () => {
  const original = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...original,
    execCommand: vi.fn(),
    isCommandAvailable: vi.fn(),
  };
});

// Mock fs and fs/promises
vi.mock('node:fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return {
    ...memfs.fs,
    default: memfs.fs,
  };
});

vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return {
    ...memfs.fs.promises,
    default: memfs.fs.promises,
  };
});

const CWD = '/test/project';
const GIT_LOGS_HEAD_PATH = path.join(CWD, '.git', 'logs', 'HEAD');

async function flushAsyncEffects() {
  vi.runAllTimers();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useGitBranchName', () => {
  beforeEach(() => {
    vol.reset(); // Reset in-memory filesystem
    vol.fromJSON({
      [GIT_LOGS_HEAD_PATH]: 'ref: refs/heads/main',
    });
    vi.useFakeTimers(); // Use fake timers for async operations
    (isCommandAvailable as Mock).mockReturnValue({ available: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it('should return branch name', async () => {
    (execCommand as Mock).mockResolvedValueOnce({
      stdout: 'main\n',
      stderr: '',
      code: 0,
    });
    const { result, rerender } = renderHook(() => useGitBranchName(CWD));

    await act(async () => {
      vi.runAllTimers(); // Advance timers to trigger useEffect and exec callback
      rerender(); // Rerender to get the updated state
    });

    expect(result.current).toBe('main');
  });

  it('should return undefined if git command fails', async () => {
    (execCommand as Mock).mockRejectedValue(new Error('Git error'));

    const { result, rerender } = renderHook(() => useGitBranchName(CWD));
    expect(result.current).toBeUndefined();

    await act(async () => {
      vi.runAllTimers();
      rerender();
    });
    expect(result.current).toBeUndefined();
  });

  it('should return short commit hash if branch is HEAD (detached state)', async () => {
    (execCommand as Mock).mockImplementation(
      async (_command: string, args?: readonly string[] | null) => {
        if (args?.includes('--abbrev-ref')) {
          return { stdout: 'HEAD\n', stderr: '', code: 0 };
        } else if (args?.includes('--short')) {
          return { stdout: 'a1b2c3d\n', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    );

    const { result, rerender } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      vi.runAllTimers();
      rerender();
    });
    expect(result.current).toBe('a1b2c3d');
  });

  it('should return undefined if branch is HEAD and getting commit hash fails', async () => {
    (execCommand as Mock).mockImplementation(
      async (_command: string, args?: readonly string[] | null) => {
        if (args?.includes('--abbrev-ref')) {
          return { stdout: 'HEAD\n', stderr: '', code: 0 };
        } else if (args?.includes('--short')) {
          throw new Error('Git error');
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    );

    const { result, rerender } = renderHook(() => useGitBranchName(CWD));
    await act(async () => {
      vi.runAllTimers();
      rerender();
    });
    expect(result.current).toBeUndefined();
  });

  it('should update branch name when .git/logs/HEAD changes', async () => {
    let onWatchEvent: ((eventType: string) => void) | undefined;
    const watchMock = vi
      .spyOn(fs, 'watch')
      .mockImplementation(
        (_filename: unknown, options?: unknown, listener?: unknown) => {
          const callback =
            typeof options === 'function'
              ? (options as (
                  eventType: string,
                  filename: string | Buffer | null,
                ) => void)
              : typeof listener === 'function'
                ? (listener as (
                    eventType: string,
                    filename: string | Buffer | null,
                  ) => void)
                : undefined;
          onWatchEvent = callback
            ? (eventType: string) => callback(eventType, null)
            : undefined;
          return {
            close: vi.fn(),
          } as unknown as ReturnType<typeof fs.watch>;
        },
      );
    (execCommand as Mock)
      .mockResolvedValueOnce({
        stdout: 'main\n',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'develop\n',
        stderr: '',
        code: 0,
      });

    const { result, rerender } = renderHook(() => useGitBranchName(CWD));

    await act(async () => {
      await flushAsyncEffects();
      rerender();
    });
    expect(result.current).toBe('main');
    expect(watchMock).toHaveBeenCalledWith(
      GIT_LOGS_HEAD_PATH,
      expect.any(Function),
    );

    // Simulate the watcher event after updating the reflog file.
    await act(async () => {
      fs.writeFileSync(GIT_LOGS_HEAD_PATH, 'ref: refs/heads/develop'); // Trigger watcher
      onWatchEvent?.('change');
      await flushAsyncEffects(); // Process timers for watcher and exec
      rerender();
    });

    expect(result.current).toBe('develop');
  });

  it('should handle watcher setup error silently', async () => {
    // Remove .git/logs/HEAD to cause an error in fs.watch setup
    vol.unlinkSync(GIT_LOGS_HEAD_PATH);

    (execCommand as Mock).mockResolvedValue({
      stdout: 'main\n',
      stderr: '',
      code: 0,
    });

    const { result, rerender } = renderHook(() => useGitBranchName(CWD));

    await act(async () => {
      vi.runAllTimers();
      rerender();
    });

    expect(result.current).toBe('main'); // Branch name should still be fetched initially

    (execCommand as Mock).mockResolvedValueOnce({
      stdout: 'develop\n',
      stderr: '',
      code: 0,
    });

    // This write would trigger the watcher if it was set up
    // but since it failed, the branch name should not update
    // We need to create the file again for writeFileSync to not throw
    vol.fromJSON({
      [GIT_LOGS_HEAD_PATH]: 'ref: refs/heads/develop',
    });

    await act(async () => {
      fs.writeFileSync(GIT_LOGS_HEAD_PATH, 'ref: refs/heads/develop');
      vi.runAllTimers();
      rerender();
    });

    // Branch name should not change because watcher setup failed
    expect(result.current).toBe('main');
  });

  it('should cleanup watcher on unmount', async () => {
    const closeMock = vi.fn();
    const watchMock = vi.spyOn(fs, 'watch').mockReturnValue({
      close: closeMock,
    } as unknown as ReturnType<typeof fs.watch>);

    (execCommand as Mock).mockResolvedValue({
      stdout: 'main\n',
      stderr: '',
      code: 0,
    });

    const { unmount, rerender } = renderHook(() => useGitBranchName(CWD));

    await act(async () => {
      await flushAsyncEffects();
      rerender();
    });
    expect(watchMock).toHaveBeenCalled();

    unmount();
    expect(watchMock).toHaveBeenCalledWith(
      GIT_LOGS_HEAD_PATH,
      expect.any(Function),
    );
    expect(closeMock).toHaveBeenCalled();
  });

  it('should not create watcher if setup completes after unmount', async () => {
    let resolveAccess!: () => void;
    vi.spyOn(fsPromises, 'access').mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAccess = resolve;
      }),
    );

    const closeMock = vi.fn();
    const watchMock = vi.spyOn(fs, 'watch').mockReturnValue({
      close: closeMock,
    } as unknown as ReturnType<typeof fs.watch>);

    (execCommand as Mock).mockResolvedValue({
      stdout: 'main\n',
      stderr: '',
      code: 0,
    });

    const { unmount } = renderHook(() => useGitBranchName(CWD));
    unmount();

    await act(async () => {
      resolveAccess();
      await Promise.resolve();
    });

    expect(watchMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useGitBranchName } from './useGitBranchName.js';
import { fs, vol } from 'memfs';
import path from 'node:path';
import {
  readGitHead,
  resolveGitRepositoryLayout,
} from '@qwen-code/core';

vi.mock('@qwen-code/core', async () => {
  const original = await vi.importActual<
    typeof import('@qwen-code/core')
  >('@qwen-code/core');
  return {
    ...original,
    readGitHead: vi.fn(),
    resolveGitRepositoryLayout: vi.fn(),
  };
});

vi.mock('node:fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  Object.defineProperty(memfs.fs, 'writeSync', {
    configurable: true,
    value: actual.writeSync,
  });
  return {
    ...memfs.fs,
    writeSync: actual.writeSync,
    default: memfs.fs,
  };
});

vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return { ...memfs.fs.promises, default: memfs.fs.promises };
});

const CWD = '/test/project';
const GIT_DIR = path.join(CWD, '.git');
const GIT_LOGS_HEAD_PATH = path.join(GIT_DIR, 'logs', 'HEAD');

describe('useGitBranchName', () => {
  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      [GIT_LOGS_HEAD_PATH]: 'ref: refs/heads/main',
    });
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      worktreeRoot: CWD,
      gitDir: GIT_DIR,
      commonDir: GIT_DIR,
      isWorktree: false,
    });
    vi.mocked(readGitHead).mockResolvedValue({
      ref: 'refs/heads/main',
      branch: 'main',
      commit: 'a'.repeat(40),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderGitBranchNameHook = async (cwd: string) => {
    let hookResult: ReturnType<typeof useGitBranchName>;
    function TestComponent() {
      hookResult = useGitBranchName(cwd);
      return null;
    }
    const result = await render(<TestComponent />);
    return {
      result: {
        get current() {
          return hookResult;
        },
      },
      unmount: result.unmount,
    };
  };

  it('returns the symbolic branch without starting Git', async () => {
    const { result } = await renderGitBranchNameHook(CWD);

    await waitFor(() => expect(result.current).toBe('main'));
    expect(resolveGitRepositoryLayout).toHaveBeenCalledWith(CWD);
    expect(readGitHead).toHaveBeenCalled();
  });

  it('returns undefined outside a repository', async () => {
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

    const { result } = await renderGitBranchNameHook(CWD);

    await act(async () => undefined);
    expect(result.current).toBeUndefined();
    expect(readGitHead).not.toHaveBeenCalled();
  });

  it('returns a short commit hash for detached HEAD', async () => {
    vi.mocked(readGitHead).mockResolvedValue({ commit: 'a1b2c3d4e5f6' });

    const { result } = await renderGitBranchNameHook(CWD);

    await waitFor(() => expect(result.current).toBe('a1b2c3d'));
  });

  it('updates the branch when the resolved worktree reflog changes', async () => {
    const worktreeGitDir = '/test/repository/.git/worktrees/project';
    const worktreeLogsHead = path.join(worktreeGitDir, 'logs', 'HEAD');
    vol.fromJSON({ [worktreeLogsHead]: 'initial\n' });
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      worktreeRoot: CWD,
      gitDir: worktreeGitDir,
      commonDir: '/test/repository/.git',
      isWorktree: true,
    });
    vi.mocked(readGitHead)
      .mockResolvedValueOnce({ branch: 'main' })
      .mockResolvedValue({ branch: 'develop' });
    const watchSpy = vi.spyOn(fs, 'watch');

    const { result } = await renderGitBranchNameHook(CWD);
    await waitFor(() => expect(result.current).toBe('main'));
    await waitFor(() => {
      expect(watchSpy).toHaveBeenCalledWith(
        worktreeLogsHead,
        expect.any(Function),
      );
    });

    await act(async () => {
      fs.writeFileSync(worktreeLogsHead, 'changed\n');
    });

    await waitFor(() => expect(result.current).toBe('develop'));
  });

  it('handles watcher setup errors silently', async () => {
    vol.unlinkSync(GIT_LOGS_HEAD_PATH);

    const { result } = await renderGitBranchNameHook(CWD);

    await waitFor(() => expect(result.current).toBe('main'));
  });

  it('closes the watcher on unmount', async () => {
    const closeMock = vi.fn();
    const watchMock = vi.spyOn(fs, 'watch').mockReturnValue({
      close: closeMock,
    } as unknown as ReturnType<typeof fs.watch>);

    const { unmount } = await renderGitBranchNameHook(CWD);
    await waitFor(() => expect(watchMock).toHaveBeenCalled());

    unmount();
    expect(closeMock).toHaveBeenCalled();
  });
});

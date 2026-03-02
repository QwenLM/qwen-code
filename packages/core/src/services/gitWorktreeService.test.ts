/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type * as fs from 'node:fs/promises';
import { GitWorktreeService } from './gitWorktreeService.js';
import { isCommandAvailable } from '../utils/shell-utils.js';

const hoistedMockSimpleGit = vi.hoisted(() => vi.fn());
const hoistedMockCheckIsRepo = vi.hoisted(() => vi.fn());
const hoistedMockInit = vi.hoisted(() => vi.fn());
const hoistedMockAdd = vi.hoisted(() => vi.fn());
const hoistedMockCommit = vi.hoisted(() => vi.fn());
const hoistedMockRevparse = vi.hoisted(() => vi.fn());
const hoistedMockRaw = vi.hoisted(() => vi.fn());
const hoistedMockBranch = vi.hoisted(() => vi.fn());
const hoistedMockDiff = vi.hoisted(() => vi.fn());
const hoistedMockMerge = vi.hoisted(() => vi.fn());
const hoistedMockStash = vi.hoisted(() => vi.fn());

vi.mock('simple-git', () => ({
  simpleGit: hoistedMockSimpleGit,
  CheckRepoActions: { IS_REPO_ROOT: 'is-repo-root' },
}));

vi.mock('../utils/shell-utils.js', () => ({
  isCommandAvailable: vi.fn(),
}));

const hoistedMockGetGlobalQwenDir = vi.hoisted(() => vi.fn());
vi.mock('../config/storage.js', () => ({
  Storage: {
    getGlobalQwenDir: hoistedMockGetGlobalQwenDir,
  },
}));

const hoistedMockFsMkdir = vi.hoisted(() => vi.fn());
const hoistedMockFsAccess = vi.hoisted(() => vi.fn());
const hoistedMockFsWriteFile = vi.hoisted(() => vi.fn());
const hoistedMockFsReaddir = vi.hoisted(() => vi.fn());
const hoistedMockFsStat = vi.hoisted(() => vi.fn());
const hoistedMockFsRm = vi.hoisted(() => vi.fn());
const hoistedMockFsReadFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    mkdir: hoistedMockFsMkdir,
    access: hoistedMockFsAccess,
    writeFile: hoistedMockFsWriteFile,
    readdir: hoistedMockFsReaddir,
    stat: hoistedMockFsStat,
    rm: hoistedMockFsRm,
    readFile: hoistedMockFsReadFile,
  };
});

describe('GitWorktreeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    hoistedMockGetGlobalQwenDir.mockReturnValue('/mock-qwen');
    (isCommandAvailable as Mock).mockReturnValue({ available: true });

    hoistedMockSimpleGit.mockImplementation(() => ({
      checkIsRepo: hoistedMockCheckIsRepo,
      init: hoistedMockInit,
      add: hoistedMockAdd,
      commit: hoistedMockCommit,
      revparse: hoistedMockRevparse,
      raw: hoistedMockRaw,
      branch: hoistedMockBranch,
      diff: hoistedMockDiff,
      merge: hoistedMockMerge,
      stash: hoistedMockStash,
    }));

    hoistedMockCheckIsRepo.mockResolvedValue(true);
    hoistedMockInit.mockResolvedValue(undefined);
    hoistedMockAdd.mockResolvedValue(undefined);
    hoistedMockCommit.mockResolvedValue(undefined);
    hoistedMockRevparse.mockResolvedValue('main\n');
    hoistedMockRaw.mockResolvedValue('');
    hoistedMockBranch.mockResolvedValue({ branches: {} });
    hoistedMockDiff.mockResolvedValue('');
    hoistedMockMerge.mockResolvedValue(undefined);
    hoistedMockStash.mockResolvedValue('');

    hoistedMockFsMkdir.mockResolvedValue(undefined);
    hoistedMockFsAccess.mockRejectedValue({ code: 'ENOENT' });
    hoistedMockFsWriteFile.mockResolvedValue(undefined);
    hoistedMockFsReaddir.mockResolvedValue([]);
    hoistedMockFsStat.mockResolvedValue({ birthtimeMs: 123 });
    hoistedMockFsRm.mockResolvedValue(undefined);
    hoistedMockFsReadFile.mockResolvedValue('{}');
  });

  it('checkGitAvailable should return an error when git is unavailable', async () => {
    (isCommandAvailable as Mock).mockReturnValue({ available: false });
    const service = new GitWorktreeService('/repo');

    await expect(service.checkGitAvailable()).resolves.toEqual({
      available: false,
      error: 'Git is not installed. Please install Git.',
    });
  });

  it('isGitRepository should fallback to checkIsRepo() when root check throws', async () => {
    hoistedMockCheckIsRepo
      .mockRejectedValueOnce(new Error('root check failed'))
      .mockResolvedValueOnce(true);
    const service = new GitWorktreeService('/repo');

    await expect(service.isGitRepository()).resolves.toBe(true);
    expect(hoistedMockCheckIsRepo).toHaveBeenNthCalledWith(1, 'is-repo-root');
    expect(hoistedMockCheckIsRepo).toHaveBeenNthCalledWith(2);
  });

  it('isGitRepository should detect subdirectory inside an existing repo', async () => {
    // IS_REPO_ROOT returns false for a subdirectory, but checkIsRepo()
    // (without params) returns true because we're inside a repo.
    hoistedMockCheckIsRepo
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const service = new GitWorktreeService('/repo/subdir');

    await expect(service.isGitRepository()).resolves.toBe(true);
    expect(hoistedMockCheckIsRepo).toHaveBeenNthCalledWith(1, 'is-repo-root');
    expect(hoistedMockCheckIsRepo).toHaveBeenNthCalledWith(2);
  });

  it('createWorktree should create a sanitized branch and worktree path', async () => {
    const service = new GitWorktreeService('/repo');

    const result = await service.createWorktree('s1', 'Model A');

    expect(result.success).toBe(true);
    expect(result.worktree?.branch).toBe('worktrees/s1/model-a');
    expect(result.worktree?.path).toBe(
      '/mock-qwen/worktrees/s1/worktrees/model-a',
    );
    expect(hoistedMockRaw).toHaveBeenCalledWith([
      'worktree',
      'add',
      '-b',
      'worktrees/s1/model-a',
      '/mock-qwen/worktrees/s1/worktrees/model-a',
      'main',
    ]);
  });

  it('setupWorktrees should fail early for colliding sanitized names', async () => {
    const service = new GitWorktreeService('/repo');

    const result = await service.setupWorktrees({
      sessionId: 's1',
      sourceRepoPath: '/repo',
      worktreeNames: ['Model A', 'model_a'],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('collides');
    expect(isCommandAvailable).not.toHaveBeenCalled();
  });

  it('setupWorktrees should return system error when git is unavailable', async () => {
    (isCommandAvailable as Mock).mockReturnValue({ available: false });
    const service = new GitWorktreeService('/repo');

    const result = await service.setupWorktrees({
      sessionId: 's1',
      sourceRepoPath: '/repo',
      worktreeNames: ['model-a'],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      {
        name: 'system',
        error: 'Git is not installed. Please install Git.',
      },
    ]);
  });

  it('setupWorktrees should cleanup session after partial creation failure', async () => {
    const service = new GitWorktreeService('/repo');
    vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
    vi.spyOn(service, 'createWorktree')
      .mockResolvedValueOnce({
        success: true,
        worktree: {
          id: 's1/a',
          name: 'a',
          path: '/w/a',
          branch: 'worktrees/s1/a',
          isActive: true,
          createdAt: 1,
        },
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'boom',
      });
    const cleanupSpy = vi.spyOn(service, 'cleanupSession').mockResolvedValue({
      success: true,
      removedWorktrees: [],
      removedBranches: [],
      errors: [],
    });

    const result = await service.setupWorktrees({
      sessionId: 's1',
      sourceRepoPath: '/repo',
      worktreeNames: ['a', 'b'],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual({ name: 'b', error: 'boom' });
    expect(cleanupSpy).toHaveBeenCalledWith('s1', 'worktrees');
  });

  it('listWorktrees should return empty array when session dir does not exist', async () => {
    const err = new Error('missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    hoistedMockFsReaddir.mockRejectedValue(err);
    const service = new GitWorktreeService('/repo');

    await expect(service.listWorktrees('missing')).resolves.toEqual([]);
  });

  it('removeWorktree should fallback to fs.rm + worktree prune when git remove fails', async () => {
    hoistedMockRaw
      .mockRejectedValueOnce(new Error('remove failed'))
      .mockResolvedValueOnce('');
    const service = new GitWorktreeService('/repo');

    const result = await service.removeWorktree('/w/a');

    expect(result.success).toBe(true);
    expect(hoistedMockFsRm).toHaveBeenCalledWith('/w/a', {
      recursive: true,
      force: true,
    });
    expect(hoistedMockRaw).toHaveBeenNthCalledWith(2, ['worktree', 'prune']);
  });

  it('cleanupSession should remove prefixed branches only', async () => {
    const service = new GitWorktreeService('/repo');
    vi.spyOn(service, 'listWorktrees').mockResolvedValue([]);
    hoistedMockBranch.mockImplementation((args?: string[]) => {
      if (args?.[0] === '-a') {
        return Promise.resolve({
          branches: {
            main: {},
            'worktrees/s1/a': {},
            'worktrees/s1/b': {},
          },
        });
      }
      return Promise.resolve({ branches: {} });
    });

    const result = await service.cleanupSession('s1');

    expect(result.success).toBe(true);
    expect(result.removedBranches).toEqual([
      'worktrees/s1/a',
      'worktrees/s1/b',
    ]);
    expect(hoistedMockBranch).toHaveBeenCalledWith(['-D', 'worktrees/s1/a']);
    expect(hoistedMockBranch).toHaveBeenCalledWith(['-D', 'worktrees/s1/b']);
    expect(hoistedMockRaw).toHaveBeenCalledWith(['worktree', 'prune']);
  });

  it('getWorktreeDiff should return staged raw diff without creating commits', async () => {
    const service = new GitWorktreeService('/repo');
    hoistedMockDiff.mockResolvedValue('diff --git a/a.ts b/a.ts');

    const diff = await service.getWorktreeDiff('/w/a', 'main');

    expect(diff).toBe('diff --git a/a.ts b/a.ts');
    expect(hoistedMockAdd).toHaveBeenCalledWith(['--all']);
    expect(hoistedMockDiff).toHaveBeenCalledWith([
      '--binary',
      '--cached',
      'main',
    ]);
    expect(hoistedMockCommit).not.toHaveBeenCalled();
  });

  it('applyWorktreeChanges should apply raw patch via git apply', async () => {
    const service = new GitWorktreeService('/repo');
    // resolveBaseline returns the baseline commit SHA
    hoistedMockRaw
      .mockResolvedValueOnce('baseline-sha\n') // resolveBaseline log --grep
      .mockResolvedValueOnce('') // reset (from withStagedChanges)
      .mockResolvedValueOnce(''); // git apply
    hoistedMockDiff.mockResolvedValueOnce('diff --git a/a.ts b/a.ts');

    const result = await service.applyWorktreeChanges('/w/a', '/repo');

    expect(result.success).toBe(true);
    expect(hoistedMockAdd).toHaveBeenCalledWith(['--all']);
    // Should diff against the baseline commit, not merge-base
    expect(hoistedMockDiff).toHaveBeenCalledWith([
      '--binary',
      '--cached',
      'baseline-sha',
    ]);

    const applyCall = hoistedMockRaw.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0] === 'apply',
    );
    expect(applyCall).toBeDefined();
    // When baseline is used, --3way is omitted (target working tree
    // matches the pre-image, so plain apply works cleanly).
    expect(applyCall?.[0]?.slice(0, 2)).toEqual([
      'apply',
      '--whitespace=nowarn',
    ]);
    expect(hoistedMockFsWriteFile).toHaveBeenCalled();
    expect(hoistedMockFsRm).toHaveBeenCalledWith(
      expect.stringContaining('.worktree-apply-'),
      { force: true },
    );
  });

  it('applyWorktreeChanges should skip apply when patch is empty', async () => {
    const service = new GitWorktreeService('/repo');
    // resolveBaseline returns baseline commit
    hoistedMockRaw.mockResolvedValueOnce('baseline-sha\n');
    hoistedMockDiff.mockResolvedValueOnce('   \n');

    const result = await service.applyWorktreeChanges('/w/a', '/repo');

    expect(result.success).toBe(true);
    const applyCall = hoistedMockRaw.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0] === 'apply',
    );
    expect(applyCall).toBeUndefined();
    expect(hoistedMockFsWriteFile).not.toHaveBeenCalled();
  });

  it('applyWorktreeChanges should return error when git apply fails', async () => {
    const service = new GitWorktreeService('/repo');
    // resolveBaseline returns baseline commit
    hoistedMockRaw
      .mockResolvedValueOnce('baseline-sha\n') // resolveBaseline
      .mockResolvedValueOnce('') // reset from withStagedChanges
      .mockRejectedValueOnce(new Error('apply failed'));
    hoistedMockDiff.mockResolvedValueOnce('diff --git a/a.ts b/a.ts');

    const result = await service.applyWorktreeChanges('/w/a', '/repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain('apply failed');
    expect(hoistedMockFsRm).toHaveBeenCalledWith(
      expect.stringContaining('.worktree-apply-'),
      { force: true },
    );
  });

  describe('dirty state propagation', () => {
    function makeWorktreeInfo(
      name: string,
      sessionId: string,
    ): {
      id: string;
      name: string;
      path: string;
      branch: string;
      isActive: boolean;
      createdAt: number;
    } {
      return {
        id: `${sessionId}/${name}`,
        name,
        path: `/mock-qwen/worktrees/${sessionId}/worktrees/${name}`,
        branch: `worktrees/${sessionId}/${name}`,
        isActive: true,
        createdAt: 1,
      };
    }

    it('setupWorktrees should apply dirty state snapshot to each worktree', async () => {
      hoistedMockStash.mockResolvedValue('snapshot-sha\n');
      const service = new GitWorktreeService('/repo');
      vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
      vi.spyOn(service, 'createWorktree')
        .mockResolvedValueOnce({
          success: true,
          worktree: makeWorktreeInfo('a', 's1'),
        })
        .mockResolvedValueOnce({
          success: true,
          worktree: makeWorktreeInfo('b', 's1'),
        });

      const result = await service.setupWorktrees({
        sessionId: 's1',
        sourceRepoPath: '/repo',
        worktreeNames: ['a', 'b'],
      });

      expect(result.success).toBe(true);
      expect(hoistedMockStash).toHaveBeenCalledWith(['create']);
      // stash apply should be called once per worktree
      const stashApplyCalls = hoistedMockRaw.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[0]) &&
          call[0][0] === 'stash' &&
          call[0][1] === 'apply',
      );
      expect(stashApplyCalls).toHaveLength(2);
      expect(stashApplyCalls[0]![0]).toEqual([
        'stash',
        'apply',
        'snapshot-sha',
      ]);
    });

    it('setupWorktrees should skip stash apply when working tree is clean', async () => {
      hoistedMockStash.mockResolvedValue('\n');
      const service = new GitWorktreeService('/repo');
      vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
      vi.spyOn(service, 'createWorktree').mockResolvedValue({
        success: true,
        worktree: makeWorktreeInfo('a', 's1'),
      });

      const result = await service.setupWorktrees({
        sessionId: 's1',
        sourceRepoPath: '/repo',
        worktreeNames: ['a'],
      });

      expect(result.success).toBe(true);
      const stashApplyCalls = hoistedMockRaw.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[0]) &&
          call[0][0] === 'stash' &&
          call[0][1] === 'apply',
      );
      expect(stashApplyCalls).toHaveLength(0);
    });

    it('setupWorktrees should still succeed when stash apply fails', async () => {
      hoistedMockStash.mockResolvedValue('snapshot-sha\n');
      hoistedMockRaw.mockRejectedValue(new Error('stash apply conflict'));
      const service = new GitWorktreeService('/repo');
      vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
      vi.spyOn(service, 'createWorktree').mockResolvedValue({
        success: true,
        worktree: makeWorktreeInfo('a', 's1'),
      });

      const result = await service.setupWorktrees({
        sessionId: 's1',
        sourceRepoPath: '/repo',
        worktreeNames: ['a'],
      });

      // Setup should still succeed — dirty state failure is non-fatal
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('setupWorktrees should still succeed when stash create fails', async () => {
      hoistedMockStash.mockRejectedValue(new Error('stash create failed'));
      const service = new GitWorktreeService('/repo');
      vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
      vi.spyOn(service, 'createWorktree').mockResolvedValue({
        success: true,
        worktree: makeWorktreeInfo('a', 's1'),
      });

      const result = await service.setupWorktrees({
        sessionId: 's1',
        sourceRepoPath: '/repo',
        worktreeNames: ['a'],
      });

      // Setup should still succeed — stash create failure is non-fatal
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});

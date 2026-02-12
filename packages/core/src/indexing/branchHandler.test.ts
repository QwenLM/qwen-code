/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BranchHandler,
  type BranchChangeResult,
  type GitExecutor,
} from './branchHandler.js';

/**
 * Creates a mock {@link GitExecutor} backed by a Vitest spy.
 * Callers configure behaviour via `mockGit.exec.mockResolvedValue(...)` etc.
 */
function createMockGitExecutor(): GitExecutor & {
  exec: ReturnType<typeof vi.fn>;
} {
  return {
    exec: vi.fn(),
  };
}

describe('BranchHandler', () => {
  let handler: BranchHandler;
  let mockGit: ReturnType<typeof createMockGitExecutor>;
  const projectRoot = '/test/project';

  beforeEach(() => {
    mockGit = createMockGitExecutor();
    handler = new BranchHandler(projectRoot, mockGit);
  });

  // --------------- getCurrentBranch ---------------

  describe('getCurrentBranch', () => {
    it('should return the current branch name', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });

      const branch = await handler.getCurrentBranch();

      expect(branch).toBe('main');
      expect(mockGit.exec).toHaveBeenCalledWith(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        expect.any(String),
      );
    });

    it('should trim whitespace from branch name', async () => {
      mockGit.exec.mockResolvedValue({
        stdout: '  feature/test  \n',
        stderr: '',
      });

      const branch = await handler.getCurrentBranch();
      expect(branch).toBe('feature/test');
    });

    it('should return short hash when in detached HEAD state', async () => {
      // First call: rev-parse --abbrev-ref → "HEAD" (detached)
      // Second call: rev-parse --short → short hash
      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'HEAD\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'a1b2c3d\n', stderr: '' });

      const branch = await handler.getCurrentBranch();

      expect(branch).toBe('a1b2c3d');
      expect(mockGit.exec).toHaveBeenCalledTimes(2);
      expect(mockGit.exec).toHaveBeenNthCalledWith(
        2,
        ['rev-parse', '--short', 'HEAD'],
        expect.any(String),
      );
    });
  });

  // --------------- checkBranchChange ---------------

  describe('checkBranchChange', () => {
    it('should return changed=false on first check (no previous branch)', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });

      const result = await handler.checkBranchChange();

      expect(result.changed).toBe(false);
      expect(result.currentBranch).toBe('main');
      expect(result.changedFiles).toBeNull();
      expect(handler.getLastBranch()).toBe('main');
    });

    it('should return changed=false when branch has not changed', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });

      await handler.checkBranchChange();
      const result = await handler.checkBranchChange();

      expect(result.changed).toBe(false);
    });

    it('should detect branch change and return changedFiles', async () => {
      // First check: branch = "main"
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });
      await handler.checkBranchChange();

      // Second check: branch = "feature/new", then diff
      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'feature/new\n', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'src/a.ts\nsrc/b.ts\n',
          stderr: '',
        });

      const result = await handler.checkBranchChange();

      expect(result).toEqual<BranchChangeResult>({
        changed: true,
        previousBranch: 'main',
        currentBranch: 'feature/new',
        changedFiles: ['src/a.ts', 'src/b.ts'],
      });
      expect(handler.getLastBranch()).toBe('feature/new');
    });

    it('should return changedFiles=null when diff fails', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });
      await handler.checkBranchChange();

      // Branch changed, but diff throws
      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'orphan\n', stderr: '' })
        .mockRejectedValueOnce(new Error('no common ancestor'));

      const result = await handler.checkBranchChange();

      expect(result.changed).toBe(true);
      expect(result.changedFiles).toBeNull();
    });

    it('should invoke callbacks with BranchChangeResult', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });
      await handler.checkBranchChange();

      const callback = vi.fn();
      handler.onBranchChange(callback);

      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'develop\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'file1.ts\n', stderr: '' });

      await handler.checkBranchChange();

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          changed: true,
          previousBranch: 'main',
          currentBranch: 'develop',
          changedFiles: ['file1.ts'],
        }),
      );
    });

    it('should invoke multiple callbacks on branch change', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });
      await handler.checkBranchChange();

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      handler.onBranchChange(cb1);
      handler.onBranchChange(cb2);

      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'develop\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await handler.checkBranchChange();

      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it('should continue if a callback throws', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });
      await handler.checkBranchChange();

      const errorCb = vi.fn().mockRejectedValue(new Error('boom'));
      const successCb = vi.fn();
      handler.onBranchChange(errorCb);
      handler.onBranchChange(successCb);

      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'develop\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      // Should NOT throw
      await handler.checkBranchChange();

      expect(errorCb).toHaveBeenCalled();
      expect(successCb).toHaveBeenCalled();
    });

    it('should return changed=false on getCurrentBranch error', async () => {
      mockGit.exec.mockRejectedValue(new Error('git not found'));

      const result = await handler.checkBranchChange();

      expect(result.changed).toBe(false);
    });
  });

  // --------------- offBranchChange ---------------

  describe('offBranchChange', () => {
    it('should remove a callback', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'main\n', stderr: '' });
      await handler.checkBranchChange();

      const callback = vi.fn();
      handler.onBranchChange(callback);
      handler.offBranchChange(callback);

      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'develop\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await handler.checkBranchChange();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should be a no-op if callback was never registered', () => {
      const callback = vi.fn();
      // Should not throw
      handler.offBranchChange(callback);
    });
  });

  // --------------- setLastBranch ---------------

  describe('setLastBranch', () => {
    it('should set the last branch without triggering callbacks', async () => {
      const callback = vi.fn();
      handler.onBranchChange(callback);

      handler.setLastBranch('main');

      // Now "current" is "develop" → change detected
      mockGit.exec
        .mockResolvedValueOnce({ stdout: 'develop\n', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'src/x.ts\n',
          stderr: '',
        });

      const result = await handler.checkBranchChange();

      expect(result.changed).toBe(true);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          previousBranch: 'main',
          currentBranch: 'develop',
        }),
      );
    });
  });

  // --------------- isGitRepository ---------------

  describe('isGitRepository', () => {
    it('should return true for a git repository', async () => {
      mockGit.exec.mockResolvedValue({ stdout: '.git\n', stderr: '' });

      expect(await handler.isGitRepository()).toBe(true);
    });

    it('should return false when not in a git repository', async () => {
      mockGit.exec.mockRejectedValue(new Error('not a git repository'));

      expect(await handler.isGitRepository()).toBe(false);
    });
  });

  // --------------- hasUncommittedChanges ---------------

  describe('hasUncommittedChanges', () => {
    it('should return true when working tree is dirty', async () => {
      mockGit.exec.mockResolvedValue({
        stdout: ' M src/index.ts\n?? new.ts\n',
        stderr: '',
      });

      expect(await handler.hasUncommittedChanges()).toBe(true);
    });

    it('should return false when working tree is clean', async () => {
      mockGit.exec.mockResolvedValue({ stdout: '', stderr: '' });

      expect(await handler.hasUncommittedChanges()).toBe(false);
    });

    it('should return false when git command fails', async () => {
      mockGit.exec.mockRejectedValue(new Error('not a repo'));

      expect(await handler.hasUncommittedChanges()).toBe(false);
    });
  });

  // --------------- getChangedFilesBetween ---------------

  describe('getChangedFilesBetween', () => {
    it('should return list of changed files', async () => {
      mockGit.exec.mockResolvedValue({
        stdout: 'src/a.ts\nsrc/b.ts\ntest/c.test.ts\n',
        stderr: '',
      });

      const files = await handler.getChangedFilesBetween('main', 'feature');

      expect(files).toEqual(['src/a.ts', 'src/b.ts', 'test/c.test.ts']);
      expect(mockGit.exec).toHaveBeenCalledWith(
        ['diff', '--name-only', 'main...feature'],
        expect.any(String),
      );
    });

    it('should return null on diff failure', async () => {
      mockGit.exec.mockRejectedValue(new Error('no common ancestor'));

      const files = await handler.getChangedFilesBetween(
        'main',
        'orphan-branch',
      );

      expect(files).toBeNull();
    });

    it('should use HEAD as default target', async () => {
      mockGit.exec.mockResolvedValue({ stdout: 'file.ts\n', stderr: '' });

      await handler.getChangedFilesBetween('main');

      expect(mockGit.exec).toHaveBeenCalledWith(
        ['diff', '--name-only', 'main...HEAD'],
        expect.any(String),
      );
    });
  });
});

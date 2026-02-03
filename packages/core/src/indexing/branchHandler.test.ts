/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BranchHandler } from './branchHandler.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'node:child_process';

const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

function mockExecWithImplementation(
  impl: (cmd: string) => { stdout: string; stderr: string },
) {
  mockExec.mockImplementation(
    (
      cmd: string,
      _opts: object,
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      try {
        const result = impl(cmd);
        if (callback) {
          callback(null, result.stdout, result.stderr);
        }
        return result;
      } catch (error) {
        if (callback) {
          callback(error as Error, '', '');
        }
        throw error;
      }
    },
  );
}

describe('BranchHandler', () => {
  let branchHandler: BranchHandler;
  const projectRoot = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
    branchHandler = new BranchHandler(projectRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCurrentBranch', () => {
    it('should return the current branch name', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'main\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const branch = await branchHandler.getCurrentBranch();
      expect(branch).toBe('main');
    });

    it('should trim whitespace from branch name', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: '  feature/test  \n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const branch = await branchHandler.getCurrentBranch();
      expect(branch).toBe('feature/test');
    });
  });

  describe('checkBranchChange', () => {
    it('should return false on first check (no previous branch)', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'main\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const changed = await branchHandler.checkBranchChange();

      expect(changed).toBe(false);
      expect(branchHandler.getLastBranch()).toBe('main');
    });

    it('should return false when branch has not changed', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'main\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      // First check
      await branchHandler.checkBranchChange();

      // Second check - same branch
      const changed = await branchHandler.checkBranchChange();

      expect(changed).toBe(false);
    });

    it('should return true and invoke callbacks when branch changes', async () => {
      let currentBranch = 'main';

      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: `${currentBranch}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const callback = vi.fn();
      branchHandler.onBranchChange(callback);

      // First check
      await branchHandler.checkBranchChange();
      expect(callback).not.toHaveBeenCalled();

      // Change branch
      currentBranch = 'feature/new';

      // Second check
      const changed = await branchHandler.checkBranchChange();

      expect(changed).toBe(true);
      expect(callback).toHaveBeenCalledWith('main', 'feature/new');
      expect(branchHandler.getLastBranch()).toBe('feature/new');
    });

    it('should invoke multiple callbacks on branch change', async () => {
      let currentBranch = 'main';

      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: `${currentBranch}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      branchHandler.onBranchChange(callback1);
      branchHandler.onBranchChange(callback2);

      // First check
      await branchHandler.checkBranchChange();

      // Change branch
      currentBranch = 'develop';

      // Second check
      await branchHandler.checkBranchChange();

      expect(callback1).toHaveBeenCalledWith('main', 'develop');
      expect(callback2).toHaveBeenCalledWith('main', 'develop');
    });

    it('should continue checking even if a callback throws', async () => {
      let currentBranch = 'main';

      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: `${currentBranch}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const errorCallback = vi
        .fn()
        .mockRejectedValue(new Error('Callback error'));
      const successCallback = vi.fn();

      branchHandler.onBranchChange(errorCallback);
      branchHandler.onBranchChange(successCallback);

      // First check
      await branchHandler.checkBranchChange();

      // Change branch
      currentBranch = 'develop';

      // Second check - should not throw
      await branchHandler.checkBranchChange();

      expect(errorCallback).toHaveBeenCalled();
      expect(successCallback).toHaveBeenCalled();
    });
  });

  describe('offBranchChange', () => {
    it('should remove a callback', async () => {
      let currentBranch = 'main';

      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: `${currentBranch}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const callback = vi.fn();
      branchHandler.onBranchChange(callback);

      // First check
      await branchHandler.checkBranchChange();

      // Remove callback
      branchHandler.offBranchChange(callback);

      // Change branch
      currentBranch = 'develop';

      // Second check
      await branchHandler.checkBranchChange();

      // Callback should not have been called
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('setLastBranch', () => {
    it('should set the last branch without triggering callbacks', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { stdout: 'develop\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const callback = vi.fn();
      branchHandler.onBranchChange(callback);

      // Set last branch to 'main'
      branchHandler.setLastBranch('main');

      // Check for changes (current is 'develop', last is 'main')
      const changed = await branchHandler.checkBranchChange();

      expect(changed).toBe(true);
      expect(callback).toHaveBeenCalledWith('main', 'develop');
    });
  });

  describe('isGitRepository', () => {
    it('should return true for a git repository', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --git-dir')) {
          return { stdout: '.git\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const isRepo = await branchHandler.isGitRepository();
      expect(isRepo).toBe(true);
    });

    it('should return false when not in a git repository', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('rev-parse --git-dir')) {
          throw new Error('not a git repository');
        }
        return { stdout: '', stderr: '' };
      });

      const isRepo = await branchHandler.isGitRepository();
      expect(isRepo).toBe(false);
    });
  });

  describe('getChangedFilesBetween', () => {
    it('should return list of changed files', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('git diff --name-only')) {
          return {
            stdout: 'src/a.ts\nsrc/b.ts\ntest/c.test.ts\n',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      const files = await branchHandler.getChangedFilesBetween(
        'main',
        'feature',
      );

      expect(files).toEqual(['src/a.ts', 'src/b.ts', 'test/c.test.ts']);
    });

    it('should return empty array on diff failure', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('git diff --name-only')) {
          throw new Error('no common ancestor');
        }
        return { stdout: '', stderr: '' };
      });

      const files = await branchHandler.getChangedFilesBetween(
        'main',
        'orphan-branch',
      );

      expect(files).toEqual([]);
    });
  });

  describe('getModifiedFiles', () => {
    it('should return list of modified files', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('git diff --name-only HEAD')) {
          return { stdout: 'modified.ts\nchanged.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const files = await branchHandler.getModifiedFiles();

      expect(files).toEqual(['modified.ts', 'changed.ts']);
    });
  });

  describe('getUntrackedFiles', () => {
    it('should return list of untracked files', async () => {
      mockExecWithImplementation((cmd) => {
        if (cmd.includes('ls-files --others')) {
          return { stdout: 'new-file.ts\nanother.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const files = await branchHandler.getUntrackedFiles();

      expect(files).toEqual(['new-file.ts', 'another.ts']);
    });
  });
});

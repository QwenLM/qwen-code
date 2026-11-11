/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs } from '../utils/gitCommandPolicy.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  readCurrentGitBranch,
  getProjectRootForWorktree,
  findProjectRootForWorktree,
  createWorktreeService,
  createWorktree,
  isGeminiWorktree,
  hasWorktreeChanges,
  cleanupWorktree,
  getWorktreePath,
  // New exports for P0/P1 features
  validateWorktreeSlug,
  flattenSlug,
  worktreeBranchName,
  parsePRReference,
  countWorktreeChanges,
  hasWorktreeCreateHook,
  hasWorktreeRemoveHook,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  executeWorktreeRemoveHookWithStatus,
  cleanupWorktreeSession,
  ownsWorktreeLifecycle,
  worktreesDir,
  WorktreeRepositoryNotFoundError,
  normalizeWorktreeCreationSettings,
} from './worktreeService.js';
import { execFile as execFileCb } from 'node:child_process';
import { CONFIG_DIR } from '../utils/paths.js';
import { runLogger } from '../utils/runLogger.js';
import { HookEventName } from '../hooks/types.js';
import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import { isWorktreeOwnedBySession } from './worktree-owner-state.js';
import { readGitHead, resolveGitRepositoryLayout } from '../utils/gitUtils.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});
vi.mock('node:fs/promises');
vi.mock('./worktree-owner-state.js', () => ({
  isWorktreeOwnedBySession: vi.fn(),
  readWorktreeOwnerState: vi.fn(),
}));
vi.mock('../utils/gitUtils.js', () => ({
  createGitCommandEnv: vi.fn((source: NodeJS.ProcessEnv = process.env) => ({
    ...source,
  })),
  readGitHead: vi.fn(),
  resolveGitRepositoryLayout: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
  };
});

// Helper: make the mocked execFile call back with { stdout, stderr }
const mockExecFile = vi.mocked(execFileCb);

function mockExecFileResolve(stdout: string) {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        stdout,
        '',
      );
      return {} as ReturnType<typeof execFileCb>;
    },
  );
}

function mockExecFileReject(error: Error) {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error) => void)(error);
      return {} as ReturnType<typeof execFileCb>;
    },
  );
}

// For tests that use mockExecFile broadly (any call resolves)
function mockExecFileResolveAll(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        stdout,
        '',
      );
      return {} as ReturnType<typeof execFileCb>;
    },
  );
}

function expectGitCall(index: number, cwd: string, args: string[]): void {
  expect(mockExecFile).toHaveBeenNthCalledWith(
    index,
    'git',
    [...internalGitArgs(), '-C', cwd, ...args],
    { env: expect.any(Object) },
    expect.any(Function),
  );
}

describe('worktree utilities', () => {
  const projectRoot = path.resolve('/mock/project');
  const worktreeName = 'test-feature';
  const expectedPath = path.join(
    projectRoot,
    CONFIG_DIR,
    'worktrees',
    worktreeName,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) =>
      cwd.includes(`${path.sep}worktrees${path.sep}`)
        ? null
        : {
            worktreeRoot: cwd,
            gitDir: path.join(cwd, '.git'),
            commonDir: path.join(cwd, '.git'),
            isWorktree: false,
          },
    );
    vi.mocked(readGitHead).mockResolvedValue(null);
  });

  describe('getProjectRootForWorktree', () => {
    it('should return the project root from repository metadata', async () => {
      const result = await getProjectRootForWorktree(projectRoot);
      expect(result).toBe(projectRoot);
      expect(resolveGitRepositoryLayout).toHaveBeenCalledExactlyOnceWith(
        projectRoot,
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should resolve the common repository root from a linked worktree', async () => {
      const worktreePath = `/mock/project/${CONFIG_DIR}/worktrees/my-feature`;
      vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
        worktreeRoot: worktreePath,
        gitDir: '/mock/project/.git/worktrees/my-feature',
        commonDir: '/mock/project/.git',
        isWorktree: true,
      });

      const result = await getProjectRootForWorktree(worktreePath);
      expect(result).toBe('/mock/project');
    });

    it('should fall back to the unchanged cwd outside a repository', async () => {
      vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

      const result = await getProjectRootForWorktree('/mock/non-git/src');
      expect(result).toBe('/mock/non-git/src');
    });

    it('should return undefined from strict lookup outside a repository', async () => {
      vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

      const result = await findProjectRootForWorktree('/mock/non-git/src');
      expect(result).toBeUndefined();
    });

    it('should reject service creation before filesystem writes outside a git repository', async () => {
      vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

      await expect(
        createWorktreeService('/mock/non-git/src'),
      ).rejects.toBeInstanceOf(WorktreeRepositoryNotFoundError);
      expect(fs.mkdir).not.toHaveBeenCalled();
    });
  });

  describe('getWorktreePath', () => {
    it('should return the correct path for a given name', () => {
      expect(getWorktreePath(projectRoot, worktreeName)).toBe(expectedPath);
    });
  });

  describe('createWorktree', () => {
    function deferGitCalls() {
      const callbacks: Array<
        (err: Error | null, stdout: string, stderr: string) => void
      > = [];
      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          callbacks.push(
            cb as (err: Error | null, stdout: string, stderr: string) => void,
          );
          return {} as ReturnType<typeof execFileCb>;
        },
      );
      return callbacks;
    }

    it('should execute git worktree add with correct branch and path', async () => {
      mockExecFileResolve('');

      const resultPath = await createWorktree(projectRoot, worktreeName);

      expect(resultPath).toBe(expectedPath);
      expectGitCall(1, projectRoot, [
        'worktree',
        'add',
        expectedPath,
        '-B',
        `worktree-${worktreeName}`,
      ]);
    });

    it('should throw when git worktree add fails', async () => {
      // When git worktree add fails, createWorktree must throw (fail-closed)
      // instead of silently returning the path.
      mockExecFileReject(new Error('git failed'));
      // tearDown attempt (worktree remove)
      mockExecFileResolve('');

      await expect(createWorktree(projectRoot, worktreeName)).rejects.toThrow(
        /Failed to create worktree/,
      );
    });

    it('serializes concurrent worktree mutations in the same repository', async () => {
      const callbacks = deferGitCalls();

      const first = createWorktree(projectRoot, 'first');
      const second = createWorktree(projectRoot, 'second');

      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()!(null, '', '');
      await first;

      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()!(null, '', '');
      await second;
    });

    it('shares the repository lock across linked checkouts', async () => {
      const callbacks = deferGitCalls();
      const linkedCheckout = path.join(projectRoot, 'linked');
      vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) => ({
        worktreeRoot: cwd,
        gitDir:
          cwd === projectRoot
            ? path.join(projectRoot, '.git')
            : path.join(projectRoot, '.git', 'worktrees', 'linked'),
        commonDir: path.join(projectRoot, '.git'),
        isWorktree: cwd !== projectRoot,
      }));

      const first = createWorktree(projectRoot, 'first');
      const second = createWorktree(linkedCheckout, 'second');

      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()!(null, '', '');
      await first;

      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()!(null, '', '');
      await second;
    });

    it('allows concurrent worktree mutations in different repositories', async () => {
      const callbacks = deferGitCalls();

      const first = createWorktree('/mock/repository-a', 'first');
      const second = createWorktree('/mock/repository-b', 'second');

      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      callbacks.splice(0).forEach((callback) => callback(null, '', ''));
      await Promise.all([first, second]);
    });

    it('serializes creation and cleanup in the same repository', async () => {
      const callbacks = deferGitCalls();
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const creation = createWorktree(projectRoot, 'first');
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));

      const cleanup = cleanupWorktree(
        path.join(projectRoot, CONFIG_DIR, 'worktrees', 'old'),
        projectRoot,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callbacks).toHaveLength(1);

      callbacks.shift()!(null, '', '');
      await creation;
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));

      callbacks.shift()!(null, '', '');
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()!(null, '', '');
      await cleanup;
    });
  });

  describe('isGeminiWorktree', () => {
    it('should return true for a valid gemini worktree path', () => {
      expect(isGeminiWorktree(expectedPath, projectRoot)).toBe(true);
      expect(
        isGeminiWorktree(path.join(expectedPath, 'src'), projectRoot),
      ).toBe(true);
    });

    it('should return false for a path outside gemini worktrees', () => {
      expect(isGeminiWorktree(path.join(projectRoot, 'src'), projectRoot)).toBe(
        false,
      );
      expect(
        isGeminiWorktree(path.resolve('/some/other/path'), projectRoot),
      ).toBe(false);
    });
  });

  describe('ownsWorktreeLifecycle', () => {
    it('requires explicit owner provenance for newly detected worktrees', () => {
      expect(
        ownsWorktreeLifecycle({
          path: '/repo/.qwen/worktrees/feature',
          lifecycle: 'attached',
        }),
      ).toBe(false);
      expect(
        ownsWorktreeLifecycle({
          path: '/repo/.qwen/worktrees/feature',
          lifecycle: 'owner',
        }),
      ).toBe(true);
    });

    it('treats legacy state without explicit provenance as attached', () => {
      expect(
        ownsWorktreeLifecycle({
          path: '/repo/.qwen/worktrees/feature',
          originalCwd: '/repo',
        }),
      ).toBe(false);
      expect(
        ownsWorktreeLifecycle({
          path: '/repo/.qwen/worktrees/feature',
          originalCwd: '/repo/.qwen/worktrees/feature',
        }),
      ).toBe(false);
    });
  });

  describe('hasWorktreeChanges', () => {
    it('should return true if git status --porcelain has output', async () => {
      mockExecFileResolve(' M somefile.txt\n?? newfile.txt');

      const hasChanges = await hasWorktreeChanges(expectedPath);

      expect(hasChanges).toBe(true);
      expectGitCall(1, expectedPath, ['status', '--porcelain']);
    });

    it('should return true if there are untracked files', async () => {
      mockExecFileResolve('?? untracked-file.txt\n');

      const hasChanges = await hasWorktreeChanges(expectedPath);

      expect(hasChanges).toBe(true);
    });

    it('should return true if HEAD differs from baseSha (rev-list > 0)', async () => {
      mockExecFileResolve(''); // status clean
      mockExecFileResolve('3'); // rev-list --count returns 3 commits ahead

      const hasChanges = await hasWorktreeChanges(expectedPath, 'base-sha');

      expect(hasChanges).toBe(true);
    });

    it('should return false if status is clean and rev-list count is 0', async () => {
      mockExecFileResolve(''); // status clean
      mockExecFileResolve('0'); // rev-list --count returns 0

      const hasChanges = await hasWorktreeChanges(expectedPath, 'base-sha');

      expect(hasChanges).toBe(false);
    });

    it('should return true if rev-list fails (non-zero exit code)', async () => {
      mockExecFileResolve(''); // status clean
      // execFileNoThrow wraps the error — rev-list returns non-zero exit code
      // which the function interprets as "has changes"
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          (cb as (err: Error, stdout: string, stderr: string) => void)(
            new Error('bad revision'),
            '',
            'fatal: bad revision',
          );
          return {} as ReturnType<typeof execFileCb>;
        },
      );

      const hasChanges = await hasWorktreeChanges(expectedPath, 'base-sha');

      expect(hasChanges).toBe(true);
    });
  });

  describe('cleanupWorktree', () => {
    it('should remove a clean worktree and delete its branch regardless of merge status', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockExecFileResolve(`worktree-${worktreeName}\n`); // branch --show-current
      mockExecFileResolve(''); // worktree remove
      mockExecFileResolve(''); // branch -D

      await cleanupWorktree(expectedPath, projectRoot);

      expect(mockExecFile).toHaveBeenCalledTimes(3);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        'git',
        [...internalGitArgs(), '-C', expectedPath, 'branch', '--show-current'],
        { env: expect.any(Object) },
        expect.any(Function),
      );
      expectGitCall(2, projectRoot, ['worktree', 'remove', expectedPath]);
      expectGitCall(3, projectRoot, [
        'branch',
        '-D',
        `worktree-${worktreeName}`,
      ]);
    });

    it('should handle branch discovery failure gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockExecFileResolve(''); // no branch found
      mockExecFileResolve(''); // remove

      await cleanupWorktree(expectedPath, projectRoot);

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expectGitCall(2, projectRoot, ['worktree', 'remove', expectedPath]);
    });

    it('uses force only when explicitly requested', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockExecFileResolve(`worktree-${worktreeName}\n`);
      mockExecFileResolve('');
      mockExecFileResolve('');

      await cleanupWorktree(expectedPath, projectRoot, { force: true });

      expectGitCall(2, projectRoot, [
        'worktree',
        'remove',
        expectedPath,
        '--force',
      ]);
      expectGitCall(3, projectRoot, [
        'branch',
        '-D',
        `worktree-${worktreeName}`,
      ]);
    });

    it('does not treat an access probe error as an already removed worktree', async () => {
      vi.mocked(fs.access).mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      await expect(cleanupWorktree(expectedPath, projectRoot)).rejects.toThrow(
        'permission denied',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('reports branch deletion failure after the checkout is removed', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockExecFileResolve(`worktree-${worktreeName}\n`);
      mockExecFileResolve('');
      mockExecFileReject(new Error('branch deletion failed'));

      await expect(cleanupWorktree(expectedPath, projectRoot)).rejects.toThrow(
        `git branch delete failed for worktree-${worktreeName}`,
      );
    });
  });
});

// ===========================================================================
// P0/P1 Feature Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// validateWorktreeSlug (P0)
// ---------------------------------------------------------------------------

describe('validateWorktreeSlug', () => {
  it('accepts valid simple slugs', () => {
    expect(() => validateWorktreeSlug('my-feature')).not.toThrow();
    expect(() => validateWorktreeSlug('feature_123')).not.toThrow();
    expect(() => validateWorktreeSlug('abc')).not.toThrow();
  });

  it('accepts slugs with forward slashes', () => {
    expect(() => validateWorktreeSlug('user/feature')).not.toThrow();
    expect(() => validateWorktreeSlug('a/b/c')).not.toThrow();
  });

  it('accepts dots and underscores in segments', () => {
    expect(() => validateWorktreeSlug('v2.0')).not.toThrow();
    expect(() => validateWorktreeSlug('my_branch')).not.toThrow();
  });

  it('rejects path traversal with ..', () => {
    expect(() => validateWorktreeSlug('..')).toThrow(
      /must not contain.*"\.\."/,
    );
    expect(() => validateWorktreeSlug('foo/..')).toThrow(
      /must not contain.*"\.\."/,
    );
    expect(() => validateWorktreeSlug('../bar')).toThrow(
      /must not contain.*"\.\."/,
    );
  });

  it('rejects . segment', () => {
    expect(() => validateWorktreeSlug('.')).toThrow(/must not contain.*"\."/);
  });

  it('rejects slugs with special characters', () => {
    expect(() => validateWorktreeSlug('foo bar')).toThrow(/must be non-empty/);
    expect(() => validateWorktreeSlug('foo@bar')).toThrow(/must be non-empty/);
    expect(() => validateWorktreeSlug('foo:bar')).toThrow(/must be non-empty/);
  });

  it('rejects empty segment from double slash', () => {
    expect(() => validateWorktreeSlug('foo//bar')).toThrow(/must be non-empty/);
  });

  it('rejects slugs exceeding max length', () => {
    const longSlug = 'a'.repeat(257);
    expect(() => validateWorktreeSlug(longSlug)).toThrow(/256 characters/);
  });

  it('accepts slug at exactly max length', () => {
    const maxSlug = 'a'.repeat(256);
    expect(() => validateWorktreeSlug(maxSlug)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// flattenSlug
// ---------------------------------------------------------------------------

describe('flattenSlug', () => {
  it('passes through simple slugs unchanged', () => {
    expect(flattenSlug('my-feature')).toBe('my-feature');
  });

  it('replaces forward slashes with plus signs', () => {
    expect(flattenSlug('user/feature')).toBe('user+feature');
    expect(flattenSlug('a/b/c')).toBe('a+b+c');
  });
});

// ---------------------------------------------------------------------------
// worktreeBranchName
// ---------------------------------------------------------------------------

describe('worktreeBranchName', () => {
  it('creates branch name from simple slug', () => {
    expect(worktreeBranchName('my-feature')).toBe('worktree-my-feature');
  });

  it('flattens slashes in branch name', () => {
    expect(worktreeBranchName('user/feature')).toBe('worktree-user+feature');
  });
});

// ---------------------------------------------------------------------------
// parsePRReference
// ---------------------------------------------------------------------------

describe('parsePRReference', () => {
  it('parses GitHub PR URL', () => {
    expect(parsePRReference('https://github.com/owner/repo/pull/123')).toBe(
      123,
    );
  });

  it('parses GitHub PR URL with trailing slash', () => {
    expect(parsePRReference('https://github.com/owner/repo/pull/456/')).toBe(
      456,
    );
  });

  it('parses #N format', () => {
    expect(parsePRReference('#42')).toBe(42);
  });

  it('parses a GitLab merge request URL', () => {
    expect(
      parsePRReference('https://gitlab.com/owner/repo/-/merge_requests/7'),
    ).toBe(7);
  });

  it('parses a GitLab merge request URL under nested groups', () => {
    expect(
      parsePRReference(
        'https://gitlab.example.com/group/subgroup/repo/-/merge_requests/89/',
      ),
    ).toBe(89);
  });

  it('ignores query strings and fragments on review URLs', () => {
    expect(
      parsePRReference('https://github.com/owner/repo/pull/12?diff=split'),
    ).toBe(12);
    expect(
      parsePRReference(
        'https://gitlab.com/owner/repo/-/merge_requests/34#note_1',
      ),
    ).toBe(34);
  });

  it('returns null for non-PR strings', () => {
    expect(parsePRReference('not-a-pr')).toBeNull();
    expect(parsePRReference('')).toBeNull();
  });

  it('returns null for invalid #N format', () => {
    expect(parsePRReference('#abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// countWorktreeChanges (P1 - change count replacing boolean)
// ---------------------------------------------------------------------------

describe('countWorktreeChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns changedFiles and commits count', async () => {
    // git status --porcelain returns 2 lines
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        'M file1.ts\nA file2.ts\n',
        '',
      );
      return {} as ReturnType<typeof execFileCb>;
    });
    // git rev-list returns 3
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        '3\n',
        '',
      );
      return {} as ReturnType<typeof execFileCb>;
    });

    const result = await countWorktreeChanges('/wt', 'abc123');
    expect(result).toEqual({ changedFiles: 2, commits: 3 });
  });

  it('returns null when git status fails', async () => {
    mockExecFileReject(new Error('fatal: not a git repository'));
    const result = await countWorktreeChanges('/wt', 'abc123');
    expect(result).toBeNull();
  });

  it('returns null when no baseSha provided', async () => {
    mockExecFileResolve('');
    const result = await countWorktreeChanges('/wt');
    expect(result).toBeNull();
  });

  it('returns null when rev-list fails', async () => {
    // status succeeds
    mockExecFileResolve('');
    // rev-list fails
    mockExecFileReject(new Error('bad revision'));

    const result = await countWorktreeChanges('/wt', 'abc123');
    expect(result).toBeNull();
  });

  it('returns 0 changes when worktree is clean', async () => {
    // git status clean
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return {} as ReturnType<typeof execFileCb>;
    });
    // rev-list returns 0
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        '0\n',
        '',
      );
      return {} as ReturnType<typeof execFileCb>;
    });

    const result = await countWorktreeChanges('/wt', 'abc123');
    expect(result).toEqual({ changedFiles: 0, commits: 0 });
  });
});

// ---------------------------------------------------------------------------
// hasWorktreeCreateHook / hasWorktreeRemoveHook (P0 - hook detection)
// ---------------------------------------------------------------------------

describe('hasWorktreeCreateHook', () => {
  it('returns false when no hookSystem provided', () => {
    expect(hasWorktreeCreateHook()).toBe(false);
    expect(hasWorktreeCreateHook(undefined)).toBe(false);
  });

  it('returns false when registry has no WorktreeCreate hooks', () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: (eventName: string) =>
          eventName === HookEventName.WorktreeCreate ? [] : [],
      }),
    };
    expect(hasWorktreeCreateHook(hookSystem)).toBe(false);
  });

  it('returns true when registry has WorktreeCreate hooks', () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: (eventName: string) =>
          eventName === HookEventName.WorktreeCreate
            ? [{ type: 'command', command: 'echo test' }]
            : [],
      }),
    };
    expect(hasWorktreeCreateHook(hookSystem)).toBe(true);
  });
});

describe('hasWorktreeRemoveHook', () => {
  it('returns false when no hookSystem provided', () => {
    expect(hasWorktreeRemoveHook()).toBe(false);
  });

  it('returns true when registry has WorktreeRemove hooks', () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: (eventName: string) =>
          eventName === HookEventName.WorktreeRemove
            ? [{ type: 'command', command: 'echo remove' }]
            : [],
      }),
    };
    expect(hasWorktreeRemoveHook(hookSystem)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeWorktreeCreateHook / executeWorktreeRemoveHook (P0 - hook execution)
// ---------------------------------------------------------------------------

describe('executeWorktreeCreateHook', () => {
  afterEach(() => {
    vi.mocked(fs.realpath).mockReset();
  });

  it('extracts worktreePath from hookSpecificOutput', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/canonical/worktree');
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [
          { hookSpecificOutput: { worktreePath: '/path/to/worktree' } },
        ],
        errors: [],
        totalDuration: 100,
      } satisfies AggregatedHookResult),
    };

    const result = await executeWorktreeCreateHook(hookSystem, 'my-wt');
    expect(result.worktreePath).toBe('/canonical/worktree');
    expect(fs.realpath).toHaveBeenCalledWith('/path/to/worktree');
    expect(hookSystem.fireWorktreeCreateEvent).toHaveBeenCalledWith('my-wt');
  });

  it.each([
    { hookSpecificOutput: { worktreePath: './relative-worktree' } },
    { stdoutContent: './relative-worktree\n' },
  ])(
    'rejects a relative hook path instead of resolving it against the process cwd: %j',
    async (output) => {
      vi.mocked(fs.realpath).mockResolvedValue(
        '/unrelated-project/relative-worktree',
      );
      const hookSystem = {
        fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
          success: true,
          successfulHookCount: 1,
          allOutputs: [output],
          errors: [],
          totalDuration: 0,
        }),
      };

      await expect(
        executeWorktreeCreateHook(hookSystem, 'my-wt'),
      ).rejects.toThrow(/absolute path/i);
    },
  );

  it('falls back to stdoutContent when no hookSpecificOutput', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/canonical/stdout/path');
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [{ stdoutContent: '  /stdout/path  \n' }],
        errors: [],
        totalDuration: 50,
      } satisfies unknown as AggregatedHookResult),
    };

    const result = await executeWorktreeCreateHook(hookSystem, 'my-wt');
    expect(result.worktreePath).toBe('/canonical/stdout/path');
    expect(fs.realpath).toHaveBeenCalledWith('/stdout/path');
  });

  it('rejects a hook path that cannot be canonicalized', async () => {
    vi.mocked(fs.realpath).mockRejectedValue(new Error('not found'));
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [
          { hookSpecificOutput: { worktreePath: '/missing/worktree' } },
        ],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeCreateHook(hookSystem, 'my-wt'),
    ).rejects.toThrow(/invalid worktree path.*not found/);
  });

  it('rejects a hook path containing only whitespace', async () => {
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [{ stdoutContent: ' \n\t ' }],
        errors: [],
        totalDuration: 10,
      } satisfies unknown as AggregatedHookResult),
    };

    await expect(
      executeWorktreeCreateHook(hookSystem, 'my-wt'),
    ).rejects.toThrow(/returned no worktree path/);
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it('throws when hooks fail', async () => {
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: false,
        allOutputs: [],
        errors: [new Error('hook error')],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeCreateHook(hookSystem, 'my-wt'),
    ).rejects.toThrow(/WorktreeCreate hook failed/);
  });

  it('throws when hooks succeed but return no path', async () => {
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [{}],
        errors: [],
        totalDuration: 10,
      } satisfies unknown as AggregatedHookResult),
    };

    await expect(
      executeWorktreeCreateHook(hookSystem, 'my-wt'),
    ).rejects.toThrow(/returned no worktree path/);
  });

  it('treats an empty successful result as no hook having run', async () => {
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeCreateHook(hookSystem, 'my-wt'),
    ).rejects.toThrow(/WorktreeCreate hook failed.*no successful output/);
  });

  it('throws when every hook failed without producing an error object', async () => {
    // Hook processes that exit non-zero without throwing leave `errors` empty,
    // so `success` stays true. Creation must still fail, otherwise the caller
    // would treat a path from a failed hook as a usable worktree.
    vi.mocked(fs.realpath).mockResolvedValue('/canonical/worktree');
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        successfulHookCount: 0,
        allOutputs: [
          { hookSpecificOutput: { worktreePath: '/path/to/worktree' } },
        ],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeCreateHook(hookSystem, 'my-wt'),
    ).rejects.toThrow(/WorktreeCreate hook failed/);
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it('accepts the path when at least one hook succeeded', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/canonical/worktree');
    const hookSystem = {
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue({
        success: true,
        successfulHookCount: 1,
        allOutputs: [
          { hookSpecificOutput: { worktreePath: '/path/to/worktree' } },
        ],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    const result = await executeWorktreeCreateHook(hookSystem, 'my-wt');
    expect(result.worktreePath).toBe('/canonical/worktree');
  });
});

describe('executeWorktreeRemoveHook', () => {
  it('returns false when no hooks registered', async () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: () => [],
      }),
      fireWorktreeRemoveEvent: vi.fn(),
    };

    const result = await executeWorktreeRemoveHook(hookSystem, '/path/to/wt');
    expect(result).toBe(false);
    expect(hookSystem.fireWorktreeRemoveEvent).not.toHaveBeenCalled();
  });

  it('returns true and fires event when hooks registered', async () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: (eventName: string) =>
          eventName === HookEventName.WorktreeRemove
            ? [{ type: 'command', command: 'echo removed' }]
            : [],
      }),
      fireWorktreeRemoveEvent: vi.fn().mockResolvedValue({
        success: true,
        successfulHookCount: 1,
        allOutputs: [],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    const result = await executeWorktreeRemoveHook(hookSystem, '/path/to/wt');
    expect(result).toBe(true);
    expect(hookSystem.fireWorktreeRemoveEvent).toHaveBeenCalledWith(
      '/path/to/wt',
    );
  });

  it('returns false when every configured hook fails', async () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: () => [
          { type: 'command', command: 'exit 1' },
          { type: 'command', command: 'exit 2' },
        ],
      }),
      fireWorktreeRemoveEvent: vi.fn().mockResolvedValue({
        success: true,
        successfulHookCount: 0,
        allOutputs: [],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeRemoveHook(hookSystem, '/path/to/wt'),
    ).resolves.toBe(false);
  });

  it('returns true when at least one configured hook succeeds', async () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: () => [
          { type: 'command', command: 'exit 1' },
          { type: 'command', command: 'echo removed' },
        ],
      }),
      fireWorktreeRemoveEvent: vi.fn().mockResolvedValue({
        success: true,
        successfulHookCount: 1,
        allOutputs: [],
        errors: [],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeRemoveHook(hookSystem, '/path/to/wt'),
    ).resolves.toBe(true);
  });

  it('returns false when hooks are registered but none of them ran', async () => {
    // The hook system reports an empty success when every hook for the event is
    // async or filtered out by an `if:` condition. Nothing removed the
    // worktree, so it must not be reported as removed.
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: () => [
          { type: 'command', command: 'echo never-runs' },
          { type: 'command', command: 'echo also-never' },
        ],
      }),
      fireWorktreeRemoveEvent: vi.fn().mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      } satisfies unknown as AggregatedHookResult),
    };

    await expect(
      executeWorktreeRemoveHook(hookSystem, '/path/to/wt'),
    ).resolves.toBe(false);
  });

  it('reports unknown when every configured hook fails', async () => {
    const hookSystem = {
      getRegistry: () => ({
        getHooksForEvent: () => [{ type: 'command', command: 'exit 1' }],
      }),
      fireWorktreeRemoveEvent: vi.fn().mockResolvedValue({
        success: false,
        successfulHookCount: 0,
        allOutputs: [],
        errors: [new Error('remove failed')],
        totalDuration: 10,
      } satisfies AggregatedHookResult),
    };

    await expect(
      executeWorktreeRemoveHookWithStatus(hookSystem, '/path/to/wt'),
    ).resolves.toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// cleanupWorktreeSession (P0 - session exit with remove)
// ---------------------------------------------------------------------------

describe('cleanupWorktreeSession', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.realpath).mockImplementation(async (value) => String(value));
    vi.mocked(isWorktreeOwnedBySession).mockResolvedValue(true);
  });

  afterEach(() => {
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
  });

  it('uses only the explicit cleanup request', async () => {
    mockExecFileResolveAll('');
    const result = await cleanupWorktreeSession({
      worktreeSettings: {
        name: 'test',
        path: '/tmp/wt',
        worktreeCwd: '/tmp/wt',
        baseSha: 'base',
        lifecycle: 'owner',
        originalCwd,
        sessionId: 's1',
      },
      currentSessionId: 's1',
    });
    expect(result).toEqual({ removed: true });
  });

  it('cleans up a Git worktree from explicit settings', async () => {
    mockExecFileResolveAll('');

    const result = await cleanupWorktreeSession({
      worktreeSettings: {
        name: 'test',
        path: '/tmp/wt',
        worktreeCwd: '/tmp/wt',
        baseSha: 'base',
        lifecycle: 'owner',
        originalCwd,
        sessionId: 's1',
        hookBased: false,
      },
      currentSessionId: 's1',
    });

    expect(result).toEqual({ removed: true });
    expect(process.cwd()).toBe(originalCwd);
  });

  it('uses hook for hook-based worktree cleanup', async () => {
    const hookSystem = {
      hasWorktreeRemoveHook: () => true,
      executeWorktreeRemoveHook: vi.fn().mockResolvedValue(true),
    };

    const result = await cleanupWorktreeSession(
      {
        worktreeSettings: {
          name: 'hook-wt',
          path: '/hook/wt',
          worktreeCwd: '/hook/wt',
          baseSha: 'base',
          lifecycle: 'owner',
          originalCwd,
          sessionId: 's1',
          hookBased: true,
        },
        currentSessionId: 's1',
      },
      hookSystem,
    );

    expect(result).toEqual({ removed: true });
    expect(hookSystem.executeWorktreeRemoveHook).toHaveBeenCalledWith(
      '/hook/wt',
    );
  });

  it('preserves a hook-based worktree when the hook cannot confirm removal', async () => {
    const hookSystem = {
      executeWorktreeRemoveHook: vi.fn().mockResolvedValue({
        status: 'unknown' as const,
      }),
    };

    const result = await cleanupWorktreeSession(
      {
        worktreeSettings: {
          name: 'hook-wt',
          path: '/hook/wt',
          worktreeCwd: '/hook/wt',
          baseSha: 'base',
          lifecycle: 'owner',
          originalCwd,
          sessionId: 'session-1',
          hookBased: true,
        },
        currentSessionId: 'session-1',
      },
      hookSystem,
    );

    expect(result).toMatchObject({
      removed: false,
      reason: 'cleanup-failed',
      message: expect.stringMatching(/did not confirm/),
    });
  });

  it('fails closed when durable owner metadata does not match', async () => {
    vi.mocked(isWorktreeOwnedBySession).mockResolvedValue(false);

    const result = await cleanupWorktreeSession({
      worktreeSettings: {
        name: 'test',
        path: '/tmp/wt',
        worktreeCwd: '/tmp/wt',
        baseSha: 'base',
        lifecycle: 'owner',
        originalCwd,
        sessionId: 's1',
      },
      currentSessionId: 's1',
    });

    expect(result).toEqual({ removed: false, reason: 'owner-mismatch' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('does not require hidden session state during cleanup', async () => {
    vi.mocked(fs.realpath).mockRejectedValue(new Error('realpath failed'));

    const result = await cleanupWorktreeSession({
      worktreeSettings: {
        name: 'test',
        path: '/tmp/wt',
        worktreeCwd: '/tmp/wt',
        baseSha: 'base',
        lifecycle: 'owner',
        originalCwd,
        sessionId: 's1',
      },
      currentSessionId: 's1',
    });

    expect(result).toEqual({ removed: true });
    expect(isWorktreeOwnedBySession).toHaveBeenCalledWith(
      '/tmp/wt',
      's1',
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// worktreesDir
// ---------------------------------------------------------------------------

describe('worktreesDir', () => {
  it('returns the correct worktrees directory path', () => {
    const result = worktreesDir('/home/user/project');
    expect(result).toBe(path.join('/home/user/project', CONFIG_DIR, 'worktrees'));
  });
});

// ---------------------------------------------------------------------------
// normalizeWorktreeCreationSettings — settings arrive from user-authored JSON
// ---------------------------------------------------------------------------

describe('normalizeWorktreeCreationSettings', () => {
  it('returns an empty object for non-object input', () => {
    expect(normalizeWorktreeCreationSettings(undefined)).toEqual({});
    expect(normalizeWorktreeCreationSettings(null)).toEqual({});
    expect(normalizeWorktreeCreationSettings('fresh')).toEqual({});
  });

  it('keeps both supported baseRef values', () => {
    expect(normalizeWorktreeCreationSettings({ baseRef: 'fresh' })).toEqual({
      baseRef: 'fresh',
    });
    expect(normalizeWorktreeCreationSettings({ baseRef: 'head' })).toEqual({
      baseRef: 'head',
    });
  });

  it('drops an unsupported baseRef instead of passing it to git', () => {
    // Reaching git with a bogus revision would surface as a confusing
    // rev-parse failure rather than a configuration problem.
    expect(
      normalizeWorktreeCreationSettings({ baseRef: 'origin/main' }),
    ).toEqual({});
    expect(normalizeWorktreeCreationSettings({ baseRef: 42 })).toEqual({});
  });

  it('keeps only string entries in path lists', () => {
    expect(
      normalizeWorktreeCreationSettings({
        sparsePaths: ['packages/core', 7, null, 'docs'],
        symlinkDirectories: ['node_modules', {}],
      }),
    ).toEqual({
      sparsePaths: ['packages/core', 'docs'],
      symlinkDirectories: ['node_modules'],
    });
  });

  it('omits path lists that are absent, empty, or not arrays', () => {
    expect(
      normalizeWorktreeCreationSettings({
        sparsePaths: [],
        symlinkDirectories: 'node_modules',
      }),
    ).toEqual({});
  });

  it('warns instead of silently dropping malformed path lists', () => {
    const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    normalizeWorktreeCreationSettings({
      sparsePaths: ['packages/core', 7],
      symlinkDirectories: 'node_modules',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-string entry in worktree.sparsePaths'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring worktree.symlinkDirectories'),
    );
  });
});

describe('readCurrentGitBranch filesystem metadata', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFileReject(new Error('Git unavailable'));
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      worktreeRoot: '/project',
      gitDir: '/project/.git',
      commonDir: '/project/.git',
      isWorktree: false,
    });
  });

  it('reads optional branch metadata without Git', async () => {
    vi.mocked(readGitHead).mockResolvedValue({ branch: 'feature/example' });
    await expect(readCurrentGitBranch('/project')).resolves.toBe(
      'feature/example',
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('continues when repository metadata is unavailable', async () => {
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);
    await expect(readCurrentGitBranch('/project')).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

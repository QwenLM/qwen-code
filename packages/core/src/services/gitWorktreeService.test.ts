/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitWorktreeService } from './gitWorktreeService.js';
import type { WorktreeInfo } from './gitWorktreeService.js';
import { isCommandAvailable } from '../utils/shell-utils.js';

const hoistedMockSimpleGit = vi.hoisted(() => vi.fn());
const git = {
  env: vi.fn(),
  checkIsRepo: vi.fn(),
  init: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  revparse: vi.fn(),
  raw: vi.fn(),
  branch: vi.fn(),
  diff: vi.fn(),
  merge: vi.fn(),
  stash: vi.fn(),
};

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

const runSetup = (service: GitWorktreeService, worktreeNames: string[]) =>
  service.setupWorktrees({
    sessionId: 's1',
    sourceRepoPath: '/repo',
    worktreeNames,
  });

function worktreeInfo(
  name: string,
  over: Partial<WorktreeInfo> = {},
): WorktreeInfo {
  return {
    id: `s1/${name}`,
    name,
    path: `/mock-qwen/worktrees/s1/worktrees/${name}`,
    branch: `worktrees/s1/${name}`,
    isActive: true,
    createdAt: 1,
    ...over,
  };
}

/** `git.raw` calls whose argv starts with `prefix`. */
const rawCalls = (...prefix: string[]) =>
  git.raw.mock.calls.filter(
    (call) =>
      Array.isArray(call[0]) && prefix.every((arg, i) => call[0][i] === arg),
  );

describe('GitWorktreeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    hoistedMockGetGlobalQwenDir.mockReturnValue('/mock-qwen');
    (isCommandAvailable as Mock).mockReturnValue({ available: true });

    hoistedMockSimpleGit.mockImplementation(() => {
      const instance = { ...git };
      git.env.mockReturnValue(instance);
      return instance;
    });

    git.checkIsRepo.mockResolvedValue(true);
    git.init.mockResolvedValue(undefined);
    git.add.mockResolvedValue(undefined);
    git.commit.mockResolvedValue(undefined);
    git.revparse.mockResolvedValue('main\n');
    git.raw.mockResolvedValue('');
    git.branch.mockResolvedValue({ branches: {} });
    git.diff.mockResolvedValue('');
    git.merge.mockResolvedValue(undefined);
    git.stash.mockResolvedValue('');

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
    git.checkIsRepo
      .mockRejectedValueOnce(new Error('root check failed'))
      .mockResolvedValueOnce(true);
    const service = new GitWorktreeService('/repo');

    await expect(service.isGitRepository()).resolves.toBe(true);
    expect(git.checkIsRepo).toHaveBeenNthCalledWith(1, 'is-repo-root');
    expect(git.checkIsRepo).toHaveBeenNthCalledWith(2);
  });

  it('isGitRepository should detect subdirectory inside an existing repo', async () => {
    // IS_REPO_ROOT returns false for a subdirectory, but checkIsRepo()
    // (without params) returns true because we're inside a repo.
    git.checkIsRepo.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const service = new GitWorktreeService('/repo/subdir');

    await expect(service.isGitRepository()).resolves.toBe(true);
    expect(git.checkIsRepo).toHaveBeenNthCalledWith(1, 'is-repo-root');
    expect(git.checkIsRepo).toHaveBeenNthCalledWith(2);
  });

  it('initializeRepository should initialize a new repo on main', async () => {
    git.checkIsRepo.mockResolvedValue(false);
    const service = new GitWorktreeService('/repo');

    const result = await service.initializeRepository();

    expect(result).toEqual({ initialized: true });
    expect(git.init).toHaveBeenCalledWith(false);
    expect(git.raw).toHaveBeenCalledWith([
      'symbolic-ref',
      'HEAD',
      'refs/heads/main',
    ]);
    expect(git.add).toHaveBeenCalledWith('.');
    expect(git.commit).toHaveBeenCalledWith('Initial commit', {
      '--allow-empty': null,
    });
    expect(git.init.mock.invocationCallOrder[0]!).toBeLessThan(
      git.raw.mock.invocationCallOrder[0]!,
    );
    expect(git.raw.mock.invocationCallOrder[0]!).toBeLessThan(
      git.commit.mock.invocationCallOrder[0]!,
    );
  });

  it('initializeRepository should not update HEAD for an existing repo', async () => {
    git.checkIsRepo.mockResolvedValue(true);
    const service = new GitWorktreeService('/repo');

    const result = await service.initializeRepository();

    expect(result).toEqual({ initialized: false });
    expect(git.init).not.toHaveBeenCalled();
    expect(git.raw).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
  });

  it('createWorktree should create a sanitized branch and worktree path', async () => {
    const service = new GitWorktreeService('/repo');

    const result = await service.createWorktree('s1', 'Model A');

    const expectedPath = path.join(
      '/mock-qwen',
      'worktrees',
      's1',
      'worktrees',
      'model-a',
    );
    expect(result.success).toBe(true);
    expect(result.worktree?.branch).toBe('main-s1-model-a');
    expect(result.worktree?.path).toBe(expectedPath);
    expect(git.raw).toHaveBeenCalledWith([
      'worktree',
      'add',
      '-b',
      'main-s1-model-a',
      expectedPath,
      'main',
    ]);
  });

  it('setupWorktrees should fail early for colliding sanitized names', async () => {
    const service = new GitWorktreeService('/repo');

    const result = await runSetup(service, ['Model A', 'model_a']);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('collides');
    expect(isCommandAvailable).not.toHaveBeenCalled();
  });

  it('setupWorktrees should return system error when git is unavailable', async () => {
    (isCommandAvailable as Mock).mockReturnValue({ available: false });
    const service = new GitWorktreeService('/repo');

    const result = await runSetup(service, ['model-a']);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      { name: 'system', error: 'Git is not installed. Please install Git.' },
    ]);
  });

  it('setupWorktrees should cleanup session after partial creation failure', async () => {
    const service = new GitWorktreeService('/repo');
    vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
    vi.spyOn(service, 'createWorktree')
      .mockResolvedValueOnce({
        success: true,
        worktree: worktreeInfo('a', { path: '/w/a' }),
      })
      .mockResolvedValueOnce({ success: false, error: 'boom' });
    const cleanupSpy = vi.spyOn(service, 'cleanupSession').mockResolvedValue({
      success: true,
      removedWorktrees: [],
      removedBranches: [],
      errors: [],
    });

    const result = await runSetup(service, ['a', 'b']);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual({ name: 'b', error: 'boom' });
    expect(cleanupSpy).toHaveBeenCalledWith('s1');
  });

  it('listWorktrees should return empty array when session dir does not exist', async () => {
    const err = new Error('missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    hoistedMockFsReaddir.mockRejectedValue(err);
    const service = new GitWorktreeService('/repo');

    await expect(service.listWorktrees('missing')).resolves.toEqual([]);
  });

  it('removeWorktree should fallback to fs.rm + worktree prune when git remove fails', async () => {
    git.raw
      .mockRejectedValueOnce(new Error('remove failed'))
      .mockResolvedValueOnce('');
    const service = new GitWorktreeService('/repo');

    const result = await service.removeWorktree('/w/a');

    expect(result.success).toBe(true);
    expect(hoistedMockFsRm).toHaveBeenCalledWith('/w/a', {
      recursive: true,
      force: true,
    });
    expect(git.raw).toHaveBeenNthCalledWith(2, ['worktree', 'prune']);
  });

  it('cleanupSession should remove branches from listed worktrees', async () => {
    const service = new GitWorktreeService('/repo');
    vi.spyOn(service, 'listWorktrees').mockResolvedValue(
      ['a', 'b'].map((name) =>
        worktreeInfo(name, {
          path: `/w/${name}`,
          branch: `main-s1-${name}`,
          createdAt: Date.now(),
        }),
      ),
    );
    vi.spyOn(service, 'removeWorktree').mockResolvedValue({ success: true });

    const result = await service.cleanupSession('s1');

    expect(result.success).toBe(true);
    expect(result.removedBranches).toEqual(['main-s1-a', 'main-s1-b']);
    expect(git.branch).toHaveBeenCalledWith(['-D', 'main-s1-a']);
    expect(git.branch).toHaveBeenCalledWith(['-D', 'main-s1-b']);
    expect(git.raw).toHaveBeenCalledWith(['worktree', 'prune']);
  });

  it('getWorktreeDiff should return staged raw diff without creating commits', async () => {
    const service = new GitWorktreeService('/repo');
    git.diff.mockResolvedValue('diff --git a/a.ts b/a.ts');

    const diff = await service.getWorktreeDiff('/w/a', 'main');

    expect(diff).toBe('diff --git a/a.ts b/a.ts');
    expect(git.add).toHaveBeenCalledWith(['--all']);
    expect(git.diff).toHaveBeenCalledWith([
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--cached',
      'main',
    ]);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it('applyWorktreeChanges should apply raw patch via git apply', async () => {
    const service = new GitWorktreeService('/repo');
    git.raw
      .mockResolvedValueOnce('baseline-sha\n') // resolveBaseline log --grep
      .mockResolvedValueOnce('') // reset (from withStagedChanges)
      .mockResolvedValueOnce(''); // git apply
    git.diff.mockResolvedValueOnce('diff --git a/a.ts b/a.ts');

    const result = await service.applyWorktreeChanges('/w/a', '/repo');

    expect(result.success).toBe(true);
    expect(git.add).toHaveBeenCalledWith(['--all']);
    // Should diff against the baseline commit, not merge-base
    expect(git.diff).toHaveBeenCalledWith([
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--cached',
      'baseline-sha',
    ]);

    const applyCall = rawCalls('apply')[0];
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
    git.raw.mockResolvedValueOnce('baseline-sha\n'); // resolveBaseline
    git.diff.mockResolvedValueOnce('   \n');

    const result = await service.applyWorktreeChanges('/w/a', '/repo');

    expect(result.success).toBe(true);
    expect(rawCalls('apply')[0]).toBeUndefined();
    expect(hoistedMockFsWriteFile).not.toHaveBeenCalled();
  });

  it('applyWorktreeChanges should return error when git apply fails', async () => {
    const service = new GitWorktreeService('/repo');
    git.raw
      .mockResolvedValueOnce('baseline-sha\n') // resolveBaseline
      .mockResolvedValueOnce('') // reset from withStagedChanges
      .mockRejectedValueOnce(new Error('apply failed'));
    git.diff.mockResolvedValueOnce('diff --git a/a.ts b/a.ts');

    const result = await service.applyWorktreeChanges('/w/a', '/repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain('apply failed');
    expect(hoistedMockFsRm).toHaveBeenCalledWith(
      expect.stringContaining('.worktree-apply-'),
      { force: true },
    );
  });

  describe('dirty state propagation', () => {
    /** setupWorktrees over `names`, each of whose creation succeeds. */
    function setupCreated(...names: string[]) {
      const service = new GitWorktreeService('/repo');
      vi.spyOn(service, 'isGitRepository').mockResolvedValue(true);
      const create = vi.spyOn(service, 'createWorktree');
      const created = (name: string) => ({
        success: true,
        worktree: worktreeInfo(name),
      });
      if (names.length === 1) create.mockResolvedValue(created(names[0]!));
      else
        for (const name of names) create.mockResolvedValueOnce(created(name));
      return runSetup(service, names);
    }

    it('setupWorktrees should apply dirty state snapshot to each worktree', async () => {
      git.stash.mockResolvedValue('snapshot-sha\n');

      const result = await setupCreated('a', 'b');

      expect(result.success).toBe(true);
      expect(git.stash).toHaveBeenCalledWith(['create']);
      // stash apply should be called once per worktree
      const stashApplyCalls = rawCalls('stash', 'apply');
      expect(stashApplyCalls).toHaveLength(2);
      expect(stashApplyCalls[0]![0]).toEqual([
        'stash',
        'apply',
        'snapshot-sha',
      ]);
    });

    it('setupWorktrees should skip stash apply when working tree is clean', async () => {
      git.stash.mockResolvedValue('\n');

      const result = await setupCreated('a');

      expect(result.success).toBe(true);
      expect(rawCalls('stash', 'apply')).toHaveLength(0);
    });

    it('setupWorktrees should still succeed when stash apply fails', async () => {
      git.stash.mockResolvedValue('snapshot-sha\n');
      git.raw.mockRejectedValue(new Error('stash apply conflict'));

      const result = await setupCreated('a');

      // Setup should still succeed — dirty state failure is non-fatal
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('setupWorktrees should still succeed when stash create fails', async () => {
      git.stash.mockRejectedValue(new Error('stash create failed'));

      const result = await setupCreated('a');

      // Setup should still succeed — stash create failure is non-fatal
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('parsePRReference', () => {
    const parse = (input: string) => GitWorktreeService.parsePRReference(input);

    it('recognises #N shorthand', () => {
      expect(parse('#123')).toBe(123);
      expect(parse('#1')).toBe(1);
      expect(parse('#99999')).toBe(99999);
    });

    it('trims surrounding whitespace before matching', () => {
      expect(parse('  #42  ')).toBe(42);
    });

    it('rejects leading zeros to keep round-trips unambiguous', () => {
      expect(parse('#0123')).toBeNull();
      expect(parse('#0')).toBeNull();
    });

    it('recognises full GitHub PR URLs (any host)', () => {
      expect(parse('https://github.com/QwenLM/qwen-code/pull/4174')).toBe(4174);
      expect(parse('http://gh.enterprise.example.com/team/repo/pull/9')).toBe(
        9,
      );
    });

    it('tolerates trailing slash, query string, and fragment', () => {
      expect(parse('https://github.com/o/r/pull/123/')).toBe(123);
      expect(parse('https://github.com/o/r/pull/123?foo=bar')).toBe(123);
      expect(parse('https://github.com/o/r/pull/123#discussion_r999')).toBe(
        123,
      );
    });

    it('returns null for plain slugs and malformed inputs', () => {
      expect(parse('my-feature')).toBeNull();
      expect(parse('#abc')).toBeNull();
      expect(parse('123')).toBeNull();
      expect(parse('https://example.com/')).toBeNull();
      expect(parse('https://github.com/o/r/issues/123')).toBeNull();
      expect(parse('')).toBeNull();
    });

    it('safely handles non-string input', () => {
      expect(parse(undefined as unknown as string)).toBeNull();
      expect(parse(null as unknown as string)).toBeNull();
    });
  });

  describe('getMainWorktreePath', () => {
    /** One porcelain `worktree` record. */
    const entry = (dir: string, branch = 'main') =>
      `worktree ${dir}\nHEAD abc123\nbranch refs/heads/${branch}\n`;

    /** Queues `git.raw` answers (an Error rejects), then resolves from `cwd`. */
    function mainPath(cwd: string, answers: Array<string | Error>) {
      for (const answer of answers) {
        if (answer instanceof Error) git.raw.mockRejectedValueOnce(answer);
        else git.raw.mockResolvedValueOnce(answer);
      }
      return new GitWorktreeService(cwd).getMainWorktreePath();
    }

    it('parses the first porcelain entry as the main worktree path', async () => {
      const porcelain =
        entry('/repo') + '\n' + entry('/repo/.qwen/worktrees/wt', 'wt');
      // Round-trip validation: `--git-common-dir` answers absolute from a
      // linked worktree and relative from the main tree; both resolve to the
      // same common dir.
      await expect(
        mainPath('/repo/.qwen/worktrees/wt', [porcelain, '/repo/.git', '.git']),
      ).resolves.toBe('/repo');
      expect(git.raw).toHaveBeenCalledWith(['worktree', 'list', '--porcelain']);
    });

    it.each<[string, string, Array<string | Error>, string | null]>([
      [
        'accepts a bare-repository first entry',
        '/srv/repo.git',
        ['worktree /srv/repo.git\nbare\n', '.', '.'],
        '/srv/repo.git',
      ],
      [
        'returns null when the first line is not a worktree entry',
        '/repo',
        ['HEAD abc123\n'],
        null,
      ],
      ['returns null when the porcelain output is empty', '/repo', [''], null],
      [
        'returns null when git fails',
        '/repo',
        [new Error('git unavailable')],
        null,
      ],
      // A main-tree path containing a newline splits the first porcelain
      // entry across lines; the truncated prefix can resolve inside a
      // DIFFERENT repository and aim the containment gate at that repo's
      // worktree registry. The path remainder lands where a record attribute
      // belongs; it is not one, so the anchor is refused and callers fall
      // back to `--show-toplevel`, which keeps interior newlines intact.
      [
        'returns null when the main-tree path contains a newline',
        '/outer/sub/\nR1',
        [entry('/outer/sub/\nR1')],
        null,
      ],
      // The attribute-shape backstop: a remainder that is itself a record
      // attribute (`detached`, `HEAD …`, …), or a path ending right at a
      // newline, parses cleanly, so the parse check alone cannot catch the
      // truncation. The round-trip refuses the anchor: probed at the
      // truncated prefix, `--git-common-dir` resolves against a DIFFERENT
      // repository (git -C /outer/sub walks up into the enclosing one).
      [
        'returns null when the truncated prefix belongs to another repository',
        '/outer/sub/\ndetached',
        [entry('/outer/sub/\ndetached'), '.git', '/outer/.git'],
        null,
      ],
      [
        'returns null when the anchor probe fails',
        '/gone/repo',
        [entry('/gone/repo'), '.git', new Error('not a git repository')],
        null,
      ],
      // git preserves a path's leading/trailing whitespace verbatim in the
      // porcelain output; the parse must not mutate the anchor (a trim would
      // aim every subsequent gate at a different directory).
      [
        'preserves whitespace in the main worktree path',
        '/srv/proj ',
        [entry('/srv/proj '), '.git', '.git'],
        '/srv/proj ',
      ],
      // git's stdout is LF-terminated on all platforms, so a trailing CR in
      // the porcelain answer is part of the directory name, not a terminator.
      [
        'preserves a trailing CR in the main worktree path',
        '/srv/proj\r',
        [entry('/srv/proj\r'), '.git', '.git'],
        '/srv/proj\r',
      ],
    ])('%s', async (_title, cwd, answers, expected) => {
      await expect(mainPath(cwd, answers)).resolves.toBe(expected);
    });
  });

  describe('getRepoTopLevel', () => {
    it('preserves whitespace in the repository top-level path', async () => {
      git.raw.mockResolvedValueOnce('/srv/proj \n');
      const service = new GitWorktreeService('/srv/proj ');

      await expect(service.getRepoTopLevel()).resolves.toBe('/srv/proj ');
    });

    // git's stdout is LF-terminated on all platforms, so a trailing CR in
    // the answer is part of the directory name, not a line terminator.
    it('preserves a trailing CR in the repository top-level path', async () => {
      git.raw.mockResolvedValueOnce('/srv/proj\r\n');
      const service = new GitWorktreeService('/srv/proj\r');

      await expect(service.getRepoTopLevel()).resolves.toBe('/srv/proj\r');
    });
  });

  describe('validateUserWorktreeSlug', () => {
    const validate = (
      ...args: Parameters<typeof GitWorktreeService.validateUserWorktreeSlug>
    ) => GitWorktreeService.validateUserWorktreeSlug(...args);

    it('reserves pr-<number> slugs for PR-backed worktrees', () => {
      expect(validate('pr-42')).toMatch(/reserved/);
      // `pr-0` is not the reserved shape and stays a legal user slug; the
      // backfill's [1-9] pattern simply never binds it.
      expect(validate('pr-0')).toBeNull();
      expect(validate('my-pr-42')).toBeNull();
    });

    it('allows the pr-<number> shape for PR-backed creators only', () => {
      expect(validate('pr-42', { allowPrBackedShape: true })).toBeNull();
      // The other slug rules still apply.
      expect(validate('pr-42/..', { allowPrBackedShape: true })).toMatch(
        /may only contain/,
      );
    });
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { CONFIG_DIR } from '../utils/paths.js';
import { internalGitArgs } from '../utils/gitCommandPolicy.js';
import { runLogger } from '../utils/runLogger.js';
import {
  readWorktreeHeadSha,
  getOrCreateWorktree,
  copyWorktreeIncludeFiles,
  performPostCreationSetup,
  createWorktreeForSession,
} from './worktreeService.js';
import {
  execFile as execFileCb,
  execFileSync,
} from 'node:child_process';

// Only mock child_process — fs is real in this file
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

const mockExecFile = vi.mocked(execFileCb);

async function createCommonGitStorage(commonDir: string): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(commonDir, 'objects'), { recursive: true }),
    fs.mkdir(path.join(commonDir, 'refs', 'heads'), { recursive: true }),
  ]);
}

// ---------------------------------------------------------------------------
// readWorktreeHeadSha (P1 - fast resume)
// ---------------------------------------------------------------------------

describe('readWorktreeHeadSha (real fs)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-sha-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent directory', async () => {
    const result = await readWorktreeHeadSha(path.join(tmpDir, 'nonexistent'));
    expect(result).toBeNull();
  });

  it('returns null when .git file has invalid format', async () => {
    const worktreePath = path.join(tmpDir, 'wt');
    await fs.mkdir(worktreePath);
    await fs.writeFile(path.join(worktreePath, '.git'), 'not a gitdir file');
    const result = await readWorktreeHeadSha(worktreePath);
    expect(result).toBeNull();
  });

  it('reads SHA from linked worktree .git pointer + HEAD ref', async () => {
    const worktreePath = path.join(tmpDir, 'wt');
    const commonDir = path.join(tmpDir, 'main', '.git');
    const gitDir = path.join(commonDir, 'worktrees', 'wt');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await createCommonGitStorage(commonDir);

    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${gitDir}`);
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await fs.writeFile(
      path.join(gitDir, 'gitdir'),
      `${path.join(worktreePath, '.git')}\n`,
    );
    await fs.writeFile(
      path.join(gitDir, 'HEAD'),
      'ref: refs/heads/worktree-test',
    );

    const commit = 'a'.repeat(40);
    await fs.writeFile(
      path.join(commonDir, 'refs', 'heads', 'worktree-test'),
      `${commit}\n`,
    );

    const result = await readWorktreeHeadSha(worktreePath);
    expect(result).toBe(commit);
  });

  it('reuses a real linked worktree without running git worktree add', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    const worktreePath = path.join(repoPath, CONFIG_DIR, 'worktrees', '12');
    await fs.mkdir(repoPath, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'initial\n');
    execFileSync('git', ['add', 'tracked.txt'], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test-user@example.com',
        'commit',
        '-m',
        'initial',
      ],
      { cwd: repoPath, stdio: 'ignore' },
    );
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'worktree-12', worktreePath],
      { cwd: repoPath, stdio: 'ignore' },
    );
    const result = await getOrCreateWorktree(repoPath, '12');

    expect(result).toEqual({
      worktreePath,
      worktreeBranch: 'worktree-12',
      headCommit: '',
      existed: true,
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('falls back to git when HEAD ref is not stored as a loose ref', async () => {
    const worktreePath = path.join(tmpDir, 'wt-packed-ref');
    const commonDir = path.join(tmpDir, 'main', '.git');
    const gitDir = path.join(commonDir, 'worktrees', 'wt-packed-ref');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await createCommonGitStorage(commonDir);

    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${gitDir}`);
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await fs.writeFile(
      path.join(gitDir, 'gitdir'),
      `${path.join(worktreePath, '.git')}\n`,
    );
    await fs.writeFile(
      path.join(gitDir, 'HEAD'),
      'ref: refs/heads/worktree-packed',
    );
    mockExecFile.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          'fedcba654321\n',
          '',
        );
        return {} as ReturnType<typeof execFileCb>;
      },
    );

    const result = await readWorktreeHeadSha(worktreePath);

    expect(result).toBe('fedcba654321');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      [
        ...internalGitArgs(),
        '-C',
        worktreePath,
        'rev-parse',
        '--verify',
        'HEAD',
      ],
      {
        env: expect.objectContaining({
          GIT_ASKPASS: '',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        }),
        timeout: 2000,
      },
      expect.any(Function),
    );
  });

  it('reads SHA from detached HEAD', async () => {
    const worktreePath = path.join(tmpDir, 'wt-detached');
    const commonDir = path.join(tmpDir, 'main', '.git');
    const gitDir = path.join(commonDir, 'worktrees', 'wt-detached');
    const commit = 'd'.repeat(40);
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await createCommonGitStorage(commonDir);

    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${gitDir}`);
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await fs.writeFile(
      path.join(gitDir, 'gitdir'),
      `${path.join(worktreePath, '.git')}\n`,
    );
    await fs.writeFile(path.join(gitDir, 'HEAD'), `${commit}\n`);

    const result = await readWorktreeHeadSha(worktreePath);
    expect(result).toBe(commit);
  });

  it('returns null when the Git fallback times out', async () => {
    const worktreePath = path.join(tmpDir, 'wt-missing-ref');
    const commonDir = path.join(tmpDir, 'main', '.git');
    const gitDir = path.join(commonDir, 'worktrees', 'wt-missing-ref');
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await createCommonGitStorage(commonDir);

    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${gitDir}`);
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await fs.writeFile(
      path.join(gitDir, 'gitdir'),
      `${path.join(worktreePath, '.git')}\n`,
    );
    await fs.writeFile(
      path.join(gitDir, 'HEAD'),
      'ref: refs/heads/missing-branch',
    );
    // Don't create the ref file so resolution falls back to Git.
    mockExecFile.mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        const error = Object.assign(new Error('timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
        });
        (cb as (err: Error, stdout: string, stderr: string) => void)(
          error,
          '',
          '',
        );
        return {} as ReturnType<typeof execFileCb>;
      },
    );

    const result = await readWorktreeHeadSha(worktreePath);
    expect(result).toBeNull();
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      [
        ...internalGitArgs(),
        '-C',
        worktreePath,
        'rev-parse',
        '--verify',
        'HEAD',
      ],
      expect.objectContaining({ timeout: 2000 }),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// createWorktreeForSession (P0 - session-level creation, real fs)
// ---------------------------------------------------------------------------

describe('createWorktreeForSession (real fs)', () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-session-'));

    // Setup a fake git repo structure for the tmpDir
    const gitDir = path.join(tmpDir, '.git');
    await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
    await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(
      path.join(gitDir, 'refs', 'heads', 'main'),
      'abc123def456\n',
    );
  });

  afterEach(async () => {
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates session with hook-based worktree when hook available', async () => {
    const hookSystem = {
      hasWorktreeCreateHook: () => true,
      executeWorktreeCreateHook: vi.fn().mockResolvedValue({
        worktreePath: '/hook/worktree/path',
      }),
    };

    const session = await createWorktreeForSession(
      'my-wt',
      tmpDir,
      hookSystem,
    );

    expect(session.worktreePath).toBe('/hook/worktree/path');
    expect(session.worktreeName).toBe('my-wt');
    expect(session.hookBased).toBe(true);
  });

  it('creates session with git worktree when no hook', async () => {
    await fs.rm(path.join(tmpDir, '.git'), { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--initial-branch=main'], {
      cwd: tmpDir,
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd: tmpDir },
    );
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    mockExecFile.mockImplementation(actual.execFile);
    const session = await createWorktreeForSession(
      'git-wt',
      tmpDir,
      undefined,
      { baseRef: 'head' },
    );

    expect(session.worktreeName).toBe('git-wt');
    expect(session.originalBranch).toBe('main');
    expect(
      mockExecFile.mock.calls.some(([, args]) =>
        (args as string[]).includes('--abbrev-ref'),
      ),
    ).toBe(false);
    expect(session.hookBased).toBe(false);
  });

  it('throws on invalid slug', async () => {
    await expect(
      createWorktreeForSession('..', tmpDir),
    ).rejects.toThrow(/Invalid worktree name/);
  });
});

// ---------------------------------------------------------------------------
// copyWorktreeIncludeFiles (P1 - .worktreeinclude, real fs)
// ---------------------------------------------------------------------------

describe('copyWorktreeIncludeFiles (real fs)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-include-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no .worktreeinclude file', async () => {
    const result = await copyWorktreeIncludeFiles(tmpDir, tmpDir);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty .worktreeinclude', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.worktreeinclude'),
      '# just a comment\n',
    );
    const result = await copyWorktreeIncludeFiles(tmpDir, tmpDir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// performPostCreationSetup — settings.local.json copy (P1, real fs)
// ---------------------------------------------------------------------------

describe('performPostCreationSetup - settings.local.json (real fs)', () => {
  let repoRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'post-setup-repo-'));
    worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'post-setup-wt-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(worktreePath, { recursive: true, force: true });
  });

  it('copies settings.local.json to worktree when present', async () => {
    const projectConfigDir = path.join(repoRoot, CONFIG_DIR);
    await fs.mkdir(projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(projectConfigDir, 'settings.local.json'),
      '{"test": true}',
    );

    await performPostCreationSetup(repoRoot, worktreePath);

    const copied = await fs.readFile(
      path.join(worktreePath, CONFIG_DIR, 'settings.local.json'),
      'utf-8',
    );
    expect(copied).toBe('{"test": true}');
  });

  it('does not create the project config directory when settings.local.json is absent', async () => {
    await performPostCreationSetup(repoRoot, worktreePath);

    const exists = await fs
      .access(path.join(worktreePath, CONFIG_DIR))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('logs unexpected settings.local.json copy failures', async () => {
    const projectConfigDir = path.join(repoRoot, CONFIG_DIR);
    await fs.mkdir(projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(projectConfigDir, 'settings.local.json'),
      '{"test": true}',
    );
    await fs.writeFile(path.join(worktreePath, CONFIG_DIR), 'not a directory');
    const debugSpy = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});

    await performPostCreationSetup(repoRoot, worktreePath);

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to copy ${CONFIG_DIR}/settings.local.json to worktree:`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// .worktreeinclude matching + copy safety (P0, real fs)
//
// Only `git ls-files` is stubbed here: the enumeration source is irrelevant to
// the properties under test, which are gitignore-semantics matching and the
// refusal to follow symlinks out of the worktree.
// ---------------------------------------------------------------------------

describe('copyWorktreeIncludeFiles matching and symlink safety (real fs)', () => {
  let repoRoot: string;
  let worktreePath: string;
  let outsideDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-include-repo-'));
    worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-include-wt-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-include-out-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of [repoRoot, worktreePath, outsideDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** Stub every `git ls-files` invocation with one NUL-separated listing. */
  function stubLsFiles(
    entries: string[],
    { code = 0, stderr = '' }: { code?: number; stderr?: string } = {},
  ): void {
    const stdout = entries.length > 0 ? `${entries.join('\0')}\0` : '';
    mockExecFile.mockImplementation(((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      callback: (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      if (code === 0) {
        callback(null, stdout, stderr);
      } else {
        callback(
          Object.assign(new Error('git failed'), { code }),
          '',
          stderr,
        );
      }
      return undefined as never;
    }) as never);
  }

  async function writeInclude(content: string): Promise<void> {
    await fs.writeFile(path.join(repoRoot, '.worktreeinclude'), content);
  }

  it('honours gitignore negation so excluded files are not copied', async () => {
    // A whole-directory rule cannot be undone by a negation (same as
    // gitignore), so the include list narrows to files before re-including.
    await writeInclude('config/*.env\n!config/secret.env\n');
    await fs.mkdir(path.join(repoRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'config/keep.env'), 'keep');
    await fs.writeFile(path.join(repoRoot, 'config/secret.env'), 'secret');
    stubLsFiles(['config/keep.env', 'config/secret.env']);

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(copied).toEqual(['config/keep.env']);
    await expect(
      fs.readFile(path.join(worktreePath, 'config/keep.env'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(
      fs.access(path.join(worktreePath, 'config/secret.env')),
    ).rejects.toThrow();
  });

  it('keeps a whole-directory exclusion in effect despite a negation', async () => {
    await writeInclude('config/\n!config/secret.env\n');
    await fs.mkdir(path.join(repoRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'config/secret.env'), 'secret');
    stubLsFiles(['config/secret.env']);

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(copied).toEqual(['config/secret.env']);
  });

  it('copies names containing spaces, Unicode, and newlines', async () => {
    // NUL separation is what makes a newline inside a filename survive.
    const names = ['with space.env', '\u914d\u7f6e.env', 'line\nbreak.env'];
    await writeInclude('*.env\n');
    for (const name of names) {
      await fs.writeFile(path.join(repoRoot, name), `body:${name}`);
    }
    stubLsFiles(names);

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(new Set(copied)).toEqual(new Set(names));
    for (const name of names) {
      await expect(
        fs.readFile(path.join(worktreePath, name), 'utf-8'),
      ).resolves.toBe(`body:${name}`);
    }
  });

  it('skips a source entry that is a symlink', async () => {
    const externalTarget = path.join(outsideDir, 'target.env');
    await fs.writeFile(externalTarget, 'external');
    await writeInclude('*.env\n');
    await fs.symlink(externalTarget, path.join(repoRoot, 'link.env'));
    stubLsFiles(['link.env']);

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(copied).toEqual([]);
    await expect(
      fs.access(path.join(worktreePath, 'link.env')),
    ).rejects.toThrow();
  });

  it('does not write through a destination file symlink pointing outside', async () => {
    const externalSecret = path.join(outsideDir, 'secret.env');
    await fs.writeFile(externalSecret, 'do-not-touch');
    await writeInclude('*.env\n');
    await fs.writeFile(path.join(repoRoot, 'evil.env'), 'payload');
    await fs.symlink(externalSecret, path.join(worktreePath, 'evil.env'));
    stubLsFiles(['evil.env']);

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(copied).toEqual([]);
    await expect(fs.readFile(externalSecret, 'utf-8')).resolves.toBe(
      'do-not-touch',
    );
  });

  it('does not write through a destination parent directory symlink', async () => {
    await writeInclude('sub/*.env\n');
    await fs.mkdir(path.join(repoRoot, 'sub'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'sub/payload.env'), 'payload');
    await fs.symlink(outsideDir, path.join(worktreePath, 'sub'));
    stubLsFiles(['sub/payload.env']);

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(copied).toEqual([]);
    await expect(
      fs.access(path.join(outsideDir, 'payload.env')),
    ).rejects.toThrow();
  });

  it('fails closed when the ignored-file enumeration fails', async () => {
    await writeInclude('*.env\n');
    await fs.writeFile(path.join(repoRoot, 'a.env'), 'a');
    stubLsFiles([], { code: 128, stderr: 'not a git repository' });

    const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath);

    expect(copied).toEqual([]);
    await expect(
      fs.access(path.join(worktreePath, 'a.env')),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// symlinkDirectories safety (P0, real fs)
// ---------------------------------------------------------------------------

describe('performPostCreationSetup - symlinkDirectories (real fs)', () => {
  let repoRoot: string;
  let worktreePath: string;
  let outsideDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-symlink-repo-'));
    worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-symlink-wt-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-symlink-out-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of [repoRoot, worktreePath, outsideDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('links a real directory inside the repository', async () => {
    await fs.mkdir(path.join(repoRoot, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'node_modules/dep.txt'), 'dep');

    await performPostCreationSetup(repoRoot, worktreePath, {
      symlinkDirectories: ['node_modules'],
    });

    const linkPath = path.join(worktreePath, 'node_modules');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(
      fs.readFile(path.join(linkPath, 'dep.txt'), 'utf-8'),
    ).resolves.toBe('dep');
  });

  it.each([
    ['an absolute path', '/etc'],
    ['a parent traversal', '../escape'],
    ['a nested parent traversal', 'deps/../../escape'],
    ['a bare dot segment', './'],
  ])('skips %s', async (_label, candidate) => {
    await performPostCreationSetup(repoRoot, worktreePath, {
      symlinkDirectories: [candidate],
    });

    const entries = await fs.readdir(worktreePath);
    expect(entries).toEqual([]);
  });

  it('skips a source directory that is itself a symlink', async () => {
    await fs.mkdir(path.join(outsideDir, 'real_deps'), { recursive: true });
    await fs.symlink(
      path.join(outsideDir, 'real_deps'),
      path.join(repoRoot, 'node_modules'),
    );

    await performPostCreationSetup(repoRoot, worktreePath, {
      symlinkDirectories: ['node_modules'],
    });

    await expect(
      fs.lstat(path.join(worktreePath, 'node_modules')),
    ).rejects.toThrow();
  });

  it('skips when an intermediate source segment is a symlink', async () => {
    await fs.mkdir(path.join(outsideDir, 'inner'), { recursive: true });
    await fs.symlink(outsideDir, path.join(repoRoot, 'linked'));

    await performPostCreationSetup(repoRoot, worktreePath, {
      symlinkDirectories: ['linked/inner'],
    });

    await expect(
      fs.lstat(path.join(worktreePath, 'linked')),
    ).rejects.toThrow();
  });

  it('does not create a link whose destination escapes the worktree', async () => {
    await fs.mkdir(path.join(repoRoot, 'deps'), { recursive: true });
    // The worktree-side parent is a symlink out of the worktree, so creating
    // `<worktree>/escaped/deps` would plant a link in an unrelated directory.
    await fs.symlink(outsideDir, path.join(worktreePath, 'escaped'));

    await performPostCreationSetup(repoRoot, worktreePath, {
      symlinkDirectories: ['escaped/deps'],
    });

    await expect(fs.lstat(path.join(outsideDir, 'deps'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// settings.local.json copy safety (P0, real fs)
// ---------------------------------------------------------------------------

describe('performPostCreationSetup - settings.local.json safety (real fs)', () => {
  let repoRoot: string;
  let worktreePath: string;
  let outsideDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-settings-repo-'));
    worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-settings-wt-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-settings-out-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of [repoRoot, worktreePath, outsideDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a symlinked source settings file', async () => {
    const externalSettings = path.join(outsideDir, 'external-settings.json');
    await fs.writeFile(externalSettings, '{"external": true}');
    await fs.mkdir(path.join(repoRoot, CONFIG_DIR), { recursive: true });
    await fs.symlink(
      externalSettings,
      path.join(repoRoot, CONFIG_DIR, 'settings.local.json'),
    );

    await performPostCreationSetup(repoRoot, worktreePath);

    await expect(
      fs.access(path.join(worktreePath, CONFIG_DIR, 'settings.local.json')),
    ).rejects.toThrow();
  });

  it('does not write through a destination directory symlink', async () => {
    await fs.mkdir(path.join(repoRoot, CONFIG_DIR), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, CONFIG_DIR, 'settings.local.json'),
      '{"copied": true}',
    );
    await fs.symlink(outsideDir, path.join(worktreePath, CONFIG_DIR));

    await performPostCreationSetup(repoRoot, worktreePath);

    await expect(
      fs.access(path.join(outsideDir, 'settings.local.json')),
    ).rejects.toThrow();
  });
});

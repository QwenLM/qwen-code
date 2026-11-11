/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createGitCommandEnv,
  findGitRootAsync,
  GitMetadataProbeTimeoutError,
  isGitWorktree,
  isGitWorktreeAsync,
  readGitHead,
  resolveGitRepositoryLayout,
} from './gitUtils.js';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'test-git-layout-'));
  tempRoots.push(root);
  return root;
}

async function createGitStorage(gitDir: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(gitDir, 'objects'), { recursive: true }),
    mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true }),
  ]);
}

// A mutable mock namespace permits targeted failures without spying on native
// ESM exports, whose properties are non-configurable.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('findGitRootAsync', () => {
  it.each(['directory', 'file'])(
    'recognizes a .git %s without reading HEAD or worktree metadata',
    async (kind) => {
      const root = await realpath(await createTempRoot());
      const child = path.join(root, 'src');
      await mkdir(child);
      if (kind === 'directory') await mkdir(path.join(root, '.git'));
      else await writeFile(path.join(root, '.git'), 'gitdir: unavailable\n');
      const read = vi.spyOn(fsPromises, 'open');
      await expect(findGitRootAsync(child)).resolves.toBe(root);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('discovers the physical ancestors of a symlink cwd', async () => {
    const root = await realpath(await createTempRoot());
    const repo = path.join(root, 'repo');
    const nested = path.join(repo, 'src');
    await mkdir(nested, { recursive: true });
    await mkdir(path.join(repo, '.git'));
    const alias = path.join(root, 'alias');
    await symlink(
      nested,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(findGitRootAsync(alias, { throwOnError: true })).resolves.toBe(
      repo,
    );
    await expect(findGitRootAsync(root)).resolves.toBeNull();
  });

  it('distinguishes I/O failure from non-Git for strict callers and bounds slow discovery', async () => {
    const root = await createTempRoot();
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fsPromises, 'realpath').mockRejectedValue(error);
    await expect(findGitRootAsync(root, { throwOnError: true })).rejects.toBe(
      error,
    );
    vi.mocked(fsPromises.realpath).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.useFakeTimers();
    const result = findGitRootAsync(root, {
      timeoutMs: 10,
      throwOnError: true,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeInstanceOf(GitMetadataProbeTimeoutError);
  });
});

describe('resolveGitRepositoryLayout', () => {
  it('returns null for a non-Git directory without descending into child repos', async () => {
    const root = await createTempRoot();
    const resolvePath = vi.spyOn(fsPromises, 'realpath');
    await expect(
      resolveGitRepositoryLayout(root, { throwOnError: true }),
    ).resolves.toBeNull();

    const childGitDir = path.join(root, 'child', '.git');
    await createGitStorage(childGitDir);
    await writeFile(path.join(childGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await expect(
      resolveGitRepositoryLayout(root, { throwOnError: true }),
    ).resolves.toBeNull();
    expect(resolvePath).toHaveBeenCalledTimes(2);
  });

  it('matches Git for a workspace symlink pointing into a real repository', async () => {
    const root = await createTempRoot();
    const repo = path.join(root, 'repo');
    const nested = path.join(repo, 'src');
    const alias = path.join(root, 'workspace');
    await mkdir(nested, { recursive: true });
    const env = createGitCommandEnv();
    execFileSync('git', ['init', '--quiet', repo], { env });
    await symlink(nested, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(
      execFileSync('git', ['-C', alias, 'rev-parse', '--is-inside-work-tree'], {
        env,
        encoding: 'utf8',
      }).trim(),
    ).toBe('true');
    for (const throwOnError of [false, true]) {
      const layout = await resolveGitRepositoryLayout(alias, { throwOnError });
      expect(layout?.worktreeRoot).toBe(await realpath(repo));
      expect(layout?.isWorktree).toBe(false);
    }
  });

  it('preserves ENOTDIR from marker discovery only in strict mode', async () => {
    const root = await createTempRoot();
    const file = path.join(root, 'not-a-directory');
    await writeFile(file, 'not a directory');

    await expect(resolveGitRepositoryLayout(file)).resolves.toBeNull();
    await expect(
      resolveGitRepositoryLayout(file, { throwOnError: true }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('preserves directory validation errors only in strict mode', async () => {
    const root = await createTempRoot();
    const gitDir = path.join(root, '.git');
    await createGitStorage(gitDir);
    await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    const markerStat = await fsPromises.lstat(gitDir);
    const error = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const stat = vi.spyOn(fsPromises, 'lstat');

    for (const throwOnError of [false, true]) {
      stat.mockResolvedValueOnce(markerStat).mockRejectedValueOnce(error);
      const probe = resolveGitRepositoryLayout(root, { throwOnError });
      if (throwOnError) {
        await expect(probe).rejects.toBe(error);
      } else {
        await expect(probe).resolves.toBeNull();
      }
    }
  });

  it('preserves canonicalization errors instead of falling back in strict mode', async () => {
    const root = await createTempRoot();
    await createGitStorage(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const error = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const resolvePath = vi.spyOn(fsPromises, 'realpath');

    resolvePath.mockRejectedValueOnce(error);
    await expect(resolveGitRepositoryLayout(root)).resolves.not.toBeNull();
    resolvePath.mockRejectedValueOnce(error);
    await expect(
      resolveGitRepositoryLayout(root, { throwOnError: true }),
    ).rejects.toBe(error);
  });

  it.each([false, true])(
    'bounds initial workspace realpath with the same deadline (throwOnError=%s)',
    async (throwOnError) => {
      const root = await createTempRoot();
      await createGitStorage(path.join(root, '.git'));
      await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const markerStat = await fsPromises.lstat(path.join(root, '.git'));
      vi.useFakeTimers();
      vi.spyOn(fsPromises, 'realpath').mockImplementationOnce(
        () => new Promise<string>(() => {}),
      );
      const stat = vi.spyOn(fsPromises, 'lstat').mockResolvedValue(markerStat);
      const probe = resolveGitRepositoryLayout(root, {
        timeoutMs: 10,
        throwOnError,
      });
      const assertion = (async () => {
        if (throwOnError) {
          await expect(probe).rejects.toBeInstanceOf(GitMetadataProbeTimeoutError);
        } else {
          await expect(probe).resolves.toBeNull();
        }
      })();

      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(stat).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('finds a primary checkout from a nested directory', async () => {
    const root = await createTempRoot();
    const nested = path.join(root, 'src', 'nested');
    await createGitStorage(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(nested, { recursive: true });

    const layout = await resolveGitRepositoryLayout(nested);
    const canonicalRoot = await realpath(root);

    expect(layout).toEqual({
      worktreeRoot: canonicalRoot,
      gitDir: path.join(canonicalRoot, '.git'),
      commonDir: path.join(canonicalRoot, '.git'),
      isWorktree: false,
    });
  });

  it('resolves a linked worktree from .git and commondir files', async () => {
    const repositoryRoot = await createTempRoot();
    const worktreeRoot = path.join(
      repositoryRoot,
      '.qwen',
      'worktrees',
      'feature',
    );
    const privateGitDir = path.join(
      repositoryRoot,
      '.git',
      'worktrees',
      'feature',
    );
    await mkdir(privateGitDir, { recursive: true });
    await createGitStorage(path.join(repositoryRoot, '.git'));
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(
      path.join(worktreeRoot, '.git'),
      `gitdir: ${privateGitDir}\n`,
    );
    await writeFile(path.join(privateGitDir, 'commondir'), '../..\n');
    await writeFile(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    await writeFile(path.join(privateGitDir, 'gitdir'), `${path.join(worktreeRoot, '.git')}\n`);

    const layout = await resolveGitRepositoryLayout(worktreeRoot);
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const canonicalWorktreeRoot = await realpath(worktreeRoot);

    expect(layout).toEqual({
      worktreeRoot: canonicalWorktreeRoot,
      gitDir: path.join(
        canonicalRepositoryRoot,
        '.git',
        'worktrees',
        'feature',
      ),
      commonDir: path.join(canonicalRepositoryRoot, '.git'),
      isWorktree: true,
    });
    await expect(isGitWorktreeAsync(worktreeRoot)).resolves.toBe(true);
  });

  it('rejects a .git file without a gitdir pointer', async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, '.git'), 'not a git pointer\n');

    await expect(resolveGitRepositoryLayout(root)).resolves.toBeNull();
  });

  it('rejects a linked worktree whose private gitdir points elsewhere', async () => {
    const repositoryRoot = await createTempRoot();
    const worktreeRoot = path.join(repositoryRoot, 'worktree');
    const privateGitDir = path.join(
      repositoryRoot,
      '.git',
      'worktrees',
      'worktree',
    );
    await mkdir(privateGitDir, { recursive: true });
    await createGitStorage(path.join(repositoryRoot, '.git'));
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(
      path.join(worktreeRoot, '.git'),
      `gitdir: ${privateGitDir}\n`,
    );
    await writeFile(path.join(privateGitDir, 'commondir'), '../..\n');
    await writeFile(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(privateGitDir, 'gitdir'), '/tmp/not-this-worktree/.git\n');

    await expect(resolveGitRepositoryLayout(worktreeRoot)).resolves.toBeNull();
  });

  it('rejects a Git directory that only contains HEAD', async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await expect(resolveGitRepositoryLayout(root)).resolves.toBeNull();
  });

  it('rejects symlinked .git markers and HEAD files', async () => {
    const root = await createTempRoot();
    const externalGitDir = path.join(root, 'external-git');
    await createGitStorage(externalGitDir);
    await writeFile(
      path.join(externalGitDir, 'HEAD-target'),
      'ref: refs/heads/main\n',
    );
    await symlink(externalGitDir, path.join(root, '.git'));
    await expect(resolveGitRepositoryLayout(root)).resolves.toBeNull();
    await expect(
      resolveGitRepositoryLayout(root, { throwOnError: true }),
    ).resolves.toBeNull();

    await rm(path.join(root, '.git'));
    await mkdir(path.join(root, '.git'), { recursive: true });
    await createGitStorage(path.join(root, '.git'));
    await symlink(
      path.join(externalGitDir, 'HEAD-target'),
      path.join(root, '.git', 'HEAD'),
    );
    await expect(resolveGitRepositoryLayout(root)).resolves.toBeNull();
  });

  it('rejects oversized or unsafe HEAD metadata', async () => {
    const root = await createTempRoot();
    await createGitStorage(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'HEAD'), 'x'.repeat(4097));
    await expect(resolveGitRepositoryLayout(root)).resolves.toBeNull();

    await writeFile(
      path.join(root, '.git', 'HEAD'),
      'ref: refs/heads/..\\..\\outside\n',
    );
    await expect(resolveGitRepositoryLayout(root)).resolves.toBeNull();
  });

  it('bounds the full metadata probe and can preserve timeout errors', async () => {
    const root = await createTempRoot();
    await createGitStorage(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await expect(
      resolveGitRepositoryLayout(root, {
        timeoutMs: 0,
        throwOnTimeout: true,
      }),
    ).rejects.toBeInstanceOf(GitMetadataProbeTimeoutError);
  });
});

describe('readGitHead', () => {
  it('reads a linked worktree branch and loose commit ref', async () => {
    const repositoryRoot = await createTempRoot();
    const worktreeRoot = path.join(
      repositoryRoot,
      '.qwen',
      'worktrees',
      'feature',
    );
    const privateGitDir = path.join(
      repositoryRoot,
      '.git',
      'worktrees',
      'feature',
    );
    const commit = 'a'.repeat(40);
    await createGitStorage(path.join(repositoryRoot, '.git'));
    await mkdir(privateGitDir, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(
      path.join(worktreeRoot, '.git'),
      `gitdir: ${privateGitDir}\n`,
    );
    await writeFile(path.join(privateGitDir, 'commondir'), '../..\n');
    await writeFile(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    await writeFile(path.join(privateGitDir, 'gitdir'), `${path.join(worktreeRoot, '.git')}\n`);
    await writeFile(
      path.join(repositoryRoot, '.git', 'refs', 'heads', 'feature'),
      `${commit}\n`,
    );

    const layout = await resolveGitRepositoryLayout(worktreeRoot);
    expect(layout).not.toBeNull();
    await expect(readGitHead(layout!)).resolves.toEqual({
      ref: 'refs/heads/feature',
      branch: 'feature',
      commit,
    });
  });

  it('reads a commit from packed-refs', async () => {
    const root = await createTempRoot();
    const commit = 'b'.repeat(40);
    await createGitStorage(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      path.join(root, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled\n${commit} refs/heads/main\n`,
    );

    const layout = await resolveGitRepositoryLayout(root);
    expect(layout).not.toBeNull();
    await expect(readGitHead(layout!)).resolves.toEqual({
      ref: 'refs/heads/main',
      branch: 'main',
      commit,
    });
  });

  it('reads a detached HEAD without resolving refs', async () => {
    const root = await createTempRoot();
    const commit = 'c'.repeat(40);
    await createGitStorage(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'HEAD'), `${commit}\n`);

    const layout = await resolveGitRepositoryLayout(root);
    expect(layout).not.toBeNull();
    await expect(readGitHead(layout!)).resolves.toEqual({ commit });
  });
});

describe('public Git helpers', () => {
  it('keeps isGitWorktree synchronous', async () => {
    const root = await createTempRoot();

    const result: boolean = isGitWorktree(root);

    expect(result).toBe(false);
  });

  it('removes repository selector variables from internal Git environments', () => {
    const env = createGitCommandEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/other/.git',
      GIT_WORK_TREE: '/other',
      GIT_COMMON_DIR: '/other/.git',
      HTTPS_PROXY: 'http://proxy.example',
    });

    expect(env).toEqual({
      GIT_OPTIONAL_LOCKS: '0',
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.example',
    });
  });
});

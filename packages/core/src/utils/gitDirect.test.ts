/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the real filesystem (so resolution/HEAD parsing read real temp repos),
// but replace fs.watch with a spy so the shared-watcher logic is observable.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: actual, watch: vi.fn() };
});

import {
  isValidRefName,
  isValidGitSha,
  readGitHead,
  resolveBranchName,
  watchRepoBranch,
  clearGitDirCache,
} from './gitDirect.js';

const watchMock = fs.watch as unknown as Mock;

const tmpRoots: string[] = [];

async function makeRepo(
  headContent: string,
  opts: { withReflog?: boolean } = {},
): Promise<string> {
  const { withReflog = true } = opts;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-gitdirect-'));
  tmpRoots.push(dir);
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.git', 'HEAD'), headContent);
  if (withReflog) {
    await fsp.mkdir(path.join(dir, '.git', 'logs'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.git', 'logs', 'HEAD'), 'reflog\n');
  }
  return dir;
}

async function makeBareDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-nogit-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  clearGitDirCache();
  watchMock.mockReset();
  for (const dir of tmpRoots.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('isValidRefName', () => {
  it.each(['main', 'feature/foo', 'release/2.0', 'v1.2.3', 'fix-123', 'a_b'])(
    'accepts %s',
    (name) => {
      expect(isValidRefName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '/foo',
    'foo/',
    '.hidden',
    'foo.',
    'foo.lock',
    'a..b',
    'a//b',
    'a@{0}',
    'foo bar',
    'a\tb',
    'foo^',
    'foo~',
    'foo:bar',
    'foo?x',
    'a*b',
    'a[b',
    'a\\b',
    '../../evil',
  ])('rejects %j', (name) => {
    expect(isValidRefName(name)).toBe(false);
  });
});

describe('isValidGitSha', () => {
  it('accepts 40-hex (SHA-1) and 64-hex (SHA-256)', () => {
    expect(isValidGitSha('a'.repeat(40))).toBe(true);
    expect(isValidGitSha('f'.repeat(64))).toBe(true);
  });
  it('rejects non-hex, wrong length, and uppercase', () => {
    expect(isValidGitSha('abc')).toBe(false);
    expect(isValidGitSha('g'.repeat(40))).toBe(false);
    expect(isValidGitSha('a'.repeat(41))).toBe(false);
    expect(isValidGitSha('A'.repeat(40))).toBe(false);
  });
});

describe('readGitHead', () => {
  it('parses a branch', async () => {
    const repo = await makeRepo('ref: refs/heads/main\n');
    expect(await readGitHead(path.join(repo, '.git'))).toEqual({
      type: 'branch',
      name: 'main',
    });
  });

  it('preserves nested branch names', async () => {
    const repo = await makeRepo('ref: refs/heads/feature/foo\n');
    expect(await readGitHead(path.join(repo, '.git'))).toEqual({
      type: 'branch',
      name: 'feature/foo',
    });
  });

  it('returns the full sha when detached', async () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const repo = await makeRepo(`${sha}\n`);
    expect(await readGitHead(path.join(repo, '.git'))).toEqual({
      type: 'detached',
      name: sha,
    });
  });

  it('rejects HEAD pointing outside refs/heads', async () => {
    const repo = await makeRepo('ref: refs/remotes/origin/main\n');
    expect(await readGitHead(path.join(repo, '.git'))).toBeNull();
  });

  it('rejects an invalid ref name (path traversal)', async () => {
    const repo = await makeRepo('ref: refs/heads/../../evil\n');
    expect(await readGitHead(path.join(repo, '.git'))).toBeNull();
  });

  it('returns null for garbage HEAD content', async () => {
    const repo = await makeRepo('not-a-valid-head\n');
    expect(await readGitHead(path.join(repo, '.git'))).toBeNull();
  });

  it('returns null when HEAD is missing', async () => {
    const dir = await makeBareDir();
    await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
    expect(await readGitHead(path.join(dir, '.git'))).toBeNull();
  });
});

describe('resolveBranchName', () => {
  it('returns the branch name', async () => {
    const repo = await makeRepo('ref: refs/heads/main\n');
    expect(await resolveBranchName(repo)).toBe('main');
  });

  it('walks up from a subdirectory to the repo root', async () => {
    const repo = await makeRepo('ref: refs/heads/main\n');
    const sub = path.join(repo, 'a', 'b', 'c');
    await fsp.mkdir(sub, { recursive: true });
    expect(await resolveBranchName(sub)).toBe('main');
  });

  it('reads through a worktree gitdir pointer file', async () => {
    const main = await makeRepo('ref: refs/heads/main\n');
    const realGitDir = path.join(main, '.git', 'worktrees', 'wt1');
    await fsp.mkdir(realGitDir, { recursive: true });
    await fsp.writeFile(
      path.join(realGitDir, 'HEAD'),
      'ref: refs/heads/feature\n',
    );
    const worktree = await makeBareDir();
    await fsp.writeFile(path.join(worktree, '.git'), `gitdir: ${realGitDir}\n`);
    expect(await resolveBranchName(worktree)).toBe('feature');
  });

  it('returns a 7-char short hash when detached', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const repo = await makeRepo(`${sha}\n`);
    expect(await resolveBranchName(repo)).toBe('abcdef1');
  });

  it('returns undefined outside a repository', async () => {
    const dir = await makeBareDir();
    expect(await resolveBranchName(dir)).toBeUndefined();
  });

  it('caches gitDir resolution, and clearGitDirCache re-resolves', async () => {
    const dir = await makeBareDir();
    expect(await resolveBranchName(dir)).toBeUndefined();

    // Turn it into a repo; the cached miss should still be returned...
    await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsp.writeFile(
      path.join(dir, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    expect(await resolveBranchName(dir)).toBeUndefined();

    // ...until the cache is cleared.
    clearGitDirCache();
    expect(await resolveBranchName(dir)).toBe('main');
  });
});

describe('watchRepoBranch', () => {
  it('shares one watcher across subscribers and tears down on last unsubscribe', async () => {
    let fire: ((eventType: string) => void) | undefined;
    const close = vi.fn();
    watchMock.mockImplementation(
      (_p: string, listener: (eventType: string) => void) => {
        fire = listener;
        return { close } as unknown as fs.FSWatcher;
      },
    );

    const repo = await makeRepo('ref: refs/heads/main\n');
    const s1 = vi.fn();
    const s2 = vi.fn();
    const dispose1 = await watchRepoBranch(repo, s1);
    const dispose2 = await watchRepoBranch(repo, s2);

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledWith(
      path.join(repo, '.git', 'logs', 'HEAD'),
      expect.any(Function),
    );

    fire?.('change');
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(1);

    dispose1();
    expect(close).not.toHaveBeenCalled();
    fire?.('change');
    expect(s1).toHaveBeenCalledTimes(1); // unsubscribed
    expect(s2).toHaveBeenCalledTimes(2);

    dispose2();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refreshes on rename events but ignores unknown ones', async () => {
    let fire: ((eventType: string) => void) | undefined;
    watchMock.mockImplementation(
      (_p: string, listener: (eventType: string) => void) => {
        fire = listener;
        return { close: vi.fn() } as unknown as fs.FSWatcher;
      },
    );
    const repo = await makeRepo('ref: refs/heads/main\n');
    const sub = vi.fn();
    const dispose = await watchRepoBranch(repo, sub);

    fire?.('rename');
    expect(sub).toHaveBeenCalledTimes(1);
    fire?.('something-else');
    expect(sub).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('does not watch when there is no reflog yet', async () => {
    const repo = await makeRepo('ref: refs/heads/main\n', {
      withReflog: false,
    });
    const dispose = await watchRepoBranch(repo, vi.fn());
    expect(watchMock).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('returns a no-op disposer outside a repository', async () => {
    const dir = await makeBareDir();
    const dispose = await watchRepoBranch(dir, vi.fn());
    expect(watchMock).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });
});

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
  // A real git dir carries an object store; isRealGitDir requires objects/ + refs/.
  await fsp.mkdir(path.join(dir, '.git', 'objects'), { recursive: true });
  await fsp.mkdir(path.join(dir, '.git', 'refs'), { recursive: true });
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
    'a\x9bb', // C1 control (CSI) — terminal escape injection
    'a\u2028b', // Unicode line separator — status-line layout desync
    'a'.repeat(256), // exceeds the length cap
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

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked HEAD (would follow out of the repo)',
    async () => {
      const repo = await makeRepo('ref: refs/heads/main\n');
      const secret = path.join(await makeBareDir(), 'secret');
      await fsp.writeFile(secret, 'ref: refs/heads/leaked\n');
      const headPath = path.join(repo, '.git', 'HEAD');
      await fsp.rm(headPath);
      await fsp.symlink(secret, headPath);
      expect(await readGitHead(path.join(repo, '.git'))).toBeNull();
    },
  );
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
    // A real worktree gitdir has no objects/ of its own; commondir points at
    // the main gitdir (which has objects/ + refs/).
    await fsp.writeFile(path.join(realGitDir, 'commondir'), '../..\n');
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

  it('does not cache a non-repo miss (detects git init mid-session)', async () => {
    const dir = await makeBareDir();
    expect(await resolveBranchName(dir)).toBeUndefined();

    // The directory becomes a real repo mid-session. The earlier miss must not
    // have been cached, so the branch resolves without clearing anything.
    await fsp.mkdir(path.join(dir, '.git', 'objects'), { recursive: true });
    await fsp.mkdir(path.join(dir, '.git', 'refs'), { recursive: true });
    await fsp.writeFile(
      path.join(dir, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    expect(await resolveBranchName(dir)).toBe('main');
  });

  it('caches a successful resolution; clearGitDirCache forces re-resolution', async () => {
    const repo = await makeRepo('ref: refs/heads/main\n');
    expect(await resolveBranchName(repo)).toBe('main');

    // Remove the object store. The cached gitDir is still used (only HEAD is
    // re-read), so the branch still resolves...
    await fsp.rm(path.join(repo, '.git', 'objects'), {
      recursive: true,
      force: true,
    });
    expect(await resolveBranchName(repo)).toBe('main');

    // ...until the cache is cleared and re-resolution rejects the storeless dir.
    clearGitDirCache();
    expect(await resolveBranchName(repo)).toBeUndefined();
  });

  it('rejects a .git gitdir pointer to a non-repo path', async () => {
    // A crafted `.git` FILE pointing at an out-of-repo dir with a fake HEAD but
    // no object store.
    const decoy = await makeBareDir();
    await fsp.writeFile(path.join(decoy, 'HEAD'), 'ref: refs/heads/pwned\n');
    const project = await makeBareDir();
    await fsp.writeFile(path.join(project, '.git'), `gitdir: ${decoy}\n`);
    // Without the object-store check this would surface 'pwned'.
    expect(await resolveBranchName(project)).toBeUndefined();
  });

  it('accepts a submodule gitdir with its own object store', async () => {
    const main = await makeRepo('ref: refs/heads/main\n');
    const modDir = path.join(main, '.git', 'modules', 'sub');
    await fsp.mkdir(path.join(modDir, 'objects'), { recursive: true });
    await fsp.mkdir(path.join(modDir, 'refs'), { recursive: true });
    await fsp.writeFile(path.join(modDir, 'HEAD'), 'ref: refs/heads/submod\n');
    const sub = await makeBareDir();
    await fsp.writeFile(path.join(sub, '.git'), `gitdir: ${modDir}\n`);
    expect(await resolveBranchName(sub)).toBe('submod');
  });

  it('rejects a .git/worktrees/* gitdir with no object store', async () => {
    // Path shape alone must not be trusted: a crafted `.git/worktrees/fake`
    // with only a HEAD (no objects/, no commondir) is rejected, like git.
    const other = await makeBareDir();
    const fake = path.join(other, '.git', 'worktrees', 'fake');
    await fsp.mkdir(fake, { recursive: true });
    await fsp.writeFile(path.join(fake, 'HEAD'), 'ref: refs/heads/pwned\n');
    const project = await makeBareDir();
    await fsp.writeFile(path.join(project, '.git'), `gitdir: ${fake}\n`);
    expect(await resolveBranchName(project)).toBeUndefined();
  });

  it('rejects a fake .git directory with only a HEAD (no object store)', async () => {
    const dir = await makeBareDir();
    await fsp.mkdir(path.join(dir, '.git', 'logs'), { recursive: true });
    await fsp.writeFile(
      path.join(dir, '.git', 'HEAD'),
      'ref: refs/heads/FAKE-DOTGIT\n',
    );
    await fsp.writeFile(path.join(dir, '.git', 'logs', 'HEAD'), 'x\n');
    expect(await resolveBranchName(dir)).toBeUndefined();
  });
});

describe('watchRepoBranch', () => {
  // Mock fs.watch to return an observable FSWatcher: a close() spy plus
  // captured change/error listeners we can fire from the test.
  function installWatchMock() {
    let listener: ((eventType: string) => void) | undefined;
    let errorHandler: (() => void) | undefined;
    const close = vi.fn();
    watchMock.mockImplementation(
      (_p: string, l: (eventType: string) => void) => {
        listener = l;
        return {
          close,
          on: (event: string, handler: () => void) => {
            if (event === 'error') errorHandler = handler;
          },
        } as unknown as fs.FSWatcher;
      },
    );
    return {
      close,
      fire: (eventType: string) => listener?.(eventType),
      emitError: () => errorHandler?.(),
    };
  }

  it('shares one watcher across subscribers and tears down on last unsubscribe', async () => {
    const w = installWatchMock();
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

    w.fire('change');
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(1);

    dispose1();
    expect(w.close).not.toHaveBeenCalled();
    w.fire('change');
    expect(s1).toHaveBeenCalledTimes(1); // unsubscribed
    expect(s2).toHaveBeenCalledTimes(2);

    dispose2();
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it('refreshes on rename events but ignores unknown ones', async () => {
    const w = installWatchMock();
    const repo = await makeRepo('ref: refs/heads/main\n');
    const sub = vi.fn();
    const dispose = await watchRepoBranch(repo, sub);

    w.fire('rename');
    expect(sub).toHaveBeenCalledTimes(1);
    w.fire('something-else');
    expect(sub).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("tears down the watch on an FSWatcher 'error' instead of crashing", async () => {
    const w = installWatchMock();
    const repo = await makeRepo('ref: refs/heads/main\n');
    const sub = vi.fn();
    const dispose = await watchRepoBranch(repo, sub);

    // An unhandled 'error' on an EventEmitter would throw; ours must not.
    expect(() => w.emitError()).not.toThrow();
    expect(w.close).toHaveBeenCalledTimes(1);

    // The dead watch is gone: a stale event no longer reaches the subscriber,
    // and disposing is a safe no-op.
    w.fire('change');
    expect(sub).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('does not watch without a reflog, but watches once it appears', async () => {
    installWatchMock();
    const repo = await makeRepo('ref: refs/heads/main\n', {
      withReflog: false,
    });
    const dispose1 = await watchRepoBranch(repo, vi.fn());
    expect(watchMock).not.toHaveBeenCalled();
    expect(() => dispose1()).not.toThrow();

    // The reflog appears (e.g. first commit); a later caller must be able to
    // establish the watch — the earlier miss must not be cached.
    await fsp.mkdir(path.join(repo, '.git', 'logs'), { recursive: true });
    await fsp.writeFile(path.join(repo, '.git', 'logs', 'HEAD'), 'reflog\n');
    const dispose2 = await watchRepoBranch(repo, vi.fn());
    expect(watchMock).toHaveBeenCalledTimes(1);
    dispose2();
  });

  it('dedupes concurrent subscribers into a single watcher', async () => {
    installWatchMock();
    const repo = await makeRepo('ref: refs/heads/main\n');
    // Both calls race through getCachedGitDir + access() before either registers
    // the entry, exercising the post-await re-check path.
    const [dispose1, dispose2] = await Promise.all([
      watchRepoBranch(repo, vi.fn()),
      watchRepoBranch(repo, vi.fn()),
    ]);
    expect(watchMock).toHaveBeenCalledTimes(1);
    dispose1();
    dispose2();
  });

  it('returns a no-op disposer outside a repository', async () => {
    installWatchMock();
    const dir = await makeBareDir();
    const dispose = await watchRepoBranch(dir, vi.fn());
    expect(watchMock).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('returns a no-op (never rejects) when fs.watch throws synchronously', async () => {
    watchMock.mockImplementation(() => {
      // TOCTOU: logs/HEAD vanished after access(), or a platform watch limit.
      throw new Error('ENOENT');
    });
    const repo = await makeRepo('ref: refs/heads/main\n');
    // Must resolve to a disposer, not reject (which would surface as unhandled).
    const dispose = await watchRepoBranch(repo, vi.fn());
    expect(() => dispose()).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked reflog (no out-of-repo watch)',
    async () => {
      installWatchMock();
      const repo = await makeRepo('ref: refs/heads/main\n', {
        withReflog: false,
      });
      const target = path.join(await makeBareDir(), 'evil-log');
      await fsp.writeFile(target, 'x\n');
      await fsp.mkdir(path.join(repo, '.git', 'logs'), { recursive: true });
      await fsp.symlink(target, path.join(repo, '.git', 'logs', 'HEAD'));
      const dispose = await watchRepoBranch(repo, vi.fn());
      expect(watchMock).not.toHaveBeenCalled();
      expect(() => dispose()).not.toThrow();
    },
  );
});

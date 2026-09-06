/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchGitRemotes,
  gitRemoteAdd,
  gitRemoteRemove,
  isRemovableRemoteName,
  isValidRemoteName,
  isValidRemoteUrl,
} from './git-remotes.js';

const tmpRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitremotes-'));
  tmpRoots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Neutralize an inherited global core.hooksPath (hook managers installed
  // machine-wide would otherwise run on every fixture commit).
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe('isValidRemoteName', () => {
  it.each([
    ['origin', true],
    ['upstream', true],
    ['my-fork_2.0', true],
    ['', false],
    ['-origin', false],
    ['a/b', false],
    ['a b', false],
    ['a..b', false],
    ['.a', false],
    ['a.', false],
    ['a.lock', false],
    ['a@{b', false],
    ['a:b', false],
    ['a?b', false],
    ['HEAD', false],
    ['a\tb', false],
  ])('isValidRemoteName(%j) === %s', (name, expected) => {
    expect(isValidRemoteName(name)).toBe(expected);
  });
});

describe('isValidRemoteUrl', () => {
  it.each([
    ['https://example.com/o/r.git', true],
    ['git@example.com:o/r.git', true],
    ['file:///tmp/repo', true],
    ['/tmp/local path/repo', true],
    ['', false],
    ['-oProxyCommand=x', false],
    ['https://x/\nmalicious', false],
    // Bidi-override, zero-width, bidi-mark (LRM/RLM), soft-hyphen and
    // line/paragraph-separator characters are rejected: the URL is rendered
    // verbatim in the Web Shell (gitDirect's display policy, extended to
    // the full Default_Ignorable set).
    ['https://example.com/\u202eevil', false],
    ['https://example.com/\u200b', false],
    ['https://example.com/\u2029evil', false],
    ['https://example.com/\u200fevil', false],
    ['https://example.com/\u00adevil', false],
  ])('isValidRemoteUrl(%j) === %s', (url, expected) => {
    expect(isValidRemoteUrl(url)).toBe(expected);
  });
});

describe('isRemovableRemoteName', () => {
  // Removal must not be stricter than git: names a hand-edited config can
  // hold stay removable, while the exec-vector floor still holds.
  it.each([
    ['origin', true],
    ['a.lock', true],
    ['a/b', true],
    ['a:b', true],
    ['HEAD', true],
    ['', false],
    ['-x', false],
    ['a\tb', false],
  ])('isRemovableRemoteName(%j) === %s', (name, expected) => {
    expect(isRemovableRemoteName(name)).toBe(expected);
  });

  it('is strictly more lenient than the add predicate', () => {
    expect(isValidRemoteName('a.lock')).toBe(false);
    expect(isRemovableRemoteName('a.lock')).toBe(true);
  });
});

describe('fetchGitRemotes', () => {
  it('returns an empty list for a repo without remotes', async () => {
    const dir = makeRepo();
    await expect(fetchGitRemotes(dir)).resolves.toEqual([]);
  });

  it('groups fetch/push lines by name in git printed order', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const remotes = await fetchGitRemotes(dir);
    // `git remote` prints names sorted, not in config order.
    expect(remotes.map((r) => r.name)).toEqual(['origin', 'upstream']);
    for (const remote of remotes) {
      expect(remote.pushUrl).toBe(remote.fetchUrl);
    }
  });

  it('reports the true fetch url for a promisor (partial-clone) remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/upstream.git');
    git(
      dir,
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://example.com/fork.git',
    );
    // `git remote -v` annotates this fetch line with `[blob:none]`; the
    // structured accessors must not be fooled by the rendered form.
    git(dir, 'config', 'remote.origin.promisor', 'true');
    git(dir, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    const remotes = await fetchGitRemotes(dir);
    expect(remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/upstream.git',
        pushUrl: 'https://example.com/fork.git',
      },
    ]);
  });

  it('reports the name as url when the config entry lost its url', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'config', '--unset', 'remote.origin.url');
    // git's own fallback: `get-url` answers the remote name when no URL is
    // configured.
    await expect(fetchGitRemotes(dir)).resolves.toEqual([
      { name: 'origin', fetchUrl: 'origin', pushUrl: 'origin' },
    ]);
  });

  it('reports a push-url override set via git remote set-url --push', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(
      dir,
      'remote',
      'set-url',
      '--push',
      'origin',
      'git@example.com:o/r.git',
    );
    const remotes = await fetchGitRemotes(dir);
    expect(remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'git@example.com:o/r.git',
      },
    ]);
  });

  it('rejects outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-notrepo-'));
    tmpRoots.push(dir);
    await expect(fetchGitRemotes(dir)).rejects.toThrow();
  });

  // Crosses the lookup concurrency bound (8) in both directions: every
  // configured remote must come back, in git's sorted order, with its own
  // push override intact.
  it('lists every remote across the batched lookups', async () => {
    const dir = makeRepo();
    const expected: string[] = [];
    for (let i = 0; i < 24; i++) {
      const name = `r${String(i).padStart(2, '0')}`;
      git(dir, 'remote', 'add', name, `https://example.com/${name}.git`);
      if (i % 3 === 0) {
        git(
          dir,
          'remote',
          'set-url',
          '--push',
          name,
          `git@example.com:${name}.git`,
        );
      }
      expected.push(name);
    }
    const remotes = await fetchGitRemotes(dir);
    expect(remotes.map((r) => r.name)).toEqual(expected.sort());
    for (const remote of remotes) {
      const index = Number(remote.name.slice(1));
      expect(remote.fetchUrl).toBe(`https://example.com/${remote.name}.git`);
      expect(remote.pushUrl).toBe(
        index % 3 === 0
          ? `git@example.com:${remote.name}.git`
          : remote.fetchUrl,
      );
    }
  });
});

describe('gitRemoteAdd', () => {
  it('adds a remote and returns the fresh list', async () => {
    const dir = makeRepo();
    const remotes = await gitRemoteAdd(
      dir,
      'origin',
      'https://example.com/o/r.git',
    );
    expect(remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'https://example.com/o/r.git',
      },
    ]);
    expect(git(dir, 'remote')).toBe('origin\n');
  });

  // Pins the predicate/git agreement the reverse audit could not verify
  // under the shell guard: names isValidRemoteName accepts must also be
  // accepted by `git remote add`, so the route answers 400 only for names
  // git would refuse too — never a 500 over a predicate-legal name.
  it.each(['a@b', 'a+b', 'a#b', '@'])(
    'git accepts the predicate-legal name %j',
    async (name) => {
      const dir = makeRepo();
      const remotes = await gitRemoteAdd(
        dir,
        name,
        'https://example.com/o/r.git',
      );
      expect(remotes.map((r) => r.name)).toEqual([name]);
    },
  );

  it('rejects a duplicate name with git output attached', async () => {
    const dir = makeRepo();
    await gitRemoteAdd(dir, 'origin', 'https://example.com/o/r.git');
    const err = await gitRemoteAdd(
      dir,
      'origin',
      'https://example.com/other.git',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr)
        : '';
    expect(stderr).toMatch(/already exists/i);
  });

  it('rejects invalid names and urls before spawning git', async () => {
    const dir = makeRepo();
    await expect(
      gitRemoteAdd(dir, '-x', 'https://example.com/o/r.git'),
    ).rejects.toThrow(/invalid remote name/);
    await expect(gitRemoteAdd(dir, 'origin', '')).rejects.toThrow(
      /invalid remote url/,
    );
    await expect(gitRemoteAdd(dir, 'origin', '-upload-pack=x')).rejects.toThrow(
      /invalid remote url/,
    );
    await expect(
      gitRemoteAdd(dir, 'origin', 'https://example.com/\u202eevil'),
    ).rejects.toThrow(/invalid remote url/);
    expect(git(dir, 'remote')).toBe('');
  });
});

describe('gitRemoteRemove', () => {
  it('removes a remote and returns the fresh list', async () => {
    const dir = makeRepo();
    await gitRemoteAdd(dir, 'origin', 'https://example.com/o/r.git');
    await gitRemoteAdd(dir, 'upstream', 'https://example.com/u/r.git');
    const remotes = await gitRemoteRemove(dir, 'origin');
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    expect(git(dir, 'remote')).toBe('upstream\n');
  });

  it('removing an unknown remote surfaces git no-such-remote', async () => {
    const dir = makeRepo();
    const err = await gitRemoteRemove(dir, 'missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr)
        : '';
    expect(stderr).toMatch(/no such remote/i);
  });

  it('removes a hand-configured remote whose name the add predicate rejects', async () => {
    const dir = makeRepo();
    // A name `git remote add` would refuse (`.lock` suffix), written
    // straight into the config — removal must still work on it. (No fetch
    // refspec: `refs/remotes/x.lock/*` is not a valid refname, and git
    // rejects the whole listing over it.)
    git(dir, 'config', 'remote.x.lock.url', 'https://example.com/x.git');
    const listed = await fetchGitRemotes(dir);
    expect(listed.map((r) => r.name)).toEqual(['x.lock']);

    const remotes = await gitRemoteRemove(dir, 'x.lock');
    expect(remotes).toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('rejects flag-shaped names before spawning git', async () => {
    const dir = makeRepo();
    await expect(gitRemoteRemove(dir, '-x')).rejects.toThrow(
      /invalid remote name/,
    );
  });
});

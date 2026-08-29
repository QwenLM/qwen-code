/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitEnv,
  gitPull,
  gitPush,
  isValidCheckoutRef,
} from './git-branches.js';
import { getDefaultBranch } from './github-prs.js';

const tmpRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranches-'));
  tmpRoots.push(dir);
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function makeBareRemote(): string {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitremote-'));
  tmpRoots.push(remote);
  git(remote, 'init', '-q', '--bare');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/master');
  return remote;
}

function currentBranch(cwd: string): string {
  return git(cwd, 'symbolic-ref', '--short', 'HEAD').trim();
}

function headSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('isValidCheckoutRef', () => {
  it.each([
    'main',
    'feature/foo',
    'release/2.0',
    'v1.2.3',
    'HEAD',
    'abc1234', // short SHA
    'a'.repeat(40), // full SHA-1
  ])('accepts %s', (ref) => {
    expect(isValidCheckoutRef(ref)).toBe(true);
  });

  it.each([
    '',
    '   ',
    '.', // pathspec that would wipe the working tree
    '-f',
    '--patch',
    '--force',
    '--output=/tmp/pwned',
    '-b',
    '../etc',
  ])('rejects %s', (ref) => {
    expect(isValidCheckoutRef(ref)).toBe(false);
  });
});

describe('gitEnv (R12 env isolation)', () => {
  it('strips repository-shaping variables from the child environment', () => {
    const env = gitEnv({
      PATH: '/usr/bin',
      GH_REPO: 'evil/repo',
      GIT_DIR: '/elsewhere/.git',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      GIT_CONFIG_SYSTEM: '/etc/evil-gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://evil.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_PARAMETERS: "'foo=bar'",
      GIT_OBJECT_DIRECTORY: '/tmp/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/alt',
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['LC_ALL']).toBe('C');
    for (const key of [
      'GH_REPO',
      'GIT_DIR',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_PARAMETERS',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('keeps repository discovery on the cwd even with a hostile GIT_DIR', async () => {
    const dir = makeRepo();
    git(dir, 'branch', 'feature');
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = '/definitely/not/a/repo/.git';
    try {
      const result = await fetchGitBranches(dir);
      expect(result.local.map((b) => b.name)).toContain('feature');
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
    }
  });
});

describe('fetchGitBranches upstream tracking', () => {
  it('marks a branch whose upstream ref was deleted and pruned as gone', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'master');
    git(dir, 'checkout', '-q', '-b', 'feat');
    git(dir, 'push', '-q', '-u', 'origin', 'feat');

    const tracked = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'feat',
    );
    expect(tracked?.upstream).toBe('origin/feat');
    expect(tracked?.upstreamGone).toBeUndefined();

    git(dir, 'push', '-q', 'origin', '--delete', 'feat');
    git(dir, 'fetch', '-q', '--prune', 'origin');

    const gone = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'feat',
    );
    // The configured upstream is still reported so the UI can name it, but
    // the flag says its ref no longer exists.
    expect(gone?.upstream).toBe('origin/feat');
    expect(gone?.upstreamGone).toBe(true);
    expect(gone?.ahead).toBe(0);
    expect(gone?.behind).toBe(0);
    const master = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'master',
    );
    expect(master?.upstreamGone).toBeUndefined();
  });
});

describe('fetchGitBranches recent branches', () => {
  it('lists recently checked-out branches from the reflog', async () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-q', '-b', 'feature-a');
    git(dir, 'checkout', '-q', '-b', 'feature-b');
    git(dir, 'checkout', '-q', 'master');

    const result = await fetchGitBranches(dir);

    expect(result.recent).toContain('feature-b');
    expect(result.recent).toContain('feature-a');
    expect(result.recent).not.toContain('master');
  });
});

describe('fetchGitBranches HEAD under colliding refs', () => {
  it('reports head without the heads/ prefix under a colliding tag', async () => {
    // `symbolic-ref --short` shortens to the shortest unambiguous name and
    // would report `heads/release`; the full-form read must win.
    const dir = makeRepo();
    git(dir, 'branch', 'release');
    git(dir, 'tag', 'release');
    git(dir, 'checkout', '-q', 'release');

    expect((await fetchGitBranches(dir)).head).toBe('release');
  });
});

describe('gitCheckout', () => {
  it('switches to an existing branch', async () => {
    const dir = makeRepo();
    git(dir, 'branch', 'feature');

    const result = await gitCheckout(dir, 'feature');

    expect(result).toEqual({ branch: 'feature', detached: false });
    expect(currentBranch(dir)).toBe('feature');
  });

  it('checks out a tag into a detached HEAD', async () => {
    const dir = makeRepo();
    git(dir, 'tag', 'v1.0');

    const result = await gitCheckout(dir, 'v1.0');

    expect(result.detached).toBe(true);
  });

  it('checks out the tag, not a same-named branch, via refs/tags/', async () => {
    const dir = makeRepo();
    // Tag the initial commit, then advance the branch and create a same-named branch.
    git(dir, 'tag', 'release');
    const tagCommit = headSha(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');
    git(dir, 'branch', 'release'); // refs/heads/release now differs from refs/tags/release

    const result = await gitCheckout(dir, 'refs/tags/release');

    expect(result.detached).toBe(true);
    expect(headSha(dir)).toBe(tagCommit);
  });

  it('rejects a pathspec ref that would discard working-tree changes', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitCheckout(dir, '.')).rejects.toThrow(/invalid checkout ref/);
    // The uncommitted edit must survive the rejected checkout.
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
  });

  it.each(['-f', '--force', '--patch', '--output=/tmp/pwned'])(
    'rejects option injection via %s',
    async (ref) => {
      const dir = makeRepo();
      await expect(gitCheckout(dir, ref)).rejects.toThrow(
        /invalid checkout ref/,
      );
    },
  );

  it('does not revert a dirty file when ref names a tracked path', async () => {
    const dir = makeRepo();
    // 'a.txt' is a tracked file AND a valid ref name (passes
    // isValidCheckoutRef). Without the -- terminator, git checkout
    // would interpret it as a pathspec and revert the working tree.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'LOCAL EDIT\n');

    await expect(gitCheckout(dir, 'a.txt')).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'LOCAL EDIT\n',
    );
  });

  // The hook tests install POSIX sh scripts; git's hook execution on
  // Windows cannot be verified from the Linux CI hosts, so skip them there
  // (the absorbed-hook logic itself is platform-independent).
  it.skipIf(process.platform === 'win32')(
    'reports success when only the post-checkout hook fails',
    async () => {
      // Git runs the post-checkout hook AFTER HEAD has moved and exits
      // non-zero when it fails. The switch itself completed, so the result
      // must reflect the real state instead of claiming a failure.
      const dir = makeRepo();
      git(dir, 'branch', 'target');
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\nexit 1\n',
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      const result = await gitCheckout(dir, 'target');

      expect(result).toEqual({ branch: 'target', detached: false });
      expect(currentBranch(dir)).toBe('target');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a detached landing when the hook fails on a tag checkout',
    async () => {
      const dir = makeRepo();
      git(dir, 'tag', 'v1.0');
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\nexit 1\n',
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      const result = await gitCheckout(dir, 'v1.0');

      expect(result.detached).toBe(true);
    },
  );

  it('still rejects a refused checkout without moving HEAD', async () => {
    const dir = makeRepo();
    // The target branch rewrites a.txt; the dirty local edit makes git
    // refuse the switch BEFORE moving HEAD.
    git(dir, 'checkout', '-q', '-b', 'target');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'target version\n');
    git(dir, 'commit', '-q', '-am', 'target change');
    git(dir, 'checkout', '-q', 'master');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitCheckout(dir, 'target')).rejects.toThrow();
    expect(currentBranch(dir)).toBe('master');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'restores the original branch when a failing hook moved HEAD away',
    async () => {
      // A post-checkout hook can move HEAD (`symbolic-ref` needs no index
      // lock, which the parent checkout holds) and then fail the checkout.
      // The rollback must restore the original branch — it fires because
      // HEAD's reflog records this step's checkout move. The hook removes
      // itself so the rollback checkout is not re-sabotaged by a second run.
      const dir = makeRepo();
      git(dir, 'branch', 'target');
      git(dir, 'branch', 'elsewhere');
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\nrm -f "$0"\ngit symbolic-ref HEAD refs/heads/elsewhere\nexit 1\n',
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      await expect(gitCheckout(dir, 'target')).rejects.toThrow();
      expect(currentBranch(dir)).toBe('master');
    },
  );

  it('rejects a failed checkout whose target commit already matches HEAD', async () => {
    // origin/feature points at the same commit as master. With the index
    // locked, the tracking checkout fails BEFORE moving HEAD; the
    // commit-match fallback must not absorb that as a successful landing
    // while HEAD is still attached to a branch.
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
    git(dir, 'fetch', '-q', 'origin');
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
    try {
      await expect(gitCheckout(dir, 'origin/feature')).rejects.toThrow();
    } finally {
      fs.rmSync(path.join(dir, '.git', 'index.lock'));
    }
    expect(currentBranch(dir)).toBe('master');
  });

  it('rejects a refused checkout when detached HEAD already sits on the target commit', async () => {
    // With the index locked the checkout is refused before moving HEAD. The
    // commit-equality fallback must not absorb that: HEAD was ALREADY
    // detached at the target commit, so the equality holds without a switch.
    const dir = makeRepo();
    git(dir, 'branch', 'target');
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
    try {
      await expect(gitCheckout(dir, 'target')).rejects.toThrow();
    } finally {
      fs.rmSync(path.join(dir, '.git', 'index.lock'));
    }
    // HEAD stays detached; the refusal was not absorbed as a landing.
    expect(() => git(dir, 'symbolic-ref', 'HEAD')).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'logs a refused rollback restore instead of swallowing it',
    async () => {
      // The failing hook dirties a file that diverges between the half-moved
      // HEAD and the original branch, so the restore checkout is refused; the
      // refusal must surface instead of vanishing silently.
      const dir = makeRepo();
      git(dir, 'checkout', '-q', '-b', 'target');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'target version\n');
      git(dir, 'commit', '-q', '-am', 'target change');
      git(dir, 'checkout', '-q', '-b', 'elsewhere', 'master');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'elsewhere version\n');
      git(dir, 'commit', '-q', '-am', 'elsewhere change');
      git(dir, 'checkout', '-q', 'master');
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\necho dirty > a.txt\ngit symbolic-ref HEAD refs/heads/elsewhere\nexit 1\n',
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(gitCheckout(dir, 'target')).rejects.toThrow();
        expect(errorSpy).toHaveBeenCalledWith(
          'git checkout rollback failed:',
          expect.anything(),
        );
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});

describe('gitCreateBranch', () => {
  it('creates a branch from a valid start point', async () => {
    const dir = makeRepo();

    const result = await gitCreateBranch(dir, 'topic', 'HEAD');

    expect(result).toEqual({ branch: 'topic', detached: false });
    expect(currentBranch(dir)).toBe('topic');
  });

  it.each(['-f', '--orphan', '.'])(
    'rejects an invalid start point %s',
    async (startPoint) => {
      const dir = makeRepo();
      await expect(gitCreateBranch(dir, 'topic', startPoint)).rejects.toThrow(
        /invalid start point/,
      );
    },
  );

  it.each(['-f', '--orphan', ''])(
    'rejects an invalid branch name %s',
    async (name) => {
      const dir = makeRepo();
      await expect(gitCreateBranch(dir, name)).rejects.toThrow(
        /invalid branch name/,
      );
    },
  );

  it('treats a tracked filename as a ref, not a pathspec (-- terminator)', async () => {
    const dir = makeRepo();
    // Without the trailing `--`, `git checkout -b a.txt` would error
    // differently or create a branch from a pathspec interpretation.
    // The `-b` flag already forces commit-ish interpretation, so this
    // is defense-in-depth; the lock test ensures a refactor cannot
    // silently drop the terminator.
    const result = await gitCreateBranch(dir, 'a.txt');
    expect(result.branch).toBe('a.txt');
    expect(currentBranch(dir)).toBe('a.txt');
  });
});

describe('gitCreateBranch rollback (R12)', () => {
  it.skipIf(process.platform === 'win32')(
    'rolls back a branch created before a failing post-checkout hook',
    async () => {
      const dir = makeRepo();
      const before = currentBranch(dir);
      const hookDir = path.join(dir, '.git', 'hooks');
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'post-checkout'),
        '#!/bin/sh\nexit 1\n',
        {
          mode: 0o755,
        },
      );

      await expect(gitCreateBranch(dir, 'topic')).rejects.toThrow();

      // HEAD is restored and the half-created branch is removed.
      expect(currentBranch(dir)).toBe(before);
      const branches = git(dir, 'branch', '--format=%(refname:short)');
      expect(branches.split('\n').map((s) => s.trim())).not.toContain('topic');
    },
  );
});

describe('gitPush', () => {
  it('throws a clear error when setUpstream is used in detached HEAD', async () => {
    const dir = makeRepo();
    git(dir, 'tag', 'v1.0');
    git(dir, 'checkout', '-q', 'v1.0');

    await expect(gitPush(dir, { setUpstream: true })).rejects.toThrow(
      /detached HEAD/,
    );
  });

  it('fails loud on a setUpstream push under a colliding tag', async () => {
    // The branch name is read from the full symbolic ref: a regression to
    // `symbolic-ref --short HEAD` would resolve `heads/feature` here and
    // fail with a different error (no matching refspec) instead.
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'branch', 'feature');
    git(dir, 'tag', 'feature');
    git(dir, 'checkout', '-q', 'feature');

    await expect(gitPush(dir, { setUpstream: true })).rejects.toThrow(
      /matches more than one/,
    );
  });

  it('preserves an existing upstream instead of rewriting it', async () => {
    const dir = makeRepo();
    const remoteA = makeBareRemote();
    const remoteB = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remoteA);
    git(dir, 'remote', 'add', 'upstream', remoteB);
    git(dir, 'push', '-q', 'upstream', 'HEAD');
    // Set tracking to upstream, not origin.
    const branch = currentBranch(dir);
    git(dir, 'branch', '--set-upstream-to', `upstream/${branch}`, branch);

    // Make a new commit so push has something to send.
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');

    await gitPush(dir, { setUpstream: true });

    // Tracking must still point at upstream, not origin.
    const tracking = git(
      dir,
      'rev-parse',
      '--abbrev-ref',
      `${branch}@{u}`,
    ).trim();
    expect(tracking).toBe(`upstream/${branch}`);
    // The commit must have landed in the upstream remote.
    const upstreamLog = git(remoteB, 'log', '--oneline', '-1');
    expect(upstreamLog).toContain('second');
  });

  it('resolves the sole configured remote when no upstream exists', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'myfork', remote);

    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');

    await gitPush(dir, { setUpstream: true });

    const branch = currentBranch(dir);
    const tracking = git(
      dir,
      'rev-parse',
      '--abbrev-ref',
      `${branch}@{u}`,
    ).trim();
    expect(tracking).toBe(`myfork/${branch}`);
  });

  it('uses --force-with-lease when force is requested', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '--set-upstream', 'origin', 'HEAD');

    // Amend the commit so local and remote diverge, requiring a force push.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'amended\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '--amend', '-m', 'amended');

    await gitPush(dir, { force: true });

    const remoteLog = git(remote, 'log', '--oneline', '-1');
    expect(remoteLog).toContain('amended');
  });
});

describe('gitPush push-remote precedence (R12)', () => {
  it('honors remote.pushDefault over the sole/origin remote', async () => {
    const dir = makeRepo();
    const origin = makeBareRemote();
    const fork = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'remote', 'add', 'fork', fork);
    git(dir, 'config', 'remote.pushDefault', 'fork');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');

    await gitPush(dir, { setUpstream: true });

    const branch = currentBranch(dir);
    const tracking = git(
      dir,
      'rev-parse',
      '--abbrev-ref',
      `${branch}@{u}`,
    ).trim();
    expect(tracking).toBe(`fork/${branch}`);
  });

  it('honors branch.<name>.pushRemote over branch.<name>.remote', async () => {
    const dir = makeRepo();
    const origin = makeBareRemote();
    const fork = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'remote', 'add', 'fork', fork);
    const branch = currentBranch(dir);
    // Pull remote is origin but there is no upstream tracking (@{u} fails),
    // and the push remote is explicitly the fork.
    git(dir, 'config', `branch.${branch}.remote`, 'origin');
    git(dir, 'config', `branch.${branch}.pushRemote`, 'fork');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');

    await gitPush(dir, { setUpstream: true });

    const tracking = git(
      dir,
      'rev-parse',
      '--abbrev-ref',
      `${branch}@{u}`,
    ).trim();
    expect(tracking).toBe(`fork/${branch}`);
  });
});

describe('gitCommit', () => {
  it('commits staged changes and returns sha and subject', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git(dir, 'add', '.');

    const result = await gitCommit(dir, 'update a.txt');

    expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(result.subject).toBe('update a.txt');
  });

  it('stages untracked files when all is true', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');

    const result = await gitCommit(dir, 'add new file', { all: true });

    expect(result.subject).toBe('add new file');
    const status = git(dir, 'status', '--porcelain');
    expect(status.trim()).toBe('');
  });

  it('throws on a clean working tree', async () => {
    const dir = makeRepo();

    await expect(gitCommit(dir, 'noop', { all: true })).rejects.toThrow();
  });
});

describe('gitPull', () => {
  it('fetch-only does not merge a divergent remote commit', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD');

    // Create a divergent commit on the remote via a second clone.
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    const headBefore = headSha(dir);

    const result = await gitPull(dir, { fetchOnly: true });

    expect(result.success).toBe(true);
    // HEAD must not have advanced — fetch-only must not merge.
    expect(headSha(dir)).toBe(headBefore);
    // But the remote ref must have been fetched.
    const branch = currentBranch(dir);
    const fetched = git(dir, 'rev-parse', `origin/${branch}`).trim();
    expect(fetched).not.toBe(headBefore);
  });

  it('merge pull integrates a remote commit', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    const headBefore = headSha(dir);

    const result = await gitPull(dir);

    expect(result.success).toBe(true);
    expect(headSha(dir)).not.toBe(headBefore);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
  });

  it('rebase pull integrates a remote commit', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // Create a local commit so rebase has something to replay.
    fs.writeFileSync(path.join(dir, 'local-only.txt'), 'local\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');

    const result = await gitPull(dir, { rebase: true });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'local-only.txt'))).toBe(true);
  });
});

describe('gitCommit index rollback (R10 #1)', () => {
  it.skipIf(process.platform === 'win32')(
    'restores the original index when the commit fails after add -A',
    async () => {
      const dir = makeRepo();
      const hookDir = path.join(dir, '.git', 'hooks');
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'pre-commit'),
        '#!/bin/sh\necho "lint failed" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      // Stage a deliberate subset and leave another file untracked.
      fs.writeFileSync(path.join(dir, 'a.txt'), 'staged edit\n');
      git(dir, 'add', 'a.txt');
      fs.writeFileSync(path.join(dir, 'scratch.txt'), 'never staged\n');

      expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');

      await expect(gitCommit(dir, 'feat: x', { all: true })).rejects.toThrow();

      // The failed commit must not leave the whole tree staged: the index
      // returns to exactly what the user had staged beforehand.
      expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');
    },
  );

  it('refuses add -A when unmerged entries prevent rollback', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD');

    // Create a conflicting change on the remote.
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote change\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote edit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // Create a conflicting local change and attempt merge.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local change\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local edit');
    git(dir, 'fetch', '-q', 'origin');
    let mergeFailed = false;
    try {
      git(dir, 'merge', 'origin/' + currentBranch(dir));
    } catch {
      mergeFailed = true;
    }
    expect(mergeFailed).toBe(true);

    // The index now has unmerged entries; gitCommit with all:true must
    // refuse rather than destroy the conflict state.
    await expect(gitCommit(dir, 'fix: resolve', { all: true })).rejects.toThrow(
      /unresolved merge conflicts/,
    );

    // Unmerged state is preserved.
    expect(git(dir, 'ls-files', '--unmerged').trim()).not.toBe('');
  });

  it('refuses add -A when write-tree fails for a non-unmerged reason', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    // Wedge the index lock so write-tree fails but ls-files --unmerged is
    // empty — the code must throw instead of silently continuing without
    // an index snapshot.
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    await expect(gitCommit(dir, 'feat: x', { all: true })).rejects.toThrow(
      /failed to snapshot index/,
    );
  });
});

describe('gitCheckout remote-tracking refs (R10 #4)', () => {
  function advanceRemote(remote: string, fileName: string): string {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(clone, fileName), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', `advance ${fileName}`);
    git(clone, 'push', '-q', 'origin', 'HEAD');
    return git(clone, 'rev-parse', 'HEAD').trim();
  }

  it('tracks the exact remote ref when no local branch exists (multi-remote)', async () => {
    const dir = makeRepo();
    const branch = currentBranch(dir);
    const remoteA = makeBareRemote();
    const remoteB = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remoteA);
    git(dir, 'remote', 'add', 'upstream', remoteB);
    git(dir, 'push', '-q', 'origin', 'HEAD');
    git(dir, 'push', '-q', 'upstream', 'HEAD');
    // Advance upstream only, then fetch so upstream/<branch> differs.
    const upstreamHead = advanceRemote(remoteB, 'upstream-only.txt');
    git(dir, 'fetch', '-q', 'upstream');
    // Remove the local branch so checkout must create one.
    git(dir, 'checkout', '-q', '--detach');
    git(dir, 'branch', '-D', branch);

    const result = await gitCheckout(dir, `upstream/${branch}`);

    expect(result).toEqual({ branch, detached: false });
    expect(currentBranch(dir)).toBe(branch);
    expect(headSha(dir)).toBe(upstreamHead);
    const tracking = git(
      dir,
      'rev-parse',
      '--abbrev-ref',
      `${branch}@{u}`,
    ).trim();
    expect(tracking).toBe(`upstream/${branch}`);
  });

  it('rejects a remote-tracking ref whose local name is an option (e.g. origin/-f)', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD');
    // Create refs directly — git branch rejects '-f' as a name, but a
    // malicious remote could still carry refs/heads/-f.
    git(dir, 'update-ref', 'refs/heads/-f', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/-f', 'HEAD');

    await expect(gitCheckout(dir, 'origin/-f')).rejects.toThrow(
      'invalid local branch name derived from remote ref',
    );
  });

  it('checks out the existing local branch rather than the remote commit', async () => {
    const dir = makeRepo();
    const branch = currentBranch(dir);
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD');
    // Advance the remote so origin/<branch> differs from the local branch.
    advanceRemote(remote, 'remote-only.txt');
    git(dir, 'fetch', '-q', 'origin');
    const localHead = headSha(dir);
    const remoteHead = git(dir, 'rev-parse', `origin/${branch}`).trim();
    expect(remoteHead).not.toBe(localHead);

    const result = await gitCheckout(dir, `origin/${branch}`);

    // A local branch of that name exists: check it out (staying on the local
    // commit) rather than detaching HEAD on the remote-tracking ref.
    expect(result).toEqual({ branch, detached: false });
    expect(headSha(dir)).toBe(localHead);
  });

  it.skipIf(process.platform === 'win32')(
    'reports a detached landing when a hook detaches HEAD after a tracking checkout',
    async () => {
      // The hook detaches HEAD onto the target commit after `--track` created
      // the branch and exits non-zero: the absorbed failure must report the
      // real detached state, not `{ branch: '', detached: false }`.
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
      git(dir, 'fetch', '-q', 'origin');
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\nrm -f "$0"\ngit checkout -q --detach HEAD\nexit 1\n',
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      const result = await gitCheckout(dir, 'origin/feature');

      expect(result.detached).toBe(true);
      expect(result.branch).not.toBe('');
      expect(() => git(dir, 'symbolic-ref', 'HEAD')).toThrow();
    },
  );
});

describe('gitCheckout concurrent serialization (R9-2)', () => {
  it('serializes concurrent same-target checkouts without rollback crossfire', async () => {
    // Two checkouts of the same target run at once: without per-cwd
    // serialization the later one can fail (`--track` finds the branch the
    // first created), and its reflog scan then matches the FIRST step's
    // entry — passing a movement proof for a HEAD it never moved and
    // rolling back the successful switch. The queue must keep both results
    // consistent with the final HEAD.
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
    git(dir, 'fetch', '-q', 'origin');

    const results = await Promise.allSettled([
      gitCheckout(dir, 'feature'),
      gitCheckout(dir, 'origin/feature'),
    ]);

    expect(currentBranch(dir)).toBe('feature');
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') {
        expect(result.value).toEqual({ branch: 'feature', detached: false });
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'serializes concurrent checkouts spelled through different cwds of one repository (R11-7)',
    async () => {
      // The queue keys on repository identity, not the raw request cwd: git
      // operations from a workspace-contained subdirectory act on the same
      // HEAD and reflog as the root, so two cwd spellings of one repository
      // must share one queue or the crossfire guarded above slips through a
      // per-cwd key. The serialization is asserted deterministically: a
      // post-checkout hook records concurrent executions, which the queue
      // guarantees cannot happen because it holds each checkout — hook
      // included — until completion.
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
      git(dir, 'fetch', '-q', 'origin');
      const sub = path.join(dir, 'subdir');
      fs.mkdirSync(sub);
      const overlap = path.join(dir, '.git', 'overlap');
      const marker = path.join(dir, '.git', 'in-hook');
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\nif [ -f "${marker}" ]; then : > "${overlap}"; fi\n: > "${marker}"\nsleep 0.3\nrm -f "${marker}"\nexit 0\n`,
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      const results = await Promise.allSettled([
        gitCheckout(dir, 'feature'),
        gitCheckout(sub, 'origin/feature'),
      ]);

      expect(currentBranch(dir)).toBe('feature');
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value).toEqual({ branch: 'feature', detached: false });
        }
      }
      expect(fs.existsSync(overlap)).toBe(false);
    },
  );
});

describe('gitCheckout landing verification read failures (R11-2)', () => {
  it.skipIf(process.platform === 'win32')(
    'does not roll back a landed checkout when a verification read fails',
    async () => {
      // The checkout lands, the post-checkout hook fails, and the landing
      // verification's `rev-parse HEAD` then fails transiently (injected via
      // a git wrapper that trips only after the hook marks the repo). A
      // swallowed read used to compare as "HEAD is not on the target" and
      // roll back the landed switch; the tri-state verification must skip
      // the rollback and rethrow the hook error instead.
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'second');
      // Tag the FIRST commit so a rollback to master (now one commit ahead)
      // is distinguishable from the landed detached HEAD.
      git(dir, 'tag', 'v1.0', 'HEAD~1');
      const tagCommit = git(dir, 'rev-parse', 'v1.0').trim();
      const marker = path.join(dir, '.git', 'verify-marker');
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitwrap-'));
      tmpRoots.push(binDir);
      const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      fs.writeFileSync(
        path.join(binDir, 'git'),
        `#!/bin/sh\nif [ -f "${marker}" ] && [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then\n  exit 1\nfi\nexec "${realGit}" "$@"\n`,
      );
      fs.chmodSync(path.join(binDir, 'git'), 0o755);
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\n: > "${marker}"\nexit 1\n`,
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      await expect(
        gitCheckout(dir, 'v1.0', {
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        }),
      ).rejects.toThrow();

      // The landed switch survives: HEAD stays detached on the tag commit
      // instead of being rolled back to master.
      expect(headSha(dir)).toBe(tagCommit);
      expect(() => git(dir, 'symbolic-ref', 'HEAD')).toThrow();
    },
  );
});

describe('gitCheckout fully qualified refs (R6-19)', () => {
  it('lands on the branch, not a same-named tag, via refs/heads/', async () => {
    const dir = makeRepo();
    // Tag the initial commit, then advance the branch and create a
    // same-named branch: the qualified value must land on the branch.
    git(dir, 'tag', 'release');
    const tagCommit = headSha(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');
    git(dir, 'branch', 'release');

    const result = await gitCheckout(dir, 'refs/heads/release');

    expect(result).toEqual({ branch: 'release', detached: false });
    expect(headSha(dir)).not.toBe(tagCommit);
  });

  it('rejects a refs/heads/ value whose remainder is an option', async () => {
    const dir = makeRepo();
    await expect(gitCheckout(dir, 'refs/heads/-f')).rejects.toThrow(
      'invalid checkout ref',
    );
  });

  it('tracks the exact remote ref via refs/remotes/', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
    git(dir, 'fetch', '-q', 'origin');

    const result = await gitCheckout(dir, 'refs/remotes/origin/feature');

    expect(result).toEqual({ branch: 'feature', detached: false });
    expect(currentBranch(dir)).toBe('feature');
    const tracking = git(
      dir,
      'rev-parse',
      '--abbrev-ref',
      'feature@{u}',
    ).trim();
    expect(tracking).toBe('origin/feature');
  });

  it('lands on a slashed local branch whose name mirrors a remote-tracking ref', async () => {
    // A local branch literally named origin/develop is a legal ref, and the
    // pickers submit it as refs/heads/origin/develop. The remote-tracking
    // mirror must not reroute the checkout to the unrelated local `develop`.
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/develop');
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'branch', 'origin/develop');
    git(dir, 'branch', 'develop');

    const result = await gitCheckout(dir, 'refs/heads/origin/develop');

    expect(result).toEqual({ branch: 'origin/develop', detached: false });
    expect(currentBranch(dir)).toBe('origin/develop');
  });
});

describe('gitCheckout hook-masked failures and colliding landings (R8)', () => {
  function installFailingHook(dir: string, body: string): void {
    fs.writeFileSync(
      path.join(dir, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nrm -f "$0"\n${body}\nexit 1\n`,
    );
    fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
  }

  it
    .skipIf(process.platform === 'win32')
    .each(['git checkout -q elsewhere', 'git checkout -q --detach HEAD~1'])(
    'rolls back when a failing hook moved HEAD away via `%s`',
    async (hookCheckout) => {
      // The hook's own checkout leaves ITS reflog entry newest, masking
      // the step's entry from a newest-only scan; the rollback must still
      // fire on the step's entry among the post-snapshot entries.
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'second');
      git(dir, 'branch', 'target');
      git(dir, 'branch', 'elsewhere');
      installFailingHook(dir, hookCheckout);

      await expect(gitCheckout(dir, 'target')).rejects.toThrow();
      expect(currentBranch(dir)).toBe('master');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'absorbs a hook failure that detached HEAD onto a colliding branch tip',
    async () => {
      // Branch `release` and tag `release` differ. The hook detaches HEAD onto
      // the BRANCH tip after the switch landed; the landing check must resolve
      // the target through refs/heads/ (a bare rev-parse prefers the tag) and
      // absorb the detached landing instead of rolling back a correct switch.
      const dir = makeRepo();
      git(dir, 'tag', 'release');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'second');
      git(dir, 'branch', 'release');
      const branchTip = headSha(dir);
      installFailingHook(dir, 'git checkout -q --detach refs/heads/release');

      const result = await gitCheckout(dir, 'release');

      expect(result.detached).toBe(true);
      expect(headSha(dir)).toBe(branchTip);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'restores a detached HEAD when a failing hook moves it away',
    async () => {
      // The rollback's detached arm must restore the captured commit when the
      // original HEAD was detached and a failing hook moved HEAD elsewhere.
      const dir = makeRepo();
      git(dir, 'branch', 'target');
      const detachedAt = headSha(dir);
      git(dir, 'checkout', '-q', '--detach', 'HEAD');
      installFailingHook(dir, 'git checkout -q master');

      await expect(gitCheckout(dir, 'target')).rejects.toThrow();

      expect(() => git(dir, 'symbolic-ref', 'HEAD')).toThrow();
      expect(headSha(dir)).toBe(detachedAt);
    },
  );

  it('rejects a checkout that git fatally refuses on an unborn HEAD', async () => {
    // Zero-commit repo: `git checkout main` fails with `invalid reference`,
    // but symbolic-ref still reports `main` — the branch-equality absorption
    // must not turn the fatal refusal into a success.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranches-'));
    tmpRoots.push(dir);
    git(dir, 'init', '-q', '-b', 'main');

    await expect(gitCheckout(dir, 'main')).rejects.toThrow();
    expect(git(dir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
  });

  it.skipIf(process.platform === 'win32')(
    'absorbs a hook failure that bornes an unborn HEAD onto the same branch name',
    async () => {
      // A `--track` checkout of origin/master on a fresh repo genuinely
      // creates refs/heads/master and attaches HEAD — an unborn→born move.
      // The born name equals the unborn HEAD's branch name, so branch
      // equality alone cannot tell the landed switch from a fatal refusal;
      // only HEAD now resolving a commit proves it. Without absorption the
      // rollback re-runs the failing hook and gitCheckout throws even though
      // HEAD sits exactly where requested.
      const donor = makeRepo();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranches-'));
      tmpRoots.push(dir);
      git(dir, 'init', '-q', '-b', 'master');
      git(dir, 'remote', 'add', 'origin', donor);
      git(dir, 'fetch', '-q', 'origin');
      const donorSha = headSha(donor);
      fs.writeFileSync(
        path.join(dir, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\nexit 1\n',
      );
      fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);

      const result = await gitCheckout(dir, 'origin/master');

      expect(result).toEqual({ branch: 'master', detached: false });
      expect(headSha(dir)).toBe(donorSha);
    },
  );

  it('rejects a refs/heads/ checkout whose branch no longer exists', async () => {
    // Without the existence check the bare fall-through DWIMs onto the
    // same-named tag and silently detaches HEAD.
    const dir = makeRepo();
    git(dir, 'tag', 'gone');

    await expect(gitCheckout(dir, 'refs/heads/gone')).rejects.toThrow(
      'branch not found: gone',
    );
    expect(currentBranch(dir)).toBe('master');
  });
});

describe('gitCreateBranch rollback under colliding refs (R8)', () => {
  it.skipIf(process.platform === 'win32')(
    'rolls back a half-created branch that collides with a tag',
    async () => {
      // HEAD's branch name comes from the full symbolic ref: with a same-named
      // tag, `symbolic-ref --short` reports the ambiguous `heads/topic` form
      // and the stranded-HEAD comparison never matches, skipping the rollback.
      const dir = makeRepo();
      git(dir, 'tag', 'topic');
      const before = currentBranch(dir);
      const hookDir = path.join(dir, '.git', 'hooks');
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, 'post-checkout'),
        '#!/bin/sh\nexit 1\n',
        { mode: 0o755 },
      );

      await expect(gitCreateBranch(dir, 'topic')).rejects.toThrow();

      expect(currentBranch(dir)).toBe(before);
      let branchStillExists = true;
      try {
        git(dir, 'show-ref', '--verify', '--quiet', 'refs/heads/topic');
      } catch {
        branchStillExists = false;
      }
      expect(branchStillExists).toBe(false);
      // The colliding tag survives the rollback.
      expect(git(dir, 'tag', '--list', 'topic').trim()).toBe('topic');
    },
  );
});

describe('getDefaultBranch (R10 #3)', () => {
  it('returns the fully-qualified remote ref so log ranges stay correct', async () => {
    const dir = makeRepo();
    const branch = currentBranch(dir);
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD');
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'remote', 'set-head', 'origin', branch);

    const result = await getDefaultBranch(dir);

    expect(result).toBe(`origin/${branch}`);
  });

  it('returns null when origin/HEAD is not set', async () => {
    const dir = makeRepo();
    expect(await getDefaultBranch(dir)).toBeNull();
  });
});

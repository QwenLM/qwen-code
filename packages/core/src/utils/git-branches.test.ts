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
  it('rolls back a branch created before a failing post-checkout hook', async () => {
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
  });
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
  it('restores the original index when the commit fails after add -A', async () => {
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
  });

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

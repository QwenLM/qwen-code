/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

// Ambient git config must not reach the fixtures or the git invocations
// of the code under test through any channel this file controls: point
// HOME and the XDG config home at an empty directory for this file's
// lifetime, GIT_CONFIG_GLOBAL/SYSTEM at an empty file for the fixture
// helper (which does not go through gitEnv()), and clear the env-injected
// config channels plus the repo selectors the fixture helper would
// otherwise inherit. The host's compiled-in system config (/etc/gitconfig)
// stays reachable for the code under test because gitEnv() strips the very
// variables that would redirect it; the divergent-merge tests below are
// gated on its absence.
const hermeticHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-githome-'));
// Platform-neutral interactive-rebase sequence editor for the rebase
// fixtures: rewrites the first todo command to `edit` so the rebase stops.
// `sed -i` without a backup extension is GNU-only and fails under BSD sed
// (stock macOS), while node is already guaranteed everywhere these tests
// run.
const seqEditorScript = path.join(hermeticHome, 'seq-editor.js');
const savedAmbientGitEnv: Record<string, string | undefined> = {};
const GIT_ENV_VARS_TO_CLEAR = [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  // Editor overrides resolve env-first, ahead of the repo-local
  // sequence.editor the rebase fixtures depend on.
  'GIT_SEQUENCE_EDITOR',
  'GIT_EDITOR',
];
const GIT_ENV_PREFIXES_TO_CLEAR = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];
beforeAll(() => {
  fs.writeFileSync(path.join(hermeticHome, 'gitconfig'), '');
  fs.writeFileSync(
    seqEditorScript,
    "const fs = require('node:fs');\n" +
      'const todo = process.argv[2];\n' +
      "fs.writeFileSync(todo, fs.readFileSync(todo, 'utf8').replace(/^pick/, 'edit'));\n",
  );
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    ...GIT_ENV_VARS_TO_CLEAR,
  ]) {
    savedAmbientGitEnv[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) {
    if (GIT_ENV_PREFIXES_TO_CLEAR.some((prefix) => key.startsWith(prefix))) {
      savedAmbientGitEnv[key] = process.env[key];
    }
  }
  for (const key of Object.keys(savedAmbientGitEnv)) {
    delete process.env[key];
  }
  process.env['HOME'] = hermeticHome;
  process.env['USERPROFILE'] = hermeticHome;
  process.env['XDG_CONFIG_HOME'] = hermeticHome;
  process.env['GIT_CONFIG_GLOBAL'] = path.join(hermeticHome, 'gitconfig');
  process.env['GIT_CONFIG_SYSTEM'] = path.join(hermeticHome, 'gitconfig');
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedAmbientGitEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(hermeticHome, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// A system-wide git config (e.g. `[merge] ff = only`) changes how the
// divergent-merge pulls below behave; gitEnv() strips the redirect
// variables, so detect the host's compiled-in system file the way the
// code under test sees it.
function hostHasSystemGitConfig(): boolean {
  try {
    execFileSync('git', ['config', '--system', '--list'], {
      encoding: 'utf8',
      env: gitEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
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

function makeClone(remote: string): string {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
  tmpRoots.push(clone);
  git(clone, 'clone', '-q', remote, '.');
  git(clone, 'config', 'user.email', 'other@example.com');
  git(clone, 'config', 'user.name', 'Other');
  git(clone, 'config', 'commit.gpgsign', 'false');
  return clone;
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
    const clone = makeClone(remote);
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

    const clone = makeClone(remote);
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

    const clone = makeClone(remote);
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

  it('stash pull updates a dirty tree and restores the local changes', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked\n');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(fs.existsSync(path.join(dir, 'scratch.txt'))).toBe(true);
    expect(result.stashRestoreConflict).toBeUndefined();
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('stash pull behaves like a plain pull when the tree is clean', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('stash pull reports a conflicting restore and keeps the stash entry', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote edit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(result.output).toContain('CONFLICT');
    expect(result.stashRestoreConflict).toBe(true);
    expect(git(dir, 'ls-files', '--unmerged').trim()).not.toBe('');
    const stashes = git(dir, 'stash', 'list', '--oneline')
      .trim()
      .split('\n')
      .filter((line) => line !== '');
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toContain('auto-stash before pull');
  });

  it('stash pull flags a failed restore that leaves no unmerged entries', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    // The incoming commit adds a tracked file with the same name as the
    // user's untracked file: the pull succeeds, but the stash pop aborts
    // with "already exists, no checkout" and keeps the entry, leaving no
    // unmerged index entries behind.
    fs.writeFileSync(path.join(clone, 'notes.txt'), 'incoming\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'add notes');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'notes.txt'), 'local notes\n');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(result.stashRestoreConflict).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe(
      'incoming\n',
    );
    expect(git(dir, 'stash', 'list', '--oneline')).toContain(
      'auto-stash before pull',
    );
  });

  it('restores the dirty state when a stash pull fails', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    // No -u: the pull fails with "no tracking information".
    git(dir, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toThrow();

    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('force pull discards local changes and updates', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'local.env\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore local.env');
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked\n');
    fs.writeFileSync(path.join(dir, 'local.env'), 'secret\n');

    const result = await gitPull(dir, { force: true });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(dir, 'scratch.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'local.env'))).toBe(true);
  });

  it('rejects combining stash and force', async () => {
    const dir = makeRepo();

    await expect(gitPull(dir, { stash: true, force: true })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it('a conflicting stash pull aborts the partial merge and restores the dirty state', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // A divergent local commit touching the same file: the post-stash pull
    // merge-conflicts and leaves MERGE_HEAD unless the recovery aborts it.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

    // The merge conflicts on committed content the stash cannot influence,
    // so the failure is classified as the terminal diverged state rather
    // than a panel-recoverable dirty tree.
    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'diverged',
    });

    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'dirty edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
    expect(() =>
      git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
    ).toThrow();
    // The recovery must abort the merge, not reset to the upstream tip:
    // HEAD and the divergent local content survive.
    expect(headSha(dir)).toBe(headBefore);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local version\n',
    );
  });

  it('restores the dirty state when a rebasing stash pull conflicts', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // A divergent local commit touching the same file: the post-stash rebase
    // conflicts and leaves rebase state unless the recovery aborts it.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

    await expect(gitPull(dir, { stash: true, rebase: true })).rejects.toThrow();

    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'dirty edit\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local version\n',
    );
    expect(headSha(dir)).toBe(headBefore);
    expect(git(dir, 'stash', 'list').trim()).toBe('');
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-apply'))).toBe(false);
  });

  it('force pull refuses a diverged branch before discarding anything', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

    await expect(gitPull(dir, { force: true })).rejects.toThrow(/diverged/);

    // Nothing was discarded and no merge was started.
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'dirty edit\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local version\n',
    );
    expect(headSha(dir)).toBe(headBefore);
    expect(() =>
      git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
    ).toThrow();
  });

  it('force pull refuses a missing upstream before discarding anything', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    // No -u: the branch has no upstream.
    git(dir, 'push', '-q', 'origin', 'HEAD');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

    await expect(gitPull(dir, { force: true })).rejects.toThrow(/no upstream/);

    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'dirty edit\n',
    );
  });

  it('force pull from a repository subdirectory refuses without discarding', async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'ws'));
    fs.writeFileSync(path.join(dir, 'ws', 'w.txt'), 'ws v1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add ws');

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // Dirty tracked edits inside AND outside the workspace subdirectory.
    fs.writeFileSync(path.join(dir, 'ws', 'w.txt'), 'ws local edit\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'root local edit\n');

    await expect(
      gitPull(path.join(dir, 'ws'), { force: true }),
    ).rejects.toThrow(/subdirectory/);

    expect(fs.readFileSync(path.join(dir, 'ws', 'w.txt'), 'utf8')).toBe(
      'ws local edit\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'root local edit\n',
    );
  });

  it('stash pull leaves an unrelated pre-existing stash entry untouched', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // A user stash created earlier; the tree is clean again.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'stashed work\n');
    git(dir, 'stash', 'push', '-q', '-m', 'user stash');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    // Nothing was stashed, so nothing may be popped: the unrelated entry
    // must stay in the list and out of the working tree.
    const stashes = git(dir, 'stash', 'list', '--oneline').trim().split('\n');
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toContain('user stash');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
  });
});

// Gated: a host system config such as `[merge] ff = only` fatals these
// merges before the merge defaults the update pins (--no-edit
// --no-autostash) apply.
describe.runIf(!hostHasSystemGitConfig())(
  'gitPull divergent-branch merges',
  () => {
    it('merge pull reconciles divergent branches when no pull policy is configured', async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      // A divergent local commit; with pull.rebase/pull.ff unset a bare
      // `git pull` here fatals with "Need to specify how to reconcile
      // divergent branches" unless the merge default is pinned explicitly.
      fs.writeFileSync(path.join(dir, 'local-only.txt'), 'local\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'local commit');

      const result = await gitPull(dir);

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'local-only.txt'))).toBe(true);
      expect(git(dir, 'log', '--merges', '--oneline').trim()).not.toBe('');
    });

    it('stash pull merges divergent branches and restores the local changes', async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'local-only.txt'), 'local\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'local commit');
      const headBefore = headSha(dir);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const result = await gitPull(dir, { stash: true });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
      // The divergent local commit must survive the merge: a destructive
      // reset to the upstream tip would drop it and its file.
      expect(() =>
        git(dir, 'merge-base', '--is-ancestor', headBefore, 'HEAD'),
      ).not.toThrow();
      expect(fs.existsSync(path.join(dir, 'local-only.txt'))).toBe(true);
      expect(git(dir, 'log', '--merges', '--oneline').trim()).not.toBe('');
    });
  },
);

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

describe('gitPull state guards', () => {
  function makeDivergedPairOn(dir: string, remote: string): void {
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');
  }

  it('refuses to pull while a merge is already in progress', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    makeDivergedPairOn(dir, remote);
    git(dir, 'fetch', '-q', 'origin');
    let mergeFailed = false;
    try {
      git(dir, 'merge', 'origin/master');
    } catch {
      mergeFailed = true;
    }
    expect(mergeFailed).toBe(true);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'uncommitted edit\n');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'merge_in_progress',
      });
    }

    // The refusal precedes any action: the merge state and the edit are
    // untouched and nothing was stashed.
    expect(() =>
      git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'uncommitted edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a stash pull while a rebase is in progress, keeping the rebase and the edits', async () => {
    const dir = makeRepo();
    for (const [file, content] of [
      ['b.txt', 'two\n'],
      ['c.txt', 'three\n'],
    ] as const) {
      fs.writeFileSync(path.join(dir, file), content);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `add ${file}`);
    }
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Stop the interactive rebase after the first commit (an edit/break
    // stop carries no unmerged entries, so `stash push` would succeed and
    // the old failure recovery aborted the user's rebase).
    git(dir, 'config', 'sequence.editor', `node "${seqEditorScript}"`);
    git(dir, 'rebase', '-i', 'HEAD~2');
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(true);
    const headAtStop = headSha(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'uncommitted edit\n');
    fs.writeFileSync(path.join(dir, 'u.txt'), 'untracked edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'rebase_in_progress',
    });

    // The pre-existing rebase survives: its state dir is intact, HEAD is
    // still at the stop, both edits are in the worktree, and nothing was
    // moved into the auto-stash.
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(true);
    expect(headSha(dir)).toBe(headAtStop);
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'uncommitted edit\n',
    );
    expect(fs.readFileSync(path.join(dir, 'u.txt'), 'utf8')).toBe(
      'untracked edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('classifies a stash push refused by unmerged entries', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Leave unmerged index entries without MERGE_HEAD: a conflicting
    // cherry-pick. `stash push` refuses them ("needs merge"); the failure
    // must surface the structured unmerged state instead of the raw,
    // locale-dependent git error.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'to pick\n');
    git(dir, 'commit', '-q', '-am', 'to pick');
    const pick = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'cherry-pick', pick)).toThrow();

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'dirty_working_tree',
      unmerged: true,
    });

    // The refusal precedes any action: the conflicted content stays and
    // nothing was stashed.
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toContain(
      '<<<<<<<',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it.runIf(!hostHasSystemGitConfig())(
    'classifies a plain pull that conflicts mid-merge as merge_in_progress',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'c.txt'), 'shared\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add c.txt');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
      makeDivergedPairOn(dir, remote);
      // Dirty a file the merge does not touch, so the pull starts the merge
      // (conflicting on the committed content) instead of refusing on dirt.
      fs.writeFileSync(path.join(dir, 'c.txt'), 'dirty edit\n');

      await expect(gitPull(dir)).rejects.toMatchObject({
        code: 'merge_in_progress',
      });

      // The failed pull leaves MERGE_HEAD behind; the classification says
      // terminal instead of offering panel actions that all fail on it.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).not.toThrow();
      expect(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8')).toBe(
        'dirty edit\n',
      );
    },
  );

  it('refuses a stash pull when incoming changes would overwrite a local ignored file', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore config.json');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
    fs.writeFileSync(path.join(clone, 'config.json'), 'incoming\n');
    git(clone, 'add', '.');
    // The clone shares the .gitignore, so the new path needs a force-add.
    git(clone, 'add', '-f', 'config.json');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    // The refusal precedes any action: nothing was stashed or overwritten.
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a force pull when incoming changes would overwrite a local ignored file', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore config.json');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'config.json'), 'incoming\n');
    git(clone, 'add', '-f', 'config.json');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');

    await expect(gitPull(dir, { force: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    // The "ignored files are kept" guarantee holds even against the
    // destructive option.
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
  });
});

describe('gitPull incoming-tip guards', () => {
  function installGitShim(script: string): string {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitshim-'));
    tmpRoots.push(shimDir);
    fs.writeFileSync(path.join(shimDir, 'git'), script, { mode: 0o755 });
    return shimDir;
  }

  function withPathPrefix<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env['PATH'] ?? '';
    process.env['PATH'] = `${dir}${path.delimiter}${saved}`;
    return fn().finally(() => {
      process.env['PATH'] = saved;
    });
  }

  it('refuses a stash pull when an incoming rename lands on a local ignored file', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
    fs.writeFileSync(path.join(dir, 'source.txt'), 'tracked source\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore config.json');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // The rename destination collides with the local ignored file; with
    // rename detection the path arrives as R100, not as an addition.
    const clone = makeClone(remote);
    git(clone, 'mv', 'source.txt', 'config.json');
    git(clone, 'commit', '-q', '-m', 'rename onto the ignored path');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a force pull when an incoming non-ASCII path collides with a local ignored file', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'caf\u00e9.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore the non-ascii path');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'caf\u00e9.json'), 'incoming\n');
    git(clone, 'add', '-f', 'caf\u00e9.json');
    git(clone, 'commit', '-q', '-m', 'add the non-ascii path');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'caf\u00e9.json'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { force: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'caf\u00e9.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
  });

  it('does not refuse a safe pull when local commits deleted a file matching an ignore pattern', async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'app.log'), 'log data\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add logs');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Local-only commits: ignore *.log and delete the tracked log file.
    // ahead>0/behind=0 — the update merges nothing, but a HEAD..@{u} probe
    // would see the deletion as an incoming addition and refuse the pull
    // naming a file that does not exist locally.
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore logs');
    git(dir, 'rm', '-q', 'logs/app.log');
    git(dir, 'commit', '-q', '-m', 'delete the log');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('does not refuse a pull when the colliding ignored path does not exist locally', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore config.json');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // A teammate adds a file matching the local ignore pattern; no such
    // file exists locally, so the merge checks it out cleanly. Refusing
    // would name a file the user cannot move or remove.
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'config.json'), 'incoming\n');
    git(clone, 'add', '-f', 'config.json');
    git(clone, 'commit', '-q', '-m', 'add config.json');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
      'incoming\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a stash pull from a subdirectory workspace when an incoming path collides with an ignored file', async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'sub/config.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore sub/config.json');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.mkdirSync(path.join(clone, 'sub'));
    fs.writeFileSync(path.join(clone, 'sub', 'config.json'), 'incoming\n');
    git(clone, 'add', '-f', 'sub/config.json');
    git(clone, 'commit', '-q', '-m', 'add sub/config.json');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'sub', 'config.json'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(
      gitPull(path.join(dir, 'sub'), { stash: true }),
    ).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'sub', 'config.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a plain pull when incoming changes would overwrite a local ignored file', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore config.json');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
    fs.writeFileSync(path.join(clone, 'config.json'), 'incoming\n');
    git(clone, 'add', '.');
    git(clone, 'add', '-f', 'config.json');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // The tree reads clean: ignored files never appear in `git status`.
    fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');

    await expect(gitPull(dir)).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses a dirty pull instead of auto-stashing under ambient autostash config', async () => {
    const dir = makeRepo();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'a.txt'), `${lines.join('\n')}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'extend a.txt');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // The incoming commit touches the same file as the local dirty edit (in
    // a separate hunk), so without --no-autostash the ambient autostash
    // config would silently stash, merge, and pop around the refusal.
    const clone = makeClone(remote);
    const remoteContent = fs
      .readFileSync(path.join(clone, 'a.txt'), 'utf8')
      .replace('line 10', 'line 10 remote');
    fs.writeFileSync(path.join(clone, 'a.txt'), remoteContent);
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote edit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    const localContent = fs
      .readFileSync(path.join(dir, 'a.txt'), 'utf8')
      .replace('line 1\n', 'line 1 local\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), localContent);

    // Ambient user config enables git's implicit stash-then-restore; the
    // update must still refuse the dirty tree loudly instead of exiting 0
    // with the changes stranded in an autostash entry. $HOME/.gitconfig is
    // the channel gitEnv() keeps: GIT_CONFIG_GLOBAL/SYSTEM are stripped.
    const userGitconfig = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(
      userGitconfig,
      '[merge]\n\tautostash = true\n[rebase]\n\tautostash = true\n',
    );
    try {
      for (const opts of [{}, { rebase: true }] as const) {
        await expect(gitPull(dir, opts)).rejects.toMatchObject({
          code: 'dirty_working_tree',
        });
        expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
          localContent,
        );
        expect(git(dir, 'stash', 'list').trim()).toBe('');
      }
    } finally {
      fs.rmSync(userGitconfig, { force: true });
    }
  });

  // The POSIX shim below stands in for a concurrent actor pushing into the
  // probe->merge window; it has no Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'merges exactly the probed tip when a racing commit lands mid-pull',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore config.json');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      // The racer clone holds a colliding commit that is pushed while
      // the pull is in flight — after the collision probe has already run.
      const racer = makeClone(remote);
      fs.writeFileSync(path.join(racer, 'config.json'), 'racing\n');
      git(racer, 'add', '-f', 'config.json');
      git(racer, 'commit', '-q', '-m', 'racing commit');
      const racerSha = headSha(racer);

      fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `case "$1" in\n` +
          `pull|merge)\n` +
          `  "${realGit}" -C "${racer}" push -q origin HEAD\n` +
          `  ;;\n` +
          `esac\n` +
          `exec "${realGit}" "$@"\n`,
      );
      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      expect(result.success).toBe(true);
      // The racing commit never entered the probed tip, so it must not be
      // merged, and the ignored file it collides with survives.
      expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
        'local secret\n',
      );
      expect(() =>
        git(dir, 'merge-base', '--is-ancestor', racerSha, 'HEAD'),
      ).toThrow();
      expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'remote edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32' && !hostHasSystemGitConfig())(
    'serializes concurrent stash pulls so auto-stashes are not cross-applied',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'f1.txt'), 'committed\n');
      fs.writeFileSync(path.join(dir, 'f2.txt'), 'committed\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add f1 and f2');
      fs.writeFileSync(path.join(dir, 'f1.txt'), 'A edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'overlap-marker');
      const f2 = path.join(dir, 'f2.txt');
      // Simulate a second session dirtying f2 while the first pull is in
      // flight, and stretch the update step so the two pulls overlap.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `case "$1" in\n` +
          `pull|merge)\n` +
          `  if [ ! -e "${marker}" ]; then\n` +
          `    : > "${marker}"\n` +
          `    printf 'B edit\\n' > "${f2}"\n` +
          `  fi\n` +
          `  sleep 0.8\n` +
          `  ;;\n` +
          `esac\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const read = (p: string) => fs.readFileSync(p, 'utf8');
      let seenByA: { f1: string; f2: string } | undefined;
      let seenByB: { f1: string; f2: string } | undefined;
      await withPathPrefix(shimDir, async () => {
        const pullA = gitPull(dir, { stash: true }).then((result) => {
          expect(result.success).toBe(true);
          seenByA = { f1: read(path.join(dir, 'f1.txt')), f2: read(f2) };
        });
        const pullB = new Promise((resolve) => setTimeout(resolve, 400)).then(
          () =>
            gitPull(dir, { stash: true }).then((result) => {
              expect(result.success).toBe(true);
              seenByB = { f1: read(path.join(dir, 'f1.txt')), f2: read(f2) };
            }),
        );
        await Promise.all([pullA, pullB]);
      });

      // Each pull restored its own stashed edit before it resolved.
      expect(seenByA?.f1).toBe('A edit\n');
      expect(seenByB?.f1).toBe('A edit\n');
      expect(seenByB?.f2).toBe('B edit\n');
      expect(fs.readFileSync(path.join(dir, 'f1.txt'), 'utf8')).toBe(
        'A edit\n',
      );
      expect(fs.readFileSync(path.join(dir, 'f2.txt'), 'utf8')).toBe(
        'B edit\n',
      );
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  // The POSIX shims below stand in for concurrent actors creating state
  // inside the pull's check-then-use windows; they have no Windows
  // equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'serializes concurrent stash pulls addressed through different cwds of one repository',
    async () => {
      const dir = makeRepo();
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 's.txt'), 'sub\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add sub');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'f1.txt'), 'committed\n');
      fs.writeFileSync(path.join(dir, 'f2.txt'), 'committed\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add f1 and f2');
      fs.writeFileSync(path.join(dir, 'f1.txt'), 'A edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'overlap-marker');
      const f2 = path.join(dir, 'f2.txt');
      // Simulate a second session dirtying f2 while the first pull is in
      // flight, and stretch the update step so the two pulls overlap.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `case "$1" in\n` +
          `pull|merge)\n` +
          `  if [ ! -e "${marker}" ]; then\n` +
          `    : > "${marker}"\n` +
          `    printf 'B edit\\n' > "${f2}"\n` +
          `  fi\n` +
          `  sleep 0.8\n` +
          `  ;;\n` +
          `esac\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const read = (p: string) => fs.readFileSync(p, 'utf8');
      let seenByA: { f1: string; f2: string } | undefined;
      let seenByB: { f1: string; f2: string } | undefined;
      await withPathPrefix(shimDir, async () => {
        const pullA = gitPull(dir, { stash: true }).then((result) => {
          expect(result.success).toBe(true);
          seenByA = { f1: read(path.join(dir, 'f1.txt')), f2: read(f2) };
        });
        // The second pull addresses the same repository through a
        // subdirectory cwd; the shared refs/stash LIFO means the two must
        // still serialize.
        const pullB = new Promise((resolve) => setTimeout(resolve, 400)).then(
          () =>
            gitPull(path.join(dir, 'sub'), { stash: true }).then((result) => {
              expect(result.success).toBe(true);
              seenByB = { f1: read(path.join(dir, 'f1.txt')), f2: read(f2) };
            }),
        );
        await Promise.all([pullA, pullB]);
      });

      // Each pull restored its own stashed edit before it resolved.
      expect(seenByA?.f1).toBe('A edit\n');
      expect(seenByB?.f1).toBe('A edit\n');
      expect(seenByB?.f2).toBe('B edit\n');
      expect(fs.readFileSync(path.join(dir, 'f1.txt'), 'utf8')).toBe(
        'A edit\n',
      );
      expect(fs.readFileSync(path.join(dir, 'f2.txt'), 'utf8')).toBe(
        'B edit\n',
      );
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses stash and force pulls when merge state appears during the fetch window',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      // A concurrent actor concludes a merge resolution while the pull is
      // fetching: MERGE_HEAD appears after the pull's pre-fetch guard ran.
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "fetch" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  status=$?\n` +
          `  "${realGit}" rev-parse HEAD > "$("${realGit}" rev-parse --git-dir)/MERGE_HEAD"\n` +
          `  exit $status\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      for (const opts of [{ stash: true }, { force: true }] as const) {
        await withPathPrefix(shimDir, () =>
          expect(gitPull(dir, opts)).rejects.toMatchObject({
            code: 'merge_in_progress',
          }),
        );
        // Remove the planted state so the next shape exercises the window
        // guard again instead of the pre-fetch guard.
        fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
      }

      // The refusal precedes any stash/discard action: the edit survives
      // both shapes and nothing was stashed.
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'restores the auto-stash and refuses when merge state appears before the update',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      // A concurrent actor's merge concludes after the auto-stash was
      // created but before the update runs.
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  status=$?\n` +
          `  "${realGit}" rev-parse HEAD > "$("${realGit}" rev-parse --git-dir)/MERGE_HEAD"\n` +
          `  exit $status\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'merge_in_progress',
        }),
      );

      // The auto-stash is popped back and the foreign merge state is
      // untouched — the recovery must not abort state it did not start.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).not.toThrow();
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses the pull when the collision probe itself fails',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore config.json');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'config.json'), 'incoming\n');
      git(clone, 'add', '-f', 'config.json');
      git(clone, 'commit', '-q', '-m', 'add config.json');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      // A probe failure (here: check-ignore exiting 128) must not read as
      // "no collision" and let the overwriting merge through.
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "check-ignore" ]; then\n` +
          `  exit 128\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'dirty_working_tree',
        }),
      );

      expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
        'local secret\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'pops back an auto-stash entry left behind by a failed stash push',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      // Simulate a push that fails after refs/stash was updated (git
      // creates the commit and updates the ref before resetting the
      // worktree): the entry exists while git reports failure.
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  exit 1\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'dirty_working_tree',
        }),
      );

      // The stranded entry is popped back: the edit is restored and
      // nothing lingers in refs/stash.
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'reports the kept auto-stash when the failure-recovery restore fails',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      // Divergent local commit touching the same file: the post-stash pull
      // merge-conflicts, and the recovery's restore pop fails below.
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'local commit');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "pop" ]; then\n` +
          `  exit 1\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      let thrown: unknown;
      await withPathPrefix(shimDir, () => gitPull(dir, { stash: true })).catch(
        (err) => {
          thrown = err;
        },
      );

      expect(thrown).toMatchObject({ code: 'diverged' });
      // The failure names where the unrestored changes are kept; without
      // the pointer the edits sit in refs/stash invisibly.
      expect((thrown as Error).message).toContain('git stash list');
      expect(git(dir, 'stash', 'list', '--oneline')).toContain(
        'auto-stash before pull',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local version\n',
      );
      expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
    },
  );
});

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
  STASH_RESTORE_NOTE,
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
  // Pin line endings repo-locally (like the gpgsign pin above):
  // gitEnv() strips GIT_CONFIG_GLOBAL/SYSTEM for the product’s git, so
  // a host config — the Windows runners’ system core.autocrlf=true —
  // reaches the product’s git but not the fixture channel, and the
  // repo-local pin outranks the host config on both channels.
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.eol', 'lf');
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
  git(clone, 'config', 'core.autocrlf', 'false');
  git(clone, 'config', 'core.eol', 'lf');
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

  it('aborts the rebase a conflicting tag-upstream pull started', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Upstream publishes a conflicting commit as an ANNOTATED tag and only
    // the tag is fetched: @{u} resolves to the tag object while the rebase
    // state's `onto` file holds the peeled commit, so the recovery's
    // identity comparison must peel the fetched tip.
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'tag', '-a', 'v1', '-m', 'release v1');
    git(clone, 'push', '-q', 'origin', 'v1');

    git(
      dir,
      'config',
      '--add',
      'remote.origin.fetch',
      '+refs/tags/v1:refs/remotes/origin/v1',
    );
    git(dir, 'config', 'branch.master.merge', 'refs/tags/v1');
    git(dir, 'fetch', '-q', 'origin');

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

  it('keeps a plain pull on a diverged dirty tree panel-recoverable', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // Divergent local commit plus a dirty edit: the branch has diverged,
    // but the stash option can still save this shape when the local
    // commits do not conflict, so a plain pull stays panel-recoverable
    // instead of the terminal diverged code.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty edit\n');

    await expect(gitPull(dir)).rejects.toMatchObject({
      code: 'dirty_working_tree',
    });

    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'dirty edit\n',
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
    git(clone, 'config', 'core.autocrlf', 'false');
    git(clone, 'config', 'core.eol', 'lf');
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
    git(clone, 'config', 'core.autocrlf', 'false');
    git(clone, 'config', 'core.eol', 'lf');
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

  it('refuses every pull shape while a git am session is stopped, keeping it', async () => {
    const dir = makeRepo();
    // A patch that conflicts with the local history: `git am` stops and
    // leaves .git/rebase-apply — the same directory a rebase uses, but
    // without the `onto` file a rebase writes. A stopped am carries no
    // MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD either, yet the staged
    // resolution work the user prepares for `am --continue` is just as
    // unrecoverable-by-reflog as a cherry-pick's — so the guard covers
    // it instead of letting the stash/discard steps destroy it.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'patched line\n');
    git(dir, 'commit', '-q', '-am', 'patch source');
    const patch = git(dir, 'format-patch', '-1', '--stdout');
    fs.writeFileSync(path.join(dir, '.git', 'conflict.patch'), patch);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local line\n');
    git(dir, 'commit', '-q', '-am', 'local change');
    expect(() =>
      git(dir, 'am', path.join(dir, '.git', 'conflict.patch')),
    ).toThrow();
    expect(
      fs.existsSync(path.join(dir, '.git', 'rebase-apply', 'applying')),
    ).toBe(true);

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'rebase_in_progress',
      });
      // The am session survives every refusal: the guard precedes any
      // stash/discard action.
      expect(
        fs.existsSync(path.join(dir, '.git', 'rebase-apply', 'applying')),
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(false);
    expect(git(dir, 'stash', 'list').trim()).toBe('');
    // The state is still abortable as am, not rebase.
    git(dir, 'am', '--abort');
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-apply'))).toBe(false);
  });

  it('refuses a force pull while a stopped am holds a staged resolution', async () => {
    const dir = makeRepo();
    // A stopped am WITH unmerged entries: the user resolved the patch
    // conflict and staged the resolution for `am --continue`. That
    // staged blob is unrecoverable by reflog — the exact loss the
    // cherry-pick/revert arm of the guard exists to prevent, and the
    // discard's `reset --hard` destroys it.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'patched line\n');
    git(dir, 'commit', '-q', '-am', 'patch source');
    const patch = git(dir, 'format-patch', '-1', '--stdout');
    fs.writeFileSync(path.join(dir, '.git', 'conflict.patch'), patch);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local line\n');
    git(dir, 'commit', '-q', '-am', 'local change');
    expect(() =>
      git(dir, 'am', '--3way', path.join(dir, '.git', 'conflict.patch')),
    ).toThrow();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved line\n');
    git(dir, 'add', 'a.txt');

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // An unmerged tree leaves the panel Discard as the only recovery; it
    // must refuse instead of resetting the staged resolution away.
    await expect(gitPull(dir, { force: true })).rejects.toMatchObject({
      code: 'rebase_in_progress',
    });

    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'resolved line\n',
    );
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');
    expect(
      fs.existsSync(path.join(dir, '.git', 'rebase-apply', 'applying')),
    ).toBe(true);
  });

  it('refuses a stash pull while a cherry-pick is conflicted', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // A conflicting cherry-pick leaves unmerged entries plus
    // CHERRY_PICK_HEAD; the foreign-state guard refuses before the stash
    // branch, because discard would leave CHERRY_PICK_HEAD dangling into
    // the pull's own merge.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'to pick\n');
    git(dir, 'commit', '-q', '-am', 'to pick');
    const pick = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'cherry-pick', pick)).toThrow();

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'merge_in_progress',
    });

    // The refusal precedes any action: the conflicted content stays and
    // nothing was stashed.
    expect(() =>
      git(dir, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'),
    ).not.toThrow();
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

  it('refuses every pull shape when an incoming file lands on an ignored directory', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore dist');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'dist'), 'incoming file\n');
    git(clone, 'add', '-f', 'dist');
    git(clone, 'commit', '-q', '-m', 'add dist as a file');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // A local ignored DIRECTORY where the incoming addition wants a file:
    // the merge would silently replace the directory and its contents.
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'secret.txt'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'ignored_collision',
      });
      expect(
        fs.readFileSync(path.join(dir, 'dist', 'secret.txt'), 'utf8'),
      ).toBe('local secret\n');
    }
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a pull when an incoming file lands on an ignored symlink',
    async () => {
      const dir = makeRepo();
      fs.mkdirSync(path.join(dir, 'target'));
      fs.writeFileSync(path.join(dir, 'target', 't.txt'), 'tracked\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'link\nlinkdir\n');
      fs.symlinkSync('/nonexistent', path.join(dir, 'link'));
      fs.symlinkSync('target', path.join(dir, 'linkdir'));
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore the symlinks');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'link'), 'incoming\n');
      fs.writeFileSync(path.join(clone, 'linkdir'), 'incoming\n');
      git(clone, 'add', '-f', 'link', 'linkdir');
      git(clone, 'commit', '-q', '-m', 'add files at the symlink paths');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      // statSync follows the links (or throws on the dangling one), so a
      // stat-based walk sees directories and misses the overwrite; lstat
      // semantics surface every symlink as the non-directory entry the
      // merge replaces.
      await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
        code: 'ignored_collision',
      });

      expect(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(dir, 'linkdir')).isSymbolicLink()).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a pull when a pathspec-magic incoming path collides with a local ignored file',
    async () => {
      const dir = makeRepo();
      // A name starting with `:(` is pathspec magic to any git command that
      // parses pathspecs; the probe must compare it literally.
      const magicName = ':(top)notes.txt';
      fs.writeFileSync(path.join(dir, '.gitignore'), `${magicName}\n`);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore the magic name');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, magicName), 'incoming\n');
      // A leading ./ keeps git from parsing the name as pathspec magic.
      git(clone, 'add', '-f', '--', `./${magicName}`);
      git(clone, 'commit', '-q', '-m', 'add the magic name');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, magicName), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
        code: 'ignored_collision',
      });

      expect(fs.readFileSync(path.join(dir, magicName), 'utf8')).toBe(
        'local secret\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not refuse a safe pull whose incoming path replaces a tracked symlink',
    async () => {
      const dir = makeRepo();
      fs.symlinkSync('a.txt', path.join(dir, 'vendor'));
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add a tracked symlink');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      // Upstream replaces the symlink with a real directory; the incoming
      // paths sit beyond the symlink, which git resolves by replacing it.
      const clone = makeClone(remote);
      git(clone, 'rm', '-q', 'vendor');
      fs.mkdirSync(path.join(clone, 'vendor'));
      fs.writeFileSync(path.join(clone, 'vendor', 'core.js'), 'core\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'replace symlink with a directory');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const result = await gitPull(dir, { stash: true });

      expect(result.success).toBe(true);
      expect(fs.statSync(path.join(dir, 'vendor')).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'vendor', 'core.js'), 'utf8')).toBe(
        'core\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it('refuses a rebase pull whose replayed commits add a path over a local ignored file', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // The common "commit a generated file, then untrack and ignore it"
    // history, in LOCAL-ONLY commits: the replay checks the committed
    // copy out over the worktree even though the net range diff no
    // longer shows the path.
    fs.writeFileSync(path.join(dir, 'notes'), 'gen v1\n');
    git(dir, 'add', '-f', 'notes');
    git(dir, 'commit', '-q', '-m', 'add notes');
    git(dir, 'rm', '-q', '--cached', 'notes');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'notes\n');
    fs.writeFileSync(path.join(dir, 'notes'), 'current secret\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'untrack and ignore notes');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    const headBefore = headSha(dir);

    await expect(gitPull(dir, { rebase: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    // The refusal precedes the rebase: HEAD, the ignored content, and the
    // worktree are untouched.
    expect(headSha(dir)).toBe(headBefore);
    expect(fs.readFileSync(path.join(dir, 'notes'), 'utf8')).toBe(
      'current secret\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  // The merge arm runs a real divergent three-way merge; a host system
  // config such as [merge] ff = only fatals it before the pinned behavior
  // applies.
  it.runIf(!hostHasSystemGitConfig())(
    'refuses a rebase pull whose initial checkout would overwrite a locally deleted-and-ignored file',
    async () => {
      // Base carries F; upstream never touches it while the local branch
      // deletes it and ignores the path, keeping user content in the
      // worktree. The rebase's initial checkout of the tip still writes F
      // over the ignored file before the replayed delete removes it, so
      // the collision probe must count the tip's whole tree, not only the
      // upstream diff. A merge writes only what changed since the base,
      // so the merge shape is safe on the identical setup.
      const makeFixture = () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, 'F.txt'), 'base content\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'add F');
        const remote = makeBareRemote();
        git(dir, 'remote', 'add', 'origin', remote);
        git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

        const clone = makeClone(remote);
        fs.writeFileSync(path.join(clone, 'g.txt'), 'incoming\n');
        git(clone, 'add', '.');
        git(clone, 'commit', '-q', '-m', 'add g.txt');
        git(clone, 'push', '-q', 'origin', 'HEAD');

        git(dir, 'rm', '-q', 'F.txt');
        git(dir, 'commit', '-q', '-m', 'delete F');
        fs.writeFileSync(path.join(dir, '.gitignore'), 'F.txt\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'ignore F');
        fs.writeFileSync(path.join(dir, 'F.txt'), 'user content\n');
        return dir;
      };

      const rebaseDir = makeFixture();
      fs.writeFileSync(path.join(rebaseDir, 'a.txt'), 'local edit\n');

      await expect(
        gitPull(rebaseDir, { stash: true, rebase: true }),
      ).rejects.toMatchObject({ code: 'ignored_collision' });

      expect(fs.readFileSync(path.join(rebaseDir, 'F.txt'), 'utf8')).toBe(
        'user content\n',
      );
      expect(fs.readFileSync(path.join(rebaseDir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(rebaseDir, 'stash', 'list').trim()).toBe('');

      const mergeDir = makeFixture();
      fs.writeFileSync(path.join(mergeDir, 'a.txt'), 'local edit\n');

      const result = await gitPull(mergeDir, { stash: true });

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(mergeDir, 'F.txt'), 'utf8')).toBe(
        'user content\n',
      );
      expect(fs.readFileSync(path.join(mergeDir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(mergeDir, 'stash', 'list').trim()).toBe('');
    },
  );

  it('refuses every pull shape while a resolved cherry-pick is staged', async () => {
    const dir = makeRepo();
    // A conflicting cherry-pick, resolved and staged: no MERGE_HEAD, no
    // rebase dirs, no unmerged entries — but stash push and reset --hard
    // both abandon it, and the staged resolution is unrecoverable.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'to pick\n');
    git(dir, 'commit', '-q', '-am', 'to pick');
    const pick = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'cherry-pick', pick)).toThrow();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    git(dir, 'add', 'a.txt');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'merge_in_progress',
      });
    }

    // The refusal precedes any action: the pick is still resumable.
    expect(() =>
      git(dir, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('resolved\n');
    expect(git(dir, 'stash', 'list').trim()).toBe('');
    // `:` is git's special-cased no-op editor and spawns no process:
    // coreutils `true` is not guaranteed on the Windows lanes' git-visible
    // PATH, where cherry-pick --continue would fail starting it.
    git(dir, '-c', 'core.editor=:', 'cherry-pick', '--continue');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('resolved\n');
  });
  it('refuses every pull shape while a resolved squash merge is staged', async () => {
    const dir = makeRepo();
    // A conflicted squash merge writes SQUASH_MSG without MERGE_HEAD or a
    // sequence head, and the staged resolution is just as unrecoverable by
    // reflog as a cherry-pick's once the discard resets it.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'to squash\n');
    git(dir, 'commit', '-q', '-am', 'to squash');
    const source = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'merge', '--squash', source)).toThrow();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    git(dir, 'add', 'a.txt');

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'merge_in_progress',
      });
    }

    // The refusal precedes any action: the resolution stays staged, nothing
    // was stashed, and the squash is still completable.
    expect(fs.existsSync(path.join(dir, '.git', 'SQUASH_MSG'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('resolved\n');
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');
    expect(git(dir, 'stash', 'list').trim()).toBe('');
    git(dir, 'commit', '-q', '-m', 'finish the squash');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('resolved\n');
  });

  it('refuses a stash pull while a resolved revert is staged', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-q', '-am', 'two');
    const target = headSha(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    git(dir, 'commit', '-q', '-am', 'three');
    expect(() => git(dir, 'revert', target)).toThrow();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    git(dir, 'add', 'a.txt');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'merge_in_progress',
    });

    expect(() =>
      git(dir, 'rev-parse', '-q', '--verify', 'REVERT_HEAD'),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('resolved\n');
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses the force discard for unmerged entries no session head explains', async () => {
    // A single-commit `cherry-pick -n` stopped on conflict writes no
    // CHERRY_PICK_HEAD/MERGE_HEAD/SQUASH_MSG/sequencer state — only
    // unmerged index entries — yet the discard's `reset --hard` destroys
    // that resolution just as irrecoverably by reflog as the sessions the
    // guard already covers.
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'to pick\n');
    git(dir, 'commit', '-q', '-am', 'to pick');
    const pick = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'cherry-pick', '-n', pick)).toThrow();

    // No probe-able session state exists for the guard's head probes.
    for (const head of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      expect(() => git(dir, 'rev-parse', '-q', '--verify', head)).toThrow();
    }
    expect(fs.existsSync(path.join(dir, '.git', 'sequencer'))).toBe(false);

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    await expect(gitPull(dir, { force: true })).rejects.toMatchObject({
      code: 'merge_in_progress',
    });

    // The refusal precedes the discard: the conflict state is intact.
    expect(git(dir, 'ls-files', '--unmerged').trim()).not.toBe('');
  });

  it('refuses every pull shape while a parked no-commit pick sequence holds the sequencer', async () => {
    // Multiple picks with -n park their todo list in .git/sequencer while
    // writing no CHERRY_PICK_HEAD/REVERT_HEAD the guard's head probes
    // read; the staged resolution a stopped pick leaves is just as
    // unrecoverable by reflog once the discard resets it.
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'pick one\n');
    git(dir, 'commit', '-q', '-am', 'pick one');
    const pickOne = headSha(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'pick two\n');
    git(dir, 'commit', '-q', '-am', 'pick two');
    const pickTwo = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~2');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'cherry-pick', '-n', pickOne, pickTwo)).toThrow();
    expect(fs.existsSync(path.join(dir, '.git', 'sequencer'))).toBe(true);

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'merge_in_progress',
      });
    }

    // The refusal precedes any action: the parked sequence survives.
    expect(fs.existsSync(path.join(dir, '.git', 'sequencer'))).toBe(true);
    expect(git(dir, 'ls-files', '--unmerged').trim()).not.toBe('');
  });

  it('classifies unmerged entries outside a subdirectory workspace', async () => {
    // ls-files --unmerged lists only the cwd subtree, and the routes
    // accept subdirectory workspaces: the probe must run from the
    // toplevel, or a conflicted index outside the subtree reads as
    // unmerged:false and the panel offers the stash button on a tree
    // stashing cannot help. A stopped single-pick cherry-pick -n carries
    // the unmerged entries without a MERGE_HEAD the plain pull would
    // refuse on.
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'to pick\n');
    git(dir, 'commit', '-q', '-am', 'to pick');
    const pick = headSha(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other');
    expect(() => git(dir, 'cherry-pick', '-n', pick)).toThrow();

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 's.txt'), 'untracked\n');

    let thrown: unknown;
    await gitPull(path.join(dir, 'sub')).catch((err) => {
      thrown = err;
    });

    expect(thrown).toMatchObject({
      code: 'dirty_working_tree',
      unmerged: true,
    });
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

  it('refuses a pull when an incoming modification lands on a locally untracked-and-ignored file', async () => {
    const dir = makeRepo();
    // The standard "stop tracking" flow: a committed file, `git rm
    // --cached`, ignored, local content kept — invisible to `git status`.
    fs.writeFileSync(path.join(dir, 'f.txt'), 'gen v1\n');
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', 'track f.txt');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Upstream modifies the path while the local side untracks and
    // ignores it: the merge would check the incoming content out over
    // the ignored file before stopping on the modify/delete conflict.
    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'f.txt'), 'incoming v2\n');
    git(clone, 'add', 'f.txt');
    git(clone, 'commit', '-q', '-m', 'modify f.txt');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    git(dir, 'rm', '-q', '--cached', 'f.txt');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'f.txt\n');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'local secret v1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'untrack and ignore f.txt');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    for (const opts of [{}, { stash: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'ignored_collision',
      });
      expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(
        'local secret v1\n',
      );
    }
    // The collision lives in a local commit the remote does not have, so
    // the branch is diverged: the force shape refuses on that divergence
    // before any discard. Either refusal precedes any mutation.
    await expect(gitPull(dir, { force: true })).rejects.toMatchObject({
      code: 'diverged',
    });
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(
      'local secret v1\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('does not refuse a pull whose incoming side only deletes the ignored path', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'gen v1\n');
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', 'track f.txt');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    git(clone, 'rm', '-q', 'f.txt');
    git(clone, 'commit', '-q', '-m', 'delete f.txt');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // Locally untrack and ignore it: the pull converges on "not tracked"
    // from both sides, and the incoming deletion writes nothing over the
    // ignored local copy.
    git(dir, 'rm', '-q', '--cached', 'f.txt');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'f.txt\n');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'local secret v1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'untrack and ignore f.txt');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const result = await gitPull(dir, { stash: true });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(
      'local secret v1\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  // The fixture's shortest created path is ~1.5KB — five 246-byte directory
  // components under bulk/ plus a 250-byte file name — 48% over XNU's
  // 1024-byte PATH_MAX, so fs.mkdirSync throws ENAMETOOLONG during fixture
  // construction on the macOS lane. Shortening is not an option: short
  // paths need ~120k files to reach the >10MB listing and blow the time
  // budget.
  it.runIf(process.platform !== 'darwin')(
    'pulls through a worktree whose ignored listing exceeds the 10MB buffer',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'bulk\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore bulk');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      // A listing past runGitBuffer's fixed 10MB maxBuffer — the ordinary
      // case for a large node_modules, which enumerates entry-by-entry.
      // Long paths reach the listing size with fewer files: NTFS creates
      // files far slower than ext4, and 41,500 one-by-one writes exceeded
      // the test's 60s budget on the Windows lane.
      let bulkDir = path.join(dir, 'bulk');
      fs.mkdirSync(bulkDir);
      for (let level = 0; level < 5; level++) {
        bulkDir = path.join(bulkDir, `${'d'.repeat(245)}${level}`);
        fs.mkdirSync(bulkDir);
      }
      const nameFiller = 'x'.repeat(245);
      for (let i = 0; i < 8_192; i++) {
        fs.writeFileSync(path.join(bulkDir, `${nameFiller}-${i}.tmp`), '');
      }
      const listingBytes = execFileSync(
        'git',
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        { cwd: dir, maxBuffer: 32 * 1024 * 1024 },
      ).length;
      expect(listingBytes).toBeGreaterThan(10 * 1024 * 1024);

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'new.txt'), 'incoming\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'add new.txt');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const result = await gitPull(dir, { stash: true });

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe(
        'incoming\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
    60_000,
  );

  it('refuses a case-variant collision when the repository folds case', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Notes.md\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore Notes.md');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'notes.md'), 'incoming\n');
    git(clone, 'add', '-f', 'notes.md');
    git(clone, 'commit', '-q', '-m', 'add notes.md');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // core.ignorecase=true is the default on the case-folding
    // filesystems the daemon primarily runs on (APFS/NTFS): git's own
    // ignore matching folds case there, and the merge checks the incoming
    // file out over the case-variant ignored one.
    git(dir, 'config', 'core.ignorecase', 'true');
    fs.writeFileSync(path.join(dir, 'Notes.md'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'Notes.md'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a case-variant collision when core.ignorecase spells true in another casing', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Notes.md\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore Notes.md');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'notes.md'), 'incoming\n');
    git(clone, 'add', '-f', 'notes.md');
    git(clone, 'commit', '-q', '-m', 'add notes.md');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // git's boolean grammar accepts True/TRUE/1/yes/on as true; the probe
    // must fold case under every truthy spelling, not only lowercase.
    git(dir, 'config', 'core.ignorecase', 'True');
    fs.writeFileSync(path.join(dir, 'Notes.md'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'Notes.md'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  // The assertion pair needs the two casings to be distinct directory
  // entries — unsatisfiable on the folding filesystems (APFS/NTFS) of the
  // macOS and Windows CI runners.
  it.runIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'does not fold case when the repository says the filesystem does not',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'Notes.md\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore Notes.md');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'notes.md'), 'incoming\n');
      git(clone, 'add', '-f', 'notes.md');
      git(clone, 'commit', '-q', '-m', 'add notes.md');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      git(dir, 'config', 'core.ignorecase', 'false');
      fs.writeFileSync(path.join(dir, 'Notes.md'), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const result = await gitPull(dir, { stash: true });

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe(
        'incoming\n',
      );
      expect(fs.readFileSync(path.join(dir, 'Notes.md'), 'utf8')).toBe(
        'local secret\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it('pulls every shape on an unborn-HEAD repository with a configured upstream', async () => {
    // Cloning a still-empty remote leaves HEAD unborn while wiring
    // branch.<name>.remote/merge — the shape of a clone whose remote was
    // populated after the clone.
    const makeUnbornFixture = () => {
      const remote = makeBareRemote();
      const dir = makeClone(remote);
      const writer = makeClone(remote);
      fs.writeFileSync(path.join(writer, 'upstream.txt'), 'upstream\n');
      git(writer, 'add', '.');
      git(writer, 'commit', '-q', '-m', 'upstream commit');
      git(writer, 'push', '-q', 'origin', 'HEAD');
      git(dir, 'fetch', '-q', 'origin');
      return dir;
    };

    // A plain pull fast-forwards the unborn branch like the pre-PR bare
    // `git pull`: the probe chain must not fatal on the missing HEAD.
    {
      const dir = makeUnbornFixture();
      fs.writeFileSync(path.join(dir, 'local-untracked.txt'), 'local\n');
      const result = await gitPull(dir);
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'upstream.txt'), 'utf8')).toBe(
        'upstream\n',
      );
      expect(
        fs.readFileSync(path.join(dir, 'local-untracked.txt'), 'utf8'),
      ).toBe('local\n');
    }

    // The stash shape pulls through too: an unborn HEAD cannot be
    // stashed, so it degrades to the bare merge, which refuses to
    // overwrite the untracked local file on its own.
    {
      const dir = makeUnbornFixture();
      fs.writeFileSync(path.join(dir, 'local-untracked.txt'), 'local\n');
      const result = await gitPull(dir, { stash: true });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'upstream.txt'), 'utf8')).toBe(
        'upstream\n',
      );
      expect(
        fs.readFileSync(path.join(dir, 'local-untracked.txt'), 'utf8'),
      ).toBe('local\n');
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    }

    // The force shape's divergence check must not fatal on the missing
    // HEAD either: an unborn branch has no local commits to diverge.
    {
      const dir = makeUnbornFixture();
      const result = await gitPull(dir, { force: true });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'upstream.txt'), 'utf8')).toBe(
        'upstream\n',
      );
    }

    // The rebase shape has no local commits to replay on an unborn HEAD,
    // so it completes the update like the merge shape instead of fataling
    // on the missing HEAD ("Could not resolve HEAD to a commit").
    {
      const dir = makeUnbornFixture();
      fs.writeFileSync(path.join(dir, 'local-untracked.txt'), 'local\n');
      const result = await gitPull(dir, { rebase: true });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'upstream.txt'), 'utf8')).toBe(
        'upstream\n',
      );
      expect(
        fs.readFileSync(path.join(dir, 'local-untracked.txt'), 'utf8'),
      ).toBe('local\n');
    }

    // With force the discard runs before the update; the update must then
    // still complete instead of fataling with the changes already gone.
    {
      const dir = makeUnbornFixture();
      const result = await gitPull(dir, { force: true, rebase: true });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'upstream.txt'), 'utf8')).toBe(
        'upstream\n',
      );
    }
  });
  it('pulls an unborn-HEAD sha256 repository like the pre-PR bare pull', async () => {
    // The unborn merge base is the empty tree, whose object id depends on
    // the repository's object format: a hardcoded sha1 id fatals "unknown
    // revision" on sha256 repositories, refusing a pull the pre-PR bare
    // `git pull` handled. A clone of an EMPTY remote does not reliably
    // inherit the format, so the fixture inits each repo with it.
    const makeSha256Repo = (bare: boolean) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitsha256-'));
      tmpRoots.push(dir);
      git(
        dir,
        'init',
        '-q',
        '-b',
        'master',
        '--object-format=sha256',
        ...(bare ? ['--bare'] : []),
      );
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'config', 'commit.gpgsign', 'false');
      git(dir, 'config', 'core.autocrlf', 'false');
      git(dir, 'config', 'core.eol', 'lf');
      return dir;
    };
    // The Windows runners' compiled-in system config sets
    // core.autocrlf=true; gitEnv() strips GIT_CONFIG_GLOBAL/SYSTEM, so
    // that host channel reaches the product's git but not the fixture
    // helper. Plant the hermetic HOME's global config — which only the
    // product channel reads — to stand in for it on every platform: the
    // fixture's repo-local pin above must outrank it or the merge checks
    // the incoming file out CRLF and the content assertion fails.
    const ambient = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(ambient, '[core]\n\tautocrlf = true\n');
    try {
      const remote = makeSha256Repo(true);
      const writer = makeSha256Repo(false);
      git(writer, 'remote', 'add', 'origin', remote);
      fs.writeFileSync(path.join(writer, 'upstream.txt'), 'upstream\n');
      git(writer, 'add', '.');
      git(writer, 'commit', '-q', '-m', 'upstream commit');
      git(writer, 'push', '-q', 'origin', 'HEAD');

      const dir = makeSha256Repo(false);
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'config', 'branch.master.remote', 'origin');
      git(dir, 'config', 'branch.master.merge', 'refs/heads/master');
      // Fixture pin: a sha1 repository would pass this test vacuously.
      expect(git(dir, 'config', 'extensions.objectformat').trim()).toBe(
        'sha256',
      );
      git(dir, 'fetch', '-q', 'origin');
      expect(() => git(dir, 'rev-parse', '-q', '--verify', 'HEAD')).toThrow();

      const result = await gitPull(dir);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'upstream.txt'), 'utf8')).toBe(
        'upstream\n',
      );
    } finally {
      fs.rmSync(ambient, { force: true });
    }
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

  // Ambient merge.ff / merge.verifySignatures / commit.gpgsign reach the
  // product's git through the HOME channel gitEnv() keeps; the pinned
  // merge/rebase must neutralize them or the resolution flow dead-ends
  // host-config-dependently.
  it('stash pull merges divergent branches when ambient merge.ff is only', async () => {
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
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const userGitconfig = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(userGitconfig, '[merge]\n\tff = only\n');
    try {
      const result = await gitPull(dir, { stash: true });

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'local-only.txt'))).toBe(true);
      expect(git(dir, 'log', '--merges', '--oneline').trim()).not.toBe('');
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    } finally {
      fs.rmSync(userGitconfig, { force: true });
    }
  });

  it('fast-forwards an unsigned tip when ambient merge.verifySignatures is true', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    const userGitconfig = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(userGitconfig, '[merge]\n\tverifySignatures = true\n');
    try {
      const result = await gitPull(dir);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'remote-only.txt'), 'utf8')).toBe(
        'remote\n',
      );
    } finally {
      fs.rmSync(userGitconfig, { force: true });
    }
  });

  it('pulls every divergent shape when ambient commit.gpgsign cannot sign', async () => {
    // The repo-local commit.gpgsign=false pin every fixture carries would
    // outrank the ambient channel and make this witness vacuous, so build
    // the diverged fixture without it.
    const makeDivergedRepo = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitgpgsign-'));
      tmpRoots.push(dir);
      git(dir, 'init', '-q', '-b', 'master');
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'config', 'core.autocrlf', 'false');
      git(dir, 'config', 'core.eol', 'lf');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'init');
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
      return dir;
    };

    const userGitconfig = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(
      userGitconfig,
      '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/qwen-gpg\n',
    );
    try {
      for (const opts of [{}, { rebase: true }] as const) {
        const dir = makeDivergedRepo();
        const headBefore = headSha(dir);

        const result = await gitPull(dir, opts);

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'local-only.txt'))).toBe(true);
        expect(headSha(dir)).not.toBe(headBefore);
        expect(() =>
          git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
        ).toThrow();
        // The merge arm reconciles with a merge commit; the rebase arm
        // replays linearly.
        if (opts.rebase === true) {
          expect(git(dir, 'log', '--merges', '--oneline').trim()).toBe('');
        } else {
          expect(git(dir, 'log', '--merges', '--oneline').trim()).not.toBe('');
        }
      }
    } finally {
      fs.rmSync(userGitconfig, { force: true });
    }
  });

  it('pins the merge against ambient branch mergeoptions', async () => {
    // branch.<name>.mergeoptions is read before command-line options and
    // stays reachable through the HOME channel gitEnv() keeps: --no-commit
    // there would let the pinned merge exit 0 with HEAD unmoved and
    // MERGE_HEAD left behind, wedging every later pull into
    // merge_in_progress. The pinned --commit --no-squash must outrank it.
    const userGitconfig = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(
      userGitconfig,
      '[branch "master"]\n\tmergeoptions = --no-commit\n',
    );
    try {
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

      const result = await gitPull(dir);

      expect(result.success).toBe(true);
      expect(headSha(dir)).not.toBe(headBefore);
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).toThrow();
      expect(git(dir, 'log', '--merges', '--oneline').trim()).not.toBe('');
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'local-only.txt'))).toBe(true);
    } finally {
      fs.rmSync(userGitconfig, { force: true });
    }
  });

  it('refuses a pull when incoming files land inside a tracked gitlink the probe cannot enumerate', async () => {
    const dir = makeRepo();
    // An embedded repository tracked as a gitlink (mode 160000): the
    // superproject's ls-files never descends into a nested repository's
    // directory, so files inside it are invisible to the probe's local
    // enumeration no matter what the ignore rules say.
    const vendorDir = path.join(dir, 'vendor');
    fs.mkdirSync(vendorDir);
    git(vendorDir, 'init', '-q', '-b', 'master');
    git(vendorDir, 'config', 'user.email', 'vendor@example.com');
    git(vendorDir, 'config', 'user.name', 'Vendor');
    git(vendorDir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(vendorDir, 'lib.txt'), 'vendored\n');
    git(vendorDir, 'add', '.');
    git(vendorDir, 'commit', '-q', '-m', 'vendor init');
    git(dir, 'add', 'vendor');
    git(dir, 'commit', '-q', '-m', 'track vendor as a gitlink');
    // The shadowing file must be ignored for the overwrite to be silent:
    // git's merge refuses to clobber an untracked-and-NOT-ignored file
    // even inside a nested repository's directory. The probe's local
    // enumeration is blind inside the nested repository either way.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.env\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore secret.env');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Upstream converts the gitlink into a regular tree carrying a file
    // that shadows one held inside the local nested repository.
    const clone = makeClone(remote);
    git(clone, 'rm', '-q', '--cached', 'vendor');
    fs.mkdirSync(path.join(clone, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'vendor', 'secret.env'), 'INCOMING\n');
    git(clone, 'add', '-f', '.');
    git(clone, 'commit', '-q', '-m', 'convert the gitlink to a tree');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(vendorDir, 'secret.env'), 'TOPSECRET-LOCAL\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir)).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(vendorDir, 'secret.env'), 'utf8')).toBe(
      'TOPSECRET-LOCAL\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
  });

  it('refuses a pull when incoming files land inside an UNTRACKED nested repository the probe cannot enumerate', async () => {
    // A manual clone inside the workspace is not a gitlink, but ls-files
    // is just as blind inside it: the ignored listing cannot see the
    // shadowed file, so the nested repository must block like a gitlink.
    // The shadowing file must be ignored for the overwrite to be silent.
    const dir = makeRepo();
    const vendorDir = path.join(dir, 'vendor');
    fs.mkdirSync(vendorDir);
    git(vendorDir, 'init', '-q', '-b', 'master');
    git(vendorDir, 'config', 'user.email', 'vendor@example.com');
    git(vendorDir, 'config', 'user.name', 'Vendor');
    git(vendorDir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(vendorDir, 'lib.txt'), 'vendored\n');
    git(vendorDir, 'add', '.');
    git(vendorDir, 'commit', '-q', '-m', 'vendor init');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.env\n');
    // Add only the ignore rule: `add .` would track the nested repository
    // as a gitlink, and this fixture needs it UNTRACKED.
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'ignore secret.env');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.mkdirSync(path.join(clone, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'vendor', 'secret.env'), 'INCOMING\n');
    git(clone, 'add', '-f', '.');
    git(clone, 'commit', '-q', '-m', 'add vendor/secret.env');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(vendorDir, 'secret.env'), 'TOPSECRET-LOCAL\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir)).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(vendorDir, 'secret.env'), 'utf8')).toBe(
      'TOPSECRET-LOCAL\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
  });

  it('refuses a rebase pull when an incoming gitlink lands on a local ignored file', async () => {
    // The rebase arm enumerates the fetched tip's tree; mode-160000
    // entries stay out of the additions (a gitlink landing on a tracked
    // gitlink is a pointer update, not an overwrite), but they must still
    // refuse when the gitlink lands on a local ignored FILE — the initial
    // checkout replaces the file with an empty submodule directory, while
    // the merge arm refuses the identical state.
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'sub\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore sub');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    const subRepo = path.join(clone, 'sub');
    fs.mkdirSync(subRepo);
    git(subRepo, 'init', '-q', '-b', 'master');
    git(subRepo, 'config', 'user.email', 'sub@example.com');
    git(subRepo, 'config', 'user.name', 'Sub');
    git(subRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(subRepo, 'lib.txt'), 'vendored\n');
    git(subRepo, 'add', '.');
    git(subRepo, 'commit', '-q', '-m', 'sub init');
    git(clone, 'add', '-f', 'sub');
    git(clone, 'commit', '-q', '-m', 'add sub as a gitlink');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'sub'), 'SECRET-LOCAL\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(
      gitPull(dir, { stash: true, rebase: true }),
    ).rejects.toMatchObject({ code: 'ignored_collision' });

    expect(fs.readFileSync(path.join(dir, 'sub'), 'utf8')).toBe(
      'SECRET-LOCAL\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('pulls a rebase through an incoming gitlink pointer update', async () => {
    // The control for the refusal above: an incoming gitlink landing on a
    // locally TRACKED gitlink is a submodule pointer update, not an
    // overwrite, and must pull through.
    const dir = makeRepo();
    const subRepo = path.join(dir, 'sub');
    fs.mkdirSync(subRepo);
    git(subRepo, 'init', '-q', '-b', 'master');
    git(subRepo, 'config', 'user.email', 'sub@example.com');
    git(subRepo, 'config', 'user.name', 'Sub');
    git(subRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(subRepo, 'lib.txt'), 'vendored v1\n');
    git(subRepo, 'add', '.');
    git(subRepo, 'commit', '-q', '-m', 'sub v1');
    git(dir, 'add', 'sub');
    git(dir, 'commit', '-q', '-m', 'track sub');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    // Upstream advances the submodule pointer.
    const clone = makeClone(remote);
    const cloneSub = path.join(clone, 'sub');
    // The clone checks the gitlink out as an empty directory already.
    fs.mkdirSync(cloneSub, { recursive: true });
    git(cloneSub, 'init', '-q', '-b', 'master');
    git(cloneSub, 'config', 'user.email', 'sub@example.com');
    git(cloneSub, 'config', 'user.name', 'Sub');
    git(cloneSub, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(cloneSub, 'lib.txt'), 'vendored v2\n');
    git(cloneSub, 'add', '.');
    git(cloneSub, 'commit', '-q', '-m', 'sub v2');
    const newSubSha = headSha(cloneSub);
    git(clone, 'add', '-f', 'sub');
    git(clone, 'commit', '-q', '-m', 'advance the sub pointer');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'local-only.txt'), 'local\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');

    const result = await gitPull(dir, { rebase: true });

    expect(result.success).toBe(true);
    expect(git(dir, 'ls-files', '-s', 'sub')).toContain(newSubSha);
    expect(fs.readFileSync(path.join(dir, 'local-only.txt'), 'utf8')).toBe(
      'local\n',
    );
  });

  // The POSIX shim below stands in for a concurrent actor whose merge of
  // the SAME fetched tip lands inside the collision probe while the pull
  // also faces a real ignored collision; it has no Windows equivalent in
  // this suite.
  it.runIf(process.platform !== 'win32' && !hostHasSystemGitConfig())(
    "keeps a concurrent actor's merge when an ignored collision refuses the pull",
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore secret.txt');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'secret.txt'), 'incoming\n');
      git(clone, 'add', '-f', 'secret.txt');
      git(clone, 'commit', '-q', '-m', 'add secret.txt');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'secret.txt'), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'actor-collision-once');
      // The actor's merge of exactly the fetched tip parks its staged
      // resolution while the collision probe runs. A real merge is not the
      // simulation here: it would check the incoming file out over the
      // ignored one, making it tracked and dropping it from the ignored
      // listing the probe reads. MERGE_HEAD carries no writer identity,
      // and the collision throws before the update and its guard re-run,
      // so tip equality cannot tell this state from this pull's own.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "ls-files" ]; then\n` +
          `  case " $* " in\n` +
          `  *" --ignored "*)\n` +
          `    if [ ! -e "${marker}" ]; then\n` +
          `      : > "${marker}"\n` +
          `      "${realGit}" -C "${dir}" rev-parse origin/master > "$("${realGit}" -C "${dir}" rev-parse --git-dir)/MERGE_HEAD"\n` +
          `      "${realGit}" -C "${dir}" rev-parse HEAD > "$("${realGit}" -C "${dir}" rev-parse --git-dir)/ORIG_HEAD"\n` +
          `      printf 'actor staged resolution\\n' > "${dir}/resolved-by-actor.txt"\n` +
          `      "${realGit}" -C "${dir}" add resolved-by-actor.txt\n` +
          `    fi\n` +
          `    ;;\n` +
          `  esac\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await expect(
        withPathPrefix(shimDir, () => gitPull(dir, { stash: true })),
      ).rejects.toMatchObject({ code: 'ignored_collision' });

      // The collision refused the pull before the update ran, so any
      // merge state present is the actor's and must survive.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).not.toThrow();
      expect(git(dir, 'diff', '--cached', '--name-only')).toContain(
        'resolved-by-actor.txt',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

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
  it.runIf(process.platform !== 'win32' && !hostHasSystemGitConfig())(
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

  // The POSIX shim below stands in for a concurrent actor pushing into
  // the restore's identity-check->apply window; it has no Windows
  // equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'flags the restore when a foreign stash lands between the identity check and the apply',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'racer-marker');
      const target = path.join(dir, 'remote-only.txt');
      // The user's terminal stashes its own edit inside the window between
      // the restore's identity check and the apply: the restore must not
      // consume and drop the foreign entry while the pull's own stays
      // behind.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "apply" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  printf 'concurrent edit\\n' >> "${target}"\n` +
          `  "${realGit}" -C "${dir}" stash push -q -m 'concurrent actor'\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      expect(result.success).toBe(true);
      // The restore is reported as failed — the pull's own entry was never
      // applied — instead of a silent success behind the consumed foreign
      // entry. The apply leaves entries in place, so the foreign entry
      // survives as a duplicate (its diff applied, entry kept) instead of
      // being applied AND dropped by a single pop.
      expect(result.stashRestoreConflict).toBe(true);
      const list = git(dir, 'stash', 'list');
      expect(list).toContain('qwen-code: auto-stash before pull');
      expect(list).toContain('concurrent actor');
      // The local edit waits in the kept entry; the concurrent edit landed
      // in the worktree through the apply.
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
      expect(fs.readFileSync(path.join(dir, 'remote-only.txt'), 'utf8')).toBe(
        'remote\nconcurrent edit\n',
      );
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

  // The POSIX shim below stands in for a concurrent actor creating state
  // inside the force path's guard->discard window (the slow pre-discard
  // probe); it has no Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    "refuses a force discard when an actor's cherry-pick lands during the pre-discard probe",
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'cherry-pick-once');
      // The actor concludes a cherry-pick resolution while the pre-discard
      // probe runs: the discard must refuse it instead of destroying it —
      // `reset --hard` would erase CHERRY_PICK_HEAD and the staged
      // resolution before any later guard could see them.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "ls-files" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  "${realGit}" rev-parse HEAD > "$("${realGit}" rev-parse --git-dir)/CHERRY_PICK_HEAD"\n` +
          `  printf 'actor staged resolution\\n' > "${dir}/resolved-by-actor.txt"\n` +
          `  "${realGit}" add resolved-by-actor.txt\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { force: true })).rejects.toMatchObject({
          code: 'merge_in_progress',
        }),
      );

      // The refusal precedes the discard: the actor's cherry-pick state and
      // its staged resolution survive, and the local edit was never reset.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'),
      ).not.toThrow();
      expect(git(dir, 'diff', '--cached', '--name-only')).toContain(
        'resolved-by-actor.txt',
      );
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

      // A probe failure (here: the ignored-file enumeration exiting 128)
      // must not read as "no collision" and let the overwriting merge
      // through.
      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "ls-files" ]; then\n` +
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
      // The restore now applies and drops separately; fail the apply.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "apply" ]; then\n` +
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
      // The structured flag names where the unrestored changes are kept;
      // without it the edits sit in refs/stash invisibly behind whatever
      // guidance the client renders.
      expect(thrown).toMatchObject({ stashRestoreFailed: true });
      expect(git(dir, 'stash', 'list', '--oneline')).toContain(
        'auto-stash before pull',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local version\n',
      );
      expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses the pull when a collision-probe gate fails transiently',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      // Each arm fails one gate probe transiently (exit 128); the pull
      // must refuse instead of reading the failure as "no collision" and
      // checking the incoming file out over the local one.
      const gates = [
        // the toplevel gate
        `if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then\n` +
          `  exit 128\n` +
          `fi\n`,
        // the upstream gate
        `if [ "$1" = "rev-parse" ]; then\n` +
          `  for a in "$@"; do\n` +
          `    [ "$a" = "@{u}" ] && exit 128\n` +
          `  done\n` +
          `fi\n`,
      ];
      for (const gate of gates) {
        const shimDir = installGitShim(
          `#!/bin/sh\n${gate}exec "${realGit}" "$@"\n`,
        );
        let thrown: unknown;
        await withPathPrefix(shimDir, () =>
          gitPull(dir, { stash: true }),
        ).catch((err) => {
          thrown = err;
        });
        expect(thrown).toBeTruthy();
        expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
          'local secret\n',
        );
        expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
          'local edit\n',
        );
        expect(git(dir, 'stash', 'list').trim()).toBe('');
      }
    },
  );

  // The fixture writes a raw 0xFF byte through fs.writeFileSync, which
  // throws EILSEQ on APFS; like the case-variant tests, gate the
  // filesystem-sensitive fixture on both platforms.
  it.runIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'refuses a pull when a non-UTF-8 incoming path collides with a local ignored file',
    async () => {
      // A legacy Latin-1 name: 0xFF is not valid UTF-8, so a string
      // transport decodes it to U+FFFD and can never match the on-disk
      // name again.
      const rawName = Buffer.concat([
        Buffer.from('legacy-'),
        Buffer.from([0xff]),
        Buffer.from('.log'),
      ]);
      const rawIn = (root: string): Buffer =>
        Buffer.concat([Buffer.from(`${root}/`), rawName]);
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore logs');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(rawIn(clone), 'incoming\n');
      git(clone, 'add', '-f', '.');
      git(clone, 'commit', '-q', '-m', 'add the legacy path');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(rawIn(dir), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
        code: 'ignored_collision',
      });

      expect(fs.readFileSync(rawIn(dir), 'utf8')).toBe('local secret\n');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it('refuses every pull shape when the colliding ignored entry sits at a path prefix', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'docs\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore docs');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.mkdirSync(path.join(clone, 'docs'));
    fs.writeFileSync(path.join(clone, 'docs', 'guide.md'), 'incoming\n');
    git(clone, 'add', '-f', 'docs/guide.md');
    git(clone, 'commit', '-q', '-m', 'add docs/guide.md');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // A local ignored FILE where the incoming addition wants a directory:
    // the merge would replace the file with the incoming directory.
    fs.writeFileSync(path.join(dir, 'docs'), 'user content\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    for (const opts of [{}, { stash: true }, { force: true }] as const) {
      await expect(gitPull(dir, opts)).rejects.toMatchObject({
        code: 'ignored_collision',
      });
      expect(fs.readFileSync(path.join(dir, 'docs'), 'utf8')).toBe(
        'user content\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
    }
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it.runIf(process.platform !== 'win32')(
    'refuses the pull when the repository-identity probe fails',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then\n` +
          `  exit 128\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      let thrown: unknown;
      await withPathPrefix(shimDir, () => gitPull(dir, { stash: true })).catch(
        (err) => {
          thrown = err;
        },
      );

      expect(thrown).toBeTruthy();
      // The pull never ran: nothing was fetched or merged, and nothing
      // was stashed.
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses the pull when the merge-state guard probe fails',
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

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'local commit');

      // Mid-merge with the conflict resolved but uncommitted: MERGE_HEAD
      // exists without unmerged entries, so `stash push` succeeds and
      // clears it — admitting the pull destroys the user's merge.
      git(dir, 'fetch', '-q', 'origin');
      expect(() => git(dir, 'merge', 'origin/master')).toThrow();
      fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
      git(dir, 'add', 'a.txt');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "rev-parse" ] && [ "$2" = "-q" ] && ` +
          `[ "$3" = "--verify" ] && [ "$4" = "MERGE_HEAD" ]; then\n` +
          `  exit 128\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      let thrown: unknown;
      await withPathPrefix(shimDir, () => gitPull(dir, { stash: true })).catch(
        (err) => {
          thrown = err;
        },
      );

      expect(thrown).toBeTruthy();
      // The failed probe refused the pull: the in-progress merge and its
      // resolution survive, and nothing was stashed.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).not.toThrow();
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'resolved\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'names the kept stash when the push-failure pop-back also fails',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      // The push runs for real (creating the entry and moving the edits
      // out of the worktree) and only then reports failure; the recovery
      // pop-back of the stranded entry also fails.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  exit 1\n` +
          `fi\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "apply" ]; then\n` +
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

      expect(thrown).toBeTruthy();
      // The edits live only in the kept stash entry; the refusal must
      // name it.
      expect((thrown as Error).message).toContain('git stash list');
      expect(git(dir, 'stash', 'list', '--oneline')).toContain(
        'auto-stash before pull',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    },
  );

  it.runIf(process.platform !== 'win32')(
    "keeps a concurrent actor's merge that appears between the guard and the update",
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const callLog = path.join(dir, '.git', 'pull-calls.log');
      // A concurrent actor concludes a merge in the window between the
      // last guard re-run and the update; the update fails fast on the
      // foreign MERGE_HEAD.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `printf '%s\\n' "$*" >> "${callLog}"\n` +
          `if [ "$1" = "merge" ]; then\n` +
          `  "${realGit}" rev-parse HEAD > ` +
          `"$("${realGit}" rev-parse --git-dir)/MERGE_HEAD"\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'merge_in_progress',
        }),
      );

      // The actor's merge state survives the failure recovery (this pull
      // did not start it), no abort ran, and the auto-stash is restored.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).not.toThrow();
      expect(fs.readFileSync(callLog, 'utf8')).not.toContain('merge --abort');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    "keeps a concurrent actor's rebase that appears between the guard and the update",
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const gitDir = path.join(dir, '.git');
      const callLog = path.join(gitDir, 'pull-calls.log');
      // Plant a foreign rebase state in the window between the last guard
      // re-run and the update; `git rebase` refuses to start over an
      // existing state directory. The planted `onto` names the actor's
      // target, not this pull's fetched tip.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `printf '%s\\n' "$*" >> "${callLog}"\n` +
          `if [ "$1" = "rebase" ]; then\n` +
          `  mkdir -p "${gitDir}/rebase-merge"\n` +
          `  "${realGit}" rev-parse HEAD > "${gitDir}/rebase-merge/onto"\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(
          gitPull(dir, { stash: true, rebase: true }),
        ).rejects.toMatchObject({
          code: 'rebase_in_progress',
        }),
      );

      // The actor's rebase state survives the failure recovery, no abort
      // ran, and the auto-stash is restored.
      expect(fs.existsSync(path.join(gitDir, 'rebase-merge'))).toBe(true);
      expect(fs.readFileSync(callLog, 'utf8')).not.toContain('rebase --abort');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );
  // The POSIX shim below stands in for a concurrent actor checking out
  // another branch inside the guard->merge window (the slow collision
  // probe); it has no Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'refuses the merge and restores the auto-stash when HEAD moves during the probe',
    async () => {
      const dir = makeRepo();
      git(dir, 'branch', 'other');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'checkout-once');
      // The auto-stash manufactures the clean tree that admits the actor's
      // checkout inside the probe window; the pinned-tip merge must not
      // land on the foreign branch.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "ls-files" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  "${realGit}" checkout -q other\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      let thrown: unknown;
      await withPathPrefix(shimDir, () => gitPull(dir, { stash: true })).catch(
        (err) => {
          thrown = err;
        },
      );

      expect(thrown).toMatchObject({ code: 'head_changed' });
      // Nothing merged into the foreign branch; the auto-stash is popped
      // back and the actor's checkout stands.
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(false);
      expect(currentBranch(dir)).toBe('other');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  // The POSIX shim below stands in for a concurrent actor whose conflicted
  // merge of the SAME upstream tip lands inside the guard->merge window; it
  // has no Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    "keeps a concurrent actor's merge of the same tip that appears during the probe",
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'actor-merge-once');
      const callLog = path.join(dir, '.git', 'pull-calls.log');
      // The actor's merge of exactly the fetched tip parks its staged
      // resolution while the probe runs: tip equality cannot tell it from
      // this pull's own state, so the guard re-run must see it before the
      // merge instead of the recovery aborting it afterwards.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `printf '%s\\n' "$*" >> "${callLog}"\n` +
          `if [ "$1" = "ls-files" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  "${realGit}" rev-parse "@{u}" > "$("${realGit}" rev-parse --git-dir)/MERGE_HEAD"\n` +
          `  printf 'actor staged resolution\\n' > "${dir}/resolved-by-actor.txt"\n` +
          `  "${realGit}" add resolved-by-actor.txt\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'merge_in_progress',
        }),
      );

      // The actor's merge state and staged resolution survive (this pull
      // did not start them), and no abort ran.
      expect(() =>
        git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
      ).not.toThrow();
      expect(fs.readFileSync(callLog, 'utf8')).not.toContain('merge --abort');
      expect(git(dir, 'diff', '--cached', '--name-only')).toContain(
        'resolved-by-actor.txt',
      );
      // The local edit survives whatever the restore achieved: applied to
      // the worktree, or kept in the entry the restore-failure note names.
      const restored =
        fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'local edit\n' ||
        git(dir, 'stash', 'list', '--oneline').includes(
          'auto-stash before pull',
        );
      expect(restored).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses the pull when the fetched-tip probe fails transiently',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'tip-probe-once');
      // Fail the fetched-tip probe once, then recover: a permissive probe
      // would let the pull continue on an empty tip.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "rev-parse" ]; then\n` +
          `  for a in "$@"; do\n` +
          `    if [ "$a" = "@{u}" ] && [ ! -e "${marker}" ]; then\n` +
          `      : > "${marker}"\n` +
          `      exit 128\n` +
          `    fi\n` +
          `  done\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      let thrown: unknown;
      await withPathPrefix(shimDir, () => gitPull(dir, { stash: true })).catch(
        (err) => {
          thrown = err;
        },
      );

      expect(thrown).toBeTruthy();
      // The pull never reached the merge.
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects when the post-push stash probe fails instead of reporting success over a stranded stash',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'stash-probe-once');
      // Let the pre-push refs/stash probe pass, then fail the post-push
      // one: reading that failure as "no stash" would skip the restore
      // and report success with the edits stranded in refs/stash.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "rev-parse" ]; then\n` +
          `  for a in "$@"; do\n` +
          `    if [ "$a" = "refs/stash" ]; then\n` +
          `      if [ -e "${marker}" ]; then\n` +
          `        exit 128\n` +
          `      fi\n` +
          `      : > "${marker}"\n` +
          `    fi\n` +
          `  done\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      let thrown: unknown;
      let resolved: unknown;
      await withPathPrefix(shimDir, () => gitPull(dir, { stash: true })).then(
        (result) => {
          resolved = result;
        },
        (err) => {
          thrown = err;
        },
      );

      // The loud failure replaces a lying success report.
      expect(resolved).toBeUndefined();
      expect(thrown).toBeTruthy();
      // The push succeeded, so the edits exist inside the kept entry; the
      // error must carry the stash pointer like every sibling
      // restore-failure path.
      expect((thrown as Error).message).toContain(STASH_RESTORE_NOTE);
      // The push ran, so the edits are safe inside the kept entry; the
      // merge never started.
      expect(git(dir, 'stash', 'list', '--oneline')).toContain(
        'auto-stash before pull',
      );
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'flags the stash pointer when the post-push probe fails during a failed push',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'push-probe-once');
      // Let the pre-push refs/stash probe pass, fail the push itself, and
      // fail the post-push probe too: whether the failed push created an
      // entry is now unknown, so the refusal must carry the stash pointer
      // instead of leaking a bare probe error.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ]; then\n` +
          `  exit 1\n` +
          `fi\n` +
          `if [ "$1" = "rev-parse" ]; then\n` +
          `  for a in "$@"; do\n` +
          `    if [ "$a" = "refs/stash" ]; then\n` +
          `      if [ -e "${marker}" ]; then\n` +
          `        exit 128\n` +
          `      fi\n` +
          `      : > "${marker}"\n` +
          `    fi\n` +
          `  done\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'dirty_working_tree',
          stashRestoreFailed: true,
        }),
      );

      // The push failed before the worktree was reset; the edit stays.
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps both entries when a foreign stash appears before the success-path pop',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'new.txt'), 'incoming\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'foreign-stash-once');
      // A concurrent actor's stash lands at the top of refs/stash inside
      // the push→pop window: the restore must not apply and drop it in
      // place of this pull's own entry.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "merge" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  echo foreign-edit > foreign.txt\n` +
          `  "${realGit}" stash push -q --include-untracked -m "foreign stash"\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      expect(result.success).toBe(true);
      expect(result.stashRestoreConflict).toBe(true);
      expect(result.output).toContain(STASH_RESTORE_NOTE);
      // Both entries survive: the pull did not pop the foreign one, and
      // its own entry was not dropped behind the success report.
      const stashList = git(dir, 'stash', 'list', '--oneline');
      expect(stashList).toContain('auto-stash before pull');
      expect(stashList).toContain('foreign stash');
      // The merge landed; the local edit stays in the kept entry instead
      // of being replaced by the foreign one.
      expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe(
        'incoming\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
      expect(fs.existsSync(path.join(dir, 'foreign.txt'))).toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps both entries when a foreign stash appears before the failure-recovery pop',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      // Diverge: the merge conflicts, so the failure-recovery path runs.
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local committed\n');
      git(dir, 'commit', '-q', '-am', 'local commit');
      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'remote committed\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'foreign-stash-fail-once');
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "merge" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  echo foreign-edit > foreign.txt\n` +
          `  "${realGit}" stash push -q --include-untracked -m "foreign stash"\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'diverged',
          stashRestoreFailed: true,
        }),
      );

      const stashList = git(dir, 'stash', 'list', '--oneline');
      expect(stashList).toContain('auto-stash before pull');
      expect(stashList).toContain('foreign stash');
      // The abort restored HEAD's content; the untracked edit stays in
      // the kept auto-stash entry.
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local committed\n',
      );
      expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'foreign.txt'))).toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'merges the probed tip when @{u} moves during the update',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'ignore config.json');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      // T1: a harmless incoming commit, fetched and probed.
      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'new1.txt'), 'one\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'T1');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      // T2: a concurrent actor's tip that collides with the local ignored
      // file; pushed and fetched inside the update window.
      const actor = makeClone(remote);
      fs.writeFileSync(path.join(actor, 'config.json'), 'incoming\n');
      git(actor, 'add', '-f', 'config.json');
      git(actor, 'commit', '-q', '-m', 'T2');

      fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'tip-move-once');
      // Move the puller's @{u} to T2 at the start of the merge: the
      // update must still merge the probed tip, not the live @{u}.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "merge" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  (cd "${actor}" && "${realGit}" push -q origin HEAD)\n` +
          `  "${realGit}" fetch -q origin\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      expect(result.success).toBe(true);
      // T1 merged; the colliding T2 file never checked out over the
      // ignored one.
      expect(fs.readFileSync(path.join(dir, 'new1.txt'), 'utf8')).toBe('one\n');
      expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
        'local secret\n',
      );
      expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      const t2 = git(actor, 'rev-parse', 'HEAD').trim();
      expect(() =>
        git(dir, 'merge-base', '--is-ancestor', t2, 'HEAD'),
      ).toThrow();
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  // The POSIX shim below stands in for a concurrent actor pushing into
  // the push->attribution window; it has no Windows equivalent in this
  // suite.
  it.runIf(process.platform !== 'win32')(
    'keeps both entries when a terminal stash lands between the push and the identity probe',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 't2.txt'), 'committed\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add t2');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'terminal-stash-once');
      const t2 = path.join(dir, 't2.txt');
      // The user's terminal stashes its own edit right after the pull's
      // auto-stash pushed: the restore must not attribute the displaced
      // foreign entry as its own and apply-and-drop it in ours's place.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ] && [ ! -e "${marker}" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  status=$?\n` +
          `  : > "${marker}"\n` +
          `  printf 'terminal edit\\n' > "${t2}"\n` +
          `  "${realGit}" -C "${dir}" stash push -q -m 'terminal actor'\n` +
          `  exit $status\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      // The pull converges but the restore fails closed: with no
      // attributable identity the edits wait in the kept entry and the
      // pointer is shown, instead of the foreign entry being consumed.
      expect(result.success).toBe(true);
      expect(result.stashRestoreConflict).toBe(true);
      expect(result.output).toContain(STASH_RESTORE_NOTE);
      const list = git(dir, 'stash', 'list', '--oneline');
      expect(list).toContain('auto-stash before pull');
      expect(list).toContain('terminal actor');
      // Neither entry was applied or dropped.
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
      expect(fs.readFileSync(path.join(dir, 't2.txt'), 'utf8')).toBe(
        'committed\n',
      );
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    },
  );

  // The POSIX shim below stands in for a concurrent actor pushing into
  // the failed-push pop-back window; it has no Windows equivalent in
  // this suite.
  it.runIf(process.platform !== 'win32')(
    'keeps a displaced entry when the failed-push pop-back cannot attribute it',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 't2.txt'), 'committed\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add t2');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'failed-push-once');
      const t2 = path.join(dir, 't2.txt');
      // The push runs for real (creating the entry and moving the edits
      // out of the worktree), a terminal actor pushes its own entry on
      // top, and only then the push reports failure: the pop-back must
      // not apply and drop the actor's entry in ours's place.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ] && [ ! -e "${marker}" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  : > "${marker}"\n` +
          `  printf 'terminal edit\\n' > "${t2}"\n` +
          `  "${realGit}" -C "${dir}" stash push -q -m 'terminal actor'\n` +
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

      expect(thrown).toBeTruthy();
      expect((thrown as Error).message).toContain(STASH_RESTORE_NOTE);
      const list = git(dir, 'stash', 'list', '--oneline');
      expect(list).toContain('auto-stash before pull');
      expect(list).toContain('terminal actor');
      // The pop-back never ran on the displaced entry.
      expect(fs.readFileSync(path.join(dir, 't2.txt'), 'utf8')).toBe(
        'committed\n',
      );
    },
  );

  // The POSIX shim below stands in for a concurrent actor popping the
  // pull's own entry inside the restore window; it has no Windows
  // equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'keeps a foreign entry the terminal pops out of the restore window',
    async () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, 'z.txt'), 'z one\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'add z');
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'remote-only.txt'), 'remote\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      // The user's own older entry sits below the pull's auto-stash.
      fs.writeFileSync(path.join(dir, 'z.txt'), 'z user edit\n');
      git(dir, 'stash', 'push', '-q', '-m', 'user older');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'terminal-pop-once');
      // The terminal pops the pull's own entry inside the window between
      // the restore's identity check and its apply; the daemon must then
      // not apply and drop the exposed older entry behind a success.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "apply" ] && [ ! -e "${marker}" ]; then\n` +
          `  : > "${marker}"\n` +
          `  "${realGit}" -C "${dir}" stash pop -q\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      expect(result.success).toBe(true);
      expect(result.stashRestoreConflict).toBe(true);
      // The user's pop already restored the pull's own edits; the daemon
      // applied the exposed older entry but kept it instead of dropping
      // it behind a verified-success report.
      const list = git(dir, 'stash', 'list', '--oneline');
      expect(list).toContain('user older');
      expect(list).not.toContain('auto-stash before pull');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(fs.readFileSync(path.join(dir, 'z.txt'), 'utf8')).toBe(
        'z user edit\n',
      );
      expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
    },
  );

  // The POSIX shim below makes the restore's post-apply identity probe
  // unreadable; it has no Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'flags the restore when the post-apply identity probe fails',
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

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'post-apply-probe-once');
      // An unreadable refs/stash right after the apply (refs/stash lock
      // contention is likeliest in exactly this concurrent-actor window)
      // must report the restore as failed, matching the pre-check's
      // fail-closed polarity — not read as a verified successful restore.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "apply" ]; then\n` +
          `  : > "${marker}"\n` +
          `fi\n` +
          `if [ "$1" = "rev-parse" ] && [ -e "${marker}" ]; then\n` +
          `  for a in "$@"; do\n` +
          `    [ "$a" = "refs/stash" ] && exit 128\n` +
          `  done\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      const result = await withPathPrefix(shimDir, () =>
        gitPull(dir, { stash: true }),
      );

      // The apply ran, so the edits are in the worktree AND still in the
      // kept entry; the unreadable re-check reports the conflict instead
      // of a lying success.
      expect(result.success).toBe(true);
      expect(result.stashRestoreConflict).toBe(true);
      expect(git(dir, 'stash', 'list', '--oneline')).toContain(
        'auto-stash before pull',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
    },
  );

  // The POSIX shim below fails the collision probe on demand; it has no
  // Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'keeps a probe failure on a diverged dirty tree panel-recoverable',
    async () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      // Diverge the branch and dirty the tree.
      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'remote version\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote commit');
      git(clone, 'push', '-q', 'origin', 'HEAD');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local version\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'local commit');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "ls-files" ]; then\n` +
          `  exit 128\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      // A probe failure is not an update failure: the update was never
      // attempted, so the stash pull must not launder it into the
      // terminal-only diverged code — the stash option can still succeed
      // on a retry that passes the probe.
      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'dirty_working_tree',
        }),
      );
      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir)).rejects.toMatchObject({
          code: 'dirty_working_tree',
        }),
      );

      // The stash pull's probe failure popped the auto-stash back.
      expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
        'dirty edit\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local version\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');
    },
  );

  // The POSIX shim below stands in for a watcher creating an ignored file
  // while the auto-stash runs; it has no Windows equivalent in this suite.
  it.runIf(process.platform !== 'win32')(
    'refuses the merge when an ignored file appears while the stash runs',
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

      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

      const realGit = execFileSync('which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const marker = path.join(dir, '.git', 'watcher-once');
      const target = path.join(dir, 'config.json');
      // A dev server or build watcher writes an ignored artifact at the
      // incoming path during the multi-second stash phase; the probe must
      // snapshot the ignored set AFTER the stash, not before it, or the
      // merge silently checks the incoming file out over it.
      const shimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "stash" ] && [ "$2" = "push" ] && [ ! -e "${marker}" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  status=$?\n` +
          `  : > "${marker}"\n` +
          `  printf 'watcher secret\\n' > "${target}"\n` +
          `  exit $status\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );

      await withPathPrefix(shimDir, () =>
        expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
          code: 'ignored_collision',
        }),
      );

      // The refusal restores the dirty edit and keeps the watcher's file.
      expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
        'watcher secret\n',
      );
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'local edit\n',
      );
      expect(git(dir, 'stash', 'list').trim()).toBe('');

      // The force shape has the same window: `clean -fd` keeps ignored
      // files, so a watcher file created during the discard must still
      // refuse the merge via the just-in-time re-probe. Remove the file
      // first so the pre-discard probe sees a clean snapshot and only
      // the just-in-time one can catch the racing write.
      fs.rmSync(path.join(dir, 'config.json'));
      const cleanMarker = path.join(dir, '.git', 'watcher-clean-once');
      const cleanShimDir = installGitShim(
        `#!/bin/sh\n` +
          `if [ "$1" = "clean" ] && [ ! -e "${cleanMarker}" ]; then\n` +
          `  "${realGit}" "$@"\n` +
          `  status=$?\n` +
          `  : > "${cleanMarker}"\n` +
          `  printf 'watcher secret\\n' > "${target}"\n` +
          `  exit $status\n` +
          `fi\n` +
          `exec "${realGit}" "$@"\n`,
      );
      await withPathPrefix(cleanShimDir, () =>
        expect(gitPull(dir, { force: true })).rejects.toMatchObject({
          code: 'ignored_collision',
        }),
      );
      expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
        'watcher secret\n',
      );
    },
  );

  it('refuses a merge pull whose criss-cross bases hide the collision in one base', async () => {
    // A criss-cross history has several best common ancestors; the real
    // merge computes from their virtual merge, so diffing a single base
    // under-approximates the incoming set. The dates pin `merge-base`
    // (single) to the base that HIDES the path (git reports the newer of
    // two tied best ancestors), so only the union over every base sees
    // the collision.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranches-'));
    tmpRoots.push(dir);
    const dated = (date: string, ...args: string[]): string =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_COMMITTER_DATE: date },
      });
    git(dir, 'init', '-q', '-b', 'master');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'core.eol', 'lf');
    fs.writeFileSync(path.join(dir, 'F.txt'), 'base\n');
    git(dir, 'add', '.');
    dated('2020-01-01T00:00:00', 'commit', '-q', '-m', 'O');
    git(dir, 'checkout', '-q', '-b', 'lineA');
    fs.writeFileSync(path.join(dir, 'F.txt'), 'x\n');
    dated('2022-01-01T00:00:00', 'commit', '-q', '-am', 'X');
    git(dir, 'checkout', '-q', 'master');
    git(dir, 'checkout', '-q', '-b', 'lineB');
    fs.writeFileSync(path.join(dir, 'F.txt'), 'y\n');
    dated('2021-01-01T00:00:00', 'commit', '-q', '-am', 'Y');
    // Each line merges the other's pre-merge tip with `-s ours`: both
    // merges record the same two ancestors, making X and Y merge bases.
    git(dir, 'checkout', '-q', 'lineA');
    git(dir, 'merge', '-q', '-s', 'ours', '--no-edit', 'lineB');
    git(dir, 'checkout', '-q', 'lineB');
    git(dir, 'merge', '-q', '-s', 'ours', '--no-edit', 'lineA~1');
    // The tip changes F to match X's content: diff(X, tip) hides F while
    // diff(Y, tip) shows it.
    fs.writeFileSync(path.join(dir, 'F.txt'), 'x\n');
    git(dir, 'commit', '-q', '-am', 'Z');

    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'lineB');
    git(dir, 'checkout', '-q', 'lineA');
    git(dir, 'branch', '--set-upstream-to', 'origin/lineB', 'lineA');

    // Locally delete F and keep user content at the path, ignored.
    git(dir, 'rm', '-q', 'F.txt');
    git(dir, 'commit', '-q', '-m', 'delete F');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'F.txt\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore F');
    fs.writeFileSync(path.join(dir, 'F.txt'), 'user content\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    // Fixture sanity: a criss-cross carries two best common ancestors.
    expect(
      git(dir, 'merge-base', '--all', 'HEAD', '@{u}').trim().split('\n'),
    ).toHaveLength(2);

    let thrown: unknown;
    await gitPull(dir).catch((err) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ code: 'ignored_collision' });
    expect((thrown as Error).message).toContain('F.txt');

    expect(fs.readFileSync(path.join(dir, 'F.txt'), 'utf8')).toBe(
      'user content\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('surfaces a re-rooted upstream instead of dead-ending on the probe', async () => {
    // A force push onto a brand-new root leaves no common ancestor:
    // `merge-base --all` exits 1 printing nothing. That is its legitimate
    // answer, not a probe failure — the empty-tree fallback (the unborn
    // arm's model of the same state) lets the update run and surface
    // git's own diagnostic instead of refusing with a blank message.
    const makeFixture = () => {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
      const clone = makeClone(remote);
      git(clone, 'checkout', '-q', '--orphan', 'newroot');
      git(clone, 'rm', '-q', '-rf', '.');
      fs.writeFileSync(path.join(clone, 'b.txt'), 'fresh root\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'fresh root');
      git(clone, 'push', '-q', '-f', 'origin', 'newroot:master');
      return dir;
    };

    // The merge shapes surface git's own unrelated-histories fatal
    // instead of a blank refusal.
    const plainDir = makeFixture();
    let plainThrown: unknown;
    await gitPull(plainDir).catch((err) => {
      plainThrown = err;
    });
    expect(plainThrown).toMatchObject({ code: 'diverged' });
    expect((plainThrown as Error).message).toContain('unrelated histories');

    // The stash shape restores the auto-stash on the way down.
    const stashDir = makeFixture();
    fs.writeFileSync(path.join(stashDir, 'a.txt'), 'local edit\n');
    let stashThrown: unknown;
    await gitPull(stashDir, { stash: true }).catch((err) => {
      stashThrown = err;
    });
    expect(stashThrown).toMatchObject({ code: 'diverged' });
    expect((stashThrown as Error).message).toContain('unrelated histories');
    expect(fs.readFileSync(path.join(stashDir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(stashDir, 'stash', 'list').trim()).toBe('');

    // The rebase shape replays the local commits onto the new root.
    const rebaseDir = makeFixture();
    const result = await gitPull(rebaseDir, { rebase: true });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(rebaseDir, 'b.txt'), 'utf8')).toBe(
      'fresh root\n',
    );
    expect(fs.readFileSync(path.join(rebaseDir, 'a.txt'), 'utf8')).toBe(
      'one\n',
    );
  });

  it('refuses a non-ASCII case-variant collision when the repository folds case', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'caf\u00e9-notes.md\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore the non-ascii notes');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'caf\u00c9-notes.md'), 'incoming\n');
    git(clone, 'add', '-f', 'caf\u00c9-notes.md');
    git(clone, 'commit', '-q', '-m', 'add the uppercase-variant notes');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // core.ignorecase=true is the default on the case-folding
    // filesystems (APFS/NTFS). The byte-mapped fold covers ASCII only,
    // so the probe must also fold decoded UTF-8 to catch non-ASCII
    // case-variant collisions.
    git(dir, 'config', 'core.ignorecase', 'true');
    fs.writeFileSync(path.join(dir, 'caf\u00e9-notes.md'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'caf\u00e9-notes.md'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('refuses a case-fold collision that only up-then-low folding maps together', async () => {
    // ς/σ (like µ/μ) are distinct under Unicode lowercase mapping but one
    // file on the case-folding filesystems this probe exists for: the
    // NTFS/APFS tables fold them together, so the probe's fold must.
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'final-\u03c3.md\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore the final notes');
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = makeClone(remote);
    fs.writeFileSync(path.join(clone, 'final-\u03c2.md'), 'incoming\n');
    git(clone, 'add', '-f', 'final-\u03c2.md');
    git(clone, 'commit', '-q', '-m', 'add the sigma-variant notes');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    git(dir, 'config', 'core.ignorecase', 'true');
    fs.writeFileSync(path.join(dir, 'final-\u03c3.md'), 'local secret\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true })).rejects.toMatchObject({
      code: 'ignored_collision',
    });

    expect(fs.readFileSync(path.join(dir, 'final-\u03c3.md'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });
});
describe('gitPull fixture line endings', () => {
  it('pins fixture line endings against ambient config only the product channel reads', async () => {
    // gitEnv() strips GIT_CONFIG_GLOBAL/SYSTEM, so ambient global config
    // reaches the product's git but not the fixture helpers — the channel
    // asymmetry that made the Windows runners' system core.autocrlf=true
    // rewrite the fixtures' LF-pinned files. Plant the hermetic HOME's
    // global config, which only the product channel reads, to stand in for
    // that host config on every platform: the fixture repos' repo-local
    // pin must outrank it or the merge checks the incoming file out CRLF.
    const ambient = path.join(hermeticHome, '.gitconfig');
    fs.writeFileSync(ambient, '[core]\n\tautocrlf = true\n');
    try {
      const dir = makeRepo();
      const remote = makeBareRemote();
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

      const clone = makeClone(remote);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-q', '-m', 'remote edit');
      git(clone, 'push', '-q', 'origin', 'HEAD');

      await expect(gitPull(dir, {})).resolves.toMatchObject({
        success: true,
      });

      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
        'remote edit\n',
      );
    } finally {
      fs.rmSync(ambient);
    }
  });
});

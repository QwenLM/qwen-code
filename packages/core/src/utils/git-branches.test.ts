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
  GitPullFailure,
  gitPush,
  isValidCheckoutRef,
  parseDroppedStashSha,
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

/**
 * Workspace `dir` tracking a bare remote, plus a second clone standing in
 * for another developer. Both repositories pin `pull.rebase` so a diverged
 * pull merges instead of depending on whatever the host's git policy is.
 */
function makeUpstream(): { dir: string; clone: string } {
  const dir = makeRepo();
  const remote = makeBareRemote();
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'config', 'pull.rebase', 'false');
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitclone-'));
  tmpRoots.push(clone);
  git(clone, 'clone', '-q', remote, '.');
  git(clone, 'config', 'user.email', 'other@example.com');
  git(clone, 'config', 'user.name', 'Other');
  git(clone, 'config', 'commit.gpgsign', 'false');
  return { dir, clone };
}

function commitFile(cwd: string, file: string, content: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return headSha(cwd);
}

function remoteCommit(clone: string, file: string, content: string): void {
  // The workspace may have pushed since the clone was made.
  git(clone, 'pull', '-q', '--ff-only');
  commitFile(clone, file, content);
  git(clone, 'push', '-q', 'origin', 'HEAD');
}

function stashList(cwd: string): string[] {
  return git(cwd, 'stash', 'list')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function read(cwd: string, file: string): string {
  return fs.readFileSync(path.join(cwd, file), 'utf8');
}

/**
 * The code under test honors HOME/XDG config (gitEnv only strips the
 * GIT_CONFIG_* overrides), so point both at an empty directory: the host's
 * `~/.gitconfig` must not decide how these merges behave.
 */
function hermeticEnv(): Record<string, string | undefined> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-githome-'));
  tmpRoots.push(home);
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
}

/**
 * A `git` on PATH that runs the real binary but lets a test inject a
 * terminal's actions immediately before or after one specific invocation
 * (matched against the joined argument list). This is how the concurrent
 * interleavings the flows must survive are produced deterministically.
 */
function gitShim(
  env: Record<string, string | undefined>,
  hooks: ReadonlyArray<{
    match: string;
    before?: string;
    after?: string;
    /** Raw case body run instead of the real git (must exit itself). */
    script?: string;
  }>,
): Record<string, string | undefined> {
  const real = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
    env: process.env,
  }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitshim-'));
  tmpRoots.push(dir);
  const cases = hooks
    .map((h) =>
      h.script
        ? `  ${h.match}) ${h.script} ;;`
        : `  ${h.match}) ${h.before ?? ':'}; "$REAL" "$@"; rc=$?; ${h.after ?? ':'}; exit $rc ;;`,
    )
    .join('\n');
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\nREAL="${real}"\ncase "$*" in\n${cases}\nesac\nexec "$REAL" "$@"\n`,
  );
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { ...env, PATH: `${dir}:${env['PATH'] ?? process.env['PATH']}` };
}

async function expectPullFailure(
  promise: Promise<unknown>,
  code: GitPullFailure['code'],
): Promise<GitPullFailure> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GitPullFailure);
  expect((caught as GitPullFailure).code).toBe(code);
  return caught as GitPullFailure;
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

describe('fetchGitBranches push-side tracking', () => {
  it('reports the push target and its counts in a triangular workflow', async () => {
    const dir = makeRepo();
    const upstreamRemote = makeBareRemote();
    const originRemote = makeBareRemote();
    git(dir, 'remote', 'add', 'upstream', upstreamRemote);
    git(dir, 'remote', 'add', 'origin', originRemote);
    git(dir, 'push', '-q', '-u', 'upstream', 'master');
    git(dir, 'config', 'branch.master.pushRemote', 'origin');
    git(dir, 'push', '-q', 'origin', 'master');
    // Local gains one commit (ahead of origin), upstream gains one via a
    // second clone (local behind upstream) — the fork-workflow shape.
    fs.writeFileSync(path.join(dir, 'local.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitother-'));
    tmpRoots.push(other);
    git(other, 'clone', '-q', upstreamRemote, 'c');
    const clone = path.join(other, 'c');
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'Test');
    git(clone, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(clone, 'up.txt'), 'y\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'up');
    git(clone, 'push', '-q', 'origin', 'master');
    git(dir, 'fetch', '-q', 'upstream');

    // Under the default `push.default=simple`, git refuses to resolve
    // `@{push}` in a triangular repo even though a plain `git push`
    // succeeds — the listing reports configured-but-unknown.
    const simpleHead = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'master',
    );
    expect(simpleHead?.upstream).toBe('upstream/master');
    expect(simpleHead?.behind).toBe(1);
    expect(simpleHead?.pushTarget).toBeUndefined();
    expect(simpleHead?.pushConfigured).toBe(true);

    // With a resolvable push.default the push-side counts come through.
    git(dir, 'config', 'push.default', 'current');
    const head = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'master',
    );
    expect(head?.pushTarget).toBe('origin/master');
    expect(head?.pushAhead).toBe(1);
    expect(head?.pushBehind).toBe(0);
    expect(head?.pushGone).toBeUndefined();
    expect(head?.pushConfigured).toBe(true);
  });

  it('marks a resolvable push destination whose ref is missing as pushGone', async () => {
    const dir = makeRepo();
    const upstreamRemote = makeBareRemote();
    const originRemote = makeBareRemote();
    git(dir, 'remote', 'add', 'upstream', upstreamRemote);
    git(dir, 'remote', 'add', 'origin', originRemote);
    git(dir, 'push', '-q', '-u', 'upstream', 'master');
    git(dir, 'config', 'branch.master.pushRemote', 'origin');
    git(dir, 'config', 'push.default', 'current');
    // Never pushed to origin: the push destination resolves by config but
    // its ref does not exist — `git push` would create it.
    const head = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'master',
    );
    expect(head?.pushTarget).toBe('origin/master');
    expect(head?.pushGone).toBe(true);
    expect(head?.pushAhead).toBeUndefined();
    expect(head?.pushBehind).toBeUndefined();
  });

  it('reports the upstream itself as push target in the plain clone shape', async () => {
    const dir = makeRepo();
    const remote = makeBareRemote();
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'master');
    const head = (await fetchGitBranches(dir)).local.find(
      (b) => b.name === 'master',
    );
    expect(head?.pushTarget).toBe('origin/master');
    expect(head?.pushAhead).toBe(0);
    expect(head?.pushBehind).toBe(0);
    expect(head?.pushConfigured).toBeUndefined();
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

describe('gitPull with a dirty working tree', () => {
  it('a plain pull on a dirty tree is still refused by git, unchanged', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');

    await expect(gitPull(dir, undefined, hermeticEnv())).rejects.toThrow(
      /would be overwritten/,
    );
    expect(read(dir, 'a.txt')).toBe('local\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('stash pull updates a dirty tree and restores tracked edits and untracked files', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
    const headBefore = headSha(dir);

    const result = await gitPull(dir, { stash: true }, hermeticEnv());

    expect(result.success).toBe(true);
    expect(result.stashRestoreConflict).toBeUndefined();
    expect(headSha(dir)).not.toBe(headBefore);
    expect(read(dir, 'remote-only.txt')).toBe('remote\n');
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    expect(read(dir, 'b.txt')).toBe('untracked\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('stash pull with nothing to stash is a plain pull', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');

    const result = await gitPull(dir, { stash: true }, hermeticEnv());

    expect(result.success).toBe(true);
    expect(read(dir, 'remote-only.txt')).toBe('remote\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('stash pull with rebase replays the local commit and restores the edits', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    commitFile(dir, 'local-only.txt', 'local\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const result = await gitPull(
      dir,
      { stash: true, rebase: true },
      hermeticEnv(),
    );

    expect(result.success).toBe(true);
    expect(read(dir, 'remote-only.txt')).toBe('remote\n');
    expect(read(dir, 'local-only.txt')).toBe('local\n');
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    // Linear history: the local commit was replayed, not merged.
    expect(git(dir, 'rev-list', '--merges', 'HEAD').trim()).toBe('');
    expect(stashList(dir)).toEqual([]);
  });

  it('stash pull reports a conflicting restore and keeps the stash entry', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');
    const headBefore = headSha(dir);

    const result = await gitPull(dir, { stash: true }, hermeticEnv());

    expect(result.success).toBe(true);
    expect(result.stashRestoreConflict).toBe(true);
    expect(headSha(dir)).not.toBe(headBefore);
    const entries = stashList(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('qwen-code: auto-stash before pull');
    const sha = git(dir, 'rev-parse', 'refs/stash').trim();
    expect(result.stashSha).toBe(sha);
    expect(result.output).toContain(sha);
    // The entry still carries the local edit.
    expect(git(dir, 'stash', 'show', '-p', sha)).toContain('+local');
  });

  it('stash pull restores the pre-pull state when the update fails', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    commitFile(dir, 'a.txt', 'local commit\n');
    commitFile(dir, 'd.txt', 'd\n');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'd.txt'), 'dirty d\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(failure.message).toContain('your local changes were restored');
    expect(failure.message).toContain('CONFLICT');
    expect(headSha(dir)).toBe(headBefore);
    expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(read(dir, 'a.txt')).toBe('local commit\n');
    expect(read(dir, 'd.txt')).toBe('dirty d\n');
    expect(read(dir, 'c.txt')).toBe('untracked\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('stash pull aborts the rebase it started when the replay conflicts', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    commitFile(dir, 'a.txt', 'local commit\n');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');

    await expectPullFailure(
      gitPull(dir, { stash: true, rebase: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(headSha(dir)).toBe(headBefore);
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-apply'))).toBe(false);
    expect(read(dir, 'a.txt')).toBe('local commit\n');
    expect(read(dir, 'c.txt')).toBe('untracked\n');
    expect(stashList(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'stash pull restores its own entry when another stash was pushed meanwhile',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
      // A post-merge hook stands in for a terminal pushing to the shared
      // refs/stash while the pull runs.
      const hook = path.join(dir, '.git', 'hooks', 'post-merge');
      fs.writeFileSync(
        hook,
        '#!/bin/sh\necho foreign > foreign.txt\ngit stash push -u -q -m foreign-entry\n',
      );
      fs.chmodSync(hook, 0o755);

      const result = await gitPull(dir, { stash: true }, hermeticEnv());

      expect(result.success).toBe(true);
      expect(result.stashRestoreConflict).toBeUndefined();
      expect(read(dir, 'a.txt')).toBe('local edit\n');
      // Only the foreign entry remains; ours was applied and dropped by
      // identity even though it was no longer on top.
      const entries = stashList(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain('foreign-entry');
      expect(fs.existsSync(path.join(dir, 'foreign.txt'))).toBe(false);
    },
  );

  it('stash pull fails with the missing-upstream message before stashing', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    await expect(gitPull(dir, { stash: true }, hermeticEnv())).rejects.toThrow(
      /no upstream/i,
    );
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('force pull discards local changes, keeps ignored files, and updates', async () => {
    const { dir, clone } = makeUpstream();
    commitFile(dir, '.gitignore', 'build/\n');
    git(dir, 'push', '-q', 'origin', 'HEAD');
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'out.txt'), 'artifact\n');

    const result = await gitPull(dir, { force: true }, hermeticEnv());

    expect(result.success).toBe(true);
    expect(read(dir, 'remote-only.txt')).toBe('remote\n');
    expect(read(dir, 'a.txt')).toBe('one\n');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
    expect(read(dir, 'build/out.txt')).toBe('artifact\n');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  });

  it('force pull refuses a diverged branch before discarding anything', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    commitFile(dir, 'local-only.txt', 'local\n');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');

    await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'diverged',
    );

    expect(headSha(dir)).toBe(headBefore);
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    expect(read(dir, 'b.txt')).toBe('untracked\n');
  });

  it('force pull from a repository subdirectory refuses without discarding', async () => {
    const { dir, clone } = makeUpstream();
    commitFile(dir, 'packages/app/index.txt', 'app\n');
    git(dir, 'push', '-q', 'origin', 'HEAD');
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'outside edit\n');
    fs.writeFileSync(path.join(dir, 'packages/app/index.txt'), 'inside edit\n');

    await expectPullFailure(
      gitPull(
        path.join(dir, 'packages', 'app'),
        { force: true },
        hermeticEnv(),
      ),
      'force_unsupported',
    );

    expect(read(dir, 'a.txt')).toBe('outside edit\n');
    expect(read(dir, 'packages/app/index.txt')).toBe('inside edit\n');
  });

  it('rejects combining stash and force', async () => {
    const dir = makeRepo();
    await expect(gitPull(dir, { stash: true, force: true })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects combining fetchOnly with stash or force instead of dropping them', async () => {
    const dir = makeRepo();
    await expect(
      gitPull(dir, { fetchOnly: true, stash: true }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(
      gitPull(dir, { fetchOnly: true, force: true }),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('types the refusal on a detached HEAD without touching anything', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    const headBefore = headSha(dir);

    const stash = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'pull_failed',
    );
    await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(stash.message).toContain('HEAD is detached');
    expect(headSha(dir)).toBe(headBefore);
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('refuses stash and force pulls while a merge is in progress, keeping it', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    commitFile(dir, 'a.txt', 'local commit\n');
    git(dir, 'fetch', '-q');
    expect(() => git(dir, 'merge', '--no-edit', '@{upstream}')).toThrow();
    // Resolve the conflict but leave the merge uncommitted: this staged
    // resolution lives only in MERGE_HEAD, which a stash or reset would drop.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    git(dir, 'add', 'a.txt');
    const mergeHead = git(dir, 'rev-parse', 'MERGE_HEAD').trim();

    await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'operation_in_progress',
    );
    await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'operation_in_progress',
    );

    expect(git(dir, 'rev-parse', 'MERGE_HEAD').trim()).toBe(mergeHead);
    expect(read(dir, 'a.txt')).toBe('resolved\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('refuses a stash pull while a rebase is stopped, keeping the edits', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    commitFile(dir, 'a.txt', 'local commit\n');
    git(dir, 'fetch', '-q');
    expect(() => git(dir, 'rebase', '@{upstream}')).toThrow();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'operation_in_progress',
    );

    expect(failure.message).toContain('rebase');
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(true);
    expect(read(dir, 'b.txt')).toBe('untracked\n');
    expect(stashList(dir)).toEqual([]);
  });
});

describe('gitPull dirty-tree flows against a concurrent terminal', () => {
  const unix = process.platform !== 'win32';

  it('parses the SHA git reports for a dropped entry', () => {
    expect(
      parseDroppedStashSha(
        'Dropped refs/stash@{1} (2ea0b3d3f5c1a4c8e0b2d6f7a9c1e3b5d7f9a1c3)\n',
      ),
    ).toBe('2ea0b3d3f5c1a4c8e0b2d6f7a9c1e3b5d7f9a1c3');
    expect(parseDroppedStashSha('')).toBeUndefined();
  });

  it.skipIf(!unix)(
    'captures its own entry by provenance when a terminal pushes right after it',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
      const env = gitShim(hermeticEnv(), [
        {
          match: '"stash push"*',
          after:
            'echo foreign > foreign.txt; "$REAL" stash push -u -q -m foreign-terminal',
        },
      ]);

      const result = await gitPull(dir, { stash: true }, env);

      expect(result.success).toBe(true);
      expect(result.stashRestoreConflict).toBeUndefined();
      expect(read(dir, 'a.txt')).toBe('local edit\n');
      expect(fs.existsSync(path.join(dir, 'foreign.txt'))).toBe(false);
      const entries = stashList(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain('foreign-terminal');
    },
  );

  it.skipIf(!unix)(
    'keeps the other entry when the stash shifts between slot lookup and drop',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
      const env = gitShim(hermeticEnv(), [
        {
          match: '"stash drop"*',
          // Only the terminal's own file goes into its entry; our restored
          // edit must stay in the tree.
          before:
            'echo shift > shift.txt; "$REAL" stash push -u -q -m foreign-shift -- shift.txt',
        },
      ]);

      const result = await gitPull(dir, { stash: true }, env);

      expect(result.success).toBe(true);
      expect(result.output).toContain('was kept');
      // Structured, so the client renders the notice sticky.
      expect(result.stashKept).toBe(true);
      expect(result.stashSha).toBe(
        git(dir, 'rev-parse', 'refs/stash^{commit}').trim() === ''
          ? undefined
          : result.stashSha,
      );
      expect(read(dir, 'a.txt')).toBe('local edit\n');
      const entries = stashList(dir);
      expect(entries).toHaveLength(2);
      expect(entries.join('\n')).toContain('foreign-shift');
      expect(entries.join('\n')).toContain('qwen-code: auto-stash before pull');
    },
  );

  it.skipIf(!unix)(
    'leaves a merge a terminal parked mid-pull alone and reports the entry as kept',
    async () => {
      const { dir, clone } = makeUpstream();
      git(dir, 'branch', 'topic');
      git(dir, 'checkout', '-q', 'topic');
      commitFile(dir, 'a.txt', 'topic\n');
      const topicSha = headSha(dir);
      git(dir, 'checkout', '-q', 'master');
      commitFile(dir, 'a.txt', 'main side\n');
      git(dir, 'push', '-q', 'origin', 'HEAD');
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
      const env = gitShim(hermeticEnv(), [
        // The terminal starts a conflicting merge after the stash and before
        // the pull runs; the pull then fails on "not concluded your merge".
        { match: 'pull*', before: '"$REAL" merge topic >/dev/null 2>&1' },
      ]);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      expect(failure.message).toContain('kept in stash entry');
      expect(git(dir, 'rev-parse', 'MERGE_HEAD').trim()).toBe(topicSha);
      expect(stashList(dir)).toHaveLength(1);
    },
  );

  it.skipIf(!unix)(
    'force pull integrates the validated tip even when the remote moves after the check',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      const validated = git(clone, 'rev-parse', 'HEAD').trim();
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
      const env = gitShim(hermeticEnv(), [
        {
          match: '"merge-base --is-ancestor"*',
          // A teammate rewrites the branch AND the workspace fetches it
          // (a terminal, or a fetchOnly request) before the discard runs.
          after: `cd "${clone}" && "$REAL" checkout -q --orphan rewritten && "$REAL" commit -q -m rewritten && "$REAL" push -q -f origin HEAD:master && cd "${dir}" && "$REAL" fetch -q --prune`,
        },
      ]);

      const result = await gitPull(dir, { force: true }, env);

      expect(result.success).toBe(true);
      // The interleaving really happened: the remote branch is rewritten…
      expect(git(clone, 'rev-parse', 'HEAD').trim()).not.toBe(validated);
      expect(git(dir, 'rev-parse', 'origin/master').trim()).not.toBe(validated);
      // …and the update still landed on the commit the check validated.
      expect(headSha(dir)).toBe(validated);
      expect(read(dir, 'remote-only.txt')).toBe('remote\n');
      expect(git(dir, 'status', '--porcelain').trim()).toBe('');
    },
  );

  it('force pull refuses when the upstream branch was deleted on the remote', async () => {
    const { dir, clone } = makeUpstream();
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'feature.txt', 'f\n');
    git(dir, 'push', '-q', '-u', 'origin', 'feature');
    git(clone, 'push', '-q', 'origin', '--delete', 'feature');
    const headBefore = headSha(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');

    const failure = await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(failure.message).toContain('no longer exists');
    expect(headSha(dir)).toBe(headBefore);
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    expect(read(dir, 'b.txt')).toBe('untracked\n');
  });

  it('stash pull with nothing to stash still aborts and types a conflicting update', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    commitFile(dir, 'a.txt', 'local commit\n');
    const headBefore = headSha(dir);

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(failure.message).toContain('CONFLICT');
    expect(headSha(dir)).toBe(headBefore);
    expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(read(dir, 'a.txt')).toBe('local commit\n');
  });

  it('stash pull types the refusal when edits hidden by skip-worktree block the update', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hidden edit\n');
    git(dir, 'update-index', '--skip-worktree', 'a.txt');

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(failure.message).toContain('update failed');
    expect(read(dir, 'a.txt')).toBe('hidden edit\n');
    expect(stashList(dir)).toEqual([]);
  });

  it('stash pull types the refusal when git cannot stash an intent-to-add entry', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    git(dir, 'add', '-N', 'new.txt');
    const headBefore = headSha(dir);

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(failure.message).toContain('cannot stash the local changes');
    expect(headSha(dir)).toBe(headBefore);
    expect(read(dir, 'a.txt')).toBe('local edit\n');
    expect(read(dir, 'new.txt')).toBe('new\n');
    expect(stashList(dir)).toEqual([]);
  });

  it.skipIf(!unix)(
    'reports the kept entry when a failed update cannot restore the stash',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'a.txt', 'remote\n');
      commitFile(dir, 'a.txt', 'local commit\n');
      fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');
      const env = gitShim(hermeticEnv(), [
        // After the pull's merge is aborted, an untracked file appears at a
        // path the stash holds, so `stash apply` refuses to overwrite it.
        { match: '"merge --abort"*', after: 'echo clash > c.txt' },
      ]);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      expect(failure.message).toContain('could not be restored automatically');
      const entries = stashList(dir);
      expect(entries).toHaveLength(1);
      const sha = git(dir, 'rev-parse', 'refs/stash').trim();
      expect(failure.message).toContain(sha);
      expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    },
  );

  it('refuses stash and force pulls while a cherry-pick is parked, keeping it', async () => {
    const { dir } = makeUpstream();
    git(dir, 'branch', 'topic');
    git(dir, 'checkout', '-q', 'topic');
    commitFile(dir, 'a.txt', 'topic\n');
    git(dir, 'checkout', '-q', 'master');
    commitFile(dir, 'a.txt', 'main side\n');
    expect(() => git(dir, 'cherry-pick', 'topic')).toThrow();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    git(dir, 'add', 'a.txt');
    const pickHead = git(dir, 'rev-parse', 'CHERRY_PICK_HEAD').trim();

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'operation_in_progress',
    );
    await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'operation_in_progress',
    );

    expect(failure.message).toContain('cherry-pick');
    expect(git(dir, 'rev-parse', 'CHERRY_PICK_HEAD').trim()).toBe(pickHead);
    expect(read(dir, 'a.txt')).toBe('resolved\n');
  });

  it.skipIf(!unix)(
    'leaves a same-tip merge a terminal parked before the pull alone',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'a.txt', 'remote\n');
      commitFile(dir, 'a.txt', 'local commit\n');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
      // The terminal merges the very tip the pull is about to integrate,
      // resolves the conflict and stages it; git then refuses the pull with
      // exit 128 before touching the tree.
      const env = gitShim(hermeticEnv(), [
        {
          match: 'pull*',
          before:
            '"$REAL" merge @{upstream} >/dev/null 2>&1; printf "resolved\\n" > a.txt; "$REAL" add a.txt',
        },
      ]);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      // git refused the pull (exit 128) without touching the tree, so the
      // recovery leaves the terminal's merge and its staged resolution
      // exactly as they were; the untracked file is put back beside them.
      expect(failure.message).toContain('merge');
      expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
      expect(read(dir, 'a.txt')).toBe('resolved\n');
      expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('a.txt');
      expect(read(dir, 'b.txt')).toBe('untracked\n');
      expect(stashList(dir)).toEqual([]);
    },
  );

  it.skipIf(!unix)(
    'types the failure and names the entry when the auto-stash cannot be re-listed',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
      const mark = path.join(dir, '.git', 'pushed.mark');
      const env = gitShim(hermeticEnv(), [
        { match: '"stash push"*', after: `: > "${mark}"` },
        {
          match: '"stash list"*',
          script: `if [ -f "${mark}" ]; then exit 128; fi; exec "$REAL" "$@"`,
        },
      ]);
      const headBefore = headSha(dir);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      expect(failure.message).toContain('qwen-code: auto-stash before pull');
      expect(failure.message).toContain('was not attempted');
      expect(stashList(dir)).toHaveLength(1);
      // The update was never attempted: HEAD must not have advanced to the
      // reachable upstream commit.
      expect(headSha(dir)).toBe(headBefore);
    },
  );

  it.skipIf(!unix)(
    'still types a failed update when the recovery listing fails',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'a.txt', 'remote\n');
      commitFile(dir, 'a.txt', 'local commit\n');
      fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');
      const mark = path.join(dir, '.git', 'pulled.mark');
      const env = gitShim(hermeticEnv(), [
        { match: 'pull*', after: `: > "${mark}"` },
        {
          match: '"stash list"*',
          script: `if [ -f "${mark}" ]; then exit 128; fi; exec "$REAL" "$@"`,
        },
      ]);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      const sha = git(dir, 'rev-parse', 'refs/stash').trim();
      expect(failure.message).toContain('your local changes were restored');
      expect(failure.message).toContain(sha);
      expect(read(dir, 'c.txt')).toBe('untracked\n');
      expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    },
  );

  it.skipIf(!unix)(
    'names the displaced entry when storing it back fails after a drop shift',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
      const env = gitShim(hermeticEnv(), [
        {
          match: '"stash drop"*',
          before:
            'echo shift > shift.txt; "$REAL" stash push -u -q -m foreign-shift -- shift.txt',
        },
        { match: '"stash store"*', script: 'exit 1' },
      ]);

      const result = await gitPull(dir, { stash: true }, env);

      expect(result.success).toBe(true);
      expect(read(dir, 'a.txt')).toBe('local edit\n');
      // Ours survived; the foreign entry is gone from the stack but named
      // by SHA, with the command that brings it back.
      const entries = stashList(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain('qwen-code: auto-stash before pull');
      expect(result.stashKept).toBe(true);
      const match = /git stash store ([0-9a-f]{40})/.exec(result.output);
      expect(match).not.toBeNull();
      expect(git(dir, 'cat-file', '-t', match![1]!).trim()).toBe('commit');
    },
  );

  it.skipIf(!unix)(
    'carries the drop diagnostic when a failed update restores but cannot drop',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'a.txt', 'remote\n');
      commitFile(dir, 'a.txt', 'local commit\n');
      fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');
      const env = gitShim(hermeticEnv(), [
        {
          match: '"stash drop"*',
          script: 'echo "error: cannot lock ref refs/stash" >&2; exit 1',
        },
      ]);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      const sha = git(dir, 'rev-parse', 'refs/stash').trim();
      expect(failure.message).toContain('could not be dropped');
      expect(failure.message).toContain(sha);
      expect(read(dir, 'c.txt')).toBe('untracked\n');
    },
  );

  it('types the refusal with a lock hint when the index is wedged', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'pull_failed',
    );

    expect(failure.message).toContain('cannot stash the local changes');
    expect(failure.message.toLowerCase()).toContain('lock');
    expect(read(dir, 'a.txt')).toBe('local edit\n');
  });

  it('pulls again once a pruned upstream branch is recreated on the remote', async () => {
    const { dir, clone } = makeUpstream();
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'feature.txt', 'f\n');
    git(dir, 'push', '-q', '-u', 'origin', 'feature');
    // The teammate has the branch before it is deleted on the remote.
    git(clone, 'fetch', '-q', 'origin', 'feature');
    git(clone, 'push', '-q', 'origin', '--delete', 'feature');
    git(dir, 'fetch', '-q', '--prune');
    expect(() => git(dir, 'rev-parse', '@{upstream}')).toThrow();
    // A teammate recreates the branch with a new commit on top of ours.
    git(clone, 'checkout', '-q', '-b', 'feature', 'FETCH_HEAD');
    commitFile(clone, 'more.txt', 'more\n');
    git(clone, 'push', '-q', 'origin', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');

    const stash = await gitPull(dir, { stash: true }, hermeticEnv());
    expect(stash.success).toBe(true);
    expect(read(dir, 'more.txt')).toBe('more\n');
    expect(read(dir, 'a.txt')).toBe('local edit\n');

    // And the force path heals the same way.
    git(clone, 'push', '-q', 'origin', '--delete', 'feature');
    git(dir, 'fetch', '-q', '--prune');
    commitFile(clone, 'even-more.txt', 'x\n');
    git(clone, 'push', '-q', 'origin', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'discard me\n');
    const force = await gitPull(dir, { force: true }, hermeticEnv());
    expect(force.success).toBe(true);
    expect(read(dir, 'even-more.txt')).toBe('x\n');
    expect(read(dir, 'a.txt')).toBe('one\n');
  });

  it.skipIf(!unix)(
    'aborts and restores when the pull is killed mid-integration',
    async () => {
      const { dir, clone } = makeUpstream();
      remoteCommit(clone, 'a.txt', 'remote\n');
      commitFile(dir, 'a.txt', 'local commit\n');
      const headBefore = headSha(dir);
      fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n');
      // The pull writes its conflicted MERGE_HEAD and then dies the way a
      // timeout kill arrives: by signal, with no numeric exit code.
      const env = gitShim(hermeticEnv(), [
        {
          match: 'pull*',
          script:
            '"$REAL" fetch -q; "$REAL" merge @{upstream} >/dev/null 2>&1; kill -TERM $$',
        },
      ]);

      const failure = await expectPullFailure(
        gitPull(dir, { stash: true }, env),
        'pull_failed',
      );

      expect(failure.message).toContain('your local changes were restored');
      expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(headSha(dir)).toBe(headBefore);
      expect(read(dir, 'a.txt')).toBe('local commit\n');
      expect(read(dir, 'c.txt')).toBe('untracked\n');
      expect(stashList(dir)).toEqual([]);
    },
  );

  it('types the force failure when a skip-worktree file blocks the validated update', async () => {
    const { dir, clone } = makeUpstream();
    remoteCommit(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hidden edit\n');
    git(dir, 'update-index', '--skip-worktree', 'a.txt');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
    const headBefore = headSha(dir);

    const failure = await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'pull_failed',
    );

    // Typed, so the route cannot re-classify it as dirty_working_tree and
    // loop the panel on a discard that can never succeed.
    expect(failure.message).toContain('discard applied, but the update failed');
    expect(headSha(dir)).toBe(headBefore);
    expect(read(dir, 'a.txt')).toBe('hidden edit\n');
  });

  it('refuses stash and force pulls while a git am is stopped, keeping it', async () => {
    const { dir } = makeUpstream();
    git(dir, 'checkout', '-q', '-b', 'series');
    commitFile(dir, 'a.txt', 'series 1\n');
    commitFile(dir, 'a.txt', 'series 2\n');
    const patches = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-patches-'));
    tmpRoots.push(patches);
    git(dir, 'format-patch', '-q', '-2', '-o', patches);
    git(dir, 'checkout', '-q', 'master');
    // The first patch applies; the second conflicts with this edit.
    commitFile(dir, 'a.txt', 'series 1\n');
    commitFile(dir, 'a.txt', 'main side\n');
    const [first, second] = fs.readdirSync(patches).sort();
    expect(() =>
      git(dir, 'am', path.join(patches, first!), path.join(patches, second!)),
    ).toThrow();
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-apply'))).toBe(true);

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'operation_in_progress',
    );
    await expectPullFailure(
      gitPull(dir, { force: true }, hermeticEnv()),
      'operation_in_progress',
    );

    expect(failure.message).toContain('am');
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-apply'))).toBe(true);
  });

  it('refuses a stash pull while a revert is parked, keeping it', async () => {
    const { dir } = makeUpstream();
    commitFile(dir, 'a.txt', 'A\n');
    const a = headSha(dir);
    commitFile(dir, 'a.txt', 'B\n');
    expect(() => git(dir, 'revert', '--no-edit', a)).toThrow();

    const failure = await expectPullFailure(
      gitPull(dir, { stash: true }, hermeticEnv()),
      'operation_in_progress',
    );

    expect(failure.message).toContain('revert');
    expect(git(dir, 'rev-parse', 'REVERT_HEAD').trim()).toBe(a);
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

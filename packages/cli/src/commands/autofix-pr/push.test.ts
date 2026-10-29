/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ghMock = vi.hoisted(() => ({
  gh: vi.fn((..._args: string[]) => ''),
  // The bare remote is a local path the real matcher cannot read: say which
  // remote serves the head repository.
  matched: vi.fn((): string[] => ['origin']),
}));
vi.mock('../review/lib/remote-match.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/remote-match.js')>()),
  matchRemotes: () => ({ matched: ghMock.matched() }),
}));
vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: ghMock.gh,
  setGhHost: () => {},
  ensureAuthenticated: () => {},
}));

import { leaseRejected, remoteHeadMoved, runPush } from './push.js';
import {
  MAX_PUSHES,
  autofixPrPaths,
  readState,
  writeAnchor,
  writeState,
  type AutofixPrState,
} from './state.js';

describe('runPush (real git, bare remote)', () => {
  let base: string;
  let repo: string;
  let remote: string;
  let featSha: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;
  let live: {
    state: string;
    headRefName: string;
    baseRefName: string;
    isCrossRepository: boolean;
    headRepository: { name: string } | null;
    headRepositoryOwner: { login: string } | null;
  };
  let defaultBranch: string;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commitIn = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    run(cwd, 'add', file);
    run(cwd, 'commit', '-q', '-m', file);
    return run(cwd, 'rev-parse', 'HEAD');
  };
  const remoteFeat = () => run(remote, 'rev-parse', 'refs/heads/feat');
  const state = () => readState(paths.statePath)!;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-push-')));
    remote = join(base, 'remote.git');
    repo = join(base, 'repo');
    run(base, 'init', '-q', '--bare', '-b', 'main', remote);
    run(base, 'init', '-q', '-b', 'main', repo);
    run(repo, 'config', 'user.email', 't@example.com');
    run(repo, 'config', 'user.name', 't');
    run(repo, 'remote', 'add', 'origin', remote);
    commitIn(repo, 'base.txt');
    run(repo, 'push', '-q', 'origin', 'main');
    run(repo, 'switch', '-q', '-c', 'feat');
    featSha = commitIn(repo, 'feat.txt');
    run(repo, 'push', '-q', 'origin', 'feat');
    run(repo, 'switch', '-q', 'main');

    paths = autofixPrPaths(repo, 7);
    mkdirSync(dirname(paths.worktreePath), { recursive: true });
    run(
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      paths.branch,
      paths.worktreePath,
      featSha,
    );
    const initial: AutofixPrState = {
      version: 1,
      sessionId: 'session-a',
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      baseRefName: 'main',
      branch: paths.branch,
      worktreePath: paths.worktreePath,
      viewer: 'me',
      prAuthor: 'me',
      lastKnownHeadSha: featSha,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
    };
    writeState(paths.statePath, initial);
    writeAnchor({ host: 'github.com', owner: 'o', repo: 'r' }, 7, repo);

    live = {
      state: 'OPEN',
      headRefName: 'feat',
      baseRefName: 'main',
      isCrossRepository: false,
      headRepository: { name: 'r' },
      headRepositoryOwner: { login: 'o' },
    };
    defaultBranch = 'main';
    ghMock.matched.mockReset();
    ghMock.matched.mockImplementation(() => ['origin']);
    ghMock.gh.mockReset();
    ghMock.gh.mockImplementation((...args: string[]) =>
      args[0] === 'pr' ? JSON.stringify(live) : defaultBranch,
    );
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    rmSync(base, { recursive: true, force: true });
  });

  it('pushes a fast-forward of the known head and records it', () => {
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    expect(runPush(7)).toEqual({
      pushed: true,
      sha: fix,
      pushes: 1,
      maxPushes: MAX_PUSHES,
    });
    expect(remoteFeat()).toBe(fix);
    expect(state()).toMatchObject({
      lastKnownHeadSha: fix,
      pushedShas: [fix],
      pushCount: 1,
    });
    // The second push builds on the first.
    const again = commitIn(paths.worktreePath, 'fix2.txt');
    expect(runPush(7)).toMatchObject({ pushed: true, sha: again, pushes: 2 });
    expect(state().pushedShas).toEqual([fix, again]);
  });

  it('has nothing to push while HEAD is the PR head, and asks GitHub nothing', () => {
    expect(runPush(7)).toEqual({
      pushed: false,
      reason: 'nothing to push: HEAD is the PR head',
    });
    expect(ghMock.gh).not.toHaveBeenCalled();
  });

  it('refuses uncommitted changes, untracked files included', () => {
    commitIn(paths.worktreePath, 'fix.txt');
    writeFileSync(join(paths.worktreePath, 'stray.txt'), 'x');
    expect(() => runPush(7)).toThrow(/uncommitted changes/);
    expect(remoteFeat()).toBe(featSha);
  });

  it('refuses a HEAD that does not build on the PR head', () => {
    run(paths.worktreePath, 'reset', '-q', '--hard', 'main');
    commitIn(paths.worktreePath, 'rewrite.txt');
    expect(() => runPush(7)).toThrow(/never rewrites a PR's history/);
    expect(remoteFeat()).toBe(featSha);
    expect(ghMock.gh).not.toHaveBeenCalled();
  });

  it('turns a push someone else made meanwhile into resync and overwrites nothing', () => {
    run(repo, 'switch', '-q', 'feat');
    const theirs = commitIn(repo, 'theirs.txt');
    run(repo, 'push', '-q', 'origin', 'feat');
    run(repo, 'switch', '-q', 'main');
    commitIn(paths.worktreePath, 'fix.txt');
    expect(runPush(7)).toMatchObject({ pushed: false, action: 'resync' });
    expect(remoteFeat()).toBe(theirs);
    expect(state()).toMatchObject({
      lastKnownHeadSha: featSha,
      pushedShas: [],
    });
  });

  it('lets the lease, not fast-forwarding alone, keep an author rollback from being undone', () => {
    // The watch's fix builds on featSha; the author resets the branch to its
    // parent. Without the lease the push would fast-forward the remote and
    // put back the commit the author removed.
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    run(repo, 'push', '-q', '--force', 'origin', 'main:refs/heads/feat');
    const rolledBack = remoteFeat();
    expect(runPush(7)).toMatchObject({ pushed: false, action: 'resync' });
    expect(remoteFeat()).toBe(rolledBack);
    expect(remoteFeat()).not.toBe(fix);
  });

  it('reads a lease the remote no longer holds from the remote, whatever language git prints in', () => {
    // A localized git could print the porcelain summary in another
    // language; the remote's own head says the same thing.
    expect(remoteHeadMoved(paths.worktreePath, 'origin', 'feat', featSha)).toBe(
      false,
    );
    run(repo, 'switch', '-q', 'feat');
    commitIn(repo, 'theirs.txt');
    run(repo, 'push', '-q', 'origin', 'feat');
    run(repo, 'switch', '-q', 'main');
    expect(remoteHeadMoved(paths.worktreePath, 'origin', 'feat', featSha)).toBe(
      true,
    );
  });

  it('records a push the remote took although its answer was lost', () => {
    // The remote dies right after the ref update commits.
    const hook = join(remote, 'hooks', 'reference-transaction');
    writeFileSync(
      hook,
      '#!/bin/sh\n[ "$1" = committed ] && kill -9 $PPID\nexit 0\n',
    );
    chmodSync(hook, 0o755);
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    expect(runPush(7)).toMatchObject({ pushed: true, sha: fix, pushes: 1 });
    expect(remoteFeat()).toBe(fix);
    expect(state()).toMatchObject({ lastKnownHeadSha: fix, pushedShas: [fix] });
  });

  it('does not count as its own push a commit someone else pushed already', () => {
    // Someone pushed X on top of the known head; the worktree was moved to X.
    run(repo, 'switch', '-q', 'feat');
    const theirs = commitIn(repo, 'theirs.txt');
    run(repo, 'push', '-q', 'origin', 'feat');
    run(repo, 'switch', '-q', 'main');
    run(paths.worktreePath, 'merge', '-q', '--ff-only', theirs);
    expect(runPush(7)).toMatchObject({ pushed: false, action: 'resync' });
    expect(state()).toMatchObject({ pushedShas: [] });
    expect(state().pushCount).toBeUndefined();
  });

  it('never pushes to the default branch, asked at push time', () => {
    commitIn(paths.worktreePath, 'fix.txt');
    defaultBranch = 'feat';
    expect(() => runPush(7)).toThrow(/default branch \(feat\)/);
    expect(remoteFeat()).toBe(featSha);
    // A fork's branch of that name is not the base repository's.
    live.isCrossRepository = true;
    expect(runPush(7)).toMatchObject({ pushed: true });
    expect(
      ghMock.gh.mock.calls.filter((call) => call[0] === 'repo'),
    ).toHaveLength(1);
  });

  it('stops instead of pushing to a PR that was merged or closed', () => {
    commitIn(paths.worktreePath, 'fix.txt');
    live.state = 'MERGED';
    expect(runPush(7)).toEqual({
      pushed: false,
      action: 'stop',
      reason: 'PR #7 is merged',
    });
    expect(remoteFeat()).toBe(featSha);
  });

  it('stops once the watch has used its pushes', () => {
    commitIn(paths.worktreePath, 'fix.txt');
    writeState(paths.statePath, { ...state(), pushCount: MAX_PUSHES });
    expect(runPush(7)).toMatchObject({ pushed: false, action: 'stop' });
    expect(remoteFeat()).toBe(featSha);
    expect(ghMock.gh).not.toHaveBeenCalled();
  });

  it('runs pre-push hooks and reports their refusal', () => {
    // Named in the repository's own config, so a global `core.hooksPath` on
    // the machine running the test does not replace it.
    const hooks = join(base, 'hooks');
    mkdirSync(hooks);
    run(repo, 'config', 'core.hooksPath', hooks);
    const hook = join(hooks, 'pre-push');
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    commitIn(paths.worktreePath, 'fix.txt');
    expect(() => runPush(7)).toThrow(/hook says no/);
    expect(remoteFeat()).toBe(featSha);
    expect(state().pushCount).toBeUndefined();
  });

  it('pushes the commit it checked, even if HEAD moves while GitHub is asked', () => {
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    ghMock.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        // Meanwhile the worktree is moved to a commit off the PR history.
        run(paths.worktreePath, 'reset', '-q', '--hard', 'main');
        commitIn(paths.worktreePath, 'rewrite.txt');
        return JSON.stringify(live);
      }
      return defaultBranch;
    });
    expect(runPush(7)).toMatchObject({ pushed: true, sha: fix });
    expect(remoteFeat()).toBe(fix);
  });

  it('pushes only the branch and destination GitHub and the remotes name, not an edited state file', () => {
    commitIn(paths.worktreePath, 'fix.txt');
    writeState(paths.statePath, { ...state(), headRefName: 'main' });
    expect(() => runPush(7)).toThrow(/head branch is feat, not the main/);
    writeState(paths.statePath, {
      ...state(),
      headRefName: 'feat',
      pushTarget: 'elsewhere',
    });
    expect(() => runPush(7)).toThrow(/now go to origin, not the elsewhere/);
    expect(remoteFeat()).toBe(featSha);
  });

  it('refuses a state file whose values would reach git as options', () => {
    const valid = state();
    writeState(paths.statePath, {
      ...valid,
      remote: '--upload-pack=touch pwned',
    });
    expect(() => runPush(7)).toThrow(/invalid remote/);
    writeState(paths.statePath, { ...valid, lastKnownHeadSha: '--all' });
    expect(() => runPush(7)).toThrow(/invalid lastKnownHeadSha/);
    writeState(paths.statePath, { ...valid, pushTarget: '-oProxy' });
    expect(() => runPush(7)).toThrow(/invalid pushTarget/);
  });

  it('pushes nothing for a round its task no longer drives', () => {
    writeState(paths.statePath, {
      ...state(),
      watch: { every: 2, reply: true, instructions: '', task: 'bbbbbbbbbbbb' },
    });
    expect(() => runPush(7, 'aaaaaaaaaaaa')).toThrow(/no longer drives/);
  });

  it('pushes nothing for a watch cleanup ended, whose work it kept', () => {
    writeState(paths.statePath, {
      ...state(),
      ended: { at: '2026-10-25T00:00:00.000Z', reason: 'kept' },
    });
    expect(() => runPush(7)).toThrow(/watch was stopped/);
  });

  it('refuses a worktree on another branch, or a symlink in its place', () => {
    run(repo, 'branch', 'mine', featSha);
    run(paths.worktreePath, 'switch', '-q', 'mine');
    commitIn(paths.worktreePath, 'user-work.txt');
    expect(() => runPush(7)).toThrow(
      /branch mine checked out, not qwen-autofix\/pr-7/,
    );
    expect(remoteFeat()).toBe(featSha);

    run(repo, 'worktree', 'remove', '--force', paths.worktreePath);
    symlinkSync(repo, paths.worktreePath);
    expect(() => runPush(7)).toThrow(/is a symlink/);
    expect(remoteFeat()).toBe(featSha);
  });

  /** A pre-push hook, named in the repository's own config. */
  const prePushHook = (script: string) => {
    const hooks = join(base, 'hooks');
    mkdirSync(hooks, { recursive: true });
    run(repo, 'config', 'core.hooksPath', hooks);
    const hook = join(hooks, 'pre-push');
    writeFileSync(hook, `#!/bin/sh\n${script}`);
    chmodSync(hook, 0o755);
  };

  it('pushes when a pre-push hook prints more than a megabyte', () => {
    prePushHook('head -c 2097152 /dev/zero | tr "\\000" x >&2\nexit 0\n');
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    expect(runPush(7)).toMatchObject({ pushed: true, sha: fix });
    expect(remoteFeat()).toBe(fix);
  });

  it('reads a lease lost while a pre-push hook refused from the remote, with no "stale info" to read', () => {
    run(repo, 'switch', '-q', 'feat');
    const theirs = commitIn(repo, 'theirs.txt');
    run(repo, 'push', '-q', 'origin', 'feat:refs/heads/side');
    run(repo, 'switch', '-q', 'main');
    // Someone pushes while the hook runs, and the hook refuses.
    prePushHook(
      `git --git-dir="${remote}" update-ref refs/heads/feat ${theirs}\necho "hook says no" >&2\nexit 1\n`,
    );
    commitIn(paths.worktreePath, 'fix.txt');
    expect(runPush(7)).toMatchObject({ pushed: false, action: 'resync' });
    expect(remoteFeat()).toBe(theirs);
  });

  it('refuses a plain directory in place of the worktree, whatever the enclosing clone has checked out', () => {
    run(repo, 'worktree', 'remove', '--force', paths.worktreePath);
    mkdirSync(paths.worktreePath);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.qwen/\n');
    // The user checked the watch's branch out in their own clone.
    run(repo, 'switch', '-q', paths.branch);
    commitIn(repo, 'user-work.txt');
    expect(() => runPush(7)).toThrow(/is not a git worktree/);
    expect(remoteFeat()).toBe(featSha);
  });

  it('refuses a worktree reached through a symlinked directory above it', () => {
    // Another clone watching the same PR, with unpushed work of its own.
    const other = join(base, 'other');
    run(base, 'clone', '-q', remote, other);
    run(other, 'config', 'user.email', 't@example.com');
    run(other, 'config', 'user.name', 't');
    const otherTmp = join(other, '.qwen', 'tmp');
    mkdirSync(otherTmp, { recursive: true });
    const otherWorktree = join(otherTmp, 'autofix-pr-7');
    run(
      other,
      'worktree',
      'add',
      '-q',
      '-b',
      paths.branch,
      otherWorktree,
      featSha,
    );
    const theirWork = commitIn(otherWorktree, 'their-work.txt');
    // This clone's `.qwen/tmp` now leads there.
    writeState(join(otherTmp, 'autofix-pr-7-state.json'), state());
    run(repo, 'worktree', 'remove', '--force', paths.worktreePath);
    rmSync(dirname(paths.worktreePath), { recursive: true });
    symlinkSync(otherTmp, dirname(paths.worktreePath));
    expect(() => runPush(7)).toThrow(/resolves through the symlink/);
    expect(remoteFeat()).toBe(featSha);
    expect(run(otherWorktree, 'rev-parse', 'HEAD')).toBe(theirWork);
  });

  it('records the base GitHub names now, and refuses one a command cannot carry', () => {
    live.baseRefName = 'release/2.0';
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    expect(runPush(7)).toMatchObject({ pushed: true, sha: fix });
    expect(state().baseRefName).toBe('release/2.0');
    live.baseRefName = 'release;id';
    commitIn(paths.worktreePath, 'fix2.txt');
    expect(() => runPush(7)).toThrow(/cannot be named in a command/);
    expect(remoteFeat()).toBe(fix);
    expect(state().baseRefName).toBe('release/2.0');
  });

  it('pushes the one branch, never the tags its commit reaches', () => {
    run(repo, 'config', 'push.followTags', 'true');
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    run(paths.worktreePath, 'tag', '-a', '-m', 'local', 'local-only', fix);
    expect(runPush(7)).toMatchObject({ pushed: true, sha: fix });
    expect(run(remote, 'tag', '--list')).toBe('');
  });

  it('refuses a commit that only a graft file says builds on the PR head', () => {
    // An orphan that drops the author's history, grafted onto the known
    // head in the clone's common directory.
    run(paths.worktreePath, 'checkout', '-q', '--orphan', 'tmp-orphan');
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'orphan');
    const orphan = run(paths.worktreePath, 'rev-parse', 'HEAD');
    run(paths.worktreePath, 'checkout', '-q', paths.branch);
    run(paths.worktreePath, 'reset', '-q', '--hard', orphan);
    writeFileSync(
      join(repo, '.git', 'info', 'grafts'),
      `${orphan} ${featSha}\n`,
    );
    expect(() => runPush(7)).toThrow(/does not build on the PR head/);
    expect(remoteFeat()).toBe(featSha);
  });

  it('reads the remote branch itself, not one whose name ends like it', () => {
    // A branch named so that `ls-remote … refs/heads/feat` lists it first,
    // at an older commit, while the server refuses the push.
    run(
      remote,
      'update-ref',
      'refs/heads/a/refs/heads/feat',
      run(remote, 'rev-parse', 'refs/heads/main'),
    );
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    commitIn(paths.worktreePath, 'fix.txt');
    expect(() => runPush(7)).toThrow(/protected branch/);
    expect(remoteFeat()).toBe(featSha);
  });

  it("reaches the remote with the user's own ssh command", () => {
    // An ssh remote, served through an ssh command of the user's that runs
    // the git command it is handed locally.
    const ssh = join(base, 'fake-ssh');
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n');
    chmodSync(ssh, 0o755);
    run(repo, 'remote', 'set-url', 'origin', `ssh://example.invalid${remote}`);
    const saved = process.env['GIT_SSH_COMMAND'];
    process.env['GIT_SSH_COMMAND'] = ssh;
    try {
      const fix = commitIn(paths.worktreePath, 'fix.txt');
      expect(runPush(7)).toMatchObject({ pushed: true, sha: fix });
      expect(remoteFeat()).toBe(fix);
    } finally {
      if (saved === undefined) delete process.env['GIT_SSH_COMMAND'];
      else process.env['GIT_SSH_COMMAND'] = saved;
    }
  });

  it('refuses a watch owned by another session', () => {
    commitIn(paths.worktreePath, 'fix.txt');
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runPush(7)).toThrow(/watched by another session/);
    expect(remoteFeat()).toBe(featSha);
  });
});

describe('leaseRejected', () => {
  it('reads a stale lease from the porcelain output only', () => {
    expect(
      leaseRejected(
        'To /r.git\n!\tHEAD:refs/heads/feat\t[rejected] (stale info)\nDone',
      ),
    ).toBe(true);
    expect(
      leaseRejected(
        'To /r.git\n!\tHEAD:refs/heads/feat\t[remote rejected] (pre-receive hook declined)\nDone',
      ),
    ).toBe(false);
    expect(leaseRejected(' \tHEAD:refs/heads/feat\tabc..def')).toBe(false);
  });
});

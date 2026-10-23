/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
}));
vi.mock('../review/lib/gh.js', () => ({
  gh: ghMock.gh,
  setGhHost: () => {},
  ensureAuthenticated: () => {},
}));

import { leaseRejected, runPush } from './push.js';
import {
  MAX_PUSHES,
  autofixPrPaths,
  readState,
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
  let live: { state: string; headRefName: string; isCrossRepository: boolean };
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

    live = { state: 'OPEN', headRefName: 'feat', isCrossRepository: false };
    defaultBranch = 'main';
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
    const hook = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    commitIn(paths.worktreePath, 'fix.txt');
    expect(() => runPush(7)).toThrow(/hook says no/);
    expect(remoteFeat()).toBe(featSha);
    expect(state().pushCount).toBeUndefined();
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

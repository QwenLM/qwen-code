/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSync } from './sync.js';
import {
  autofixPrPaths,
  readState,
  writeState,
  type AutofixPrState,
} from './state.js';

describe('runSync (real git, bare remote)', () => {
  let base: string;
  let repo: string;
  let remote: string;
  let featSha: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commitIn = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    run(cwd, 'add', file);
    run(cwd, 'commit', '-q', '-m', file);
    return run(cwd, 'rev-parse', 'HEAD');
  };
  /** Someone else pushes to the PR branch; GitHub moves refs/pull/7/head. */
  const pushFromElsewhere = (file: string) => {
    run(repo, 'switch', '-q', 'feat');
    const sha = commitIn(repo, file);
    run(repo, 'push', '-q', 'origin', 'feat');
    run(repo, 'switch', '-q', 'main');
    run(remote, 'update-ref', 'refs/pull/7/head', sha);
    return sha;
  };
  /** The author rewrites the PR branch: a force-push not built on it. */
  const forcePushFromElsewhere = (file: string) => {
    run(repo, 'switch', '-q', '-C', 'rewrite', 'main');
    const sha = commitIn(repo, file);
    run(repo, 'push', '-q', '--force', 'origin', 'rewrite:feat');
    run(repo, 'switch', '-q', 'main');
    run(remote, 'update-ref', 'refs/pull/7/head', sha);
    return sha;
  };
  const worktreeHead = () => run(paths.worktreePath, 'rev-parse', 'HEAD');
  const known = () => readState(paths.statePath)!.lastKnownHeadSha;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-sync-')));
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
    run(remote, 'update-ref', 'refs/pull/7/head', featSha);

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

  it('reports an unmoved head without writing the state', () => {
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: featSha,
      moved: false,
    });
    expect(known()).toBe(featSha);
  });

  it('fast-forwards the worktree to a head someone else pushed and records it', () => {
    const theirs = pushFromElsewhere('theirs.txt');
    expect(runSync(7)).toEqual({ synced: true, headSha: theirs, moved: true });
    expect(worktreeHead()).toBe(theirs);
    expect(known()).toBe(theirs);
    // The user's own branches are untouched.
    expect(run(repo, 'rev-parse', 'refs/heads/feat')).toBe(theirs);
    expect(run(repo, 'rev-parse', 'HEAD')).toBe(run(repo, 'rev-parse', 'main'));
  });

  it('asks for a merge when the worktree holds work the new head lacks, and changes nothing', () => {
    const ours = commitIn(paths.worktreePath, 'ours.txt');
    const theirs = pushFromElsewhere('theirs.txt');
    expect(runSync(7)).toMatchObject({
      synced: false,
      headSha: theirs,
      moved: true,
      action: 'merge',
    });
    expect(worktreeHead()).toBe(ours);
    expect(known()).toBe(featSha);
  });

  it('adopts the new head once the worktree has merged it', () => {
    commitIn(paths.worktreePath, 'ours.txt');
    const theirs = pushFromElsewhere('theirs.txt');
    run(paths.worktreePath, 'merge', '-q', '--no-edit', theirs);
    const merged = worktreeHead();
    expect(runSync(7)).toEqual({ synced: true, headSha: theirs, moved: true });
    expect(worktreeHead()).toBe(merged);
    expect(known()).toBe(theirs);
  });

  it('moves the worktree to a head the author rewrote, dropping only an unpushed attempt', () => {
    const rewritten = forcePushFromElsewhere('rewritten.txt');
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: rewritten,
      moved: true,
    });
    expect(worktreeHead()).toBe(rewritten);
    expect(known()).toBe(rewritten);

    // An attempt made on the old history cannot be pushed onto the new one.
    commitIn(paths.worktreePath, 'attempt.txt');
    const again = forcePushFromElsewhere('rewritten-again.txt');
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: again,
      moved: true,
      dropped: 1,
    });
    expect(worktreeHead()).toBe(again);
  });

  it('refuses to move or reset a worktree with uncommitted changes', () => {
    pushFromElsewhere('theirs.txt');
    writeFileSync(join(paths.worktreePath, 'stray.txt'), 'x');
    expect(() => runSync(7)).toThrow(/uncommitted changes/);
    forcePushFromElsewhere('rewritten.txt');
    expect(() => runSync(7)).toThrow(/uncommitted changes/);
    expect(worktreeHead()).toBe(featSha);
    expect(known()).toBe(featSha);
  });
});

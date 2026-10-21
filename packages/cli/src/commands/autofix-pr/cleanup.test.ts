/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const stdout = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdout,
  writeStderrLineSafe: () => {},
}));

import { runCleanup } from './cleanup.js';
import { autofixPrPaths, writeState, type AutofixPrState } from './state.js';

describe('runCleanup (real git)', () => {
  let repo: string;
  let headSha: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let paths: ReturnType<typeof autofixPrPaths>;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const lastReport = () =>
    JSON.parse(stdout.mock.calls.at(-1)![0]) as Record<string, unknown>;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-cleanup-')));
    run(repo, 'init', '-q', '-b', 'main');
    run(repo, 'config', 'user.email', 't@example.com');
    run(repo, 'config', 'user.name', 't');
    run(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    headSha = run(repo, 'rev-parse', 'HEAD');
    paths = autofixPrPaths(repo, 7);
    mkdirSync(dirname(paths.worktreePath), { recursive: true });
    run(repo, 'worktree', 'add', '-q', '-b', paths.branch, paths.worktreePath);
    const state: AutofixPrState = {
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
      lastKnownHeadSha: headSha,
      pushedShas: [],
      handledCommentIds: [],
      postedCommentIds: [],
    };
    writeState(paths.statePath, state);
    stdout.mockClear();
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    rmSync(repo, { recursive: true, force: true });
  });

  const branchExists = () => run(repo, 'branch', '--list', paths.branch) !== '';

  it('removes the worktree, branch and state when nothing would be lost', () => {
    const log = join(dirname(paths.statePath), 'autofix-pr-7-ci-1.log');
    const otherPr = join(dirname(paths.statePath), 'autofix-pr-70-state.json');
    writeFileSync(log, 'log');
    writeFileSync(otherPr, '{}');
    runCleanup(7, false);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(otherPr)).toBe(true);
    expect(existsSync(paths.worktreePath)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(branchExists()).toBe(false);
    expect(lastReport()).toEqual({
      removed: true,
      worktreePath: paths.worktreePath,
    });
  });

  it('keeps everything when the worktree has uncommitted changes', () => {
    writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
    runCleanup(7, false);
    expect(existsSync(paths.worktreePath)).toBe(true);
    expect(existsSync(paths.statePath)).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/uncommitted changes/),
    });
  });

  it('keeps everything when the worktree has unpushed commits', () => {
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
    runCleanup(7, false);
    expect(branchExists()).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/1 commit\(s\) the PR does not have/),
    });
  });

  it('keeps a branch with unpushed commits while its worktree sits on an older commit', () => {
    // The worktree's HEAD is not the branch: inspecting an older commit must
    // not unlock the branch that cleanup would delete along with it.
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
    run(paths.worktreePath, 'switch', '-q', '--detach', headSha);
    runCleanup(7, false);
    expect(existsSync(paths.worktreePath)).toBe(true);
    expect(branchExists()).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(
        /branch qwen-autofix\/pr-7 has 1 commit\(s\) the PR does not have/,
      ),
    });
  });

  it('discards unpushed work with --force', () => {
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
    runCleanup(7, true);
    expect(existsSync(paths.worktreePath)).toBe(false);
    expect(branchExists()).toBe(false);
  });

  it("refuses another session's watch unless forced", () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runCleanup(7, false)).toThrow(/watched by another session/);
    expect(existsSync(paths.worktreePath)).toBe(true);
    runCleanup(7, true);
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it('keeps a leftover worktree with uncommitted changes even without state', () => {
    rmSync(paths.statePath);
    writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
    runCleanup(7, false);
    expect(existsSync(paths.worktreePath)).toBe(true);
    expect(lastReport()).toMatchObject({ removed: false });
  });

  it('keeps a leftover worktree without state unless forced', () => {
    rmSync(paths.statePath);
    runCleanup(7, false);
    expect(existsSync(paths.worktreePath)).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/no PR head is recorded/),
    });
    runCleanup(7, true);
    expect(existsSync(paths.worktreePath)).toBe(false);
    expect(branchExists()).toBe(false);
  });

  it('keeps a branch with unpushed commits after its worktree was rm -rf-ed', () => {
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
    rmSync(paths.worktreePath, { recursive: true, force: true });
    runCleanup(7, false);
    expect(branchExists()).toBe(true);
    expect(existsSync(paths.statePath)).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(
        /branch qwen-autofix\/pr-7 has 1 commit\(s\) the PR does not have/,
      ),
    });
  });

  it('removes a clean branch after its worktree was rm -rf-ed', () => {
    rmSync(paths.worktreePath, { recursive: true, force: true });
    runCleanup(7, false);
    expect(branchExists()).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it('keeps the state file when the branch cannot be deleted', () => {
    rmSync(paths.worktreePath, { recursive: true, force: true });
    run(repo, 'worktree', 'prune');
    run(repo, 'switch', '-q', paths.branch);
    expect(() => runCleanup(7, false)).toThrow();
    expect(branchExists()).toBe(true);
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('discards an unreadable state file only with --force', () => {
    writeFileSync(paths.statePath, '{');
    expect(() => runCleanup(7, false)).toThrow(SyntaxError);
    runCleanup(7, true);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(branchExists()).toBe(false);
  });

  it('refuses to run from inside the worktree it would remove', () => {
    process.chdir(paths.worktreePath);
    expect(() => runCleanup(7, false)).toThrow(/from inside it/);
    expect(existsSync(paths.worktreePath)).toBe(true);
  });

  it('counts a subdirectory whose name starts with two dots as inside', () => {
    const sub = join(paths.worktreePath, '..cache');
    mkdirSync(sub);
    process.chdir(sub);
    expect(() => runCleanup(7, false)).toThrow(/from inside it/);
    expect(existsSync(paths.worktreePath)).toBe(true);
  });

  it('finds the watch from another worktree of the clone', () => {
    const other = join(repo, '..', `${repo.split('/').at(-1)}-other`);
    run(repo, 'worktree', 'add', '-q', '--detach', other);
    try {
      process.chdir(other);
      runCleanup(7, false);
      expect(existsSync(paths.statePath)).toBe(false);
      expect(branchExists()).toBe(false);
    } finally {
      process.chdir(repo);
      rmSync(other, { recursive: true, force: true });
    }
  });
});

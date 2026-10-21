/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real git (a bare "remote" carrying refs/pull/7/head, a clone of it) around
// a mocked `gh`. Remote matching is steered because `git remote -v` prints
// the local path of the bare repository; lib/remote-match.test.ts covers it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  gh: vi.fn((..._args: string[]): string => ''),
  matched: vi.fn((_owner: string): string[] => ['origin']),
  stdout: vi.fn((_line: string) => {}),
}));

vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: mocks.gh,
  currentUser: () => 'me',
  ensureAuthenticated: () => {},
}));

vi.mock('../review/lib/remote-match.js', () => ({
  matchRemotes: (_remoteV: string, { owner }: { owner: string }) => ({
    matched: mocks.matched(owner),
  }),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
}));

import {
  eligibilityError,
  pushUrl,
  runPrepare,
  type PrView,
} from './prepare.js';
import { autofixPrPaths, readState, writeState } from './state.js';

function prView(overrides: Partial<PrView> = {}): PrView {
  return {
    number: 7,
    state: 'OPEN',
    url: 'https://github.com/o/r/pull/7',
    isDraft: false,
    headRefName: 'feat',
    headRefOid: 'x',
    baseRefName: 'main',
    isCrossRepository: false,
    maintainerCanModify: false,
    headRepository: { name: 'r' },
    headRepositoryOwner: { login: 'o' },
    author: { login: 'me' },
    ...overrides,
  };
}

const writable = {
  viewerPermission: 'WRITE',
  defaultBranchRef: { name: 'main' },
};

describe('eligibilityError', () => {
  it('accepts an open same-repository PR the viewer can push to', () => {
    expect(eligibilityError(prView(), writable, 'me')).toBeNull();
  });

  it('refuses closed and merged PRs', () => {
    expect(
      eligibilityError(prView({ state: 'MERGED' }), writable, 'me'),
    ).toMatch(/is merged/);
    expect(
      eligibilityError(prView({ state: 'CLOSED' }), writable, 'me'),
    ).toMatch(/is closed/);
  });

  it('refuses a head that is the default branch', () => {
    expect(
      eligibilityError(prView({ headRefName: 'main' }), writable, 'me'),
    ).toMatch(/default branch/);
  });

  it('refuses a viewer without write access', () => {
    expect(
      eligibilityError(
        prView(),
        { ...writable, viewerPermission: 'READ' },
        'me',
      ),
    ).toMatch(/cannot push to this repository \(permission: READ\)/);
  });

  it('accepts a fork the viewer owns, or one that allows maintainer edits', () => {
    const fork = prView({
      isCrossRepository: true,
      headRepositoryOwner: { login: 'contributor' },
      headRefName: 'main',
    });
    expect(
      eligibilityError(
        fork,
        { ...writable, viewerPermission: 'READ' },
        'contributor',
      ),
    ).toBeNull();
    expect(
      eligibilityError({ ...fork, maintainerCanModify: true }, writable, 'me'),
    ).toBeNull();
    expect(eligibilityError(fork, writable, 'me')).toMatch(
      /does not allow edits from maintainers/,
    );
  });

  it('refuses a PR whose head repository was deleted', () => {
    expect(
      eligibilityError(prView({ headRepository: null }), writable, 'me'),
    ).toMatch(/no longer exists/);
  });
});

describe('pushUrl', () => {
  it('follows the gh git protocol', () => {
    expect(pushUrl('github.com', 'o', 'r', 'ssh')).toBe(
      'git@github.com:o/r.git',
    );
    expect(pushUrl('github.com', 'o', 'r', 'https')).toBe(
      'https://github.com/o/r.git',
    );
  });
});

describe('runPrepare (real git)', () => {
  let dir: string;
  let clone: string;
  let headSha: string;
  let savedCwd: string;
  let savedSession: string | undefined;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const lastReport = () =>
    JSON.parse(mocks.stdout.mock.calls.at(-1)![0]) as Record<string, unknown>;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-prepare-')));
    const src = join(dir, 'src');
    run(dir, 'init', '-q', '-b', 'main', src);
    run(src, 'config', 'user.email', 't@example.com');
    run(src, 'config', 'user.name', 't');
    run(src, 'commit', '-q', '--allow-empty', '-m', 'base');
    run(src, 'checkout', '-q', '-b', 'feat');
    run(src, 'commit', '-q', '--allow-empty', '-m', 'feature');
    headSha = run(src, 'rev-parse', 'HEAD');
    const bare = join(dir, 'bare.git');
    run(dir, 'clone', '-q', '--bare', src, bare);
    run(bare, 'update-ref', 'refs/pull/7/head', headSha);
    clone = join(dir, 'clone');
    run(dir, 'clone', '-q', bare, clone);

    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr')
        return JSON.stringify(prView({ headRefOid: headSha }));
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    mocks.matched.mockImplementation(() => ['origin']);
    mocks.stdout.mockClear();
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    process.chdir(clone);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a worktree at the PR head and records the state', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    expect(run(paths.worktreePath, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(run(paths.worktreePath, 'branch', '--show-current')).toBe(
      'qwen-autofix/pr-7',
    );
    expect(readState(paths.statePath)).toMatchObject({
      sessionId: 'session-a',
      owner: 'o',
      repo: 'r',
      remote: 'origin',
      pushTarget: 'origin',
      headRefName: 'feat',
      lastKnownHeadSha: headSha,
      prAuthor: 'me',
      handledCommentIds: [],
    });
    expect(lastReport()).toMatchObject({
      resumed: false,
      headSha,
      localUnpushedCommits: 0,
    });
  });

  it('pushes to the head repository URL when no remote serves it', () => {
    mocks.matched.mockImplementation((owner) =>
      owner === 'o' ? ['origin'] : [],
    );
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(
          prView({
            headRefOid: headSha,
            isCrossRepository: true,
            maintainerCanModify: true,
            headRepositoryOwner: { login: 'contributor' },
          }),
        );
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'ssh';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      pushTarget: 'git@github.com:contributor/r.git',
    });
  });

  it('counts local commits the PR does not have', () => {
    expect(run(clone, 'branch', '--show-current')).toBe('feat');
    run(clone, 'config', 'user.email', 't@example.com');
    run(clone, 'config', 'user.name', 't');
    run(clone, 'commit', '-q', '--allow-empty', '-m', 'local only');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ localUnpushedCommits: 1 });
  });

  it('resumes in the owning session without touching the worktree', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    mocks.gh.mockImplementation(() => {
      throw new Error('a resume must not call gh');
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ resumed: true, headSha });
  });

  it('recreates a removed worktree and keeps the cursor', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const state = readState(paths.statePath)!;
    execFileSync('git', ['worktree', 'remove', '--force', paths.worktreePath], {
      cwd: clone,
    });
    writeState(paths.statePath, { ...state, handledCommentIds: ['C1'] });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(existsSync(paths.worktreePath)).toBe(true);
    expect(readState(paths.statePath)!.handledCommentIds).toEqual(['C1']);
    expect(lastReport()).toMatchObject({ resumed: false });
  });

  it('recreates a worktree deleted with rm -rf', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    rmSync(paths.worktreePath, { recursive: true, force: true });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(run(paths.worktreePath, 'rev-parse', 'HEAD')).toBe(headSha);
  });

  it('refuses to drop a leftover branch that holds unpushed commits', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    run(paths.worktreePath, 'config', 'user.email', 't@example.com');
    run(paths.worktreePath, 'config', 'user.name', 't');
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
    run(clone, 'worktree', 'remove', '--force', paths.worktreePath);
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /may hold unpushed work\. Run `qwen autofix-pr cleanup 7` first/,
    );
    expect(run(clone, 'branch', '--list', paths.branch)).not.toBe('');
  });

  it('refuses a leftover worktree that has no state file', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    rmSync(paths.statePath);
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /left over from an earlier watch/,
    );
    expect(existsSync(paths.worktreePath)).toBe(true);
  });

  it("does not count an unrelated local branch that shares the head's name", () => {
    mocks.matched.mockImplementation((owner) =>
      owner === 'o' ? ['origin'] : [],
    );
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(
          prView({
            headRefOid: headSha,
            headRefName: 'feat',
            isCrossRepository: true,
            headRepositoryOwner: { login: 'me' },
          }),
        );
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    run(clone, 'config', 'user.email', 't@example.com');
    run(clone, 'config', 'user.name', 't');
    run(clone, 'commit', '-q', '--allow-empty', '-m', 'local only');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ localUnpushedCommits: 0 });
  });

  it('refuses a watch owned by another session', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /watched by another session \(session-a\)/,
    );
  });

  it('refuses when no single remote serves the repository', () => {
    mocks.matched.mockImplementation(() => []);
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /no single git remote/,
    );
    expect(existsSync(autofixPrPaths(clone, 7).statePath)).toBe(false);
  });

  it('refuses an ineligible PR before creating anything', () => {
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(prView({ state: 'MERGED' }));
      return JSON.stringify(writable);
    });
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(/is merged/);
    expect(existsSync(autofixPrPaths(clone, 7).worktreePath)).toBe(false);
  });
});

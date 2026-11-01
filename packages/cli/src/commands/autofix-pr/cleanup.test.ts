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
  readFileSync,
  realpathSync,
  rmSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const stdout = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdout,
  writeStderrLineSafe: () => {},
}));
// What happens while cleanup reads the watch, and while it asks the remote
// for the PR's head: a fix attempt that opens meanwhile.
const hooks = vi.hoisted(() => ({
  afterRead: null as (() => void) | null,
  remoteHead: null as (() => string) | null,
}));
vi.mock('./state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state.js')>();
  return {
    ...actual,
    readState: (...args: Parameters<typeof actual.readState>) => {
      const state = actual.readState(...args);
      hooks.afterRead?.();
      return state;
    },
  };
});
vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>();
  return {
    ...actual,
    remoteRef: (...args: Parameters<typeof actual.remoteRef>) =>
      hooks.remoteHead ? hooks.remoteHead() : actual.remoteRef(...args),
  };
});

import { runCleanup } from './cleanup.js';
import {
  autofixPrPaths,
  historyPath,
  readHistory,
  readState,
  writeAnchor,
  writeState,
  type AutofixPrState,
} from './state.js';

describe('runCleanup (real git)', () => {
  let repo: string;
  let headSha: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let savedServe: string | undefined;
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
    writeAnchor({ host: 'github.com', owner: 'o', repo: 'r' }, 7, repo);
    stdout.mockClear();
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    // `watchRoot` roots a daemon session's watch at its own worktree; a runner
    // under `qwen serve` must not leak that into these clone-rooted tests.
    savedServe = process.env['QWEN_CODE_SERVE'];
    delete process.env['QWEN_CODE_SERVE'];
    process.chdir(repo);
  });

  afterEach(() => {
    hooks.afterRead = null;
    hooks.remoteHead = null;
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    if (savedServe === undefined) delete process.env['QWEN_CODE_SERVE'];
    else process.env['QWEN_CODE_SERVE'] = savedServe;
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
      history: historyPath(paths, {
        host: 'github.com',
        owner: 'o',
        repo: 'r',
      }),
    });
  });

  it('keeps the gate cursor, which belongs to the scheduled task, and says so', () => {
    writeFileSync(paths.gatePath, '{}');
    runCleanup(7, false);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.gatePath)).toBe(true);
    expect(lastReport()).toEqual({
      removed: true,
      worktreePath: paths.worktreePath,
      gateCursor: paths.gatePath,
      history: historyPath(paths, {
        host: 'github.com',
        owner: 'o',
        repo: 'r',
      }),
    });
  });

  it('with --force removes a lock a killed helper left behind', () => {
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: 1, ns: 'pid:[1]', at: Date.now(), id: 'x' }),
    );
    runCleanup(7, true);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('keeps what the watch posted and handled, adding to an earlier watch of the PR', () => {
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      handledCommentIds: ['C2'],
      postedCommentIds: ['P2'],
      rerunChecks: ['run:1:2:push:Test@x'],
    });
    writeFileSync(
      historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
      JSON.stringify({
        version: 1,
        host: 'github.com',
        owner: 'O',
        repo: 'R',
        prNumber: 7,
        handledCommentIds: ['C1'],
        postedCommentIds: ['P1'],
        handledChecks: [],
        rerunChecks: [],
      }),
    );
    runCleanup(7, false);
    expect(
      readHistory(
        historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
      ),
    ).toMatchObject({
      owner: 'o',
      handledCommentIds: ['C1', 'C2'],
      postedCommentIds: ['P1', 'P2'],
      rerunChecks: ['run:1:2:push:Test@x'],
    });
  });

  it('sees changes inside a submodule whatever its ignore setting says', () => {
    const lib = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-sub-')));
    try {
      run(lib, 'init', '-q', '-b', 'main');
      writeFileSync(join(lib, 'a.txt'), 'a');
      run(lib, 'add', 'a.txt');
      run(
        lib,
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-m',
        'lib',
      );
      const wt = paths.worktreePath;
      run(
        wt,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        lib,
        'sub',
      );
      run(wt, 'commit', '-q', '-m', 'add sub');
      writeState(paths.statePath, {
        ...(JSON.parse(
          readFileSync(paths.statePath, 'utf8'),
        ) as AutofixPrState),
        lastKnownHeadSha: run(wt, 'rev-parse', 'HEAD'),
      });
      run(repo, 'config', 'submodule.sub.ignore', 'all');
      writeFileSync(join(wt, 'sub', 'a.txt'), 'edited');
      runCleanup(7, false);
      expect(readFileSync(join(wt, 'sub', 'a.txt'), 'utf8')).toBe('edited');
      expect(lastReport()).toMatchObject({
        removed: false,
        reason: expect.stringMatching(/uncommitted changes/),
      });
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
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

  it('ends the watch it keeps, so resume does not start it again over the kept work', () => {
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      watch: { every: 2, reply: true, instructions: '' },
    });
    writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
    writeFileSync(paths.checkedPath, '');
    runCleanup(7, false);
    expect(lastReport()).toMatchObject({ removed: false });
    const kept = readState(paths.statePath)!;
    expect(kept.watch).toBeUndefined();
    // No check of its gate looks recent: the gate answers watch_ended now.
    expect(existsSync(paths.checkedPath)).toBe(false);
    // The rounds' helpers refuse it until a start resumes it.
    expect(kept.ended).toEqual({
      at: expect.any(String),
      reason: expect.stringMatching(/uncommitted changes/),
    });
    expect(kept.lastKnownHeadSha).toBe(headSha);
  });

  describe('a fix attempt that opens while it runs', () => {
    const openAttempt = () =>
      writeFileSync(
        paths.fixPath,
        JSON.stringify({
          version: 1,
          attempt: '0123456789ab',
          task: 'aaaaaaaaaaaa',
          head: headSha,
          startedAt: new Date().toISOString(),
        }),
      );
    const refused = /a fix agent is working in PR #7's worktree/;

    it('keeps the worktree it was about to remove', () => {
      run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
      const pushed = run(paths.worktreePath, 'rev-parse', 'HEAD');
      // The commit is on the PR: nothing would be lost.
      hooks.remoteHead = () => {
        openAttempt();
        return pushed;
      };
      expect(() => runCleanup(7, false)).toThrow(refused);
      expect(existsSync(paths.worktreePath)).toBe(true);
      expect(branchExists()).toBe(true);
      expect(existsSync(paths.statePath)).toBe(true);
    });

    it('leaves the watch it would end with the work it keeps running', () => {
      writeState(paths.statePath, {
        ...readState(paths.statePath)!,
        watch: { every: 2, reply: true, instructions: '' },
      });
      run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
      hooks.remoteHead = () => {
        openAttempt();
        return headSha;
      };
      expect(() => runCleanup(7, false)).toThrow(refused);
      expect(readState(paths.statePath)).toMatchObject({
        watch: { every: 2 },
      });
      expect(readState(paths.statePath)).not.toHaveProperty('ended');
    });

    it('names the running fix before anything else, an unreadable watch too', () => {
      // Before it reads the watch: a state file it cannot read would
      // otherwise send the user to --force, which then refuses the same.
      writeFileSync(paths.statePath, '{');
      openAttempt();
      for (const force of [false, true]) {
        expect(() => runCleanup(7, force)).toThrow(refused);
      }
      expect(existsSync(paths.worktreePath)).toBe(true);
    });

    it('keeps the worktree --force would discard', () => {
      run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
      hooks.afterRead = () => {
        hooks.afterRead = null;
        openAttempt();
      };
      expect(() => runCleanup(7, true)).toThrow(refused);
      expect(existsSync(paths.worktreePath)).toBe(true);
      expect(existsSync(paths.statePath)).toBe(true);
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

  it('sees untracked files whatever status.showUntrackedFiles says', () => {
    run(repo, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
    runCleanup(7, false);
    expect(existsSync(join(paths.worktreePath, 'wip.txt'))).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/uncommitted changes/),
    });
  });

  it('counts commits already on the PR head as saved', () => {
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-remote-')));
    try {
      run(remote, 'init', '-q', '--bare');
      run(repo, 'remote', 'add', 'origin', remote);
      run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
      // Pushed without the push helper: the recorded head never moved.
      run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      runCleanup(7, false);
      expect(lastReport()).toEqual({
        removed: true,
        worktreePath: paths.worktreePath,
        history: historyPath(paths, {
          host: 'github.com',
          owner: 'o',
          repo: 'r',
        }),
      });
      expect(branchExists()).toBe(false);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('counts commits the watch pushed as saved', () => {
    run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'fix');
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    writeState(paths.statePath, {
      ...state,
      pushedShas: [run(paths.worktreePath, 'rev-parse', 'HEAD')],
    });
    runCleanup(7, false);
    expect(lastReport()).toMatchObject({ removed: true });
  });

  it('judges a leftover directory that is not a worktree as unknown, not as the clone', () => {
    // An interrupted `prepare` can leave a plain directory; git run inside
    // it would find the (clean) enclosing clone.
    run(repo, 'worktree', 'remove', '--force', paths.worktreePath);
    mkdirSync(paths.worktreePath);
    writeFileSync(join(paths.worktreePath, 'notes.txt'), 'keep me');
    runCleanup(7, false);
    expect(existsSync(join(paths.worktreePath, 'notes.txt'))).toBe(true);
    expect(lastReport()).toMatchObject({
      removed: false,
      reason: expect.stringMatching(/is not a git worktree/),
    });
    runCleanup(7, true);
    expect(existsSync(paths.worktreePath)).toBe(false);
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

  it("takes another session's watch over to end it, still keeping its work", () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
    runCleanup(7, false, true);
    expect(lastReport()).toMatchObject({ removed: false });
    // Ended under its new owner, as a stop of its own would.
    expect(readState(paths.statePath)).toMatchObject({
      sessionId: 'session-b',
      ended: { reason: expect.stringMatching(/uncommitted changes/) },
    });
    rmSync(join(paths.worktreePath, 'wip.txt'));
    process.env['QWEN_CODE_SESSION_ID'] = 'session-c';
    runCleanup(7, false, true);
    expect(lastReport()).toMatchObject({ removed: true });
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it('leaves a watch it failed to take over to end with the session that owns it', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    // A ref lock git leaves behind: the branch cannot be deleted.
    writeFileSync(
      join(repo, '.git', 'refs', 'heads', `${paths.branch}.lock`),
      '',
    );
    expect(() => runCleanup(7, false, true)).toThrow(/lock/);
    // Its owner's gate still finds the watch its own.
    expect(readState(paths.statePath)).toMatchObject({
      sessionId: 'session-a',
    });
    expect(readState(paths.statePath)!.ended).toBeUndefined();
  });

  // A shell script stands in for the remote.
  it.skipIf(process.platform === 'win32')(
    'does not end a watch a third session took over while it looked',
    () => {
      process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
      run(paths.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'wip');
      // Asking the remote for the PR head is when session-c takes it.
      const script = join(repo, 'take-over.sh');
      writeFileSync(
        script,
        `#!/bin/sh\nsed 's/"session-a"/"session-c"/' '${paths.statePath}' > '${paths.statePath}.new'\nmv '${paths.statePath}.new' '${paths.statePath}'\nexit 1\n`,
        { mode: 0o755 },
      );
      run(repo, 'remote', 'add', 'origin', repo);
      run(repo, 'config', 'remote.origin.uploadpack', script);
      expect(() => runCleanup(7, false, true)).toThrow(
        /watched by another session \(session-c\)/,
      );
      expect(readState(paths.statePath)).toMatchObject({
        sessionId: 'session-c',
      });
      expect(readState(paths.statePath)!.ended).toBeUndefined();
    },
  );

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

  // FIFOs are POSIX only.
  it.skipIf(process.platform === 'win32')(
    'discards a state that is not a regular file with --force, without blocking on it',
    () => {
      rmSync(paths.statePath);
      execFileSync('mkfifo', [paths.statePath]);
      expect(() => runCleanup(7, false)).toThrow(/not a regular file/);
      runCleanup(7, true);
      expect(existsSync(paths.statePath)).toBe(false);
      // A directory or a link to nothing in its place goes the same way.
      mkdirSync(paths.statePath);
      expect(() => runCleanup(7, false)).toThrow(/not a regular file/);
      runCleanup(7, true);
      expect(existsSync(paths.statePath)).toBe(false);
      symlinkSync(join(repo, 'nowhere'), paths.statePath);
      expect(() => runCleanup(7, false)).toThrow(/not a regular file/);
      runCleanup(7, true);
      expect(
        lstatSync(paths.statePath, { throwIfNoEntry: false }),
      ).toBeUndefined();
    },
  );

  // FIFOs are POSIX only.
  it.skipIf(process.platform === 'win32')(
    'never blocks on a history that is not a regular file, and replaces it',
    () => {
      const history = historyPath(paths, readState(paths.statePath)!);
      execFileSync('mkfifo', [history]);
      runCleanup(7, true);
      expect(lastReport()).toMatchObject({ removed: true });
      expect(readHistory(history)).toMatchObject({ prNumber: 7 });
    },
  );

  it('replaces a directory planted at the history, and with --force one at the cursor', () => {
    const history = historyPath(paths, readState(paths.statePath)!);
    mkdirSync(history);
    mkdirSync(paths.gatePath);
    runCleanup(7, false);
    expect(lastReport()).toMatchObject({ removed: true });
    expect(readHistory(history)).toMatchObject({ prNumber: 7 });
    // The cursor stays without --force: it belongs to the scheduled task.
    expect(existsSync(paths.gatePath)).toBe(true);
    runCleanup(7, true);
    expect(existsSync(paths.gatePath)).toBe(false);
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
    const other = join(dirname(repo), `${basename(repo)}-other`);
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

  it('ends a main-rooted watch from a daemon session in a linked worktree', () => {
    // The watch is rooted in the main worktree (beforeEach); a daemon session
    // in a linked worktree must still discover and end it, not report a
    // nonexistent path under its own root and leave the real watch running.
    const linked = join(dirname(repo), `${basename(repo)}-linked`);
    run(repo, 'worktree', 'add', '-q', '--detach', linked);
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(linked);
    try {
      runCleanup(7, false);
      expect(lastReport()).toMatchObject({ removed: true });
      expect(existsSync(paths.worktreePath)).toBe(false);
      expect(branchExists()).toBe(false);
    } finally {
      process.chdir(repo);
      delete process.env['QWEN_CODE_SERVE'];
      run(repo, 'worktree', 'remove', '--force', linked);
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it('ends the watch despite a sibling worktree with a malformed .qwen/tmp', () => {
    const sibling = join(dirname(repo), `${basename(repo)}-sibling`);
    run(repo, 'worktree', 'add', '-q', '--detach', sibling);
    mkdirSync(join(sibling, '.qwen'), { recursive: true });
    writeFileSync(join(sibling, '.qwen', 'tmp'), 'not a directory');
    try {
      // Discovery must isolate the sibling's ENOTDIR, not abort: the healthy
      // main-rooted watch is still found and ended.
      runCleanup(7, false);
      expect(lastReport()).toMatchObject({ removed: true });
      expect(branchExists()).toBe(false);
    } finally {
      run(repo, 'worktree', 'remove', '--force', sibling);
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  describe('in place', () => {
    const makeInPlace = () => {
      run(repo, 'worktree', 'remove', '--force', paths.worktreePath);
      run(repo, 'branch', '-D', paths.branch);
      writeState(paths.statePath, {
        ...readState(paths.statePath)!,
        inPlace: true,
        worktreePath: repo,
        branch: 'main',
      });
    };

    it('removes only the watch files; the checkout and its branch stay', () => {
      makeInPlace();
      run(repo, 'update-ref', paths.headRef, headSha);
      const log = join(dirname(paths.statePath), 'autofix-pr-7-ci-1.log');
      writeFileSync(log, 'log');
      const before = run(repo, 'rev-parse', 'HEAD');
      // cwd is the checkout itself: no "from inside it" refusal applies.
      runCleanup(7, false);
      expect(lastReport()).toMatchObject({
        removed: true,
        inPlace: true,
        worktreePath: repo,
      });
      expect(existsSync(paths.statePath)).toBe(false);
      expect(existsSync(log)).toBe(false);
      expect(run(repo, 'for-each-ref', paths.headRef)).toBe('');
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(before);
      expect(run(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(
        existsSync(
          historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
        ),
      ).toBe(true);
    });

    it('--force keeps a dirty checkout and its unpushed commits too', () => {
      makeInPlace();
      run(repo, 'commit', '-q', '--allow-empty', '-m', 'mine');
      writeFileSync(join(repo, 'dirty.txt'), 'x');
      const before = run(repo, 'rev-parse', 'HEAD');
      runCleanup(7, true);
      expect(existsSync(join(repo, 'dirty.txt'))).toBe(true);
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(before);
      expect(run(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(existsSync(paths.statePath)).toBe(false);
    });

    it('--force removes a killed helper lock, break and non-regular gate, and the head ref', () => {
      makeInPlace();
      run(repo, 'update-ref', paths.headRef, headSha);
      mkdirSync(paths.lockPath, { recursive: true });
      writeFileSync(`${paths.lockPath}.break`, '');
      mkdirSync(paths.gatePath, { recursive: true });
      runCleanup(7, true);
      expect(run(repo, 'for-each-ref', paths.headRef)).toBe('');
      expect(existsSync(paths.lockPath)).toBe(false);
      expect(existsSync(`${paths.lockPath}.break`)).toBe(false);
      expect(existsSync(paths.gatePath)).toBe(false);
      expect(run(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    });
  });
});

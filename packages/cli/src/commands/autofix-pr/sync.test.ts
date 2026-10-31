/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => ({
  live: {
    state: 'OPEN',
    headRefName: 'feat',
    baseRefName: 'main',
    isCrossRepository: false,
    headRepository: { name: 'r' },
    headRepositoryOwner: { login: 'o' },
  } as Record<string, unknown>,
  // Runs right after a real networkGit call: a concurrent fetch or branch
  // switch in the user's checkout, for the in-place race regressions.
  afterFetch: null as (() => void) | null,
  // Makes the ignored-file listing throw, for the fail-closed regression.
  failListings: false,
}));
vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: (...args: string[]) => {
    if (args[0] === 'pr') return JSON.stringify(mocks.live);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  },
  setGhHost: () => {},
  ensureAuthenticated: () => {},
}));
// The bare remote is a local path the real matcher cannot read.
vi.mock('../review/lib/remote-match.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/remote-match.js')>()),
  matchRemotes: () => ({ matched: ['origin'] }),
}));
vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>();
  return {
    ...actual,
    networkGit: (args: string[]) => {
      const out = actual.networkGit(args);
      mocks.afterFetch?.();
      return out;
    },
  };
});
vi.mock('../review/lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../review/lib/git.js')>();
  return {
    ...actual,
    gitRaw: (...args: string[]) => {
      if (mocks.failListings && args.includes('--ignored')) {
        throw new Error('simulated listing failure (ENOBUFS)');
      }
      return actual.gitRaw(...args);
    },
  };
});

import { runSync } from './sync.js';
import {
  autofixPrPaths,
  readState,
  writeAnchor,
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

  // The runner may have no git identity of its own: a commit the test
  // makes in a repository it configures none for (a submodule's checkout)
  // takes this one, while a repository's own config still wins over it.
  const gitHome = mkdtempSync(join(tmpdir(), 'autofix-git-'));
  const gitConfig = join(gitHome, 'config');
  writeFileSync(gitConfig, '[user]\n\tname = t\n\temail = t@example.com\n');
  afterAll(() => rmSync(gitHome, { recursive: true, force: true }));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig },
    }).trim();
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
    writeAnchor({ host: 'github.com', owner: 'o', repo: 'r' }, 7, repo);
    mocks.live = {
      state: 'OPEN',
      headRefName: 'feat',
      baseRefName: 'main',
      isCrossRepository: false,
      headRepository: { name: 'r' },
      headRepositoryOwner: { login: 'o' },
    };
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    process.chdir(repo);
  });

  afterEach(() => {
    mocks.afterFetch = null;
    mocks.failListings = false;
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

  it('removes a background fix its session left behind, with its round, and says so', () => {
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: '0123456789ab',
        task: 't',
        head: featSha,
        startedAt,
      }),
    );
    writeFileSync(paths.snapshotPath, '{}');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.fixPath, old, old);
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: featSha,
      moved: false,
      abandonedFix: { startedAt },
    });
    expect(existsSync(paths.fixPath)).toBe(false);
    expect(existsSync(paths.snapshotPath)).toBe(false);
    expect(runSync(7)).not.toHaveProperty('abandonedFix');
  });

  it('keeps a marker its session left behind for the next sync when this one fails', () => {
    writeFileSync(paths.fixPath, '{}');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.fixPath, old, old);
    mocks.live = { ...mocks.live!, state: 'CLOSED' };
    expect(() => runSync(7)).toThrow(/closed/);
    expect(existsSync(paths.fixPath)).toBe(true);
  });

  it("leaves the marker alone for another session's sync", () => {
    writeFileSync(paths.fixPath, '{}');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.fixPath, old, old);
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runSync(7)).toThrow(/watched by another session/);
    expect(existsSync(paths.fixPath)).toBe(true);
  });

  it('starts a round only for the task that drives the watch, and none of a watch cleanup ended', () => {
    const state = readState(paths.statePath)!;
    writeState(paths.statePath, {
      ...state,
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
    });
    expect(runSync(7, false, 'aaaaaaaaaaaa')).toMatchObject({ synced: true });
    // A fire its task queued before a later schedule replaced it.
    expect(() => runSync(7, false, 'bbbbbbbbbbbb')).toThrow(
      // The refusal names which task to delete, and which one to keep.
      /task bbbbbbbbbbbb no longer drives PR #7's watch; delete the task whose gate has --task bbbbbbbbbbbb, not the one with --task aaaaaaaaaaaa/,
    );
    // Its kept work is not discarded by a round still under way.
    writeState(paths.statePath, {
      ...state,
      ended: { at: '2026-10-25T00:00:00.000Z', reason: 'kept' },
    });
    expect(() => runSync(7, true)).toThrow(/watch was stopped/);
    // Whichever session asks: a stopped watch is no other session's to
    // resume, and the answer says how to get it back.
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runSync(7)).toThrow(/Start it again with \/autofix-pr 7/);
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

  it("gives every check its fix pushes back when it adopts someone else's push", () => {
    // The watch pushed `fix`; a check failed on it once.
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    run(remote, 'update-ref', 'refs/pull/7/head', fix);
    // Recorded on the head before the watch's push, counting from none.
    const red = {
      identity: 'run:1:2:pull_request:Test',
      check: 'Test',
      head: featSha,
      pushes: 2,
    };
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: featSha,
      pushedShas: [fix],
      failingChecks: [red],
    });
    // Following its own push spends and gives back nothing.
    expect(runSync(7)).toMatchObject({ synced: true, headSha: fix });
    expect(readState(paths.statePath)!.failingChecks).toEqual([red]);
    // Someone else pushes on top: whether or not a round reads it, the
    // check's pushes are back, counted from the watch's latest push.
    run(repo, 'fetch', '-q', 'origin', 'feat');
    run(repo, 'branch', '-f', 'feat', 'FETCH_HEAD');
    const theirs = pushFromElsewhere('theirs.txt');
    expect(runSync(7)).toMatchObject({ synced: true, headSha: theirs });
    expect(readState(paths.statePath)!.failingChecks).toEqual([
      { ...red, pushes: 0, lastPush: fix },
    ]);
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

  it('reports the commits a round left unpushed, so the next round does not push them', () => {
    // A turn ended after the fix agent committed and before the push.
    commitIn(paths.worktreePath, 'leftover.txt');
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: featSha,
      moved: false,
      unpushed: 1,
    });
    expect(runSync(7, true)).toMatchObject({ synced: true, dropped: 1 });
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: featSha,
      moved: false,
    });
  });

  it('counts as dropped only what the round made, not the PR commits it merged', () => {
    commitIn(paths.worktreePath, 'ours1.txt');
    commitIn(paths.worktreePath, 'ours2.txt');
    const theirs = pushFromElsewhere('theirs.txt');
    expect(runSync(7)).toMatchObject({
      action: 'merge',
      reason: expect.stringContaining('has 2 unpushed commit(s)'),
    });
    // The merge does not pass verification, and the round is discarded.
    run(paths.worktreePath, 'merge', '-q', '--no-edit', theirs);
    expect(runSync(7, true)).toMatchObject({
      synced: true,
      headSha: theirs,
      dropped: 3,
    });
  });

  it('records a base the PR was retargeted to, and refuses one a command cannot carry', () => {
    mocks.live = { ...mocks.live, baseRefName: 'release/2.0' };
    expect(runSync(7)).toMatchObject({ synced: true, moved: false });
    expect(readState(paths.statePath)!.baseRefName).toBe('release/2.0');
    mocks.live = { ...mocks.live, baseRefName: 'release$(id)' };
    expect(() => runSync(7)).toThrow(/cannot be named in a command/);
    expect(readState(paths.statePath)!.baseRefName).toBe('release/2.0');
  });

  it('adopts the new head once the worktree has merged it', () => {
    commitIn(paths.worktreePath, 'ours.txt');
    const theirs = pushFromElsewhere('theirs.txt');
    run(paths.worktreePath, 'merge', '-q', '--no-edit', theirs);
    const merged = worktreeHead();
    expect(runSync(7)).toEqual({
      synced: true,
      headSha: theirs,
      moved: true,
      unpushed: 2,
    });
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

  it('follows the author rolling back a push the watch made, so the next push cannot restore it', () => {
    // The watch pushed `fix` on top of the PR head.
    const fix = commitIn(paths.worktreePath, 'fix.txt');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: fix,
      pushedShas: [fix],
    });
    // The author resets the branch back to before it.
    run(repo, 'push', '-q', '--force', 'origin', `${featSha}:refs/heads/feat`);
    expect(runSync(7)).toEqual({ synced: true, headSha: featSha, moved: true });
    expect(worktreeHead()).toBe(featSha);
    expect(known()).toBe(featSha);
  });

  it('with --discard returns the worktree to the PR head, whatever it holds', () => {
    commitIn(paths.worktreePath, 'attempt.txt');
    writeFileSync(join(paths.worktreePath, 'stray.txt'), 'x');
    expect(runSync(7, true)).toEqual({
      synced: true,
      headSha: featSha,
      moved: false,
      dropped: 1,
      discardedChanges: true,
    });
    expect(worktreeHead()).toBe(featSha);
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('with --discard also removes a nested repository, and works when the branch is gone', () => {
    commitIn(paths.worktreePath, 'attempt.txt');
    const nested = join(paths.worktreePath, 'nested');
    run(paths.worktreePath, 'init', '-q', 'nested');
    writeFileSync(join(nested, 'n.txt'), 'n');
    // The PR's branch was deleted: nothing to fetch.
    run(remote, 'update-ref', '-d', 'refs/heads/feat');
    expect(runSync(7, true)).toMatchObject({
      synced: true,
      headSha: featSha,
      dropped: 1,
      discardedChanges: true,
    });
    expect(worktreeHead()).toBe(featSha);
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('with --discard also returns submodules to the commits the PR records', () => {
    // A submodule the PR records, checked out and changed by a round.
    const sub = join(base, 'sub');
    run(base, 'init', '-q', '-b', 'main', sub);
    run(sub, 'config', 'user.email', 't@example.com');
    run(sub, 'config', 'user.name', 't');
    commitIn(sub, 's.txt');
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'add sub');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    const withSub = worktreeHead();
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: withSub,
    });
    const inSub = join(paths.worktreePath, 'vendor', 'sub');
    writeFileSync(join(inSub, 's.txt'), 'changed');
    writeFileSync(join(inSub, 'new.txt'), 'new');
    commitIn(inSub, 'more.txt');
    expect(run(paths.worktreePath, 'status', '--porcelain')).not.toBe('');
    expect(runSync(7, true)).toMatchObject({ synced: true, headSha: withSub });
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('moves a checked-out submodule along when the author bumps it', () => {
    const sub = join(base, 'sub2');
    run(base, 'init', '-q', '-b', 'main', sub);
    run(sub, 'config', 'user.email', 't@example.com');
    run(sub, 'config', 'user.name', 't');
    const s1 = commitIn(sub, 's1.txt');
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'add sub');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    // Submodule commands refuse the file transport unless told otherwise;
    // a real submodule's remote is https.
    run(
      join(paths.worktreePath, 'vendor', 'sub'),
      'config',
      'protocol.file.allow',
      'always',
    );
    const withSub = worktreeHead();
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: withSub,
    });
    // The author bumps the submodule to s2 in a clone of their own.
    const s2 = commitIn(sub, 's2.txt');
    const author = join(base, 'author');
    run(base, 'clone', '-q', '-b', 'feat', remote, author);
    run(author, 'config', 'user.email', 'a@example.com');
    run(author, 'config', 'user.name', 'a');
    run(author, 'update-index', '--cacheinfo', `160000,${s2},vendor/sub`);
    run(author, 'commit', '-q', '-m', 'bump sub');
    run(author, 'push', '-q', 'origin', 'feat');
    expect(runSync(7)).toMatchObject({ synced: true, moved: true });
    expect(
      run(join(paths.worktreePath, 'vendor', 'sub'), 'rev-parse', 'HEAD'),
    ).toBe(s2);
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
    expect(s1).not.toBe(s2);

    // A bump to a commit the submodule's remote does not have cannot be
    // checked out: the worktree is not clean, and sync says so instead of
    // letting a fix commit the submodule back.
    run(
      author,
      'update-index',
      '--cacheinfo',
      `160000,${'e'.repeat(40)},vendor/sub`,
    );
    run(author, 'commit', '-q', '-m', 'bump to nowhere');
    run(author, 'push', '-q', 'origin', 'feat');
    expect(runSync(7)).toMatchObject({ synced: false, moved: true });
    // The author pushes once more. Discarding cannot check it out either,
    // and says the worktree is still not clean — having adopted the push
    // all the same, which gives a spent check its pushes back.
    const red = {
      identity: 'run:1:2:pull_request:Test',
      check: 'Test',
      head: withSub,
      pushes: 3,
    };
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      failingChecks: [red],
    });
    run(
      author,
      'update-index',
      '--cacheinfo',
      `160000,${'d'.repeat(40)},vendor/sub`,
    );
    run(author, 'commit', '-q', '-m', 'bump to nowhere again');
    run(author, 'push', '-q', 'origin', 'feat');
    expect(runSync(7, true)).toMatchObject({
      synced: false,
      reason: expect.stringContaining('still not clean after discarding'),
    });
    expect(readState(paths.statePath)!.failingChecks).toEqual([
      { ...red, pushes: 0 },
    ]);
  });

  it('never recurses into a submodule the worktree has not checked out, whatever submodule.recurse says', () => {
    // The user's own checkout has the submodule; the config is shared by
    // every worktree of the clone, and says to recurse.
    const sub = join(base, 'sub3');
    run(base, 'init', '-q', '-b', 'main', sub);
    run(sub, 'config', 'user.email', 't@example.com');
    run(sub, 'config', 'user.name', 't');
    commitIn(sub, 's1.txt');
    run(repo, 'switch', '-q', 'feat');
    run(
      repo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(repo, 'commit', '-q', '-m', 'add sub');
    run(repo, 'push', '-q', 'origin', 'feat');
    run(repo, 'switch', '-q', 'main');
    run(repo, 'config', 'submodule.recurse', 'true');
    // The worktree follows the head that added it, and discards a round.
    expect(runSync(7)).toMatchObject({ synced: true, moved: true });
    commitIn(paths.worktreePath, 'attempt.txt');
    expect(runSync(7, true)).toMatchObject({ synced: true, dropped: 1 });
    // A rewritten history is followed the same way.
    forcePushFromElsewhere('rewritten.txt');
    expect(runSync(7)).toMatchObject({ synced: true, moved: true });
    // The worktree stays readable throughout.
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  /** A repository of its own, with one commit, for a submodule. */
  const repoOf = (name: string): string => {
    const dir = join(base, name);
    run(base, 'init', '-q', '-b', 'main', dir);
    run(dir, 'config', 'user.email', 't@example.com');
    run(dir, 'config', 'user.name', 't');
    commitIn(dir, `${name}.txt`);
    return dir;
  };
  /** Lets submodule commands in `dir` fetch from a local path. */
  const allowFile = (dir: string) =>
    run(dir, 'config', 'protocol.file.allow', 'always');
  /** The author moves a gitlink of the PR branch to `sha`. */
  const authorBumps = (path: string, sha: string) => {
    const author = join(base, `author-${sha.slice(0, 7)}`);
    run(base, 'clone', '-q', '-b', 'feat', remote, author);
    run(author, 'config', 'user.email', 'a@example.com');
    run(author, 'config', 'user.name', 'a');
    run(author, 'update-index', '--cacheinfo', `160000,${sha},${path}`);
    run(author, 'commit', '-q', '-m', `bump ${path}`);
    run(author, 'push', '-q', 'origin', 'feat');
  };

  it('aligns nested submodules one level at a time, each to what its parent records', () => {
    const inner = repoOf('inner');
    const outer = repoOf('outer');
    run(
      outer,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'inner',
    );
    run(outer, 'commit', '-q', '-m', 'add inner');
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      outer,
      'outer',
    );
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '-q',
      '--init',
      '--recursive',
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'add outer');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: worktreeHead(),
    });
    allowFile(join(paths.worktreePath, 'outer'));
    allowFile(join(paths.worktreePath, 'outer', 'inner'));
    // outer moves on, and records a newer inner.
    const i2 = commitIn(inner, 'i2.txt');
    run(join(outer, 'inner'), 'pull', '-q', 'origin', 'main');
    run(outer, 'add', 'inner');
    run(outer, 'commit', '-q', '-m', 'bump inner');
    authorBumps('outer', run(outer, 'rev-parse', 'HEAD'));
    expect(runSync(7)).toMatchObject({ synced: true, moved: true });
    expect(
      run(join(paths.worktreePath, 'outer', 'inner'), 'rev-parse', 'HEAD'),
    ).toBe(i2);
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('aligns submodules after a round merged a head that moved one', () => {
    const sub = repoOf('msub');
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'add sub');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: worktreeHead(),
    });
    allowFile(join(paths.worktreePath, 'vendor', 'sub'));
    // The round's fix, while the author bumps the submodule on top.
    commitIn(paths.worktreePath, 'fix.txt');
    const s2 = commitIn(sub, 's2.txt');
    authorBumps('vendor/sub', s2);
    expect(runSync(7)).toMatchObject({ synced: false, action: 'merge' });
    run(
      paths.worktreePath,
      'fetch',
      '-q',
      '--no-recurse-submodules',
      'origin',
      'feat',
    );
    run(paths.worktreePath, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    expect(runSync(7)).toMatchObject({ synced: true, moved: true });
    expect(
      run(join(paths.worktreePath, 'vendor', 'sub'), 'rev-parse', 'HEAD'),
    ).toBe(s2);
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  /** A submodule at vendor/sub of the PR head, checked out in the worktree. */
  const checkedOutSub = (name: string) => {
    const sub = repoOf(name);
    const s1 = run(sub, 'rev-parse', 'HEAD');
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'add sub');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: worktreeHead(),
    });
    const dir = join(paths.worktreePath, 'vendor', 'sub');
    allowFile(dir);
    return { sub, s1, dir };
  };

  it('reads a submodule path holding a newline as one path, never as another submodule to reset', () => {
    const { sub, s1, dir } = checkedOutSub('nlsub');
    const s2 = commitIn(sub, 's2.txt');
    // The PR names a second submodule whose path ends in what a line-based
    // listing would read as "<s2> vendor/sub" — listed after the real one.
    const forged = `x\n${s2} vendor/sub`;
    const author = join(base, 'author-nl');
    run(base, 'clone', '-q', '-b', 'feat', remote, author);
    run(author, 'config', 'user.email', 'a@example.com');
    run(author, 'config', 'user.name', 'a');
    run(
      author,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${s1},${forged}`,
    );
    writeFileSync(
      join(author, '.gitmodules'),
      `${readFileSync(join(author, '.gitmodules'), 'utf8')}[submodule "forged"]\n\tpath = "x\\n${s2} vendor/sub"\n\turl = ${sub}\n`,
    );
    run(author, 'add', '.gitmodules');
    run(author, 'commit', '-q', '-m', 'forged');
    run(author, 'push', '-q', 'origin', 'feat');
    expect(runSync(7)).toMatchObject({ moved: true });
    const head = worktreeHead();
    // A round checks the submodules out.
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '-q',
      '--init',
    );
    expect(runSync(7)).toMatchObject({ synced: true });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(s1);
    expect(worktreeHead()).toBe(head);
  });

  it('leaves alone a submodule whose git directory or work tree is not its own', () => {
    const { sub, s1, dir } = checkedOutSub('gsub');
    const gitDir = run(dir, 'rev-parse', '--absolute-git-dir');
    // A work tree configured elsewhere would be written there.
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    run(dir, 'config', 'core.worktree', elsewhere);
    authorBumps('vendor/sub', commitIn(sub, 's2.txt'));
    // `--discard` is the path that resets whatever the worktree holds.
    expect(runSync(7, true)).toMatchObject({ synced: false, moved: true });
    expect(readdirSync(elsewhere)).toEqual([]);
    run(gitDir, 'config', '--unset', 'core.worktree');
    // A `.git` file naming the user's repository would move its branch to
    // a commit it has.
    authorBumps('vendor/sub', featSha);
    const main = run(repo, 'rev-parse', 'main');
    writeFileSync(join(dir, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    expect(runSync(7, true)).toMatchObject({ synced: false });
    expect(run(repo, 'rev-parse', 'main')).toBe(main);
    expect(run(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(s1).not.toBe(featSha);
  });

  it('leaves alone a submodule that resolves outside the worktree', () => {
    // Git 2.45.1 and later refuse to list it at all; older ones list it,
    // and the helper skips it.
    const { sub, s1, dir } = checkedOutSub('osub');
    const gitDir = run(dir, 'rev-parse', '--absolute-git-dir');
    const outside = join(base, 'outside-sub');
    renameSync(dir, outside);
    symlinkSync(outside, dir);
    writeFileSync(join(outside, '.git'), `gitdir: ${gitDir}\n`);
    // A round's merge moved the gitlink (a reset or checkout of the
    // worktree would replace the symlink itself).
    const s2 = commitIn(sub, 's2.txt');
    run(
      paths.worktreePath,
      'update-index',
      '--cacheinfo',
      `160000,${s2},vendor/sub`,
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'merged bump');
    expect(runSync(7)).toMatchObject({ synced: false, moved: false });
    expect(run(outside, 'rev-parse', 'HEAD')).toBe(s1);
  });

  it('moves a submodule whose git directory is embedded in it', () => {
    const sub = repoOf('esub');
    const dir = join(paths.worktreePath, 'vendor', 'emb');
    run(base, 'clone', '-q', sub, dir);
    run(
      paths.worktreePath,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/emb',
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'add emb');
    run(paths.worktreePath, 'push', '-q', 'origin', 'HEAD:feat');
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      lastKnownHeadSha: worktreeHead(),
    });
    allowFile(dir);
    expect(statSync(join(dir, '.git')).isDirectory()).toBe(true);
    const s2 = commitIn(sub, 's2.txt');
    authorBumps('vendor/emb', s2);
    expect(runSync(7)).toMatchObject({ synced: true, moved: true });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(s2);
  });

  it('keeps the work a submodule holds when the worktree already contains the PR head', () => {
    const { dir, s1 } = checkedOutSub('ksub');
    writeFileSync(join(dir, 'ksub.txt'), 'changed');
    expect(runSync(7)).toMatchObject({ synced: false, moved: false });
    expect(readFileSync(join(dir, 'ksub.txt'), 'utf8')).toBe('changed');
    run(dir, 'checkout', '-q', '--', 'ksub.txt');
    const own = commitIn(dir, 'own.txt');
    expect(runSync(7)).toMatchObject({ synced: false, moved: false });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(own);
    // Discarding takes it back to what the PR records.
    expect(runSync(7, true)).toMatchObject({ synced: true });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(s1);
  });

  it('with --discard does not throw on a worktree git cannot read', () => {
    // A submodule whose gitfile points nowhere: git status fails.
    run(
      paths.worktreePath,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${featSha},vendor/broken`,
    );
    run(paths.worktreePath, 'commit', '-q', '-m', 'gitlink');
    mkdirSync(join(paths.worktreePath, 'vendor', 'broken'), {
      recursive: true,
    });
    writeFileSync(
      join(paths.worktreePath, 'vendor', 'broken', '.git'),
      'gitdir: /nowhere\n',
    );
    expect(() => runSync(7, true)).not.toThrow();
  });

  it('follows only the branch GitHub names, not one an edited state file names', () => {
    run(repo, 'branch', 'release', 'main');
    const release = run(repo, 'rev-parse', 'release');
    // A refspec in the branch name would write the user's `release`.
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      headRefName: 'feat:refs/heads/release',
    } as AutofixPrState);
    expect(() => runSync(7)).toThrow(/invalid headRefName/);
    writeState(paths.statePath, {
      ...JSON.parse(readFileSync(paths.statePath, 'utf8')),
      headRefName: 'other',
    });
    expect(() => runSync(7)).toThrow(/head branch is feat, not the other/);
    expect(run(repo, 'rev-parse', 'release')).toBe(release);
  });

  it('with --discard quits a rebase a fix left stopped on a conflict', () => {
    // `git pull` under the user's pull.rebase=true stops on a conflict.
    run(repo, 'switch', '-q', '-c', 'upstream', featSha);
    writeFileSync(join(repo, 'clash.txt'), 'theirs');
    run(repo, 'add', 'clash.txt');
    run(repo, 'commit', '-q', '-m', 'theirs');
    run(repo, 'switch', '-q', 'main');
    writeFileSync(join(paths.worktreePath, 'clash.txt'), 'ours');
    run(paths.worktreePath, 'add', 'clash.txt');
    run(paths.worktreePath, 'commit', '-q', '-m', 'ours');
    expect(() => run(paths.worktreePath, 'rebase', '-q', 'upstream')).toThrow();
    expect(() => runSync(7)).toThrow(/detached HEAD/);
    expect(runSync(7, true)).toMatchObject({ synced: true, headSha: featSha });
    expect(run(paths.worktreePath, 'symbolic-ref', 'HEAD')).toBe(
      `refs/heads/${paths.branch}`,
    );
    expect(run(paths.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('with --discard quits a merge a fix left stopped on another branch', () => {
    run(repo, 'switch', '-q', '-c', 'upstream2', featSha);
    writeFileSync(join(repo, 'clash.txt'), 'theirs');
    run(repo, 'add', 'clash.txt');
    run(repo, 'commit', '-q', '-m', 'theirs');
    run(repo, 'switch', '-q', 'main');
    run(paths.worktreePath, 'switch', '-q', '-c', 'fix/merge');
    writeFileSync(join(paths.worktreePath, 'clash.txt'), 'ours');
    run(paths.worktreePath, 'add', 'clash.txt');
    run(paths.worktreePath, 'commit', '-q', '-m', 'ours');
    expect(() =>
      run(paths.worktreePath, 'merge', '-q', '--no-edit', 'upstream2'),
    ).toThrow();
    expect(runSync(7, true)).toMatchObject({ synced: true, headSha: featSha });
    expect(run(paths.worktreePath, 'symbolic-ref', 'HEAD')).toBe(
      `refs/heads/${paths.branch}`,
    );
  });

  it("fetches with the user's own ssh command", () => {
    const ssh = join(base, 'fake-ssh');
    writeFileSync(
      ssh,
      '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n',
      { mode: 0o755 },
    );
    run(repo, 'remote', 'set-url', 'origin', `ssh://example.invalid${remote}`);
    const saved = process.env['GIT_SSH_COMMAND'];
    process.env['GIT_SSH_COMMAND'] = ssh;
    try {
      const theirs = pushFromElsewhere('theirs.txt');
      expect(runSync(7)).toMatchObject({ synced: true, headSha: theirs });
    } finally {
      if (saved === undefined) delete process.env['GIT_SSH_COMMAND'];
      else process.env['GIT_SSH_COMMAND'] = saved;
    }
  });

  it('refuses a worktree with another branch checked out', () => {
    run(repo, 'branch', 'mine', featSha);
    run(paths.worktreePath, 'switch', '-q', 'mine');
    forcePushFromElsewhere('rewritten.txt');
    expect(() => runSync(7)).toThrow(/branch mine checked out/);
    expect(run(repo, 'rev-parse', 'mine')).toBe(featSha);
  });

  it('with --discard takes the worktree back to the watch branch from one a fix switched to', () => {
    run(paths.worktreePath, 'switch', '-q', '-c', 'fix/ci');
    const theirs = commitIn(paths.worktreePath, 'on-fix-branch.txt');
    writeFileSync(join(paths.worktreePath, 'stray.txt'), 'x');
    expect(runSync(7, true)).toMatchObject({ synced: true, headSha: featSha });
    expect(run(paths.worktreePath, 'symbolic-ref', 'HEAD')).toBe(
      `refs/heads/${paths.branch}`,
    );
    // The other branch keeps its commit; the watch's branch is untouched.
    expect(run(repo, 'rev-parse', 'fix/ci')).toBe(theirs);
    expect(worktreeHead()).toBe(featSha);
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

  describe('in place', () => {
    let other: string;
    /** Someone else pushes to the PR branch, from a checkout of their own. */
    const pushFromOther = (file: string) => {
      const sha = commitIn(other, file);
      run(other, 'push', '-q', 'origin', 'feat');
      run(remote, 'update-ref', 'refs/pull/7/head', sha);
      return sha;
    };

    beforeEach(() => {
      // Turn the fixture's watch into an in-place one on repo itself.
      run(repo, 'worktree', 'remove', '--force', paths.worktreePath);
      run(repo, 'branch', '-D', paths.branch);
      run(repo, 'switch', '-q', 'feat');
      writeState(paths.statePath, {
        ...readState(paths.statePath)!,
        inPlace: true,
        worktreePath: repo,
        branch: 'feat',
      });
      other = join(base, 'other');
      run(base, 'clone', '-q', remote, other);
      run(other, 'config', 'user.email', 't@example.com');
      run(other, 'config', 'user.name', 't');
      run(other, 'checkout', '-q', 'feat');
    });

    it('refuses --discard and keeps what the checkout holds', () => {
      writeFileSync(join(repo, 'dirty.txt'), 'mine');
      expect(() => runSync(7, true)).toThrow(/never discards/);
      expect(existsSync(join(repo, 'dirty.txt'))).toBe(true);
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(featSha);
      expect(known()).toBe(featSha);
    });

    it('answers synced:false for a dirty checkout, without --discard advice', () => {
      const theirs = pushFromOther('theirs.txt');
      writeFileSync(join(repo, 'dirty.txt'), 'mine');
      const outcome = runSync(7);
      expect(outcome).toMatchObject({
        synced: false,
        headSha: theirs,
        moved: true,
      });
      expect(outcome.reason).toMatch(/commit or stash/);
      expect(outcome.reason).not.toMatch(/--discard/);
      // The branch did not move, and the dirty file survived.
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(featSha);
      expect(existsSync(join(repo, 'dirty.txt'))).toBe(true);
    });

    it('never resets the branch when the author rewrote history', () => {
      run(other, 'checkout', '-q', '--orphan', 'rewrite');
      run(other, 'commit', '-q', '--allow-empty', '-m', 'rewrite');
      const sha = run(other, 'rev-parse', 'HEAD');
      run(other, 'push', '-q', '--force', 'origin', 'rewrite:feat');
      run(remote, 'update-ref', 'refs/pull/7/head', sha);
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, headSha: sha });
      expect(outcome.reason).toMatch(/rewrote the PR's history/);
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(featSha);
      expect(run(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat');
    });

    it('fast-forwards a clean checkout to the new head', () => {
      const theirs = pushFromOther('theirs.txt');
      expect(runSync(7)).toMatchObject({
        synced: true,
        headSha: theirs,
        moved: true,
      });
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(theirs);
      expect(known()).toBe(theirs);
    });

    it('asks for a merge when the checkout holds unpushed commits', () => {
      commitIn(repo, 'mine.txt');
      pushFromOther('theirs.txt');
      expect(runSync(7)).toMatchObject({ synced: false, action: 'merge' });
      // Nothing moved: the merge is the round's to make, attended.
      expect(run(repo, 'rev-parse', 'HEAD')).not.toBe(known());
    });

    it('refuses when the user switched the checkout to another branch', () => {
      run(repo, 'switch', '-q', 'main');
      expect(() => runSync(7)).toThrow(/branch main checked out/);
      expect(run(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    });

    /** A submodule the PR records, checked out in the user's checkout. */
    const withSubmodule = () => {
      const sub = join(base, 'sub-ip');
      run(base, 'init', '-q', '-b', 'main', sub);
      run(sub, 'config', 'user.email', 't@example.com');
      run(sub, 'config', 'user.name', 't');
      const s1 = commitIn(sub, 's1.txt');
      run(
        repo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'vendor/sub',
      );
      run(repo, 'commit', '-q', '-m', 'add sub');
      run(repo, 'push', '-q', 'origin', 'HEAD:feat');
      run(
        join(repo, 'vendor', 'sub'),
        'config',
        'protocol.file.allow',
        'always',
      );
      const withSub = run(repo, 'rev-parse', 'HEAD');
      run(remote, 'update-ref', 'refs/pull/7/head', withSub);
      writeState(paths.statePath, {
        ...readState(paths.statePath)!,
        lastKnownHeadSha: withSub,
      });
      // The author bumps the submodule to s2 in a clone of their own.
      const s2 = commitIn(sub, 's2.txt');
      const author = join(base, 'author-ip');
      run(base, 'clone', '-q', '-b', 'feat', remote, author);
      run(author, 'config', 'user.email', 'a@example.com');
      run(author, 'config', 'user.name', 'a');
      run(author, 'update-index', '--cacheinfo', `160000,${s2},vendor/sub`);
      run(author, 'commit', '-q', '-m', 'bump sub');
      run(author, 'push', '-q', 'origin', 'feat');
      const bump = run(author, 'rev-parse', 'HEAD');
      run(remote, 'update-ref', 'refs/pull/7/head', bump);
      return { s1, s2, bump, inSub: join(repo, 'vendor', 'sub') };
    };

    it('moves a checked-out submodule along on a clean fast-forward', () => {
      const { s2, bump, inSub } = withSubmodule();
      expect(runSync(7)).toMatchObject({ synced: true, moved: true });
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(bump);
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s2);
    });

    it('leaves a submodule holding work alone, and moves nothing', () => {
      const { s1, inSub } = withSubmodule();
      const before = run(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(inSub, 'mine.txt'), 'mine');
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/commit or stash/);
      expect(outcome.reason).not.toMatch(/--discard/);
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(before);
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s1);
      expect(existsSync(join(inSub, 'mine.txt'))).toBe(true);
    });

    it('names an unfetchable submodule commit in the in-place reason', () => {
      const { inSub } = withSubmodule();
      // The recorded commit exists only in the author's clone: the
      // submodule's own remote can never serve it, and nothing is dirty.
      run(inSub, 'remote', 'set-url', 'origin', join(base, 'no-such-remote'));
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/could not be fetched/);
      expect(outcome.reason).not.toMatch(/--discard/);
    });

    it('refuses to overwrite an ignored user file the PR head starts tracking', () => {
      writeFileSync(join(repo, 'secret.env'), 'LOCAL_WORK=do-not-delete');
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'secret.env\n');
      // The PR head starts tracking secret.env.
      const author = join(base, 'author-ign');
      run(base, 'clone', '-q', remote, author);
      run(author, 'config', 'user.email', 'a@example.com');
      run(author, 'config', 'user.name', 'a');
      run(author, 'checkout', '-q', 'feat');
      writeFileSync(join(author, 'secret.env'), 'REMOTE_REPLACEMENT=1');
      run(author, 'add', 'secret.env');
      run(author, 'commit', '-q', '-m', 'track secret');
      run(author, 'push', '-q', 'origin', 'feat');
      const sha = run(author, 'rev-parse', 'HEAD');
      run(remote, 'update-ref', 'refs/pull/7/head', sha);
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/secret\.env/);
      expect(outcome.reason).toMatch(/ignored/);
      // The user's bytes and the branch tip both survive.
      expect(readFileSync(join(repo, 'secret.env'), 'utf8')).toBe(
        'LOCAL_WORK=do-not-delete',
      );
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(featSha);
      expect(known()).toBe(featSha);
    });

    it('refuses to overwrite an ignored file inside a submodule the PR head bumps', () => {
      const { s1, inSub } = withSubmodule();
      // The user's ignored file inside the checked-out submodule. A
      // submodule's .git is a gitfile: its exclude lives in the git
      // directory it names.
      writeFileSync(
        join(inSub, 'secret.env'),
        'SUBMODULE_LOCAL_WORK=do-not-delete',
      );
      const subGitDir = run(inSub, 'rev-parse', '--absolute-git-dir');
      mkdirSync(join(subGitDir, 'info'), { recursive: true });
      writeFileSync(join(subGitDir, 'info', 'exclude'), 'secret.env\n');
      // A further submodule commit that starts tracking secret.env, bumped
      // by the PR head.
      const sub = join(base, 'sub-ip');
      writeFileSync(join(sub, 'secret.env'), 'REMOTE_BYTES=1');
      run(sub, 'add', 'secret.env');
      run(sub, 'commit', '-q', '-m', 'track secret in sub');
      const s3 = run(sub, 'rev-parse', 'HEAD');
      const author = join(base, 'author-ip');
      run(author, 'update-index', '--cacheinfo', `160000,${s3},vendor/sub`);
      run(author, 'commit', '-q', '-m', 'bump sub to secret-tracking');
      run(author, 'push', '-q', 'origin', 'HEAD:feat');
      run(
        remote,
        'update-ref',
        'refs/pull/7/head',
        run(author, 'rev-parse', 'HEAD'),
      );
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/vendor\/sub: secret\.env/);
      // The user's bytes and the submodule tip both survive.
      expect(readFileSync(join(inSub, 'secret.env'), 'utf8')).toBe(
        'SUBMODULE_LOCAL_WORK=do-not-delete',
      );
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s1);
    });

    /** Bumps the PR head's gitlink to a submodule commit tracking `files`. */
    const bumpSubmoduleTo = (files: Record<string, string>) => {
      const sub = join(base, 'sub-ip');
      for (const [name, content] of Object.entries(files)) {
        const p = join(sub, name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        run(sub, 'add', name);
      }
      run(sub, 'commit', '-q', '-m', 'bump sub files');
      const s3 = run(sub, 'rev-parse', 'HEAD');
      const author = join(base, 'author-ip');
      run(author, 'update-index', '--cacheinfo', `160000,${s3},vendor/sub`);
      run(author, 'commit', '-q', '-m', 'bump gitlink');
      run(author, 'push', '-q', 'origin', 'HEAD:feat');
      run(
        remote,
        'update-ref',
        'refs/pull/7/head',
        run(author, 'rev-parse', 'HEAD'),
      );
    };

    /** Ignores `pattern` inside the checked-out submodule. */
    const ignoreInSubmodule = (inSub: string, pattern: string) => {
      const subGitDir = run(inSub, 'rev-parse', '--absolute-git-dir');
      mkdirSync(join(subGitDir, 'info'), { recursive: true });
      writeFileSync(join(subGitDir, 'info', 'exclude'), `${pattern}\n`);
    };

    it('refuses when the target tracks a blob where an ignored directory sits', () => {
      const { s1, inSub } = withSubmodule();
      mkdirSync(join(inSub, 'local-dir'), { recursive: true });
      writeFileSync(
        join(inSub, 'local-dir', 'secret.env'),
        'DIR_LOCAL_WORK=do-not-delete',
      );
      ignoreInSubmodule(inSub, 'local-dir/');
      bumpSubmoduleTo({ 'local-dir': 'REMOTE_BLOB=1' });
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/vendor\/sub: local-dir/);
      expect(readFileSync(join(inSub, 'local-dir', 'secret.env'), 'utf8')).toBe(
        'DIR_LOCAL_WORK=do-not-delete',
      );
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s1);
    });

    it('refuses when the target tracks a directory where an ignored file sits', () => {
      const { s1, inSub } = withSubmodule();
      writeFileSync(join(inSub, 'local-file'), 'FILE_LOCAL_WORK=do-not-delete');
      ignoreInSubmodule(inSub, 'local-file');
      bumpSubmoduleTo({ 'local-file/remote.txt': 'REMOTE=1' });
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/vendor\/sub: local-file\/remote\.txt/);
      expect(readFileSync(join(inSub, 'local-file'), 'utf8')).toBe(
        'FILE_LOCAL_WORK=do-not-delete',
      );
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s1);
    });

    it('refuses the reset when the ignored-file listing cannot be read', () => {
      const { s1, inSub } = withSubmodule();
      writeFileSync(
        join(inSub, 'secret.env'),
        'SUBMODULE_LOCAL_WORK=do-not-delete',
      );
      ignoreInSubmodule(inSub, 'secret.env');
      bumpSubmoduleTo({ 'secret.env': 'REMOTE_BYTES=1' });
      // A failed enumeration (e.g. a listing past the command buffer) must
      // refuse the reset, not read as "no ignored files".
      mocks.failListings = true;
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/unreadable/);
      expect(readFileSync(join(inSub, 'secret.env'), 'utf8')).toBe(
        'SUBMODULE_LOCAL_WORK=do-not-delete',
      );
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s1);
    });

    it('refuses a differently cased collision when the submodule is case-insensitive', () => {
      const { s1, inSub } = withSubmodule();
      // Git's own view of a case-insensitive filesystem: differently cased
      // names identify the same path, so the guard must fold case too.
      run(inSub, 'config', 'core.ignorecase', 'true');
      writeFileSync(
        join(inSub, 'CaseSecret.env'),
        'CASE_COLLISION_USER_BYTES=keep',
      );
      ignoreInSubmodule(inSub, 'CaseSecret.env');
      bumpSubmoduleTo({ 'casesecret.env': 'REMOTE_BYTES=1' });
      const outcome = runSync(7);
      expect(outcome).toMatchObject({ synced: false, moved: true });
      expect(outcome.reason).toMatch(/vendor\/sub: casesecret\.env/);
      expect(readFileSync(join(inSub, 'CaseSecret.env'), 'utf8')).toBe(
        'CASE_COLLISION_USER_BYTES=keep',
      );
      expect(run(inSub, 'rev-parse', 'HEAD')).toBe(s1);
    });

    // The coexistence case needs differently cased names to be distinct
    // files. Probe the tmpdir the fixtures live on: on a case-insensitive
    // filesystem git sets core.ignorecase itself, the guard rightly
    // refuses, and only the refusal case above applies.
    const caseSensitiveTmp = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'autofix-case-probe-'));
      try {
        writeFileSync(join(dir, 'CaseProbe'), 'upper');
        writeFileSync(join(dir, 'caseprobe'), 'lower');
        return readdirSync(dir).length === 2;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();

    it.skipIf(!caseSensitiveTmp)(
      'does not fold case on a case-sensitive submodule',
      () => {
        const { inSub } = withSubmodule();
        // Default core.ignorecase on a case-sensitive filesystem: the two
        // names are different files, and the alignment must still proceed.
        writeFileSync(
          join(inSub, 'CaseSecret.env'),
          'CASE_COLLISION_USER_BYTES=keep',
        );
        ignoreInSubmodule(inSub, 'CaseSecret.env');
        bumpSubmoduleTo({ 'casesecret.env': 'REMOTE_BYTES=1' });
        const outcome = runSync(7);
        expect(outcome).toMatchObject({ synced: true, moved: true });
        expect(readFileSync(join(inSub, 'CaseSecret.env'), 'utf8')).toBe(
          'CASE_COLLISION_USER_BYTES=keep',
        );
        expect(readFileSync(join(inSub, 'casesecret.env'), 'utf8')).toBe(
          'REMOTE_BYTES=1',
        );
      },
    );

    it('reads the PR head from the private ref when a concurrent fetch rewrites FETCH_HEAD', () => {
      // A descendant of the PR head on another remote branch: an
      // interleaved fetch of it would fast-forward the user's branch to
      // the wrong commit if sync read the shared FETCH_HEAD.
      run(repo, 'switch', '-q', '-c', 'extra');
      const wrong = commitIn(repo, 'extra.txt');
      run(repo, 'push', '-q', 'origin', 'extra');
      run(repo, 'switch', '-q', 'feat');
      mocks.afterFetch = () => {
        run(repo, 'fetch', '-q', 'origin', 'extra');
      };
      expect(runSync(7)).toMatchObject({
        synced: true,
        headSha: featSha,
        moved: false,
      });
      expect(run(repo, 'rev-parse', 'HEAD')).toBe(featSha);
      expect(known()).toBe(featSha);
      expect(wrong).not.toBe(featSha);
    });

    it('refuses when the user switches branches during the fetch', () => {
      const theirs = pushFromOther('theirs.txt');
      const mainBefore = run(repo, 'rev-parse', 'main');
      mocks.afterFetch = () => {
        run(repo, 'switch', '-q', 'main');
      };
      expect(() => runSync(7)).toThrow(/branch main checked out/);
      // Neither branch advanced.
      expect(run(repo, 'rev-parse', 'feat')).toBe(featSha);
      expect(run(repo, 'rev-parse', 'main')).toBe(mainBefore);
      expect(known()).toBe(featSha);
      expect(theirs).not.toBe(featSha);
    });
  });
});

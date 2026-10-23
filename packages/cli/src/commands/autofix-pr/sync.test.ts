/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => ({
  live: {
    state: 'OPEN',
    headRefName: 'feat',
    isCrossRepository: false,
    headRepository: { name: 'r' },
    headRepositoryOwner: { login: 'o' },
  } as Record<string, unknown>,
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
    mocks.live = {
      state: 'OPEN',
      headRefName: 'feat',
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

  it('refuses a worktree with another branch checked out', () => {
    run(repo, 'branch', 'mine', featSha);
    run(paths.worktreePath, 'switch', '-q', 'mine');
    forcePushFromElsewhere('rewritten.txt');
    expect(() => runSync(7)).toThrow(/branch mine checked out/);
    expect(run(repo, 'rev-parse', 'mine')).toBe(featSha);
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

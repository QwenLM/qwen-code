/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real git (a bare "remote" carrying refs/pull/7/head, a clone of it) around
// a mocked `gh`. Remote matching is steered because `git remote -v` prints
// the local path of the bare repository; lib/remote-match.test.ts covers it.

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
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => ({
  gh: vi.fn((..._args: string[]): string => ''),
  // Steers `matchRemotes` for a real `git remote -v` listing (several lines:
  // the clone's remotes are local paths); null hands a call to the real
  // matcher, which the push-URL validation uses one synthesized line at a time.
  matched: vi.fn((_owner: string, _remoteV: string): string[] | null => [
    'origin',
  ]),
  stdout: vi.fn((_line: string) => {}),
  // Runs right after a real networkGit call: a concurrent fetch in the
  // user's checkout, for the FETCH_HEAD race.
  afterFetch: null as (() => void) | null,
}));

vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: mocks.gh,
  currentUser: () => 'me',
  ensureAuthenticated: () => {},
}));

vi.mock('../review/lib/remote-match.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../review/lib/remote-match.js')>();
  return {
    ...original,
    matchRemotes: (
      remoteV: string,
      input: Parameters<typeof original.matchRemotes>[1],
    ) => {
      const steered = mocks.matched(input.owner, remoteV);
      return steered === null
        ? original.matchRemotes(remoteV, input)
        : { matched: steered };
    },
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
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

import {
  eligibilityError,
  pushUrl,
  runPrepare,
  type PrView,
} from './prepare.js';
import { runCleanup } from './cleanup.js';
import {
  anchorPath,
  autofixPrPaths,
  historyPath,
  readAnchor,
  readState,
  repoRoot,
  trustAnchor,
  withWatchLock,
  writeAnchor,
  writeState,
} from './state.js';
import { requireWorktree } from './worktree.js';

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

  it('refuses branch names git cannot take, or a base the brief cannot put in a command', () => {
    expect(
      eligibilityError(prView({ headRefName: 'a..b' }), writable, 'me'),
    ).toMatch(/head branch "a\.\.b" is not a name/);
    for (const base of ['main;id', 'rel$(id)', '-x']) {
      expect(
        eligibilityError(prView({ baseRefName: base }), writable, 'me'),
      ).toMatch(/base branch .* cannot be named in a command/);
    }
    expect(
      eligibilityError(prView({ baseRefName: 'release/2.0' }), writable, 'me'),
    ).toBeNull();
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

  it('keeps a port, which the scp-like ssh form cannot carry', () => {
    expect(pushUrl('ghe.corp:8443', 'o', 'r', 'ssh')).toBe(
      'ssh://git@ghe.corp:8443/o/r.git',
    );
    expect(pushUrl('ghe.corp:8443', 'o', 'r', 'https')).toBe(
      'https://ghe.corp:8443/o/r.git',
    );
  });
});

describe('runPrepare (real git)', () => {
  let dir: string;
  let clone: string;
  let headSha: string;
  let savedCwd: string;
  let savedSession: string | undefined;
  let savedHost: string | undefined;
  let savedServe: string | undefined;

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
    // The clone's remotes are local paths the real matcher cannot read, so
    // the listing and their push-URL lines are steered; a synthesized line
    // with a GitHub URL goes to the real matcher.
    mocks.matched.mockImplementation((_owner, remoteV) =>
      !remoteV.includes('\n') && remoteV.includes('github.com')
        ? null
        : ['origin'],
    );
    mocks.stdout.mockClear();
    savedCwd = process.cwd();
    savedSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    // `runPrepare` without a host falls back to an exported GH_HOST.
    savedHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    // `watchRoot` roots a daemon session's watch at its own worktree, so a
    // runner that itself runs under `qwen serve` must not leak that into the
    // non-daemon tests: each daemon test sets it explicitly.
    savedServe = process.env['QWEN_CODE_SERVE'];
    delete process.env['QWEN_CODE_SERVE'];
    process.chdir(clone);
  });

  afterEach(() => {
    mocks.afterFetch = null;
    process.chdir(savedCwd);
    if (savedSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
    else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
    if (savedHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedHost;
    if (savedServe === undefined) delete process.env['QWEN_CODE_SERVE'];
    else process.env['QWEN_CODE_SERVE'] = savedServe;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a remote whose name a command cannot carry, before creating anything', () => {
    run(clone, 'remote', 'rename', 'origin', 'up$(id)');
    mocks.matched.mockImplementation(() => ['up$(id)']);
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /cannot be named in a command as it is/,
    );
    expect(existsSync(autofixPrPaths(clone, 7).worktreePath)).toBe(false);
  });

  it('prepares in a daemon session opened in a linked worktree, rooting under it', () => {
    // A linked worktree of the same clone is a session working directory of
    // its own: the watch roots there, inside it, where the daemon runs the
    // fix agent's commands — not under the clone's main worktree, outside it,
    // where every command would be refused (the b1887512 dead end).
    const elsewhere = join(dir, 'elsewhere');
    run(
      clone,
      'worktree',
      'add',
      '-q',
      '-b',
      'other',
      elsewhere,
      'origin/main',
    );
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(elsewhere);
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
      const paths = autofixPrPaths(elsewhere, 7);
      expect(existsSync(paths.worktreePath)).toBe(true);
      expect(run(paths.worktreePath, 'rev-parse', 'HEAD')).toBe(headSha);
      expect(lastReport()).toMatchObject({ worktreePath: paths.worktreePath });
      // Nothing was rooted under the main worktree, outside this session.
      expect(existsSync(autofixPrPaths(clone, 7).worktreePath)).toBe(false);
    } finally {
      process.chdir(clone);
      delete process.env['QWEN_CODE_SERVE'];
    }
  });

  it('prepares in a daemon session opened inside the clone', () => {
    const savedServe = process.env['QWEN_CODE_SERVE'];
    process.env['QWEN_CODE_SERVE'] = '1';
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
    } finally {
      if (savedServe === undefined) delete process.env['QWEN_CODE_SERVE'];
      else process.env['QWEN_CODE_SERVE'] = savedServe;
    }
    expect(existsSync(autofixPrPaths(clone, 7).worktreePath)).toBe(true);
  });

  it('refuses a daemon session whose working directory is below the watch root', () => {
    // The watch roots at the worktree toplevel; a session opened in a
    // subdirectory of it cannot run a worktree rooted above its own directory.
    // A resume reports the worktree already there, so the refusal has to come
    // before the state is read: otherwise this session is handed a watch whose
    // every command the daemon will refuse.
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const sub = join(clone, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(sub);
    try {
      expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
        /outside this session's working directory/,
      );
      expect(readState(paths.statePath)).toMatchObject({
        worktreePath: paths.worktreePath,
        sessionId: 'session-a',
      });
    } finally {
      process.chdir(clone);
      delete process.env['QWEN_CODE_SERVE'];
    }
  });

  it('imports the PR history when a watch moves to another worktree', () => {
    // The supported migration: cleanup in the old owning worktree keeps the
    // history beside the old state, then a daemon session prepares in a linked
    // worktree. The fresh watch must not forget the comments it already handled.
    runPrepare({ pr: 7, repo: 'o/r' });
    const mainPaths = autofixPrPaths(clone, 7);
    writeState(mainPaths.statePath, {
      ...readState(mainPaths.statePath)!,
      handledCommentIds: ['IC_already_handled'],
      postedCommentIds: ['IC_posted'],
    });
    runCleanup(7, false);
    expect(existsSync(mainPaths.worktreePath)).toBe(false);
    expect(
      existsSync(
        historyPath(mainPaths, { host: 'github.com', owner: 'o', repo: 'r' }),
      ),
    ).toBe(true);
    const linked = join(dir, 'linked');
    run(clone, 'worktree', 'add', '-q', '-b', 'other', linked, 'origin/main');
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(linked);
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
      const moved = readState(autofixPrPaths(linked, 7).statePath)!;
      expect(moved.handledCommentIds).toEqual(['IC_already_handled']);
      expect(moved.postedCommentIds).toEqual(['IC_posted']);
    } finally {
      process.chdir(clone);
      delete process.env['QWEN_CODE_SERVE'];
    }
  });

  it('merges PR history across two relocation hops', () => {
    // main handles X; linked A imports X, handles Y; linked B must union both
    // histories ([X, Y]), not import the stale main copy ([X]) first-match.
    runPrepare({ pr: 7, repo: 'o/r' });
    const mainPaths = autofixPrPaths(clone, 7);
    writeState(mainPaths.statePath, {
      ...readState(mainPaths.statePath)!,
      handledCommentIds: ['X'],
    });
    runCleanup(7, false);
    const linkedA = join(dir, 'linkedA');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherA', linkedA, 'origin/main');
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(linkedA);
    runPrepare({ pr: 7, repo: 'o/r' });
    const aPaths = autofixPrPaths(linkedA, 7);
    expect(readState(aPaths.statePath)!.handledCommentIds).toEqual(['X']);
    writeState(aPaths.statePath, {
      ...readState(aPaths.statePath)!,
      handledCommentIds: ['X', 'Y'],
    });
    runCleanup(7, false);
    const linkedB = join(dir, 'linkedB');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherB', linkedB, 'origin/main');
    process.chdir(linkedB);
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
      expect(
        readState(autofixPrPaths(linkedB, 7).statePath)!.handledCommentIds,
      ).toEqual(['X', 'Y']);
    } finally {
      process.chdir(clone);
      delete process.env['QWEN_CODE_SERVE'];
    }
  });

  it('keys the trust anchor by the clone and reads it from the external store', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const state = readState(autofixPrPaths(clone, 7).statePath)!;
    const genuine = realpathSync(clone);
    const repository = { host: 'github.com', owner: 'o', repo: 'r' };
    // prepare confirmed the anchor in the external store, keyed by this clone.
    expect(readAnchor(repository, 7)?.trustRoot).toBe(genuine);
    expect(trustAnchor(state)).toBe(genuine);
    // The anchor is clone-specific: a different main worktree resolves to a
    // different, unconfirmed key and fails closed rather than borrowing this
    // clone's confirmation (defense-in-depth against a repointed cwd).
    const other = join(dir, 'other-clone');
    run(dir, 'init', '-q', '-b', 'main', other);
    process.chdir(other);
    try {
      expect(realpathSync(repoRoot())).not.toBe(genuine);
      expect(() => trustAnchor(state)).toThrow(/no confirmed trust anchor/);
    } finally {
      process.chdir(clone);
    }
    // Tampering the state's repository redirects to another unconfirmed key,
    // which fails closed; it cannot borrow the genuine clone's anchor.
    expect(() => trustAnchor({ ...state, repo: 'other' })).toThrow(
      /no confirmed trust anchor/,
    );
  });

  it('fails closed for a watch with no confirmed anchor', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const state = readState(autofixPrPaths(clone, 7).statePath)!;
    rmSync(
      anchorPath({ host: 'github.com', owner: 'o', repo: 'r' }, 7, clone),
      {
        force: true,
      },
    );
    expect(() => trustAnchor(state)).toThrow(/no confirmed trust anchor/);
  });

  it('rejects a compromised watch through the production trustAnchor path', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const state = readState(paths.statePath)!;
    // A round builds a replacement repo and repoints the watch worktree's
    // gitfile at a self-consistent entry of it, and tampers the state anchor.
    const repl = join(dir, 'repl');
    run(dir, 'init', '-q', '-b', 'main', repl);
    run(
      repl,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'r',
    );
    const entry = join(repl, '.git', 'worktrees', 'autofix-pr-7');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'gitdir'), `${paths.worktreePath}/.git\n`);
    writeFileSync(join(entry, 'commondir'), '../../\n');
    writeFileSync(join(paths.worktreePath, '.git'), `gitdir: ${entry}\n`);
    // The production write path validates against trustAnchor(state), which
    // reads the external store (the genuine clone), so the compromised watch is
    // rejected even though the watch gitfile names the replacement.
    expect(() =>
      requireWorktree(paths, 7, clone, false, trustAnchor(state)),
    ).toThrow(/not to this clone's own entry/);
  });

  it('re-confirms the anchor on resume after the clone root changed', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const repository = { host: 'github.com', owner: 'o', repo: 'r' };
    const genuine = realpathSync(clone);
    const state = readState(autofixPrPaths(clone, 7).statePath)!;
    expect(readAnchor(repository, 7)?.trustRoot).toBe(genuine);
    // A clone move orphans the anchor keyed by the old root: the current root
    // has none, so the watch fails closed until a resume re-confirms it.
    rmSync(anchorPath(repository, 7, clone), { force: true });
    expect(readAnchor(repository, 7)).toBeNull();
    expect(() => trustAnchor(state)).toThrow(/no confirmed trust anchor/);
    // Resume re-confirms from the current cwd, re-establishing the anchor.
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readAnchor(repository, 7)?.trustRoot).toBe(genuine);
  });

  it('keeps two independent clones watching one PR on distinct anchors', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const repository = { host: 'github.com', owner: 'o', repo: 'r' };
    const genuineA = realpathSync(clone);
    expect(readAnchor(repository, 7)?.trustRoot).toBe(genuineA);
    // A second, independent clone confirms its own anchor for the same PR.
    const cloneB = join(dir, 'clone-b');
    run(dir, 'init', '-q', '-b', 'main', cloneB);
    const genuineB = realpathSync(cloneB);
    writeAnchor(repository, 7, genuineB);
    // Distinct keys: confirming B neither revokes nor overwrites A's anchor
    // (the repo+PR-only key let the second prepare revoke the first).
    expect(anchorPath(repository, 7, genuineA)).not.toBe(
      anchorPath(repository, 7, genuineB),
    );
    expect(readAnchor(repository, 7)?.trustRoot).toBe(genuineA);
    // B reads its own confirmation from its own cwd.
    process.chdir(cloneB);
    try {
      expect(readAnchor(repository, 7)?.trustRoot).toBe(genuineB);
    } finally {
      process.chdir(clone);
    }
  });

  it('keeps the latest handled conflict marker across a two-hop migration', () => {
    const repository = { host: 'github.com', owner: 'o', repo: 'r' };
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    runPrepare({ pr: 7, repo: 'o/r' });
    const mainPaths = autofixPrPaths(clone, 7);
    writeState(mainPaths.statePath, {
      ...readState(mainPaths.statePath)!,
      handledConflictSha: headA,
    });
    runCleanup(7, false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(historyPath(mainPaths, repository), old, old);
    const linkedL = join(dir, 'linkedL');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherL', linkedL, 'origin/main');
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(linkedL);
    runPrepare({ pr: 7, repo: 'o/r' });
    const lPaths = autofixPrPaths(linkedL, 7);
    writeState(lPaths.statePath, {
      ...readState(lPaths.statePath)!,
      handledConflictSha: headB,
    });
    runCleanup(7, false);
    const linkedN = join(dir, 'linkedN');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherN', linkedN, 'origin/main');
    process.chdir(linkedN);
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
      // The newer linked settlement (B) wins over the stale main marker (A).
      expect(
        readState(autofixPrPaths(linkedN, 7).statePath)!.handledConflictSha,
      ).toBe(headB);
    } finally {
      process.chdir(clone);
      delete process.env['QWEN_CODE_SERVE'];
    }
  });

  it('keeps settled history on a return hop to a former root', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const mainPaths = autofixPrPaths(clone, 7);
    writeState(mainPaths.statePath, {
      ...readState(mainPaths.statePath)!,
      handledCommentIds: ['X'],
    });
    runCleanup(7, false);
    const linkedA = join(dir, 'linkedA');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherA', linkedA, 'origin/main');
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(linkedA);
    runPrepare({ pr: 7, repo: 'o/r' });
    const aPaths = autofixPrPaths(linkedA, 7);
    writeState(aPaths.statePath, {
      ...readState(aPaths.statePath)!,
      handledCommentIds: ['X', 'Y'],
    });
    runCleanup(7, false);
    // Return to main, which still holds its old [X] history: reconciliation
    // must union A's [X,Y], not skip because main has a local history.
    process.chdir(clone);
    delete process.env['QWEN_CODE_SERVE'];
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(mainPaths.statePath)!.handledCommentIds).toEqual([
      'X',
      'Y',
    ]);
  });

  it('does not resurrect a spent rerun hold when reconciling histories', () => {
    const repository = { host: 'github.com', owner: 'o', repo: 'r' };
    const floor = `check@${'a'.repeat(40)}@123`;
    runPrepare({ pr: 7, repo: 'o/r' });
    const mainPaths = autofixPrPaths(clone, 7);
    writeState(mainPaths.statePath, {
      ...readState(mainPaths.statePath)!,
      heldChecks: [`123:${floor}`],
      deferredRuns: [123],
    });
    runCleanup(7, false);
    // Age main's history so the linked copy is unambiguously the newest.
    const old = new Date(Date.now() - 60_000);
    utimesSync(historyPath(mainPaths, repository), old, old);
    const linkedA = join(dir, 'linkedA');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherA', linkedA, 'origin/main');
    process.env['QWEN_CODE_SERVE'] = '1';
    process.chdir(linkedA);
    runPrepare({ pr: 7, repo: 'o/r' });
    const aPaths = autofixPrPaths(linkedA, 7);
    // A spends the hold: the floor settles into rerunChecks, the hold clears.
    writeState(aPaths.statePath, {
      ...readState(aPaths.statePath)!,
      rerunChecks: [floor],
      heldChecks: [],
      deferredRuns: [],
    });
    runCleanup(7, false);
    const linkedB = join(dir, 'linkedB');
    run(clone, 'worktree', 'add', '-q', '-b', 'otherB', linkedB, 'origin/main');
    process.chdir(linkedB);
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
      const st = readState(autofixPrPaths(linkedB, 7).statePath)!;
      expect(st.rerunChecks).toContain(floor);
      expect(st.heldChecks ?? []).toEqual([]);
      expect(st.deferredRuns ?? []).toEqual([]);
    } finally {
      process.chdir(clone);
      delete process.env['QWEN_CODE_SERVE'];
    }
  });

  it('starts one watch at a time: a second start waits for the lock', () => {
    const paths = autofixPrPaths(clone, 7);
    mkdirSync(dirname(paths.lockPath), { recursive: true });
    withWatchLock(paths, 7, () => {
      expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
        /another autofix-pr helper is working on PR #7/,
      );
    });
    expect(existsSync(paths.worktreePath)).toBe(false);
    expect(run(clone, 'branch', '--list', paths.branch)).toBe('');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(existsSync(paths.worktreePath)).toBe(true);
  });

  it('takes the worktree and branch back when a hook fails the worktree add', () => {
    // A post-checkout hook that fails leaves the worktree made.
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    run(clone, 'config', 'core.hooksPath', hooks);
    const paths = autofixPrPaths(clone, 7);
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow();
    expect(existsSync(paths.worktreePath)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(run(clone, 'branch', '--list', paths.branch)).toBe('');
    // With the hook fixed, the next prepare works.
    run(clone, 'config', '--unset', 'core.hooksPath');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(run(paths.worktreePath, 'rev-parse', 'HEAD')).toBe(headSha);
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

  it('pushes to the head repository URL when the matched remote pushes elsewhere', () => {
    // The fetch side matches the head repository; the push side does not.
    run(
      clone,
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://github.com/elsewhere/r.git',
    );
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      pushTarget: 'https://github.com/o/r.git',
    });
    expect(readState(autofixPrPaths(clone, 7).statePath)?.pushTarget).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('pushes to the head repository URL when a second remote URL points elsewhere', () => {
    // Two `remote.fork.url` entries and no `pushurl`: git fetches from the
    // first, which the matcher sees, and pushes to both.
    run(clone, 'remote', 'add', 'fork', 'https://github.com/contributor/r.git');
    run(
      clone,
      'remote',
      'set-url',
      '--add',
      'fork',
      'https://github.com/elsewhere/r.git',
    );
    expect(run(clone, 'remote', 'get-url', '--push', '--all', 'fork')).toBe(
      'https://github.com/contributor/r.git\nhttps://github.com/elsewhere/r.git',
    );
    mocks.matched.mockImplementation((owner, remoteV) =>
      remoteV.includes('\n') ? (owner === 'o' ? ['origin'] : ['fork']) : null,
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
      if (args[0] === 'config') return 'https';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      pushTarget: 'https://github.com/contributor/r.git',
    });
  });

  it('keeps the remote whose push URL is another spelling of the head repository', () => {
    run(
      clone,
      'remote',
      'set-url',
      '--push',
      'origin',
      'git@github.com:O/R.git',
    );
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ pushTarget: 'origin' });
  });

  it('counts local commits the PR does not have', () => {
    expect(run(clone, 'branch', '--show-current')).toBe('feat');
    run(clone, 'config', 'user.email', 't@example.com');
    run(clone, 'config', 'user.name', 't');
    run(clone, 'commit', '-q', '--allow-empty', '-m', 'local only');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ localUnpushedCommits: 1 });
  });

  it("reports uncommitted changes in the user's own checkout", () => {
    expect(run(clone, 'branch', '--show-current')).toBe('feat');
    writeFileSync(join(clone, 'scratch.txt'), 'work in progress\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      localUnpushedCommits: 0,
      localUncommittedChanges: true,
    });
  });

  it('reports no uncommitted changes for a clean checkout', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ localUncommittedChanges: false });
  });

  it('reports uncommitted changes when it resumes a watch', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    writeFileSync(join(clone, 'scratch.txt'), 'work in progress\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      resumed: true,
      localUncommittedChanges: true,
    });
  });

  it('reports no uncommitted work on the head branch no checkout has', () => {
    // The local branch whose upstream is the head branch stays, but nothing
    // has it checked out: work in another checkout is not work on that copy.
    run(clone, 'checkout', '-q', '-b', 'scratch');
    writeFileSync(join(clone, 'scratch.txt'), 'work in progress\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ localUncommittedChanges: false });
  });

  it('reports no uncommitted work on a branch that does not track the head', () => {
    run(clone, 'branch', '--unset-upstream');
    writeFileSync(join(clone, 'scratch.txt'), 'work in progress\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      localUnpushedCommits: 0,
      localUncommittedChanges: false,
    });
  });

  it('counts untracked work whatever status.showUntrackedFiles says', () => {
    run(clone, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(clone, 'new-source.ts'), 'export {};\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      localUncommittedChanges: true,
      localWorkUnknown: false,
    });
  });

  it('counts uncommitted work under .qwen outside the watch directory', () => {
    mkdirSync(join(clone, '.qwen', 'skills'), { recursive: true });
    writeFileSync(join(clone, '.qwen', 'skills', 'mine.md'), 'work\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      localUncommittedChanges: true,
      localWorkUnknown: false,
    });
  });

  it('reports unknown when the PR head is not in this clone', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const other = join(dir, 'other');
    run(dir, 'clone', '-q', join(dir, 'bare.git'), other);
    run(other, 'config', 'user.email', 't@example.com');
    run(other, 'config', 'user.name', 't');
    run(other, 'commit', '-q', '--allow-empty', '-m', 'pushed elsewhere');
    const elsewhere = run(other, 'rev-parse', 'HEAD');
    run(other, 'push', '-q', 'origin', 'feat');
    run(join(dir, 'bare.git'), 'update-ref', 'refs/pull/7/head', elsewhere);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(prView({ headRefOid: elsewhere }));
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      resumed: true,
      localUnpushedCommits: 0,
      localWorkUnknown: true,
    });
  });

  it('falls back when git has no worktree -z', () => {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const bin = join(dir, 'old-git');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ] && [ "$4" = -z ]; then exit 129; fi\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${savedPath}`;
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
    } finally {
      process.env['PATH'] = savedPath;
    }
    expect(lastReport()).toMatchObject({
      localUncommittedChanges: false,
      localWorkUnknown: false,
    });
  });

  it('counts a dirty submodule whatever diff.ignoreSubmodules says', () => {
    const sub = join(dir, 'subsrc');
    run(dir, 'init', '-q', '-b', 'main', sub);
    run(sub, 'config', 'user.email', 't@example.com');
    run(sub, 'config', 'user.name', 't');
    writeFileSync(join(sub, 'a.txt'), 'a\n');
    run(sub, 'add', 'a.txt');
    run(sub, 'commit', '-q', '-m', 'sub');
    run(
      clone,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'mod',
    );
    run(clone, 'commit', '-q', '-m', 'add submodule');
    run(clone, 'config', 'diff.ignoreSubmodules', 'all');
    writeFileSync(join(clone, 'mod', 'a.txt'), 'dirty\n');
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ localUncommittedChanges: true });
  });

  it('reads a linked checkout of the head branch', () => {
    // The work belongs to a checkout beside this one, so a scan that asked
    // the directory prepare ran in would miss it.
    run(clone, 'checkout', '-q', 'main');
    const linked = join(dir, 'linked');
    run(clone, 'worktree', 'add', '-q', linked, 'feat');
    writeFileSync(join(linked, 'dirty.txt'), 'work\n');
    const savedServe = process.env['QWEN_CODE_SERVE'];
    delete process.env['QWEN_CODE_SERVE'];
    try {
      runPrepare({ pr: 7, repo: 'o/r' });
    } finally {
      if (savedServe === undefined) delete process.env['QWEN_CODE_SERVE'];
      else process.env['QWEN_CODE_SERVE'] = savedServe;
    }
    expect(lastReport()).toMatchObject({ localUncommittedChanges: true });
  });

  it('counts commits against the live head when it resumes a watch', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    run(clone, 'config', 'user.email', 't@example.com');
    run(clone, 'config', 'user.name', 't');
    run(clone, 'commit', '-q', '--allow-empty', '-m', 'pushed to the PR');
    const pushed = run(clone, 'rev-parse', 'HEAD');
    run(clone, 'push', '-q', 'origin', 'feat');
    // GitHub moves the PR head with the branch.
    run(join(dir, 'bare.git'), 'update-ref', 'refs/pull/7/head', pushed);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(prView({ headRefOid: pushed }));
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      resumed: true,
      localUnpushedCommits: 0,
    });
  });

  it('resumes in the owning session without touching the worktree', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const answer = mocks.gh.getMockImplementation()!;
    // A resume asks GitHub only about the PR's author and head repository.
    mocks.gh.mockImplementation((...args: string[]) => {
      if (
        args[0] !== 'pr' ||
        args.at(-1) !== 'author,headRepository,headRepositoryOwner,headRefOid'
      ) {
        throw new Error(`a resume must not call gh ${args.join(' ')}`);
      }
      return answer(...args);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ resumed: true, headSha });
  });

  it('leaves nothing behind when it cannot ask GitHub who may push', () => {
    const paths = autofixPrPaths(clone, 7);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(
          prView({ headRefOid: headSha, author: { login: 'collab' } }),
        );
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      throw Object.assign(new Error('Command failed: gh api'), {
        stderr: 'gh: API rate limit exceeded (HTTP 403)',
      });
    });
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /could not ask GitHub whether collab can push/,
    );
    expect(existsSync(paths.worktreePath)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(run(clone, 'branch', '--list', paths.branch)).toBe('');
  });

  it('resumes no watch of a PR whose head repository is gone', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const answer = mocks.gh.getMockImplementation()!;
    mocks.gh.mockImplementation((...args: string[]) =>
      args[0] === 'pr'
        ? JSON.stringify(
            prView({
              headRefOid: headSha,
              headRepository: null,
              headRepositoryOwner: null,
            }),
          )
        : answer(...args),
    );
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /head repository no longer exists/,
    );
  });

  it("derives a resumed watch's remotes from the clone, not from its state file", () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const state = readState(paths.statePath)!;
    // The PR's own code wrote the file beside its worktree.
    writeState(paths.statePath, {
      ...state,
      remote: 'evil',
      pushTarget: 'https://github.com/evil/x.git',
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(paths.statePath)).toMatchObject({
      remote: state.remote,
      pushTarget: state.pushTarget,
    });
    // A repository this clone does not serve is no watch to resume.
    writeState(paths.statePath, { ...state, owner: 'evil', repo: 'x' });
    mocks.matched.mockImplementation((owner) => (owner === 'evil' ? [] : null));
    expect(() => runPrepare({ pr: 7, repo: 'evil/x' })).toThrow(
      /no single git remote here serves github.com\/evil\/x/,
    );
  });

  it('ends no watch over a failure to ask GitHub, and moves none', () => {
    const paths = autofixPrPaths(clone, 7);
    let permission: () => string = () => 'write';
    const answer = (...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(
          prView({ headRefOid: headSha, author: { login: 'collab' } }),
        );
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      if (args[0] === 'api') return permission();
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    mocks.gh.mockImplementation(answer);
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(paths.statePath)!.authorCanPush).toBe(true);
    // A rate limit says nothing of the author: the resume is refused, and
    // the watch keeps what it recorded.
    permission = () => {
      throw Object.assign(new Error('Command failed: gh api'), {
        stderr: 'gh: API rate limit exceeded (HTTP 403)',
      });
    };
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /could not ask GitHub whether collab can push/,
    );
    expect(readState(paths.statePath)!.authorCanPush).toBe(true);
    // A take-over that cannot ask GitHub leaves the watch where it was.
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') throw new Error('connection reset');
      return answer(...args);
    });
    expect(() => runPrepare({ pr: 7, repo: 'o/r', takeOver: true })).toThrow(
      /connection reset/,
    );
    expect(readState(paths.statePath)!.sessionId).toBe('session-a');
    // A 404 is the answer for someone who is not a collaborator.
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    mocks.gh.mockImplementation(answer);
    permission = () => {
      throw Object.assign(new Error('Command failed: gh api'), {
        stderr: 'gh: Not Found (HTTP 404)',
      });
    };
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ resumed: true, authorCanPush: false });
  });

  it('asks GitHub again whether the author can push, whatever the state file says', () => {
    const paths = autofixPrPaths(clone, 7);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(
          prView({ headRefOid: headSha, author: { login: 'outsider' } }),
        );
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      if (args[0] === 'api') return 'read';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(paths.statePath)!.authorCanPush).toBe(false);
    // The PR's own code ran beside the state file and wrote it.
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      authorCanPush: true,
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ resumed: true, authorCanPush: false });
    expect(readState(paths.statePath)!.authorCanPush).toBe(false);
  });

  it('resumes from inside the autofix worktree', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    process.chdir(autofixPrPaths(clone, 7).worktreePath);
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ resumed: true, headSha });
  });

  it('resumes whatever the spelling of the repository', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    runPrepare({ pr: 7, repo: 'O/R', host: 'GitHub.com' });
    expect(lastReport()).toMatchObject({ resumed: true, headSha });
    runPrepare({ pr: 7, repo: 'o/r', host: 'github.com:443' });
    expect(lastReport()).toMatchObject({ resumed: true, headSha });
  });

  it('does not resume a watch of the same host on another port', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(() =>
      runPrepare({ pr: 7, repo: 'o/r', host: 'github.com:8443' }),
    ).toThrow(/is a watch of github\.com\/o\/r, not github\.com:8443\/o\/r/);
  });

  it('refuses to create the worktree through a symlinked .qwen', () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(clone, '.qwen'));
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(/is a symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(run(clone, 'branch', '--list', 'qwen-autofix/pr-7')).toBe('');
  });

  it("refuses to resume another repository's PR of the same number", () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(() => runPrepare({ pr: 7, repo: 'fork/r' })).toThrow(
      /is a watch of github\.com\/o\/r, not github\.com\/fork\/r/,
    );
  });

  it('recreates a removed worktree and keeps the cursor', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const state = readState(paths.statePath)!;
    execFileSync('git', ['worktree', 'remove', '--force', paths.worktreePath], {
      cwd: clone,
    });
    const budgets = {
      pendingPosts: [
        { where: 101, handled: ['C3'], bodyHash: 'h', sha: headSha },
      ],
      deferredRuns: [60],
      handledChecks: [`Test@${headSha}@#5`],
      rerunChecks: [`run:1:2:push:Test@${headSha}`],
      handledConflictSha: headSha,
      pushCount: 4,
      // The head is the watch's own push: the checks keep their count.
      pushedShas: [headSha],
      summarizedSha: headSha,
      failingChecks: [
        {
          identity: 'run:1:2:push:Test',
          check: 'Test',
          head: headSha,
          pushes: 2,
          lastPush: headSha,
          unanswered: [{ sha: 'f'.repeat(40), pushes: 1 }],
        },
      ],
      // `resume` starts this task again after the rebuild.
      watch: { every: 5, reply: false, instructions: 'keep the API' },
      needsHuman: [{ sha: headSha, at: '2026-10-25T00:00:00.000Z', text: 'x' }],
    };
    writeState(paths.statePath, {
      ...state,
      handledCommentIds: ['C1'],
      ...budgets,
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(existsSync(paths.worktreePath)).toBe(true);
    // The history and the budgets survive: a removed worktree must not
    // reset the push count or the re-runs already spent.
    expect(readState(paths.statePath)).toMatchObject({
      handledCommentIds: ['C1'],
      ...budgets,
    });
    // A start that is cancelled now must not clean the watch up.
    expect(lastReport()).toMatchObject({ resumed: false, recreated: true });
  });

  it("gives every check its fix pushes back when it recreates the worktree at someone else's push", () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const pushed = 'e'.repeat(40);
    execFileSync('git', ['worktree', 'remove', '--force', paths.worktreePath], {
      cwd: clone,
    });
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      pushedShas: [pushed],
      failingChecks: [
        {
          identity: 'run:1:2:push:Test',
          check: 'Test',
          head: pushed,
          pushes: 3,
          lastPush: pushed,
          unanswered: [{ sha: 'f'.repeat(40), pushes: 2 }],
        },
      ],
    });
    // The PR head is no push of the watch's, as `sync` adopting it would see.
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(paths.statePath)).toMatchObject({
      lastKnownHeadSha: headSha,
      failingChecks: [
        {
          identity: 'run:1:2:push:Test',
          check: 'Test',
          head: pushed,
          pushes: 0,
          lastPush: pushed,
        },
      ],
    });
    expect(readState(paths.statePath)!.failingChecks![0]).not.toHaveProperty(
      'unanswered',
    );
  });

  it("reports whether the PR's author could push", () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    // The user's own PR.
    expect(lastReport()).toMatchObject({ authorCanPush: true });
    const paths = autofixPrPaths(clone, 7);
    const restart = () => {
      execFileSync(
        'git',
        ['worktree', 'remove', '--force', paths.worktreePath],
        { cwd: clone },
      );
      execFileSync('git', ['branch', '-D', paths.branch], { cwd: clone });
      rmSync(paths.statePath);
    };
    restart();
    let permission = 'read';
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        return JSON.stringify(
          prView({ headRefOid: headSha, author: { login: 'outsider' } }),
        );
      }
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      if (args[0] === 'api') {
        expect(args[1]).toBe('repos/o/r/collaborators/outsider/permission');
        return permission;
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ authorCanPush: false });
    restart();
    permission = 'write';
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({ authorCanPush: true });
  });

  it('starts a new watch from what earlier watches of the PR posted and handled', () => {
    const paths = autofixPrPaths(clone, 7);
    mkdirSync(
      dirname(
        historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
      ),
      { recursive: true },
    );
    const history = {
      version: 1,
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      handledCommentIds: ['C1'],
      postedCommentIds: ['P1'],
      handledChecks: [`Test@${headSha}@#5`],
      rerunChecks: [`run:1:2:push:Test@${headSha}`],
      handledConflictSha: headSha,
      pendingPosts: [
        { where: 101, handled: ['C2'], bodyHash: 'h', sha: headSha },
      ],
      deferredRuns: [50],
    };
    writeFileSync(
      historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
      JSON.stringify(history),
    );
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(paths.statePath)).toMatchObject({
      handledCommentIds: ['C1'],
      postedCommentIds: ['P1'],
      handledChecks: history.handledChecks,
      rerunChecks: history.rerunChecks,
      handledConflictSha: headSha,
      pendingPosts: history.pendingPosts,
      deferredRuns: [50],
    });
    // Not another repository's PR of the same number.
    execFileSync('git', ['worktree', 'remove', '--force', paths.worktreePath], {
      cwd: clone,
    });
    execFileSync('git', ['branch', '-D', paths.branch], { cwd: clone });
    rmSync(paths.statePath);
    writeFileSync(
      historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
      JSON.stringify({ ...history, owner: 'elsewhere' }),
    );
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(readState(paths.statePath)).toMatchObject({
      handledCommentIds: [],
      postedCommentIds: [],
    });
  });

  it('fetches a PR whose submodule commit no remote has, without recursing into submodules', () => {
    const sub = join(dir, 'sub');
    run(dir, 'init', '-q', '-b', 'main', sub);
    run(
      sub,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      's1',
      '--author',
      't <t@example.com>',
    );
    // The user's clone has the submodule checked out.
    run(clone, 'config', 'user.email', 't@example.com');
    run(clone, 'config', 'user.name', 't');
    run(
      clone,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(clone, 'commit', '-q', '-m', 'add sub');
    run(
      join(clone, 'vendor', 'sub'),
      'config',
      'protocol.file.allow',
      'always',
    );
    // The PR records a submodule commit its author never pushed.
    const src = join(dir, 'src');
    run(
      src,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor/sub',
    );
    run(
      src,
      'update-index',
      '--cacheinfo',
      `160000,${'e'.repeat(40)},vendor/sub`,
    );
    run(src, 'commit', '-q', '-m', 'bump to an unpushed commit');
    const prHead = run(src, 'rev-parse', 'HEAD');
    run(src, 'push', '-q', join(dir, 'bare.git'), `+HEAD:refs/pull/7/head`);
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr')
        return JSON.stringify(prView({ headRefOid: prHead }));
      if (args[0] === 'repo') return JSON.stringify(writable);
      if (args[0] === 'config') return 'https';
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    expect(run(paths.worktreePath, 'rev-parse', 'HEAD')).toBe(prHead);
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

  it('takes over a watch whose background fix its session left behind, and never one whose fix still runs', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: '0123456789ab',
        task: 't',
        head: 'a'.repeat(40),
        startedAt: new Date().toISOString(),
      }),
    );
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(() => runPrepare({ pr: 7, repo: 'o/r', takeOver: true })).toThrow(
      /a fix agent is working in PR #7's worktree/,
    );
    expect(readState(paths.statePath)).toMatchObject({
      sessionId: 'session-a',
    });
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(paths.fixPath, old, old);
    runPrepare({ pr: 7, repo: 'o/r', takeOver: true });
    expect(lastReport()).toMatchObject({ tookOver: true });
    expect(existsSync(paths.fixPath)).toBe(false);
  });

  it('hands a watch to this session with --take-over, keeping what it recorded', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    writeState(paths.statePath, {
      ...readState(paths.statePath)!,
      handledCommentIds: ['C1'],
      pushCount: 3,
    });
    // A /clear started a new session.
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    runPrepare({ pr: 7, repo: 'o/r', takeOver: true });
    expect(lastReport()).toMatchObject({ resumed: true, tookOver: true });
    expect(readState(paths.statePath)).toMatchObject({
      sessionId: 'session-b',
      handledCommentIds: ['C1'],
      pushCount: 3,
    });
    // The session it was taken from is refused now.
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /watched by another session \(session-b\)/,
    );
    // Another repository's PR of the same number is never taken over.
    expect(() => runPrepare({ pr: 7, repo: 'x/r', takeOver: true })).toThrow(
      /is a watch of/,
    );
  });

  it('dates a new state, and resumes a watch cleanup ended when started again', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const state = readState(paths.statePath)!;
    expect(Date.parse(state.preparedAt!)).not.toBeNaN();
    // Reported as recorded: a later prepare of the PR is another watch.
    expect(lastReport()).toMatchObject({
      preparedAt: state.preparedAt,
      host: 'github.com',
    });
    const ended = { at: '2026-10-25T00:00:00.000Z', reason: 'kept' };
    writeState(paths.statePath, { ...state, ended });
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      resumed: true,
      wasEnded: ended,
      preparedAt: state.preparedAt,
    });
    expect(readState(paths.statePath)!.ended).toBeUndefined();
  });

  it('says it resumed a watch stop ended, though its worktree was removed since', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    const ended = { at: '2026-10-25T00:00:00.000Z', reason: 'kept' };
    writeState(paths.statePath, { ...readState(paths.statePath)!, ended });
    run(clone, 'worktree', 'remove', '--force', paths.worktreePath);
    runPrepare({ pr: 7, repo: 'o/r' });
    expect(lastReport()).toMatchObject({
      resumed: false,
      recreated: true,
      wasEnded: ended,
    });
    expect(readState(paths.statePath)!.ended).toBeUndefined();
  });

  it('takes over a watch whose worktree was removed only once the PR passed its checks', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    run(clone, 'worktree', 'remove', '--force', paths.worktreePath);
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    const answer = mocks.gh.getMockImplementation()!;
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(prView({ state: 'MERGED' }));
      return answer(...args);
    });
    // A refusal leaves the watch with the session that has it, whose gate
    // goes on as before.
    expect(() => runPrepare({ pr: 7, repo: 'o/r', takeOver: true })).toThrow(
      /is merged/,
    );
    expect(readState(paths.statePath)!.sessionId).toBe('session-a');
    mocks.gh.mockImplementation(answer);
    runPrepare({ pr: 7, repo: 'o/r', takeOver: true });
    expect(lastReport()).toMatchObject({ resumed: false, tookOver: true });
    expect(readState(paths.statePath)!.sessionId).toBe('session-b');
    expect(existsSync(paths.worktreePath)).toBe(true);
  });

  it('reads the watch again under its lock, so a take-over meanwhile stands', () => {
    runPrepare({ pr: 7, repo: 'o/r' });
    const paths = autofixPrPaths(clone, 7);
    // The worktree is gone, so prepare goes on to make it again.
    run(clone, 'worktree', 'remove', '--force', paths.worktreePath);
    const answer = mocks.gh.getMockImplementation()!;
    mocks.gh.mockImplementation((...args: string[]) => {
      if (args[0] === 'pr') {
        // Another session takes the watch over while this one reads the PR.
        writeState(paths.statePath, {
          ...readState(paths.statePath)!,
          sessionId: 'session-b',
        });
      }
      return answer(...args);
    });
    expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
      /watched by another session \(session-b\)/,
    );
    expect(readState(paths.statePath)).toMatchObject({
      sessionId: 'session-b',
    });
    expect(existsSync(paths.worktreePath)).toBe(false);
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

  describe('--in-place', () => {
    // The bare's HEAD is feat (src was on it when the bare was cloned), so
    // the clone already sits on feat, tracking origin/feat, at the PR head.
    const statePath = () => autofixPrPaths(clone, 7).statePath;

    it("prepares the user's checkout: no worktree, no branch of its own", () => {
      runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
      const state = readState(statePath())!;
      expect(state).toMatchObject({
        inPlace: true,
        worktreePath: clone,
        branch: 'feat',
        lastKnownHeadSha: headSha,
      });
      expect(lastReport()).toMatchObject({
        inPlace: true,
        resumed: false,
        worktreePath: clone,
      });
      expect(existsSync(autofixPrPaths(clone, 7).worktreePath)).toBe(false);
      expect(run(clone, 'branch', '--list', 'qwen-autofix/pr-7')).toBe('');
      // The checkout did not move.
      expect(run(clone, 'rev-parse', 'HEAD')).toBe(headSha);
    });

    it('refuses another branch, leaving nothing written', () => {
      run(clone, 'checkout', '-q', 'main');
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /needs the PR's head branch feat/,
      );
      expect(existsSync(statePath())).toBe(false);
    });

    it('refuses a detached HEAD', () => {
      run(clone, 'checkout', '-q', '--detach');
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /detached HEAD/,
      );
      expect(existsSync(statePath())).toBe(false);
    });

    it('refuses uncommitted changes and keeps them', () => {
      writeFileSync(join(clone, 'dirty.txt'), 'mine');
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /uncommitted changes/,
      );
      expect(existsSync(join(clone, 'dirty.txt'))).toBe(true);
      expect(existsSync(statePath())).toBe(false);
    });

    it('refuses unpushed local commits and keeps them', () => {
      run(clone, 'commit', '-q', '--allow-empty', '-m', 'mine');
      const mine = run(clone, 'rev-parse', 'HEAD');
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /commits the PR does not have/,
      );
      expect(run(clone, 'rev-parse', 'HEAD')).toBe(mine);
      expect(existsSync(statePath())).toBe(false);
    });

    it('prepares a behind branch without moving it', () => {
      run(clone, 'reset', '-q', '--hard', 'HEAD~1');
      const behind = run(clone, 'rev-parse', 'HEAD');
      runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
      // The first round's sync fast-forwards; prepare itself moves nothing.
      expect(run(clone, 'rev-parse', 'HEAD')).toBe(behind);
      expect(readState(statePath())!.lastKnownHeadSha).toBe(headSha);
    });

    it('refuses a branch that tracks nothing', () => {
      run(clone, 'branch', '--unset-upstream', 'feat');
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /must track origin\/feat/,
      );
      expect(existsSync(statePath())).toBe(false);
    });

    it('refuses a daemon session in a subdirectory, naming the checkout root', () => {
      const sub = join(clone, 'sub');
      mkdirSync(sub);
      process.env['QWEN_CODE_SERVE'] = '1';
      process.chdir(sub);
      try {
        expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
          /checkout root/,
        );
        expect(existsSync(statePath())).toBe(false);
      } finally {
        process.chdir(clone);
        delete process.env['QWEN_CODE_SERVE'];
      }
    });

    it('refuses when a worktree watch of the PR exists already', () => {
      runPrepare({ pr: 7, repo: 'o/r' });
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /already has a watch/,
      );
      expect(readState(statePath())!.inPlace).toBeUndefined();
    });

    it('classic prepare refuses an in-place state', () => {
      runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
      let message = '';
      try {
        runPrepare({ pr: 7, repo: 'o/r' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/in-place watch/);
      // Cleanup is the only way forward; a bare --in-place retry is not.
      expect(message).toMatch(/cleanup 7/);
      expect(message).toMatch(/then prepare again/);
      expect(readState(statePath())!.inPlace).toBe(true);
    });

    it('reads the PR head from a private ref, not the shared FETCH_HEAD', () => {
      // A concurrent fetch in the user's checkout (an IDE's autofetch)
      // overwrites FETCH_HEAD between prepare's fetch and its read.
      mocks.afterFetch = () => {
        run(clone, 'fetch', '-q', 'origin', 'main');
      };
      runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
      expect(readState(statePath())!.lastKnownHeadSha).toBe(headSha);
      expect(run(clone, 'rev-parse', 'refs/qwen-autofix/pr-7/head')).toBe(
        headSha,
      );
    });

    it('refuses a URL push target with an actionable named-remote message', () => {
      mocks.gh.mockImplementation((...args: string[]) => {
        if (args[0] === 'pr')
          return JSON.stringify(
            prView({
              headRefOid: headSha,
              isCrossRepository: true,
              maintainerCanModify: true,
              headRepositoryOwner: { login: 'contributor' },
            }),
          );
        if (args[0] === 'repo') return JSON.stringify(writable);
        if (args[0] === 'config') return 'https';
        throw new Error(`unexpected gh ${args.join(' ')}`);
      });
      // No remote of this clone serves the contributor's fork: pushTarget
      // falls back to a URL, which git can never track as an upstream.
      mocks.matched.mockImplementation((owner) =>
        owner === 'contributor' ? [] : ['origin'],
      );
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /named git remote/,
      );
      expect(existsSync(statePath())).toBe(false);
    });

    it('refuses under the lock when an in-place start lands during the gh calls', () => {
      const answer = mocks.gh.getMockImplementation()!;
      let injected = false;
      mocks.gh.mockImplementation((...args: string[]) => {
        if (args[0] === 'pr' && !injected) {
          injected = true;
          // A full in-place start completes while the classic call is
          // between its first state read and its lock.
          runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
        }
        return answer(...args);
      });
      expect(() => runPrepare({ pr: 7, repo: 'o/r' })).toThrow(
        /in-place watch/,
      );
      expect(readState(statePath())!.inPlace).toBe(true);
      expect(run(clone, 'branch', '--list', 'qwen-autofix/pr-7')).toBe('');
      expect(existsSync(autofixPrPaths(clone, 7).worktreePath)).toBe(false);
    });

    it('refuses a checkout of another repository, leaving nothing written', () => {
      mocks.matched.mockImplementation(() => []);
      expect(() => runPrepare({ pr: 7, repo: 'o/r', inPlace: true })).toThrow(
        /no single git remote/,
      );
      expect(existsSync(statePath())).toBe(false);
    });

    it('inherits the settled history of an earlier watch', () => {
      const paths = autofixPrPaths(clone, 7);
      mkdirSync(dirname(paths.statePath), { recursive: true });
      writeFileSync(
        historyPath(paths, { host: 'github.com', owner: 'o', repo: 'r' }),
        JSON.stringify({
          version: 1,
          host: 'github.com',
          owner: 'o',
          repo: 'r',
          prNumber: 7,
          handledCommentIds: ['IC_1'],
          postedCommentIds: ['IC_2'],
          handledChecks: ['c@h@a'],
          rerunChecks: [],
        }),
      );
      runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
      expect(readState(statePath())!).toMatchObject({
        handledCommentIds: ['IC_1'],
        postedCommentIds: ['IC_2'],
        handledChecks: ['c@h@a'],
      });
    });

    it('prepares in a daemon session opened at the checkout root', () => {
      process.env['QWEN_CODE_SERVE'] = '1';
      try {
        runPrepare({ pr: 7, repo: 'o/r', inPlace: true });
        expect(readState(statePath())!.inPlace).toBe(true);
      } finally {
        delete process.env['QWEN_CODE_SERVE'];
      }
    });
  });
});

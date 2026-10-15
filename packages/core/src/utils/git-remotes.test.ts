/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  fetchGitRemotes,
  gitRemoteAdd,
  gitRemoteRemove,
  isRemovableRemoteName,
  isSectionlessUpstream,
  isValidRemoteName,
  isValidRemoteUrl,
} from './git-remotes.js';
import { gitEnv } from './git-branches.js';

const tmpRoots: string[] = [];

// Hermetic global scope: git's duplicate and no-such-remote checks resolve
// across every scope, so a host global [remote …] section or org-wide
// insteadOf rewrite would otherwise decide the mutation assertions.
// HOME/XDG reach the code under test through this env (gitEnv cannot scrub
// config files); GIT_CONFIG_NOSYSTEM does not (gitEnv strips it) — on the
// read side the listing's scope filter keeps host system/global remotes out.
let fixtureEnv: NodeJS.ProcessEnv;
let tmpHome: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnv });
}
const cfg = (cwd: string, ...args: string[]) => git(cwd, 'config', ...args);
type Scope = 'local' | 'global' | 'worktree' | 'all';
// `git config [--<scope>] <op…>`; `all` passes no scope flag.
const readCfg = (cwd: string, scope: Scope, ...op: string[]) =>
  cfg(cwd, ...(scope === 'all' ? [] : [`--${scope}`]), ...op);
const get = (cwd: string, scope: Scope, key: string) =>
  readCfg(cwd, scope, '--get', key);
const getAll = (cwd: string, scope: Scope, key: string) =>
  readCfg(cwd, scope, '--get-all', key);
const cfgList = (cwd: string, scope: Scope = 'all') =>
  readCfg(cwd, scope, '--list');
const refs = (cwd: string, prefix: string) => git(cwd, 'for-each-ref', prefix);
const verifyRef = (cwd: string, ref: string) =>
  git(cwd, 'rev-parse', '--verify', ref);
const setUrl = (cwd: string, ...args: string[]) =>
  git(cwd, 'remote', 'set-url', ...args);
const listRemotes = (cwd: string) => fetchGitRemotes(cwd, fixtureEnv);
const add = (cwd: string, name: string, url: string) =>
  gitRemoteAdd(cwd, name, url, fixtureEnv);
const rm = (cwd: string, name: string) =>
  gitRemoteRemove(cwd, name, fixtureEnv);
const names = (remotes: Array<{ name: string }>) => remotes.map((r) => r.name);
const STILL = /remote still configured after removal/;
const NO_SUCH = /no such remote/i;
const INHERITED = /remote already configured in an inherited scope/;
const ZERO_OID = `${'0'.repeat(40)}\n`;
const ORIGIN_URL = 'https://example.com/o/r.git';
const SCP_URL = 'git@example.com:me/repo.git';
/** The full listing row of an `origin` added at ORIGIN_URL. */
const originRow = (overrides: object) => ({
  name: 'origin',
  fetchUrl: ORIGIN_URL,
  pushUrl: ORIGIN_URL,
  extraFetchUrls: 0,
  extraPushUrls: 0,
  promisor: false,
  customRefspec: false,
  otherSettings: 0,
  ...overrides,
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** `git remote add` each name with url https://example.com/<initial>/r.git. */
function addRemotes(cwd: string, ...remotes: string[]): void {
  for (const r of remotes) {
    git(cwd, 'remote', 'add', r, `https://example.com/${r[0]}/r.git`);
  }
}

/** A one-commit repo on `main`, then `addRemotes(dir, ...remotes)`. */
function makeRepo(...remotes: string[]): string {
  const dir = tmpDir('qwen-gitremotes-');
  git(dir, 'init', '-q', '-b', 'main');
  cfg(dir, 'user.email', 'test@example.com');
  cfg(dir, 'user.name', 'Test');
  cfg(dir, 'commit.gpgsign', 'false');
  // Neutralize an inherited global core.hooksPath (machine-wide hook
  // managers would otherwise run on every fixture commit).
  cfg(dir, 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  addRemotes(dir, ...remotes);
  return dir;
}

/** Points `branch` at `remote` (branch.<b>.remote + .merge) in `scope`. */
function track(
  cwd: string,
  scope: 'local' | 'worktree',
  branch: string,
  remote: string,
  merge = 'refs/heads/main',
): void {
  cfg(cwd, `--${scope}`, `branch.${branch}.remote`, remote);
  cfg(cwd, `--${scope}`, `branch.${branch}.merge`, merge);
}

/** Links worktree `<dir>-wt`, first enabling extensions.worktreeConfig. */
function addWorktree(dir: string, worktreeConfig = true): string {
  if (worktreeConfig) cfg(dir, '--local', 'extensions.worktreeConfig', 'true');
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  tmpRoots.push(wt);
  git(dir, 'worktree', 'add', '--detach', wt);
  return wt;
}

function repoWithWorktree(): { dir: string; wt: string } {
  const dir = makeRepo();
  return { dir, wt: addWorktree(dir) };
}

/** Plants a stale lock on the `<dir>-wt` config.worktree; returns its path. */
function lockWtConfig(dir: string): string {
  const wtDir = path.join(dir, '.git', 'worktrees', `${path.basename(dir)}-wt`);
  const file = path.join(wtDir, 'config.worktree');
  fs.writeFileSync(`${file}.lock`, '');
  return file;
}

/** Sets refs/remotes/<name>/main to HEAD plus a stale lock; returns the lock. */
function lockTrackingRef(dir: string, name: string, body = ''): string {
  git(dir, 'update-ref', `refs/remotes/${name}/main`, 'HEAD');
  const lock = path.join(dir, '.git', 'refs', 'remotes', name, 'main.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, body);
  return lock;
}

/** Writes `<dir>/<file>` and appends an include.path for it to .git/config. */
function includeCfg(dir: string, body: string, file = 'extra.cfg'): void {
  const inc = path.join(dir, file);
  fs.writeFileSync(inc, body);
  cfg(dir, '--local', 'include.path', inc);
}

/**
 * Branch foo tracks `survivor` locally, but an include appended after the
 * local section re-points it at `name` (the effective pre-removal value).
 */
function shadowSurvivorByInclude(dir: string, name: string): void {
  track(dir, 'local', 'foo', 'survivor', 'refs/heads/foo');
  includeCfg(dir, `[branch "foo"]\n\tremote = ${name}\n`);
}

/** A legacy $GIT_DIR/remotes/<name> file (resolves with no config record). */
function legacyRemote(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, '.git', 'remotes'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git', 'remotes', name),
    'URL: https://example.com/legacy/r.git\n',
  );
}

const writeGlobal = (body: string) =>
  fs.writeFileSync(path.join(tmpHome, '.gitconfig'), body);
const readGlobal = () =>
  fs.readFileSync(path.join(tmpHome, '.gitconfig'), 'utf8');
const GLOBAL_ORIGIN =
  '[remote "origin"]\n\turl = https://global.example/g.git\n';

/** Awaits a rejection, asserts it is an Error, and returns it. */
async function caught(p: Promise<unknown>) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error & { stderr?: unknown };
}
const stderrOf = (err: object) =>
  'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
const stderrAndMessage = (e: { stderr?: unknown; message?: unknown }) =>
  `${typeof e.stderr === 'string' ? e.stderr : ''}${
    typeof e.message === 'string' ? e.message : ''
  }`;

/**
 * Shadows a global `key = value` with a local `key = removed` copy and
 * removes `removed`: git's rm unsets the local copy, unmasking the global.
 */
function unmask(dir: string, key: string, value: string, removed = 'origin') {
  cfg(dir, '--global', key, value);
  cfg(dir, '--local', key, removed);
  return rm(dir, removed);
}
const refusesUnmask = (
  dir: string,
  key: string,
  value: string,
  removed?: string,
) => expect(unmask(dir, key, value, removed)).rejects.toThrow(STILL);
/** `unmask` certifies, leaving `survivors`, and `value` is what git resolves. */
async function certifiesUnmask(
  dir: string,
  key: string,
  value: string,
  removed?: string,
  survivors: string[] = [],
) {
  expect(names(await unmask(dir, key, value, removed))).toEqual(survivors);
  expect(get(dir, 'all', key)).toBe(`${value}\n`);
}

beforeEach(() => {
  tmpHome = tmpDir('qwen-gitremotes-home-');
  // Built through the scrubber the code under test uses, so a host that
  // redirects config by env (GIT_CONFIG_GLOBAL, GIT_CONFIG_COUNT…) cannot
  // split the fixture from the code it asserts on.
  fixtureEnv = {
    ...gitEnv({ ...process.env, HOME: tmpHome, XDG_CONFIG_HOME: tmpHome }),
    GIT_CONFIG_NOSYSTEM: '1',
  };
});

// Windows can briefly hold a handle on a just-touched tmp dir (indexer, a
// git child exiting): retry the teardown rmdir on its race codes (EBUSY,
// EPERM, ENOTEMPTY) instead of failing a test whose assertions passed.
const RETRYABLE_RM_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
function rmRetry(dir: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        attempt >= 3 ||
        !RETRYABLE_RM_CODES.has((err as NodeJS.ErrnoException).code ?? '')
      ) {
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    rmRetry(tmpRoots.pop()!);
  }
});

// Planted host redirectors: the fixture env is rebuilt per test, so the
// plant makes the scrub witness below non-vacuous on a clean host.
// Save/restore keeps a host that genuinely presets them (the exact shape
// the plant simulates) intact.
const PLANTED_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/corp/shared.gitconfig',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'remote.planted.url',
  GIT_CONFIG_VALUE_0: 'https://planted.example/x.git',
};
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [key, value] of Object.entries(PLANTED_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, saved] of Object.entries(savedEnv)) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

it('scrubs host config redirectors out of the fixture env', () => {
  expect(fixtureEnv['GIT_CONFIG_GLOBAL']).toBeUndefined();
  expect(fixtureEnv['GIT_CONFIG_COUNT']).toBeUndefined();
});

// The code under test spawns git through gitEnv, which strips
// GIT_CONFIG_NOSYSTEM — so a host /etc/gitconfig remote section would decide
// the inherited-scope assertions (fail loudly HERE, not as ten red tests).
beforeAll(() => {
  let systemList = '';
  try {
    systemList = execFileSync('git', ['config', '--system', '--list'], {
      encoding: 'utf8',
      env: gitEnv({ ...process.env }),
    });
  } catch {
    // No readable system config file: the hermetic precondition holds.
  }
  if (/^remote\./m.test(systemList)) {
    throw new Error(
      'host /etc/gitconfig defines remote.* config (a [remote] section or pushDefault) — the inherited-scope assertions are not hermetic on this host',
    );
  }
});

describe('isValidRemoteName', () => {
  it.each([
    ['origin', true],
    ['upstream', true],
    ['my-fork_2.0', true],
    ['', false],
    ['-origin', false],
    ['a/b', false],
    ['a b', false],
    ['a..b', false],
    ['.a', false],
    ['a.', false],
    ['a.lock', false],
    ['a@{b', false],
    ['a:b', false],
    ['a?b', false],
    ['HEAD', false],
    ['a\tb', false],
    // Invisible characters make a name render identically to an existing
    // remote: a deletion-spoofing surface the add path must refuse.
    ['origin‏', false],
    ['ori­ingin', false],
    ['ori\u{e0041}gin', false],
    ['origin￹', false],
  ])('isValidRemoteName(%j) === %s', (name, expected) => {
    expect(isValidRemoteName(name)).toBe(expected);
  });
});

describe('isValidRemoteUrl', () => {
  it.each([
    ['https://example.com/o/r.git', true],
    ['ssh://git@host/o/r.git', true],
    // Bracketed IPv6 literals carry `::` but are not helper forms: the
    // anchor plus scheme charset must keep accepting them.
    ['ssh://git@[::1]/repo.git', true],
    ['ssh://git@[2001:db8::1]:22/o/r.git', true],
    ['git@example.com:o/r.git', true],
    ['file:///tmp/repo', true],
    ['/tmp/local path/repo', true],
    ['', false],
    ['-oProxyCommand=x', false],
    ['https://x/\nmalicious', false],
    // Command-executing transport helpers: git's default refusal is
    // overridable (config files, GIT_ALLOW_PROTOCOL), so reject outright.
    ['ext::sh -c touch /tmp/x', false],
    ['fd::0', false],
    ['EXT::anything', false],
    // The helper FORM in general, not two names: an installed
    // git-remote-<name> runs at connect time under the default policy.
    ['gcrypt::myrepo', false],
    ['hg::http://h/repo', false],
    // git's transport form has no letter-first rule: a digit-leading
    // scheme executes git-remote-<name> like any other helper.
    ['7z::archive.7z', false],
    ['9p::ssh://host/repo', false],
    // git admits the EMPTY transport name, and unlike `ext::` it is not
    // deny-by-default: git execs a PATH-resolved `git-remote-` with the
    // payload as argv (a protocol.allow policy is overridable from config
    // files) — the anchor must match at position 0 with zero scheme chars.
    ['::sh -c id', false],
    ['::0', false],
    ['::', false],
    // C1 controls and Cf-outside-Default_Ignorable: stripped at render, so
    // the write gate must refuse them too.
    ['https://example.com/\u0085evil', false],
    ['https://example.com/\u009fevil', false],
    ['https://example.com/؀evil', false],
    ['https://example.com/‮evil', false],
    ['https://example.com/​', false],
    ['https://example.com/ evil', false],
    ['https://example.com/­evil', false],
    // A Tag-block code point: Default_Ignorable WITHOUT being Cc/Cf —
    // the arm the property-derived class exists for.
    ['https://example.com/\u{e0041}evil', false],
  ])('isValidRemoteUrl(%j) === %s', (url, expected) => {
    expect(isValidRemoteUrl(url)).toBe(expected);
  });
});

describe('isRemovableRemoteName', () => {
  // Removal is no stricter than git: hand-edited names stay removable. The
  // floors: non-empty, no NUL (execFile cannot carry it), and no `/` (since
  // the tracking-refs sweep: its namespace nests in the prefix remote's and
  // cannot be swept safely). The `--` terminator guards the exec vector
  // (pinned by the dash-leading round trip: git reads a leading `-` as a
  // switch without it).
  it.each([
    ['origin', true],
    ['a.lock', true],
    ['a/b', false],
    ['a:b', true],
    ['HEAD', true],
    ['-y', true],
    [' ', true],
    ['origin‏', true],
    ['a\tb', true],
    ['', false],
    ['a\0b', false],
  ])('isRemovableRemoteName(%j) === %s', (name, expected) => {
    expect(isRemovableRemoteName(name)).toBe(expected);
  });

  it('is strictly more lenient than the add predicate', () => {
    expect(isValidRemoteName('a.lock')).toBe(false);
    expect(isRemovableRemoteName('a.lock')).toBe(true);
    expect(isValidRemoteName('-y')).toBe(false);
    expect(isRemovableRemoteName('-y')).toBe(true);
  });
});

describe('fetchGitRemotes', () => {
  it('returns an empty list for a repo without remotes', async () => {
    const dir = makeRepo();
    await expect(listRemotes(dir)).resolves.toEqual([]);
  });

  it('lists remotes in config order with their urls', async () => {
    const remotes = await listRemotes(makeRepo('upstream', 'origin'));
    expect(names(remotes)).toEqual(['upstream', 'origin']);
    for (const remote of remotes) {
      expect(remote.pushUrl).toBe(remote.fetchUrl);
      expect(remote.promisor).toBe(false);
      expect(remote.customRefspec).toBe(false);
      expect(remote.extraFetchUrls).toBe(0);
      expect(remote.extraPushUrls).toBe(0);
    }
  });

  it('reports a push-url override set via git remote set-url --push', async () => {
    const dir = makeRepo('origin');
    setUrl(dir, '--push', 'origin', 'git@example.com:o/r.git');
    expect(await listRemotes(dir)).toEqual([
      originRow({ pushUrl: 'git@example.com:o/r.git' }),
    ]);
  });

  it('reports promisor and partial-clone filter from the config section', async () => {
    const dir = makeRepo('origin');
    cfg(dir, 'remote.origin.promisor', 'true');
    cfg(dir, 'remote.origin.partialclonefilter', 'blob:none');
    const [origin] = await listRemotes(dir);
    expect(origin?.promisor).toBe(true);
    expect(origin?.partialCloneFilter).toBe('blob:none');
  });

  it('flags a non-default fetch refspec', async () => {
    const dir = makeRepo('origin');
    cfg(
      dir,
      'remote.origin.fetch',
      '+refs/heads/main:refs/remotes/origin/main',
    );
    expect((await listRemotes(dir))[0]?.customRefspec).toBe(true);
  });

  it('reports extra configured urls instead of hiding them', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/one.git');
    setUrl(dir, '--add', 'origin', 'https://example.com/o/two.git');
    setUrl(dir, '--push', 'origin', 'https://example.com/o/push1.git');
    setUrl(dir, '--add', '--push', 'origin', 'https://example.com/o/push2.git');
    const [origin] = await listRemotes(dir);
    expect(origin?.fetchUrl).toBe('https://example.com/o/one.git');
    expect(origin?.pushUrl).toBe('https://example.com/o/push1.git');
    expect(origin?.extraFetchUrls).toBe(1);
    expect(origin?.extraPushUrls).toBe(1);
  });

  it('lists a section whose url was unset, with empty urls', async () => {
    const dir = makeRepo('origin');
    cfg(dir, '--unset', 'remote.origin.url');
    expect(await listRemotes(dir)).toEqual([
      originRow({ fetchUrl: '', pushUrl: '' }),
    ]);
  });

  it('lists and can remove a dash-leading name git itself accepts', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', '--', '-y', 'https://example.com/y.git');
    expect(names(await listRemotes(dir))).toEqual(['-y']);
    await expect(rm(dir, '-y')).resolves.toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('ignores remotes defined only in an inherited config scope', async () => {
    const dir = makeRepo();
    writeGlobal('[remote "inherited"]\n\turl = https://global.example/g.git\n');
    addRemotes(dir, 'origin');
    // The listing covers only the repository's own scopes: git cannot
    // remove the inherited remote either, so listing it would certify a
    // removal that never happens.
    expect(names(await listRemotes(dir))).toEqual(['origin']);
  });

  it('refuses to add a name an inherited scope already configures', async () => {
    const dir = makeRepo();
    // git's duplicate check does NOT see the inherited section, so the
    // panel's own Add would silently create a fetch/push divergence.
    writeGlobal(GLOBAL_ORIGIN);
    await expect(add(dir, 'origin', ORIGIN_URL)).rejects.toThrow(
      /inherited scope/,
    );
    // `git remote` shows the inherited row by design; the refusal must
    // leave the repository config untouched.
    expect(cfgList(dir, 'local')).not.toContain('remote.origin.url');
  });

  it('reports not-a-repo before the inherited-scope pre-flight', async () => {
    const dir = tmpDir('qwen-notrepo-');
    // Outside a repository the scope read exits 0 with the inherited
    // config: the shadow refusal must not mask git's canonical answer.
    writeGlobal(GLOBAL_ORIGIN);
    await expect(add(dir, 'origin', ORIGIN_URL)).rejects.toThrow(
      /not a git repository/,
    );
  });

  it('reports not-a-repo before the removal pre-flight', async () => {
    const dir = tmpDir('qwen-notrepo-');
    // Same ordering on the remove side: outside a repository the config
    // dump exits 0 with the inherited config, so a same-named global
    // remote would surface the shadow refusal where git's canonical 404
    // belongs — the pre-flight's rev-parse probes throw first.
    writeGlobal(GLOBAL_ORIGIN);
    await expect(rm(dir, 'origin')).rejects.toThrow(/not a git repository/);
  });

  it('reports the configured url, not an insteadOf-rewritten one', async () => {
    const dir = makeRepo();
    writeGlobal(
      '[url "https://rewritten.example/"]\n\tinsteadOf = https://example.com/\n',
    );
    addRemotes(dir, 'origin');
    expect((await listRemotes(dir))[0]?.fetchUrl).toBe(ORIGIN_URL);
  });

  it('survives an invalid configured fetch refspec on a sibling remote', async () => {
    const dir = makeRepo('origin');
    cfg(dir, 'remote.bad.url', 'https://example.com/b/r.git');
    // Genuinely invalid (no colon): a refspec git accepts would not
    // distinguish the config read from the refspec-parsing shapes.
    cfg(dir, 'remote.bad.fetch', '+refs/heads/*');
    // A config-level read does not parse refspecs, so one bad section
    // cannot wedge the whole listing (the `git remote` shape did).
    expect(names(await listRemotes(dir)).sort()).toEqual(['bad', 'origin']);
  });

  it('surfaces git refusal for a remote whose configured refspec is invalid', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.bad.url', 'https://example.com/b/r.git');
    cfg(dir, 'remote.bad.fetch', '+refs/heads/*');
    // git dies parsing the refspec before mutating anything: the refusal
    // must surface, not be laundered into a success or a silent 500.
    const err = await caught(rm(dir, 'bad'));
    expect(stderrAndMessage(err)).toMatch(/invalid refspec/i);
    // The premise: git died BEFORE mutating, so the section is still there.
    expect(get(dir, 'all', 'remote.bad.url')).toBe(
      'https://example.com/b/r.git\n',
    );
  });

  it('does not mistake an injected exact-prefix line for git’s refusal', async () => {
    const wt = addWorktree(makeRepo());
    cfg(wt, '--worktree', 'remote.evil.url', 'https://example.com/e/r.git');
    // The injected line carries git's exact `error: Could not …` prefix:
    // the line anchor alone would match it, so only the invalid-refspec
    // precedence keeps the completion from firing.
    cfg(
      wt,
      '--worktree',
      'remote.evil.fetch',
      "+refs/heads/*\nerror: Could not remove config section 'remote.evil'",
    );
    const err = await caught(rm(wt, 'evil'));
    expect(stderrAndMessage(err)).toMatch(/invalid refspec/i);
    expect(get(wt, 'worktree', 'remote.evil.url')).toBe(
      'https://example.com/e/r.git\n',
    );
  });

  it('rejects outside a git repository', async () => {
    const dir = tmpDir('qwen-notrepo-');
    await expect(listRemotes(dir)).rejects.toThrow();
  });
});

describe('gitRemoteAdd', () => {
  it('refuses to add a name rendering identically to an existing remote', async () => {
    const dir = makeRepo('origin');
    // A zero-width-space lookalike: the panel would show two identical
    // rows, so the write gate refuses before git is even spawned.
    await expect(
      add(dir, 'ori​gin', 'https://example.com/e/r.git'),
    ).rejects.toThrow('invalid remote name');
    expect(getAll(dir, 'all', 'remote.origin.url')).toBe(`${ORIGIN_URL}\n`);
  });

  it('adds a remote and returns the fresh list', async () => {
    const dir = makeRepo();
    expect(names(await add(dir, 'origin', ORIGIN_URL))).toEqual(['origin']);
    expect(git(dir, 'remote')).toBe('origin\n');
  });

  it('stores the trimmed url, not the padded body value', async () => {
    const dir = makeRepo();
    await add(dir, 'origin', `  ${ORIGIN_URL}  `);
    // Read the stored value raw: the listing trims, and git quotes a
    // padded value on write, so a trimmed read would pass with the core
    // trim removed.
    expect(get(dir, 'local', 'remote.origin.url')).toBe(`${ORIGIN_URL}\n`);
  });

  it('rejects a padded exec-vector url the raw body value would pass', async () => {
    const dir = makeRepo();
    await expect(add(dir, 'origin', ' -oProxyCommand=x ')).rejects.toThrow(
      /invalid remote url/,
    );
    expect(git(dir, 'remote')).toBe('');
  });

  it('rejects a duplicate name with git output attached', async () => {
    const dir = makeRepo();
    await add(dir, 'origin', ORIGIN_URL);
    const err = await caught(
      add(dir, 'origin', 'https://example.com/other.git'),
    );
    expect(stderrOf(err)).toMatch(/already exists/i);
  });

  it('rejects command-executing helper urls before spawning git', async () => {
    const dir = makeRepo();
    await expect(
      add(dir, 'mirror', 'ext::sh -c touch /tmp/pwned'),
    ).rejects.toThrow(/invalid remote url/);
    expect(git(dir, 'remote')).toBe('');
  });

  it('rejects invalid names and urls before spawning git', async () => {
    const dir = makeRepo();
    await expect(add(dir, '-x', ORIGIN_URL)).rejects.toThrow(
      /invalid remote name/,
    );
    await expect(add(dir, 'origin', '')).rejects.toThrow(/invalid remote url/);
    await expect(add(dir, 'origin', '-upload-pack=x')).rejects.toThrow(
      /invalid remote url/,
    );
    await expect(
      add(dir, 'origin', 'https://example.com/‮evil'),
    ).rejects.toThrow(/invalid remote url/);
    expect(git(dir, 'remote')).toBe('');
  });
});

describe('gitRemoteRemove', () => {
  it('removes a remote and returns the fresh list', async () => {
    const dir = makeRepo();
    await add(dir, 'origin', ORIGIN_URL);
    await add(dir, 'upstream', 'https://example.com/u/r.git');
    expect(names(await rm(dir, 'origin'))).toEqual(['upstream']);
    expect(git(dir, 'remote')).toBe('upstream\n');
  });

  it('removes a hand-configured remote whose name the add predicate rejects', async () => {
    const dir = makeRepo();
    // A name `git remote add` would refuse (`.lock` suffix), written
    // straight into the config — removal must still work on it.
    cfg(dir, 'remote.x.lock.url', 'https://example.com/x.git');
    expect(names(await listRemotes(dir))).toEqual(['x.lock']);
    expect(await rm(dir, 'x.lock')).toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('removing an unknown remote surfaces git no-such-remote', async () => {
    const err = await caught(rm(makeRepo(), 'missing'));
    expect(stderrOf(err)).toMatch(NO_SUCH);
  });

  it('rejects an empty name before spawning git', async () => {
    const dir = makeRepo();
    await expect(rm(dir, '')).rejects.toThrow(/invalid remote name/);
  });

  it('rejects a NUL-bearing name before spawning git', async () => {
    const dir = makeRepo();
    // execFile refuses an argv entry containing a NUL byte; without the
    // predicate floor the request would die as an unclassified 500.
    await expect(rm(dir, 'a\0b')).rejects.toThrow(/invalid remote name/);
  });

  it('removes a control-character name the config can hold', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.a\tb.url', 'https://example.com/t.git');
    expect(names(await listRemotes(dir))).toEqual(['a\tb']);
    await expect(rm(dir, 'a\tb')).resolves.toEqual([]);
  });
});

describe('fetchGitRemotes config parsing', () => {
  // An origin section holding only a url (no fetch refspec).
  const urlOnlyRepo = () => {
    const dir = makeRepo();
    cfg(dir, 'remote.origin.url', ORIGIN_URL);
    return dir;
  };
  const promisorOf = async (dir: string) =>
    (await listRemotes(dir))[0]?.promisor;

  it('lists a space-bearing subsection name and can remove it', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.my remote.url', 'https://example.com/mr.git');
    const remotes = await listRemotes(dir);
    expect(names(remotes)).toEqual(['my remote']);
    expect(remotes[0]?.fetchUrl).toBe('https://example.com/mr.git');
    await expect(rm(dir, 'my remote')).resolves.toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('keeps an embedded newline inside one value instead of a phantom row', async () => {
    const dir = makeRepo();
    cfg(
      dir,
      'remote.origin.url',
      'https://good/x.git\nremote.fake.url https://attacker/y.git',
    );
    const remotes = await listRemotes(dir);
    expect(names(remotes)).toEqual(['origin']);
    expect(remotes[0]?.fetchUrl).toContain('remote.fake.url');
  });

  // The host git resolves the value (`--type=bool`), so these rows only pin
  // the DELEGATION, with spellings whose truth is stable across git's
  // grammar versions. Boundary integers (`2147483648`, `2g`) belong to
  // git's own tests: the maybe_bool bound differs across versions/builds.
  it.each([
    ['0', false],
    ['no', false],
    ['off', false],
    ['false', false],
    ['OFF', false],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['ON', true],
    ['1', true],
    ['0x1', true],
    ['0x0', false],
    ['1k', true],
    // Invalid-octal / trailing-content spellings die in git's parser, so
    // the per-key read errors and the badge stays false.
    ['08', false],
    ['1e1', false],
    [' true ', false],
    ['+ 1', false],
  ])('reads promisor=%j as %s', async (value, expected) => {
    const dir = urlOnlyRepo();
    cfg(dir, 'remote.origin.promisor', value);
    expect(await promisorOf(dir)).toBe(expected);
  });

  it('reads a valueless promisor key as true', async () => {
    const dir = urlOnlyRepo();
    const config = path.join(dir, '.git', 'config');
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace(/\[remote "origin"\]/, '[remote "origin"]\n\tpromisor'),
    );
    expect(await promisorOf(dir)).toBe(true);
  });

  it('reads an empty promisor value as false, unlike the valueless key', async () => {
    const dir = urlOnlyRepo();
    // `git config <key> ''` writes the delimiter with an empty value,
    // which git's boolean parser reads as false.
    cfg(dir, 'remote.origin.promisor', '');
    expect(await promisorOf(dir)).toBe(false);
  });

  it('reads a multi-valued promisor additively, like git', async () => {
    const dir = urlOnlyRepo();
    // git registers a promisor remote on ANY true record (a
    // `[true, false]` pair still lazy-fetches): not the last value.
    cfg(dir, '--add', 'remote.origin.promisor', 'true');
    cfg(dir, '--add', 'remote.origin.promisor', 'false');
    expect(await promisorOf(dir)).toBe(true);
    cfg(dir, '--unset-all', 'remote.origin.promisor');
    cfg(dir, '--add', 'remote.origin.promisor', 'false');
    cfg(dir, '--add', 'remote.origin.promisor', '0');
    expect(await promisorOf(dir)).toBe(false);
  });

  it('badges a remote whose promisor key lives only in the global config', async () => {
    const dir = urlOnlyRepo();
    // git registers promisor remotes cross-scope and the badge read
    // resolves the same way: an inherited promisor key on a listed
    // (repository-scope) remote must still mark it.
    cfg(dir, '--global', 'remote.origin.promisor', 'true');
    expect(await promisorOf(dir)).toBe(true);
  });

  it('does not certify an unparseable promisor value as true', async () => {
    const dir = urlOnlyRepo();
    cfg(dir, 'remote.origin.promisor', 'maybe');
    expect(await promisorOf(dir)).toBe(false);
  });

  it('counts unparsed section settings as otherSettings', async () => {
    const dir = urlOnlyRepo();
    cfg(dir, 'remote.origin.proxy', 'http://corp-proxy:8080');
    cfg(dir, 'remote.origin.mirror', 'true');
    expect((await listRemotes(dir))[0]?.otherSettings).toBe(2);
  });
});

describe('repository-scope listing and removal', () => {
  it('lists a remote an include.path in .git/config contributes', async () => {
    const dir = makeRepo();
    includeCfg(
      dir,
      '[remote "inc"]\n\turl = https://example.com/inc.git\n',
      'included.gitconfig',
    );
    addRemotes(dir, 'origin');
    // git labels include-sourced keys `local` scope and its duplicate
    // check sees them: a `--local`-only read under-lists while
    // `git remote add` dead-ends on the included name.
    const remotes = await listRemotes(dir);
    expect(names(remotes).sort()).toEqual(['inc', 'origin']);
    expect(remotes.find((r) => r.name === 'inc')?.fetchUrl).toBe(
      'https://example.com/inc.git',
    );
  });

  it('refuses a split section before git rm can destroy anything', async () => {
    const dir = makeRepo();
    includeCfg(
      dir,
      '[remote "dup"]\n\turl = https://example.com/from-include.git\n',
      'included.gitconfig',
    );
    cfg(dir, 'remote.dup.url', 'https://example.com/from-local.git');
    git(dir, 'branch', 'feat');
    cfg(dir, 'branch.feat.remote', 'dup');
    git(dir, 'update-ref', 'refs/remotes/dup/main', 'HEAD');
    // git's rm would edit only .git/config, leaving the included half live,
    // and it deletes the tracking refs and branch keys BEFORE the section
    // write it cannot complete: the refusal must come before rm runs. As a
    // pure pre-flight, a second attempt answers the same way.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await caught(rm(dir, 'dup'))).message).toMatch(
        /^remote section lives in an included config file$/,
      );
    }
    // Nothing was destroyed: both section halves, the tracking ref and
    // the branch key survive.
    expect(getAll(dir, 'all', 'remote.dup.url')).toBe(
      'https://example.com/from-include.git\nhttps://example.com/from-local.git\n',
    );
    expect(get(dir, 'all', 'branch.feat.remote')).toBe('dup\n');
    expect(refs(dir, 'refs/remotes/dup')).toBe(
      `${git(dir, 'rev-parse', 'HEAD').trim()} commit\trefs/remotes/dup/main\n`,
    );
  });

  it('refuses to certify while a legacy .git/remotes/<name> file still resolves', async () => {
    const dir = makeRepo('origin');
    // The pre-config-era mechanism git still honors resolves the name with
    // no config record: a config-only certification would certify while
    // fetches keep working.
    legacyRemote(dir, 'origin');
    await expect(rm(dir, 'origin')).rejects.toThrow(STILL);
    // git's own section removal DID happen; only the certification refuses.
    expect(cfgList(dir)).not.toContain('remote.origin.url');
    // Deleting the legacy file converges the retry to git's own 404.
    fs.unlinkSync(path.join(dir, '.git', 'remotes', 'origin'));
    await expect(rm(dir, 'origin')).rejects.toThrow(NO_SUCH);
  });

  it('sweeps a sibling worktree’s upstream keys on a removal from the main one', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feature');
    // The keys live in the SIBLING's config.worktree: invisible to every
    // read the removal runs from the main worktree.
    track(wt, 'worktree', 'feature', 'origin');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(cfgList(wt, 'worktree')).not.toContain('branch.feature.remote');
    expect(cfgList(wt, 'worktree')).not.toContain('branch.feature.merge');
  });

  it('removes a remote while a stale (prunable) worktree record exists', async () => {
    const dir = makeRepo();
    // Deleting the directory out of band leaves the registration (tagged
    // prunable) until `git worktree prune`: removals must not die on it.
    fs.rmSync(addWorktree(dir, false), { recursive: true, force: true });
    addRemotes(dir, 'origin');
    expect(await rm(dir, 'origin')).toEqual([]);
  });

  it('removes fine with a linked sibling when extensions.worktreeConfig is off', async () => {
    const dir = makeRepo();
    addWorktree(dir, false);
    // `git config --worktree` then refuses outright: the sibling sweep
    // must read that as "no worktree scope", not fail the removal.
    addRemotes(dir, 'origin');
    expect(await rm(dir, 'origin')).toEqual([]);
  });

  it('refuses when a sibling worktree holds a section override for the remote', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'origin');
    // The sibling's own per-worktree override: the name still resolves
    // there after the shared section goes.
    const override = 'https://example.com/override/r.git';
    cfg(wt, '--worktree', 'remote.origin.url', override);
    await expect(rm(dir, 'origin')).rejects.toThrow(STILL);
    expect(get(wt, 'worktree', 'remote.origin.url')).toBe(`${override}\n`);
  });

  it('ignores a planted worktrees gitdir pointing at an unrelated repository', async () => {
    const dir = makeRepo('origin');
    // A hand-written .git/worktrees/<x>/gitdir looks like a real sibling in
    // `worktree list`, and the sweep WRITES with cwd set to it: the
    // shared-common-dir ownership probe must skip it.
    const victim = makeRepo();
    cfg(victim, '--local', 'extensions.worktreeConfig', 'true');
    track(victim, 'worktree', 'main', 'origin');
    const admin = path.join(dir, '.git', 'worktrees', 'evil');
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(
      path.join(admin, 'gitdir'),
      `${path.join(victim, '.git')}\n`,
    );
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(get(victim, 'worktree', 'branch.main.remote')).toBe('origin\n');
    expect(get(victim, 'worktree', 'branch.main.merge')).toBe(
      'refs/heads/main\n',
    );
  });

  it('keeps a sibling merge key whose remote lives in the shared config', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'origin', 'upstream');
    git(wt, 'branch', 'feat');
    // The branch's remote is in the SHARED config (naming the surviving
    // remote); only its merge key is per-worktree. Removing the
    // unrelated remote must not touch the sibling's merge.
    cfg(wt, '--local', 'branch.feat.remote', 'upstream');
    cfg(wt, '--worktree', 'branch.feat.merge', 'refs/heads/main');
    expect(names(await rm(dir, 'origin'))).toEqual(['upstream']);
    expect(get(wt, 'worktree', 'branch.feat.merge')).toBe('refs/heads/main\n');
  });

  it('ignores an unrelated sibling branch subkey carrying the name', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    // A description that happens to carry the removed name is not the
    // sweep's business and must not trip the re-verify.
    cfg(wt, '--worktree', 'branch.feat.description', 'origin');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(get(wt, 'worktree', 'branch.feat.description')).toBe('origin\n');
  });

  it('removes a hand-configured remote whose name carries edge whitespace', async () => {
    const dir = makeRepo();
    fs.appendFileSync(
      path.join(dir, '.git', 'config'),
      '\n[remote " foo"]\n\turl = https://example.com/f/r.git\n',
    );
    // The lenient removal predicate admits the name; the certification
    // must not read git's verbatim echo + terminator as still-resolving.
    expect(await rm(dir, ' foo')).toEqual([]);
  });

  it('restores a destroyed merge key when the multi-valued remote survived', async () => {
    const wt = addWorktree(makeRepo());
    addRemotes(wt, 'origin', 'survivor');
    git(wt, 'branch', 'b1');
    // git's rm skips the multi-valued remote key but still deletes the
    // merge: the restore must re-add the merge against the survivor.
    cfg(wt, '--local', '--add', 'branch.b1.remote', 'survivor');
    cfg(wt, '--local', '--add', 'branch.b1.remote', 'origin');
    cfg(wt, '--local', 'branch.b1.merge', 'refs/heads/b1');
    cfg(wt, '--worktree', 'branch.b1.remote', 'origin');
    expect(names(await rm(wt, 'origin'))).toEqual(['survivor']);
    expect(get(wt, 'local', 'branch.b1.merge')).toBe('refs/heads/b1\n');
    expect(get(wt, 'local', 'branch.b1.remote')).toBe('survivor\n');
  });

  it('refuses up front while an inherited pushurl-only section survives', async () => {
    const dir = makeRepo('origin');
    track(dir, 'local', 'main', 'origin');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // A pushurl-only inherited section resolves fetch-side as the BARE name
    // (ls-remote --get-url echoes it). git's rm would destroy the local
    // half, the tracking ref and the pointing branch's keys FIRST, so the
    // refusal lands BEFORE any spawn that mutates.
    const pushUrl = 'https://example.com/push/r.git';
    cfg(dir, '--global', 'remote.origin.pushurl', pushUrl);
    await expect(rm(dir, 'origin')).rejects.toThrow(INHERITED);
    // Nothing was destroyed: the local section, the upstream keys and
    // the tracking ref are intact, and the inherited record stays.
    expect(get(dir, 'local', 'remote.origin.url')).toBe(`${ORIGIN_URL}\n`);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('origin\n');
    expect(get(dir, 'local', 'branch.main.merge')).toBe('refs/heads/main\n');
    expect(refs(dir, 'refs/remotes/origin')).toContain(
      'refs/remotes/origin/main',
    );
    expect(get(dir, 'global', 'remote.origin.pushurl')).toBe(`${pushUrl}\n`);
  });

  it('resolves cleanly when a sibling holds a dotted-EXTENSION remote, not an override', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'a');
    // [remote "a.b"] in the sibling's file is not remote a's section.
    cfg(wt, '--worktree', 'remote.a.b.url', 'https://example.com/ab/r.git');
    // The sibling's section is worktree-scoped — invisible from here.
    expect(await rm(dir, 'a')).toEqual([]);
    expect(get(wt, 'worktree', 'remote.a.b.url')).toBe(
      'https://example.com/ab/r.git\n',
    );
  });

  it('rolls back a destroyed local section when the removal dies on a stale ref lock', async () => {
    const dir = makeRepo();
    cfg(dir, '--local', 'extensions.worktreeConfig', 'true');
    addRemotes(dir, 'survivor', 'gone');
    track(dir, 'local', 'main', 'survivor');
    // The worktree-scope record shadows the local one: main effectively
    // tracks `gone`, so git rm destroys the LOCAL section (survivor's
    // tracking config) on its way to dying on the lock.
    cfg(dir, '--worktree', 'branch.main.remote', 'gone');
    lockTrackingRef(dir, 'gone', ZERO_OID);
    await expect(rm(dir, 'gone')).rejects.toThrow();
    // The refusal after git's mutation must not skip the rollback:
    // survivor's tracking config stands again, and a retry re-reads its
    // snapshot from THIS config, not a destroyed one.
    expect(get(dir, 'local', 'branch.main.remote')).toBe('survivor\n');
    expect(get(dir, 'local', 'branch.main.merge')).toBe('refs/heads/main\n');
  });

  it('does not re-point a branch while a ref-locked removal leaves the section live', async () => {
    const dir = makeRepo('gone', 'survivor');
    // Included AFTER the local section, so foo effectively tracks `gone`:
    // git rm unsets the local survivor copy on its way to dying on the ref
    // lock, with the section STILL LIVE. The include-held value is then the
    // still-effective upstream, not residue: the rollback must not
    // discount it and silently re-point the branch while refusing.
    shadowSurvivorByInclude(dir, 'gone');
    lockTrackingRef(dir, 'gone', ZERO_OID);
    await expect(rm(dir, 'gone')).rejects.toThrow();
    // Faithful rollback: the destroyed merge key is rewritten, and no
    // survivor value is inserted over the still-effective residue.
    expect(get(dir, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.remote=');
  });

  it('does not re-point a push upstream while a ref-locked removal leaves the section live', async () => {
    const dir = makeRepo('gone', 'survivor');
    cfg(dir, '--local', 'branch.foo.pushremote', 'survivor');
    // Include at EOF (after the branch section): the include-held
    // pushRemote is the still-effective upstream, and the ref lock makes
    // git rm die after unsetting the branch keys with the section live —
    // the rollback must not discount the residue and re-point over it.
    includeCfg(dir, '[branch "foo"]\n\tpushremote = gone\n');
    lockTrackingRef(dir, 'gone', ZERO_OID);
    await expect(rm(dir, 'gone')).rejects.toThrow();
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.pushremote=');
  });

  it('writes back a destroyed pushRemote over an include-held residue once the name stops resolving', async () => {
    const dir = makeRepo('gone', 'survivor');
    cfg(dir, '--local', 'branch.foo.pushremote', 'survivor');
    includeCfg(dir, '[branch "foo"]\n\tpushremote = gone\n');
    // The pushRemote presence read shares the branch arm's gate decision
    // (section gone, name unresolving): the destroyed local copy is
    // written back and then shadows the include-held residue (the
    // shadowed-survivor doctrine), so the removal certifies.
    expect(names(await rm(dir, 'gone'))).toEqual(['survivor']);
    expect(get(dir, 'local', 'branch.foo.pushremote')).toBe('survivor\n');
  });

  it('does not re-point a branch while a ref-locked removal leaves a pushurl-only section live', async () => {
    const dir = makeRepo();
    cfg(dir, '--local', 'remote.gone.pushurl', 'https://example.com/g/r.git');
    cfg(
      dir,
      '--local',
      'remote.gone.fetch',
      '+refs/heads/*:refs/remotes/gone/*',
    );
    addRemotes(dir, 'survivor');
    shadowSurvivorByInclude(dir, 'gone');
    // A pushurl-only section is push-side LIVE while the fetch-side
    // resolver probe echoes the name (it cannot see pushurl records) and
    // the path probe fails: only the gate's SECTION leg sees the section
    // stand, so it alone keeps the rollback from re-pointing the branch
    // under the ref-lock refusal.
    lockTrackingRef(dir, 'gone', ZERO_OID);
    await expect(rm(dir, 'gone')).rejects.toThrow();
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.remote=');
    expect(get(dir, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
  });

  it('restores a destroyed merge key when a multi-valued all-name remote key survives a refused removal', async () => {
    const dir = makeRepo('gone');
    cfg(dir, '--local', '--add', 'branch.foo.remote', 'gone');
    cfg(dir, '--local', '--add', 'branch.foo.remote', 'gone');
    cfg(dir, '--local', 'branch.foo.merge', 'refs/heads/foo');
    // git skips multi-valued keys on removal but still deletes the merge
    // key, then dies on the ref lock with the section live: the merge key
    // must roll back even though every remote value equals the removed
    // name (nothing to write back; the merge question is "does a record
    // stand?").
    lockTrackingRef(dir, 'gone', ZERO_OID);
    await expect(rm(dir, 'gone')).rejects.toThrow();
    expect(get(dir, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
  });

  it('does not re-point a branch when a legacy file keeps the removed name resolving', async () => {
    const dir = makeRepo('gone', 'survivor');
    shadowSurvivorByInclude(dir, 'gone');
    // A legacy $GIT_DIR/remotes/<name> file keeps the name resolving with
    // NO section: the include-held value is then a LIVE upstream, not
    // residue — the rollback must not shadow it with a rewritten local
    // copy under the 409.
    legacyRemote(dir, 'gone');
    await expect(rm(dir, 'gone')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.remote=');
    expect(get(dir, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
  });

  it('does not re-point a branch when a same-named directory repo keeps the removed name resolving', async () => {
    const dir = makeRepo('fork', 'survivor');
    shadowSurvivorByInclude(dir, 'fork');
    // A same-named directory repo at the toplevel keeps the bare word
    // resolving through git's path transport with NO config record, and
    // `--get-url` never consults the filesystem: without the gate's path
    // leg the rollback discounts a LIVE upstream.
    git(dir, 'init', 'fork');
    await expect(rm(dir, 'fork')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.remote=');
  });

  it('does not re-point a branch when a same-named bundle file keeps the removed name resolving', async () => {
    const dir = makeRepo('fork.bundle', 'survivor');
    shadowSurvivorByInclude(dir, 'fork.bundle');
    // git's transport magic-sniffs the bundle: the name resolves with no
    // config record, exactly like the directory-repo shape.
    git(dir, 'bundle', 'create', 'fork.bundle', '--all');
    await expect(rm(dir, 'fork.bundle')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.remote=');
  });

  it('restores the destroyed merge key when the discount gate probe cannot answer', async () => {
    const dir = makeRepo('gone', 'survivor');
    shadowSurvivorByInclude(dir, 'gone');
    // An empty-base insteadOf makes the resolver probe exit 128: the gate
    // must answer no-discount (the safe direction) INSIDE itself, not
    // abort the rollback ahead of the merge arm — the certification gate
    // downstream still fails closed on the same read.
    cfg(dir, '--local', 'url..insteadOf', 'gone');
    await expect(rm(dir, 'gone')).rejects.toThrow();
    expect(get(dir, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
    expect(cfgList(dir, 'local')).not.toContain('branch.foo.remote=');
  });

  it('writes back a destroyed pushDefault over an include-held residue once the name stops resolving', async () => {
    const dir = makeRepo('gone');
    cfg(dir, '--local', 'remote.pushDefault', 'survivor');
    includeCfg(dir, '[remote]\n\tpushDefault = gone\n');
    // The rollback discounts the include-held residue (section gone, name
    // unresolving) and writes the destroyed local pushDefault back at EOF,
    // past the include directive, shadowing it. The removal then refuses
    // on the unmask pushDefault arm: the written-back value names a remote
    // with no section here, so it surfaces dangling (with a resolvable
    // survivor the removal certifies, as the pushRemote twin shows).
    await expect(rm(dir, 'gone')).rejects.toThrow(STILL);
    expect(get(dir, 'local', 'remote.pushdefault')).toBe('survivor\n');
  });

  it('does not re-point pushDefault when a legacy file keeps the removed name resolving', async () => {
    const dir = makeRepo('gone');
    cfg(dir, '--local', 'remote.pushDefault', 'survivor');
    includeCfg(dir, '[remote]\n\tpushDefault = gone\n');
    legacyRemote(dir, 'gone');
    await expect(rm(dir, 'gone')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).not.toContain('remote.pushdefault=');
  });

  it('restores a shadowed local pushDefault naming a surviving remote', async () => {
    const wt = addWorktree(makeRepo());
    addRemotes(wt, 'origin', 'survivor');
    // git rm's handle_push_default unsets the key in the COMMON config when
    // the effective value matched: the shadowed local survivor copy is
    // collateral the restore must bring back.
    cfg(wt, '--local', 'remote.pushDefault', 'survivor');
    cfg(wt, '--worktree', 'remote.pushDefault', 'origin');
    expect(names(await rm(wt, 'origin'))).toEqual(['survivor']);
    expect(get(wt, 'local', 'remote.pushdefault')).toBe('survivor\n');
  });

  it('removes a hand-configured remote whose name carries a trailing CR', async () => {
    const dir = makeRepo();
    fs.appendFileSync(
      path.join(dir, '.git', 'config'),
      '\n[remote "a\r"]\n\turl = https://example.com/f/r.git\n',
    );
    // git echoes an unanswered name verbatim + one LF; the terminator
    // strip must not eat a CR belonging to the name.
    expect(await rm(dir, 'a\r')).toEqual([]);
  });

  it('does not refuse an include-held upstream key shadowed by a surviving worktree record', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'gone', 'origin');
    // The include-held residue names the removed remote but is shadowed by
    // a worktree record naming the SURVIVING one: inert by the
    // shadowed-survivor doctrine, so the re-verify must not refuse.
    includeCfg(dir, '[branch "main"]\n\tremote = gone\n');
    // The shadow must live in the INVOKING worktree's scope — a sibling's
    // config.worktree is invisible to this worktree's reads.
    cfg(dir, '--worktree', 'branch.main.remote', 'origin');
    expect(names(await rm(dir, 'gone'))).toEqual(['origin']);
    // The residue stays (uneditable); it just must not refuse the removal.
    expect(get(dir, 'all', 'branch.main.remote')).toBe('origin\n');
  });

  it('keeps a sibling merge key when the same file holds a surviving remote entry', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'gone', 'origin');
    git(wt, 'branch', 'feat');
    // The sibling's multi-valued remote key holds BOTH the removed and the
    // surviving remote: the value sweep takes the removed entry, and the
    // merge key must stay with the survivor.
    cfg(wt, '--worktree', '--add', 'branch.feat.remote', 'origin');
    cfg(wt, '--worktree', '--add', 'branch.feat.remote', 'gone');
    cfg(wt, '--worktree', 'branch.feat.merge', 'refs/heads/main');
    expect(names(await rm(dir, 'gone'))).toEqual(['origin']);
    expect(get(wt, 'worktree', 'branch.feat.merge')).toBe('refs/heads/main\n');
    expect(getAll(wt, 'worktree', 'branch.feat.remote')).toBe('origin\n');
  });

  it('refuses an include-held section before rm, and the retry refuses identically', async () => {
    const dir = makeRepo();
    includeCfg(
      dir,
      '[remote "inc"]\n\turl = https://example.com/inc.git\n\tfetch = +refs/heads/*:refs/remotes/inc/*\n',
      'included.gitconfig',
    );
    git(dir, 'branch', 'feat');
    track(dir, 'local', 'feat', 'inc');
    git(dir, 'update-ref', 'refs/remotes/inc/main', 'HEAD');
    // git's rm deletes the tracking refs and branch keys BEFORE it fails
    // renaming a section it cannot write, and the row stays listed (the
    // include file is intact), so every retry would repeat the
    // destruction: the pre-flight refuses before rm runs, leaving the
    // repository untouched, and a retry answers the same way.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await caught(rm(dir, 'inc'))).message).toBe(
        'remote section lives in an included config file',
      );
    }
    expect(get(dir, 'all', 'branch.feat.remote')).toBe('inc\n');
    expect(get(dir, 'all', 'branch.feat.merge')).toBe('refs/heads/main\n');
    expect(refs(dir, 'refs/remotes/inc')).toContain('refs/remotes/inc/main');
    expect(git(dir, 'remote')).toBe('inc\n');
  });

  it('lists a worktree-scope remote from the worktree only', async () => {
    const { dir, wt } = repoWithWorktree();
    cfg(wt, '--worktree', 'remote.wtonly.url', 'https://example.com/wt.git');
    expect(names(await listRemotes(wt))).toEqual(['wtonly']);
    // Another worktree's scope is not this repository's own config.
    await expect(listRemotes(dir)).resolves.toEqual([]);
  });

  it('completes removal of a worktree-scope remote git cannot edit', async () => {
    const wt = addWorktree(makeRepo());
    cfg(wt, '--worktree', 'remote.wtonly.url', 'https://example.com/wt.git');
    const refspec = '+refs/heads/*:refs/remotes/wtonly/*';
    cfg(wt, '--worktree', 'remote.wtonly.fetch', refspec);
    // Seed what `git remote remove` destroys before failing on the
    // worktree-scope section: the tracking refs and the upstream config.
    git(wt, 'update-ref', 'refs/remotes/wtonly/main', 'HEAD');
    git(wt, 'branch', 'feat');
    track(wt, 'local', 'feat', 'wtonly');
    // Worktree-scope upstream keys git cannot unset either: left behind
    // they would dangle `branch.wfeat.remote = <gone>`.
    git(wt, 'branch', 'wfeat');
    track(wt, 'worktree', 'wfeat', 'wtonly');

    expect(await rm(wt, 'wtonly')).toEqual([]);
    expect(refs(wt, 'refs/remotes')).toBe('');
    const config = cfgList(wt);
    expect(config).not.toContain('branch.feat.remote');
    expect(config).not.toContain('branch.wfeat.remote');
    expect(config).not.toContain('branch.wfeat.merge');
  });

  it('clears worktree-scope upstream keys on a local remote removal', async () => {
    const wt = addWorktree(makeRepo());
    // The section is at local scope, so git rm exits 0 — but its
    // branch-key cleanup only writes the file it can write, leaving the
    // worktree-held upstream key dangling.
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    track(wt, 'worktree', 'feat', 'origin');

    expect(await rm(wt, 'origin')).toEqual([]);
    expect(cfgList(wt)).not.toContain('branch.feat.remote');
    expect(cfgList(wt)).not.toContain('branch.feat.merge');
  });

  it('clears a multi-valued worktree upstream key by exact value', async () => {
    const wt = addWorktree(makeRepo());
    cfg(wt, '--worktree', 'remote.wtonly.url', 'https://example.com/wt.git');
    git(wt, 'branch', 'feat');
    // git resolves the LAST value, so the removed remote goes last and the
    // branch stays fetch-pointed. The entries MUST differ: only a distinct
    // surviving entry pins the `--fixed-value` half of the unset (a plain
    // `--unset-all` would take it too). It names a real remote, or the
    // unmask gate refuses the removal.
    addRemotes(wt, 'upstream');
    cfg(wt, '--worktree', '--add', 'branch.feat.remote', 'upstream');
    cfg(wt, '--worktree', '--add', 'branch.feat.remote', 'wtonly');
    cfg(wt, '--worktree', '--add', 'branch.feat.merge', 'refs/heads/main');
    cfg(wt, '--worktree', '--add', 'branch.feat.merge', 'refs/heads/main');

    expect(names(await rm(wt, 'wtonly'))).toEqual(['upstream']);
    // Only the removed remote's entry was value-matched away.
    expect(getAll(wt, 'worktree', 'branch.feat.remote')).toBe('upstream\n');
    // The merge key stays: the scope still holds a surviving remote entry,
    // and the merge half pairs with that (surviving) upstream.
    expect(getAll(wt, 'worktree', 'branch.feat.merge')).toBe(
      'refs/heads/main\nrefs/heads/main\n',
    );
  });

  it('attributes a branch by its worktree-scope remote over a divergent local one', async () => {
    const wt = addWorktree(makeRepo());
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    // git resolves worktree-over-local: feat points at origin through the
    // WORKTREE record. git's rm then deletes the local copy too (its
    // effective-value match writes the file it can write): the shadowed
    // `other` copy is collateral the removal must restore, while the
    // worktree copy (naming the removed remote) goes.
    git(wt, 'remote', 'add', 'other', 'https://example.com/other/r.git');
    track(wt, 'local', 'feat', 'other');
    cfg(wt, '--worktree', 'branch.feat.remote', 'origin');
    expect(names(await rm(wt, 'origin'))).toEqual(['other']);
    // The surviving local copy is restored: the branch tracks `other`.
    expect(get(wt, 'local', 'branch.feat.remote')).toBe('other\n');
    expect(get(wt, 'local', 'branch.feat.merge')).toBe('refs/heads/main\n');
    // The worktree-scope copy (the removed remote's) is gone.
    expect(cfgList(wt, 'worktree')).not.toContain('branch.feat.remote');
  });

  it('clears a worktree merge key whose remote key lives at local scope', async () => {
    const wt = addWorktree(makeRepo());
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    // git rm unsets the local remote key itself but cannot write the
    // worktree-held merge key: attribution must come from the pre-removal
    // snapshot, not the post-removal config.
    cfg(wt, 'branch.feat.remote', 'origin');
    cfg(wt, '--worktree', 'branch.feat.merge', 'refs/heads/main');

    expect(await rm(wt, 'origin')).toEqual([]);
    expect(cfgList(wt)).not.toContain('branch.feat.merge');
  });

  it('clears a worktree pushRemote without touching the fetch upstream', async () => {
    const wt = addWorktree(makeRepo());
    addRemotes(wt, 'upstream');
    cfg(wt, '--worktree', 'remote.wtonly.url', 'https://example.com/wt.git');
    git(wt, 'branch', 'tri');
    // Fetches from the survivor, pushes to the removed remote: git's rm
    // unsets pushRemote independently of the remote match, so the cleanup
    // must clear it, while the merge key belongs to the survivor and stays.
    track(wt, 'worktree', 'tri', 'upstream');
    cfg(wt, '--worktree', 'branch.tri.pushremote', 'wtonly');

    expect(names(await rm(wt, 'wtonly'))).toEqual(['upstream']);
    const config = cfgList(wt);
    expect(config).not.toContain('branch.tri.pushremote');
    expect(config).toContain('branch.tri.remote');
    expect(config).toContain('branch.tri.merge');
  });

  it('clears a worktree remote.pushDefault that resolves to the removed remote', async () => {
    const wt = addWorktree(makeRepo());
    addRemotes(wt, 'origin', 'upstream');
    cfg(wt, '--worktree', 'remote.pushDefault', 'origin');
    cfg(wt, '--worktree', 'branch.feat.remote', 'upstream');

    expect(names(await rm(wt, 'origin'))).toEqual(['upstream']);
    const config = cfgList(wt);
    expect(config).not.toContain('remote.pushdefault');
    expect(config).toContain('branch.feat.remote');
  });

  it('converges the tracking-ref sweep on a retry after a failed sweep', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.nf.url', 'https://example.com/nf/r.git');
    // The first attempt's sweep dies on a planted ref lock; the section is
    // already gone, so the retry lands on the no-such-remote arm, which
    // must converge the ref cleanup too (not dead-end on it).
    const lock = lockTrackingRef(dir, 'nf');
    await expect(rm(dir, 'nf')).rejects.toThrow(STILL);
    fs.rmSync(lock);
    await expect(rm(dir, 'nf')).rejects.toThrow(NO_SUCH);
    expect(refs(dir, 'refs/remotes/nf/')).toBe('');
  });

  it('converges the tracking-ref sweep on a retry despite an empty pushInsteadOf alias', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.nf.url', 'https://example.com/nf/r.git');
    // An empty-valued pushInsteadOf alias must not prefix-match every
    // name (`startsWith('')`) and disable the converge arm's sweep.
    cfg(dir, '--local', 'url.https://mirror/.pushinsteadof', '');
    const lock = lockTrackingRef(dir, 'nf');
    await expect(rm(dir, 'nf')).rejects.toThrow(STILL);
    fs.rmSync(lock);
    await expect(rm(dir, 'nf')).rejects.toThrow(NO_SUCH);
    expect(refs(dir, 'refs/remotes/nf/')).toBe('');
  });

  it('converges the SIBLING cleanup on a retry after a failed first attempt', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    cfg(wt, '--worktree', 'branch.feat.remote', 'origin');
    // Attempt 1 dies AFTER the section removal, before the sibling sweep:
    // the sibling's config.worktree is locked.
    const configWorktree = lockWtConfig(dir);
    await expect(rm(dir, 'origin')).rejects.toThrow(STILL);
    fs.rmSync(`${configWorktree}.lock`);
    // Retry: git answers no-such-remote — the converge arm must still
    // sweep the sibling's keys before surfacing git's 404.
    await expect(rm(dir, 'origin')).rejects.toThrow(NO_SUCH);
    expect(cfgList(wt, 'worktree')).not.toContain('branch.feat.remote');
  });

  it('converges the upstream cleanup on a retry after a failed cleanup', async () => {
    const { dir, wt } = repoWithWorktree();
    // The section is at local scope, so git rm removes it successfully:
    // the lock only blocks the upstream cleanup.
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    cfg(wt, '--worktree', 'branch.feat.remote', 'origin');
    const configWorktree = lockWtConfig(dir);
    // First attempt: the section goes but the cleanup dies on the lock.
    await expect(rm(wt, 'origin')).rejects.toThrow(STILL);
    fs.rmSync(`${configWorktree}.lock`);
    // Retry: git answers no-such-remote (the section is gone), which must
    // still converge the upstream cleanup instead of dead-ending.
    await expect(rm(wt, 'origin')).rejects.toThrow(NO_SUCH);
    expect(cfgList(wt)).not.toContain('branch.feat.remote');
  });

  it('refuses a converged retry whose sweep unshadows a dangling inherited upstream', async () => {
    const dir = makeRepo('foo');
    cfg(dir, '--global', 'branch.main.remote', 'ghost');
    track(dir, 'local', 'main', 'foo');
    // Out-of-band destruction: the retry takes the converge arm, whose
    // sweep unsets the local shadow — the inherited `ghost` (no section
    // anywhere) surfaces dangling, and a converged 404 would clear the
    // client row over a branch left dangling.
    cfg(dir, '--local', '--remove-section', 'remote.foo');
    await expect(rm(dir, 'foo')).rejects.toThrow(STILL);
    expect(get(dir, 'global', 'branch.main.remote')).toBe('ghost\n');
  });

  it('keeps the no-such-remote doctrine for an inherited upstream key the sweep never touched', async () => {
    const dir = makeRepo();
    // An inherited BRANCH-key survivor the snapshot never pointed at leaves
    // both resolve arms silent (they need a snapshot-pointed branch or
    // pushDefault), so git's 404 stays the answer the client's stale-row
    // convergence keys on (the certify path's all-scope surviving-keys
    // half owns the mutated case).
    cfg(dir, '--global', 'branch.main.remote', 'foo');
    await expect(rm(dir, 'foo')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'global', 'branch.main.remote')).toBe('foo\n');
  });

  it('answers no-such-remote for a sectionless value without sweeping its live tracking config', async () => {
    const dir = makeRepo();
    // `.` (the local repository) is a sectionless upstream the lenient
    // removal predicate admits. The no-such-remote converge arm must not
    // sweep keys value-matched to it: git's 404 says nothing was removed,
    // so the live tracking config must survive intact.
    track(dir, 'local', 'main', '.');
    cfg(dir, '--local', 'remote.pushDefault', '.');
    await expect(rm(dir, '.')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('.\n');
    expect(get(dir, 'local', 'branch.main.merge')).toBe('refs/heads/main\n');
    expect(get(dir, 'local', 'remote.pushdefault')).toBe('.\n');
  });

  it('answers no-such-remote for an insteadOf-aliased name without sweeping its live tracking config', async () => {
    const dir = makeRepo();
    // An url.<base>.insteadOf alias keeps the bare name resolving with NO
    // section: git rm answers no-such-remote touching nothing (probed: key
    // and ref survive), and the converge arm must not sweep the live
    // upstream over that 404 either — git's own resolver tells a bare word
    // apart post hoc. (A legacy $GIT_DIR/remotes|branches file is the other
    // resolution source; there git's OWN rm fails on the missing section
    // after unsetting the branch keys — mirrored, outside the converge arm.)
    const alias = 'url.https://example.com/alias/r.git.insteadOf';
    cfg(dir, '--local', alias, 'legacy');
    track(dir, 'local', 'main', 'legacy');
    git(dir, 'update-ref', 'refs/remotes/legacy/main', 'HEAD');
    await expect(rm(dir, 'legacy')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('legacy\n');
    expect(refs(dir, 'refs/remotes/legacy')).toContain(
      'refs/remotes/legacy/main',
    );
  });

  it('answers no-such-remote for a bare-word path upstream without sweeping its live tracking config', async () => {
    const dir = makeRepo();
    // A bare word naming a directory repo inside the worktree is a live
    // local-path upstream the `--get-url` resolver never sees (probed: it
    // echoes the name without consulting the filesystem). The converge
    // arm's path probe is what keeps the sweep off the live config.
    git(dir, 'init', '-q', 'sub');
    track(dir, 'local', 'main', 'sub');
    git(dir, 'update-ref', 'refs/remotes/sub/main', 'HEAD');
    await expect(rm(dir, 'sub')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('sub\n');
    expect(get(dir, 'local', 'branch.main.merge')).toBe('refs/heads/main\n');
    expect(refs(dir, 'refs/remotes/sub')).toContain('refs/remotes/sub/main');
  });

  it('refuses the converge arm when a tracking-ref deletion failure persists across the retry', async () => {
    const dir = makeRepo();
    // The section is already gone (the first attempt's shape), so the
    // retry enters the converge arm. The persisting lock blocks the
    // best-effort ref sweep: the arm must REFUSE rather than converge to a
    // 404 that abandons the phantom namespace with no remote to prune it.
    lockTrackingRef(dir, 'gone');
    await expect(rm(dir, 'gone')).rejects.toThrow(STILL);
    expect(refs(dir, 'refs/remotes/gone')).toContain('refs/remotes/gone/main');
  });

  it('answers no-such-remote for a pushInsteadOf-aliased name without sweeping its live push config', async () => {
    const dir = makeRepo();
    // url.<base>.pushInsteadOf = word keeps `word` resolving PUSH-side (the
    // `gh:` alias pattern) while nothing fetch-side answers it, and git has
    // no push-side resolver probe (probed: `ls-remote --push` exits 129),
    // so the converge gate answers from the config dump itself.
    cfg(dir, '--local', 'url.https://real.example/x.pushinsteadof', 'word');
    cfg(dir, '--local', 'branch.main.pushremote', 'word');
    cfg(dir, '--local', 'remote.pushDefault', 'word');
    await expect(rm(dir, 'word')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.pushremote')).toBe('word\n');
    expect(get(dir, 'local', 'remote.pushdefault')).toBe('word\n');
  });

  it('certifies an unmasked pushRemote naming a pushInsteadOf-aliased value', async () => {
    const dir = makeRepo('origin');
    // The push-side arms' alias awareness: the surfaced inherited
    // pushRemote names a push-side alias — live, not dangling.
    cfg(dir, '--local', 'url.https://real.example/x.pushinsteadof', 'word');
    await certifiesUnmask(dir, 'branch.main.pushremote', 'word');
  });

  it('refuses up front a removal whose name a pushInsteadOf alias still resolves push-side', async () => {
    const dir = makeRepo();
    // The alias keeps the bare name a live push destination whatever the
    // section says, and a POST-destruction refusal would wedge upstream
    // keys the certify sweep can no longer reach (the retry's 404 converge
    // arm skips the same alias): the refusal lands BEFORE git's rm, and
    // the section and every pointing key survive untouched.
    addRemotes(dir, 'word');
    cfg(dir, '--local', 'branch.feat.remote', 'word');
    cfg(dir, '--local', 'url.https://real.example/x.pushinsteadof', 'word');
    await expect(rm(dir, 'word')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).toContain('remote.word.url');
    expect(get(dir, 'local', 'branch.feat.remote')).toBe('word\n');
  });

  it('keeps the inherited-only 404 doctrine despite a matching pushInsteadOf alias', async () => {
    const dir = makeRepo();
    // An INHERITED-only section leaves nothing repository-scoped to
    // destroy: the block check falls through to git's 404 (the answer the
    // client's stale-row convergence keys on), and the pre-flight alias
    // refusal must not swallow it — the alias alone destroys nothing.
    cfg(dir, '--global', 'remote.origin.url', 'https://g/o.git');
    cfg(dir, '--global', 'url.https://real.example/x.pushinsteadof', 'origin');
    await expect(rm(dir, 'origin')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'global', 'remote.origin.url')).toBe('https://g/o.git\n');
  });

  it('refuses up front a worktree-scope section whose name a pushInsteadOf alias matches', async () => {
    const dir = makeRepo();
    // A config.worktree-held section is a destroyable repository half: the
    // pre-flight alias refusal must cover it too, or git's rm destroys refs
    // and branch keys before dying on the section write, and the wedge
    // returns through the 404 converge arm's sweep skip.
    cfg(dir, '--local', 'extensions.worktreeConfig', 'true');
    cfg(dir, '--worktree', 'remote.word.url', 'https://example.com/w/r.git');
    cfg(dir, '--local', 'branch.feat.remote', 'word');
    cfg(dir, '--local', 'url.https://real.example/x.pushinsteadof', 'word');
    await expect(rm(dir, 'word')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'worktree')).toContain('remote.word.url');
    expect(get(dir, 'local', 'branch.feat.remote')).toBe('word\n');
  });

  it('refuses up front a name a pushInsteadOf alias only PREFIXES', async () => {
    const dir = makeRepo();
    // git's alias rewrite is a byte-prefix match: a remote whose name
    // merely STARTS with the alias value stays a live push destination
    // after removal, so strict prefixes are refused too.
    addRemotes(dir, 'wordbook');
    cfg(dir, '--local', 'url.https://real.example/x.pushinsteadof', 'word');
    await expect(rm(dir, 'wordbook')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).toContain('remote.wordbook.url');
  });

  it('refuses up front a repository-scope section whose alias lives at an inherited scope', async () => {
    const dir = makeRepo();
    // Push resolution spans scopes: a GLOBAL alias keeps the listed
    // repository-scope name resolving push-side, so the refusal fires even
    // though the panel never lists the alias's scope (fail-closed,
    // terminal-only escape).
    addRemotes(dir, 'word');
    cfg(dir, '--global', 'url.https://real.example/x.pushinsteadof', 'word');
    await expect(rm(dir, 'word')).rejects.toThrow(STILL);
    expect(cfgList(dir, 'local')).toContain('remote.word.url');
  });

  it('keeps the inherited refusal ahead of the pushInsteadOf refusal', async () => {
    const dir = makeRepo();
    // Both pre-destruction refusals can co-fire (inherited section AND a
    // push-side alias): the inherited cause names a survivor scope, so it
    // wins the message.
    addRemotes(dir, 'word');
    cfg(dir, '--global', 'remote.word.url', 'https://g/o.git');
    cfg(dir, '--global', 'url.https://real.example/x.pushinsteadof', 'word');
    await expect(rm(dir, 'word')).rejects.toThrow(/inherited scope/i);
    // Nothing was destroyed: the local section survives the refusal.
    expect(cfgList(dir, 'local')).toContain('remote.word.url');
  });

  it('keeps the included-file refusal ahead of the pushInsteadOf refusal', async () => {
    const dir = makeRepo();
    // Both pre-flight refusals are pre-destruction; the included-file
    // cause names the file git cannot edit, so it wins the message.
    includeCfg(
      dir,
      '[remote "word"]\n\turl = https://example.com/w.git\n',
      'included.gitconfig',
    );
    cfg(dir, '--local', 'url.https://real.example/x.pushinsteadof', 'word');
    await expect(rm(dir, 'word')).rejects.toThrow(
      /remote section lives in an included config file/i,
    );
  });

  it('answers no-such-remote for a bare-word path upstream from a SUBDIRECTORY cwd', async () => {
    const dir = makeRepo();
    // git's path transport resolves the bare word against the worktree
    // TOPLEVEL (setup chdirs there): a subdirectory cwd must not make the
    // converge gate's path probe call a live toplevel upstream "not a repo".
    git(dir, 'init', '-q', 'sub');
    track(dir, 'local', 'main', 'sub');
    git(dir, 'update-ref', 'refs/remotes/sub/main', 'HEAD');
    fs.mkdirSync(path.join(dir, 'inner'));
    await expect(rm(path.join(dir, 'inner'), 'sub')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('sub\n');
    expect(refs(dir, 'refs/remotes/sub')).toContain('refs/remotes/sub/main');
  });

  it('answers no-such-remote for a scp-like value without sweeping its live tracking config', async () => {
    const dir = makeRepo();
    // Same gate, scp-like shape: `host:path` resolves sectionless too.
    cfg(dir, '--local', 'branch.main.remote', 'git@host:repo.git');
    await expect(rm(dir, 'git@host:repo.git')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('git@host:repo.git\n');
  });

  it('refuses to certify when a worktree upstream key cannot be unset', async () => {
    const { dir, wt } = repoWithWorktree();
    // The section is at LOCAL scope, so git rm exits 0 and the section
    // gates all pass: only the branch-key cleanup can fail, and the
    // re-verification guard turns that into a refusal.
    addRemotes(wt, 'origin');
    git(wt, 'branch', 'feat');
    cfg(wt, '--worktree', 'branch.feat.remote', 'origin');
    // git writes config via lock+rename, so a stale lock file is the
    // deterministic write failure (chmod cannot stop the rename).
    const configWorktree = lockWtConfig(dir);
    await expect(rm(wt, 'origin')).rejects.toThrow(STILL);
    // Fail-closed: the key survives rather than being certified cleaned.
    expect(fs.readFileSync(configWorktree, 'utf8')).toContain(
      'remote = origin',
    );
  });

  it('refuses to certify an upstream key surviving in an included file', async () => {
    const dir = makeRepo('origin', 'upstream');
    // git's rm unsets branch.<b>.remote only in .git/config: a key held in
    // an include.path'd file is scope-`local` and survives the certified
    // removal into a dangling `branch.main.remote = <gone>`.
    includeCfg(dir, '[branch "main"]\n\tremote = origin\n');
    await expect(rm(dir, 'origin')).rejects.toThrow(STILL);
    const config = cfg(dir, '--list', '--show-scope');
    // The section IS gone; only the include-held key survives, uneditable
    // by this module.
    expect(config).not.toContain('remote.origin.url');
    expect(config).toContain('local\tbranch.main.remote=origin');
  });

  it('refuses to certify an include-held pushDefault resolving to the removed remote', async () => {
    const dir = makeRepo('origin', 'upstream');
    // Same shape as the include-held branch key: `git push` would keep
    // resolving the default to the gone remote.
    includeCfg(dir, '[remote]\n\tpushDefault = origin\n');
    await expect(rm(dir, 'origin')).rejects.toThrow(STILL);
    const config = cfg(dir, '--list', '--show-scope');
    expect(config).not.toContain('remote.origin.url');
    expect(config).toContain('local\tremote.pushdefault=origin');
  });

  it('refuses to certify an upstream key surviving at global scope', async () => {
    const dir = makeRepo('origin', 'upstream');
    // The global file is shared by every repository, outside what this
    // module will edit: the only honest answer is a refusal.
    cfg(dir, '--global', 'branch.main.remote', 'origin');
    await expect(rm(dir, 'origin')).rejects.toThrow(STILL);
    const config = cfg(dir, '--list', '--show-scope');
    expect(config).not.toContain('remote.origin.url');
    expect(config).toContain('global\tbranch.main.remote=origin');
    expect(get(dir, 'global', 'branch.main.remote')).toBe('origin\n');
  });

  it('sweeps the removed remote from a multi-valued local upstream key', async () => {
    const dir = makeRepo('upstream', 'origin');
    git(dir, 'branch', 'feat');
    // branch.feat.remote = [upstream, origin]: the LAST value points the
    // branch at the removed remote, but git's rm skips a multi-valued key
    // with a warning, leaving every entry. The sweep must take only the
    // removed remote's entries (--fixed-value): a plain --unset-all would
    // cut the surviving remote's entry too.
    cfg(dir, '--local', '--add', 'branch.feat.remote', 'upstream');
    cfg(dir, '--local', '--add', 'branch.feat.remote', 'origin');
    expect(names(await rm(dir, 'origin'))).toEqual(['upstream']);
    expect(getAll(dir, 'local', 'branch.feat.remote')).toBe('upstream\n');
  });

  it('sweeps a non-effective multi-valued entry so a later removal cannot unmask it', async () => {
    const dir = makeRepo('gone', 'origin');
    // branch.main.remote = [gone, origin]: main is NOT pointed at `gone`
    // (origin is effective), but the non-effective entry is residue that
    // would surface and dangle the moment `origin` is removed.
    cfg(dir, '--local', '--add', 'branch.main.remote', 'gone');
    cfg(dir, '--local', '--add', 'branch.main.remote', 'origin');
    expect(names(await rm(dir, 'gone'))).toEqual(['origin']);
    expect(getAll(dir, 'local', 'branch.main.remote')).toBe('origin\n');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(cfgList(dir)).not.toContain('branch.main.remote');
  });

  it('keeps the merge key when the scope still holds a surviving remote entry', async () => {
    const dir = makeRepo('upstream', 'wtonly');
    git(dir, 'branch', 'feat');
    // feat is pointed at wtonly (last value wins), but the same scope's
    // remote key keeps an upstream entry after the sweep: the merge key
    // pairs with the SURVIVING upstream now and must stay.
    cfg(dir, '--local', '--add', 'branch.feat.remote', 'upstream');
    cfg(dir, '--local', '--add', 'branch.feat.remote', 'wtonly');
    cfg(dir, '--local', '--add', 'branch.feat.merge', 'refs/heads/main');
    cfg(dir, '--local', '--add', 'branch.feat.merge', 'refs/heads/main');
    expect(names(await rm(dir, 'wtonly'))).toEqual(['upstream']);
    expect(getAll(dir, 'local', 'branch.feat.remote')).toBe('upstream\n');
    expect(getAll(dir, 'local', 'branch.feat.merge')).toBe(
      'refs/heads/main\nrefs/heads/main\n',
    );
  });

  it('refuses when the removal unmasks an inherited upstream key naming a gone remote', async () => {
    const dir = makeRepo('upstream');
    // The local record shadows a GLOBAL one naming a remote with no section
    // anywhere: once git's rm unsets the local half, main's upstream
    // resolves to a ghost, which the removal must not certify either.
    await refusesUnmask(dir, 'branch.main.remote', 'ghost', 'upstream');
    expect(get(dir, 'global', 'branch.main.remote')).toBe('ghost\n');
    expect(cfgList(dir, 'local')).not.toContain('branch.main.remote');
  });

  it('refuses when the removal unmasks an inherited pushRemote naming a gone remote', async () => {
    const dir = makeRepo('origin', 'upstream');
    // The push half of the unmask gate: the local pushRemote shadows a
    // GLOBAL one naming a remote with no section anywhere.
    await refusesUnmask(dir, 'branch.main.pushremote', 'ghost', 'upstream');
    expect(get(dir, 'global', 'branch.main.pushremote')).toBe('ghost\n');
  });

  it('refuses an unmasked pushRemote naming a gone remote despite an empty pushInsteadOf alias', async () => {
    const dir = makeRepo('origin', 'upstream');
    // An empty alias must not make every unmasked value read as
    // push-resolving (which would certify over the dangling pushRemote).
    cfg(dir, '--local', 'url.https://mirror/.pushinsteadof', '');
    await refusesUnmask(dir, 'branch.main.pushremote', 'ghost', 'upstream');
    expect(get(dir, 'global', 'branch.main.pushremote')).toBe('ghost\n');
  });

  it('answers no-such-remote for a bundle-file upstream without sweeping its live config', async () => {
    const dir = makeRepo();
    // git resolves a same-named BUNDLE through the local transport
    // (magic-sniffed, extension-independent) while `--resolve-git-dir`
    // calls it "too large to be a .git file": the path probe must ask
    // git's transport, not model the filesystem.
    git(dir, 'bundle', 'create', 'nightly', 'HEAD');
    track(dir, 'local', 'main', 'nightly');
    git(dir, 'update-ref', 'refs/remotes/nightly/main', 'HEAD');
    await expect(rm(dir, 'nightly')).rejects.toThrow(NO_SUCH);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('nightly\n');
    expect(refs(dir, 'refs/remotes/nightly')).toContain(
      'refs/remotes/nightly/main',
    );
  });

  it('certifies an unmasked upstream naming a bundle file', async () => {
    const dir = makeRepo('origin');
    git(dir, 'bundle', 'create', 'nightly', 'HEAD');
    await certifiesUnmask(dir, 'branch.main.remote', 'nightly');
  });

  it('certifies an unmasked inherited upstream key naming a surviving remote', async () => {
    const dir = makeRepo('origin', 'upstream');
    // Same shape, but the surfaced record names a remote that still
    // exists: git's own shadowing semantics, not a dangling upstream.
    await certifiesUnmask(dir, 'branch.main.remote', 'origin', 'upstream', [
      'origin',
    ]);
  });

  it('certifies an unmasked local-repository pseudo-remote (.)', async () => {
    const dir = makeRepo('origin');
    // branch.main.remote = [., origin]: the sweep removes origin's entry,
    // and git's `.` spelling (the local repository, needing no section) is
    // a VALID surviving upstream, not a dangling one.
    cfg(dir, '--local', '--add', 'branch.main.remote', '.');
    cfg(dir, '--local', '--add', 'branch.main.remote', 'origin');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(getAll(dir, 'local', 'branch.main.remote')).toBe('.\n');
  });

  it('does not refuse a completed removal over an include-held inert merge key', async () => {
    const dir = makeRepo('origin');
    git(dir, 'branch', 'feat');
    cfg(dir, 'branch.feat.remote', 'origin');
    // The merge key lives in an include.path'd file the sweep cannot edit,
    // and a merge-only survivor resolves to "." and is inert: the removal
    // must certify, not refuse.
    includeCfg(dir, '[branch "feat"]\n\tmerge = refs/heads/main\n');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(get(dir, 'all', 'branch.feat.merge')).toBe('refs/heads/main\n');
  });

  it('refuses when the removal unmasks an inherited pushDefault naming a gone remote', async () => {
    const dir = makeRepo('origin');
    // The local pushDefault shadows a GLOBAL one naming a remote with no
    // section anywhere: once the sweep unsets the local copy, every push
    // without an explicit upstream would resolve to a ghost.
    await refusesUnmask(dir, 'remote.pushDefault', 'gone2');
    expect(get(dir, 'global', 'remote.pushdefault')).toBe('gone2\n');
  });

  it('certifies an unmasked pushRemote naming a pushurl-only section', async () => {
    const dir = makeRepo('origin');
    // The pushremote arm of the same push-side rule: the surfaced inherited
    // copy names a section holding only a pushurl — resolving for pushes,
    // echoing bare fetch-side.
    cfg(dir, '--global', 'remote.upstream.pushurl', SCP_URL);
    await certifiesUnmask(dir, 'branch.main.pushremote', 'upstream');
  });

  it('certifies an unmasked pushRemote naming a surviving remote', async () => {
    const dir = makeRepo('origin', 'upstream');
    // Same arm, plainest shape: the surfaced copy names a remote that
    // still exists — git's own shadowing, not a dangle.
    await certifiesUnmask(dir, 'branch.main.pushremote', 'upstream', 'origin', [
      'upstream',
    ]);
  });

  it('certifies an unmasked pushDefault naming a pushurl-only section', async () => {
    const dir = makeRepo('origin');
    // A pushurl-ONLY section resolves push-side (git push reaches it) while
    // the fetch-side resolver probe echoes the bare name: the push-side
    // unmask arms must count the pushurl record as resolving, or a healthy
    // removal is refused over a phantom dangle.
    cfg(dir, '--global', 'remote.upstream.pushurl', SCP_URL);
    await certifiesUnmask(dir, 'remote.pushDefault', 'upstream');
  });

  it('certifies an unmasked pushDefault naming a surviving remote', async () => {
    const dir = makeRepo('origin', 'upstream');
    // Same shape, but the surfaced value names a remote that exists.
    await certifiesUnmask(dir, 'remote.pushDefault', 'origin', 'upstream', [
      'origin',
    ]);
  });

  it('ignores a pre-existing dangling inherited pushDefault the removal never shadowed', async () => {
    const dir = makeRepo('origin');
    // The global pushDefault pointed at a ghost BEFORE the removal and no
    // editable copy shadowed it: not this removal's doing.
    cfg(dir, '--global', 'remote.pushDefault', 'ghost');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(get(dir, 'global', 'remote.pushdefault')).toBe('ghost\n');
  });

  it('certifies an unmasked upstream naming a URL, not a section', async () => {
    const dir = makeRepo('origin');
    // git resolves a URL-valued branch.<b>.remote as an ANONYMOUS remote
    // (no section needed): the unmasked inherited URL is a valid upstream.
    const url = 'https://example.com/inherited/x.git';
    await certifiesUnmask(dir, 'branch.main.remote', url);
  });

  it('certifies an unmasked upstream naming a bare-word directory repo', async () => {
    const dir = makeRepo('origin');
    // A bare word with no `/`, `:` or `.` still names a live upstream when
    // a same-named DIRECTORY repo sits in the worktree: git resolves it via
    // the path transport (`--get-url` never consults the filesystem), so
    // the unmask gate must not refuse over a phantom dangle.
    git(dir, 'init', '-q', 'sub');
    await certifiesUnmask(dir, 'branch.main.remote', 'sub');
  });

  it('certifies an unmasked upstream naming a bare-word BARE repo', async () => {
    const dir = makeRepo('origin');
    // The bare-repo spelling of the path probe (`<name>` itself is a
    // gitdir): the `<name>/.git` candidate alone would miss it.
    git(dir, 'init', '-q', '--bare', 'sub');
    await certifiesUnmask(dir, 'branch.main.remote', 'sub');
  });

  it('certifies an unmasked pushRemote naming a bare-word directory repo', async () => {
    const dir = makeRepo('origin');
    // The pushremote arm of the same path acceptance.
    git(dir, 'init', '-q', 'sub');
    await certifiesUnmask(dir, 'branch.main.pushremote', 'sub');
  });

  it('certifies an unmasked pushDefault naming a bare-word directory repo', async () => {
    const dir = makeRepo('origin');
    // The pushDefault arm of the same path acceptance.
    git(dir, 'init', '-q', 'sub');
    await certifiesUnmask(dir, 'remote.pushDefault', 'sub');
  });

  it('refuses an unmasked dangling Windows-spelled upstream value', async () => {
    const dir = makeRepo('origin');
    // A backslash-spelled value naming neither a section nor an existing
    // path is DANGLING once unmasked, and the probes decide it. The old
    // win32 shape carve certified it (fail-open); an EXISTING win32 path
    // still certifies through the path probe on win32, so the carve is gone.
    await refusesUnmask(dir, 'branch.main.remote', '..\\old-sibling');
  });

  it('refuses an unmasked dangling colon-after-slash upstream value', async () => {
    const dir = makeRepo('origin');
    // git reads the scp-like spelling only when the colon precedes the
    // FIRST slash: this is a LOCAL path shape (nonexistent, so dangling
    // once unmasked). A bare colon test short-circuited it as a network
    // transport and certified it (fail-open); the scp-like control beside
    // it still certifies.
    await refusesUnmask(dir, 'branch.main.remote', '../old:sibling');
  });

  it('answers the drive-letter upstream shape per platform', async () => {
    const probe = (value: string) =>
      unmask(makeRepo('origin'), 'branch.main.remote', value);
    if (process.platform === 'win32') {
      // A drive-letter value is a LOCAL path on win32 (git's
      // has_dos_drive_prefix: any non-NUL ASCII character, or one whole
      // non-ASCII code point, plus a colon, no separator required):
      // nonexistent here, so dangling once unmasked, decided locally.
      await expect(probe('C:/old-sibling')).rejects.toThrow(STILL);
      await expect(probe('C:\\old-sibling')).rejects.toThrow(STILL);
      await expect(probe('C:old-sibling')).rejects.toThrow(STILL);
    } else {
      // POSIX git reads the drive-letter shape as scp-like ssh (host `C`),
      // a network transport: the predicate answers it sectionless and every
      // probe stays off the wire (probing would spawn ssh from a config
      // string), so the unmask arm stays silent and the removal certifies
      // (HEAD's polarity).
      expect(await probe('C:/old-sibling')).toEqual([]);
      expect(await probe('C:\\old-sibling')).toEqual([]);
      expect(await probe('C:old-sibling')).toEqual([]);
    }
  });

  it('certifies an unmasked upstream naming a local path, not a section', async () => {
    const dir = makeRepo('origin');
    // A path-valued branch.<b>.remote is git's third sectionless form: an
    // anonymous remote naming a local repository.
    await certifiesUnmask(dir, 'branch.main.remote', dir);
  });

  it('certifies an unmasked scp-like pushDefault', async () => {
    const dir = makeRepo('upstream');
    // The scp-like `[user@]host:path` spelling resolves without a section
    // the same way.
    await certifiesUnmask(dir, 'remote.pushDefault', SCP_URL, 'upstream');
  });

  it('refuses when the removal unmasks an upstream naming a URL-less remote section', async () => {
    const dir = makeRepo('upstream');
    // A bare `[remote "foo"] proxy = …` record puts foo in the section
    // record set while resolving NOTHING (no url/pushurl: git's resolver
    // echoes the bare name): the unmask gate must ask git's resolver, not
    // the record set, or it certifies the dangling upstream it exists to
    // refuse.
    cfg(dir, '--global', 'remote.foo.proxy', 'http://p');
    await refusesUnmask(dir, 'branch.main.remote', 'foo', 'upstream');
    // The refusal must not edit the inherited file either.
    expect(get(dir, 'global', 'branch.main.remote')).toBe('foo\n');
  });

  it('certifies an unmasked upstream naming a legacy .git/remotes/ file', async () => {
    const dir = makeRepo('upstream');
    // A legacy $GIT_DIR/remotes/<name> file resolves the name with NO
    // config record: the record-set approximation would refuse this
    // healthy removal (unrecoverably: once the section is gone the retry
    // takes the converge arm to git's 404).
    legacyRemote(dir, 'second');
    await certifiesUnmask(dir, 'branch.main.remote', 'second', 'upstream');
  });

  it('does not duplicate an empty-value pushDefault the removal never touched', async () => {
    const dir = makeRepo('origin');
    // An empty value prints as an empty LINE under default framing: the
    // restore's presence read must see it as PRESENT (NUL framing), or it
    // re-adds a key git never destroyed, doubling per removal.
    cfg(dir, '--local', 'remote.pushDefault', '');
    await rm(dir, 'origin');
    expect(getAll(dir, 'local', 'remote.pushdefault')).toBe('\n');
  });

  it('refuses when the removal unmasks a dangling slashed upstream value', async () => {
    const dir = makeRepo('origin');
    // A slashed value naming neither a section nor an existing path is a
    // DANGLING upstream once unmasked: the shape shortcut must not certify
    // it (the bare-word twin refuses; so must this).
    await refusesUnmask(dir, 'branch.main.remote', 'ghost/fork');
  });

  it('restores a local upstream copy an include-held record naming the removed remote shadowed', async () => {
    const dir = makeRepo('gone', 'survivor');
    // Included AFTER the local section: pre-removal its record wins the
    // effective value (pointing foo at `gone`) and it survives the rm. The
    // restore's presence check must discount a present value equal to the
    // removed name (dangling residue, not a surviving key), or the
    // destroyed local survivor copy is never written back: permanent loss
    // plus a 409 the write-back avoids when the [branch] section is gone
    // outright (recreated at EOF, past the include directive; a SURVIVING
    // section takes an in-section insert, and a later include-held record
    // can still win effective order — fail-closed, as before this fix).
    shadowSurvivorByInclude(dir, 'gone');
    expect(names(await rm(dir, 'gone'))).toEqual(['survivor']);
    expect(getAll(dir, 'local', 'branch.foo.remote')).toBe('survivor\n');
    expect(get(dir, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
  });

  it('does not duplicate an include-held pushDefault into the local file', async () => {
    const dir = makeRepo('gone');
    // The snapshot's scope dump labels an include.path'd file's records
    // `local`, so the restore's presence check must read the SAME set
    // (includes on): a bare --local read calls the include-held pushDefault
    // absent and re-adds it to .git/config, duplicating the key and
    // shadowing the include forever (a --add appends past the include
    // directive and wins last-value resolution).
    includeCfg(dir, '[remote]\n\tpushDefault = survivor\n');
    expect(await rm(dir, 'gone')).toEqual([]);
    expect(
      cfg(dir, '--local', '--includes', '--get-all', 'remote.pushdefault'),
    ).toBe('survivor\n');
    expect(
      fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'),
    ).not.toContain('pushdefault');
  });

  it('removes a remote from a subdirectory cwd of the worktree', async () => {
    const dir = makeRepo('origin');
    // git prints --show-origin paths relative to the worktree TOPLEVEL (it
    // chdirs during setup), so a subdir cwd must not fail the
    // editable-origin check — every removal would refuse otherwise.
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    expect(await rm(sub, 'origin')).toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('refuses a slashed remote name before the sweep can reach a sibling namespace', async () => {
    const dir = makeRepo('origin');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // refs/remotes/origin/staging/* is a live namespace of its own
    // (origin's staging/* tracking refs, or a configured `origin/staging`
    // remote's) that a slashed target's sweep pattern cannot tell apart,
    // so the panel refuses the shape before anything runs.
    git(dir, 'update-ref', 'refs/remotes/origin/staging/main', 'HEAD');
    await expect(rm(dir, 'origin/staging')).rejects.toThrow(
      'invalid remote name',
    );
    expect(refs(dir, 'refs/remotes/origin')).toContain(
      'refs/remotes/origin/staging/main',
    );
  });

  it('sweeps the exact bare tracking ref git rm leaves behind', async () => {
    const dir = makeRepo('origin');
    // A single-destination fetch (or a plain update-ref) leaves the EXACT
    // ref refs/remotes/origin: outside the refs/remotes/origin/ pattern
    // git's rm deletes through, and invisible to a trailing-slash listing.
    git(dir, 'update-ref', 'refs/remotes/origin', 'HEAD');
    expect(await rm(dir, 'origin')).toEqual([]);
    expect(refs(dir, 'refs/remotes')).toBe('');
  });

  it('refuses a never-configured name without sweeping its live bare ref', async () => {
    const dir = makeRepo('origin');
    // A remote-HEAD symbolic ref is a LIVE top-level ref: the converge arm
    // (no-such-remote over a never-configured name) must surface git's 404
    // with the ref untouched, not sweep it and answer 404 as if nothing
    // happened.
    git(dir, 'symbolic-ref', 'refs/remotes/HEAD', 'refs/remotes/origin/main');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await expect(rm(dir, 'HEAD')).rejects.toThrow(/No such remote/);
    expect(verifyRef(dir, 'refs/remotes/HEAD')).toBeTruthy();
    expect(refs(dir, 'refs/remotes')).toContain('refs/remotes/origin/main');
  });

  it('refuses a never-configured flat-layout name without sweeping its live ref', async () => {
    const dir = makeRepo('origin');
    // A flat fetch refspec puts live refs at refs/remotes/<branch>
    // (top-level, namespace-less): removing the never-configured name
    // `main` must not delete the live one over a 404.
    cfg(dir, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/*');
    git(dir, 'update-ref', 'refs/remotes/main', 'HEAD');
    await expect(rm(dir, 'main')).rejects.toThrow(/No such remote/);
    expect(verifyRef(dir, 'refs/remotes/main')).toBeTruthy();
  });

  it('certifies an unmasked UNC upstream on win32 without probing it', async () => {
    const dir = makeRepo('origin');
    // A UNC path is a NETWORK transport on win32: probing it would block
    // up to the git timeout on an offline share, so the shape
    // short-circuits the probes there and certifies.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const unc = '\\\\fileserver\\share\\repo.git';
      expect(await unmask(dir, 'branch.main.remote', unc)).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', platform!);
    }
  });

  it('refuses a never-configured name whose namespace a surviving refspec dests into', async () => {
    const dir = makeRepo('origin');
    // A second refspec dests origin's refs into refs/remotes/release/*:
    // those are ORIGIN's live tracking state, and removing the
    // never-configured name `release` must not sweep them over a 404
    // (name-prefix ownership would).
    const refspec = '+refs/heads/*:refs/remotes/release/*';
    cfg(dir, '--add', 'remote.origin.fetch', refspec);
    git(dir, 'update-ref', 'refs/remotes/release/1.0', 'HEAD');
    await expect(rm(dir, 'release')).rejects.toThrow(/No such remote/);
    expect(verifyRef(dir, 'refs/remotes/release/1.0')).toBeTruthy();
  });

  it('refuses a never-configured name under a flat dest namespace with slashed branches', async () => {
    const dir = makeRepo('origin');
    // The flat dest owns EVERYTHING below refs/remotes/, slashed branch
    // refs included: the residual the bare-ref exclusion alone could not
    // close.
    cfg(dir, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/*');
    git(dir, 'update-ref', 'refs/remotes/release/1.0', 'HEAD');
    await expect(rm(dir, 'release')).rejects.toThrow(/No such remote/);
    expect(verifyRef(dir, 'refs/remotes/release/1.0')).toBeTruthy();
  });

  it('keeps a surviving remote mid-wildcard dest refs out of an unrelated sweep', async () => {
    const dir = makeRepo();
    // A mid-wildcard dest (`refs/remotes/*/main`, git-legal) covers
    // namespaces no literal prefix bounds; failing closed (whole tree
    // foreign) is the only safe reading. Removing `origin` (own dest
    // disjoint) must not delete fork's live refs/remotes/origin/main.
    addRemotes(dir, 'fork');
    cfg(dir, 'remote.fork.fetch', '+refs/heads/*:refs/remotes/*/main');
    cfg(dir, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/ns/*');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/master/main', 'HEAD');
    expect(names(await rm(dir, 'origin'))).toEqual(['fork']);
    const remaining = refs(dir, 'refs/remotes');
    expect(remaining).toContain('refs/remotes/origin/main');
    expect(remaining).toContain('refs/remotes/master/main');
  });

  it('still sweeps a refspec-less remote orphans when another remote keeps a default dest', async () => {
    const dir = makeRepo('origin');
    // A surviving remote with a DEFAULT dest (refs/remotes/origin/*) must
    // not disable the sweep repo-wide: the refspec-less `nf`'s orphan
    // namespace is still nf's own, while origin's stays foreign.
    cfg(dir, '--local', 'remote.nf.url', 'https://example.com/n/r.git');
    git(dir, 'update-ref', 'refs/remotes/nf/main', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(names(await rm(dir, 'nf'))).toEqual(['origin']);
    const remaining = refs(dir, 'refs/remotes');
    expect(remaining).not.toContain('refs/remotes/nf/main');
    expect(remaining).toContain('refs/remotes/origin/main');
  });

  it('keeps a configured slashed sibling bare ref out of the converge sweep', async () => {
    const dir = makeRepo();
    // A single-destination refspec leaves remote a/b's OWN namespace as the
    // bare ref refs/remotes/a/b. The converge arm for the never-configured
    // prefix name `a` must not reassign that ref to the shorter prefix and
    // sweep the sibling's live state over a 404: ownership resolution
    // stays whole, only the removed name's own namespace-less ref is
    // excluded from the result.
    git(dir, 'remote', 'add', 'a/b', 'https://example.com/ab/r.git');
    cfg(dir, 'remote.a/b.fetch', '+refs/heads/main:refs/remotes/a/b');
    git(dir, 'update-ref', 'refs/remotes/a/b', 'HEAD');
    await expect(rm(dir, 'a')).rejects.toThrow(/No such remote/);
    expect(verifyRef(dir, 'refs/remotes/a/b')).toBeTruthy();
  });

  it('keeps a configured slashed sibling tracking namespace when the prefix remote goes', async () => {
    const dir = makeRepo();
    // The sibling section is written, not `git remote add`ed: git newer
    // than 2.50 refuses `remote add a/b` over an existing `a` ("is a subset
    // of existing remote"), while a hand-edited config (the shape the lax
    // removal predicate exists for) still holds it. refs/remotes/a/b/* is
    // ITS namespace: removing `a` must not take it down.
    addRemotes(dir, 'a');
    cfg(dir, '--local', 'remote.a/b.url', 'https://example.com/ab/r.git');
    cfg(dir, '--local', 'remote.a/b.fetch', '+refs/heads/*:refs/remotes/a/b/*');
    git(dir, 'update-ref', 'refs/remotes/a/main', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/a/b/main', 'HEAD');
    expect(names(await rm(dir, 'a'))).toEqual(['a/b']);
    const remaining = refs(dir, 'refs/remotes');
    expect(remaining).toContain('refs/remotes/a/b/main');
    expect(remaining).not.toContain('refs/remotes/a/main');
  });

  it('sweeps orphaned tracking refs a refspec-less worktree removal leaves behind', async () => {
    const { dir, wt } = repoWithWorktree();
    // No fetch refspec (the --mirror=push / hand-unset shape): git's rm
    // fails at the section write and deletes NO refs (probed), so the
    // certification must sweep the orphaned namespace itself, and only it.
    cfg(wt, '--worktree', 'remote.nf.url', 'https://example.com/nf/r.git');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    git(wt, 'update-ref', 'refs/remotes/nf/main', head);
    git(wt, 'update-ref', 'refs/remotes/nf.b/main', head);
    expect(names(await rm(wt, 'nf'))).toEqual([]);
    expect(refs(wt, 'refs/remotes/nf/')).toBe('');
    expect(refs(wt, 'refs/remotes/nf.b/')).toContain('refs/remotes/nf.b/main');
  });

  it('sweeps a symbolic ref without dereferencing it', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.nf.url', 'https://example.com/nf/r.git');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'update-ref', 'refs/remotes/nf/main', head);
    // A symref planted under the remote's namespace (a clones-from-zip
    // config can carry one): the sweep must delete the SYMREF, never its
    // target — dereferencing would delete the user's own branch.
    git(dir, 'symbolic-ref', 'refs/remotes/nf/HEAD', 'refs/heads/main');
    expect(names(await rm(dir, 'nf'))).toEqual([]);
    expect(refs(dir, 'refs/remotes/nf/')).toBe('');
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(`${head}\n`);
  });

  it('sweeps orphaned tracking refs a refspec-less local removal leaves behind', async () => {
    const dir = makeRepo();
    cfg(dir, 'remote.nf.url', 'https://example.com/nf/r.git');
    // git exits 0 over the local section and still deletes no refs
    // without a parseable refspec (probed): the certification sweeps.
    git(dir, 'update-ref', 'refs/remotes/nf/main', 'HEAD');
    expect(names(await rm(dir, 'nf'))).toEqual([]);
    expect(refs(dir, 'refs/remotes/nf/')).toBe('');
  });

  it('refuses when git rm unmasks a same-valued inherited upstream key', async () => {
    const dir = makeRepo('origin', 'upstream');
    // git's rm unsets the .git/config copy because its value matches,
    // unmasking the identical global record it cannot write.
    await refusesUnmask(dir, 'branch.main.remote', 'origin');
    const config = cfg(dir, '--list', '--show-scope');
    expect(config).not.toContain('local\tbranch.main.remote');
    expect(config).toContain('global\tbranch.main.remote=origin');
  });

  it('does not refuse an inherited upstream key shadowed by a surviving remote', async () => {
    const dir = makeRepo('origin', 'upstream');
    // The local copy shadows the global one, so main effectively tracks the
    // SURVIVING upstream: git's rm leaves both alone (verified on git
    // 2.50.1: its branch-key unset compares effective values), and the
    // survivor check must resolve the same way, not match raw records.
    cfg(dir, '--global', 'branch.main.remote', 'origin');
    cfg(dir, '--local', 'branch.main.remote', 'upstream');
    expect(names(await rm(dir, 'origin'))).toEqual(['upstream']);
    const config = cfg(dir, '--list', '--show-scope');
    expect(config).toContain('local\tbranch.main.remote=upstream');
    expect(config).toContain('global\tbranch.main.remote=origin');
  });

  it('completes a worktree-scope removal despite a dotted sibling name', async () => {
    const { dir, wt } = repoWithWorktree();
    // A local remote whose name EXTENDS the removed one: a prefix match
    // would read it as a local copy of `a` and refuse the completion.
    git(dir, 'remote', 'add', 'a.b', 'https://example.com/ab/r.git');
    cfg(wt, '--worktree', 'remote.a.url', 'https://example.com/a/r.git');
    cfg(wt, '--worktree', 'remote.a.fetch', '+refs/heads/*:refs/remotes/a/*');
    git(wt, 'update-ref', 'refs/remotes/a/main', 'HEAD');
    git(wt, 'branch', 'feat');
    track(wt, 'local', 'feat', 'a');

    expect(names(await rm(wt, 'a'))).toEqual(['a.b']);
    expect(refs(wt, 'refs/remotes')).toBe('');
    expect(cfgList(wt)).not.toContain('remote.a.url');
    expect(cfgList(wt)).toContain('remote.a.b.url');
  });

  it('completes a split local+worktree section after git exits 0', async () => {
    const wt = addWorktree(makeRepo());
    // `remote add` writes the common config; the worktree-scope url then
    // splits the section across both files.
    addRemotes(wt, 'dup');
    cfg(wt, '--worktree', 'remote.dup.url', 'https://example.com/wt.git');
    git(wt, 'update-ref', 'refs/remotes/dup/main', 'HEAD');

    // git removes the common half and exits 0; the completion must finish
    // the worktree half instead of reporting a survived section.
    expect(await rm(wt, 'dup')).toEqual([]);
    expect(refs(wt, 'refs/remotes')).toBe('');
    expect(cfgList(wt)).not.toContain('remote.dup.url');
  });

  it('writes back a destroyed upstream copy when the split-section completion removes the last half', async () => {
    const { dir, wt } = repoWithWorktree();
    addRemotes(wt, 'dup');
    cfg(wt, '--worktree', 'remote.dup.url', 'https://example.com/wt.git');
    addRemotes(wt, 'survivor');
    shadowSurvivorByInclude(dir, 'dup');
    // The discount gate must not see the worktree half the exit-0
    // completion removes right after: the restore runs AFTER it, or the
    // destroyed local survivor copy is never written back over the
    // include-held residue.
    expect(names(await rm(wt, 'dup'))).toEqual(['survivor']);
    expect(get(wt, 'local', 'branch.foo.remote')).toBe('survivor\n');
    expect(get(wt, 'local', 'branch.foo.merge')).toBe('refs/heads/foo\n');
  });

  it('refuses up front when an inherited-scope survivor would keep resolving', async () => {
    const dir = makeRepo();
    // Same name in local AND global: the inherited-scope pre-flight
    // refuses BEFORE git rm — an exit-0 split-section removal would
    // destroy the local section, the tracking ref and the pointing
    // branch's keys first and only then refuse over the survivor.
    writeGlobal(GLOBAL_ORIGIN);
    addRemotes(dir, 'origin');
    track(dir, 'local', 'main', 'origin');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await caught(rm(dir, 'origin'))).message).toMatch(INHERITED);
    // Nothing was destroyed: every piece git's rm would have taken is
    // intact, and the inherited section stays untouched.
    expect(get(dir, 'local', 'remote.origin.url')).toBe(`${ORIGIN_URL}\n`);
    expect(get(dir, 'local', 'branch.main.remote')).toBe('origin\n');
    expect(get(dir, 'local', 'branch.main.merge')).toBe('refs/heads/main\n');
    expect(refs(dir, 'refs/remotes/origin')).toContain(
      'refs/remotes/origin/main',
    );
    expect(readGlobal()).toContain('remote "origin"');
  });

  it('answers no-such-remote when the section lives ONLY in an inherited scope', async () => {
    const dir = makeRepo();
    // No repository-scope half exists to be destroyed: the refusal protects
    // the split-section case, and a phantom row (an out-of-band local
    // removal left a global survivor) must get git's 404 — the client's
    // stale-row convergence keys on no_such_remote, never on a 409.
    writeGlobal(GLOBAL_ORIGIN);
    await expect(rm(dir, 'origin')).rejects.toThrow(NO_SUCH);
    expect(readGlobal()).toContain('remote "origin"');
  });

  it('refuses a worktree-section removal shadowed by an inherited scope before any destruction', async () => {
    const wt = addWorktree(makeRepo());
    writeGlobal('[remote "dup"]\n\turl = https://global.example/d.git\n');
    cfg(wt, '--worktree', 'remote.dup.url', 'https://example.com/wt.git');
    // The inherited-scope pre-flight refuses BEFORE git rm: git would fail
    // on the section it cannot edit only AFTER destroying the tracking refs
    // and upstream keys, and completing the worktree half over a global
    // survivor would certify a name that still resolves.
    expect((await caught(rm(wt, 'dup'))).message).toMatch(INHERITED);
    // Scoped at the file meant: an all-scope --list also reads the planted
    // global section, which matches remote.dup.url either way.
    expect(cfgList(wt, 'worktree')).toContain('remote.dup.url');
    expect(readGlobal()).toContain('remote "dup"');
  });
});

it('counts every url as a push destination when no pushurl is configured', async () => {
  const dir = makeRepo('origin');
  setUrl(dir, '--add', 'origin', 'https://example.com/o2/r.git');
  // No pushurl: git pushes to EVERY url, so the push fan-out falls back to
  // the url list (`git remote -v` reports both destinations).
  const [origin] = await listRemotes(dir);
  expect(origin?.pushUrl).toBe(ORIGIN_URL);
  expect(origin?.extraFetchUrls).toBe(1);
  expect(origin?.extraPushUrls).toBe(1);
});

describe('gitRemoteAdd predicate-legal round trip', () => {
  it.each(['a@b', 'a+b', 'a#b', '@'])(
    'git accepts the predicate-legal name %j and the listing returns it',
    async (name) => {
      const remotes = await add(makeRepo(), name, ORIGIN_URL);
      expect(names(remotes)).toEqual([name]);
      expect(remotes[0]?.fetchUrl).toBe(ORIGIN_URL);
    },
  );
});

describe('isSectionlessUpstream mirrors git url_is_local_not_ssh (over-approximating UNC on win32)', () => {
  // The win32 legs cannot run off-win32, so the predicate is unit-tested
  // under a stubbed platform; restore the ORIGINAL property descriptor so
  // later suites (and win32 CI) see the real platform, not the last stub.
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
  };
  afterEach(() => setPlatform(originalDescriptor?.value));
  afterAll(() => {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
    }
  });
  const expectSectionless = (expected: boolean, values: string[]) => {
    for (const value of values) {
      expect(`${value} -> ${isSectionlessUpstream(value)}`).toBe(
        `${value} -> ${expected}`,
      );
    }
  };

  it('classifies win32 local transports as probeable', () => {
    setPlatform('win32');
    expectSectionless(false, [
      'C:/repos/mine',
      'C:\\repos\\mine',
      'C:repos',
      'C:/',
      'C:/..',
      'C:/.',
      '/::',
      '/:a:b',
      '1:/foo',
      '_:/x',
      'ä:/repo',
      'bare',
      'rel/path',
      'a/b:c',
    ]);
  });

  it('classifies win32 network shapes as sectionless', () => {
    setPlatform('win32');
    expectSectionless(true, [
      '\\\\srv\\share',
      '//srv/share',
      '\\/srv/share',
      '/\\srv\\share',
      'C:/CON',
      'C:\\NUL',
      'C:/aux',
      'C:/COM1',
      'C:/lpt1',
      'C:/a:b',
      'C:/a<b',
      'C:/a*b',
      'C:/a?b',
      'C:/repo.',
      'C:/repo ',
      'C:/a\tb',
      'C:/...',
      'C:aux.txt',
      'C:con.txt',
      'C:com1.txt',
      'C:lpt0',
      'C:nul.dat',
      'C:prn.x',
      'C:aux .txt',
      'host:path',
      'https://x/y',
      'rel:after/slash',
    ]);
  });

  it('keeps every drive-letter shape sectionless off-win32', () => {
    setPlatform('linux');
    expectSectionless(true, [
      'C:/repos/mine',
      'C:\\repos\\mine',
      'C:repos',
      'C:/CON',
      'C:/..',
      'host:path',
      'https://x/y',
      'rel:after/slash',
    ]);
    expectSectionless(false, [
      'bare',
      'rel/path',
      'a/b:c',
      '../old:sibling',
      '//srv/share',
      '/::',
    ]);
  });
});

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
  isValidRemoteName,
  isValidRemoteUrl,
} from './git-remotes.js';
import { gitEnv } from './git-branches.js';

const tmpRoots: string[] = [];

// Hermetic global scope: git's duplicate and no-such-remote checks resolve
// across every scope, so a host carrying a global [remote …] section or an
// org-wide insteadOf rewrite would otherwise decide the mutation
// assertions. HOME/XDG reach the code under test through this env (gitEnv
// cannot scrub config files); its GIT_CONFIG_NOSYSTEM does not, because
// gitEnv strips that key — on the read side the listing's scope filter is
// what keeps host system/global remotes out of these assertions.
let fixtureEnv: NodeJS.ProcessEnv;
let tmpHome: string;

// Save/restore: the GIT_CONFIG_COUNT family plant must not destroy a
// host that genuinely presets it (the exact shape the plant simulates).
const savedConfigCount = {
  keys: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'],
  values: {} as Record<string, string | undefined>,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnv });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitremotes-'));
  tmpRoots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Neutralize an inherited global core.hooksPath (hook managers installed
  // machine-wide would otherwise run on every fixture commit).
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitremotes-home-'));
  tmpRoots.push(tmpHome);
  // Built through the same scrubber the code under test uses, so a host
  // that redirects config by env (GIT_CONFIG_GLOBAL, GIT_CONFIG_COUNT…)
  // cannot split the fixture from the code it asserts on.
  fixtureEnv = {
    ...gitEnv({ ...process.env, HOME: tmpHome, XDG_CONFIG_HOME: tmpHome }),
    GIT_CONFIG_NOSYSTEM: '1',
  };
});

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

// The fixture env is rebuilt per test, so planting a redirector here makes
// the scrub witness below non-vacuous on a clean host.
const savedConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
beforeAll(() => {
  process.env['GIT_CONFIG_GLOBAL'] = '/corp/shared.gitconfig';
  for (const key of savedConfigCount.keys) {
    savedConfigCount.values[key] = process.env[key];
  }
  process.env['GIT_CONFIG_COUNT'] = '1';
  process.env['GIT_CONFIG_KEY_0'] = 'remote.planted.url';
  process.env['GIT_CONFIG_VALUE_0'] = 'https://planted.example/x.git';
});
afterAll(() => {
  for (const key of savedConfigCount.keys) {
    const saved = savedConfigCount.values[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});
afterAll(() => {
  if (savedConfigGlobal === undefined) {
    delete process.env['GIT_CONFIG_GLOBAL'];
  } else {
    process.env['GIT_CONFIG_GLOBAL'] = savedConfigGlobal;
  }
});

it('scrubs host config redirectors out of the fixture env', () => {
  expect(fixtureEnv['GIT_CONFIG_GLOBAL']).toBeUndefined();
  expect(fixtureEnv['GIT_CONFIG_COUNT']).toBeUndefined();
});

// The code under test spawns git through gitEnv, which strips
// GIT_CONFIG_NOSYSTEM — so a host /etc/gitconfig remote section would
// decide the inherited-scope assertions (fail loudly HERE, not as ten
// unrelated red tests).
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
      'host /etc/gitconfig defines a [remote] section — the inherited-scope assertions are not hermetic on this host',
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
    ['origin\u200f', false],
    ['ori\u00adingin', false],
    ['ori\u{e0041}gin', false],
    ['origin\ufff9', false],
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
    // Command-executing transport helpers: git's default policy refuses
    // them, but that policy is overridable from config files and
    // GIT_ALLOW_PROTOCOL, so the write path rejects them outright.
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
    // C1 controls and Cf-outside-Default_Ignorable: stripped at render, so
    // the write gate must refuse them too.
    ['https://example.com/\u0085evil', false],
    ['https://example.com/\u009fevil', false],
    ['https://example.com/\u0600evil', false],
    ['https://example.com/\u202eevil', false],
    ['https://example.com/\u200b', false],
    ['https://example.com/\u2029evil', false],
    ['https://example.com/\u00adevil', false],
    // A Tag-block code point: Default_Ignorable WITHOUT being Cc/Cf —
    // the arm the property-derived class exists for.
    ['https://example.com/\u{e0041}evil', false],
  ])('isValidRemoteUrl(%j) === %s', (url, expected) => {
    expect(isValidRemoteUrl(url)).toBe(expected);
  });
});

describe('isRemovableRemoteName', () => {
  // Removal must not be stricter than git: names a hand-edited config can
  // hold stay removable — the floors are non-emptiness, the NUL byte
  // execFile cannot carry, and (since the tracking-refs sweep landed) a
  // `/`, whose tracking namespace is a subdirectory of the prefix
  // remote's and cannot be swept safely; the `--` terminator guards the
  // exec vector (pinned by the dash-leading round-trip below — git
  // parses a leading `-` as a switch without it).
  it.each([
    ['origin', true],
    ['a.lock', true],
    ['a/b', false],
    ['a:b', true],
    ['HEAD', true],
    ['-y', true],
    [' ', true],
    ['origin\u200f', true],
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
    await expect(fetchGitRemotes(dir, fixtureEnv)).resolves.toEqual([]);
  });

  it('lists remotes in config order with their urls', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream', 'origin']);
    for (const remote of remotes) {
      expect(remote.pushUrl).toBe(remote.fetchUrl);
      expect(remote.promisor).toBe(false);
      expect(remote.customRefspec).toBe(false);
      expect(remote.extraFetchUrls).toBe(0);
      expect(remote.extraPushUrls).toBe(0);
    }
  });

  it('reports a push-url override set via git remote set-url --push', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(
      dir,
      'remote',
      'set-url',
      '--push',
      'origin',
      'git@example.com:o/r.git',
    );
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'git@example.com:o/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ]);
  });

  it('reports promisor and partial-clone filter from the config section', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'config', 'remote.origin.promisor', 'true');
    git(dir, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(true);
    expect(remotes[0]?.partialCloneFilter).toBe('blob:none');
  });

  it('flags a non-default fetch refspec', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(
      dir,
      'config',
      'remote.origin.fetch',
      '+refs/heads/main:refs/remotes/origin/main',
    );
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.customRefspec).toBe(true);
  });

  it('reports extra configured urls instead of hiding them', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/one.git');
    git(
      dir,
      'remote',
      'set-url',
      '--add',
      'origin',
      'https://example.com/o/two.git',
    );
    git(
      dir,
      'remote',
      'set-url',
      '--push',
      'origin',
      'https://example.com/o/push1.git',
    );
    git(
      dir,
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'https://example.com/o/push2.git',
    );
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.fetchUrl).toBe('https://example.com/o/one.git');
    expect(remotes[0]?.pushUrl).toBe('https://example.com/o/push1.git');
    expect(remotes[0]?.extraFetchUrls).toBe(1);
    expect(remotes[0]?.extraPushUrls).toBe(1);
  });

  it('lists a section whose url was unset, with empty urls', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'config', '--unset', 'remote.origin.url');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: '',
        pushUrl: '',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ]);
  });

  it('lists and can remove a dash-leading name git itself accepts', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', '--', '-y', 'https://example.com/y.git');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['-y']);
    await expect(gitRemoteRemove(dir, '-y', fixtureEnv)).resolves.toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('ignores remotes defined only in an inherited config scope', async () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[remote "inherited"]\n\turl = https://global.example/g.git\n',
    );
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // The listing covers only the scopes the repository owns: the
    // inherited remote is not listed, and git cannot remove it either, so
    // claiming it would certify a removal that never happens.
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
  });

  it('refuses to add a name an inherited scope already configures', async () => {
    const dir = makeRepo();
    // git's duplicate check does NOT see the inherited section, so the
    // panel's own Add would silently create a fetch/push divergence.
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[remote "origin"]\n\turl = https://global.example/g.git\n',
    );
    await expect(
      gitRemoteAdd(dir, 'origin', 'https://example.com/o/r.git', fixtureEnv),
    ).rejects.toThrow(/inherited scope/);
    // The inherited row shows in `git remote` by design; the refusal must
    // leave the repository config untouched.
    expect(git(dir, 'config', '--local', '--list')).not.toContain(
      'remote.origin.url',
    );
  });

  it('reports not-a-repo before the inherited-scope pre-flight', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-notrepo-'));
    tmpRoots.push(dir);
    // Outside a repository the scope read exits 0 with the inherited
    // config: the shadow refusal must not mask git's canonical answer.
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[remote "origin"]\n\turl = https://global.example/g.git\n',
    );
    await expect(
      gitRemoteAdd(dir, 'origin', 'https://example.com/o/r.git', fixtureEnv),
    ).rejects.toThrow(/not a git repository/);
  });

  it('reports the configured url, not an insteadOf-rewritten one', async () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[url "https://rewritten.example/"]\n\tinsteadOf = https://example.com/\n',
    );
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.fetchUrl).toBe('https://example.com/o/r.git');
  });

  it('survives an invalid configured fetch refspec on a sibling remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'config', 'remote.bad.url', 'https://example.com/b/r.git');
    // Genuinely invalid (no colon): a refspec git accepts would not
    // distinguish the config read from the refspec-parsing shapes.
    git(dir, 'config', 'remote.bad.fetch', '+refs/heads/*');
    // A config-level read does not parse refspecs, so one bad section
    // cannot wedge the whole listing (the `git remote` shape did).
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name).sort()).toEqual(['bad', 'origin']);
  });

  it('surfaces git refusal for a remote whose configured refspec is invalid', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.bad.url', 'https://example.com/b/r.git');
    git(dir, 'config', 'remote.bad.fetch', '+refs/heads/*');
    // git dies parsing the refspec before mutating anything: the refusal
    // must surface, not be laundered into a success or a silent 500.
    const err = await gitRemoteRemove(dir, 'bad', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as { stderr?: unknown; message?: unknown };
    expect(
      `${typeof e.stderr === 'string' ? e.stderr : ''}${
        typeof e.message === 'string' ? e.message : ''
      }`,
    ).toMatch(/invalid refspec/i);
    // The premise the refusal rests on: git died BEFORE mutating, so
    // the section must still be there.
    expect(git(dir, 'config', '--get', 'remote.bad.url')).toBe(
      'https://example.com/b/r.git\n',
    );
  });

  it('does not complete a worktree section over git’s invalid-refspec refusal', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(
      wt,
      'config',
      '--worktree',
      'remote.evil.url',
      'https://example.com/e/r.git',
    );
    // A config-chosen refspec value carries a real newline whose second
    // line spoofs the completion phrase; git dies parsing it BEFORE
    // mutating, so the worktree completion must not fire — the refusal
    // has its own answer (remote_config_unparsable) and the row stays.
    git(
      wt,
      'config',
      '--worktree',
      'remote.evil.fetch',
      "+refs/heads/*\ncould not remove config section 'remote.evil'",
    );
    const err = await gitRemoteRemove(wt, 'evil', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as { stderr?: unknown; message?: unknown };
    expect(
      `${typeof e.stderr === 'string' ? e.stderr : ''}${
        typeof e.message === 'string' ? e.message : ''
      }`,
    ).toMatch(/invalid refspec/i);
    expect(git(wt, 'config', '--worktree', '--get', 'remote.evil.url')).toBe(
      'https://example.com/e/r.git\n',
    );
  });

  it('does not mistake an injected exact-prefix line for git’s refusal', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(
      wt,
      'config',
      '--worktree',
      'remote.evil.url',
      'https://example.com/e/r.git',
    );
    // The injected line now carries git's exact `error: Could not …`
    // prefix: the line anchor alone would match it, so only the
    // invalid-refspec precedence keeps the completion from firing.
    git(
      wt,
      'config',
      '--worktree',
      'remote.evil.fetch',
      "+refs/heads/*\nerror: Could not remove config section 'remote.evil'",
    );
    const err = await gitRemoteRemove(wt, 'evil', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as { stderr?: unknown; message?: unknown };
    expect(
      `${typeof e.stderr === 'string' ? e.stderr : ''}${
        typeof e.message === 'string' ? e.message : ''
      }`,
    ).toMatch(/invalid refspec/i);
    expect(git(wt, 'config', '--worktree', '--get', 'remote.evil.url')).toBe(
      'https://example.com/e/r.git\n',
    );
  });

  it('rejects outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-notrepo-'));
    tmpRoots.push(dir);
    await expect(fetchGitRemotes(dir, fixtureEnv)).rejects.toThrow();
  });
});

describe('gitRemoteAdd', () => {
  it('refuses to add a name rendering identically to an existing remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // A zero-width-space lookalike: the panel would show two
    // indistinguishable rows, so the write gate refuses before git is
    // even spawned.
    await expect(
      gitRemoteAdd(
        dir,
        'ori\u200bgin',
        'https://example.com/e/r.git',
        fixtureEnv,
      ),
    ).rejects.toThrow('invalid remote name');
    expect(git(dir, 'config', '--get-all', 'remote.origin.url')).toBe(
      'https://example.com/o/r.git\n',
    );
  });

  it('adds a remote and returns the fresh list', async () => {
    const dir = makeRepo();
    const remotes = await gitRemoteAdd(
      dir,
      'origin',
      'https://example.com/o/r.git',
      fixtureEnv,
    );
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    expect(git(dir, 'remote')).toBe('origin\n');
  });

  it('stores the trimmed url, not the padded body value', async () => {
    const dir = makeRepo();
    await gitRemoteAdd(
      dir,
      'origin',
      '  https://example.com/o/r.git  ',
      fixtureEnv,
    );
    // Read the stored value raw: gitConfig() trims, and git quotes a
    // padded value on write, so a trimmed read would pass with the core
    // trim removed.
    const stored = execFileSync(
      'git',
      ['config', '--local', '--get', 'remote.origin.url'],
      { cwd: dir, encoding: 'utf8', env: fixtureEnv },
    );
    expect(stored).toBe('https://example.com/o/r.git\n');
  });

  it('rejects a padded exec-vector url the raw body value would pass', async () => {
    const dir = makeRepo();
    await expect(
      gitRemoteAdd(dir, 'origin', ' -oProxyCommand=x ', fixtureEnv),
    ).rejects.toThrow(/invalid remote url/);
    expect(git(dir, 'remote')).toBe('');
  });

  it('rejects a duplicate name with git output attached', async () => {
    const dir = makeRepo();
    await gitRemoteAdd(
      dir,
      'origin',
      'https://example.com/o/r.git',
      fixtureEnv,
    );
    const err = await gitRemoteAdd(
      dir,
      'origin',
      'https://example.com/other.git',
      fixtureEnv,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr)
        : '';
    expect(stderr).toMatch(/already exists/i);
  });

  it('rejects command-executing helper urls before spawning git', async () => {
    const dir = makeRepo();
    await expect(
      gitRemoteAdd(dir, 'mirror', 'ext::sh -c touch /tmp/pwned', fixtureEnv),
    ).rejects.toThrow(/invalid remote url/);
    expect(git(dir, 'remote')).toBe('');
  });

  it('rejects invalid names and urls before spawning git', async () => {
    const dir = makeRepo();
    await expect(
      gitRemoteAdd(dir, '-x', 'https://example.com/o/r.git', fixtureEnv),
    ).rejects.toThrow(/invalid remote name/);
    await expect(gitRemoteAdd(dir, 'origin', '', fixtureEnv)).rejects.toThrow(
      /invalid remote url/,
    );
    await expect(
      gitRemoteAdd(dir, 'origin', '-upload-pack=x', fixtureEnv),
    ).rejects.toThrow(/invalid remote url/);
    await expect(
      gitRemoteAdd(dir, 'origin', 'https://example.com/\u202eevil', fixtureEnv),
    ).rejects.toThrow(/invalid remote url/);
    expect(git(dir, 'remote')).toBe('');
  });
});

describe('gitRemoteRemove', () => {
  it('removes a remote and returns the fresh list', async () => {
    const dir = makeRepo();
    await gitRemoteAdd(
      dir,
      'origin',
      'https://example.com/o/r.git',
      fixtureEnv,
    );
    await gitRemoteAdd(
      dir,
      'upstream',
      'https://example.com/u/r.git',
      fixtureEnv,
    );
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    expect(git(dir, 'remote')).toBe('upstream\n');
  });

  it('removes a hand-configured remote whose name the add predicate rejects', async () => {
    const dir = makeRepo();
    // A name `git remote add` would refuse (`.lock` suffix), written
    // straight into the config — removal must still work on it.
    git(dir, 'config', 'remote.x.lock.url', 'https://example.com/x.git');
    const listed = await fetchGitRemotes(dir, fixtureEnv);
    expect(listed.map((r) => r.name)).toEqual(['x.lock']);

    const remotes = await gitRemoteRemove(dir, 'x.lock', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('removing an unknown remote surfaces git no-such-remote', async () => {
    const dir = makeRepo();
    const err = await gitRemoteRemove(dir, 'missing', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr)
        : '';
    expect(stderr).toMatch(/no such remote/i);
  });

  it('rejects an empty name before spawning git', async () => {
    const dir = makeRepo();
    await expect(gitRemoteRemove(dir, '', fixtureEnv)).rejects.toThrow(
      /invalid remote name/,
    );
  });

  it('rejects a NUL-bearing name before spawning git', async () => {
    const dir = makeRepo();
    // execFile refuses an argv entry containing a NUL byte; without the
    // predicate floor the request would die as an unclassified 500.
    await expect(gitRemoteRemove(dir, 'a\0b', fixtureEnv)).rejects.toThrow(
      /invalid remote name/,
    );
  });

  it('removes a control-character name the config can hold', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.a\tb.url', 'https://example.com/t.git');
    const listed = await fetchGitRemotes(dir, fixtureEnv);
    expect(listed.map((r) => r.name)).toEqual(['a\tb']);
    await expect(gitRemoteRemove(dir, 'a\tb', fixtureEnv)).resolves.toEqual([]);
  });
});

describe('fetchGitRemotes config parsing', () => {
  it('lists a space-bearing subsection name and can remove it', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.my remote.url', 'https://example.com/mr.git');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['my remote']);
    expect(remotes[0]?.fetchUrl).toBe('https://example.com/mr.git');
    await expect(
      gitRemoteRemove(dir, 'my remote', fixtureEnv),
    ).resolves.toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('keeps an embedded newline inside one value instead of a phantom row', async () => {
    const dir = makeRepo();
    git(
      dir,
      'config',
      'remote.origin.url',
      'https://good/x.git\nremote.fake.url https://attacker/y.git',
    );
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    expect(remotes[0]?.fetchUrl).toContain('remote.fake.url');
  });

  // The promisor value is resolved by the host git itself
  // (`--type=bool`), so these rows only pin the DELEGATION — a spelling
  // whose truth is stable across git's grammar versions. Boundary
  // integers belong to git's own tests: the maybe_bool bound differs
  // across git versions and builds, so `2147483648` and `2g` have no
  // host-stable expectation.
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
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    git(dir, 'config', 'remote.origin.promisor', value);
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(expected);
  });

  it('reads a valueless promisor key as true', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    fs.writeFileSync(
      path.join(dir, '.git', 'config'),
      fs
        .readFileSync(path.join(dir, '.git', 'config'), 'utf8')
        .replace(/\[remote "origin"\]/, '[remote "origin"]\n\tpromisor'),
    );
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(true);
  });

  it('reads an empty promisor value as false, unlike the valueless key', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    // `git config <key> ''` writes the delimiter with an empty value,
    // which git's boolean parser reads as false.
    git(dir, 'config', 'remote.origin.promisor', '');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(false);
  });

  it('reads a multi-valued promisor additively, like git', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    // git registers a promisor remote on ANY true record — a
    // `[true, false]` pair still lazy-fetches — so the badge must not
    // take the last value.
    git(dir, 'config', '--add', 'remote.origin.promisor', 'true');
    git(dir, 'config', '--add', 'remote.origin.promisor', 'false');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(true);
    git(dir, 'config', '--unset-all', 'remote.origin.promisor');
    git(dir, 'config', '--add', 'remote.origin.promisor', 'false');
    git(dir, 'config', '--add', 'remote.origin.promisor', '0');
    const allFalse = await fetchGitRemotes(dir, fixtureEnv);
    expect(allFalse[0]?.promisor).toBe(false);
  });

  it('badges a remote whose promisor key lives only in the global config', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    // git registers promisor remotes cross-scope; the badge read
    // resolves the same way, so an inherited promisor key on a listed
    // (repository-scope) remote must still mark it.
    git(dir, 'config', '--global', 'remote.origin.promisor', 'true');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(true);
  });

  it('does not certify an unparseable promisor value as true', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    git(dir, 'config', 'remote.origin.promisor', 'maybe');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.promisor).toBe(false);
  });

  it('counts unparsed section settings as otherSettings', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.origin.url', 'https://example.com/o/r.git');
    git(dir, 'config', 'remote.origin.proxy', 'http://corp-proxy:8080');
    git(dir, 'config', 'remote.origin.mirror', 'true');
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes[0]?.otherSettings).toBe(2);
  });
});

describe('fetchGitRemotes repository scope', () => {
  it('lists a remote an include.path in .git/config contributes', async () => {
    const dir = makeRepo();
    const inc = path.join(dir, 'included.gitconfig');
    fs.writeFileSync(
      inc,
      '[remote "inc"]\n\turl = https://example.com/inc.git\n',
    );
    git(dir, 'config', 'include.path', inc);
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // git labels include-sourced keys `local` scope and its duplicate
    // check sees them, so a `--local`-only read under-lists while
    // `git remote add` dead-ends on the included name.
    const remotes = await fetchGitRemotes(dir, fixtureEnv);
    expect(remotes.map((r) => r.name).sort()).toEqual(['inc', 'origin']);
    expect(remotes.find((r) => r.name === 'inc')?.fetchUrl).toBe(
      'https://example.com/inc.git',
    );
  });

  it('refuses a split section before git rm can destroy anything', async () => {
    const dir = makeRepo();
    const inc = path.join(dir, 'included.gitconfig');
    fs.writeFileSync(
      inc,
      '[remote "dup"]\n\turl = https://example.com/from-include.git\n',
    );
    git(dir, 'config', 'include.path', inc);
    git(dir, 'config', 'remote.dup.url', 'https://example.com/from-local.git');
    git(dir, 'branch', 'feat');
    git(dir, 'config', 'branch.feat.remote', 'dup');
    git(dir, 'update-ref', 'refs/remotes/dup/main', 'HEAD');
    // git's rm would edit only .git/config, leaving the included half
    // live — and it deletes the tracking refs and the branch keys BEFORE
    // the section write it cannot complete, so the refusal must come
    // before rm runs at all.
    // The refusal is a pure pre-flight: a second attempt answers the
    // same way, with the state still intact.
    for (let attempt = 0; attempt < 2; attempt++) {
      const err = await gitRemoteRemove(dir, 'dup', fixtureEnv).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        /^remote section lives in an included config file$/,
      );
    }
    // Nothing was destroyed: the section (both halves), the tracking ref
    // and the branch key all survive a refused removal.
    expect(git(dir, 'config', '--get-all', 'remote.dup.url')).toBe(
      'https://example.com/from-include.git\nhttps://example.com/from-local.git\n',
    );
    expect(git(dir, 'config', '--get', 'branch.feat.remote')).toBe('dup\n');
    expect(git(dir, 'for-each-ref', 'refs/remotes/dup')).toBe(
      `${git(dir, 'rev-parse', 'HEAD').trim()} commit\trefs/remotes/dup/main\n`,
    );
  });

  it('refuses to certify while a legacy .git/remotes/<name> file still resolves', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // The pre-config-era mechanism git still honors: $GIT_DIR/remotes/
    // <name> resolves the name with no config record at all — a
    // config-only certification would certify while fetches keep
    // working.
    fs.mkdirSync(path.join(dir, '.git', 'remotes'));
    fs.writeFileSync(
      path.join(dir, '.git', 'remotes', 'origin'),
      'URL: https://example.com/legacy/r.git\n',
    );
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    // git's own section removal DID happen — only the certification
    // refuses.
    expect(git(dir, 'config', '--list')).not.toContain('remote.origin.url');
    // Deleting the legacy file converges the retry to git's own 404.
    fs.unlinkSync(path.join(dir, '.git', 'remotes', 'origin'));
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /no such remote/i,
    );
  });

  it('sweeps a sibling worktree\u2019s upstream keys on a removal from the main one', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feature');
    // The key lives in the SIBLING's config.worktree: invisible to
    // every read the removal runs from the main worktree.
    git(wt, 'config', '--worktree', 'branch.feature.remote', 'origin');
    git(wt, 'config', '--worktree', 'branch.feature.merge', 'refs/heads/main');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(wt, 'config', '--worktree', '--list')).not.toContain(
      'branch.feature.remote',
    );
    expect(git(wt, 'config', '--worktree', '--list')).not.toContain(
      'branch.feature.merge',
    );
  });

  it('removes a remote while a stale (prunable) worktree record exists', async () => {
    const dir = makeRepo();
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // Deleting the directory out of band leaves the registration
    // (tagged prunable) until `git worktree prune` — removals must not
    // die on it.
    fs.rmSync(wt, { recursive: true, force: true });
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
  });

  it('removes fine with a linked sibling when extensions.worktreeConfig is off', async () => {
    const dir = makeRepo();
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // No extensions.worktreeConfig: `git config --worktree` refuses
    // outright — the sibling sweep must read that as "no worktree
    // scope", not fail the removal.
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
  });

  it('refuses when a sibling worktree holds a section override for the remote', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // The sibling's own per-worktree override: the name still resolves
    // there after the shared section goes.
    git(
      wt,
      'config',
      '--worktree',
      'remote.origin.url',
      'https://example.com/override/r.git',
    );
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(git(wt, 'config', '--worktree', '--get', 'remote.origin.url')).toBe(
      'https://example.com/override/r.git\n',
    );
  });

  it('keeps a sibling merge key whose remote lives in the shared config', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(wt, 'branch', 'feat');
    // The branch's remote is in the SHARED config (naming the surviving
    // remote); only its merge key is per-worktree. Removing the
    // unrelated remote must not touch the sibling's merge.
    git(wt, 'config', '--local', 'branch.feat.remote', 'upstream');
    git(wt, 'config', '--worktree', 'branch.feat.merge', 'refs/heads/main');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    expect(git(wt, 'config', '--worktree', '--get', 'branch.feat.merge')).toBe(
      'refs/heads/main\n',
    );
  });

  it('ignores an unrelated sibling branch subkey carrying the name', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    // A description that happens to carry the removed name is not the
    // sweep's business and must not trip the re-verify.
    git(wt, 'config', '--worktree', 'branch.feat.description', 'origin');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(
      git(wt, 'config', '--worktree', '--get', 'branch.feat.description'),
    ).toBe('origin\n');
  });

  it('removes a hand-configured remote whose name carries edge whitespace', async () => {
    const dir = makeRepo();
    fs.appendFileSync(
      path.join(dir, '.git', 'config'),
      '\n[remote " foo"]\n\turl = https://example.com/f/r.git\n',
    );
    // The lenient removal predicate admits the name; the certification
    // must not read git's verbatim echo + terminator as still-resolving.
    const remotes = await gitRemoteRemove(dir, ' foo', fixtureEnv);
    expect(remotes).toEqual([]);
  });

  it('restores a destroyed merge key when the multi-valued remote survived', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'remote', 'add', 'survivor', 'https://example.com/s/r.git');
    git(wt, 'branch', 'b1');
    // git's rm skips the multi-valued remote key but still deletes the
    // merge: the restore must re-add the merge against the survivor.
    git(wt, 'config', '--local', '--add', 'branch.b1.remote', 'survivor');
    git(wt, 'config', '--local', '--add', 'branch.b1.remote', 'origin');
    git(wt, 'config', '--local', 'branch.b1.merge', 'refs/heads/b1');
    git(wt, 'config', '--worktree', 'branch.b1.remote', 'origin');
    const remotes = await gitRemoteRemove(wt, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['survivor']);
    expect(git(wt, 'config', '--local', '--get', 'branch.b1.merge')).toBe(
      'refs/heads/b1\n',
    );
    expect(git(wt, 'config', '--local', '--get', 'branch.b1.remote')).toBe(
      'survivor\n',
    );
  });

  it('refuses to certify while an inherited pushurl-only section survives', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // A pushurl-only inherited section resolves fetch-side as the BARE
    // name (ls-remote --get-url echoes it) — only the all-scope section
    // read sees it. Push keeps reaching it after a certified removal.
    git(
      dir,
      'config',
      '--global',
      'remote.origin.pushurl',
      'https://example.com/push/r.git',
    );
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(git(dir, 'config', '--list')).not.toContain('remote.origin.url');
    expect(
      git(dir, 'config', '--global', '--get', 'remote.origin.pushurl'),
    ).toBe('https://example.com/push/r.git\n');
  });

  it('resolves cleanly when a sibling holds a dotted-EXTENSION remote, not an override', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'a', 'https://example.com/a/r.git');
    // [remote "a.b"] in the sibling's file is not remote a's section.
    git(
      wt,
      'config',
      '--worktree',
      'remote.a.b.url',
      'https://example.com/ab/r.git',
    );
    const remotes = await gitRemoteRemove(dir, 'a', fixtureEnv);
    // The sibling's section is worktree-scoped — invisible from here.
    expect(remotes).toEqual([]);
    expect(git(wt, 'config', '--worktree', '--get', 'remote.a.b.url')).toBe(
      'https://example.com/ab/r.git\n',
    );
  });

  it('restores a shadowed local pushDefault naming a surviving remote', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'remote', 'add', 'survivor', 'https://example.com/s/r.git');
    // git rm's handle_push_default unsets the key in the COMMON config
    // when the effective value matched — the shadowed local survivor
    // copy is collateral the restore must bring back.
    git(wt, 'config', '--local', 'remote.pushDefault', 'survivor');
    git(wt, 'config', '--worktree', 'remote.pushDefault', 'origin');
    const remotes = await gitRemoteRemove(wt, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['survivor']);
    expect(git(wt, 'config', '--local', '--get', 'remote.pushdefault')).toBe(
      'survivor\n',
    );
  });

  it('removes a hand-configured remote whose name carries a trailing CR', async () => {
    const dir = makeRepo();
    fs.appendFileSync(
      path.join(dir, '.git', 'config'),
      '\n[remote "a\r"]\n\turl = https://example.com/f/r.git\n',
    );
    // git echoes an unanswered name verbatim + one LF; the terminator
    // strip must not eat a CR belonging to the name.
    const remotes = await gitRemoteRemove(dir, 'a\r', fixtureEnv);
    expect(remotes).toEqual([]);
  });

  it('does not refuse an include-held upstream key shadowed by a surviving worktree record', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'gone', 'https://example.com/g/r.git');
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // The include-held residue names the removed remote but is
    // shadowed by the worktree record naming the SURVIVING one — inert
    // by the shadowed-survivor doctrine, so the re-verify must not
    // refuse over it.
    const include = path.join(dir, 'extra.cfg');
    fs.writeFileSync(include, '[branch "main"]\n\tremote = gone\n');
    git(dir, 'config', '--local', 'include.path', include);
    // The shadow must live in the INVOKING worktree's scope — a
    // sibling's config.worktree is invisible to this worktree's reads.
    git(dir, 'config', '--worktree', 'branch.main.remote', 'origin');
    const remotes = await gitRemoteRemove(dir, 'gone', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    // The residue is still there (uneditable) — the point is only that
    // it does not refuse the removal.
    expect(git(dir, 'config', '--get', 'branch.main.remote')).toBe('origin\n');
  });

  it('keeps a sibling merge key when the same file holds a surviving remote entry', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'gone', 'https://example.com/g/r.git');
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    // The sibling's file: a multi-valued remote key holding BOTH the
    // removed and the surviving remote — the value sweep takes the
    // removed entry, and the merge key must stay with the survivor.
    git(wt, 'config', '--worktree', '--add', 'branch.feat.remote', 'origin');
    git(wt, 'config', '--worktree', '--add', 'branch.feat.remote', 'gone');
    git(wt, 'config', '--worktree', 'branch.feat.merge', 'refs/heads/main');
    const remotes = await gitRemoteRemove(dir, 'gone', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    expect(git(wt, 'config', '--worktree', '--get', 'branch.feat.merge')).toBe(
      'refs/heads/main\n',
    );
    expect(
      git(wt, 'config', '--worktree', '--get-all', 'branch.feat.remote'),
    ).toBe('origin\n');
  });

  it('refuses an include-held section before rm, and the retry refuses identically', async () => {
    const dir = makeRepo();
    const inc = path.join(dir, 'included.gitconfig');
    fs.writeFileSync(
      inc,
      '[remote "inc"]\n\turl = https://example.com/inc.git\n\tfetch = +refs/heads/*:refs/remotes/inc/*\n',
    );
    git(dir, 'config', 'include.path', inc);
    git(dir, 'branch', 'feat');
    git(dir, 'config', 'branch.feat.remote', 'inc');
    git(dir, 'config', 'branch.feat.merge', 'refs/heads/main');
    git(dir, 'update-ref', 'refs/remotes/inc/main', 'HEAD');
    // git's rm deletes the tracking refs and the branch keys BEFORE it
    // fails renaming a section it cannot write, and the row stays listed
    // (the include file is intact), so every retry would repeat the
    // destruction. The pre-flight must refuse before rm runs — leaving
    // the repository untouched, and a retry must answer the same way.
    for (let attempt = 0; attempt < 2; attempt++) {
      const err = await gitRemoteRemove(dir, 'inc', fixtureEnv).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(
        'remote section lives in an included config file',
      );
    }
    expect(git(dir, 'config', '--get', 'branch.feat.remote')).toBe('inc\n');
    expect(git(dir, 'config', '--get', 'branch.feat.merge')).toBe(
      'refs/heads/main\n',
    );
    expect(git(dir, 'for-each-ref', 'refs/remotes/inc')).toContain(
      'refs/remotes/inc/main',
    );
    expect(git(dir, 'remote')).toBe('inc\n');
  });

  it('lists a worktree-scope remote from the worktree only', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(
      wt,
      'config',
      '--worktree',
      'remote.wtonly.url',
      'https://example.com/wt.git',
    );
    const remotes = await fetchGitRemotes(wt, fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['wtonly']);
    // Another worktree's scope is not this repository's own config.
    await expect(fetchGitRemotes(dir, fixtureEnv)).resolves.toEqual([]);
  });

  it('completes removal of a worktree-scope remote git cannot edit', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(
      wt,
      'config',
      '--worktree',
      'remote.wtonly.url',
      'https://example.com/wt.git',
    );
    git(
      wt,
      'config',
      '--worktree',
      'remote.wtonly.fetch',
      '+refs/heads/*:refs/remotes/wtonly/*',
    );
    // Seed what `git remote remove` destroys before failing on the
    // worktree-scope section: the tracking refs and the upstream config.
    git(wt, 'update-ref', 'refs/remotes/wtonly/main', 'HEAD');
    git(wt, 'branch', 'feat');
    git(wt, 'config', 'branch.feat.remote', 'wtonly');
    git(wt, 'config', 'branch.feat.merge', 'refs/heads/main');
    // The worktree-scope upstream keys git cannot unset either: leaving
    // them behind would dangle `branch.wfeat.remote = <gone>`.
    git(wt, 'branch', 'wfeat');
    git(wt, 'config', '--worktree', 'branch.wfeat.remote', 'wtonly');
    git(wt, 'config', '--worktree', 'branch.wfeat.merge', 'refs/heads/main');

    const remotes = await gitRemoteRemove(wt, 'wtonly', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(wt, 'for-each-ref', 'refs/remotes')).toBe('');
    const config = git(wt, 'config', '--list');
    expect(config).not.toContain('branch.feat.remote');
    expect(config).not.toContain('branch.wfeat.remote');
    expect(config).not.toContain('branch.wfeat.merge');
  });

  it('clears worktree-scope upstream keys on a local remote removal', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // The remote section is at local scope, so git rm exits 0 — but its
    // branch-key cleanup only writes the file it can write, leaving the
    // worktree-held upstream key dangling.
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    git(wt, 'config', '--worktree', 'branch.feat.remote', 'origin');
    git(wt, 'config', '--worktree', 'branch.feat.merge', 'refs/heads/main');

    const remotes = await gitRemoteRemove(wt, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(wt, 'config', '--list')).not.toContain('branch.feat.remote');
    expect(git(wt, 'config', '--list')).not.toContain('branch.feat.merge');
  });

  it('clears a multi-valued worktree upstream key by exact value', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(
      wt,
      'config',
      '--worktree',
      'remote.wtonly.url',
      'https://example.com/wt.git',
    );
    git(wt, 'branch', 'feat');
    // git resolves the LAST value of a multi-valued key — so the removed
    // remote goes last and the branch stays fetch-pointed. The entries
    // MUST differ: only a distinct surviving entry pins the
    // `--fixed-value` half of the unset (a plain `--unset-all` would
    // silently take the surviving remote's entry too). The surviving
    // entry names a real remote, or the unmask gate refuses the removal.
    git(wt, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(wt, 'config', '--worktree', '--add', 'branch.feat.remote', 'upstream');
    git(wt, 'config', '--worktree', '--add', 'branch.feat.remote', 'wtonly');
    git(
      wt,
      'config',
      '--worktree',
      '--add',
      'branch.feat.merge',
      'refs/heads/main',
    );
    git(
      wt,
      'config',
      '--worktree',
      '--add',
      'branch.feat.merge',
      'refs/heads/main',
    );

    const remotes = await gitRemoteRemove(wt, 'wtonly', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    // The surviving remote's entry is kept — only the removed remote's
    // entry was value-matched away.
    expect(
      git(wt, 'config', '--worktree', '--get-all', 'branch.feat.remote'),
    ).toBe('upstream\n');
    // And the merge key stays: the scope still holds a surviving remote
    // entry, so the branch keeps its (surviving) upstream — the merge
    // half pairs with it.
    expect(
      git(wt, 'config', '--worktree', '--get-all', 'branch.feat.merge'),
    ).toBe('refs/heads/main\nrefs/heads/main\n');
  });

  it('attributes a branch by its worktree-scope remote over a divergent local one', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    // git resolves worktree-over-local: feat points at origin through
    // the WORKTREE record. git's rm then deletes the local section too
    // (its effective-value match writes the file it can write) — the
    // shadowed `other` copy is collateral the removal must restore,
    // while the worktree copy (pointing at the removed remote) goes.
    git(wt, 'remote', 'add', 'other', 'https://example.com/other/r.git');
    git(wt, 'config', '--local', 'branch.feat.remote', 'other');
    git(wt, 'config', '--local', 'branch.feat.merge', 'refs/heads/main');
    git(wt, 'config', '--worktree', 'branch.feat.remote', 'origin');
    const remotes = await gitRemoteRemove(wt, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['other']);
    // The surviving local copy is restored: the branch tracks `other`.
    expect(git(wt, 'config', '--local', '--get', 'branch.feat.remote')).toBe(
      'other\n',
    );
    expect(git(wt, 'config', '--local', '--get', 'branch.feat.merge')).toBe(
      'refs/heads/main\n',
    );
    // The worktree-scope copy (the removed remote's) is gone.
    expect(git(wt, 'config', '--worktree', '--list')).not.toContain(
      'branch.feat.remote',
    );
  });

  it('clears a worktree merge key whose remote key lives at local scope', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    // git rm unsets this one itself (local file), but cannot write the
    // worktree-held merge key — attribution must come from the
    // pre-removal snapshot, not the post-removal config.
    git(wt, 'config', 'branch.feat.remote', 'origin');
    git(wt, 'config', '--worktree', 'branch.feat.merge', 'refs/heads/main');

    const remotes = await gitRemoteRemove(wt, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(wt, 'config', '--list')).not.toContain('branch.feat.merge');
  });

  it('clears a worktree pushRemote without touching the fetch upstream', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(
      wt,
      'config',
      '--worktree',
      'remote.wtonly.url',
      'https://example.com/wt.git',
    );
    git(wt, 'branch', 'tri');
    // The branch fetches from the surviving remote but pushes to the
    // removed one: git's rm unsets pushRemote independently of the remote
    // match, so the cleanup must clear it — while the merge key belongs
    // to the surviving upstream and stays.
    git(wt, 'config', '--worktree', 'branch.tri.remote', 'upstream');
    git(wt, 'config', '--worktree', 'branch.tri.merge', 'refs/heads/main');
    git(wt, 'config', '--worktree', 'branch.tri.pushremote', 'wtonly');

    const remotes = await gitRemoteRemove(wt, 'wtonly', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    const config = git(wt, 'config', '--list');
    expect(config).not.toContain('branch.tri.pushremote');
    expect(config).toContain('branch.tri.remote');
    expect(config).toContain('branch.tri.merge');
  });

  it('clears a worktree remote.pushDefault that resolves to the removed remote', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(wt, 'config', '--worktree', 'remote.pushDefault', 'origin');
    git(wt, 'config', '--worktree', 'branch.feat.remote', 'upstream');

    const remotes = await gitRemoteRemove(wt, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    const config = git(wt, 'config', '--list');
    expect(config).not.toContain('remote.pushdefault');
    expect(config).toContain('branch.feat.remote');
  });

  it('converges the tracking-ref sweep on a retry after a failed sweep', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.nf.url', 'https://example.com/nf/r.git');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'update-ref', 'refs/remotes/nf/main', head);
    // The first attempt's sweep dies on a planted ref lock — the section
    // is already gone, so the retry lands on the no-such-remote arm,
    // which must converge the ref cleanup too (not dead-end on it).
    fs.writeFileSync(
      path.join(dir, '.git', 'refs', 'remotes', 'nf', 'main.lock'),
      '',
    );
    await expect(gitRemoteRemove(dir, 'nf', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    fs.rmSync(path.join(dir, '.git', 'refs', 'remotes', 'nf', 'main.lock'));
    await expect(gitRemoteRemove(dir, 'nf', fixtureEnv)).rejects.toThrow(
      /no such remote/i,
    );
    expect(git(dir, 'for-each-ref', 'refs/remotes/nf/')).toBe('');
  });

  it('converges the SIBLING cleanup on a retry after a failed first attempt', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    git(wt, 'config', '--worktree', 'branch.feat.remote', 'origin');
    const configWorktree = path.join(
      dir,
      '.git',
      'worktrees',
      `${path.basename(dir)}-wt`,
      'config.worktree',
    );
    // Attempt 1 dies AFTER the section removal, before the sibling
    // sweep: the sibling's config.worktree is locked.
    fs.writeFileSync(`${configWorktree}.lock`, '');
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    fs.rmSync(`${configWorktree}.lock`);
    // Retry: git answers no-such-remote — the converge arm must still
    // sweep the sibling's keys before surfacing git's 404.
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /no such remote/i,
    );
    expect(git(wt, 'config', '--worktree', '--list')).not.toContain(
      'branch.feat.remote',
    );
  });

  it('converges the upstream cleanup on a retry after a failed cleanup', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // The remote section is at local scope, so git rm removes it
    // successfully — the lock only blocks the upstream cleanup.
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    git(wt, 'config', '--worktree', 'branch.feat.remote', 'origin');
    const configWorktree = path.join(
      dir,
      '.git',
      'worktrees',
      `${path.basename(dir)}-wt`,
      'config.worktree',
    );
    fs.writeFileSync(`${configWorktree}.lock`, '');
    // First attempt: the section goes but the cleanup dies on the lock.
    await expect(gitRemoteRemove(wt, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    fs.rmSync(`${configWorktree}.lock`);
    // Retry: git answers no-such-remote (the section is gone), which must
    // still converge the upstream cleanup instead of dead-ending.
    await expect(gitRemoteRemove(wt, 'origin', fixtureEnv)).rejects.toThrow(
      /no such remote/i,
    );
    expect(git(wt, 'config', '--list')).not.toContain('branch.feat.remote');
  });

  it('refuses to certify when a worktree upstream key cannot be unset', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // The remote section is at LOCAL scope, so git rm exits 0 and the
    // section gates all pass: only the branch-key cleanup can fail, and
    // the re-verification guard is what turns that into a refusal.
    git(wt, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(wt, 'branch', 'feat');
    git(wt, 'config', '--worktree', 'branch.feat.remote', 'origin');
    const configWorktree = path.join(
      dir,
      '.git',
      'worktrees',
      `${path.basename(dir)}-wt`,
      'config.worktree',
    );
    // git writes config via lock+rename, so a stale lock file is the
    // deterministic write failure (chmod cannot stop the rename).
    fs.writeFileSync(`${configWorktree}.lock`, '');
    await expect(gitRemoteRemove(wt, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    // Fail-closed: the upstream key survives rather than being certified
    // cleaned.
    expect(fs.readFileSync(configWorktree, 'utf8')).toContain(
      'remote = origin',
    );
  });

  it('refuses to certify an upstream key surviving in an included file', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // git's rm unsets branch.<b>.remote only in .git/config: the key held
    // in an include.path'd file is scope-`local` and survives the
    // certified removal into a dangling `branch.main.remote = <gone>`.
    const include = path.join(dir, 'extra.cfg');
    fs.writeFileSync(include, '[branch "main"]\n\tremote = origin\n');
    git(dir, 'config', '--local', 'include.path', include);
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    const config = git(dir, 'config', '--list', '--show-scope');
    // The remote section IS gone — only the include-held key survives,
    // uneditable by this module.
    expect(config).not.toContain('remote.origin.url');
    expect(config).toContain('local\tbranch.main.remote=origin');
  });

  it('refuses to certify an include-held pushDefault resolving to the removed remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // Same shape as the include-held branch key: `git push` would keep
    // resolving the default to the gone remote.
    const include = path.join(dir, 'extra.cfg');
    fs.writeFileSync(include, '[remote]\n\tpushDefault = origin\n');
    git(dir, 'config', '--local', 'include.path', include);
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    const config = git(dir, 'config', '--list', '--show-scope');
    expect(config).not.toContain('remote.origin.url');
    expect(config).toContain('local\tremote.pushdefault=origin');
  });

  it('refuses to certify an upstream key surviving at global scope', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // The global file is shared by every repository — outside what this
    // module will edit — so the only honest answer is a refusal.
    git(dir, 'config', '--global', 'branch.main.remote', 'origin');
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    const config = git(dir, 'config', '--list', '--show-scope');
    expect(config).not.toContain('remote.origin.url');
    expect(config).toContain('global\tbranch.main.remote=origin');
    expect(git(dir, 'config', '--global', '--get', 'branch.main.remote')).toBe(
      'origin\n',
    );
  });

  it('sweeps the removed remote from a multi-valued local upstream key', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'branch', 'feat');
    // branch.feat.remote = [upstream, origin]: the LAST value points at
    // the removed remote, so the branch is pointed — but git's rm skips
    // a multi-valued key with a warning, leaving every entry behind. The
    // sweep must take only the removed remote's entries (--fixed-value):
    // a plain --unset-all would cut the surviving remote's entry too.
    git(dir, 'config', '--local', '--add', 'branch.feat.remote', 'upstream');
    git(dir, 'config', '--local', '--add', 'branch.feat.remote', 'origin');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    expect(
      git(dir, 'config', '--local', '--get-all', 'branch.feat.remote'),
    ).toBe('upstream\n');
  });

  it('sweeps a non-effective multi-valued entry so a later removal cannot unmask it', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'gone', 'https://example.com/g/r.git');
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // branch.main.remote = [gone, origin]: the branch is NOT pointed at
    // `gone` (the effective value is origin), but the non-effective
    // entry is residue — left behind, it would surface and dangle the
    // moment `origin` is removed.
    git(dir, 'config', '--local', '--add', 'branch.main.remote', 'gone');
    git(dir, 'config', '--local', '--add', 'branch.main.remote', 'origin');
    const step1 = await gitRemoteRemove(dir, 'gone', fixtureEnv);
    expect(step1.map((r) => r.name)).toEqual(['origin']);
    expect(
      git(dir, 'config', '--local', '--get-all', 'branch.main.remote'),
    ).toBe('origin\n');
    const step2 = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(step2).toEqual([]);
    expect(git(dir, 'config', '--list')).not.toContain('branch.main.remote');
  });

  it('keeps the merge key when the scope still holds a surviving remote entry', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(dir, 'remote', 'add', 'wtonly', 'https://example.com/w/r.git');
    git(dir, 'branch', 'feat');
    // feat is pointed at wtonly (last value wins), but the same scope's
    // remote key keeps an upstream entry after the sweep — the merge
    // key pairs with the SURVIVING upstream now and must stay.
    git(dir, 'config', '--local', '--add', 'branch.feat.remote', 'upstream');
    git(dir, 'config', '--local', '--add', 'branch.feat.remote', 'wtonly');
    git(
      dir,
      'config',
      '--local',
      '--add',
      'branch.feat.merge',
      'refs/heads/main',
    );
    git(
      dir,
      'config',
      '--local',
      '--add',
      'branch.feat.merge',
      'refs/heads/main',
    );
    const remotes = await gitRemoteRemove(dir, 'wtonly', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    expect(
      git(dir, 'config', '--local', '--get-all', 'branch.feat.remote'),
    ).toBe('upstream\n');
    expect(
      git(dir, 'config', '--local', '--get-all', 'branch.feat.merge'),
    ).toBe('refs/heads/main\nrefs/heads/main\n');
  });

  it('refuses when the removal unmasks an inherited upstream key naming a gone remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // The local record shadows a GLOBAL one naming a remote with no
    // section anywhere: git's rm unsets the local half and the dangling
    // inherited record surfaces — main's upstream now resolves to a
    // ghost, which the removal must not certify either.
    git(dir, 'config', '--global', 'branch.main.remote', 'ghost');
    git(dir, 'config', '--local', 'branch.main.remote', 'upstream');
    await expect(gitRemoteRemove(dir, 'upstream', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(git(dir, 'config', '--global', '--get', 'branch.main.remote')).toBe(
      'ghost\n',
    );
    expect(git(dir, 'config', '--local', '--list')).not.toContain(
      'branch.main.remote',
    );
  });

  it('refuses when the removal unmasks an inherited pushRemote naming a gone remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // The push half of the unmask gate: the local pushRemote shadows a
    // GLOBAL one naming a remote with no section anywhere.
    git(dir, 'config', '--global', 'branch.main.pushremote', 'ghost');
    git(dir, 'config', '--local', 'branch.main.pushremote', 'upstream');
    await expect(gitRemoteRemove(dir, 'upstream', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(
      git(dir, 'config', '--global', '--get', 'branch.main.pushremote'),
    ).toBe('ghost\n');
  });

  it('certifies an unmasked inherited upstream key naming a surviving remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // Same shape, but the surfaced record names a remote that still
    // exists: git's own shadowing semantics, not a dangling upstream.
    git(dir, 'config', '--global', 'branch.main.remote', 'origin');
    git(dir, 'config', '--local', 'branch.main.remote', 'upstream');
    const remotes = await gitRemoteRemove(dir, 'upstream', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    expect(git(dir, 'config', '--get', 'branch.main.remote')).toBe('origin\n');
  });

  it('certifies an unmasked local-repository pseudo-remote (.)', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // branch.main.remote = [., origin]: the sweep removes origin's
    // entry, and git's `.` spelling — the local repository, needing no
    // section — is a VALID surviving upstream, not a dangling one.
    git(dir, 'config', '--local', '--add', 'branch.main.remote', '.');
    git(dir, 'config', '--local', '--add', 'branch.main.remote', 'origin');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(
      git(dir, 'config', '--local', '--get-all', 'branch.main.remote'),
    ).toBe('.\n');
  });

  it('does not refuse a completed removal over an include-held inert merge key', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'branch', 'feat');
    git(dir, 'config', 'branch.feat.remote', 'origin');
    // The merge key lives in an include.path'd file: the sweep cannot
    // edit it, and a merge-only survivor resolves to "." and is inert —
    // the removal must certify, not refuse.
    const include = path.join(dir, 'extra.cfg');
    fs.writeFileSync(include, '[branch "feat"]\n\tmerge = refs/heads/main\n');
    git(dir, 'config', '--local', 'include.path', include);
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'config', '--get', 'branch.feat.merge')).toBe(
      'refs/heads/main\n',
    );
  });

  it('refuses when the removal unmasks an inherited pushDefault naming a gone remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // The local pushDefault shadows a GLOBAL one naming a remote with no
    // section anywhere: the sweep unsets the local copy and the dangling
    // inherited record surfaces — every push without an explicit
    // upstream would resolve to a ghost.
    git(dir, 'config', '--global', 'remote.pushDefault', 'gone2');
    git(dir, 'config', '--local', 'remote.pushDefault', 'origin');
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(git(dir, 'config', '--global', '--get', 'remote.pushdefault')).toBe(
      'gone2\n',
    );
  });

  it('certifies an unmasked pushDefault naming a surviving remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // Same shape, but the surfaced value names a remote that exists.
    git(dir, 'config', '--global', 'remote.pushDefault', 'origin');
    git(dir, 'config', '--local', 'remote.pushDefault', 'upstream');
    const remotes = await gitRemoteRemove(dir, 'upstream', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['origin']);
    expect(git(dir, 'config', '--get', 'remote.pushdefault')).toBe('origin\n');
  });

  it('ignores a pre-existing dangling inherited pushDefault the removal never shadowed', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // The global pushDefault pointed at a ghost BEFORE the removal and
    // no editable copy shadowed it — not this removal's doing.
    git(dir, 'config', '--global', 'remote.pushDefault', 'ghost');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'config', '--global', '--get', 'remote.pushdefault')).toBe(
      'ghost\n',
    );
  });

  it('certifies an unmasked upstream naming a URL, not a section', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // git resolves a URL-valued branch.<b>.remote as an ANONYMOUS remote
    // — no section needed — so the unmasked inherited URL is a valid
    // upstream, not a dangling name.
    git(
      dir,
      'config',
      '--global',
      'branch.main.remote',
      'https://example.com/inherited/x.git',
    );
    git(dir, 'config', '--local', 'branch.main.remote', 'origin');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'config', '--get', 'branch.main.remote')).toBe(
      'https://example.com/inherited/x.git\n',
    );
  });

  it('certifies an unmasked upstream naming a local path, not a section', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // A path-valued branch.<b>.remote is git's third sectionless form:
    // an anonymous remote naming a local repository.
    git(dir, 'config', '--global', 'branch.main.remote', dir);
    git(dir, 'config', '--local', 'branch.main.remote', 'origin');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'config', '--get', 'branch.main.remote')).toBe(`${dir}\n`);
  });

  it('certifies an unmasked scp-like pushDefault', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // The scp-like `[user@]host:path` spelling resolves without a
    // section the same way.
    git(
      dir,
      'config',
      '--global',
      'remote.pushDefault',
      'git@example.com:me/repo.git',
    );
    git(dir, 'config', '--local', 'remote.pushDefault', 'upstream');
    const remotes = await gitRemoteRemove(dir, 'upstream', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'config', '--get', 'remote.pushdefault')).toBe(
      'git@example.com:me/repo.git\n',
    );
  });

  it('removes a remote from a subdirectory cwd of the worktree', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // git prints --show-origin paths relative to the worktree TOPLEVEL
    // (it chdirs during setup), so a subdir cwd must not fail the
    // editable-origin check — every removal would refuse otherwise.
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const remotes = await gitRemoteRemove(sub, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });

  it('refuses a slashed remote name before the sweep can reach a sibling namespace', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // refs/remotes/origin/staging/* is a live namespace of its own —
    // origin's staging/* branch tracking refs, or a configured
    // `origin/staging` remote's — and a slashed removal target's sweep
    // pattern cannot tell them apart, so the panel refuses the shape
    // before anything runs.
    git(dir, 'update-ref', 'refs/remotes/origin/staging/main', 'HEAD');
    await expect(
      gitRemoteRemove(dir, 'origin/staging', fixtureEnv),
    ).rejects.toThrow('invalid remote name');
    expect(git(dir, 'for-each-ref', 'refs/remotes/origin')).toContain(
      'refs/remotes/origin/staging/main',
    );
  });

  it('sweeps the exact bare tracking ref git rm leaves behind', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    // A single-destination fetch (or a plain update-ref) leaves the
    // EXACT ref refs/remotes/origin — outside the refs/remotes/origin/
    // pattern git's rm deletes through, and invisible to a
    // trailing-slash listing.
    git(dir, 'update-ref', 'refs/remotes/origin', 'HEAD');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(dir, 'for-each-ref', 'refs/remotes')).toBe('');
  });

  it('keeps a configured slashed sibling tracking namespace when the prefix remote goes', async () => {
    const dir = makeRepo();
    // `git remote add a/b` is legal on the CLI: the panel lists it, and
    // refs/remotes/a/b/* is ITS namespace — a removal of `a` must not
    // take it down.
    git(dir, 'remote', 'add', 'a', 'https://example.com/a/r.git');
    git(dir, 'remote', 'add', 'a/b', 'https://example.com/ab/r.git');
    git(dir, 'update-ref', 'refs/remotes/a/main', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/a/b/main', 'HEAD');
    const remotes = await gitRemoteRemove(dir, 'a', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['a/b']);
    const refs = git(dir, 'for-each-ref', 'refs/remotes');
    expect(refs).toContain('refs/remotes/a/b/main');
    expect(refs).not.toContain('refs/remotes/a/main');
  });

  it('sweeps orphaned tracking refs a refspec-less worktree removal leaves behind', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // No fetch refspec (the --mirror=push / hand-unset shape): git's rm
    // fails at the section write and deletes NO refs (probed), so the
    // certification must sweep the orphaned namespace itself — and only
    // that namespace.
    git(
      wt,
      'config',
      '--worktree',
      'remote.nf.url',
      'https://example.com/nf/r.git',
    );
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    git(wt, 'update-ref', 'refs/remotes/nf/main', head);
    git(wt, 'update-ref', 'refs/remotes/nf.b/main', head);
    const remotes = await gitRemoteRemove(wt, 'nf', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual([]);
    expect(git(wt, 'for-each-ref', 'refs/remotes/nf/')).toBe('');
    expect(git(wt, 'for-each-ref', 'refs/remotes/nf.b/')).toContain(
      'refs/remotes/nf.b/main',
    );
  });

  it('sweeps a symbolic ref without dereferencing it', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.nf.url', 'https://example.com/nf/r.git');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'update-ref', 'refs/remotes/nf/main', head);
    // A symref planted under the remote's namespace (a clones-from-zip
    // config can carry one): the sweep must delete the SYMREF, never
    // its target — dereferencing would delete the user's own branch.
    git(dir, 'symbolic-ref', 'refs/remotes/nf/HEAD', 'refs/heads/main');
    const remotes = await gitRemoteRemove(dir, 'nf', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual([]);
    expect(git(dir, 'for-each-ref', 'refs/remotes/nf/')).toBe('');
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(`${head}\n`);
  });

  it('sweeps orphaned tracking refs a refspec-less local removal leaves behind', async () => {
    const dir = makeRepo();
    git(dir, 'config', 'remote.nf.url', 'https://example.com/nf/r.git');
    // git exits 0 over the local section and still deletes no refs
    // without a parseable refspec (probed): the certification sweeps.
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'update-ref', 'refs/remotes/nf/main', head);
    const remotes = await gitRemoteRemove(dir, 'nf', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual([]);
    expect(git(dir, 'for-each-ref', 'refs/remotes/nf/')).toBe('');
  });

  it('refuses when git rm unmasks a same-valued inherited upstream key', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // git's rm unsets the .git/config copy because its value matches —
    // unmasking the identical global record it cannot write.
    git(dir, 'config', '--global', 'branch.main.remote', 'origin');
    git(dir, 'config', '--local', 'branch.main.remote', 'origin');
    await expect(gitRemoteRemove(dir, 'origin', fixtureEnv)).rejects.toThrow(
      /remote still configured after removal/,
    );
    const config = git(dir, 'config', '--list', '--show-scope');
    expect(config).not.toContain('local\tbranch.main.remote');
    expect(config).toContain('global\tbranch.main.remote=origin');
  });

  it('does not refuse an inherited upstream key shadowed by a surviving remote', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    // The local copy shadows the global one, so main effectively tracks
    // the SURVIVING upstream — git's rm leaves both alone (verified on
    // git 2.50.1: its branch-key unset compares effective values), and
    // the survivor check must resolve the same way rather than matching
    // raw records.
    git(dir, 'config', '--global', 'branch.main.remote', 'origin');
    git(dir, 'config', '--local', 'branch.main.remote', 'upstream');
    const remotes = await gitRemoteRemove(dir, 'origin', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['upstream']);
    const config = git(dir, 'config', '--list', '--show-scope');
    expect(config).toContain('local\tbranch.main.remote=upstream');
    expect(config).toContain('global\tbranch.main.remote=origin');
  });

  it('completes a worktree-scope removal despite a dotted sibling name', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // A local remote whose name EXTENDS the removed one: a prefix match
    // would read it as a local copy of `a` and refuse the completion.
    git(dir, 'remote', 'add', 'a.b', 'https://example.com/ab/r.git');
    git(
      wt,
      'config',
      '--worktree',
      'remote.a.url',
      'https://example.com/a/r.git',
    );
    git(
      wt,
      'config',
      '--worktree',
      'remote.a.fetch',
      '+refs/heads/*:refs/remotes/a/*',
    );
    git(wt, 'update-ref', 'refs/remotes/a/main', 'HEAD');
    git(wt, 'branch', 'feat');
    git(wt, 'config', 'branch.feat.remote', 'a');
    git(wt, 'config', 'branch.feat.merge', 'refs/heads/main');

    const remotes = await gitRemoteRemove(wt, 'a', fixtureEnv);
    expect(remotes.map((r) => r.name)).toEqual(['a.b']);
    expect(git(wt, 'for-each-ref', 'refs/remotes')).toBe('');
    expect(git(wt, 'config', '--list')).not.toContain('remote.a.url');
    expect(git(wt, 'config', '--list')).toContain('remote.a.b.url');
  });

  it('completes a split local+worktree section after git exits 0', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    // `remote add` writes the common config; the worktree-scope url then
    // splits the section across both files.
    git(wt, 'remote', 'add', 'dup', 'https://example.com/d/r.git');
    git(
      wt,
      'config',
      '--worktree',
      'remote.dup.url',
      'https://example.com/wt.git',
    );
    git(wt, 'update-ref', 'refs/remotes/dup/main', 'HEAD');

    // git removes the common half and exits 0; the completion must finish
    // the worktree half instead of reporting a survived section.
    const remotes = await gitRemoteRemove(wt, 'dup', fixtureEnv);
    expect(remotes).toEqual([]);
    expect(git(wt, 'for-each-ref', 'refs/remotes')).toBe('');
    expect(git(wt, 'config', '--list')).not.toContain('remote.dup.url');
  });

  it('refuses success when an inherited-scope survivor keeps resolving', async () => {
    const dir = makeRepo();
    // Same name in local AND global: git removes the local section and
    // exits 0, but the name still resolves from the global file.
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[remote "origin"]\n\turl = https://global.example/g.git\n',
    );
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const err = await gitRemoteRemove(dir, 'origin', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /remote still configured after removal/,
    );
    expect(fs.readFileSync(path.join(tmpHome, '.gitconfig'), 'utf8')).toContain(
      'remote "origin"',
    );
  });

  it('does not complete a worktree section shadowed by an inherited scope', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
    tmpRoots.push(wt);
    git(dir, 'worktree', 'add', '--detach', wt);
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[remote "dup"]\n\turl = https://global.example/d.git\n',
    );
    git(
      wt,
      'config',
      '--worktree',
      'remote.dup.url',
      'https://example.com/wt.git',
    );
    // git fails on the section it cannot edit; the completion must NOT
    // fire over an inherited-scope survivor (a 200 would certify a removal
    // the global file still resolves).
    const err = await gitRemoteRemove(wt, 'dup', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as { stderr?: unknown; message?: unknown };
    expect(
      `${typeof e.stderr === 'string' ? e.stderr : ''}${
        typeof e.message === 'string' ? e.message : ''
      }`,
    ).toMatch(/could not remove config section/i);
    // Scoped at the file the assertion means: an all-scope --list reads
    // the planted global section too, which satisfies a bare
    // remote.dup.url match whether or not the worktree half survived.
    expect(git(wt, 'config', '--worktree', '--list')).toContain(
      'remote.dup.url',
    );
    expect(fs.readFileSync(path.join(tmpHome, '.gitconfig'), 'utf8')).toContain(
      'remote "dup"',
    );
  });
});

it('counts every url as a push destination when no pushurl is configured', async () => {
  const dir = makeRepo();
  git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
  git(
    dir,
    'remote',
    'set-url',
    '--add',
    'origin',
    'https://example.com/o2/r.git',
  );
  // No pushurl: git pushes to EVERY url, so the push fan-out falls
  // back to the url list (`git remote -v` reports both destinations).
  const [origin] = await fetchGitRemotes(dir, fixtureEnv);
  expect(origin?.pushUrl).toBe('https://example.com/o/r.git');
  expect(origin?.extraFetchUrls).toBe(1);
  expect(origin?.extraPushUrls).toBe(1);
});

describe('gitRemoteAdd predicate-legal round trip', () => {
  it.each(['a@b', 'a+b', 'a#b', '@'])(
    'git accepts the predicate-legal name %j and the listing returns it',
    async (name) => {
      const dir = makeRepo();
      const remotes = await gitRemoteAdd(
        dir,
        name,
        'https://example.com/o/r.git',
        fixtureEnv,
      );
      expect(remotes.map((r) => r.name)).toEqual([name]);
      expect(remotes[0]?.fetchUrl).toBe('https://example.com/o/r.git');
    },
  );
});

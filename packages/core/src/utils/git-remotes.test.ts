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
  ])('isValidRemoteUrl(%j) === %s', (url, expected) => {
    expect(isValidRemoteUrl(url)).toBe(expected);
  });
});

describe('isRemovableRemoteName', () => {
  // Removal must not be stricter than git: names a hand-edited config can
  // hold stay removable — the only floors are non-emptiness and the NUL
  // byte execFile cannot carry; the `--` terminator guards the exec vector
  // (pinned by the dash-leading round-trip below — git parses a leading
  // `-` as a switch without it).
  it.each([
    ['origin', true],
    ['a.lock', true],
    ['a/b', true],
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
  });

  it('rejects outside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-notrepo-'));
    tmpRoots.push(dir);
    await expect(fetchGitRemotes(dir, fixtureEnv)).rejects.toThrow();
  });
});

describe('gitRemoteAdd', () => {
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

  it.each([
    ['0', false],
    ['no', false],
    ['off', false],
    ['false', false],
    ['true', true],
    ['yes', true],
    // git's integer grammar includes hex and k/m/g unit factors; `1e1`,
    // invalid octals and quoted trailing padding make git die at read
    // time, so the listing certifies neither. strtoimax skips LEADING
    // whitespace, and the maybe_bool bound is [INT_MIN, INT_MAX].
    ['0x1', true],
    ['0x0', false],
    ['1k', true],
    ['08', false],
    ['1e1', false],
    [' 1', true],
    [' true ', false],
    [' 1 ', false],
    // strtoimax skips leading whitespace but takes the sign ATTACHED to
    // the digits; uppercase hex/unit forms; maybe_bool bounds to
    // [INT_MIN, INT_MAX]. Anything its parser does not consume dies in
    // git, so the listing certifies neither for those spellings.
    ['+ 1', false],
    ['- 1', false],
    ['+1', true],
    ['\u00a01', false],
    ['1K', true],
    ['0X1', true],
    ['2147483647', true],
    ['2147483648', false],
    ['-2147483648', true],
    ['-2147483649', false],
    ['1g', true],
    ['2g', false],
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

  it('refuses success when an included half of a split section survives', async () => {
    const dir = makeRepo();
    const inc = path.join(dir, 'included.gitconfig');
    fs.writeFileSync(
      inc,
      '[remote "dup"]\n\turl = https://example.com/from-include.git\n',
    );
    git(dir, 'config', 'include.path', inc);
    git(dir, 'config', 'remote.dup.url', 'https://example.com/from-local.git');
    // `git remote remove` edits only .git/config and exits 0 here, leaving
    // the included half live: the verification re-read must catch it.
    const err = await gitRemoteRemove(dir, 'dup', fixtureEnv).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /remote still configured after removal/,
    );
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
    // git resolves the LAST value of a multi-valued key; both entries
    // point at the removed remote, so both may go (a plain --unset exits
    // 5 here).
    git(wt, 'config', '--worktree', '--add', 'branch.feat.remote', 'wtonly');
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
    expect(remotes).toEqual([]);
    expect(git(wt, 'config', '--list')).not.toContain('branch.feat.remote');
    expect(git(wt, 'config', '--list')).not.toContain('branch.feat.merge');
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
    expect(git(wt, 'config', '--list')).toContain('remote.dup.url');
    expect(fs.readFileSync(path.join(tmpHome, '.gitconfig'), 'utf8')).toContain(
      'remote "dup"',
    );
  });
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

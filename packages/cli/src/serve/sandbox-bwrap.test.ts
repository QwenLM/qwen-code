/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parse } from 'shell-quote';
import { execFileSync } from 'node:child_process';
import { gitEnv } from '@qwen-code/qwen-code-core/utils/git-branches.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn());
const storageDirs = vi.hoisted(() => ({ qwen: '', runtime: '' }));

function git(args: string[], cwd?: string): string {
  return execFileSync(
    'git',
    [
      // The literal '/dev/null', never os.devNull: Git for Windows
      // special-cases the POSIX spelling in its compat layer, while
      // os.devNull's win32 value ('\\.\nul') is rejected as
      // "fatal: unable to access '\\.\nul': Invalid argument" — both for
      // this argv config and for GIT_CONFIG_GLOBAL below. Same reason as
      // core/src/extension/extension-git-client.ts.
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'init.templateDir=',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...gitEnv(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TEMPLATE_DIR: '',
      },
    },
  ).trim();
}

beforeEach(() => {
  execMock.mockImplementation((_command, _options, callback) => {
    callback(null, '', '');
    return new EventEmitter();
  });
  vi.stubEnv('BUILD_SANDBOX', undefined);
  vi.stubEnv('QWEN_SANDBOX_NET', undefined);
  vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Total Storage mock: class statics are non-enumerable, so spreading the real
// class would copy nothing. Only the two directory getters are consulted here;
// the module's other named exports (QWEN_DIR, …) pass through unmocked.
vi.mock(
  '@qwen-code/qwen-code-core/config/storage.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/config/storage.js')
      >();
    return {
      ...actual,
      Storage: {
        getGlobalQwenDir: () => storageDirs.qwen,
        getRuntimeBaseDir: () => storageDirs.runtime,
      },
    };
  },
);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      execSync: execSyncMock,
      exec: execMock,
      spawn: spawnMock,
    },
    exec: execMock,
    execSync: execSyncMock,
    spawn: spawnMock,
  };
});

import {
  buildBwrapArgs,
  normalizeWritableRoots,
  resolveBwrapWritableRoots,
  resolveGitWritableRoots,
  resolveSandboxNetworkMode,
  start_sandbox,
} from './sandbox.js';

/** Index of `flag`'s value in a `--flag value` argv, or -1. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Every `--bind <src> <dst>` source in argv order. */
function bindSources(args: string[]): string[] {
  const sources: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bind') {
      sources.push(args[i + 1]);
    }
  }
  return sources;
}

describe('resolveSandboxNetworkMode', () => {
  it.each([
    [{ QWEN_SANDBOX_NET: 'closed' }, 'closed'],
    [{ QWEN_SANDBOX_NET: ' CLOSED ' }, 'closed'],
    [{ QWEN_SANDBOX_NET: 'open' }, 'open'],
    [{}, 'open'],
    [{ QWEN_SANDBOX_PROXY_COMMAND: 'proxy-cmd' }, 'proxied'],
    [
      { QWEN_SANDBOX_NET: 'proxied', QWEN_SANDBOX_PROXY_COMMAND: 'proxy-cmd' },
      'proxied',
    ],
    // An explicit hard deny outranks a configured proxy.
    [
      { QWEN_SANDBOX_NET: 'closed', QWEN_SANDBOX_PROXY_COMMAND: 'proxy-cmd' },
      'closed',
    ],
  ] as Array<[NodeJS.ProcessEnv, string]>)('resolves %j to %s', (env, mode) => {
    expect(resolveSandboxNetworkMode(env)).toBe(mode);
  });

  it.each([undefined, '', '   '])(
    'rejects explicit proxied mode with proxy command %j',
    (command) => {
      expect(() =>
        resolveSandboxNetworkMode({
          QWEN_SANDBOX_NET: 'proxied',
          QWEN_SANDBOX_PROXY_COMMAND: command,
        }),
      ).toThrow(/proxied.*QWEN_SANDBOX_PROXY_COMMAND/);
    },
  );

  // A typo on the hard-deny switch must not fall through to the least
  // restrictive mode: the operator asked for confinement and gets told.
  it.each(['close', 'blocked', 'none', 'off'])(
    'rejects an unrecognized QWEN_SANDBOX_NET=%s instead of falling open',
    (value) => {
      expect(() =>
        resolveSandboxNetworkMode({ QWEN_SANDBOX_NET: value }),
      ).toThrow(/Invalid QWEN_SANDBOX_NET/);
    },
  );
});

describe('buildBwrapArgs', () => {
  const base = {
    writableRoots: ['/ws'],
    targetDir: '/ws',
    cliArgs: ['node', '/cli.js', '--foo'],
    readOnlyOverrides: [] as string[],
  };

  it('opens with a recursive read-only host root and a fresh /dev', () => {
    const args = buildBwrapArgs({ ...base, networkMode: 'open' });

    expect(args.slice(0, 6)).toEqual([
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--die-with-parent',
    ]);
  });

  it.each(['open', 'proxied'] as const)(
    'leaves the network namespace shared in %s mode',
    (networkMode) => {
      expect(buildBwrapArgs({ ...base, networkMode })).not.toContain(
        '--unshare-net',
      );
    },
  );

  it('unshares the network namespace only in closed mode', () => {
    expect(buildBwrapArgs({ ...base, networkMode: 'closed' })).toContain(
      '--unshare-net',
    );
  });

  // D6: a namespace-local PID written into the records shared through ~/.qwen
  // reads as *alive* to a host-side `process.kill(pid, 0)`, so ownership
  // handoff would never fire. There is no switch for it either — guard both.
  it.each(['open', 'closed', 'proxied'] as const)(
    'never unshares the PID namespace or remounts /proc or /tmp (%s mode)',
    (networkMode) => {
      const args = buildBwrapArgs({ ...base, networkMode });

      expect(args).not.toContain('--unshare-pid');
      expect(args).not.toContain('--unshare-all');
      expect(args).not.toContain('--proc');
      expect(args).not.toContain('--tmpfs');
    },
  );

  it('binds every writable root read-write, in the order given', () => {
    const args = buildBwrapArgs({
      ...base,
      writableRoots: ['/ws', '/tmp', '/home/u/.qwen'],
      networkMode: 'open',
    });

    const binds = args.flatMap((arg, i) =>
      arg === '--bind' ? [[args[i + 1], args[i + 2]]] : [],
    );
    expect(binds).toEqual([
      ['/ws', '/ws'],
      ['/tmp', '/tmp'],
      ['/home/u/.qwen', '/home/u/.qwen'],
    ]);
  });

  it('layers read-only overrides after the writable binds they carve out of', () => {
    const args = buildBwrapArgs({
      ...base,
      writableRoots: ['/ws', '/home/u/.qwen'],
      readOnlyOverrides: ['/home/u/.qwen/.env'],
      networkMode: 'open',
    });

    const writableQwenAt = args.findIndex(
      (arg, i) => arg === '--bind' && args[i + 1] === '/home/u/.qwen',
    );
    const overlayAt = args.findIndex(
      (arg, i) =>
        arg === '--ro-bind' &&
        args[i + 1] === '/home/u/.qwen/.env' &&
        args[i + 2] === '/home/u/.qwen/.env',
    );
    expect(writableQwenAt).toBeGreaterThan(-1);
    expect(overlayAt).toBeGreaterThan(-1);
    // bwrap applies mounts in argv order, so the carve-out must follow the
    // writable bind it shadows.
    expect(overlayAt).toBeGreaterThan(writableQwenAt);
  });

  it('chdirs into the target dir and passes cliArgs after the separator', () => {
    const args = buildBwrapArgs({ ...base, networkMode: 'open' });

    expect(valueAfter(args, '--chdir')).toBe('/ws');
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(-1);
    expect(args.slice(separator + 1)).toEqual(['node', '/cli.js', '--foo']);
  });
});

describe('normalizeWritableRoots', () => {
  let work: string;

  beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roots-')));
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('drops roots that do not exist', () => {
    // bwrap fails the whole launch on a missing bind source, so a root that is
    // not there must never reach the argv.
    expect(normalizeWritableRoots([path.join(work, 'absent')])).toEqual([]);
  });

  it.each([
    path.parse(os.homedir()).root,
    os.homedir(),
    path.dirname(os.homedir()),
  ])('refuses a root at or above the home directory: %s', (root) => {
    expect(() => normalizeWritableRoots([work, root])).toThrow(
      'Refusing sandbox writable root',
    );
  });

  it('refuses a symlink to the filesystem root', () => {
    const link = path.join(work, 'root-link');
    fs.symlinkSync(
      path.parse(work).root,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => normalizeWritableRoots([link])).toThrow(
      'Refusing sandbox writable root',
    );
  });

  it('drops a root already covered by an earlier one', () => {
    const nested = path.join(work, 'nested');
    fs.mkdirSync(nested);

    expect(normalizeWritableRoots([work, nested])).toEqual([work]);
  });

  it('keeps both when the parent arrives after the child', () => {
    const nested = path.join(work, 'nested');
    fs.mkdirSync(nested);

    // Documented behavior: only *earlier* roots absorb later ones. bwrap
    // tolerates the redundant bind, so this stays a redundancy, not a bug.
    expect(normalizeWritableRoots([nested, work])).toEqual([nested, work]);
  });

  it('resolves symlinks, because the kernel compares resolved paths', () => {
    const real = path.join(work, 'real');
    const link = path.join(work, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    expect(normalizeWritableRoots([link])).toEqual([real]);
  });

  it('de-duplicates two spellings of the same directory', () => {
    const real = path.join(work, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(work, 'link'));

    expect(normalizeWritableRoots([real, path.join(work, 'link')])).toEqual([
      real,
    ]);
  });
});

describe('resolveGitWritableRoots', () => {
  let work: string;

  beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitroots-')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('contributes nothing outside a repository', () => {
    expect(resolveGitWritableRoots(work)).toEqual([]);
  });

  it('does not grant an unrelated repository named by a planted gitfile', () => {
    const victim = path.join(work, 'victim');
    const planted = path.join(work, 'planted');
    git(['init', '-q', victim]);
    fs.mkdirSync(planted);
    fs.writeFileSync(
      path.join(planted, '.git'),
      `gitdir: ${path.join(victim, '.git')}\n`,
    );
    expect(resolveGitWritableRoots(planted)).toEqual([]);
  });

  it('does not grant a symlinked Git directory', () => {
    const victim = path.join(work, 'victim');
    const planted = path.join(work, 'planted');
    git(['init', '-q', victim]);
    fs.mkdirSync(planted);
    fs.symlinkSync(
      path.join(victim, '.git'),
      path.join(planted, '.git'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(resolveGitWritableRoots(planted)).toEqual([]);
  });

  it('requires explicit grants for a separate Git directory', () => {
    const checkout = path.join(work, 'checkout');
    git([
      'init',
      '-q',
      '--separate-git-dir',
      path.join(work, 'metadata'),
      checkout,
    ]);
    expect(resolveGitWritableRoots(checkout)).toEqual([]);
  });

  it('rejects a forged back-pointer outside the common repository registration', () => {
    const checkout = path.join(work, 'checkout');
    const metadata = path.join(work, 'metadata');
    const victim = path.join(work, 'victim');
    git(['init', '-q', victim]);
    git(['init', '-q', '--separate-git-dir', metadata, checkout]);
    fs.writeFileSync(
      path.join(metadata, 'commondir'),
      path.join(victim, '.git'),
    );
    fs.writeFileSync(
      path.join(metadata, 'gitdir'),
      path.join(checkout, '.git'),
    );
    expect(path.resolve(git(['rev-parse', '--git-common-dir'], checkout))).toBe(
      path.join(victim, '.git'),
    );
    expect(resolveGitWritableRoots(checkout)).toEqual([]);
  });

  it.each(['GIT_DIR', 'GIT_COMMON_DIR'])(
    'ignores an ambient %s pointing at another repository',
    (variable) => {
      const main = path.join(work, 'main');
      const other = path.join(work, 'other');
      git(['init', '-q', main]);
      git(['init', '-q', other]);
      vi.stubEnv(variable, path.join(other, '.git'));
      expect(resolveGitWritableRoots(main)).toEqual([
        path.join(main, '.git'),
        path.join(main, '.git'),
      ]);
    },
  );

  it('rejects a registered worktree belonging to a different checkout', () => {
    const main = path.join(work, 'main');
    git(['init', '-q', main]);
    git(['config', 'user.email', 'test@example.com'], main);
    git(['config', 'user.name', 'test'], main);
    git(['commit', '--allow-empty', '-qm', 'init'], main);
    const worktree = path.join(work, 'wt');
    git(['worktree', 'add', '-q', worktree, '-b', 'topic'], main);
    const other = path.join(work, 'other');
    fs.mkdirSync(other);
    fs.copyFileSync(path.join(worktree, '.git'), path.join(other, '.git'));
    expect(resolveGitWritableRoots(other)).toEqual([]);
  });

  it('rejects a gitfile whose configured worktree is outside the requested workspace', () => {
    const main = path.join(work, 'main');
    const other = path.join(work, 'other');
    git(['init', '-q', main]);
    git(['config', 'core.worktree', main], main);
    fs.mkdirSync(other);
    fs.writeFileSync(
      path.join(other, '.git'),
      `gitdir: ${path.join(main, '.git')}\n`,
    );
    expect(resolveGitWritableRoots(other)).toEqual([]);
  });

  it('retains the enclosing dotfiles repository metadata for a home subdirectory', () => {
    const home = path.join(work, 'home');
    git(['init', '-q', home]);
    const notes = path.join(home, 'notes');
    fs.mkdirSync(notes);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(resolveGitWritableRoots(notes)).toEqual([
      path.join(home, '.git'),
      path.join(home, '.git'),
    ]);
  });

  it('resolves the git dir and common dir of a worktree checkout', () => {
    vi.stubEnv('GIT_DIR', path.join(work, 'ambient.git'));
    // The defect this guards: in a worktree `.git` is a file pointing
    // elsewhere, so index/HEAD/reflogs live outside the workspace and a
    // workspace-only bind leaves every `git add` failing EROFS.
    const main = path.join(work, 'main');
    fs.mkdirSync(main);
    git(['init', '-q', '.'], main);
    git(['config', 'user.email', 'test@example.com'], main);
    git(['config', 'user.name', 'test'], main);
    fs.writeFileSync(path.join(main, 'a'), 'a\n');
    git(['add', 'a'], main);
    git(['commit', '-qm', 'init'], main);

    const worktree = path.join(work, 'wt');
    git(['worktree', 'add', '-q', worktree, '-b', 'topic'], main);

    const roots = resolveGitWritableRoots(worktree);

    expect(roots).toContain(
      path.resolve(git(['rev-parse', '--absolute-git-dir'], worktree)),
    );
    expect(roots.every((root) => path.isAbsolute(root))).toBe(true);
    // Both land outside the worktree — the whole reason they need binding.
    expect(roots.some((root) => root.startsWith(worktree))).toBe(false);
    const nested = path.join(worktree, 'nested');
    fs.mkdirSync(nested);
    expect(resolveGitWritableRoots(nested)).toEqual(roots);
  });
});

describe('resolveBwrapWritableRoots', () => {
  let work: string;

  beforeEach(() => {
    work = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bwraproots-')),
    );
    storageDirs.qwen = path.join(work, 'qwen');
    storageDirs.runtime = path.join(work, 'runtime');
    // The scratch dir lives under the real `os.tmpdir()`, which is itself a
    // writable root and would legitimately absorb every root below it — hiding
    // exactly what these tests check. Point tmpdir at a sibling instead so the
    // roots stay disjoint.
    const fakeTmp = path.join(work, 'tmp');
    const fakeHome = path.join(work, 'operator-home');
    const workspace = path.join(work, 'workspace');
    for (const dir of [fakeTmp, fakeHome, workspace]) fs.mkdirSync(dir);
    vi.spyOn(os, 'tmpdir').mockReturnValue(fakeTmp);
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    vi.stubEnv('XDG_CACHE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(work, { recursive: true, force: true });
  });

  // Added after a mutation test: deleting the `resolveGitWritableRoots(...)`
  // line from this function left all 101 tests green, even though it silently
  // breaks every git write in a worktree checkout — the single most important
  // thing this backend fixes. `resolveGitWritableRoots` having its own test is
  // not enough; something has to assert that the roots builder calls it.
  it('includes the git dirs of a worktree checkout', () => {
    const main = path.join(work, 'main');
    fs.mkdirSync(main);
    git(['init', '-q', '.'], main);
    git(['config', 'user.email', 'test@example.com'], main);
    git(['config', 'user.name', 'test'], main);
    fs.writeFileSync(path.join(main, 'a'), 'a\n');
    git(['add', 'a'], main);
    git(['commit', '-qm', 'init'], main);
    const worktree = path.join(work, 'wt');
    git(['worktree', 'add', '-q', worktree, '-b', 'topic'], main);
    vi.spyOn(process, 'cwd').mockReturnValue(worktree);

    const { targetDir, roots } = resolveBwrapWritableRoots();

    expect(targetDir).toBe(worktree);
    expect(roots).toContain(
      path.resolve(git(['rev-parse', '--absolute-git-dir'], worktree)),
    );
    expect(roots).toContain(fs.realpathSync(path.join(main, '.git')));
  });

  it('passes the caller-provided workspace directories through', () => {
    const ws = path.join(work, 'ws');
    const extra = path.join(work, 'extra');
    fs.mkdirSync(ws);
    fs.mkdirSync(extra);
    vi.spyOn(process, 'cwd').mockReturnValue(ws);

    expect(resolveBwrapWritableRoots([extra]).roots).toContain(extra);
  });

  it('drops an optional cache whose parent does not exist', () => {
    const cache = path.join(work, 'absent-parent', 'cache');
    vi.stubEnv('XDG_CACHE_HOME', cache);
    expect(resolveBwrapWritableRoots().roots).not.toContain(cache);
    expect(fs.existsSync(path.dirname(cache))).toBe(false);
  });

  it('creates the default cache leaf when XDG_CACHE_HOME is empty', () => {
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('XDG_CACHE_HOME', '');
    const cache = path.join(home, '.cache');
    expect(resolveBwrapWritableRoots().roots).toContain(cache);
    expect(fs.statSync(cache).isDirectory()).toBe(true);
  });

  it('refuses an included directory that resolves inside the home directory', () => {
    const home = path.join(work, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('XDG_CACHE_HOME', '');
    const ws = path.join(work, 'ws');
    fs.mkdirSync(ws);
    vi.spyOn(process, 'cwd').mockReturnValue(ws);

    // Workspace-scope settings can name this directory; it must not become a
    // writable root.
    expect(() => resolveBwrapWritableRoots([path.join(home, '.ssh')])).toThrow(
      'Refusing sandbox writable root',
    );

    // A directory already covered by a built-in root stays admitted.
    const cache = path.join(home, '.cache');
    expect(resolveBwrapWritableRoots([cache]).roots).toContain(
      fs.realpathSync(cache),
    );
  });

  it('names the home directory when refusing a root that contains it', () => {
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(process, 'cwd').mockReturnValue(home);

    expect(() => resolveBwrapWritableRoots()).toThrow(
      `Refusing sandbox writable root '${fs.realpathSync(home)}': the home directory ('${fs.realpathSync(home)}') and its ancestors must stay read-only.`,
    );
  });

  it('names the home directory when the temp dir is its ancestor', () => {
    const tmp = path.join(work, 'shared-tmp');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    vi.spyOn(os, 'tmpdir').mockReturnValue(tmp);
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(() => resolveBwrapWritableRoots()).toThrow(
      `Refusing sandbox writable root '${fs.realpathSync(tmp)}': the home directory ('${fs.realpathSync(home)}') and its ancestors must stay read-only.`,
    );
  });

  it('reserves the global .env read-only and preserves later operator edits', () => {
    const ws = path.join(work, 'ws');
    fs.mkdirSync(ws);
    vi.spyOn(process, 'cwd').mockReturnValue(ws);

    const envFile = path.join(storageDirs.qwen, '.env');
    expect(resolveBwrapWritableRoots().readOnlyOverrides).toEqual([envFile]);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('');
    if (process.platform !== 'win32') {
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    }

    fs.writeFileSync(envFile, 'KEY=1\n');
    const { roots, readOnlyOverrides } = resolveBwrapWritableRoots();
    expect(roots).toContain(fs.realpathSync(storageDirs.qwen));
    expect(readOnlyOverrides).toEqual([fs.realpathSync(envFile)]);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('KEY=1\n');
  });

  it.each(['directory', 'hardlink'])(
    'refuses a global .env that is a %s',
    (kind) => {
      fs.mkdirSync(storageDirs.qwen);
      const envFile = path.join(storageDirs.qwen, '.env');
      if (kind === 'directory') {
        fs.mkdirSync(envFile);
      } else {
        const original = path.join(work, 'original.env');
        fs.writeFileSync(original, 'KEY=1\n');
        fs.linkSync(original, envFile);
      }
      expect(() => resolveBwrapWritableRoots()).toThrow(
        /Cannot protect sandbox configuration/,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked global .env without changing its target',
    () => {
      fs.mkdirSync(storageDirs.qwen);
      const original = path.join(work, 'original.env');
      fs.writeFileSync(original, 'KEY=1\n');
      fs.symlinkSync(original, path.join(storageDirs.qwen, '.env'));
      expect(() => resolveBwrapWritableRoots()).toThrow(
        /Cannot protect sandbox configuration/,
      );
      expect(fs.readFileSync(original, 'utf8')).toBe('KEY=1\n');
    },
  );

  it('fails closed when the global .env cannot be prepared', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('fixture write refused'), {
        code: 'EACCES',
      });
    });
    expect(() => resolveBwrapWritableRoots()).toThrow(
      /Cannot protect sandbox configuration.*fixture write refused/,
    );
  });
});

describe('start_sandbox bwrap branch', () => {
  const cliArgs = [process.execPath, '/path/to/cli.js', '--prompt', 'hi'];
  let work: string;

  beforeEach(() => {
    work = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-hop-')),
    );
    storageDirs.qwen = path.join(work, 'qwen');
    storageDirs.runtime = path.join(work, 'runtime');
    fs.mkdirSync(storageDirs.qwen);
    fs.mkdirSync(storageDirs.runtime);
    const fakeHome = path.join(work, 'home');
    const fakeTmp = path.join(work, 'tmp');
    const workspace = path.join(work, 'workspace');
    for (const dir of [fakeHome, fakeTmp, workspace]) fs.mkdirSync(dir);
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(os, 'tmpdir').mockReturnValue(fakeTmp);
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    vi.stubEnv('XDG_CACHE_HOME', '');
    vi.stubEnv('DEBUG', undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'realpathSync').mockImplementation(
      (filePath) => String(filePath) || '/tmp',
    );
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
    fs.rmSync(work, { recursive: true, force: true });
  });

  async function run(
    nodeArgs: string[] = [],
    childEnv?: Record<string, string>,
  ): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    const child = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation((command) =>
      command === 'bash'
        ? Object.assign(new EventEmitter(), { pid: 4321 })
        : child,
    );
    const result = start_sandbox(
      { command: 'bwrap' },
      nodeArgs,
      undefined,
      cliArgs,
      childEnv,
    );
    await Promise.resolve();
    const call = spawnMock.mock.calls.find((call) => call[0] === 'bwrap');
    // Without this, a branch that never spawns fails later as a TypeError on
    // `undefined.env` instead of saying what actually went wrong.
    expect(call, 'bwrap was never spawned').toBeDefined();
    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
    return {
      args: call?.[1] as string[],
      env: (call?.[2] as { env: NodeJS.ProcessEnv }).env,
    };
  }

  it('spawns bwrap with the workspace bound and cliArgs after the separator', async () => {
    const { args } = await run();

    expect(spawnMock.mock.calls[0]?.[0]).toBe('bwrap');
    expect(bindSources(args)).toContain(fs.realpathSync(process.cwd()));
    expect(args.slice(args.indexOf('--') + 1)).toEqual(cliArgs);
  });

  it('marks the child as confined so the prompt and status line agree', async () => {
    const { env } = await run();

    expect(env['SANDBOX']).toBe('bwrap');
    expect(env['SANDBOX_ENFORCEMENT']).toBe('full');
  });

  it('appends memory options without losing inherited Node options', async () => {
    vi.stubEnv('NODE_OPTIONS', '--use-openssl-ca');
    const { env } = await run(['--max-old-space-size=512']);
    expect(env['NODE_OPTIONS']).toBe(
      '--use-openssl-ca --max-old-space-size=512',
    );
  });

  it('preserves child env precedence while adding debug options', async () => {
    vi.stubEnv('NODE_OPTIONS', '--use-openssl-ca');
    vi.stubEnv('DEBUG', '1');
    const { env } = await run([], { NODE_OPTIONS: '--enable-source-maps' });
    expect(env['NODE_OPTIONS']).toBe('--enable-source-maps --inspect-brk');
  });

  it('restores Electron Node mode only for a managed re-exec', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined);
    vi.stubEnv('QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE', '1');
    const { env } = await run();
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    vi.stubEnv('QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE', undefined);
    expect((await run()).env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
  });

  it('drops the display variables so OAuth prints a URL instead of launching a confined browser', async () => {
    vi.stubEnv('DISPLAY', ':0');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('MIR_SOCKET', '/run/mir_socket');

    const { env } = await run();

    expect(env['DISPLAY']).toBeUndefined();
    expect(env['WAYLAND_DISPLAY']).toBeUndefined();
    expect(env['MIR_SOCKET']).toBeUndefined();
  });

  it('refuses BUILD_SANDBOX, which only means anything for an image', async () => {
    vi.stubEnv('BUILD_SANDBOX', '1');

    await expect(start_sandbox({ command: 'bwrap' })).rejects.toThrow(
      'Cannot BUILD_SANDBOX when using bwrap',
    );
  });

  it('passes proxy settings through the normal hop and releases its proxy', async () => {
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy');
    vi.stubEnv('HTTPS_PROXY', 'http://fixture.invalid:9988');
    vi.stubEnv('NO_PROXY', 'fixture.internal');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const { env } = await run();
    expect(spawnMock.mock.calls[0]?.[0]).toBe('bash');
    expect(spawnMock.mock.calls[1]?.[0]).toBe('bwrap');
    expect(env['HTTPS_PROXY']).toBe('http://fixture.invalid:9988');
    expect(env['http_proxy']).toBe('http://fixture.invalid:9988');
    expect(env['no_proxy']).toBe('fixture.internal');
    expect(parse(execMock.mock.calls[0]?.[0])).toContain(
      'http://fixture.invalid:9988',
    );
    expect(process.kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
  });
});

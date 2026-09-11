/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const storageDirs = vi.hoisted(() => ({ qwen: '', runtime: '' }));

// Partial mock: this module also exports `QWEN_DIR` and friends that other
// modules in the graph import, so only the two directory getters are replaced.
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
        ...actual.Storage,
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
      spawn: spawnMock,
    },
    execSync: execSyncMock,
    spawn: spawnMock,
  };
});

import {
  buildBwrapArgs,
  normalizeWritableRoots,
  resolveBwrapWritableRoots,
  resolveGitWritableRoots,
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

describe('buildBwrapArgs', () => {
  const base = {
    writableRoots: ['/ws'],
    targetDir: '/ws',
    cliArgs: ['node', '/cli.js', '--foo'],
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

    expect(bindSources(args)).toEqual(['/ws', '/tmp', '/home/u/.qwen']);
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
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('contributes nothing outside a repository', () => {
    expect(resolveGitWritableRoots(work)).toEqual([]);
  });

  it('resolves the git dir and common dir of a worktree checkout', () => {
    // The defect this guards: in a worktree `.git` is a file pointing
    // elsewhere, so index/HEAD/reflogs live outside the workspace and a
    // workspace-only bind leaves every `git add` failing EROFS.
    const main = path.join(work, 'main');
    fs.mkdirSync(main);
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(['init', '-q', '.'], main);
    git(['config', 'user.email', 'test@example.com'], main);
    git(['config', 'user.name', 'test'], main);
    fs.writeFileSync(path.join(main, 'a'), 'a\n');
    git(['add', 'a'], main);
    git(['commit', '-qm', 'init'], main);

    const worktree = path.join(work, 'wt');
    git(['worktree', 'add', '-q', worktree, '-b', 'topic'], main);

    const roots = resolveGitWritableRoots(worktree);

    expect(roots).toContain(git(['rev-parse', '--absolute-git-dir'], worktree));
    expect(roots.every((root) => path.isAbsolute(root))).toBe(true);
    // Both land outside the worktree — the whole reason they need binding.
    expect(roots.some((root) => root.startsWith(worktree))).toBe(false);
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
    fs.mkdirSync(fakeTmp);
    vi.spyOn(os, 'tmpdir').mockReturnValue(fakeTmp);
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
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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
    expect(roots).toContain(git(['rev-parse', '--absolute-git-dir'], worktree));
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
});

describe('start_sandbox bwrap branch', () => {
  const cliArgs = [process.execPath, '/path/to/cli.js', '--prompt', 'hi'];

  beforeEach(() => {
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
  });

  async function run(): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    const result = start_sandbox({ command: 'bwrap' }, [], undefined, cliArgs);
    const call = spawnMock.mock.calls[0];
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

  // Proxied mode is deliberately not unit-tested here: entering it spawns the
  // user's proxy command and then polls `curl` until it answers, so a unit test
  // would either hang or assert on a stubbed environment rather than on the
  // injection. It is covered by the integration lane instead. The property that
  // matters — the variables reaching the *child env* rather than a discarded
  // object, which is the seatbelt bug this branch avoids — is visible in the
  // `env` assertions above, since they read what was handed to spawn.
});

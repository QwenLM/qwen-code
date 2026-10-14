/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookCommandCgroup,
  HookCommandIsolationUnavailableError,
} from './hook-command-cgroup.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hook-launcher-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('unit creation and attachment', () => {
  it('refuses to create or attach without a delegated Linux root', () => {
    expect(() => HookCommandCgroup.create(undefined)).toThrow(
      HookCommandIsolationUnavailableError,
    );
    expect(() =>
      HookCommandCgroup.create(join(directory, 'not-a-cgroup')),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(() =>
      HookCommandCgroup.create(join(directory, 'not-a-cgroup'), 'qwen-bg-1'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(() =>
      HookCommandCgroup.attach(join(directory, 'not-a-cgroup'), 'qwen-bg-1'),
    ).toThrow(HookCommandIsolationUnavailableError);
  });

  it('refuses a caller-supplied unit name that escapes its root', async () => {
    expect(() =>
      HookCommandCgroup.create(directory, 'qwen-bg/../other'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(() => HookCommandCgroup.create(directory, 'qwen-bg\0tail')).toThrow(
      HookCommandIsolationUnavailableError,
    );
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual([]);
  });

  it('admits a caller-supplied name that stays one unit', () => {
    // The creation below still fails closed on a non-cgroup root, but the
    // name guard must not be the thrower: it runs before resolveRoot, so
    // reaching resolveRoot is the proof the name passed.
    const resolveRoot = vi
      .spyOn(
        HookCommandCgroup as unknown as {
          resolveRoot: (root: string | undefined) => string;
        },
        'resolveRoot',
      )
      .mockReturnValue(directory);
    expect(() =>
      HookCommandCgroup.create('/unused-root', 'qwen-bg-shell-1'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(resolveRoot).toHaveBeenCalledWith('/unused-root');
  });

  it('removes only the unit it created on a failed create, never a pre-existing one', async () => {
    vi.spyOn(
      HookCommandCgroup as unknown as {
        resolveRoot: (root: string | undefined) => string;
      },
      'resolveRoot',
    ).mockReturnValue(directory);
    // A named unit that already exists belongs to its owner — the very
    // process-holding cgroup the H3 recovery path re-attaches by name — so
    // a refused create must leave it exactly where it found it.
    const owned = join(directory, 'qwen-bg-owner');
    await mkdir(owned);
    try {
      HookCommandCgroup.create('/unused-root', 'qwen-bg-owner');
      expect.unreachable('a taken unit name must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(HookCommandIsolationUnavailableError);
      expect((cause as HookCommandIsolationUnavailableError).reason).toBe(
        'unit_name_taken',
      );
    }
    expect(await readdir(directory)).toEqual(['qwen-bg-owner']);
    // A unit create itself made dies with the failed start: no half-empty
    // unit stays behind for the next caller to trip over.
    expect(() =>
      HookCommandCgroup.create('/unused-root', 'qwen-bg-fresh'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(await readdir(directory)).toEqual(['qwen-bg-owner']);
  });
});

describe('managed command launcher environment', () => {
  it('keeps environment values out of argv and applies them only after membership', async () => {
    const preload = join(directory, 'preload.cjs');
    const marker = join(directory, 'preloaded');
    await writeFile(
      preload,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, fs.readFileSync(${JSON.stringify(join(directory, 'cgroup.procs'))}, 'utf8') + '\\n');`,
    );
    // This exercises the real launcher with a membership-file stand-in,
    // without claiming that the temporary directory is a cgroup.
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const env = {
      SERVICE_TOKEN: 'fake-secret-"quoted"\n非真实凭据',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      PATH: '/deployment-command-path',
    };
    const launch = unit.launch(
      process.execPath,
      [
        '--eval',
        'process.stdout.write(JSON.stringify({ token: process.env.SERVICE_TOKEN, path: process.env.PATH }));',
      ],
      env,
    );
    expect(launch.args.join('\n')).not.toContain('fake-secret');
    expect(launch.env).not.toHaveProperty('NODE_OPTIONS');
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output[3]).toBe('joined\n');
    expect(JSON.parse(result.stdout)).toEqual({
      token: env.SERVICE_TOKEN,
      path: env.PATH,
    });
    expect(await readFile(marker, 'utf8')).toBe(`${result.pid}\n`);
  });

  it('does not apply command environment when membership fails', async () => {
    const preload = join(directory, 'preload.cjs');
    const marker = join(directory, 'forbidden');
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      join(directory, 'missing'),
    ]);
    const launch = unit.launch(process.execPath, ['--eval', ''], {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    });
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output[3]).toBe('unavailable\n');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('announces its membership on fd 3 once the kernel accepts it', () => {
    // The marker is the membership proof a parent may rely on even after
    // the unit's process list can no longer name the launcher (the command
    // already ran and everything exited).
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(process.execPath, ['--eval', ''], {});
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output[3]).toBe('joined\n');
  });
});

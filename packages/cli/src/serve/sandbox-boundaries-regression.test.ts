/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ qwen: '', runtime: '' }));
vi.mock(
  '@qwen-code/qwen-code-core/config/storage.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/config/storage.js')
    >()),
    Storage: {
      getGlobalQwenDir: () => dirs.qwen,
      getRuntimeBaseDir: () => dirs.runtime,
    },
  }),
);

import { resolveBwrapWritableRoots } from './sandbox.js';

let fixture: string;
let home: string;
beforeEach(() => {
  fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-policy-')),
  );
  home = path.join(fixture, 'home');
  const workspace = path.join(fixture, 'workspace');
  const temporary = path.join(fixture, 'tmp');
  for (const dir of [home, workspace, temporary]) fs.mkdirSync(dir);
  dirs.qwen = path.join(home, '.qwen');
  dirs.runtime = path.join(home, 'runtime');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(os, 'tmpdir').mockReturnValue(temporary);
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CACHE_HOME', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('bwrap startup configuration policy', () => {
  it('reserves the initially absent global .env as read-only and keeps runtime data writable', () => {
    const envFile = path.join(dirs.qwen, '.env');
    expect(fs.existsSync(envFile)).toBe(false);
    const policy = resolveBwrapWritableRoots();
    expect.soft(policy.readOnlyOverrides).toContain(envFile);
    expect.soft(policy.roots).toContain(dirs.qwen);
    expect.soft(policy.roots).toContain(dirs.runtime);
  });

  it('keeps existing global .env content unchanged and read-only', () => {
    fs.mkdirSync(dirs.qwen, { recursive: true });
    const envFile = path.join(dirs.qwen, '.env');
    fs.writeFileSync(envFile, 'ORDINARY_VALUE=preserved\n');
    const policy = resolveBwrapWritableRoots();
    expect(policy.readOnlyOverrides).toContain(envFile);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('ORDINARY_VALUE=preserved\n');
  });

  it('does not grant write access to the existing global gitconfig', () => {
    const gitconfig = path.join(home, '.gitconfig');
    fs.writeFileSync(gitconfig, '[user]\n\tname = Fixture User\n');
    const policy = resolveBwrapWritableRoots();
    expect(
      policy.roots.some(
        (root) => gitconfig === root || gitconfig.startsWith(root + path.sep),
      ),
    ).toBe(false);
    expect(
      execFileSync(
        'git',
        ['config', '--file', gitconfig, '--get', 'user.name'],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'],
            HOME: home,
            GIT_CONFIG_NOSYSTEM: '1',
          },
        },
      ).trim(),
    ).toBe('Fixture User');
  });
});

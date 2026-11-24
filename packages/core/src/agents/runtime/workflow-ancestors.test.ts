/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTrustedWorkflowAncestors } from './workflow-ancestors.js';

const exec = promisify(execFile);

describe('workflow ancestor Git boundary', () => {
  let base: string;
  const trust = vi.fn(async (dirs: readonly string[]) => dirs.map(() => true));

  beforeEach(async () => {
    base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-git-')),
    );
    trust.mockClear();
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv(
      'GIT_CONFIG_GLOBAL',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(base, { recursive: true, force: true });
  });

  it('C03: includes the repository root and stops at a real linked worktree Git file', async () => {
    const repo = path.join(base, 'repo');
    const worktree = path.join(base, 'worktree');
    await exec('git', ['init', repo]);
    await exec('git', [
      '-C',
      repo,
      '-c',
      'user.name=DW01',
      '-c',
      'user.email=dw01@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${path.join(base, 'no-hooks')}`,
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    await exec('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '--detach',
      worktree,
      'HEAD',
    ]);
    const target = path.join(worktree, 'packages', 'a');
    await fs.mkdir(target, { recursive: true });
    expect((await fs.lstat(path.join(worktree, '.git'))).isFile()).toBe(true);
    expect(await getTrustedWorkflowAncestors(target, trust)).toEqual([
      path.join(worktree, 'packages'),
      worktree,
    ]);
    expect(trust).toHaveBeenCalledExactlyOnceWith(
      [path.join(worktree, 'packages'), worktree],
      target,
    );
  });

  it('C03: a submodule-shaped Git file is the nearest boundary', async () => {
    const nested = path.join(base, 'repo', 'module');
    const target = path.join(nested, 'src');
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(base, 'repo', '.git'));
    await fs.writeFile(
      path.join(nested, '.git'),
      'gitdir: ../.git/modules/module',
    );
    expect(await getTrustedWorkflowAncestors(target, trust)).toEqual([nested]);
  });

  it('C03: a target at its own Git root does not ask for parent trust', async () => {
    await fs.mkdir(path.join(base, '.git'));
    expect(await getTrustedWorkflowAncestors(base, trust)).toEqual([]);
    expect(trust).not.toHaveBeenCalled();
  });

  it('C04: an unknown .git entry type fails closed', async () => {
    const target = path.join(base, 'a', 'b');
    await fs.mkdir(target, { recursive: true });
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(((file, ...args) => {
      if (String(file) === path.join(path.dirname(target), '.git')) {
        return Promise.resolve({
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        });
      }
      return original(file, ...args);
    }) as typeof fs.lstat);
    expect(await getTrustedWorkflowAncestors(target, trust)).toEqual([]);
    expect(trust).not.toHaveBeenCalled();
  });

  it('C05: a sparse provider answer cannot grant unknown ancestors', async () => {
    const target = path.join(base, 'a', 'b');
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(base, '.git'));
    expect(
      await getTrustedWorkflowAncestors(target, async () => Array<boolean>(2)),
    ).toEqual([]);
  });
});

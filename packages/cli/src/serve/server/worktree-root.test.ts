/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKTREE_ROOT,
  InvalidWorktreeRootError,
  parseWorktreeRoot,
} from '@qwen-code/qwen-code-core/utils/worktree-root.js';
import {
  INVALID_WORKTREE_ROOT_SENTINEL,
  isWorktreePathInManagedRoots,
  readWorkspaceWorktreeRoot,
  resolveWorkspaceWorktreeRootSetting,
} from './worktree-root.js';

describe('serve worktree-root settings reader and containment', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeFixture(): Promise<{
    root: string;
    home: string;
    repo: string;
    env: NodeJS.ProcessEnv;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-wt-root-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    return {
      root,
      home,
      repo,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        QWEN_HOME: path.join(home, '.qwen'),
        QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(
          root,
          'missing-system-settings.json',
        ),
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(
          root,
          'missing-system-defaults.json',
        ),
      },
    };
  }

  it('defaults to .qwen/worktrees when unset', async () => {
    const { repo, env } = await makeFixture();
    const parsed = readWorkspaceWorktreeRoot(repo, {
      environment: env,
      workspaceTrusted: true,
    });
    expect(parsed.normalized).toBe(DEFAULT_WORKTREE_ROOT);
    expect(parsed.isDefault).toBe(true);
  });

  it('honors worktree.root from trusted workspace settings and ignores it when untrusted', async () => {
    const { repo, env } = await makeFixture();
    await fs.mkdir(path.join(repo, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.qwen', 'settings.json'),
      JSON.stringify({ worktree: { root: '.worktrees' } }),
    );

    const trusted = readWorkspaceWorktreeRoot(repo, {
      environment: env,
      workspaceTrusted: true,
    });
    expect(trusted.normalized).toBe('.worktrees');
    expect(trusted.isDefault).toBe(false);

    const untrusted = readWorkspaceWorktreeRoot(repo, {
      environment: env,
      workspaceTrusted: false,
    });
    expect(untrusted.normalized).toBe(DEFAULT_WORKTREE_ROOT);
    expect(untrusted.isDefault).toBe(true);
  });

  it('fails closed on invalid worktree.root instead of falling back to default', async () => {
    const { repo, env } = await makeFixture();
    await fs.mkdir(path.join(repo, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.qwen', 'settings.json'),
      JSON.stringify({ worktree: { root: '../escape' } }),
    );

    expect(() =>
      readWorkspaceWorktreeRoot(repo, {
        environment: env,
        workspaceTrusted: true,
      }),
    ).toThrow(InvalidWorktreeRootError);
    expect(
      resolveWorkspaceWorktreeRootSetting(repo, {
        environment: env,
        workspaceTrusted: true,
      }),
    ).toBe(INVALID_WORKTREE_ROOT_SENTINEL);
  });

  it('rejects a non-object worktree section', async () => {
    const { repo, env } = await makeFixture();
    await fs.mkdir(path.join(repo, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.qwen', 'settings.json'),
      JSON.stringify({ worktree: 'bad' }),
    );
    expect(() =>
      readWorkspaceWorktreeRoot(repo, {
        environment: env,
        workspaceTrusted: true,
      }),
    ).toThrow(InvalidWorktreeRootError);
  });

  it('enforces in-repo symlink containment for custom roots in isWorktreePathInManagedRoots', async () => {
    const { root, repo } = await makeFixture();
    const realRepo = await fs.realpath(repo);
    const inRepoCheckout = path.join(realRepo, '.worktrees', 'good-slug');
    await fs.mkdir(inRepoCheckout, { recursive: true });
    const parsed = parseWorktreeRoot('.worktrees');

    expect(
      isWorktreePathInManagedRoots(inRepoCheckout, [realRepo], parsed),
    ).toBe(true);

    // Replace .worktrees with a symlink pointing outside the repository.
    const outside = path.join(root, 'outside');
    const outsideCheckout = path.join(outside, 'escaped-slug');
    await fs.mkdir(outsideCheckout, { recursive: true });
    await fs.rm(path.join(realRepo, '.worktrees'), {
      recursive: true,
      force: true,
    });
    await fs.symlink(outside, path.join(realRepo, '.worktrees'));

    expect(
      isWorktreePathInManagedRoots(
        await fs.realpath(outsideCheckout),
        [realRepo],
        parsed,
      ),
    ).toBe(false);
  });
});

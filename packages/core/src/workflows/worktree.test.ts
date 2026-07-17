/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorktreeProvider } from './worktree.js';

async function tmpGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wf-wt-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.raw(['commit', '--allow-empty', '-m', 'init']);
  return dir;
}

describe('GitWorktreeProvider', () => {
  it('acquires a worktree and returns its path', async () => {
    const repo = await tmpGitRepo();
    const base = await mkdtemp(join(tmpdir(), 'wf-wt-base-'));
    const provider = new GitWorktreeProvider(repo, base);
    const cwd = await provider.acquire('run-1', 0);
    expect(cwd).toContain(base);
    await provider.cleanup('run-1');
  });

  it('throws when acquisition fails (not a git repo) — no silent fallback', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'wf-not-repo-'));
    const provider = new GitWorktreeProvider(notRepo, notRepo);
    await expect(provider.acquire('run-2', 0)).rejects.toThrow();
  });
});

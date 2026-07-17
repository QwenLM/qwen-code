/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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

  it('gives distinct worktree paths per agent and a failing acquire does not remove siblings', async () => {
    const repo = await tmpGitRepo();
    const base = await mkdtemp(join(tmpdir(), 'wf-wt-base-'));
    const provider = new GitWorktreeProvider(repo, base);
    const runId = 'run-concurrent';

    const cwd0 = await provider.acquire(runId, 0);
    const cwd1 = await provider.acquire(runId, 1);
    expect(cwd0).not.toEqual(cwd1);
    expect(await pathExists(cwd0)).toBe(true);
    expect(await pathExists(cwd1)).toBe(true);

    // Simulate a third agent's acquire failing (same technique as the
    // existing "throws when acquisition fails" test: point a fresh
    // provider — sharing the same runId — at a non-git-repo source so
    // setupWorktrees hits the "not a git repository" error path and its
    // internal cleanupSession(sessionId) fires for THAT agent's own
    // session only).
    const notRepo = await mkdtemp(join(tmpdir(), 'wf-not-repo-'));
    const failingProvider = new GitWorktreeProvider(notRepo, base);
    await expect(failingProvider.acquire(runId, 2)).rejects.toThrow();

    // Agents 0 and 1's worktrees must still be intact — the failure in
    // agent 2's own session must not have cascaded to siblings sharing
    // the same runId.
    expect(await pathExists(cwd0)).toBe(true);
    expect(await pathExists(cwd1)).toBe(true);

    await provider.cleanup(runId);
  });

  it('removes an unchanged worktree on cleanup', async () => {
    const repo = await tmpGitRepo();
    const base = await mkdtemp(join(tmpdir(), 'wf-wt-base-'));
    const provider = new GitWorktreeProvider(repo, base);
    const runId = 'run-unchanged';

    const cwd = await provider.acquire(runId, 0);
    expect(await pathExists(cwd)).toBe(true);

    await provider.cleanup(runId);

    expect(await pathExists(cwd)).toBe(false);
  });

  it('preserves a changed worktree on cleanup', async () => {
    const repo = await tmpGitRepo();
    const base = await mkdtemp(join(tmpdir(), 'wf-wt-base-'));
    const provider = new GitWorktreeProvider(repo, base);
    const runId = 'run-changed';

    const cwd = await provider.acquire(runId, 0);
    await writeFile(join(cwd, 'agent-work.txt'), 'agent made a change\n');

    await provider.cleanup(runId);

    // Changed worktree must be left in place, not force-removed.
    expect(await pathExists(cwd)).toBe(true);
    expect(await pathExists(join(cwd, 'agent-work.txt'))).toBe(true);
  });
});

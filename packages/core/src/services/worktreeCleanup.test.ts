/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  worktreeHasWork,
  writeWorktreeSessionMarker,
} from './gitWorktreeService.js';
import {
  cleanupStaleAgentWorktrees,
  STALE_WORKTREE_CUTOFF_MS,
  __test__,
} from './worktreeCleanup.js';

const { isEphemeralSlug } = __test__;

describe('isEphemeralSlug', () => {
  it('matches the agent-<7hex> pattern', () => {
    expect(isEphemeralSlug('agent-aabbccd')).toBe(true);
    expect(isEphemeralSlug('agent-0000000')).toBe(true);
    expect(isEphemeralSlug('agent-abcdef0')).toBe(true);
  });

  it('rejects non-matching shapes', () => {
    expect(isEphemeralSlug('agent-')).toBe(false);
    expect(isEphemeralSlug('agent-toolong0')).toBe(false);
    expect(isEphemeralSlug('agent-abcdefg')).toBe(false); // g is not hex
    expect(isEphemeralSlug('AGENT-aabbccd')).toBe(false); // uppercase
    expect(isEphemeralSlug('my-feature')).toBe(false);
    expect(isEphemeralSlug('')).toBe(false);
  });

  it('does not sweep user-named worktrees that share the prefix', () => {
    expect(isEphemeralSlug('agent-feature')).toBe(false);
    expect(isEphemeralSlug('agentic')).toBe(false);
    expect(isEphemeralSlug('my-agent-aabbccd')).toBe(false);
  });
});

/**
 * Acceptance coverage for #12758 against the real sweep: a stale agent
 * worktree whose only content is git-ignored must survive, while one
 * holding only disposable build output (or only the daemon's session
 * marker) must stay reaping. Real git fixture — the defect lives in the
 * exact `git status` argv the sweep runs, which a mocked status cannot
 * see.
 */
describe('cleanupStaleAgentWorktrees', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  // Repo sits one level down so the worktrees dir and any siblings stay
  // inside a per-test parent that afterEach can remove wholesale.
  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-cleanup-'));
    // realpath so path comparisons line up with GitWorktreeService on
    // platforms where the temp dir is a symlink (macOS /var).
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    // Name the initial branch without `git init -b` (git < 2.28 lacks it).
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: repoRoot,
    });
    execFileSync('git', ['config', 'user.email', 't@e.com'], {
      cwd: repoRoot,
    });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoRoot,
    });
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      'secret.env\nnode_modules/\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repoRoot,
    });
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  async function createAgentWorktree(slug: string): Promise<string> {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main');
    expect(result.success).toBe(true);
    return result.worktree!.path;
  }

  // The sweep reads the worktree dir's mtime; writing files inside it
  // refreshes that mtime, so age the directory only after all writes.
  async function agePastCutoff(worktreePath: string): Promise<void> {
    const aged = new Date(
      Date.now() - STALE_WORKTREE_CUTOFF_MS - 24 * 60 * 60 * 1000,
    );
    await fs.utimes(worktreePath, aged, aged);
  }

  it('preserves a stale worktree whose only content is git-ignored (#12758)', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.writeFile(path.join(wtPath, 'secret.env'), 'AWS_KEY=x\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'secret.env')),
    ).resolves.toBeUndefined();
  });

  it('still reaps a stale worktree holding only disposable build output', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'node_modules', 'x'), {
      recursive: true,
    });
    await fs.writeFile(path.join(wtPath, 'node_modules', 'x', 'i.js'), '//\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(fs.access(wtPath)).rejects.toThrow();
  });

  it('still reaps a stale worktree holding only a session marker', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await writeWorktreeSessionMarker(wtPath, 'session-1');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
  });
});

describe('worktreeHasWork', () => {
  it('fails closed on a path git cannot read as a worktree', async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-haswork-')),
    );
    try {
      await expect(worktreeHasWork(dir)).resolves.toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

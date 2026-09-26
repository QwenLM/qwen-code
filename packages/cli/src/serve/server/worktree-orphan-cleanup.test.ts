/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Delegation coverage for `executeWorktreeCleanup`'s has-work gate
 * (#12758): the daemon reaper must consult the shared core predicate
 * (`worktreeHasWork`), so a checkout whose only content is git-ignored
 * is preserved while one holding only disposable build output stays
 * reaping. Real git fixture — the behavior under test is the exact
 * status argv, which a mocked stand-in cannot see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  writeWorktreeSessionMarker,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import {
  executeWorktreeCleanup,
  type WorktreeCleanupPlan,
} from './worktree-orphan-cleanup.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('executeWorktreeCleanup — has-work gate (#12758)', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  // Repo sits one level down so afterEach removes the worktrees dir and
  // any siblings wholesale.
  let repoParent: string;
  let repoRoot: string;

  beforeEach(() => {
    repoParent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-orphan-cleanup-')),
    );
    repoRoot = path.join(repoParent, 'repo');
    fs.mkdirSync(repoRoot);
    git(repoRoot, 'init', '-q');
    // Name the initial branch without `git init -b` (git < 2.28 lacks it).
    git(repoRoot, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(repoRoot, 'config', 'user.email', 't@e.com');
    git(repoRoot, 'config', 'user.name', 't');
    git(repoRoot, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(
      path.join(repoRoot, '.gitignore'),
      'secret.env\nnode_modules/\n',
    );
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'init', '--no-verify');
  });

  afterEach(() => {
    fs.rmSync(repoParent, { recursive: true, force: true });
  });

  async function planFor(slug: string): Promise<WorktreeCleanupPlan> {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main');
    expect(result.success).toBe(true);
    const worktreePath = fs.realpathSync(result.worktree!.path);
    const sessionId = `session-${slug}`;
    await writeWorktreeSessionMarker(worktreePath, sessionId);
    const sidecar: WorktreeSession = {
      slug,
      worktreePath,
      worktreeBranch: result.worktree!.branch,
      originalCwd: repoRoot,
      originalBranch: 'main',
      originalHeadCommit: '',
    };
    return {
      sessionId,
      sidecar,
      sidecarPath: path.join(repoParent, `${sessionId}.worktree.json`),
      lockKey: worktreePath,
    };
  }

  it('preserves a checkout whose only content is git-ignored', async () => {
    const plan = await planFor('agent-aabbccd');
    fs.writeFileSync(path.join(plan.lockKey, 'secret.env'), 'AWS_KEY=x\n');

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(path.join(plan.lockKey, 'secret.env'))).toBe(true);
  });

  it('still removes a checkout holding only disposable build output', async () => {
    const plan = await planFor('agent-aabbccd');
    fs.mkdirSync(path.join(plan.lockKey, 'node_modules', 'x'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(plan.lockKey, 'node_modules', 'x', 'i.js'),
      '//\n',
    );

    await executeWorktreeCleanup(plan);

    expect(fs.existsSync(plan.lockKey)).toBe(false);
  });
});

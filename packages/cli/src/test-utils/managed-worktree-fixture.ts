/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkspaceRuntime } from '../serve/workspace-registry.js';
import { createWorkspaceRuntimeSessionService } from '../serve/workspace-runtime-storage.js';

export function setupManagedWorktreeFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-cwd-'));
  const runtimeBase = fs.mkdtempSync(
    path.join(os.tmpdir(), 'managed-git-runtime-'),
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  execFileSync(
    'git',
    ['config', 'core.hooksPath', path.join(runtimeBase, 'empty-hooks')],
    { cwd: repo },
  );
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  return { repo, runtimeBase };
}

export function createManagedWorktreeSession(
  repo: string,
  runtimeBase: string,
  sessionId: string,
) {
  const worktree = path.join(repo, '.qwen', 'worktrees', 'branch-a');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'worktree-branch-a', worktree, 'HEAD'],
    { cwd: repo },
  );
  fs.writeFileSync(path.join(worktree, '.qwen-session'), sessionId);
  const runtime = {
    workspaceId: 'primary',
    workspaceCwd: repo,
    sessionRuntimeBaseDir: runtimeBase,
    primary: true,
    trusted: true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionExecutionSnapshot: () => ({
        workspaceCwd: repo,
        effectiveCwd: worktree,
        worktree: {
          slug: 'branch-a',
          path: worktree,
          branch: 'worktree-branch-a',
        },
      }),
    },
  } as unknown as WorkspaceRuntime;
  const sidecarPath =
    createWorkspaceRuntimeSessionService(runtime).getWorktreeSessionPath(
      sessionId,
    );
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify({
      slug: 'branch-a',
      worktreePath: worktree,
      worktreeBranch: 'worktree-branch-a',
      originalCwd: repo,
      originalBranch: 'main',
      originalHeadCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
    }),
  );
  return { worktree, runtime, sidecarPath };
}

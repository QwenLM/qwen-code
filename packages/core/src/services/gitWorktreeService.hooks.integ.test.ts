/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `GitWorktreeService.configureHooksPath()`. Uses real
 * git invocations against a temp repo because the existing
 * `gitWorktreeService.test.ts` mocks simple-git heavily, making it
 * unsuitable for verifying actual `git config` side effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  LEGACY_WORKTREES_GITIGNORE_BODY,
  WORKTREES_GITIGNORE_BODY,
} from './gitWorktreeService.js';

// Real git invocations + user-global hooks (e.g. trustup) can take
// 10–20s per setUp on slower runners; bump per-test and per-hook
// timeouts so the suite isn't flaky on CI. (Phase C reviewer #4174.)
describe('GitWorktreeService.createUserWorktree() — hooksPath setup', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-hooks-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoRoot,
    });
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repoRoot,
    });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  function readWorktreeConfig(worktreePath: string, key: string): string {
    try {
      return execFileSync('git', ['config', '--local', key], {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }

  it('points core.hooksPath at .husky when present', async () => {
    const huskyDir = path.join(repoRoot, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(path.join(huskyDir, 'pre-commit'), '#!/bin/sh\n', {
      mode: 0o755,
    });

    const svc = new GitWorktreeService(repoRoot);
    const result = await svc.createUserWorktree('husky-test');
    expect(result.success).toBe(true);

    const hooksPath = readWorktreeConfig(
      result.worktree!.path,
      'core.hooksPath',
    );
    expect(hooksPath).toBe(huskyDir);
  });

  it('falls back to .git/hooks when .husky is missing', async () => {
    const svc = new GitWorktreeService(repoRoot);
    const result = await svc.createUserWorktree('hooks-fallback');
    expect(result.success).toBe(true);

    const hooksPath = readWorktreeConfig(
      result.worktree!.path,
      'core.hooksPath',
    );
    // .git/hooks always exists after `git init`, so this branch always wins
    // when no .husky/ directory is provisioned.
    expect(hooksPath).toBe(path.join(repoRoot, '.git', 'hooks'));
  });

  it('still creates the worktree even when hooksPath setup fails', async () => {
    // Sanity: pass a non-existent base for husky and git/hooks (impossible
    // in practice since `git init` always provisions .git/hooks, but
    // exercise the error-tolerance path explicitly).
    const svc = new GitWorktreeService(repoRoot);
    const result = await svc.createUserWorktree('always-creates');
    expect(result.success).toBe(true);
    expect(result.worktree).toBeDefined();
  });

  // Provisioning writes `.qwen/.gitignore`. If that file does not ignore
  // itself, writing it is what turns a clean parent dirty, and every caller
  // that fail-closes on a dirty parent then refuses every provision after the
  // first — blaming uncommitted changes the user never made. Serialised
  // provisioning makes that ordering deterministic, so this is the witness
  // for the whole class.
  it('leaves the parent working tree clean, so a second provision is not refused', async () => {
    const svc = new GitWorktreeService(repoRoot);
    expect(await svc.hasWorktreeChanges(repoRoot)).toBe(false);

    const first = await svc.createUserWorktree('gitignore-first');
    expect(first.success).toBe(true);
    expect(
      await fs.readFile(path.join(repoRoot, '.qwen', '.gitignore'), 'utf8'),
    ).toContain('/.gitignore');

    // The assertion that matters: still clean AFTER the tool wrote its own
    // file, so the fail-closed dirty-parent gate lets the next one through.
    expect(await svc.hasWorktreeChanges(repoRoot)).toBe(false);
    const second = await svc.createUserWorktree('gitignore-second');
    expect(second.success).toBe(true);
  });

  // Existing checkouts carry the pre-fix body. Upgrade it in place on the
  // next provision — but only when it is byte-identical to what this code
  // wrote, so a file the user has touched is never rewritten.
  it('upgrades its own legacy gitignore but leaves a user-edited one alone', async () => {
    const qwenDir = path.join(repoRoot, '.qwen');
    await fs.mkdir(qwenDir, { recursive: true });
    const gitignorePath = path.join(qwenDir, '.gitignore');
    await fs.writeFile(gitignorePath, LEGACY_WORKTREES_GITIGNORE_BODY);

    const svc = new GitWorktreeService(repoRoot);
    expect((await svc.createUserWorktree('legacy-upgrade')).success).toBe(true);
    expect(await fs.readFile(gitignorePath, 'utf8')).toBe(
      WORKTREES_GITIGNORE_BODY,
    );
    expect(await svc.hasWorktreeChanges(repoRoot)).toBe(false);

    const curated = `${LEGACY_WORKTREES_GITIGNORE_BODY}# mine\nnotes.md\n`;
    await fs.writeFile(gitignorePath, curated);
    expect((await svc.createUserWorktree('curated-untouched')).success).toBe(
      true,
    );
    expect(await fs.readFile(gitignorePath, 'utf8')).toBe(curated);
  });
});

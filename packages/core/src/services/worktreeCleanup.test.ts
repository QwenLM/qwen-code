/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitWorktreeService } from './gitWorktreeService.js';
import { cleanupStaleAgentWorktrees, __test__ } from './worktreeCleanup.js';

const { isEphemeralSlug } = __test__;

const cleanupLogger = vi.hoisted(() => ({
  isEnabled: () => true,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Intercept only the sweep's own tag; every other module in this file's import
// graph (gitWorktreeService, storage, telemetry) keeps the real logger.
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (tag?: string) =>
      tag === 'WORKTREE_CLEANUP'
        ? cleanupLogger
        : actual.createDebugLogger(tag),
  };
});

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

// Real-git integration: the sweep's guards only mean anything when they run
// against an actual worktree on disk. Mirrors the sibling
// gitWorktreeService.*.integ.test.ts setup (30s ceilings for slow runners).
describe('cleanupStaleAgentWorktrees (real git)', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function initRepo(): string {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cleanup-')),
    );
    tmpDirs.push(repo);
    // git < 2.28 has no `init -b`; point HEAD at main via symbolic-ref.
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: repo,
    });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repo,
    });
    return repo;
  }

  /** Age the worktree root dir past the 30-day sweep cutoff. */
  function ageBeyondCutoff(worktreePath: string): void {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(worktreePath, old, old);
  }

  it('preserves a user-named `agent-<7hex>` worktree holding only untracked files (#12735)', async () => {
    const repo = initRepo();
    const service = new GitWorktreeService(repo);
    // `validateUserWorktreeSlug` deliberately lets the exact ephemeral
    // shape through so AgentTool isolation can share this code path — a
    // user may still pick it explicitly, and the sweep cannot tell such a
    // worktree apart from an agent one by name.
    const created = await service.createUserWorktree('agent-aabbccd');
    expect(created.success).toBe(true);
    const wtPath = service.getUserWorktreePath('agent-aabbccd');
    // Pin the untracked mode against ambient config. `normal` is git's
    // default, so without this a later refactor that drops the explicit
    // `--untracked-files=normal` from the probe would keep every test green
    // while a user's `status.showUntrackedFiles=no` (in `~/.gitconfig`, or in
    // the repo's `.git/config`, which every linked worktree shares) hides the
    // sentinel and #12735 returns silently. Same pin the exit-tool probes have
    // in git-config-exec.canary.test.ts.
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: repo,
    });
    fs.writeFileSync(path.join(wtPath, 'sentinel.txt'), 'user work\n');
    ageBeyondCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repo);

    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(wtPath, 'sentinel.txt'))).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it('logs a debug breadcrumb naming the entry it deliberately kept', async () => {
    const repo = initRepo();
    const service = new GitWorktreeService(repo);
    const created = await service.createUserWorktree('agent-aabbccd');
    expect(created.success).toBe(true);
    const wtPath = service.getUserWorktreePath('agent-aabbccd');
    fs.writeFileSync(path.join(wtPath, 'sentinel.txt'), 'user work\n');
    ageBeyondCutoff(wtPath);
    cleanupLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repo);

    expect(removed).toBe(0);
    // The caller logs "nothing to remove" when the sweep returns 0, so a
    // preserved entry that leaves no line of its own cannot be told apart from
    // one the sweep never saw.
    expect(cleanupLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('keeping agent-aabbccd'),
    );
  });

  it('still sweeps a clean, commit-free ephemeral worktree past the cutoff', async () => {
    const repo = initRepo();
    const service = new GitWorktreeService(repo);
    const created = await service.createUserWorktree('agent-1234567');
    expect(created.success).toBe(true);
    const wtPath = service.getUserWorktreePath('agent-1234567');
    ageBeyondCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repo);

    expect(removed).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

describe('hasUncommittedChanges', () => {
  it('fail-closes to dirty when git state cannot be read', async () => {
    // A directory that is not a git repository makes `git status` exit 128.
    // This catch is the only thing between an unreadable worktree (pruned or
    // corrupt admin dir, EACCES, unmounted volume) and
    // `git worktree remove --force` plus the `fs.rm(recursive, force)`
    // fallback, and it is the contract the sweep's docstring states: "Any
    // error reading git status / log → skip the entry (don't delete)."
    const notARepo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-not-a-repo-')),
    );
    try {
      await expect(__test__.hasUncommittedChanges(notARepo)).resolves.toBe(
        true,
      );
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

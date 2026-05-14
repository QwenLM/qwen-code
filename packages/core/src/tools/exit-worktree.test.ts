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
import { ExitWorktreeTool } from './exit-worktree.js';
import { EnterWorktreeTool } from './enter-worktree.js';
import type { Config } from '../config/config.js';
import {
  GitWorktreeService,
  WORKTREE_SESSION_FILE,
  worktreeBranchForSlug,
  writeWorktreeSessionMarker,
} from '../services/gitWorktreeService.js';

function makeMockConfig(targetDir = process.cwd()): Config {
  // Default to cwd because `GitWorktreeService` constructs `simpleGit`
  // against the dir, which fails on a non-existent path. Tests that
  // need a real isolated repo create their own temp dir and pass it
  // explicitly.
  return {
    getTargetDir: vi.fn(() => targetDir),
    getSessionId: vi.fn(() => 'mock-session-id'),
  } as unknown as Config;
}

describe('ExitWorktreeTool', () => {
  describe('metadata', () => {
    it('exposes the correct tool name', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(tool.name).toBe('exit_worktree');
      expect(tool.displayName).toBe('ExitWorktree');
    });
  });

  describe('validateToolParams', () => {
    it('requires a non-empty name', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(tool.validateToolParams({ name: '', action: 'keep' })).toMatch(
        /non-empty/i,
      );
    });

    it('requires action to be keep or remove', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(
        tool.validateToolParams({
          name: 'foo',
          action: 'destroy' as 'keep' | 'remove',
        }),
      ).toMatch(/keep.*remove/i);
      expect(
        tool.validateToolParams({ name: 'foo', action: 'keep' }),
      ).toBeNull();
      expect(
        tool.validateToolParams({ name: 'foo', action: 'remove' }),
      ).toBeNull();
    });

    it('rejects slugs that would resolve outside the worktrees dir', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(
        tool.validateToolParams({ name: 'a/b', action: 'remove' }),
      ).not.toBeNull();
      expect(
        tool.validateToolParams({ name: '../etc', action: 'remove' }),
      ).not.toBeNull();
    });

    it('rejects discard_changes when it is not a boolean', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(
        tool.validateToolParams({
          name: 'foo',
          action: 'remove',
          // @ts-expect-error: deliberately wrong type
          discard_changes: 'yes',
        }),
      ).toMatch(/boolean/i);
    });
  });

  describe('default permission', () => {
    it("returns 'ask' when action is 'remove'", async () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const inv = tool.build({ name: 'foo', action: 'remove' });
      expect(await inv.getDefaultPermission()).toBe('ask');
    });

    it("returns 'allow' when action is 'keep'", async () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const inv = tool.build({ name: 'foo', action: 'keep' });
      expect(await inv.getDefaultPermission()).toBe('allow');
    });
  });

  describe('confirmation type — round-7 AUTO_EDIT bypass guard', () => {
    // Regression guard for the round-7 finding: `getDefaultPermission`
    // returning 'ask' was insufficient because BaseToolInvocation's
    // default `getConfirmationDetails` returned `type: 'info'`, which
    // `permissionFlow.isAutoEditApproved(AUTO_EDIT, 'info')` silently
    // approves. The override must return `type: 'exec'` for action=remove.
    it("returns type 'exec' for action=remove (NOT auto-approved by AUTO_EDIT)", async () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const inv = tool.build({ name: 'foo', action: 'remove' });
      const details = await inv.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('exec');
      // Also verify the command field is populated, so the prompt UI
      // shows the user what would actually run.
      if (details.type === 'exec') {
        expect(details.command).toContain('git worktree remove');
        expect(details.command).toContain('git branch -d worktree-foo');
      }
    });

    it("returns the base 'info' type for action=keep (non-destructive)", async () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const inv = tool.build({ name: 'foo', action: 'keep' });
      const details = await inv.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(details.type).toBe('info');
    });
  });

  describe('getDescription', () => {
    it('mentions remove vs keep', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const remove = tool.build({ name: 'foo', action: 'remove' });
      expect(remove.getDescription()).toMatch(/remove/i);
      const keep = tool.build({ name: 'foo', action: 'keep' });
      expect(keep.getDescription()).toMatch(/keep/i);
    });
  });

  // ── execute() integration: real git repo, real worktree ──────
  // These tests provision a temp git repo so we exercise the
  // session-ownership guard, the keep path, and the missing-marker
  // fallback against the actual implementation rather than mocking
  // every git call.
  describe('execute() — session ownership & lifecycle', () => {
    let repoRoot: string;

    beforeEach(async () => {
      repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-exit-wt-'));
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.email', 't@e.com'], {
        cwd: repoRoot,
      });
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

    async function provisionWorktree(slug: string): Promise<string> {
      // Use EnterWorktreeTool to create a real worktree so the test
      // exercises the same code path users hit.
      const enterCfg = {
        getTargetDir: () => repoRoot,
        getSessionId: () => 'session-creator',
      } as unknown as Config;
      const enter = new EnterWorktreeTool(enterCfg);
      const inv = enter.build({ name: slug });
      const result = await inv.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      return new GitWorktreeService(repoRoot).getUserWorktreePath(slug);
    }

    it('refuses remove when the marker names a different session', async () => {
      const wtPath = await provisionWorktree('owned-by-creator');
      // Verify the marker landed.
      const marker = await fs.readFile(
        path.join(wtPath, WORKTREE_SESSION_FILE),
        'utf8',
      );
      expect(marker.trim()).toBe('session-creator');

      const otherCfg = {
        getTargetDir: () => repoRoot,
        getSessionId: () => 'session-stranger',
      } as unknown as Config;
      const exit = new ExitWorktreeTool(otherCfg);
      const result = await exit
        .build({ name: 'owned-by-creator', action: 'remove' })
        .execute(new AbortController().signal);
      expect(result.error?.message).toMatch(
        /different session.*owner=session-creator/i,
      );
      // Worktree must still be on disk.
      await expect(fs.access(wtPath)).resolves.toBeUndefined();
    });

    it('keep returns success and leaves the worktree + branch intact', async () => {
      const wtPath = await provisionWorktree('keepme');
      const cfg = {
        getTargetDir: () => repoRoot,
        getSessionId: () => 'session-creator',
      } as unknown as Config;
      const exit = new ExitWorktreeTool(cfg);
      const result = await exit
        .build({ name: 'keepme', action: 'keep' })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      await expect(fs.access(wtPath)).resolves.toBeUndefined();
      const branches = execFileSync('git', ['branch', '--list'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(branches).toContain(worktreeBranchForSlug('keepme'));
    });

    it('allows removal when the worktree predates the session-marker guard', async () => {
      // Manually create a worktree without writing the marker — this
      // is the upgrade path. The tool should warn-log and proceed.
      const svc = new GitWorktreeService(repoRoot);
      const created = await svc.createUserWorktree('legacy');
      expect(created.success).toBe(true);
      // Explicitly DO NOT call writeWorktreeSessionMarker.
      const wtPath = svc.getUserWorktreePath('legacy');
      await expect(
        fs.access(path.join(wtPath, WORKTREE_SESSION_FILE)),
      ).rejects.toBeDefined();

      const cfg = {
        getTargetDir: () => repoRoot,
        getSessionId: () => 'session-stranger',
      } as unknown as Config;
      const result = await new ExitWorktreeTool(cfg)
        .build({ name: 'legacy', action: 'remove' })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      await expect(fs.access(wtPath)).rejects.toBeDefined();
    });

    it('returns an error result when the worktree directory is missing', async () => {
      const cfg = {
        getTargetDir: () => repoRoot,
        getSessionId: () => 'session-creator',
      } as unknown as Config;
      const result = await new ExitWorktreeTool(cfg)
        .build({ name: 'nonexistent', action: 'remove' })
        .execute(new AbortController().signal);
      expect(result.error?.message).toMatch(/not found/i);
    });

    it('refuses removal when the worktree branch has unmerged commits', async () => {
      const wtPath = await provisionWorktree('committed');
      // Commit a change inside the worktree so it has work no other
      // ref points at.
      await fs.writeFile(path.join(wtPath, 'new.txt'), 'work\n');
      execFileSync('git', ['add', '.'], { cwd: wtPath });
      execFileSync('git', ['commit', '-q', '-m', 'work', '--no-verify'], {
        cwd: wtPath,
      });
      const cfg = {
        getTargetDir: () => repoRoot,
        getSessionId: () => 'session-creator',
      } as unknown as Config;
      const result = await new ExitWorktreeTool(cfg)
        .build({
          name: 'committed',
          action: 'remove',
          discard_changes: true,
        })
        .execute(new AbortController().signal);
      expect(result.error?.message).toMatch(/unmerged|no other branch/i);
      // Both worktree and branch must still be present.
      await expect(fs.access(wtPath)).resolves.toBeUndefined();
    });

    it('marker also written by writeWorktreeSessionMarker survives round-trip', async () => {
      // Direct service-level write, then read via the same helper —
      // covers the exclude-rule path (which is best-effort and may
      // not fire in unusual test layouts).
      const wtPath = await provisionWorktree('roundtrip');
      await writeWorktreeSessionMarker(wtPath, 'rewritten-id');
      const re = await fs.readFile(
        path.join(wtPath, WORKTREE_SESSION_FILE),
        'utf8',
      );
      expect(re.trim()).toBe('rewritten-id');
    });
  });
});

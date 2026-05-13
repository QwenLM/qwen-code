/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  AGENT_WORKTREE_SLUG_PATTERN,
  GitWorktreeService,
  worktreeBranchForSlug,
} from './gitWorktreeService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKTREE_CLEANUP');

/**
 * Slug patterns for throwaway worktrees we are willing to auto-clean.
 *
 * Currently only the `agent-<7hex>` shape produced by
 * `AgentTool isolation:'worktree'` qualifies. User-named worktrees created
 * via `EnterWorktreeTool` are NEVER swept — they are managed manually via
 * `ExitWorktreeTool`, and `validateUserWorktreeSlug` reserves the
 * `agent-` prefix so a user-named slug can never accidentally match
 * here.
 *
 * Mirrors claude-code's `EPHEMERAL_WORKTREE_PATTERNS` in
 * `utils/worktree.ts`, restricted to the patterns qwen-code actually emits.
 */
const EPHEMERAL_WORKTREE_PATTERNS: readonly RegExp[] = [
  AGENT_WORKTREE_SLUG_PATTERN,
];

/**
 * Default age threshold for stale ephemeral worktree cleanup (30 days).
 * Matches claude-code's threshold so the on-disk hygiene story is the same.
 */
export const STALE_WORKTREE_CUTOFF_MS = 30 * 24 * 60 * 60 * 1000;

function isEphemeralSlug(slug: string): boolean {
  return EPHEMERAL_WORKTREE_PATTERNS.some((re) => re.test(slug));
}

/**
 * Removes stale ephemeral worktrees under `<projectRoot>/.qwen/worktrees/`.
 *
 * Safety guarantees (fail-closed):
 * - Only touches slugs matching {@link EPHEMERAL_WORKTREE_PATTERNS}.
 * - Skips entries newer than {@link STALE_WORKTREE_CUTOFF_MS} (default 30 days).
 * - Skips entries with any uncommitted tracked changes.
 * - Skips entries with commits not reachable from the upstream remote.
 * - Any error reading git status / log → skip the entry (don't delete).
 *
 * Returns the number of worktrees actually removed.
 */
export async function cleanupStaleAgentWorktrees(
  projectRoot: string,
  options: { cutoffMs?: number } = {},
): Promise<number> {
  const cutoffMs = options.cutoffMs ?? STALE_WORKTREE_CUTOFF_MS;
  const cutoffDate = Date.now() - cutoffMs;

  const service = new GitWorktreeService(projectRoot);
  const worktreesDir = service.getUserWorktreesDir();

  // Fast bail-out for the common case (user has never used worktrees):
  // skip the dynamic readdir entirely instead of relying on the catch
  // path's ENOENT handler, which preserves the original stack on any
  // other I/O error.
  try {
    await fs.access(worktreesDir);
  } catch {
    return 0;
  }

  let entries;
  try {
    entries = await fs.readdir(worktreesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    debugLogger.warn(`Failed to read ${worktreesDir}: ${error}`);
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isEphemeralSlug(entry.name)) continue;

    const worktreePath = path.join(worktreesDir, entry.name);

    let mtimeMs: number;
    try {
      const stats = await fs.stat(worktreePath);
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoffDate) continue;

    // Fail-closed: any sign of in-progress work or unmerged commits → keep.
    // Run both checks concurrently — neither depends on the other and each
    // spawns its own git invocation.
    const [dirty, unmerged] = await Promise.all([
      hasTrackedChanges(worktreePath),
      service.hasUnmergedWorktreeCommits(entry.name),
    ]);
    if (dirty || unmerged) continue;

    const result = await service.removeUserWorktree(entry.name, {
      deleteBranch: true,
    });
    if (!result.success) {
      debugLogger.warn(
        `Failed to remove stale agent worktree ${worktreePath}: ${result.error}`,
      );
      continue;
    }
    if (result.branchPreserved) {
      // Race: commits landed between hasUnmergedWorktreeCommits and
      // git branch -d. The directory is gone but the branch remains so
      // those commits can still be recovered. Surface it so an operator
      // grepping logs can spot orphan branches.
      debugLogger.warn(
        `Removed stale agent worktree ${worktreePath} but kept branch ` +
          `${worktreeBranchForSlug(entry.name)} (unmerged commits at delete time)`,
      );
    } else {
      debugLogger.debug(`Removed stale agent worktree ${worktreePath}`);
    }
    removed += 1;
  }

  if (removed > 0) {
    debugLogger.debug(
      `cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`,
    );
  }
  return removed;
}

async function hasTrackedChanges(worktreePath: string): Promise<boolean> {
  try {
    const wtGit = simpleGit(worktreePath);
    const status = await wtGit.status();
    // Skip the untracked-files scan: untracked files in a long-dead agent
    // worktree are typically build artifacts, not user work — and listing
    // them is the slowest part of `git status` on large repos. Tracked
    // changes (staged, modified, deleted, renamed, created) are the signal
    // that work is in progress.
    return (
      status.staged.length > 0 ||
      status.modified.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0 ||
      status.created.length > 0
    );
  } catch (error) {
    // Fail-closed (assume dirty so the worktree is preserved) but log
    // so the operator can distinguish "has real changes — leave alone"
    // from "git index is unreadable — repo may be corrupt". Without
    // this, a permission error or unmounted filesystem would silently
    // keep the worktree forever with no breadcrumb.
    debugLogger.warn(
      `hasTrackedChanges: cannot inspect ${worktreePath} — assuming dirty: ${error}`,
    );
    return true;
  }
}

export const __test__ = { isEphemeralSlug };

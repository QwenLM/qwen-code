/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorktreeService } from './gitWorktreeService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKTREE_CLEANUP');

/**
 * Slug patterns for throwaway worktrees we are willing to auto-clean.
 *
 * Currently only the `agent-<7hex>` shape produced by
 * `AgentTool isolation:'worktree'` qualifies. User-named worktrees created
 * via `EnterWorktreeTool` are NEVER swept — they are managed manually via
 * `ExitWorktreeTool` and would surprise the user if removed under them.
 *
 * Mirrors claude-code's `EPHEMERAL_WORKTREE_PATTERNS` in
 * `utils/worktree.ts`, restricted to the patterns qwen-code actually emits.
 */
const EPHEMERAL_WORKTREE_PATTERNS: readonly RegExp[] = [/^agent-[0-9a-f]{7}$/];

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

    // Fail-closed: any sign of in-progress work or unpushed commits → keep.
    if (await hasTrackedChanges(worktreePath)) continue;
    if (await hasUnpushedCommits(worktreePath)) continue;

    const result = await service.removeUserWorktree(entry.name, {
      deleteBranch: true,
    });
    if (result.success) {
      removed += 1;
      debugLogger.debug(`Removed stale agent worktree ${worktreePath}`);
    } else {
      debugLogger.warn(
        `Failed to remove stale agent worktree ${worktreePath}: ${result.error}`,
      );
    }
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
  } catch {
    return true;
  }
}

async function hasUnpushedCommits(worktreePath: string): Promise<boolean> {
  try {
    const wtGit = simpleGit(worktreePath);
    // Empty output → all commits have a remote ref above them.
    // Non-empty output → at least one commit not reachable from any remote.
    const out = await wtGit.raw([
      'log',
      '--branches',
      '--not',
      '--remotes',
      '--oneline',
    ]);
    return out.trim().length > 0;
  } catch {
    return true;
  }
}

export const __test__ = { isEphemeralSlug };

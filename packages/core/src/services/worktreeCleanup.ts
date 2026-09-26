/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  AGENT_WORKTREE_SLUG_PATTERN,
  GitWorktreeService,
  worktreeBranchForSlug,
  worktreeHasWork,
} from './gitWorktreeService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKTREE_CLEANUP');

/**
 * Slug patterns for throwaway worktrees we are willing to auto-clean.
 *
 * Currently only the `agent-<7hex>` shape produced by
 * `AgentTool isolation:'worktree'` qualifies. User-named worktrees created
 * via `EnterWorktreeTool` are managed manually via `ExitWorktreeTool`, and
 * `validateUserWorktreeSlug` reserves the `agent-` prefix — except for the
 * exact `agent-<7hex>` shape, which is allowed through so `AgentTool`
 * isolation can share the same `createUserWorktree` path. A user can
 * therefore still pick that exact shape explicitly, and on disk such a
 * worktree is indistinguishable from an ephemeral agent one (no marker
 * records which path created it). That is why the dirty check below must
 * treat ANY content — including untracked files — as a reason to keep the
 * worktree: name-shape matching alone cannot protect a user-named
 * `agent-<7hex>` worktree from being swept (issue #12735).
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
 * - Skips entries with any uncommitted work — tracked, untracked, or
 *   git-ignored content — via the shared {@link worktreeHasWork}
 *   predicate the daemon reaper also uses (#12758); only disposable
 *   build output and the session marker stay exempt.
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
    } catch (error) {
      // Permission error / unmounted FS / EIO → skip this entry but
      // log so an operator can correlate accumulating disk usage with
      // the stat failure that prevents reaping. ENOENT is the only
      // truly silent case (the entry vanished between readdir and
      // stat) and is also benign.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugLogger.warn(
          `cleanupStaleAgentWorktrees: cannot stat ${worktreePath} — skipping: ${error}`,
        );
      }
      continue;
    }
    if (mtimeMs >= cutoffDate) continue;

    // Fail-closed: any sign of in-progress work or unmerged commits → keep.
    // Run both checks concurrently — neither depends on the other and each
    // spawns its own git invocation.
    const [dirty, unmerged] = await Promise.all([
      worktreeHasWork(worktreePath),
      service.hasUnmergedWorktreeCommits(entry.name),
    ]);
    if (dirty || unmerged) {
      // A deliberately preserved entry needs its own breadcrumb. The caller
      // logs "nothing to remove" at debug when the sweep returns 0, so
      // without this line an operator chasing growth under
      // `.qwen/worktrees/` cannot tell "the sweep never saw it" from "the
      // sweep saw it and refused" — and now that any untracked file
      // preserves an entry, refusing is a common outcome. Stays at `debug`
      // for the reason recorded at the call site in config.ts: `info` on
      // every CLI start that has any dirty worktree is log noise.
      debugLogger.debug(
        `cleanupStaleAgentWorktrees: keeping ${entry.name} (${
          dirty ? 'uncommitted changes' : 'unmerged commits'
        })`,
      );
      continue;
    }

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

export const __test__ = { isEphemeralSlug };

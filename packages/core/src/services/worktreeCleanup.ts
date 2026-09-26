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
} from './gitWorktreeService.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { loadSimpleGit } from '../utils/load-simple-git.js';

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
 * - Skips entries with any uncommitted changes, tracked or untracked.
 *   Ignore-rule-hidden content is not reported by the probe (no
 *   `--ignored`) and therefore does not preserve an entry; aligning this
 *   guard with the daemon reaper's is tracked in #12758.
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
      hasUncommittedChanges(worktreePath),
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

async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    // Require the path to be its own worktree before trusting any read.
    // `simpleGit(worktreePath)` pins no repository, so when this `.git` is
    // absent — an earlier sweep's `fs.rm` that threw partway, a restore that
    // dropped the link file — git discovers the ENCLOSING repo, which the
    // product gitignores for itself, and `status` succeeds with an answer
    // about the wrong tree. That answer is clean, and clean is what
    // authorises `git worktree remove --force`. A linked worktree's `.git`
    // is a file and a main checkout's a directory, so `fs.access` accepts
    // both and throws only for a path that is neither, leaving the catch
    // below to supply the dirty answer.
    await fs.access(path.join(worktreePath, '.git'));
    const { simpleGit } = await loadSimpleGit();
    const wtGit = simpleGit(worktreePath);
    // `git status --porcelain --untracked-files=normal` lists every
    // tracked change (staged, unstaged, conflicted — `UU` lines) AND
    // every untracked file not covered by an ignore rule. Untracked
    // files MUST be visible here: `validateUserWorktreeSlug` lets a
    // user claim the exact `agent-<7hex>` shape, so the sweep cannot
    // tell a user-named worktree from an ephemeral agent one by name —
    // and the removal path (`git worktree remove --force`) destroys
    // untracked files unrecoverably (issue #12735). This also matches
    // the dirty guard `exit_worktree action="remove"` has always
    // applied. What this probe does NOT see, stated so neither this
    // comment nor docs/users/features/worktree.md over-claims the
    // guarantee: `--ignored` is not passed, so content the repository's
    // ignore rules hide (a `.env`, `.qwen/pr-drafts/`) still does not
    // block the sweep — the sibling daemon reaper `checkoutHasWork`
    // (packages/cli/src/serve/server/worktree-orphan-cleanup.ts) counts
    // ignored entries as work minus `DISPOSABLE_IGNORED_ROOTS`, and
    // aligning the two guards on that one destructive sink is tracked in
    // #12758. A directory symlinked in by `worktree.symlinkDirectories`
    // also shows up here as `?? node_modules` when its ignore pattern
    // carries a trailing slash (git treats the link as a non-directory),
    // so that configuration pins the worktree. And the `.qwen-session`
    // marker stays invisible only while `writeWorktreeSessionMarker`'s
    // exclude rule sits in the common git dir — markers written before
    // #10643 put it in the per-worktree admin dir, which git does not
    // read. The untracked walk costs one extra scan per
    // already-stale candidate at startup; correctness wins over that
    // micro-optimisation. The previous `--untracked-files=no` form
    // made a worktree holding only untracked user files look "clean",
    // and the implementation before it manually enumerated
    // `status.staged/modified/...` which silently missed
    // `conflicted[]` (mutually exclusive with the others in
    // simple-git), so a worktree mid-merge looked "clean" too. Those two
    // drifts are why this probe names its siblings: a dirty-policy change
    // made only here leaves `GitWorktreeService.hasWorktreeChanges` and
    // `countWorktreeChanges` (`--untracked-files=all`, argv transport)
    // behind, and one made only there leaves this unattended sweep — the
    // path that runs `git worktree remove --force` at every CLI boot.
    const out = await wtGit.raw([
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    return out.trim().length > 0;
  } catch (error) {
    // Fail-closed (preserve worktree) and log so a permission error or
    // unmounted filesystem leaves a breadcrumb instead of being
    // indistinguishable from "has real changes".
    debugLogger.warn(
      `hasUncommittedChanges: cannot inspect ${worktreePath} — assuming dirty: ${error}`,
    );
    return true;
  }
}

export const __test__ = { isEphemeralSlug, hasUncommittedChanges };

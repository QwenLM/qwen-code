/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { GitWorktreeService } from '../services/gitWorktreeService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW_WORKTREE');

/** Acquires per-agent isolated working trees for `isolation: 'worktree'`. */
export interface WorktreeProvider {
  /** Returns the cwd path for one agent; throws on failure (never falls back). */
  acquire(runId: string, seq: number): Promise<string>;
  /** Remove the run's worktrees (auto-removes those left unchanged). */
  cleanup(runId: string): Promise<void>;
}

/**
 * Backs `isolation: 'worktree'` with the same `GitWorktreeService` ArenaManager
 * uses (design: "worktree.ts"). Acquisition failure ERRORS that agent (the
 * bridge maps it to a null result) — there is deliberately NO silent fallback
 * to the shared tree.
 *
 * Each agent gets its OWN `GitWorktreeService` session, keyed by
 * `${runId}:${seq}` rather than the shared `runId`. `setupWorktrees` calls
 * `cleanupSession(sessionId)` on a single-name failure, which force-removes
 * EVERY worktree registered under that sessionId — if all agents in a run
 * shared `runId` as their sessionId, one agent's failed acquire would
 * force-remove every sibling agent's in-progress worktree while they're
 * still mid-execution. Scoping each agent to its own session confines that
 * blast radius to just that agent.
 */
export class GitWorktreeProvider implements WorktreeProvider {
  private readonly service: GitWorktreeService;
  /** Per-agent sessionIds this provider has acquired, keyed by runId. */
  private readonly acquiredByRun = new Map<string, Set<string>>();

  constructor(
    private readonly sourceRepoPath: string,
    baseDir?: string,
  ) {
    this.service = new GitWorktreeService(sourceRepoPath, baseDir);
  }

  async acquire(runId: string, seq: number): Promise<string> {
    const name = `agent-${seq}`;
    // `sessionId` feeds into a git branch name inside GitWorktreeService
    // (`${base}-${sessionId.slice(0, 6)}-${sanitizedName}`), so it must stay
    // branch-name-safe — no `:` or other git-refname-illegal characters.
    const sessionId = `${runId}-agent${seq}`;
    const result = await this.service.setupWorktrees({
      sessionId,
      sourceRepoPath: this.sourceRepoPath,
      worktreeNames: [name],
    });
    const wt = result.worktreesByName[name];
    if (!wt) {
      const why = result.errors.map((e) => `${e.name}: ${e.error}`).join('; ');
      throw new Error(
        `worktree acquisition failed for ${name}: ${why || 'unknown'}`,
      );
    }
    // Track the per-agent sessionId so cleanup() can tear down every
    // agent's worktree at run end, even though each lives under its own
    // GitWorktreeService session rather than a shared `runId` session.
    let sessions = this.acquiredByRun.get(runId);
    if (!sessions) {
      sessions = new Set();
      this.acquiredByRun.set(runId, sessions);
    }
    sessions.add(sessionId);
    return wt.path;
  }

  async cleanup(runId: string): Promise<void> {
    const sessions = this.acquiredByRun.get(runId);
    if (!sessions) {
      return;
    }
    this.acquiredByRun.delete(runId);

    // Best-effort, per agent session: one agent's cleanup failure must not
    // stop the others from being torn down.
    for (const sessionId of sessions) {
      try {
        await this.cleanupOneSession(sessionId);
      } catch (error) {
        // Leave residue for manual cleanup rather than failing the run.
        debugLogger.warn(
          `cleanup: failed to clean up session ${sessionId} for run ${runId}: ${error}`,
        );
      }
    }
  }

  /**
   * Removes worktrees for a single agent session, but only those left
   * UNCHANGED (design: "auto-removes if unchanged"). A worktree containing
   * agent changes is left in place so the work isn't destroyed; the caller
   * (or a later manual pass) is responsible for retrieving/applying it.
   */
  private async cleanupOneSession(sessionId: string): Promise<void> {
    const worktrees = await this.service.listWorktrees(sessionId);
    let anyPreserved = false;

    for (const wt of worktrees) {
      let changed: boolean;
      try {
        const diff = await this.service.getWorktreeDiff(wt.path);
        changed = diff.trim().length > 0;
      } catch (error) {
        // Diff failed — treat as "changed" so we preserve rather than risk
        // discarding work we couldn't verify was empty.
        changed = true;
        debugLogger.warn(
          `cleanup: failed to diff worktree ${wt.path} (session ${sessionId}), preserving: ${error}`,
        );
      }

      if (changed) {
        anyPreserved = true;
        debugLogger.info(
          `cleanup: preserving worktree ${wt.path} (session ${sessionId}) — contains changes`,
        );
        continue;
      }

      const removeResult = await this.service.removeWorktree(wt.path);
      if (!removeResult.success) {
        debugLogger.warn(
          `cleanup: failed to remove unchanged worktree ${wt.path} (session ${sessionId}): ${removeResult.error}`,
        );
      }
    }

    if (!anyPreserved) {
      // No worktrees were preserved, so the whole session can be torn down
      // (branches + session directory) via the same path ArenaManager uses.
      const result = await this.service.cleanupSession(sessionId);
      if (!result.success) {
        debugLogger.warn(
          `cleanup: cleanupSession(${sessionId}) reported errors: ${result.errors.join('; ')}`,
        );
      }
    }
  }
}

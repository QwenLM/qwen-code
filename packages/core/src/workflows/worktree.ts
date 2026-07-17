/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { GitWorktreeService } from '../services/gitWorktreeService.js';

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
 */
export class GitWorktreeProvider implements WorktreeProvider {
  private readonly service: GitWorktreeService;

  constructor(
    private readonly sourceRepoPath: string,
    baseDir?: string,
  ) {
    this.service = new GitWorktreeService(sourceRepoPath, baseDir);
  }

  async acquire(runId: string, seq: number): Promise<string> {
    const name = `agent-${seq}`;
    const result = await this.service.setupWorktrees({
      sessionId: runId,
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
    return wt.path;
  }

  async cleanup(runId: string): Promise<void> {
    // cleanupSession removes the session's worktrees + branches. Worktrees left
    // unchanged carry no commits, so removal loses nothing (design:
    // "auto-removes if unchanged"). Best-effort — never throws into a run.
    try {
      await this.service.cleanupSession(runId);
    } catch {
      // Leave residue for manual cleanup rather than failing the run.
    }
  }
}

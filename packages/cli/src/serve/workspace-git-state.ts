/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGitWorkingTreeStatus,
  resolveBranchName,
  watchRepoBranch,
  type GitOperation,
  type GitWorkingTreeStatus,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './acp-session-bridge.js';

export interface WorkspaceGitStatus {
  v: 2;
  workspaceCwd: string;
  branch: string | null;
  /** v2 enriched fields — absent when not a repo or git is unavailable. */
  detached?: boolean;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicted?: number;
  hasUpstream?: boolean;
  ahead?: number;
  behind?: number;
  stashCount?: number;
  /** In-progress operation (merge/rebase/cherry-pick/revert/bisect). */
  operation?: GitOperation;
  /** Epoch ms when the enriched fields were computed. */
  computedAt?: number;
}

interface WorkspaceGitEntry {
  branch: string | undefined;
  dispose: () => void;
  /** Last computed working-tree summary; served as last-known on fast paths. */
  status?: GitWorkingTreeStatus;
  statusComputedAt?: number;
  /** In-flight working-tree computation, shared by all callers. */
  statusPromise?: Promise<void>;
  /** Last time a computation was kicked, for background-refresh throttling. */
  refreshStartedAt?: number;
  /** Set on dispose: a late-finishing refresh must not publish. */
  disposed?: boolean;
}

/**
 * Minimum interval between background working-tree refreshes. `wait: true`
 * callers bypass it — only reactive kicks (one per fast `getStatus`) are
 * throttled, so a focus/poll burst can't queue a train of `git status`
 * subprocesses.
 */
const BACKGROUND_REFRESH_THROTTLE_MS = 2_000;

function sameWorkingTreeStatus(
  a: GitWorkingTreeStatus,
  b: GitWorkingTreeStatus,
): boolean {
  return (
    a.branch === b.branch &&
    a.detached === b.detached &&
    a.hasUpstream === b.hasUpstream &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.untracked === b.untracked &&
    a.conflicted === b.conflicted &&
    a.stashCount === b.stashCount &&
    a.operation === b.operation
  );
}

export class WorkspaceGitState {
  private readonly entries = new Map<string, Promise<WorkspaceGitEntry>>();

  /**
   * Default (fast) path: return the last-known status immediately — branch-only
   * when the working-tree summary has never been computed — and kick a
   * throttled background refresh that publishes `git_status_changed` when it
   * finds a delta. `wait: true` awaits a fresh computation and returns the
   * full status (in-flight refreshes are shared), matching the pre-cache
   * blocking semantics.
   */
  async getStatus(
    workspaceCwd: string,
    bridge: AcpSessionBridge,
    opts?: { wait?: boolean },
  ): Promise<WorkspaceGitStatus> {
    const entry = await this.getOrCreateEntry(workspaceCwd, bridge);
    if (opts?.wait) {
      await this.startRefresh(workspaceCwd, entry, bridge, true);
    } else {
      void this.startRefresh(workspaceCwd, entry, bridge, false);
    }
    return this.materialize(workspaceCwd, entry);
  }

  dispose(): void {
    for (const pending of this.entries.values()) {
      void pending
        .then((entry) => {
          entry.disposed = true;
          entry.dispose();
        })
        .catch(() => {});
    }
    this.entries.clear();
  }

  disposeWorkspace(workspaceCwd: string): void {
    const pending = this.entries.get(workspaceCwd);
    if (!pending) return;
    this.entries.delete(workspaceCwd);
    void pending
      .then((entry) => {
        entry.disposed = true;
        entry.dispose();
      })
      .catch(() => {});
  }

  private materialize(
    workspaceCwd: string,
    entry: WorkspaceGitEntry,
  ): WorkspaceGitStatus {
    const status = entry.status;
    // The watcher keeps `entry.branch` live between refreshes; prefer it over
    // the (possibly stale) summary branch. A missing summary yields the
    // branch-only shape with no `computedAt`, which clients distinguish from
    // "computed and clean".
    if (!status) {
      return { v: 2, workspaceCwd, branch: entry.branch ?? null };
    }
    return {
      v: 2,
      workspaceCwd,
      branch: entry.branch ?? status.branch ?? null,
      detached: status.detached,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      conflicted: status.conflicted,
      hasUpstream: status.hasUpstream,
      ahead: status.ahead,
      behind: status.behind,
      stashCount: status.stashCount,
      ...(status.operation ? { operation: status.operation } : {}),
      computedAt: entry.statusComputedAt ?? Date.now(),
    };
  }

  /**
   * Start a working-tree computation unless one is already in flight (shared)
   * or a non-forced kick lands within the throttle window. Returns the
   * in-flight promise, or undefined when throttled. A failed computation keeps
   * the previous cache and stays silent; a successful one publishes
   * `git_status_changed` only when the summary actually changed.
   */
  private startRefresh(
    workspaceCwd: string,
    entry: WorkspaceGitEntry,
    bridge: AcpSessionBridge,
    force: boolean,
  ): Promise<void> | undefined {
    if (entry.statusPromise) return entry.statusPromise;
    if (
      !force &&
      entry.refreshStartedAt !== undefined &&
      Date.now() - entry.refreshStartedAt < BACKGROUND_REFRESH_THROTTLE_MS
    ) {
      return undefined;
    }
    entry.refreshStartedAt = Date.now();
    const run = (async () => {
      const status = await getGitWorkingTreeStatus(workspaceCwd).catch(
        () => null,
      );
      if (!status) return;
      const changed =
        !entry.status || !sameWorkingTreeStatus(entry.status, status);
      entry.status = status;
      entry.statusComputedAt = Date.now();
      if (changed && !entry.disposed) {
        try {
          bridge.publishWorkspaceEvent({
            type: 'git_status_changed',
            data: this.materialize(workspaceCwd, entry),
          });
        } catch {
          // SSE fan-out is a side effect — it must not reject the refresh
          // (an awaited wait:true call would 500 the route) or drop the cache.
        }
      }
    })();
    entry.statusPromise = run;
    void run.finally(() => {
      if (entry.statusPromise === run) {
        entry.statusPromise = undefined;
      }
    });
    return run;
  }

  private getOrCreateEntry(
    workspaceCwd: string,
    bridge: AcpSessionBridge,
  ): Promise<WorkspaceGitEntry> {
    const existing = this.entries.get(workspaceCwd);
    if (existing) return existing;

    const pending = this.createEntry(workspaceCwd, bridge).catch((error) => {
      if (this.entries.get(workspaceCwd) === pending) {
        this.entries.delete(workspaceCwd);
      }
      throw error;
    });
    this.entries.set(workspaceCwd, pending);
    return pending;
  }

  private async createEntry(
    workspaceCwd: string,
    bridge: AcpSessionBridge,
  ): Promise<WorkspaceGitEntry> {
    const entry: WorkspaceGitEntry = {
      branch: await resolveBranchName(workspaceCwd),
      dispose: () => {},
    };
    const refresh = async () => {
      const branch = await resolveBranchName(workspaceCwd);
      if (branch === entry.branch) return;
      entry.branch = branch;
      if (entry.disposed) return;
      bridge.publishWorkspaceEvent({
        type: 'git_branch_changed',
        data: { workspaceCwd, branch: branch ?? null },
      });
    };
    entry.dispose = await watchRepoBranch(workspaceCwd, () => {
      void refresh().catch(() => {});
    });
    return entry;
  }
}

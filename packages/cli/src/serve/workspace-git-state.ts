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
}

export class WorkspaceGitState {
  private readonly entries = new Map<string, Promise<WorkspaceGitEntry>>();

  async getStatus(
    workspaceCwd: string,
    bridge: AcpSessionBridge,
  ): Promise<WorkspaceGitStatus> {
    const entry = await this.getOrCreateEntry(workspaceCwd, bridge);
    // The watcher keeps `entry.branch` live between refreshes; the heavier
    // working-tree summary is computed fresh per call (the client bounds how
    // often it asks). A non-repo / git failure yields null → branch-only; a
    // transient state (merge/rebase/…) still returns a summary with `operation`.
    const status = await getGitWorkingTreeStatus(workspaceCwd).catch(
      () => null,
    );
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
      computedAt: Date.now(),
    };
  }

  dispose(): void {
    for (const pending of this.entries.values()) {
      void pending.then((entry) => entry.dispose()).catch(() => {});
    }
    this.entries.clear();
  }

  disposeWorkspace(workspaceCwd: string): void {
    const pending = this.entries.get(workspaceCwd);
    if (!pending) return;
    this.entries.delete(workspaceCwd);
    void pending.then((entry) => entry.dispose()).catch(() => {});
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

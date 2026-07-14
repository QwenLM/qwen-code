/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveBranchName, watchRepoBranch } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './acp-session-bridge.js';

export interface WorkspaceGitStatus {
  v: 1;
  workspaceCwd: string;
  branch: string | null;
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
    return { v: 1, workspaceCwd, branch: entry.branch ?? null };
  }

  dispose(): void {
    for (const pending of this.entries.values()) {
      void pending.then((entry) => entry.dispose()).catch(() => {});
    }
    this.entries.clear();
  }

  private getOrCreateEntry(
    workspaceCwd: string,
    bridge: AcpSessionBridge,
  ): Promise<WorkspaceGitEntry> {
    const existing = this.entries.get(workspaceCwd);
    if (existing) return existing;

    const pending = this.createEntry(workspaceCwd, bridge).catch((error) => {
      this.entries.delete(workspaceCwd);
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

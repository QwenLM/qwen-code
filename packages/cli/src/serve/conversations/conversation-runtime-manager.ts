/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationWorkspace } from './conversation-workspace.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface ConversationRuntimeManagerOptions {
  workspace: Pick<ConversationWorkspace, 'revalidate' | 'assertExactRoot'>;
  registry: WorkspaceRegistry;
  publishRuntime: (
    canonicalRoot: string,
    validate: (runtime: WorkspaceRuntime) => void | Promise<void>,
  ) => Promise<WorkspaceRuntime>;
}

export class ConversationRuntimeManager {
  private runtime?: WorkspaceRuntime;
  private pending?: Promise<WorkspaceRuntime>;

  constructor(private readonly options: ConversationRuntimeManagerOptions) {}

  ensure(): Promise<WorkspaceRuntime> {
    if (this.pending) return this.pending;
    const pending = this.ensureOnce().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async ensureOnce(): Promise<WorkspaceRuntime> {
    const root = await this.options.workspace.revalidate();
    if (this.runtime) {
      await this.options.workspace.assertExactRoot(this.runtime.workspaceCwd);
      this.assertActiveRuntime(
        root.canonicalRoot,
        this.runtime,
        'Live conversation runtime is no longer an active owned runtime.',
      );
      return this.runtime;
    }

    const entry = this.options.registry.getEntryByWorkspaceCwd(
      root.canonicalRoot,
    );
    if (entry) {
      const existing = entry.current?.runtime;
      if (entry.state !== 'active' || !existing) {
        throw new Error(
          'Live conversation runtime is no longer an active owned runtime.',
        );
      }
      this.assertOwnedRuntime(
        existing,
        'Live conversation root is already registered without Live provenance.',
      );
      await this.options.workspace.assertExactRoot(existing.workspaceCwd);
      this.assertActiveRuntime(
        root.canonicalRoot,
        existing,
        'Live conversation runtime is no longer an active owned runtime.',
      );
      this.runtime = existing;
      return existing;
    }

    const created = await this.options.publishRuntime(
      root.canonicalRoot,
      async (candidate) => {
        await this.options.workspace.assertExactRoot(candidate.workspaceCwd);
        this.assertOwnedRuntime(
          candidate,
          'Live conversation runtime failed its ownership gate.',
        );
      },
    );
    this.assertActiveRuntime(
      root.canonicalRoot,
      created,
      'Live conversation runtime is no longer an active owned runtime.',
    );
    this.runtime = created;
    return created;
  }

  private assertActiveRuntime(
    canonicalRoot: string,
    runtime: WorkspaceRuntime,
    message: string,
  ): void {
    this.assertOwnedRuntime(runtime, message);
    const entry = this.options.registry.getEntryByWorkspaceCwd(canonicalRoot);
    if (entry?.state !== 'active' || entry.current?.runtime !== runtime) {
      throw new Error(message);
    }
  }

  private assertOwnedRuntime(runtime: WorkspaceRuntime, message: string): void {
    if (
      runtime.primary ||
      runtime.provenance !== 'live-conversation' ||
      !runtime.trusted ||
      runtime.removable !== false
    ) {
      throw new Error(message);
    }
  }
}

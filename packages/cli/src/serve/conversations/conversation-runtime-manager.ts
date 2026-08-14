/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationWorkspace } from './conversation-workspace.js';
import type { ConversationRuntimeOwnership } from './conversation-runtime-ownership.js';
import {
  ConversationRuntimeOwnershipError,
  conversationRootCompromisedError,
  conversationRuntimeUnavailableError,
} from './conversation-runtime-errors.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface ConversationRuntimeManagerOptions {
  ownership: ConversationRuntimeOwnership;
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
    await this.options.ownership.acquire();
    const root = await this.revalidateRoot();
    if (this.runtime) {
      await this.assertExactRoot(this.runtime.workspaceCwd);
      this.assertActiveRuntime(root.canonicalRoot, this.runtime);
      return this.runtime;
    }

    const entry = this.options.registry.getManagedEntryByWorkspaceCwd(
      root.canonicalRoot,
    );
    if (entry) {
      const existing = entry.current?.runtime;
      if (entry.state !== 'active' || !existing) {
        throw conversationRuntimeUnavailableError();
      }
      this.assertOwnedRuntime(existing);
      await this.assertExactRoot(existing.workspaceCwd);
      this.assertActiveRuntime(root.canonicalRoot, existing);
      this.runtime = existing;
      return existing;
    }

    let created: WorkspaceRuntime;
    try {
      created = await this.options.publishRuntime(
        root.canonicalRoot,
        async (candidate) => {
          await this.assertExactRoot(candidate.workspaceCwd);
          this.assertOwnedRuntime(candidate);
        },
      );
    } catch (error) {
      if (error instanceof ConversationRuntimeOwnershipError) throw error;
      throw conversationRuntimeUnavailableError(error);
    }
    this.assertActiveRuntime(root.canonicalRoot, created);
    this.runtime = created;
    return created;
  }

  private async revalidateRoot(): Promise<
    Awaited<
      ReturnType<ConversationRuntimeManagerOptions['workspace']['revalidate']>
    >
  > {
    try {
      return await this.options.workspace.revalidate();
    } catch (error) {
      throw conversationRootCompromisedError(error);
    }
  }

  private async assertExactRoot(candidate: string): Promise<void> {
    try {
      await this.options.workspace.assertExactRoot(candidate);
    } catch (error) {
      throw conversationRootCompromisedError(error);
    }
  }

  private assertActiveRuntime(
    canonicalRoot: string,
    runtime: WorkspaceRuntime,
  ): void {
    this.assertOwnedRuntime(runtime);
    const entry =
      this.options.registry.getManagedEntryByWorkspaceCwd(canonicalRoot);
    if (entry?.state !== 'active' || entry.current?.runtime !== runtime) {
      throw conversationRuntimeUnavailableError();
    }
  }

  private assertOwnedRuntime(runtime: WorkspaceRuntime): void {
    if (
      runtime.primary ||
      runtime.provenance !== 'live-conversation' ||
      !runtime.trusted ||
      runtime.removable !== false
    ) {
      throw conversationRootCompromisedError();
    }
  }
}

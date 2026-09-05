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
import { writeStderrLine } from '../../utils/stdioHelpers.js';

export type ConversationRuntimeQuarantineReason =
  | 'standalone_session_containment_failed'
  | 'missing_mandatory_lease_attestation';

export interface ConversationRuntimeManagerOptions {
  ownership: ConversationRuntimeOwnership;
  workspace: Pick<ConversationWorkspace, 'revalidate' | 'assertExactRoot'>;
  registry: WorkspaceRegistry;
  publishRuntime: (
    canonicalRoot: string,
    validate: (runtime: WorkspaceRuntime) => void | Promise<void>,
  ) => Promise<WorkspaceRuntime>;
  quarantineRuntime: (
    runtime: WorkspaceRuntime,
    reason: ConversationRuntimeQuarantineReason,
  ) => Promise<void>;
  onTerminalQuarantine?: (
    runtime: WorkspaceRuntime,
    reason: ConversationRuntimeQuarantineReason,
  ) => void;
}

export class ConversationRuntimeManager {
  private runtime?: WorkspaceRuntime;
  private pending?: Promise<WorkspaceRuntime>;
  private terminalRuntime?: WorkspaceRuntime;
  private terminalError?: ConversationRuntimeOwnershipError;
  private quarantinePromise?: Promise<void>;

  constructor(private readonly options: ConversationRuntimeManagerOptions) {}

  ensure(): Promise<WorkspaceRuntime> {
    if (this.terminalRuntime) {
      return Promise.reject(
        this.terminalError ?? conversationRuntimeUnavailableError(),
      );
    }
    if (this.pending) return this.pending;
    const pending = this.ensureOnce().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  assertCurrent(expectedRuntime: WorkspaceRuntime): WorkspaceRuntime {
    this.assertNotTerminal();
    if (this.runtime !== expectedRuntime) {
      throw conversationRuntimeUnavailableError();
    }
    this.assertActiveRuntime(expectedRuntime.workspaceCwd, expectedRuntime);
    return expectedRuntime;
  }

  quarantine(
    expectedRuntime: WorkspaceRuntime,
    reason: ConversationRuntimeQuarantineReason,
  ): Promise<void> {
    if (this.terminalRuntime === expectedRuntime && this.quarantinePromise) {
      return this.quarantinePromise;
    }
    if (this.terminalRuntime) {
      throw this.terminalError ?? conversationRuntimeUnavailableError();
    }
    if (this.runtime !== expectedRuntime) {
      throw conversationRuntimeUnavailableError();
    }
    this.assertActiveRuntime(expectedRuntime.workspaceCwd, expectedRuntime);
    this.terminalRuntime = expectedRuntime;
    if (reason === 'missing_mandatory_lease_attestation') {
      // A static runtime contract violation never heals in place; keep every
      // later access on the same non-retryable classification instead of
      // degrading to retryable `conversation_runtime_unavailable`.
      this.terminalError = conversationRootCompromisedError();
    }
    try {
      this.options.onTerminalQuarantine?.(expectedRuntime, reason);
    } catch {
      try {
        writeStderrLine(
          'qwen serve: Conversations quarantine observer failed; runtime disposal will continue.',
        );
      } catch {
        // Terminal containment must not depend on diagnostics.
      }
    }
    const promise = Promise.resolve().then(() =>
      this.options.quarantineRuntime(expectedRuntime, reason),
    );
    this.quarantinePromise = promise;
    return promise;
  }

  private async ensureOnce(): Promise<WorkspaceRuntime> {
    this.assertNotTerminal();
    await this.options.ownership.acquire();
    this.assertNotTerminal();
    const root = await this.revalidateRoot();
    this.assertNotTerminal();
    if (this.runtime) {
      await this.assertExactRoot(this.runtime.workspaceCwd);
      this.assertActiveRuntime(root.canonicalRoot, this.runtime);
      this.assertNotTerminal();
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
      try {
        this.assertMandatoryLeaseAttestation(existing);
      } catch (error) {
        // An equivalent registered runtime that cannot prove the mandatory
        // lease reaches its children is terminally quarantined, never served.
        await this.quarantine(
          existing,
          'missing_mandatory_lease_attestation',
        ).catch(() => undefined);
        throw error;
      }
      this.assertNotTerminal();
      return existing;
    }

    let created: WorkspaceRuntime;
    try {
      created = await this.options.publishRuntime(
        root.canonicalRoot,
        async (candidate) => {
          await this.assertExactRoot(candidate.workspaceCwd);
          this.assertOwnedRuntime(candidate);
          this.assertMandatoryLeaseAttestation(candidate);
        },
      );
    } catch (error) {
      if (error instanceof ConversationRuntimeOwnershipError) throw error;
      throw conversationRuntimeUnavailableError(error);
    }
    this.assertActiveRuntime(root.canonicalRoot, created);
    this.runtime = created;
    this.assertNotTerminal();
    return created;
  }

  private assertNotTerminal(): void {
    if (this.terminalRuntime) {
      throw this.terminalError ?? conversationRuntimeUnavailableError();
    }
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

  private assertMandatoryLeaseAttestation(runtime: WorkspaceRuntime): void {
    if (runtime.bridge.mandatoryLeaseAttested !== true) {
      throw conversationRootCompromisedError();
    }
  }
}

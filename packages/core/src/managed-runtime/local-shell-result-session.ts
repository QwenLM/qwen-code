/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { managedSessionResourceRoot } from '../utils/sessionStorageUtils.js';
import {
  createManagedHarnessHandle,
  type ManagedHarnessHandle,
} from './managed-harness-factory.js';
import type { ManagedSession } from './managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ToolResultEnvelope } from './managed-tool-result.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';
import {
  ManagedShellResultSession,
  type LocalShellReceipt,
} from './managed-shell-result-session.js';

export type {
  LocalShellCaptureRequest,
  LocalShellReceipt,
} from './managed-shell-result-session.js';

/** The local writer owns capture storage and advances its own continuation. */
export class LocalShellResultSession extends ManagedShellResultSession {
  private readonly harness: ManagedHarnessHandle;
  constructor(
    session: ManagedSession,
    store: ToolResultSegmentStore,
    bindingGeneration: string,
    lease: SessionWriterLease,
    runtimeSessionId: string,
  ) {
    const key = session.authority.sessionHeader.sessionKey;
    if (
      lease.sessionId !== key.sessionId ||
      !(session.resources instanceof LocalManagedSessionResourceStore) ||
      session.resources.sessionRoot !==
        managedSessionResourceRoot(lease.runtimeBaseDir, key.sessionId)
    ) {
      throw new Error(
        'Shell capture requires the Session writer and resource root.',
      );
    }
    super(
      session,
      store,
      bindingGeneration,
      () => lease.assertOwnedAndUnchanged(),
      runtimeSessionId,
    );
    this.harness = createManagedHarnessHandle(session);
  }

  private async advance(receipt: LocalShellReceipt): Promise<void> {
    if (receipt.deliveryStatus !== 'committed') return;
    await this.assertWritable();
    await this.harness.resolveAwaitRuntime(
      receipt.executionCallId,
      receipt.outcomeRef,
    );
  }

  override async accept(
    identity: ToolResultExpectedIdentity,
    candidate: ToolResultEnvelope,
  ): Promise<LocalShellReceipt> {
    const receipt = await super.accept(identity, candidate);
    await this.advance(receipt);
    return receipt;
  }

  async recover(
    identity: ToolResultExpectedIdentity,
  ): Promise<LocalShellReceipt | null> {
    const receipt = await this.recorded(identity);
    if (receipt) await this.advance(receipt);
    return receipt;
  }
}

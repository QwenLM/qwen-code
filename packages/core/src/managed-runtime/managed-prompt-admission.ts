/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ManagedActivationDescriptor,
  ManagedActivationEnqueueResult,
} from './managed-activation-store.js';
import {
  managedSessionPayloadRef,
  type FileManagedSessionInbox,
  type ManagedSessionInboxAdmissionResult,
  type ManagedSessionInboxLimits,
  type ManagedSessionMessageSnapshot,
  type ManagedSessionUserMessageInput,
} from './managed-session-inbox.js';

export interface ManagedActivationSubmitter {
  submit(
    activation: ManagedActivationDescriptor,
  ): Promise<ManagedActivationEnqueueResult>;
}

export interface ManagedPromptAdmissionResult
  extends ManagedSessionInboxAdmissionResult {
  readonly activation: ManagedActivationEnqueueResult;
}

export interface ManagedPromptReconciliationResult {
  readonly inspected: number;
  readonly readied: number;
}

export class ManagedPromptAdmissionController {
  private readonly limits: ManagedSessionInboxLimits;

  constructor(
    private readonly inbox: FileManagedSessionInbox,
    private readonly submitter: ManagedActivationSubmitter,
    limits: ManagedSessionInboxLimits,
  ) {
    this.limits = Object.freeze({ ...limits });
  }

  async admit(
    input: ManagedSessionUserMessageInput,
  ): Promise<ManagedPromptAdmissionResult> {
    const admitted = await this.inbox.admit(input, this.limits);
    const message = await this.inbox.markActivationReady(
      admitted.message.message,
    );
    const activation = await this.submit(admitted.message);
    return { created: admitted.created, message, activation };
  }

  async reconcile(): Promise<ManagedPromptReconciliationResult> {
    const pending = this.inbox.listPending();
    let readied = 0;
    for (const message of pending) {
      if (!message.activationReady) {
        await this.inbox.markActivationReady(message.message);
        readied += 1;
      }
      await this.submit(message);
    }
    return { inspected: pending.length, readied };
  }

  private submit(
    snapshot: ManagedSessionMessageSnapshot,
  ): Promise<ManagedActivationEnqueueResult> {
    const { tenantId, sessionId, messageId } = snapshot.message;
    return this.submitter.submit({
      tenantId,
      sessionId,
      activationId: messageId,
      payloadRef: managedSessionPayloadRef(snapshot.message),
      reason: 'user_message',
      recovery: 'replay_safe',
    });
  }
}

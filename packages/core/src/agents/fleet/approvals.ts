/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '../../tools/tools.js';
import type { ApprovalDecision } from './session.js';

export type ApprovalResponder = (
  outcome: ToolConfirmationOutcome,
  payload?: ToolConfirmationPayload,
) => Promise<void>;

export class ApprovalRegistry {
  private readonly responders = new Map<string, ApprovalResponder>();

  register(callId: string, responder: ApprovalResponder): void {
    this.responders.set(callId, responder);
  }

  async answer(decision: ApprovalDecision): Promise<void> {
    const responder = this.responders.get(decision.callId);
    if (!responder) return;
    this.responders.delete(decision.callId);
    await responder(decision.outcome, decision.payload);
  }

  delete(callId: string): void {
    this.responders.delete(callId);
  }

  clear(): void {
    this.responders.clear();
  }
}

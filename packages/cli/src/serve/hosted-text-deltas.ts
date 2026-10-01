/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';

// A published chunk must survive its writer immediately, so every model delta
// commits; only the journal's payload text limit forces a split.
const DELTA_MAX_BYTES = 3072;

/**
 * Commits streamed assistant text as activation-scoped `message.delta` journal
 * events so a published prefix survives its writer and a dead owner's prefix
 * stays attributable to its epoch. The final `message.committed` record
 * carries the same pre-assigned messageId and does not project again.
 */
export class HostedTextDeltaStream {
  private messageId: string | undefined;
  private ordinal = 0;

  constructor(
    private readonly session: ManagedSession,
    private readonly turnId: string,
  ) {}

  /** Whether the current model message already published durable text. */
  published(): boolean {
    return this.messageId !== undefined;
  }

  /** The messageId the in-flight assistant message must commit under. */
  takeMessageId(): string | undefined {
    const id = this.messageId;
    this.messageId = undefined;
    return id;
  }

  async delta(text: string): Promise<void> {
    if (!text) return;
    this.messageId ??= randomUUID();
    let rest = text;
    while (rest.length > 0) {
      // Binary-search the longest prefix within the byte cap: walking one
      // character at a time re-measures the whole prefix per step.
      let end = Math.min(rest.length, DELTA_MAX_BYTES);
      if (Buffer.byteLength(rest.slice(0, end), 'utf8') > DELTA_MAX_BYTES) {
        let lo = 0;
        let hi = end;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (Buffer.byteLength(rest.slice(0, mid), 'utf8') <= DELTA_MAX_BYTES)
            lo = mid;
          else hi = mid - 1;
        }
        end = lo;
      }
      // Never split a surrogate pair across two durable chunks.
      if (
        end > 0 &&
        end < rest.length &&
        (rest.charCodeAt(end - 1) & 0xfc00) === 0xd800 &&
        (rest.charCodeAt(end) & 0xfc00) === 0xdc00
      ) {
        end -= 1;
      }
      await this.commit(rest.slice(0, end));
      rest = rest.slice(end);
    }
  }

  private async commit(text: string): Promise<void> {
    const messageId = this.messageId;
    if (messageId === undefined) return;
    const authority = this.session.authority;
    const activation = this.session.activation;
    const ordinal = this.ordinal;
    this.ordinal += 1;
    await authority.appendExecutionEvent(
      {
        operation: 'assistantDelta',
        commandId: `assistant-delta:${this.turnId}:${messageId}:${ordinal}`,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256').update(text).digest('hex'),
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: `assistant-delta:${this.turnId}:${messageId}:${ordinal}`,
        sessionKey: authority.sessionHeader.sessionKey,
        kind: 'message.delta',
        occurredAt: Date.now(),
        subject: {
          type: 'activation',
          scopeId: activation.activationId,
          ...activation,
        },
        payload: {
          messageId,
          turnId: this.turnId,
          role: 'assistant',
          text,
        },
      }),
      { class: 'harness', activation },
    );
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getGlobalQwenDir,
  getWorkspaceScopeDirName,
  MANAGED_OUTBOUND_LIMIT,
  validManagedReceipt,
} from '@qwen-code/channel-base';
import type {
  ManagedReceipt,
  ManagedInboundEvent,
} from '@qwen-code/channel-base';

export type { ManagedReceipt };

// H5d of #12827: the managed DingTalk adapter's own locked state. It keeps
// what the email managed state keeps for the same reasons — the account
// generation, the in-flight admissions, the sent-but-unreceipted segments,
// and the dedupe window — plus the conversationId → sessionWebhook map the
// provider needs to answer a chat. Every claim persists before its side
// effect, so a restart replays the same event or reports the same segment
// unknown, never a second input and never a second send. See
// docs/design/2026-11-13-managed-channel-dingtalk-adapter.md.

export const MANAGED_DINGTALK_PENDING_LIMIT = 32;
export const RECENT_LIMIT = 256;
export const WEBHOOK_LIMIT = 256;
// H5e of #12827: one card progress entry per in-flight card delivery. Bounded
// like the outbound ledger; least-recently-touched eviction keeps a long-lived
// instance from growing the state file without limit. An evicted entry is safe:
// the send path reads its absence as "text", never as "create a second card".
export const MANAGED_CARD_PROGRESS_LIMIT = 64;

export interface ManagedDingtalkPendingEvent {
  eventId: string;
  /**
   * The full admission, persisted because a stream message is acked on
   * receipt and never redelivered: after a restart the claim re-drives this
   * exact event, never a rebuilt one.
   */
  event: ManagedInboundEvent;
  inputId?: string;
  held?: boolean;
}

export interface ManagedDingtalkOutboundSegment {
  deliveryId: string;
  ordinal: number;
  messageId: string;
  receipt?: ManagedReceipt;
}

/**
 * The rendered card of one in-flight delivery (H5e). `body` is the accumulated
 * card text the provider already holds, persisted before each edit so a restart
 * resumes the same snapshot; `mode` records the overflow fallback to text. The
 * outTrackId is re-derivable from the deliveryId, but persisting it keeps the
 * handle and the body it names in one atomic write.
 */
export interface ManagedDingtalkCardProgress {
  outTrackId: string;
  body: string;
  mode: 'card' | 'text';
}

export interface ManagedDingtalkState {
  version: 1;
  generation: number;
  instanceRefusals?: number;
  pending: ManagedDingtalkPendingEvent[];
  outbound: ManagedDingtalkOutboundSegment[];
  recent: string[];
  webhooks: Record<string, string>;
  cards?: Record<string, ManagedDingtalkCardProgress>;
}

export function validManagedDingtalkState(
  value: unknown,
): value is ManagedDingtalkState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ManagedDingtalkState;
  return (
    state.version === 1 &&
    Number.isSafeInteger(state.generation) &&
    state.generation >= 1 &&
    (state.instanceRefusals === undefined ||
      (Number.isSafeInteger(state.instanceRefusals) &&
        state.instanceRefusals >= 0)) &&
    Array.isArray(state.pending) &&
    state.pending.length <= MANAGED_DINGTALK_PENDING_LIMIT &&
    state.pending.every(
      (entry) =>
        entry &&
        typeof entry.eventId === 'string' &&
        entry.eventId.length > 0 &&
        !!entry.event &&
        typeof entry.event === 'object' &&
        entry.event.platformEventId === entry.eventId &&
        typeof entry.event.text === 'string' &&
        (entry.inputId === undefined || typeof entry.inputId === 'string'),
    ) &&
    Array.isArray(state.outbound) &&
    state.outbound.length <= MANAGED_OUTBOUND_LIMIT &&
    state.outbound.every(
      (entry) =>
        entry &&
        typeof entry.deliveryId === 'string' &&
        entry.deliveryId.length > 0 &&
        Number.isSafeInteger(entry.ordinal) &&
        entry.ordinal >= 0 &&
        typeof entry.messageId === 'string' &&
        entry.messageId.length > 0 &&
        validManagedReceipt(entry.receipt),
    ) &&
    Array.isArray(state.recent) &&
    state.recent.length <= RECENT_LIMIT &&
    state.recent.every((entry) => typeof entry === 'string') &&
    !!state.webhooks &&
    typeof state.webhooks === 'object' &&
    !Array.isArray(state.webhooks) &&
    Object.keys(state.webhooks).length <= WEBHOOK_LIMIT &&
    Object.entries(state.webhooks).every(
      ([key, entry]) =>
        typeof key === 'string' &&
        key.length > 0 &&
        typeof entry === 'string' &&
        entry.length > 0,
    ) &&
    (state.cards === undefined ||
      (!!state.cards &&
        typeof state.cards === 'object' &&
        !Array.isArray(state.cards) &&
        Object.keys(state.cards).length <= MANAGED_CARD_PROGRESS_LIMIT &&
        Object.entries(state.cards).every(
          ([key, entry]) =>
            typeof key === 'string' &&
            key.length > 0 &&
            !!entry &&
            typeof entry === 'object' &&
            typeof entry.outTrackId === 'string' &&
            entry.outTrackId.length > 0 &&
            typeof entry.body === 'string' &&
            (entry.mode === 'card' || entry.mode === 'text'),
        )))
  );
}

export class ManagedDingtalkStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, clientId: string) {
    // One directory per robot app per workspace, beside the other channel
    // state. Its lock serializes concurrent managed instances of this robot
    // app; the Legacy DingTalk channel keeps no on-disk state and takes no
    // lock, so the lock does not arbitrate managed-versus-Legacy.
    const key = createHash('sha256')
      .update(`${name}\u0000${clientId}`)
      .digest('hex')
      .slice(0, 16);
    this.directory = join(
      getGlobalQwenDir(),
      'channels',
      getWorkspaceScopeDirName(cwd),
      `dingtalk-${key}`,
    );
    this.file = join(this.directory, 'managed-state.json');
  }

  load(): ManagedDingtalkState | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validManagedDingtalkState(value)) throw new Error('invalid state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        'Managed DingTalk state is unreadable or invalid; restore it before restarting.',
      );
    }
  }

  save(state: ManagedDingtalkState): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
    } catch (error) {
      // Keep the message (a cross-channel convention shared with the email
      // store) but preserve the fs error on cause, so the adapter's logs can
      // distinguish ENOSPC from EACCES from a read-only mount (#17432 R1-3).
      throw new Error(
        'Managed DingTalk state could not be saved; admission stopped.',
        { cause: error },
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

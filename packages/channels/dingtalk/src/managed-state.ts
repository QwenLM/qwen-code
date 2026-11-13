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
const RECENT_LIMIT = 256;
const WEBHOOK_LIMIT = 256;

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

export interface ManagedDingtalkState {
  version: 1;
  generation: number;
  instanceRefusals?: number;
  pending: ManagedDingtalkPendingEvent[];
  outbound: ManagedDingtalkOutboundSegment[];
  recent: string[];
  webhooks: Record<string, string>;
}

function validManagedReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<ManagedReceipt>;
  if (receipt.outcome === 'unknown' || receipt.outcome === 'rejected')
    return Object.keys(receipt).length === 1;
  return (
    receipt.outcome === 'accepted' &&
    Number.isSafeInteger(receipt.ordinal) &&
    (receipt.ordinal as number) >= 0 &&
    typeof receipt.providerMessageId === 'string' &&
    receipt.providerMessageId.length > 0 &&
    receipt.providerMessageId.length <= 512 &&
    Number.isSafeInteger(receipt.acceptedAt) &&
    (receipt.acceptedAt as number) >= 0
  );
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
    state.outbound.length <= 64 &&
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
    )
  );
}

export class ManagedDingtalkStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, clientId: string) {
    // One directory per robot app per workspace, beside the other channel
    // state; its lock keeps a single owner, managed or Legacy.
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
    } catch {
      throw new Error(
        'Managed DingTalk state could not be saved; admission stopped.',
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

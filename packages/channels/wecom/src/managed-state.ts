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

// The managed WeCom adapter's own locked state, mirroring the DingTalk store
// minus the webhook map: a WeCom reply travels over the live authenticated
// WebSocket keyed only by chatid, so there is no per-message bearer capability
// to persist. Every claim persists before its side effect, so a restart
// replays the same event or reports the same segment unknown, never a second
// input and never a second send. See
// docs/design/2026-11-16-managed-channel-wecom-adapter.md.

export const MANAGED_WECOM_PENDING_LIMIT = 32;
export const RECENT_LIMIT = 256;

export interface ManagedWecomPendingEvent {
  eventId: string;
  /**
   * The full admission, persisted because the SDK pushes each message once
   * and the provider never redelivers: after a restart the claim re-drives
   * this exact event, never a rebuilt one.
   */
  event: ManagedInboundEvent;
  inputId?: string;
  held?: boolean;
}

export interface ManagedWecomOutboundSegment {
  deliveryId: string;
  ordinal: number;
  messageId: string;
  receipt?: ManagedReceipt;
}

export interface ManagedWecomState {
  version: 1;
  generation: number;
  instanceRefusals?: number;
  pending: ManagedWecomPendingEvent[];
  outbound: ManagedWecomOutboundSegment[];
  recent: string[];
}

export function validManagedWecomState(
  value: unknown,
): value is ManagedWecomState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ManagedWecomState;
  return (
    state.version === 1 &&
    Number.isSafeInteger(state.generation) &&
    state.generation >= 1 &&
    (state.instanceRefusals === undefined ||
      (Number.isSafeInteger(state.instanceRefusals) &&
        state.instanceRefusals >= 0)) &&
    Array.isArray(state.pending) &&
    state.pending.length <= MANAGED_WECOM_PENDING_LIMIT &&
    state.pending.every(
      (entry) =>
        entry &&
        typeof entry.eventId === 'string' &&
        entry.eventId.length > 0 &&
        !!entry.event &&
        typeof entry.event === 'object' &&
        entry.event.platformEventId === entry.eventId &&
        typeof entry.event.text === 'string' &&
        (entry.event.subject === null ||
          typeof entry.event.subject === 'string') &&
        // The re-drive (resubmitPending) reads these fields; a partial state
        // that loads would drop the already-accepted claim with a misleading
        // line (allowlist) or submit it without chat/scope (open). Fail closed
        // on any missing required field so the store refuses it for repair.
        typeof entry.event.senderId === 'string' &&
        entry.event.senderId.length > 0 &&
        typeof entry.event.chatId === 'string' &&
        entry.event.chatId.length > 0 &&
        typeof entry.event.threadId === 'string' &&
        entry.event.threadId.length > 0 &&
        Number.isSafeInteger(entry.event.accountGeneration) &&
        entry.event.accountGeneration >= 1 &&
        entry.event.semanticRevision === 1 &&
        !!entry.event.scope &&
        entry.event.scope.kind === 'chat_thread' &&
        // The nested carriers are load-bearing too: resubmitPending submits the
        // whole event (the base contract fixes scope.senderId to null) and
        // send() addresses the reply through replyContext.chatId and gates the
        // whole delivery on replyContext.senderId (senderAllowed). Presence-only
        // checks would load a hand-repaired state whose claim is then refused
        // (scope) or whose reply settles rejected — silently, with no startup
        // refusal naming the file — when chatId or senderId is missing.
        entry.event.scope.senderId === null &&
        typeof entry.event.scope.chatId === 'string' &&
        entry.event.scope.chatId.length > 0 &&
        typeof entry.event.scope.threadId === 'string' &&
        entry.event.scope.threadId.length > 0 &&
        Array.isArray(entry.event.attachments) &&
        !!entry.event.replyContext &&
        typeof entry.event.replyContext === 'object' &&
        typeof (entry.event.replyContext as { chatId?: unknown }).chatId ===
          'string' &&
        (entry.event.replyContext as { chatId: string }).chatId.length > 0 &&
        typeof (entry.event.replyContext as { senderId?: unknown }).senderId ===
          'string' &&
        (entry.event.replyContext as { senderId: string }).senderId.length >
          0 &&
        (entry.inputId === undefined || typeof entry.inputId === 'string') &&
        // held is persisted and re-read at startup; the stall re-arm reads
        // truthiness while the lift and the probe sort require === true, so a
        // non-boolean (e.g. "false") must fail closed, not load.
        (entry.held === undefined || typeof entry.held === 'boolean'),
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
    state.recent.every((entry) => typeof entry === 'string')
  );
}

export class ManagedWecomStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, botId: string) {
    // One directory per configured entry (channel name + botId) per workspace,
    // beside the other channel state — the same name+account key shape the
    // DingTalk store uses. Its lock serializes concurrent managed instances of
    // this entry; two entries sharing a botId get separate directories and
    // locks (the SDK then admits one connection and kicks the other), so a
    // duplicated or renamed entry is an operator config concern, not something
    // the lock merges. The Legacy WeCom channel keeps no on-disk state and
    // takes no lock, so the lock does not arbitrate managed-versus-Legacy.
    const key = createHash('sha256')
      .update(`${name}\u0000${botId}`)
      .digest('hex')
      .slice(0, 16);
    this.directory = join(
      getGlobalQwenDir(),
      'channels',
      getWorkspaceScopeDirName(cwd),
      `wecom-${key}`,
    );
    this.file = join(this.directory, 'managed-state.json');
  }

  load(): ManagedWecomState | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validManagedWecomState(value)) throw new Error('invalid state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        'Managed WeCom state is unreadable or invalid; restore it before restarting.',
      );
    }
  }

  save(state: ManagedWecomState): void {
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
        'Managed WeCom state could not be saved; admission stopped.',
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

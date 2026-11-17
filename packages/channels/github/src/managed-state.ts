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

// H5f of #12827: the managed GitHub adapter's own locked state. The cursor
// (notification watermark plus the dispatched-comment ring) is the platform
// consumption commitment; pending holds the full inbound events because a
// marked-read notification cannot be re-listed; outbound is the sent-but-
// unreceipted segment ledger. Every claim persists before its side effect,
// so a restart replays the same event or reports the same segment unknown,
// never a second input and never a second send. See
// docs/design/2026-11-16-managed-channel-github-adapter.md.

export const MANAGED_GITHUB_PENDING_LIMIT = 32;
export const DISPATCHED_COMMENTS_LIMIT = 500;

export interface ManagedGithubPendingEvent {
  eventId: string;
  /**
   * The full admission, persisted because marking a notification thread read
   * removes it from the unread list: after a restart the claim re-drives this
   * exact event, never a comment re-fetched from the API (which may have been
   * edited or deleted since admission).
   */
  event: ManagedInboundEvent;
  /** The notification thread to mark read once this event is submitted. */
  notificationThreadId: string;
  held?: boolean;
}

export interface ManagedGithubOutboundSegment {
  deliveryId: string;
  ordinal: number;
  receipt?: ManagedReceipt;
}

export interface ManagedGithubCursor {
  /** The notification window watermark; null before the first poll. */
  lastProcessedAt: string | null;
  /** Comment keys already submitted; a work-saving filter over idempotency. */
  dispatchedComments: string[];
}

export interface ManagedGithubState {
  version: 1;
  generation: number;
  instanceRefusals?: number;
  cursor: ManagedGithubCursor;
  pending: ManagedGithubPendingEvent[];
  outbound: ManagedGithubOutboundSegment[];
}

export function validManagedGithubState(
  value: unknown,
): value is ManagedGithubState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ManagedGithubState;
  return (
    state.version === 1 &&
    Number.isSafeInteger(state.generation) &&
    state.generation >= 1 &&
    (state.instanceRefusals === undefined ||
      (Number.isSafeInteger(state.instanceRefusals) &&
        state.instanceRefusals >= 0)) &&
    !!state.cursor &&
    typeof state.cursor === 'object' &&
    (state.cursor.lastProcessedAt === null ||
      (typeof state.cursor.lastProcessedAt === 'string' &&
        state.cursor.lastProcessedAt.length > 0 &&
        !Number.isNaN(Date.parse(state.cursor.lastProcessedAt)))) &&
    Array.isArray(state.cursor.dispatchedComments) &&
    state.cursor.dispatchedComments.length <= DISPATCHED_COMMENTS_LIMIT &&
    state.cursor.dispatchedComments.every(
      (entry) => typeof entry === 'string' && entry.length > 0,
    ) &&
    Array.isArray(state.pending) &&
    state.pending.length <= MANAGED_GITHUB_PENDING_LIMIT &&
    state.pending.every(
      (entry) =>
        entry &&
        typeof entry.eventId === 'string' &&
        entry.eventId.length > 0 &&
        !!entry.event &&
        typeof entry.event === 'object' &&
        entry.event.platformEventId === entry.eventId &&
        typeof entry.event.text === 'string' &&
        typeof entry.notificationThreadId === 'string' &&
        entry.notificationThreadId.length > 0,
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
        validManagedReceipt(entry.receipt),
    )
  );
}

export class ManagedGithubStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, baseUrl: string) {
    // One directory per channel name per endpoint per workspace, beside the
    // other channel state. Credentials never define identity. The lock
    // serializes concurrent managed instances of this name + endpoint; it
    // does not cross-lock the Legacy GitHub channel, so the operator must run
    // exactly one consumer per bot identity.
    const key = createHash('sha256')
      .update(`${name}\u0000${baseUrl}`)
      .digest('hex')
      .slice(0, 16);
    this.directory = join(
      getGlobalQwenDir(),
      'channels',
      getWorkspaceScopeDirName(cwd),
      `github-${key}`,
    );
    this.file = join(this.directory, 'managed-state.json');
  }

  load(): ManagedGithubState | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validManagedGithubState(value)) throw new Error('invalid state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        'Managed GitHub state is unreadable or invalid; restore it before restarting.',
      );
    }
  }

  save(state: ManagedGithubState): void {
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
      // The fixed sentence keeps platform data out of the message, but the fs
      // error rides on `cause` so the adapter's logs can name ENOSPC/EACCES.
      throw new Error(
        'Managed GitHub state could not be saved; admission stopped.',
        { cause: error },
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

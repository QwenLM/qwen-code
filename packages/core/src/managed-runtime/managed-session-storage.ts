/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  managedSessionEventsDigest,
  managedSessionKeysEqual,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionHeader,
  type ManagedSessionKey,
} from './managed-session-records.js';

export interface ManagedSessionCommitReceipt {
  readonly transactionId: string;
  readonly commandId: string;
  readonly operation: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly committedSequence: number;
  /** True when the original commit was returned instead of appending again. */
  readonly replayed: boolean;
}

export interface ManagedSessionActivationState {
  readonly activationId: string;
  readonly epoch: number;
  readonly workerId: string;
  readonly phase: string;
  /** The horizon the install recorded; a release restates it unchanged. */
  readonly expiresAt: number;
}

export interface ManagedSessionCommittedTransaction {
  readonly receipt: ManagedSessionCommitReceipt;
  readonly contentDigest: string;
}

export interface ManagedSessionJournalScan {
  readonly header?: ManagedSessionHeader;
  readonly events: ManagedSessionEvent[];
  readonly transactions: Map<string, ManagedSessionCommittedTransaction>;
  readonly committed: number;
  readonly lastMarkerDigest: string | null;
  readonly lastRecordUuid: string | null;
  readonly activation: ManagedSessionActivationState | undefined;
  /** Byte length of the prefix ending at the last commit marker. */
  readonly committedBytes: number;
  /** Byte length through the Managed header. */
  readonly headerBytes: number;
  /** Byte length of records after the committed prefix. */
  readonly uncommittedBytes: number;
  readonly uncommitted: number;
  readonly foreignRecords: number;
  /** Engine ownership records written before the Managed header. */
  readonly engineRecords: number;
}

export interface ManagedSessionJournalReader {
  readonly sessionKey: ManagedSessionKey;
  read(options?: {
    readonly maxBytes?: number;
  }): Promise<ManagedSessionJournalScan>;
}

/**
 * Physical writer for one Managed Session journal.
 *
 * A semantic transaction is handed to the store as one batch. The local JSONL
 * adapter deliberately preserves its historical line-by-line crash behavior;
 * durable adapters may commit the same batch atomically.
 */
export interface ManagedSessionJournalHandle
  extends ManagedSessionJournalReader {
  appendTransaction(records: readonly unknown[]): Promise<void>;
  blockRecovery?(request: {
    readonly status:
      | 'BLOCKED_RESOURCE'
      | 'BLOCKED_WORKSPACE'
      | 'BLOCKED_EXECUTION';
    readonly detailCode: string;
  }): Promise<void>;
  seal(): Promise<void>;
  /** Abandons an unsuccessful open without publishing a handoff boundary. */
  abort(): Promise<void>;
}

export interface ManagedSessionJournalStore {
  open(request: {
    readonly sessionKey: ManagedSessionKey;
  }): Promise<ManagedSessionJournalHandle>;
}

export interface ManagedSessionResourceStore {
  publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
  read(ref: ManagedSessionDurableRef): Promise<Buffer>;
}

export function managedSessionCommandKey(
  operation: string,
  commandId: string,
): string {
  return `${operation}\u0000${commandId}`;
}

export function managedSessionActivationStateFrom(
  event: ManagedSessionEvent,
): ManagedSessionActivationState {
  return {
    activationId: event.payload['activationId'] as string,
    epoch: event.payload['epoch'] as number,
    workerId: event.payload['workerId'] as string,
    phase: event.payload['phase'] as string,
    expiresAt: event.payload['expiresAt'] as number,
  };
}

export function emptyManagedSessionJournalScan(): ManagedSessionJournalScan {
  return {
    events: [],
    transactions: new Map(),
    committed: 0,
    lastMarkerDigest: null,
    lastRecordUuid: null,
    activation: undefined,
    committedBytes: 0,
    headerBytes: 0,
    uncommittedBytes: 0,
    uncommitted: 0,
    foreignRecords: 0,
    engineRecords: 0,
  };
}

/**
 * Parses the exact JSONL representation shared by local files and remote
 * journal exports. Corrupt committed content fails closed; only a final torn
 * line is classified as an uncommitted tail.
 */
export function scanManagedSessionJournal(
  bytes: Buffer,
  sessionKey: ManagedSessionKey,
  maxBytes?: number,
): ManagedSessionJournalScan {
  const text = (
    maxBytes === undefined || maxBytes >= bytes.byteLength
      ? bytes
      : bytes.subarray(0, maxBytes)
  ).toString('utf8');
  const lines = text.split('\n');
  const tornTail = lines[lines.length - 1] !== '' ? 1 : 0;
  lines.pop();

  let header: ManagedSessionHeader | undefined;
  const events: ManagedSessionEvent[] = [];
  const transactions = new Map<string, ManagedSessionCommittedTransaction>();
  let committed = 0;
  let lastMarkerDigest: string | null = null;
  let lastRecordUuid: string | null = null;
  let activation: ManagedSessionActivationState | undefined;
  let scanned = 0;
  let committedBytes = 0;
  let headerBytes = 0;
  let foreignRecords = 0;
  let engineRecords = 0;
  let pending: ManagedSessionEvent[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === '') {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} is blank.`,
      );
    }
    scanned += Buffer.byteLength(line, 'utf8') + 1;
    const record = parseManagedSessionRecordJson(
      line,
      MANAGED_SESSION_LIMITS.maxEventBytes,
    );
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record)
    ) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} is not a record object.`,
      );
    }
    const envelope = record as Record<string, unknown>;
    const subtype = envelope['subtype'];
    if (typeof envelope['uuid'] === 'string') {
      lastRecordUuid = envelope['uuid'];
    }
    if (
      subtype !== MANAGED_SESSION_HEADER_SUBTYPE &&
      subtype !== MANAGED_SESSION_EVENT_SUBTYPE &&
      subtype !== MANAGED_SESSION_COMMIT_SUBTYPE
    ) {
      if (header !== undefined) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} has the unknown subtype ${String(subtype)} after the Managed header.`,
        );
      }
      foreignRecords++;
      if (subtype === 'session_execution_engine') engineRecords++;
      continue;
    }
    const body = envelope['managedSession'];
    if (subtype === MANAGED_SESSION_HEADER_SUBTYPE) {
      if (header !== undefined) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} repeats the Managed header.`,
        );
      }
      header = parseManagedSessionHeader(body);
      headerBytes = scanned;
      if (!managedSessionKeysEqual(header.sessionKey, sessionKey)) {
        throw new ManagedSessionRecordError(
          'session log header belongs to a different session.',
        );
      }
      continue;
    }
    if (header === undefined) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} precedes the Managed header.`,
      );
    }
    if (subtype === MANAGED_SESSION_EVENT_SUBTYPE) {
      const event = parseManagedSessionEvent(body);
      if (!managedSessionKeysEqual(event.sessionKey, sessionKey)) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} belongs to a different session.`,
        );
      }
      const expected = committed + pending.length + 1;
      if (event.sequence !== expected) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} has sequence ${event.sequence} where ${expected} was expected.`,
        );
      }
      pending.push(event);
      continue;
    }
    const marker = parseManagedSessionCommitMarker(body);
    if (marker.previousCommitDigest !== lastMarkerDigest) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} does not chain to the previous commit.`,
      );
    }
    if (
      marker.eventCount !== pending.length ||
      marker.firstSequence !== committed + 1 ||
      marker.lastSequence !== committed + pending.length
    ) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} does not cover the preceding events.`,
      );
    }
    if (marker.eventsDigest !== managedSessionEventsDigest(pending)) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} does not match the preceding event content.`,
      );
    }
    for (const event of pending) {
      if (
        event.kind === 'checkpoint.committed' &&
        (event.payload['coveredSequence'] as number) > committed
      ) {
        throw new ManagedSessionRecordError(
          'checkpoint covers events not committed before its transaction.',
        );
      }
      events.push(event);
      if (event.kind === 'activation.changed') {
        activation = managedSessionActivationStateFrom(event);
      }
    }
    committed = marker.lastSequence;
    committedBytes = scanned;
    lastMarkerDigest = managedToolDigest(
      marker,
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes,
    );
    transactions.set(
      managedSessionCommandKey(marker.operation, marker.commandId),
      {
        contentDigest: marker.contentDigest,
        receipt: {
          transactionId: marker.transactionId,
          commandId: marker.commandId,
          operation: marker.operation,
          firstSequence: marker.firstSequence,
          lastSequence: marker.lastSequence,
          committedSequence: marker.lastSequence,
          replayed: false,
        },
      },
    );
    pending = [];
  }

  return {
    header,
    events,
    transactions,
    committed,
    lastMarkerDigest,
    lastRecordUuid,
    activation,
    committedBytes,
    headerBytes,
    uncommittedBytes: Buffer.byteLength(text, 'utf8') - committedBytes,
    uncommitted: pending.length + tornTail,
    foreignRecords,
    engineRecords,
  };
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, truncate } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileManagedTerminalIdentityStore } from './managed-terminal-identity-store.js';
import type {
  ManagedActivationFence,
  ManagedActivationOutcome,
} from './managed-activation-store.js';
import { MANAGED_SESSION_LIMITS } from './managed-session-records.js';
import {
  MANAGED_JOURNAL_COMPACT_BYTES,
  parseManagedJournalSnapshot,
  replaceManagedJournalWithSnapshot,
  syncManagedJournalDirectory,
} from './managed-journal-snapshot.js';
import {
  FileManagedSessionHistory,
  ManagedHistoryUnavailableError,
  type ManagedHistoryMap,
} from './managed-session-history.js';
import {
  readManagedJournalStream,
  encodeManagedJournalSnapshotStream,
} from './managed-journal-stream.js';

export type ManagedSessionJsonValue =
  | null
  | boolean
  | number
  | string
  | ManagedSessionJsonValue[]
  | { [key: string]: ManagedSessionJsonValue };

export interface ManagedSessionMessageIdentity {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly messageId: string;
}

export interface ManagedSessionUserMessageInput
  extends ManagedSessionMessageIdentity {
  readonly payload: unknown;
}

export interface ManagedSessionUserMessage
  extends ManagedSessionMessageIdentity {
  readonly payloadRef: string;
  readonly payload: ManagedSessionJsonValue;
}

export interface ManagedSessionInboxLimits {
  readonly maxPending: number;
  readonly maxPendingPerTenant: number;
}

export interface ManagedSessionMessageSnapshot {
  readonly message: ManagedSessionUserMessage;
  readonly admittedAt: number;
  readonly admissionSequence: number;
  readonly activationReady: boolean;
  readonly state: 'admitted' | 'processing' | 'finished';
  readonly fence?: ManagedActivationFence;
  readonly outcome?: ManagedActivationOutcome | 'cancelled';
  readonly cancelRequested?: boolean;
  readonly finishedAt?: number;
}

export interface ManagedSessionInboxAdmissionResult {
  readonly created: boolean;
  readonly message: ManagedSessionMessageSnapshot;
}

export interface FileManagedSessionInboxOptions {
  readonly clock?: () => number;
  readonly maxPayloadBytes?: number;
}

export class ManagedSessionInboxAdmissionError extends Error {
  readonly retryable = true;

  constructor(
    readonly code: 'GLOBAL_INBOX_FULL' | 'TENANT_INBOX_FULL',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedSessionInboxAdmissionError';
  }
}

export class ManagedSessionMessageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionMessageConflictError';
  }
}

export class ManagedSessionMessageStaleFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionMessageStaleFenceError';
  }
}

interface MessageState {
  message: ManagedSessionUserMessage;
  admittedAt: number;
  admissionSequence: number;
  activationReady: boolean;
  state: 'admitted' | 'processing' | 'finished';
  fence?: ManagedActivationFence;
  outcome?: ManagedActivationOutcome | 'cancelled';
  cancelRequested?: boolean;
  finishedAt?: number;
}

interface EventBase {
  readonly v: 1;
  readonly sequence: number;
  readonly at: number;
}

type InboxEvent =
  | (EventBase & {
      readonly type: 'user.message.cancel_requested';
      readonly identity: ManagedSessionMessageIdentity;
    })
  | (EventBase & {
      readonly type: 'user.message.admitted';
      readonly message: ManagedSessionUserMessage;
    })
  | (EventBase & {
      readonly type: 'user.message.activation_ready';
      readonly identity: ManagedSessionMessageIdentity;
    })
  | (EventBase & {
      readonly type: 'user.message.processing';
      readonly identity: ManagedSessionMessageIdentity;
      readonly fence: ManagedActivationFence;
    })
  | (EventBase & {
      readonly type: 'user.message.finished';
      readonly identity: ManagedSessionMessageIdentity;
      readonly fence: ManagedActivationFence;
      readonly outcome: ManagedActivationOutcome | 'cancelled';
    });

type JsonObject = Record<string, unknown>;

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_IDENTITY_BYTES = 512;

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function text(value: JsonObject, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (Buffer.byteLength(result, 'utf8') > MAX_IDENTITY_BYTES) {
    throw new Error(
      `${field} must be no larger than ${MAX_IDENTITY_BYTES} UTF-8 bytes.`,
    );
  }
  return result;
}

function integer(value: JsonObject, field: string, minimum = 0): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < minimum) {
    throw new Error(`${field} must be a safe integer >= ${minimum}.`);
  }
  return result as number;
}

function positive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function timestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function identity(value: unknown): ManagedSessionMessageIdentity {
  const record = object(value, 'identity');
  return {
    tenantId: text(record, 'tenantId'),
    sessionId: text(record, 'sessionId'),
    messageId: text(record, 'messageId'),
  };
}

function fence(value: unknown): ManagedActivationFence {
  const record = object(value, 'fence');
  return {
    tenantId: text(record, 'tenantId'),
    sessionId: text(record, 'sessionId'),
    activationId: text(record, 'activationId'),
    workerId: text(record, 'workerId'),
    epoch: integer(record, 'epoch', 1),
  };
}

function outcome(value: unknown): ManagedActivationOutcome | 'cancelled' {
  if (value !== 'completed' && value !== 'failed' && value !== 'cancelled') {
    throw new Error('outcome is invalid.');
  }
  return value;
}

function canonicalJson(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): ManagedSessionJsonValue {
  if (depth > MANAGED_SESSION_LIMITS.maxJsonDepth) {
    throw new Error(
      `payload exceeds the maximum JSON depth of ${MANAGED_SESSION_LIMITS.maxJsonDepth}.`,
    );
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('payload numbers must be finite.');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new Error('payload must contain only JSON values.');
  }
  if (seen.has(value)) throw new Error('payload must not contain cycles.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalJson(item, seen, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('payload objects must be plain JSON objects.');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('payload objects must not contain symbol keys.');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        canonicalJson(item, seen, depth + 1),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

function message(
  value: unknown,
  maxPayloadBytes: number,
): ManagedSessionUserMessage {
  const record = object(value, 'message');
  const messageIdentity = identity(record);
  const payload = canonicalJson(record['payload'], new WeakSet());
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxPayloadBytes) {
    throw new Error(
      `payload exceeds the maximum size of ${maxPayloadBytes} UTF-8 bytes.`,
    );
  }
  const expectedPayloadRef = managedSessionPayloadRef(messageIdentity);
  const suppliedPayloadRef = record['payloadRef'];
  if (
    suppliedPayloadRef !== undefined &&
    suppliedPayloadRef !== expectedPayloadRef
  ) {
    throw new Error('payloadRef does not match the message identity.');
  }
  return {
    ...messageIdentity,
    payloadRef: expectedPayloadRef,
    payload,
  };
}

interface InboxSnapshot {
  readonly type: 'inbox.snapshot';
  readonly state: JsonObject;
}

function parseEvent(
  line: string,
  lineNumber: number,
  maxPayloadBytes: number,
): InboxEvent | InboxSnapshot {
  try {
    const record = object(JSON.parse(line), 'event');
    if (record['type'] === 'inbox.snapshot') {
      return {
        type: 'inbox.snapshot',
        state: parseManagedJournalSnapshot(record),
      };
    }
    if (record['v'] !== 1) throw new Error('version is unsupported.');
    const base = {
      v: 1 as const,
      sequence: integer(record, 'sequence', 1),
      at: integer(record, 'at'),
    };
    switch (record['type']) {
      case 'user.message.admitted':
        return {
          ...base,
          type: 'user.message.admitted',
          message: message(record['message'], maxPayloadBytes),
        };
      case 'user.message.activation_ready':
        return {
          ...base,
          type: 'user.message.activation_ready',
          identity: identity(record['identity']),
        };
      case 'user.message.cancel_requested':
        return {
          ...base,
          type: 'user.message.cancel_requested',
          identity: identity(record['identity']),
        };
      case 'user.message.processing':
        return {
          ...base,
          type: 'user.message.processing',
          identity: identity(record['identity']),
          fence: fence(record['fence']),
        };
      case 'user.message.finished':
        return {
          ...base,
          type: 'user.message.finished',
          identity: identity(record['identity']),
          fence: fence(record['fence']),
          outcome: outcome(record['outcome']),
        };
      default:
        throw new Error('event type is unknown.');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Managed Session inbox line ${lineNumber} is invalid: ${detail}`,
    );
  }
}

function messageKey(value: ManagedSessionMessageIdentity): string {
  return JSON.stringify([value.tenantId, value.sessionId, value.messageId]);
}

function snapshot(state: MessageState): ManagedSessionMessageSnapshot {
  return structuredClone({
    message: state.message,
    admittedAt: state.admittedAt,
    admissionSequence: state.admissionSequence,
    activationReady: state.activationReady,
    state: state.state,
    ...(state.cancelRequested ? { cancelRequested: true } : {}),
    ...(state.fence ? { fence: state.fence } : {}),
    ...(state.outcome ? { outcome: state.outcome } : {}),
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
  });
}

function fenceMatchesMessage(
  messageIdentity: ManagedSessionMessageIdentity,
  activationFence: ManagedActivationFence,
): boolean {
  return (
    messageIdentity.tenantId === activationFence.tenantId &&
    messageIdentity.sessionId === activationFence.sessionId &&
    messageIdentity.messageId === activationFence.activationId
  );
}

export function managedSessionPayloadRef(
  value: ManagedSessionMessageIdentity,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([value.tenantId, value.sessionId, value.messageId]))
    .digest('base64url');
  return `managed-user-message:v1:${digest}`;
}

/** Single-process durable adapter; the same file must have only one owner. */
export class FileManagedSessionInbox {
  private readonly messages = new Map<string, MessageState>();
  private readonly identities: ManagedHistoryMap<MessageState>;
  private overlay: MessageState | undefined;
  private viewFailure: Error | undefined;
  private nextSequence = 1;
  private tail: Promise<void> = Promise.resolve();
  private fatalError: Error | undefined;
  private syncedBytes = 0;
  private snapshotBytes = 0;
  private readonly terminals: FileManagedTerminalIdentityStore<ManagedSessionMessageSnapshot>;

  private constructor(
    readonly filePath: string,
    private readonly clock: () => number,
    private readonly maxPayloadBytes: number,
    private readonly history: FileManagedSessionHistory,
  ) {
    this.identities = history.map<MessageState>('inbox');
    this.terminals = new FileManagedTerminalIdentityStore(filePath, 'inbox');
  }

  static async open(
    filePath: string,
    options: FileManagedSessionInboxOptions = {},
  ): Promise<FileManagedSessionInbox> {
    const maxPayloadBytes =
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    positive('maxPayloadBytes', maxPayloadBytes);
    const store = new FileManagedSessionInbox(
      filePath,
      options.clock ?? Date.now,
      maxPayloadBytes,
      await FileManagedSessionHistory.create(
        path.join(path.dirname(filePath), '.managed-history'),
      ),
    );
    try {
      const scan = await FileManagedSessionInbox.restoreHistory(store);
      if (scan.snapshotBytes > 0) await syncManagedJournalDirectory(filePath);
      if (scan.totalBytes !== scan.syncedBytes)
        await truncate(filePath, scan.syncedBytes);
      store.snapshotBytes = scan.snapshotBytes;
      store.syncedBytes = scan.syncedBytes;
      store.bindHistoryRebuilder();
      return store;
    } catch (error) {
      store.history.discard();
      await store.history.close();
      throw error;
    }
  }

  private bindHistoryRebuilder(): void {
    const nextSequence = this.nextSequence;
    const syncedBytes = this.syncedBytes;
    const unchanged = () =>
      this.nextSequence === nextSequence && this.syncedBytes === syncedBytes;
    this.history.setRebuilder(async (repair) => {
      if (!unchanged())
        throw new ManagedHistoryUnavailableError(
          'Managed inbox canonical prefix changed before history repair.',
        );
      const rebuilt = new FileManagedSessionInbox(
        this.filePath,
        this.clock,
        this.maxPayloadBytes,
        repair,
      );
      const scan = await FileManagedSessionInbox.restoreHistory(rebuilt);
      if (
        !unchanged() ||
        rebuilt.nextSequence !== nextSequence ||
        scan.syncedBytes !== syncedBytes ||
        scan.totalBytes !== syncedBytes
      )
        throw new ManagedHistoryUnavailableError(
          'Managed inbox canonical prefix changed during history repair.',
        );
    });
  }

  private static async restoreHistory(
    store: FileManagedSessionInbox,
  ): Promise<Awaited<ReturnType<typeof readManagedJournalStream>>> {
    let previousSequence = 0;
    return readManagedJournalStream(store.filePath, 'inbox', async (items) => {
      store.history.begin();
      for (const item of items) {
        if (item.type === 'record') {
          const event = parseEvent(
            JSON.stringify(item.record),
            item.line,
            store.maxPayloadBytes,
          );
          if (event.type === 'inbox.snapshot')
            throw new Error('Managed Session inbox snapshot must be first.');
          const state = await store.derive(event);
          store.install(state);
          await store.identities.set(messageKey(state.message), state);
        } else if (item.type === 'snapshot-field') {
          if (item.field === 'nextSequence')
            store.nextSequence = integer(
              { nextSequence: item.value },
              'nextSequence',
              1,
            );
          else
            previousSequence = await store.restoreMessage(
              item.value,
              previousSequence,
            );
        } else if (previousSequence >= store.nextSequence) {
          throw new Error(
            'Inbox snapshot identity, order, or flags are invalid.',
          );
        }
      }
      await store.history.flush();
    });
  }

  admit(
    input: ManagedSessionUserMessageInput,
    limits: ManagedSessionInboxLimits,
  ): Promise<ManagedSessionInboxAdmissionResult> {
    let capturedInput: ManagedSessionUserMessageInput;
    try {
      capturedInput = structuredClone(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const capturedLimits = {
      maxPending: limits.maxPending,
      maxPendingPerTenant: limits.maxPendingPerTenant,
    };
    return this.serial(async () => {
      const at = this.getCurrentTime();
      positive('maxPending', capturedLimits.maxPending);
      positive('maxPendingPerTenant', capturedLimits.maxPendingPerTenant);
      if (capturedLimits.maxPendingPerTenant > capturedLimits.maxPending) {
        throw new Error('maxPendingPerTenant cannot exceed maxPending.');
      }
      const admittedMessage = message(capturedInput, this.maxPayloadBytes);
      const existing = await this.lookup(messageKey(admittedMessage));
      if (existing) {
        if (!isDeepStrictEqual(existing.message, admittedMessage)) {
          throw new ManagedSessionMessageConflictError(
            `Managed Session message ${JSON.stringify(admittedMessage.messageId)} was reused with different data.`,
          );
        }
        return {
          created: false,
          message:
            existing.state === 'finished'
              ? await this.readTerminalState(existing)
              : snapshot(existing),
        };
      }

      const pending = [...this.messages.values()].filter(
        (state) => state.state !== 'finished',
      );
      if (pending.length >= capturedLimits.maxPending) {
        throw new ManagedSessionInboxAdmissionError(
          'GLOBAL_INBOX_FULL',
          `Managed Session inbox is full (${capturedLimits.maxPending}).`,
        );
      }
      if (
        pending.filter(
          (state) => state.message.tenantId === admittedMessage.tenantId,
        ).length >= capturedLimits.maxPendingPerTenant
      ) {
        throw new ManagedSessionInboxAdmissionError(
          'TENANT_INBOX_FULL',
          `Managed Session inbox for tenant ${JSON.stringify(admittedMessage.tenantId)} is full (${capturedLimits.maxPendingPerTenant}).`,
        );
      }

      await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at,
        type: 'user.message.admitted',
        message: admittedMessage,
      });
      return {
        created: true,
        message: snapshot(this.messages.get(messageKey(admittedMessage))!),
      };
    });
  }

  markActivationReady(
    input: ManagedSessionMessageIdentity,
  ): Promise<ManagedSessionMessageSnapshot> {
    const capturedInput = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      messageId: input.messageId,
    };
    return this.serial(async () => {
      const messageIdentity = identity(capturedInput);
      const state = await this.required(messageIdentity);
      if (state.activationReady) return snapshot(state);
      if (state.state !== 'admitted') {
        throw new Error('Managed Session message is already finished.');
      }
      const committed = await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at: this.getCurrentTime(),
        type: 'user.message.activation_ready',
        identity: messageIdentity,
      });
      return snapshot(committed);
    });
  }

  beginProcessing(
    input: ManagedSessionMessageIdentity,
    inputFence: ManagedActivationFence,
  ): Promise<ManagedSessionMessageSnapshot> {
    const capturedInput = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      messageId: input.messageId,
    };
    const capturedFence = {
      tenantId: inputFence.tenantId,
      sessionId: inputFence.sessionId,
      activationId: inputFence.activationId,
      workerId: inputFence.workerId,
      epoch: inputFence.epoch,
    };
    return this.serial(async () => {
      const messageIdentity = identity(capturedInput);
      const activationFence = fence(capturedFence);
      const state = await this.required(messageIdentity);
      this.assertFenceIdentity(messageIdentity, activationFence);
      if (!state.activationReady) {
        throw new Error('Managed Session message activation is not ready.');
      }
      if (state.state === 'finished') {
        throw this.staleFence(messageIdentity, activationFence);
      }
      if (state.fence) {
        if (isDeepStrictEqual(state.fence, activationFence)) {
          return snapshot(state);
        }
        if (activationFence.epoch <= state.fence.epoch) {
          throw this.staleFence(messageIdentity, activationFence);
        }
      }
      const committed = await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at: this.getCurrentTime(),
        type: 'user.message.processing',
        identity: messageIdentity,
        fence: activationFence,
      });
      return snapshot(committed);
    });
  }

  requestCancel(
    input: ManagedSessionMessageIdentity,
  ): Promise<ManagedSessionMessageSnapshot> {
    const captured = structuredClone(input);
    return this.serial(async () => {
      const messageIdentity = identity(captured);
      const state = await this.required(messageIdentity);
      if (state.state === 'finished' || state.cancelRequested)
        return snapshot(state);
      const committed = await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at: this.getCurrentTime(),
        type: 'user.message.cancel_requested',
        identity: messageIdentity,
      });
      return snapshot(committed);
    });
  }

  finish(
    input: ManagedSessionMessageIdentity,
    inputFence: ManagedActivationFence,
    inputOutcome: ManagedActivationOutcome | 'cancelled',
  ): Promise<ManagedSessionMessageSnapshot> {
    const capturedInput = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      messageId: input.messageId,
    };
    const capturedFence = {
      tenantId: inputFence.tenantId,
      sessionId: inputFence.sessionId,
      activationId: inputFence.activationId,
      workerId: inputFence.workerId,
      epoch: inputFence.epoch,
    };
    const capturedOutcome = inputOutcome;
    return this.serial(async () => {
      const messageIdentity = identity(capturedInput);
      const activationFence = fence(capturedFence);
      const finishedOutcome = outcome(capturedOutcome);
      const state = await this.required(messageIdentity);
      this.assertFenceIdentity(messageIdentity, activationFence);
      if (state.state === 'finished') {
        if (
          isDeepStrictEqual(state.fence, activationFence) &&
          state.outcome === finishedOutcome
        ) {
          return snapshot(state);
        }
        throw this.staleFence(messageIdentity, activationFence);
      }
      if (
        state.state !== 'processing' ||
        !isDeepStrictEqual(state.fence, activationFence)
      ) {
        throw this.staleFence(messageIdentity, activationFence);
      }
      const committed = await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at: this.getCurrentTime(),
        type: 'user.message.finished',
        identity: messageIdentity,
        fence: activationFence,
        outcome: finishedOutcome,
      });
      return snapshot(committed);
    });
  }

  readTerminal(
    input: ManagedSessionMessageIdentity,
  ): Promise<ManagedSessionMessageSnapshot | undefined> {
    const captured = structuredClone(input);
    return this.serial(async () => {
      const state = await this.lookup(messageKey(identity(captured)));
      return state?.state === 'finished'
        ? this.readTerminalState(state)
        : undefined;
    });
  }

  private readTerminalState(
    state: MessageState,
  ): Promise<ManagedSessionMessageSnapshot> {
    const { tenantId, sessionId, messageId } = state.message;
    return this.terminals.read(
      [tenantId, sessionId, messageId],
      snapshot(state),
    );
  }

  async get(
    input: ManagedSessionMessageIdentity,
  ): Promise<ManagedSessionMessageSnapshot | undefined> {
    const key = messageKey(input);
    await this.tail;
    const state = await this.lookup(key);
    return state ? snapshot(state) : undefined;
  }

  async getByPayloadRef(
    input: ManagedSessionMessageIdentity,
    payloadRef: string,
  ): Promise<ManagedSessionMessageSnapshot | undefined> {
    if (payloadRef !== managedSessionPayloadRef(input)) {
      throw new Error('payloadRef does not match the message identity.');
    }
    return this.get(input);
  }

  listPending(): ManagedSessionMessageSnapshot[] {
    return [...this.messages.values()]
      .filter((state) => state.state !== 'finished')
      .sort((left, right) => left.admissionSequence - right.admissionSequence)
      .map(snapshot);
  }

  async *listAll(): AsyncGenerator<ManagedSessionMessageSnapshot> {
    await this.tail;
    const overlay = this.overlay;
    let included = false;
    for await (const state of this.identities.values()) {
      if (
        overlay &&
        messageKey(overlay.message) === messageKey(state.message)
      ) {
        yield snapshot(overlay);
        included = true;
      } else yield snapshot(state);
    }
    if (overlay && !included) yield snapshot(overlay);
  }

  get haltedError(): Error | undefined {
    return this.fatalError ?? this.viewFailure;
  }

  async close(): Promise<void> {
    await this.tail;
    await this.history.close();
  }

  private lookup(key: string): Promise<MessageState | undefined> {
    return Promise.resolve(
      this.overlay && messageKey(this.overlay.message) === key
        ? this.overlay
        : (this.messages.get(key) ?? this.identities.get(key)),
    );
  }

  private getCurrentTime(): number {
    const value = this.clock();
    timestamp('clock', value);
    return value;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.fatalError) throw this.fatalError;
      return operation();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(event: InboxEvent): Promise<MessageState> {
    if (this.viewFailure) throw this.viewFailure;
    await this.compactIfNeeded();
    const state = await this.derive(event);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, bytes, { flush: true, mode: 0o600 });
    } catch (error) {
      this.fatalError =
        error instanceof Error ? error : new Error(String(error));
      throw this.fatalError;
    }
    this.install(state);
    this.overlay = state;
    this.syncedBytes += bytes.byteLength;
    try {
      this.history.begin();
      await this.identities.set(messageKey(state.message), state);
      await this.history.flush();
      this.overlay = undefined;
    } catch (error) {
      this.history.discard();
      this.viewFailure =
        error instanceof Error ? error : new Error(String(error));
    }
    this.bindHistoryRebuilder();
    return state;
  }

  private async compactIfNeeded(): Promise<void> {
    if (
      this.syncedBytes - this.snapshotBytes <
      Math.max(MANAGED_JOURNAL_COMPACT_BYTES, this.snapshotBytes)
    ) {
      return;
    }
    let byteLength = 0;
    const state = async function* (store: FileManagedSessionInbox) {
      yield Buffer.from(`{"nextSequence":${store.nextSequence},"messages":[`);
      let first = true;
      for await (const entry of store.identities.values()) {
        yield Buffer.from(
          `${first ? '' : ','}${JSON.stringify(snapshot(entry))}`,
        );
        first = false;
      }
      yield Buffer.from(']}');
    };
    const bytes = async function* (store: FileManagedSessionInbox) {
      for await (const piece of encodeManagedJournalSnapshotStream(
        'inbox.snapshot',
        state(store),
      )) {
        byteLength += piece.byteLength;
        yield piece;
      }
    };
    try {
      await replaceManagedJournalWithSnapshot(this.filePath, bytes(this));
      this.syncedBytes = this.snapshotBytes = byteLength;
      this.bindHistoryRebuilder();
    } catch (error) {
      this.fatalError =
        error instanceof Error ? error : new Error(String(error));
      throw this.fatalError;
    }
  }

  private async restoreMessage(
    item: unknown,
    previousSequence: number,
  ): Promise<number> {
    const record = object(item, 'message snapshot');
    const savedMessage = message(record['message'], this.maxPayloadBytes);
    const admissionSequence = integer(record, 'admissionSequence', 1);
    if (
      admissionSequence <= previousSequence ||
      (await this.identities.has(messageKey(savedMessage))) ||
      typeof record['activationReady'] !== 'boolean' ||
      (record['cancelRequested'] !== undefined &&
        record['cancelRequested'] !== true)
    ) {
      throw new Error('Inbox snapshot identity, order, or flags are invalid.');
    }
    const state: MessageState = {
      message: savedMessage,
      admittedAt: integer(record, 'admittedAt'),
      admissionSequence,
      activationReady: record['activationReady'],
      state: record['state'] as MessageState['state'],
    };
    if (record['cancelRequested'] === true) state.cancelRequested = true;
    if (record['fence'] !== undefined) {
      state.fence = fence(record['fence']);
      this.assertFenceIdentity(savedMessage, state.fence);
      if (!state.activationReady) {
        throw new Error('Inbox snapshot fence requires activation readiness.');
      }
    }
    if (state.state === 'finished') {
      state.outcome = outcome(record['outcome']);
      state.finishedAt = integer(record, 'finishedAt');
      if (
        !state.fence &&
        !(state.cancelRequested && state.outcome === 'cancelled')
      ) {
        throw new Error('Inbox snapshot terminal has no processing fence.');
      }
    } else if (
      !['admitted', 'processing'].includes(state.state) ||
      record['outcome'] !== undefined ||
      record['finishedAt'] !== undefined
    ) {
      throw new Error('Inbox snapshot terminal state is invalid.');
    }
    if (
      (state.state === 'processing' && !state.fence) ||
      (state.state === 'admitted' && (state.fence || state.cancelRequested))
    ) {
      throw new Error('Inbox snapshot processing state is invalid.');
    }
    await this.identities.set(messageKey(savedMessage), state);
    if (state.state !== 'finished')
      this.messages.set(messageKey(savedMessage), state);
    return admissionSequence;
  }

  private async derive(event: InboxEvent): Promise<MessageState> {
    if (event.sequence !== this.nextSequence)
      throw new Error(
        `Expected inbox sequence ${this.nextSequence}, got ${event.sequence}.`,
      );
    timestamp('event.at', event.at);
    if (event.type === 'user.message.admitted') {
      if (await this.lookup(messageKey(event.message)))
        throw new Error('Inbox admits the same message twice.');
      return {
        message: structuredClone(event.message),
        admittedAt: event.at,
        admissionSequence: event.sequence,
        activationReady: false,
        state: 'admitted',
      };
    }
    const state = structuredClone(await this.required(event.identity));
    if (event.type === 'user.message.activation_ready') {
      if (state.activationReady || state.state !== 'admitted')
        throw new Error(
          'Inbox contains an invalid activation readiness marker.',
        );
      state.activationReady = true;
    } else if (event.type === 'user.message.cancel_requested') {
      if (state.state === 'finished' || state.cancelRequested)
        throw new Error('Inbox contains an invalid cancellation request.');
      state.cancelRequested = true;
      if (state.state === 'admitted') {
        state.state = 'finished';
        state.outcome = 'cancelled';
        state.finishedAt = event.at;
      }
    } else if (event.type === 'user.message.processing') {
      this.assertFenceIdentity(event.identity, event.fence);
      if (
        !state.activationReady ||
        state.state === 'finished' ||
        (state.fence !== undefined && event.fence.epoch <= state.fence.epoch)
      )
        throw new Error('Inbox contains an invalid processing fence.');
      state.state = 'processing';
      state.fence = structuredClone(event.fence);
    } else {
      this.assertFenceIdentity(event.identity, event.fence);
      if (
        state.state !== 'processing' ||
        !isDeepStrictEqual(state.fence, event.fence)
      )
        throw new Error('Inbox contains an invalid message terminal.');
      state.state = 'finished';
      state.outcome = event.outcome;
      state.finishedAt = event.at;
    }
    return state;
  }

  private install(state: MessageState): void {
    const key = messageKey(state.message);
    if (state.state === 'finished') this.messages.delete(key);
    else this.messages.set(key, state);
    this.nextSequence++;
  }

  private async required(
    input: ManagedSessionMessageIdentity,
  ): Promise<MessageState> {
    const state = await this.lookup(messageKey(input));
    if (!state)
      throw new Error(
        `Managed Session message ${JSON.stringify(input.messageId)} not found.`,
      );
    return state;
  }

  private assertFenceIdentity(
    messageIdentity: ManagedSessionMessageIdentity,
    activationFence: ManagedActivationFence,
  ): void {
    if (!fenceMatchesMessage(messageIdentity, activationFence)) {
      throw new Error('Activation fence does not match the message identity.');
    }
  }

  private staleFence(
    messageIdentity: ManagedSessionMessageIdentity,
    activationFence: ManagedActivationFence,
  ): ManagedSessionMessageStaleFenceError {
    return new ManagedSessionMessageStaleFenceError(
      `Managed Session message ${JSON.stringify(messageIdentity.messageId)} fence at epoch ${activationFence.epoch} is stale.`,
    );
  }
}

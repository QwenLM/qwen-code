/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export interface ManagedActivationIdentity {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly activationId: string;
}

export interface ManagedActivationDescriptor extends ManagedActivationIdentity {
  readonly payloadRef: string;
  readonly reason: 'user_message';
  readonly recovery: 'replay_safe';
}

export interface ManagedActivationFence extends ManagedActivationIdentity {
  readonly workerId: string;
  readonly epoch: number;
}

export interface ManagedActivationLease extends ManagedActivationFence {
  readonly expiresAt: number;
}

export type ManagedActivationOutcome = 'completed' | 'failed';

export interface ManagedActivationSnapshot {
  readonly descriptor: ManagedActivationDescriptor;
  readonly queuedAt: number;
  readonly queueSequence: number;
  readonly status: 'queued' | 'assigned' | 'released';
  readonly lease?: ManagedActivationLease;
  readonly outcome?: ManagedActivationOutcome;
  readonly releasedAt?: number;
}

export interface ManagedActivationQueueLimits {
  readonly maxQueued: number;
  readonly maxQueuedPerTenant: number;
}

export interface ManagedActivationEnqueueResult {
  readonly created: boolean;
  readonly activation: ManagedActivationSnapshot;
}

export interface FileManagedActivationStoreOptions {
  readonly clock?: () => number;
}

export class ManagedActivationAdmissionError extends Error {
  readonly retryable = true;

  constructor(
    readonly code: 'GLOBAL_QUEUE_FULL' | 'TENANT_QUEUE_FULL',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedActivationAdmissionError';
  }
}

export class ManagedActivationStaleLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedActivationStaleLeaseError';
  }
}

interface ActivationState {
  descriptor: ManagedActivationDescriptor;
  queuedAt: number;
  queueSequence: number;
  status: 'queued' | 'assigned' | 'released';
  lease?: ManagedActivationLease;
  outcome?: ManagedActivationOutcome;
  releasedAt?: number;
}

interface EventBase {
  readonly v: 1;
  readonly sequence: number;
  readonly at: number;
}

type JournalEvent =
  | (EventBase & {
      readonly type: 'activation.cancelled';
      readonly identity: ManagedActivationIdentity;
    })
  | (EventBase & {
      readonly type: 'activation.queued';
      readonly activation: ManagedActivationDescriptor;
    })
  | (EventBase & {
      readonly type: 'activation.assigned';
      readonly lease: ManagedActivationLease;
    })
  | (EventBase & {
      readonly type: 'activation.renewed';
      readonly lease: ManagedActivationLease;
    })
  | (EventBase & {
      readonly type: 'activation.released';
      readonly identity: ManagedActivationIdentity;
      readonly workerId: string;
      readonly epoch: number;
      readonly outcome: ManagedActivationOutcome;
    });

type JsonObject = Record<string, unknown>;

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

function identity(value: unknown): ManagedActivationIdentity {
  const record = object(value, 'identity');
  return {
    tenantId: text(record, 'tenantId'),
    sessionId: text(record, 'sessionId'),
    activationId: text(record, 'activationId'),
  };
}

function descriptor(value: unknown): ManagedActivationDescriptor {
  const record = object(value, 'activation');
  const reason = record['reason'];
  if (reason !== 'user_message') {
    throw new Error('reason is invalid.');
  }
  if (record['recovery'] !== 'replay_safe') {
    throw new Error("recovery must be 'replay_safe'.");
  }
  return {
    ...identity(record),
    payloadRef: text(record, 'payloadRef'),
    reason,
    recovery: 'replay_safe',
  };
}

function lease(value: unknown): ManagedActivationLease {
  const record = object(value, 'lease');
  return {
    ...identity(record),
    workerId: text(record, 'workerId'),
    epoch: integer(record, 'epoch', 1),
    expiresAt: integer(record, 'expiresAt'),
  };
}

function outcome(value: unknown): ManagedActivationOutcome {
  if (value !== 'completed' && value !== 'failed') {
    throw new Error('outcome is invalid.');
  }
  return value;
}

function parseEvent(line: string, lineNumber: number): JournalEvent {
  try {
    const record = object(JSON.parse(line), 'event');
    if (record['v'] !== 1) throw new Error('version is unsupported.');
    const base = {
      v: 1 as const,
      sequence: integer(record, 'sequence', 1),
      at: integer(record, 'at'),
    };
    switch (record['type']) {
      case 'activation.queued':
        return {
          ...base,
          type: 'activation.queued',
          activation: descriptor(record['activation']),
        };
      case 'activation.assigned':
      case 'activation.renewed':
        return { ...base, type: record['type'], lease: lease(record['lease']) };
      case 'activation.cancelled':
        return {
          ...base,
          type: 'activation.cancelled',
          identity: identity(record['identity']),
        };
      case 'activation.released':
        return {
          ...base,
          type: 'activation.released',
          identity: identity(record['identity']),
          workerId: text(record, 'workerId'),
          epoch: integer(record, 'epoch', 1),
          outcome: outcome(record['outcome']),
        };
      default:
        throw new Error('event type is unknown.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Managed activation journal line ${lineNumber} is invalid: ${message}`,
    );
  }
}

function activationKey(value: ManagedActivationIdentity): string {
  return JSON.stringify([value.tenantId, value.sessionId, value.activationId]);
}

function sessionKey(value: ManagedActivationIdentity): string {
  return JSON.stringify([value.tenantId, value.sessionId]);
}

function snapshot(state: ActivationState): ManagedActivationSnapshot {
  return structuredClone({
    descriptor: state.descriptor,
    queuedAt: state.queuedAt,
    queueSequence: state.queueSequence,
    status: state.status,
    ...(state.lease ? { lease: state.lease } : {}),
    ...(state.outcome ? { outcome: state.outcome } : {}),
    ...(state.releasedAt === undefined ? {} : { releasedAt: state.releasedAt }),
  });
}

/** Single-process durable adapter; the same file must have only one owner. */
export class FileManagedActivationStore {
  private readonly activations = new Map<string, ActivationState>();
  private readonly nextEpoch = new Map<string, number>();
  private nextSequence = 1;
  private tail: Promise<void> = Promise.resolve();
  private fatalError: Error | undefined;

  private constructor(
    readonly filePath: string,
    private readonly clock: () => number,
  ) {}

  static async open(
    filePath: string,
    options: FileManagedActivationStoreOptions = {},
  ): Promise<FileManagedActivationStore> {
    const store = new FileManagedActivationStore(
      filePath,
      options.clock ?? Date.now,
    );
    let contents: Buffer;
    try {
      contents = await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw error;
    }
    const complete =
      contents.length === 0 || contents[contents.length - 1] === 0x0a;
    const validLength = complete
      ? contents.length
      : contents.lastIndexOf(0x0a) + 1;
    const lines = contents
      .subarray(0, validLength)
      .toString('utf8')
      .split('\n');
    lines.pop();
    lines.forEach((line, index) => {
      if (!line) {
        throw new Error(
          `Managed activation journal line ${index + 1} is empty.`,
        );
      }
      store.apply(parseEvent(line, index + 1));
    });
    if (!complete) await truncate(filePath, validLength);
    return store;
  }

  enqueue(
    input: ManagedActivationDescriptor,
    limits: ManagedActivationQueueLimits,
  ): Promise<ManagedActivationEnqueueResult> {
    return this.serial(async () => {
      const at = this.getCurrentTime();
      const activation = descriptor(input);
      positive('maxQueued', limits.maxQueued);
      positive('maxQueuedPerTenant', limits.maxQueuedPerTenant);
      if (limits.maxQueuedPerTenant > limits.maxQueued) {
        throw new Error('maxQueuedPerTenant cannot exceed maxQueued.');
      }
      const existing = this.activations.get(activationKey(activation));
      if (existing) {
        if (!isDeepStrictEqual(existing.descriptor, activation)) {
          throw new Error(
            `Managed activation '${activation.activationId}' was reused with different data.`,
          );
        }
        return { created: false, activation: snapshot(existing) };
      }

      const queued = [...this.activations.values()].filter(
        (state) => state.status === 'queued',
      );
      if (queued.length >= limits.maxQueued) {
        throw new ManagedActivationAdmissionError(
          'GLOBAL_QUEUE_FULL',
          `Managed activation queue is full (${limits.maxQueued}).`,
        );
      }
      if (
        queued.filter(
          (state) => state.descriptor.tenantId === activation.tenantId,
        ).length >= limits.maxQueuedPerTenant
      ) {
        throw new ManagedActivationAdmissionError(
          'TENANT_QUEUE_FULL',
          `Managed activation queue for tenant '${activation.tenantId}' is full (${limits.maxQueuedPerTenant}).`,
        );
      }

      await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at,
        type: 'activation.queued',
        activation,
      });
      return {
        created: true,
        activation: snapshot(this.activations.get(activationKey(activation))!),
      };
    });
  }

  cancelQueued(input: ManagedActivationIdentity): Promise<boolean> {
    const captured = structuredClone(input);
    return this.serial(async () => {
      const activation = identity(captured);
      const state = this.activations.get(activationKey(activation));
      if (!state || state.status !== 'queued') return false;
      await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at: this.getCurrentTime(),
        type: 'activation.cancelled',
        identity: activation,
      });
      return true;
    });
  }

  claim(
    input: ManagedActivationIdentity,
    workerId: string,
    leaseDurationMs: number,
  ): Promise<ManagedActivationLease | undefined> {
    return this.serial(async () => {
      const at = this.getCurrentTime();
      const activation = identity(input);
      if (!workerId.trim()) throw new Error('workerId must be non-empty.');
      positive('leaseDurationMs', leaseDurationMs);
      const state = this.activations.get(activationKey(activation));
      if (
        !state ||
        state.status === 'released' ||
        (state.status === 'assigned' && state.lease!.expiresAt > at) ||
        !this.isOldest(state)
      ) {
        return undefined;
      }
      const expiresAt = at + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error('lease expiry exceeds safe integer range.');
      }
      const key = sessionKey(activation);
      const assigned: ManagedActivationLease = {
        ...activation,
        workerId,
        epoch: this.nextEpoch.get(key) ?? 1,
        expiresAt,
      };
      await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at,
        type: 'activation.assigned',
        lease: assigned,
      });
      return structuredClone(assigned);
    });
  }

  renew(
    input: ManagedActivationLease,
    leaseDurationMs: number,
  ): Promise<ManagedActivationLease> {
    return this.serial(async () => {
      const at = this.getCurrentTime();
      const currentLease = lease(input);
      positive('leaseDurationMs', leaseDurationMs);
      const state = this.current(currentLease, at);
      const expiresAt = at + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error('lease expiry exceeds safe integer range.');
      }
      const renewed = { ...state.lease!, expiresAt };
      await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at,
        type: 'activation.renewed',
        lease: renewed,
      });
      return structuredClone(renewed);
    });
  }

  release(
    input: ManagedActivationLease,
    result: ManagedActivationOutcome,
  ): Promise<ManagedActivationSnapshot> {
    return this.serial(async () => {
      const at = this.getCurrentTime();
      const currentLease = lease(input);
      this.current(currentLease, at);
      const releaseOutcome = outcome(result);
      await this.persist({
        v: 1,
        sequence: this.nextSequence,
        at,
        type: 'activation.released',
        identity: identity(currentLease),
        workerId: currentLease.workerId,
        epoch: currentLease.epoch,
        outcome: releaseOutcome,
      });
      return snapshot(this.activations.get(activationKey(currentLease))!);
    });
  }

  get(input: ManagedActivationIdentity): ManagedActivationSnapshot | undefined {
    const state = this.activations.get(activationKey(input));
    return state ? snapshot(state) : undefined;
  }

  listPending(): ManagedActivationSnapshot[] {
    return [...this.activations.values()]
      .filter((state) => state.status !== 'released')
      .sort((left, right) => left.queueSequence - right.queueSequence)
      .map(snapshot);
  }

  listRunnable(): ManagedActivationSnapshot[] {
    const at = this.getCurrentTime();
    const first = new Map<string, ActivationState>();
    for (const state of this.activations.values()) {
      if (state.status === 'released') continue;
      const key = sessionKey(state.descriptor);
      if (!first.has(key)) first.set(key, state);
    }
    return [...first.values()]
      .filter(
        (state) => state.status === 'queued' || state.lease!.expiresAt <= at,
      )
      .sort((left, right) => left.queueSequence - right.queueSequence)
      .map(snapshot);
  }

  getCurrentTime(): number {
    const value = this.clock();
    timestamp('clock', value);
    return value;
  }

  get haltedError(): Error | undefined {
    return this.fatalError;
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

  private async persist(event: JournalEvent): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(
        this.filePath,
        Buffer.from(`${JSON.stringify(event)}\n`),
        {
          flush: true,
          mode: 0o600,
        },
      );
      this.apply(event);
    } catch (error) {
      this.fatalError =
        error instanceof Error ? error : new Error(String(error));
      throw this.fatalError;
    }
  }

  private apply(event: JournalEvent): void {
    if (event.sequence !== this.nextSequence) {
      throw new Error(
        `Expected journal sequence ${this.nextSequence}, got ${event.sequence}.`,
      );
    }
    timestamp('event.at', event.at);
    if (event.type === 'activation.queued') {
      if (this.activations.has(activationKey(event.activation))) {
        throw new Error('Journal queues the same activation twice.');
      }
      this.activations.set(activationKey(event.activation), {
        descriptor: structuredClone(event.activation),
        queuedAt: event.at,
        queueSequence: event.sequence,
        status: 'queued',
      });
    } else if (event.type === 'activation.cancelled') {
      const state = this.activations.get(activationKey(event.identity));
      if (!state || state.status !== 'queued')
        throw new Error('Journal contains an invalid queued cancellation.');
      state.status = 'released';
      state.outcome = 'failed';
      state.releasedAt = event.at;
    } else if (event.type === 'activation.assigned') {
      const state = this.activations.get(activationKey(event.lease));
      const expectedEpoch = this.nextEpoch.get(sessionKey(event.lease)) ?? 1;
      if (
        !state ||
        state.status === 'released' ||
        !this.isOldest(state) ||
        (state.status === 'assigned' && state.lease!.expiresAt > event.at) ||
        event.lease.epoch !== expectedEpoch ||
        event.lease.expiresAt <= event.at
      ) {
        throw new Error('Journal contains an invalid activation assignment.');
      }
      state.status = 'assigned';
      state.lease = structuredClone(event.lease);
      this.nextEpoch.set(sessionKey(event.lease), expectedEpoch + 1);
    } else if (event.type === 'activation.renewed') {
      const state = this.current(event.lease, event.at);
      if (event.lease.expiresAt <= state.lease!.expiresAt) {
        throw new Error('Journal renewal does not extend the lease.');
      }
      state.lease = structuredClone(event.lease);
    } else {
      const state = this.current(
        {
          ...event.identity,
          workerId: event.workerId,
          epoch: event.epoch,
        },
        event.at,
      );
      state.status = 'released';
      state.outcome = event.outcome;
      state.releasedAt = event.at;
      delete state.lease;
    }
    this.nextSequence += 1;
  }

  private current(input: ManagedActivationFence, at: number): ActivationState {
    const state = this.activations.get(activationKey(input));
    if (
      !state ||
      state.status !== 'assigned' ||
      state.lease!.workerId !== input.workerId ||
      state.lease!.epoch !== input.epoch ||
      state.lease!.expiresAt <= at
    ) {
      throw new ManagedActivationStaleLeaseError(
        `Managed activation lease '${input.activationId}' at epoch ${input.epoch} is stale.`,
      );
    }
    return state;
  }

  private isOldest(candidate: ActivationState): boolean {
    const key = sessionKey(candidate.descriptor);
    return ![...this.activations.values()].some(
      (state) =>
        state.status !== 'released' &&
        state.queueSequence < candidate.queueSequence &&
        sessionKey(state.descriptor) === key,
    );
  }
}

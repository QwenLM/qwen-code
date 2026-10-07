/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isExtensionRunStart,
  isExtensionRunSuccessor,
  parseExtensionRun,
  type ExtensionRun,
  type ExtensionRunState,
} from './managed-extension-record.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  assertManagedSessionTime,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// H5a of #12827: the `managed-channel_route` and `managed-channel_delivery`
// record bodies, schema version 1. A route is the durable binding of one
// authenticated (instance, account, sender, chat, thread) scope to one
// Session; a delivery is one formal result sent out through that binding,
// chain-keyed by deliveryId with one receipt per segment. Neither is a
// Session task, so both register with taskKind null. Both domains stay
// disabled for submission until the slices that ship their producers (H5b
// inbound, H5c outbound); the shared fixtures in
// contracts/managed-channel-record-v1.fixtures.json pin both validators,
// and ManagedChannelRecords in packages/sdk-java/managed-agent-server
// replays the same cases.

/** The route scope kinds, preserving the Legacy router's semantics. */
export const CHANNEL_ROUTE_SCOPE_KINDS = [
  'user',
  'chat_thread',
  'thread',
  'single',
] as const;
export type ChannelRouteScopeKind = (typeof CHANNEL_ROUTE_SCOPE_KINDS)[number];

/** The most segments one delivery plan may carry. */
export const CHANNEL_DELIVERY_MAX_SEGMENTS = 64;

export interface ChannelRouteScope {
  readonly kind: ChannelRouteScopeKind;
  readonly senderId: string | null;
  readonly chatId: string | null;
  readonly threadId: string | null;
}

export interface ChannelRoute {
  readonly routeId: string;
  readonly channelInstanceId: string;
  readonly accountId: string;
  /** The provider-side account generation: a re-key advances it. */
  readonly accountGeneration: number;
  /** The route binding revision: a rebind or rollover advances it. */
  readonly routeRevision: number;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly scope: ChannelRouteScope;
  /** The admission policy (allowed senders, gates) as a durable pin. */
  readonly policyRef: ManagedSessionDurableRef;
  readonly run: ExtensionRun;
}

export interface ChannelDeliveryReceipt {
  readonly providerMessageId: string;
  readonly acceptedAt: number;
  /** The provider's send response, when one was retained. */
  readonly proofRef: ManagedSessionDurableRef | null;
}

export interface ChannelDeliverySegment {
  readonly segmentId: string;
  readonly ordinal: number;
  readonly contentRef: ManagedSessionDurableRef;
  readonly receipt: ChannelDeliveryReceipt | null;
}

export interface ChannelDelivery {
  readonly deliveryId: string;
  readonly routeId: string;
  /** The route binding revision the delivery was planned against. */
  readonly routeRevision: number;
  readonly sourceTurnId: string;
  /** The formal result the segments were split from. */
  readonly contentRef: ManagedSessionDurableRef;
  readonly segments: readonly ChannelDeliverySegment[];
  readonly cancelRequested: boolean;
  readonly run: ExtensionRun;
}

const ROUTE_KEYS = [
  'routeId',
  'channelInstanceId',
  'accountId',
  'accountGeneration',
  'routeRevision',
  'rootSessionId',
  'sessionId',
  'scope',
  'policyRef',
  'run',
] as const;
const DELIVERY_KEYS = [
  'deliveryId',
  'routeId',
  'routeRevision',
  'sourceTurnId',
  'contentRef',
  'segments',
  'cancelRequested',
  'run',
] as const;
const SCOPE_KEYS = ['kind', 'senderId', 'chatId', 'threadId'] as const;
const SEGMENT_KEYS = ['segmentId', 'ordinal', 'contentRef', 'receipt'] as const;
const RECEIPT_KEYS = ['providerMessageId', 'acceptedAt', 'proofRef'] as const;
/** The route fields a rebind revision may change, and only then. */
const REBIND_KEYS = [
  'accountGeneration',
  'routeRevision',
  'rootSessionId',
  'sessionId',
  'policyRef',
] as const;

const TERMINAL_RUN_STATES: readonly ExtensionRunState[] = [
  'settled',
  'failed',
  'cancelled',
];

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function closed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Record<Key, ManagedSessionJsonValue> {
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key as Key))
  ) {
    fail(`Channel record must have exactly the keys ${keys.join(', ')}.`);
  }
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function id(value: ManagedSessionJsonValue, label: string): string {
  return assertManagedSessionStableId(value, label);
}

function revision(value: ManagedSessionJsonValue, label: string): number {
  const parsed = assertManagedSessionSequence(value, label);
  if (parsed < 1) fail(`${label} must be positive.`);
  return parsed;
}

function ref(value: ManagedSessionJsonValue, label: string) {
  return Object.freeze(assertManagedSessionDurableRef(value, label));
}

function parseScope(value: ManagedSessionJsonValue): ChannelRouteScope {
  const body = closed(value, SCOPE_KEYS);
  const kind = body.kind;
  if (
    kind !== 'user' &&
    kind !== 'chat_thread' &&
    kind !== 'thread' &&
    kind !== 'single'
  ) {
    fail(
      'Channel route scope kind must be user, chat_thread, thread or single.',
    );
  }
  const nullableId = (
    field: ManagedSessionJsonValue,
    label: string,
  ): string | null => (field === null ? null : id(field, label));
  const scope: ChannelRouteScope = {
    kind,
    senderId: nullableId(body.senderId, 'scope.senderId'),
    chatId: nullableId(body.chatId, 'scope.chatId'),
    threadId: nullableId(body.threadId, 'scope.threadId'),
  };
  // The carriers the Legacy routing key derives per scope: user keys on the
  // sender inside its chat, thread keys on the thread when there is one and
  // on the chat else, chat_thread keys on the chat and only refines to one
  // of its threads, and single keys on the instance alone.
  const { senderId, chatId, threadId } = scope;
  const carries =
    scope.kind === 'user'
      ? senderId !== null && chatId !== null && threadId === null
      : scope.kind === 'thread'
        ? senderId === null && (chatId === null) !== (threadId === null)
        : scope.kind === 'chat_thread'
          ? senderId === null && chatId !== null
          : senderId === null && chatId === null && threadId === null;
  if (!carries) {
    fail(`Channel route scope ${scope.kind} does not carry its identity.`);
  }
  return Object.freeze(scope);
}

function routeRun(value: unknown, routeId: string): ExtensionRun {
  const run = parseExtensionRun(value);
  if (
    run.definition !== null ||
    run.executionCallId !== null ||
    run.effectId !== routeId ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.execution !== null ||
    run.runtime !== null ||
    run.delivery !== null
  ) {
    fail('Channel route run must identify its effect and nothing else.');
  }
  return run;
}

export function parseChannelRoute(value: unknown): ChannelRoute {
  const body = closed(value, ROUTE_KEYS);
  const routeId = id(body.routeId, 'routeId');
  return Object.freeze({
    routeId,
    channelInstanceId: id(body.channelInstanceId, 'channelInstanceId'),
    accountId: id(body.accountId, 'accountId'),
    accountGeneration: revision(body.accountGeneration, 'accountGeneration'),
    routeRevision: revision(body.routeRevision, 'routeRevision'),
    rootSessionId: id(body.rootSessionId, 'rootSessionId'),
    sessionId: id(body.sessionId, 'sessionId'),
    scope: parseScope(body.scope),
    policyRef: ref(body.policyRef, 'policyRef'),
    run: routeRun(body.run, routeId),
  });
}

function parseReceipt(value: ManagedSessionJsonValue): ChannelDeliveryReceipt {
  const body = closed(value, RECEIPT_KEYS);
  return Object.freeze({
    providerMessageId: id(body.providerMessageId, 'receipt.providerMessageId'),
    acceptedAt: assertManagedSessionTime(body.acceptedAt, 'receipt.acceptedAt'),
    proofRef: body.proofRef === null ? null : ref(body.proofRef, 'proofRef'),
  });
}

function parseSegments(
  value: ManagedSessionJsonValue,
): readonly ChannelDeliverySegment[] {
  if (!Array.isArray(value)) fail('Channel delivery segments must be a list.');
  if (value.length < 1 || value.length > CHANNEL_DELIVERY_MAX_SEGMENTS) {
    fail(
      `Channel delivery segments must number 1 to ${CHANNEL_DELIVERY_MAX_SEGMENTS}.`,
    );
  }
  const seen = new Set<string>();
  // Array.prototype.map would silently skip empty slots, letting a sparse
  // plan through every check and betraying its JSON round-trip when the
  // holes serialize as null; walk every index so a hole fails as a
  // non-object entry.
  const segments: ChannelDeliverySegment[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const body = closed(value[index], SEGMENT_KEYS);
    const segmentId = id(body.segmentId, `segments[${index}].segmentId`);
    if (seen.has(segmentId)) {
      fail(`Channel delivery segment ${segmentId} is named twice.`);
    }
    seen.add(segmentId);
    const ordinal = assertManagedSessionSequence(
      body.ordinal,
      `segments[${index}].ordinal`,
    );
    if (ordinal !== index) {
      fail('Channel delivery segment ordinals must be dense from zero.');
    }
    segments.push(
      Object.freeze({
        segmentId,
        ordinal,
        contentRef: ref(body.contentRef, `segments[${index}].contentRef`),
        receipt: body.receipt === null ? null : parseReceipt(body.receipt),
      }),
    );
  }
  return Object.freeze(segments);
}

function deliveryRun(value: unknown, deliveryId: string): ExtensionRun {
  const run = parseExtensionRun(value);
  if (
    run.definition !== null ||
    run.executionCallId !== null ||
    run.effectId !== deliveryId ||
    run.dispatchId !== null ||
    run.deliveryId !== deliveryId ||
    run.execution !== null ||
    run.runtime !== null ||
    run.delivery === null ||
    run.delivery.target !== 'channel'
  ) {
    fail(
      'Channel delivery run must carry its channel delivery line and nothing else.',
    );
  }
  return run;
}

export function parseChannelDelivery(value: unknown): ChannelDelivery {
  const body = closed(value, DELIVERY_KEYS);
  if (typeof body.cancelRequested !== 'boolean') {
    fail('Channel delivery cancelRequested must be boolean.');
  }
  const deliveryId = id(body.deliveryId, 'deliveryId');
  const run = deliveryRun(body.run, deliveryId);
  const segments = parseSegments(body.segments);
  const receipts = segments.map((segment) => segment.receipt !== null);
  const settled = receipts.filter(Boolean).length;
  const state = run.delivery!.state;
  const pins: Record<string, boolean> = {
    // reserved is out in the pin's favor: a delivery exists only once it is
    // planned, and the run block refuses a reserved state with a delivery.
    planned: run.state === 'admitted' && settled === 0,
    sending:
      (run.state === 'running' ||
        run.state === 'waiting' ||
        run.state === 'recovery_blocked') &&
      settled < segments.length,
    partial:
      (run.state === 'running' ||
        run.state === 'waiting' ||
        run.state === 'recovery_blocked') &&
      settled > 0 &&
      settled < segments.length,
    delivered: run.state === 'settled' && settled === segments.length,
    unknown:
      run.state === 'waiting' &&
      run.reason === null &&
      settled < segments.length,
    rejected: run.state === 'failed' && settled < segments.length,
    // A cancellation is always someone's committed act, so the request
    // flag is part of the cancelled fact.
    cancelled:
      run.state === 'cancelled' && settled === 0 && body.cancelRequested,
  };
  if (!pins[state]) {
    fail(
      `Channel delivery line ${state} does not match its run and segment receipts.`,
    );
  }
  return Object.freeze({
    deliveryId,
    routeId: id(body.routeId, 'routeId'),
    routeRevision: revision(body.routeRevision, 'routeRevision'),
    sourceTurnId: id(body.sourceTurnId, 'sourceTurnId'),
    contentRef: ref(body.contentRef, 'contentRef'),
    segments,
    cancelRequested: body.cancelRequested,
    run,
  });
}

function accepts(check: () => boolean): boolean {
  try {
    return check();
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return false;
    throw error;
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isChannelRouteStart(value: unknown): boolean {
  return accepts(() => isExtensionRunStart(parseChannelRoute(value).run));
}

export function isChannelDeliveryStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseChannelDelivery(value);
    return (
      isExtensionRunStart(record.run) &&
      !record.cancelRequested &&
      record.segments.every((segment) => segment.receipt === null)
    );
  });
}

export function isChannelRouteSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseChannelRoute(previous);
    const after = parseChannelRoute(next);
    if (
      !same(before.routeId, after.routeId) ||
      !same(before.channelInstanceId, after.channelInstanceId) ||
      !same(before.accountId, after.accountId) ||
      !same(before.scope, after.scope) ||
      !isExtensionRunSuccessor(before.run, after.run)
    ) {
      return false;
    }
    if (TERMINAL_RUN_STATES.includes(before.run.state)) {
      return same(before, after);
    }
    if (before.routeRevision === after.routeRevision) {
      return REBIND_KEYS.every((key) => same(before[key], after[key]));
    }
    return (
      after.routeRevision === before.routeRevision + 1 &&
      after.accountGeneration >= before.accountGeneration
    );
  });
}

export function isChannelDeliverySuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseChannelDelivery(previous);
    const after = parseChannelDelivery(next);
    if (
      before.deliveryId !== after.deliveryId ||
      before.routeId !== after.routeId ||
      before.routeRevision !== after.routeRevision ||
      before.sourceTurnId !== after.sourceTurnId ||
      !same(before.contentRef, after.contentRef) ||
      before.segments.length !== after.segments.length ||
      !before.segments.every((segment, index) => {
        const other = after.segments[index]!;
        return (
          segment.segmentId === other.segmentId &&
          segment.ordinal === other.ordinal &&
          same(segment.contentRef, other.contentRef) &&
          (segment.receipt === null || same(segment.receipt, other.receipt))
        );
      }) ||
      (before.cancelRequested && !after.cancelRequested) ||
      !isExtensionRunSuccessor(before.run, after.run)
    ) {
      return false;
    }
    // Leaving unknown takes proof: a partial revision must settle a
    // segment the unknown one did not, or the next sending revision could
    // re-send a segment the provider may already hold (decision 5).
    const settledOf = (record: ChannelDelivery) =>
      record.segments.filter((segment) => segment.receipt !== null).length;
    if (
      before.run.delivery!.state === 'unknown' &&
      after.run.delivery!.state === 'partial' &&
      settledOf(after) <= settledOf(before)
    ) {
      return false;
    }
    if (TERMINAL_RUN_STATES.includes(before.run.state)) {
      return same(before, after);
    }
    return true;
  });
}

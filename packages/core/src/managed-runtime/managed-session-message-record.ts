/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isExtensionRunSuccessor,
  parseExtensionRun,
  type ExtensionRun,
} from './managed-extension-record.js';
import {
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// The `managed-session_message` record body, schema version 1 (H4d of
// #12827): one message between a parent Session and one of its child
// Sessions. Each message is committed twice, once in each journal by that
// journal's own writer: the sender's `outbound` record is the durable
// outbox entry and the target's `inbound` record is the receipt, both keyed
// by the same `messageId`. The shared fixtures in
// contracts/managed-session-message-record-v1.fixtures.json pin it, and
// ManagedSessionMessageRecords in packages/sdk-java/managed-agent-server
// replays the same cases. See
// docs/design/2026-10-09-managed-session-messages.md.

export const MANAGED_SESSION_MESSAGE_LIMITS = Object.freeze({
  /**
   * Bytes of stored content, within the durable inline bound. Legacy
   * `send_message` caps 65536 characters, so multi-byte text it admits may
   * exceed this; a producer bounds bytes before it commits.
   */
  maxContentBytes: 64 * 1024,
} as const);

/** Which side of the message a record is: the outbox entry or the receipt. */
export type SessionMessageDirection = 'outbound' | 'inbound';
/** Which way the message travels along the lineage edge. */
export type SessionMessageRoute = 'to_child' | 'to_parent';

/** The body of a `managed-session_message` schema version 1 record. */
export interface SessionMessage {
  readonly direction: SessionMessageDirection;
  readonly messageId: string;
  readonly route: SessionMessageRoute;
  /** The lineage edge: the child run in the parent Session's journal. */
  readonly childRunId: string;
  readonly senderSessionId: string;
  /** Fixed at handover on the outbound side; this Session on the inbound. */
  readonly targetSessionId: string | null;
  /** The holding Session's own copy of the message content. */
  readonly contentRef: ManagedSessionDurableRef;
  readonly contentDigest: string;
  /** The input that carries the message in the target Session. */
  readonly inputId: string | null;
  readonly run: ExtensionRun;
}

const BODY_KEYS = [
  'childRunId',
  'contentDigest',
  'contentRef',
  'direction',
  'inputId',
  'messageId',
  'route',
  'run',
  'senderSessionId',
  'targetSessionId',
] as const;
/**
 * Every key but the run is fixed across revisions, except `targetSessionId`
 * and `inputId`, which are set once.
 */
const FIXED_KEYS = [
  'childRunId',
  'contentDigest',
  'contentRef',
  'direction',
  'messageId',
  'route',
  'senderSessionId',
] as const;

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
  )
    fail(`Session message must have exactly the keys ${keys.join(', ')}.`);
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function nullableId(value: ManagedSessionJsonValue, label: string) {
  return value === null ? null : assertManagedSessionStableId(value, label);
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

/**
 * Parses the body of a `managed-session_message` schema version 1 record.
 * Nothing executes for a message: the send is an act completed by the
 * commit of its content, so the run is settled from its first revision and
 * only its session delivery moves. The outbound run names the sending call;
 * the inbound run, the receipt of an act, names nothing.
 */
export function parseSessionMessage(value: unknown): SessionMessage {
  const body = closed(value, BODY_KEYS);
  const run = parseExtensionRun(body.run);
  const direction = body.direction;
  if (direction !== 'outbound' && direction !== 'inbound') {
    fail('Session message direction must be outbound or inbound.');
  }
  const route = body.route;
  if (route !== 'to_child' && route !== 'to_parent') {
    fail('Session message route must be to_child or to_parent.');
  }
  if (
    run.definition !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.execution !== null ||
    run.runtime !== null
  ) {
    fail('Session message run must be purely logical.');
  }
  if (run.state !== 'settled') {
    fail('Session message run must be settled.');
  }
  const delivery = run.delivery;
  // The run carries no deliveryId, so the delivery is a session one.
  if (delivery === null) {
    fail('Session message delivery must be a session delivery.');
  }
  const messageId = assertManagedSessionStableId(body.messageId, 'messageId');
  const childRunId = assertManagedSessionStableId(
    body.childRunId,
    'childRunId',
  );
  const senderSessionId = assertManagedSessionStableId(
    body.senderSessionId,
    'senderSessionId',
  );
  const targetSessionId = nullableId(body.targetSessionId, 'targetSessionId');
  const inputId = nullableId(body.inputId, 'inputId');
  const contentRef = Object.freeze(
    assertManagedSessionDurableRef(body.contentRef, 'contentRef'),
  );
  if (contentRef.byteLength > MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes) {
    fail(
      `Session message content exceeds ${MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes} bytes.`,
    );
  }
  const contentDigest = assertManagedSessionDigest(
    body.contentDigest,
    'contentDigest',
  );
  if (contentDigest !== contentRef.digest) {
    fail("Session message contentDigest must name the content's digest.");
  }
  if (targetSessionId === senderSessionId) {
    fail('Session message cannot address its own sender.');
  }
  if (direction === 'outbound') {
    if (run.executionCallId === null) {
      fail('Outbound session message run must name its sending call.');
    }
    if (
      targetSessionId === null &&
      delivery.state !== 'planned' &&
      delivery.state !== 'cancelled'
    ) {
      fail(
        'Outbound session message must fix its target once its delivery is claimed.',
      );
    }
    if (
      (inputId !== null) !==
      (delivery.state === 'accepted' || delivery.state === 'consumed')
    ) {
      fail(
        "Outbound session message names its target's input exactly once accepted.",
      );
    }
  } else {
    if (run.executionCallId !== null) {
      fail('Inbound session message run must name no call.');
    }
    if (delivery.state !== 'accepted' && delivery.state !== 'consumed') {
      fail('Inbound session message delivery must be accepted or consumed.');
    }
    if (targetSessionId === null || inputId === null) {
      fail('Inbound session message must name its target and its input.');
    }
  }
  return Object.freeze({
    direction,
    messageId,
    route,
    childRunId,
    senderSessionId,
    targetSessionId,
    contentRef,
    contentDigest,
    inputId,
    run,
  });
}

/**
 * Whether `value` may open a message chain: an outbox entry still planned,
 * or a receipt that opens accepted — never already consumed.
 */
export function isSessionMessageStart(value: unknown): boolean {
  return accepts(() => {
    const message = parseSessionMessage(value);
    return (
      message.run.delivery?.state ===
      (message.direction === 'outbound' ? 'planned' : 'accepted')
    );
  });
}

/**
 * Whether `next` may follow `previous`: the message, its edge, its sender
 * and its content never change, the target and the input are set once, and
 * the delivery takes one shared step at a time. A receipt only moves from
 * accepted to consumed, so a consumed receipt can never be restated.
 */
export function isSessionMessageSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseSessionMessage(previous);
    const after = parseSessionMessage(next);
    if (FIXED_KEYS.some((key) => !same(before[key], after[key]))) return false;
    if (
      (before.targetSessionId !== null &&
        before.targetSessionId !== after.targetSessionId) ||
      (before.inputId !== null && before.inputId !== after.inputId)
    ) {
      return false;
    }
    if (!isExtensionRunSuccessor(before.run, after.run)) return false;
    if (before.direction === 'outbound') return true;
    if (before.run.delivery?.state !== 'accepted') return false;
    return (
      after.run.delivery?.state === 'consumed' || same(before.run, after.run)
    );
  });
}

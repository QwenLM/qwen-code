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

// The `managed-session_command` record body, schema version 1 (H4e-b3 of
// #12827): one command a member Session asks its leader to execute on the
// team. Each command is committed twice, once in each journal by that
// journal's own writer: the member's `outbound` record is the durable
// outbox entry and the leader's `inbound` record is the receipt, both keyed
// by the same `commandId`. A receipt carries a reply and no input — a
// command never wakes a model, and only a command that changes anything
// gets a receipt at all. The shared fixtures in
// contracts/managed-session-command-record-v1.fixtures.json pin it, and
// ManagedSessionCommandRecords in packages/sdk-java replays the same cases.
// See docs/design/2026-10-11-managed-agent-team-member-commands.md.

export const MANAGED_SESSION_COMMAND_LIMITS = Object.freeze({
  /**
   * Bytes of stored arguments, within the durable inline bound. A producer
   * bounds bytes before it commits; an oversized call is a tool error.
   */
  maxArgsBytes: 64 * 1024,
  /**
   * Bytes of stored reply. A longer board listing is cut with a marker by
   * the funnel, never refused.
   */
  maxReplyBytes: 64 * 1024,
} as const);

/** Which side of the command a record is: the outbox entry or the receipt. */
export type SessionCommandDirection = 'outbound' | 'inbound';
/** A command only ever travels from a member to its leader. */
export type SessionCommandRoute = 'to_parent';
/** What the command asks the leader to do. */
export type SessionCommandKind =
  | 'board_read'
  | 'board_write'
  | 'member_message'
  | 'plan_submit';

/** The body of a `managed-session_command` schema version 1 record. */
export interface SessionCommand {
  readonly direction: SessionCommandDirection;
  readonly commandId: string;
  readonly route: SessionCommandRoute;
  readonly kind: SessionCommandKind;
  /** The lineage edge: the child run in the leader Session's journal. */
  readonly childRunId: string;
  readonly senderSessionId: string;
  /** Fixed at handover on the outbound side; this Session on the inbound. */
  readonly targetSessionId: string | null;
  /** The holding Session's own copy of the call's arguments. */
  readonly argsRef: ManagedSessionDurableRef;
  readonly argsDigest: string;
  /**
   * The reply, `{ "outcome": "answered" | "refused", "text": "…" }`, set
   * once on the outbound's `accepted` revision and at the opening of the
   * inbound receipt; `null` before and never on a failed delivery.
   */
  readonly replyRef: ManagedSessionDurableRef | null;
  readonly replyDigest: string | null;
  readonly run: ExtensionRun;
}

const BODY_KEYS = [
  'argsDigest',
  'argsRef',
  'childRunId',
  'commandId',
  'direction',
  'kind',
  'replyDigest',
  'replyRef',
  'route',
  'run',
  'senderSessionId',
  'targetSessionId',
] as const;
/**
 * Every key but the run is fixed across revisions, except `targetSessionId`
 * and the reply pair, which are set once.
 */
const FIXED_KEYS = [
  'argsDigest',
  'argsRef',
  'childRunId',
  'commandId',
  'direction',
  'kind',
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
    fail(`Session command must have exactly the keys ${keys.join(', ')}.`);
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
 * Parses the body of a `managed-session_command` schema version 1 record.
 * The reply is the act's result: the run is settled from its first
 * revision and only its session delivery moves. The outbound run names the
 * commanding call; the inbound run names nothing.
 */
export function parseSessionCommand(value: unknown): SessionCommand {
  const body = closed(value, BODY_KEYS);
  const run = parseExtensionRun(body.run);
  const direction = body.direction;
  if (direction !== 'outbound' && direction !== 'inbound') {
    fail('Session command direction must be outbound or inbound.');
  }
  const route = body.route;
  if (route !== 'to_parent') {
    fail('Session command route must be to_parent.');
  }
  const kind = body.kind;
  if (
    kind !== 'board_read' &&
    kind !== 'board_write' &&
    kind !== 'member_message' &&
    kind !== 'plan_submit'
  ) {
    fail(
      'Session command kind must be one of board_read, board_write, member_message, plan_submit.',
    );
  }
  if (
    run.definition !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.execution !== null ||
    run.runtime !== null
  ) {
    fail('Session command run must be purely logical.');
  }
  if (run.state !== 'settled') {
    fail('Session command run must be settled.');
  }
  const delivery = run.delivery;
  // The run carries no deliveryId, so the delivery is a session one.
  if (delivery === null) {
    fail('Session command delivery must be a session delivery.');
  }
  const commandId = assertManagedSessionStableId(body.commandId, 'commandId');
  const childRunId = assertManagedSessionStableId(
    body.childRunId,
    'childRunId',
  );
  const senderSessionId = assertManagedSessionStableId(
    body.senderSessionId,
    'senderSessionId',
  );
  const targetSessionId = nullableId(body.targetSessionId, 'targetSessionId');
  const argsRef = Object.freeze(
    assertManagedSessionDurableRef(body.argsRef, 'argsRef'),
  );
  if (argsRef.byteLength > MANAGED_SESSION_COMMAND_LIMITS.maxArgsBytes) {
    fail(
      `Session command arguments exceed ${MANAGED_SESSION_COMMAND_LIMITS.maxArgsBytes} bytes.`,
    );
  }
  const argsDigest = assertManagedSessionDigest(body.argsDigest, 'argsDigest');
  if (argsDigest !== argsRef.digest) {
    fail("Session command argsDigest must name the arguments' digest.");
  }
  const replyRef =
    body.replyRef === null
      ? null
      : Object.freeze(
          assertManagedSessionDurableRef(body.replyRef, 'replyRef'),
        );
  const replyDigest =
    body.replyDigest === null
      ? null
      : assertManagedSessionDigest(body.replyDigest, 'replyDigest');
  if ((replyRef === null) !== (replyDigest === null)) {
    fail('Session command names its reply as a pair, or not at all.');
  }
  if (replyRef !== null) {
    if (replyRef.byteLength > MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes) {
      fail(
        `Session command reply exceeds ${MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes} bytes.`,
      );
    }
    if (replyDigest !== replyRef.digest) {
      fail("Session command replyDigest must name the reply's digest.");
    }
  }
  if (targetSessionId !== null && targetSessionId === senderSessionId) {
    fail('Session command cannot address its own sender.');
  }
  if (direction === 'outbound') {
    if (run.executionCallId === null) {
      fail('Outbound session command run must name its commanding call.');
    }
    if (
      targetSessionId === null &&
      delivery.state !== 'planned' &&
      delivery.state !== 'cancelled'
    ) {
      fail(
        'Outbound session command must fix its target once its delivery is claimed.',
      );
    }
    if (
      (replyRef !== null) !==
      (delivery.state === 'accepted' || delivery.state === 'consumed')
    ) {
      fail('Outbound session command names its reply exactly once accepted.');
    }
  } else {
    if (kind === 'board_read') {
      fail(
        'Inbound session command is never a board read; reads commit nothing.',
      );
    }
    if (run.executionCallId !== null) {
      fail('Inbound session command run must name no call.');
    }
    if (delivery.state !== 'consumed') {
      fail('Inbound session command opens consumed with its reply.');
    }
    if (targetSessionId === null) {
      fail('Inbound session command must name its target.');
    }
    if (replyRef === null) {
      fail('Inbound session command opens with its reply.');
    }
  }
  return Object.freeze({
    direction,
    commandId,
    route,
    kind,
    childRunId,
    senderSessionId,
    targetSessionId,
    argsRef,
    argsDigest,
    replyRef,
    replyDigest,
    run,
  });
}

/**
 * Whether `value` may open a command chain: an outbox entry still planned,
 * or a receipt already consumed with its reply — never an empty wait.
 */
export function isSessionCommandStart(value: unknown): boolean {
  return accepts(() => {
    const command = parseSessionCommand(value);
    return (
      command.run.delivery?.state ===
      (command.direction === 'outbound' ? 'planned' : 'consumed')
    );
  });
}

/**
 * Whether `next` may follow `previous`: the command, its edge, its sender
 * and its arguments never change, the target and the reply are set once,
 * and the delivery takes one shared step at a time. A receipt opens
 * consumed, so only an identical restatement follows it.
 */
export function isSessionCommandSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseSessionCommand(previous);
    const after = parseSessionCommand(next);
    if (FIXED_KEYS.some((key) => !same(before[key], after[key]))) return false;
    if (
      (before.targetSessionId !== null &&
        before.targetSessionId !== after.targetSessionId) ||
      (before.replyRef !== null && !same(before.replyRef, after.replyRef)) ||
      (before.replyDigest !== null && before.replyDigest !== after.replyDigest)
    ) {
      return false;
    }
    if (!isExtensionRunSuccessor(before.run, after.run)) return false;
    if (before.direction === 'outbound') return true;
    return same(before.run, after.run);
  });
}

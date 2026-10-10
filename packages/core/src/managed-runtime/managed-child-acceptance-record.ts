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

// The `managed-child_acceptance` record body, schema version 1 (H4 of
// #12827): the parent's receipt of one child run's terminal result. The
// record lives in the parent Session's journal, one chain per child run, and
// projects no task. The shared fixtures in
// contracts/managed-child-acceptance-record-v1.fixtures.json pin it, and
// ManagedExtensionRecords in packages/sdk-java/managed-agent-server replays
// the same cases. See docs/design/2026-10-06-managed-child-agent-runtime.md.

/** The body of a `managed-child_acceptance` schema version 1 record. */
export interface ChildAcceptance {
  /** The child run this accepts: same Session, kind `child_agent`. */
  readonly childRunId: string;
  /** Must equal the child run's `ownerScopeId`. */
  readonly parentScopeId: string;
  /** The parent tool call the result attaches to, or null for `"sent"`. */
  readonly parentExecutionCallId: string | null;
  /** The accepted result version; exactly 1 in schema version 1. */
  readonly resultVersion: number;
  /** The parent-held copy of the accepted result content. */
  readonly contentRef: ManagedSessionDurableRef;
  /** Binds the copy to the child's committed result: the content's digest. */
  readonly contentDigest: string;
  /** The parent-held copy of the child's terminal receipt. */
  readonly terminalReceiptRef: ManagedSessionDurableRef;
  readonly run: ExtensionRun;
}

const BODY_KEYS = [
  'childRunId',
  'contentDigest',
  'contentRef',
  'parentExecutionCallId',
  'parentScopeId',
  'resultVersion',
  'run',
  'terminalReceiptRef',
] as const;
/** Every key but the run is fixed across the record's revisions. */
const FIXED_KEYS = [
  'childRunId',
  'contentDigest',
  'contentRef',
  'parentExecutionCallId',
  'parentScopeId',
  'resultVersion',
  'terminalReceiptRef',
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
    fail(`Child acceptance must have exactly the keys ${keys.join(', ')}.`);
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function id(value: ManagedSessionJsonValue, label: string): string {
  return assertManagedSessionStableId(value, label);
}

function ref(value: ManagedSessionJsonValue, label: string) {
  return Object.freeze(assertManagedSessionDurableRef(value, label));
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
 * Parses the body of a `managed-child_acceptance` schema version 1 record.
 * The acceptance is purely logical, so the run carries no physical identity,
 * no execution and no Runtime; it is the receipt of an act that has just
 * happened, so every revision is settled and the delivery is a session
 * delivery at `accepted` or `consumed`, per decision 9 of the design.
 */
export function parseChildAcceptance(value: unknown): ChildAcceptance {
  const body = closed(value, BODY_KEYS);
  const run = parseExtensionRun(body.run);
  if (
    run.executionCallId !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.runtime !== null ||
    run.execution !== null ||
    run.definition !== null
  ) {
    fail('Child acceptance run must be purely logical.');
  }
  if (run.state !== 'settled') {
    fail('Child acceptance run must be settled.');
  }
  const delivery = run.delivery;
  if (
    delivery === null ||
    delivery.target !== 'session' ||
    (delivery.state !== 'accepted' && delivery.state !== 'consumed')
  ) {
    fail('Child acceptance delivery must be accepted or consumed.');
  }
  const contentRef = ref(body.contentRef, 'contentRef');
  const contentDigest = assertManagedSessionDigest(
    body.contentDigest,
    'contentDigest',
  );
  if (contentDigest !== contentRef.digest) {
    fail("Child acceptance contentDigest must name the content's digest.");
  }
  const terminalReceiptRef = ref(body.terminalReceiptRef, 'terminalReceiptRef');
  const resultVersion = body.resultVersion;
  if (resultVersion !== 1) {
    fail('Child acceptance resultVersion must be 1 in schema version 1.');
  }
  return Object.freeze({
    childRunId: id(body.childRunId, 'childRunId'),
    parentScopeId: id(body.parentScopeId, 'parentScopeId'),
    parentExecutionCallId:
      body.parentExecutionCallId === null
        ? null
        : id(body.parentExecutionCallId, 'parentExecutionCallId'),
    resultVersion,
    contentRef,
    contentDigest,
    terminalReceiptRef,
    run,
  });
}

/**
 * Whether `value` may open an acceptance chain: a settled run whose delivery
 * is accepted — never already consumed.
 */
export function isChildAcceptanceStart(value: unknown): boolean {
  return accepts(
    () => parseChildAcceptance(value).run.delivery?.state === 'accepted',
  );
}

/**
 * Whether `next` may follow `previous`: the identity, content and receipt
 * never change, and the delivery may only advance from `accepted` to
 * `consumed` — an acceptance consumed once can never be restated.
 */
export function isChildAcceptanceSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseChildAcceptance(previous);
    const after = parseChildAcceptance(next);
    if (FIXED_KEYS.some((key) => !same(before[key], after[key]))) return false;
    if (!isExtensionRunSuccessor(before.run, after.run)) return false;
    if (before.run.delivery?.state !== 'accepted') return false;
    return (
      after.run.delivery?.state === 'consumed' || same(before.run, after.run)
    );
  });
}

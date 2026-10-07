/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertManagedSessionDigest,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  assertManagedSessionTime,
  MANAGED_SESSION_EVENT_KINDS,
  ManagedSessionRecordError,
  managedSessionEventsDigest,
  type ManagedSessionEvent,
  type ManagedSessionEventKind,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// The managed-event-envelope/1 contract: the distribution notice an
// EventTransport publishes after a Session Authority commit, for cross-node
// wake on journal facts; the public-event/materialization lane is a later
// stream. The design invariants pin it: only committed facts fly, the
// transport is never Session truth and an offset is never a recovery
// credential. So the envelope identifies the committed event row by its
// tenant-scoped ordering key (tenantId + sessionId + stream + sequence),
// carries the event's own recorder-side timestamp and kind, and binds the
// body by digest only — the payload body stays in the SQL record.
// Declared, not enabled: a derivation from the committed row proves the
// commit path can supply every field, but no runtime path consumes the
// envelope yet and the gate test proves that.

/** The envelope format version carried by `v`. */
export const MANAGED_EVENT_ENVELOPE_FORMAT_VERSION = 1;

/**
 * The committed source whose sequence an envelope names. A Session keeps two
 * independent counters — the journal's commit sequence and the public
 * `managed_agent_event.sequence_id` — that reuse the same numbers for
 * different facts, so a sequence is only an identity together with its
 * stream. v1 distributes journal facts only.
 */
export const MANAGED_EVENT_ENVELOPE_STREAMS = Object.freeze([
  'authoritative_journal',
] as const);

export type ManagedEventEnvelopeStream =
  (typeof MANAGED_EVENT_ENVELOPE_STREAMS)[number];

/**
 * The field names an envelope must never carry: the internals and secrets
 * the design bars from every public surface (`SessionTaskView` hides
 * `runtimeBindingId`, generation, Runtime endpoint, Pod, absolute path, raw
 * PID, SecretHandle and local sidecar; the acceptance list forbids
 * SecretHandle, Runtime endpoint, absolute path and PID on public APIs).
 * A transport message reaches across nodes, so the same vocabulary is
 * refused here by name rather than only by shape.
 */
export const MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS = Object.freeze([
  'absolutePath',
  'localPath',
  'pid',
  'pod',
  'runtimeBindingId',
  'runtimeEndpoint',
  'secretHandle',
  'sidecar',
] as const);

/**
 * The body this envelope binds, never a lookup handle: the receiver
 * locates the row by the envelope key `(tenantId, sessionId, stream,
 * sequence)` and recomputes this value over the single event to confirm
 * it has not been altered. It is the digest of the full committed event
 * in the same canonical form the commit marker's transaction-wide
 * `eventsDigest` uses — over the one-event range this envelope announces,
 * so the two are equal only for a single-event transaction and a
 * multi-event transaction stores no column equal to it. The body itself
 * never travels.
 */
export interface ManagedEventEnvelopePayloadRef {
  readonly digest: string;
}

/**
 * One committed event as distributed to other nodes. `sessionId`,
 * `tenantId` and `workspaceId` flatten the row's `sessionKey`; `sequence`,
 * `eventId`, `kind` and `occurredAt` are taken from the row unchanged.
 * `occurredAt` is the UTC Unix millisecond at which the event's own writer
 * recorded it — the recorder-side timestamp committed with the event, so
 * it precedes commit by however long the call took in flight. It is not a
 * commit order; ordering per Session rides `(tenantId, sessionId, stream,
 * sequence)` — within one stream, by `sequence`.
 */
export interface ManagedEventEnvelope {
  readonly v: 1;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly stream: ManagedEventEnvelopeStream;
  readonly sequence: number;
  readonly eventId: string;
  readonly kind: ManagedSessionEventKind;
  readonly occurredAt: number;
  readonly payloadRef: ManagedEventEnvelopePayloadRef;
}

/** The receiver-side idempotence key: the per-key ordering coordinate.
 * Sessions are tenant-scoped (one `qwen_managed_session_journal_head` row per
 * tenant and session), so a key is only identity-ending within its tenant —
 * the same session id under another tenant is another Session. */
export interface ManagedEventEnvelopeKey {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly stream: ManagedEventEnvelopeStream;
  readonly sequence: number;
}

const ENVELOPE_KEYS = [
  'v',
  'sessionId',
  'tenantId',
  'workspaceId',
  'stream',
  'sequence',
  'eventId',
  'kind',
  'occurredAt',
  'payloadRef',
] as const;
const PAYLOAD_REF_KEYS = ['digest'] as const;

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function closed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, ManagedSessionJsonValue> {
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (
      (MANAGED_EVENT_ENVELOPE_FORBIDDEN_FIELDS as readonly string[]).includes(
        key,
      )
    ) {
      fail(`${label} must not carry the forbidden field "${key}".`);
    }
  }
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key as Key))
  ) {
    fail(`${label} must have exactly the keys ${keys.join(', ')}.`);
  }
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function assertEnum<T extends string>(
  value: ManagedSessionJsonValue,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function parseManagedEventEnvelope(
  value: unknown,
): ManagedEventEnvelope {
  const body = closed(value, ENVELOPE_KEYS, 'envelope');
  if (body.v !== MANAGED_EVENT_ENVELOPE_FORMAT_VERSION) {
    fail(`envelope.v must be ${MANAGED_EVENT_ENVELOPE_FORMAT_VERSION}.`);
  }
  const sequence = assertManagedSessionSequence(
    body.sequence,
    'envelope.sequence',
  );
  if (sequence < 1) {
    fail('envelope.sequence must start at 1.');
  }
  const ref = closed(body.payloadRef, PAYLOAD_REF_KEYS, 'envelope.payloadRef');
  return Object.freeze({
    v: MANAGED_EVENT_ENVELOPE_FORMAT_VERSION,
    sessionId: assertManagedSessionStableId(
      body.sessionId,
      'envelope.sessionId',
    ),
    tenantId: assertManagedSessionStableId(body.tenantId, 'envelope.tenantId'),
    workspaceId: assertManagedSessionStableId(
      body.workspaceId,
      'envelope.workspaceId',
    ),
    stream: assertEnum(
      body.stream,
      MANAGED_EVENT_ENVELOPE_STREAMS,
      'envelope.stream',
    ),
    sequence,
    eventId: assertManagedSessionStableId(body.eventId, 'envelope.eventId'),
    kind: assertEnum(body.kind, MANAGED_SESSION_EVENT_KINDS, 'envelope.kind'),
    occurredAt: assertManagedSessionTime(
      body.occurredAt,
      'envelope.occurredAt',
    ),
    payloadRef: Object.freeze({
      digest: assertManagedSessionDigest(
        ref.digest,
        'envelope.payloadRef.digest',
      ),
    }),
  });
}

/**
 * The envelope of one committed event, derived from the row the journal
 * commits plus a per-event digest recomputed in the same canonical form
 * the commit marker's transaction-wide `eventsDigest` uses. It is not the
 * marker's value: the marker digests the whole transaction, so the two are
 * equal only for a single-event transaction. It exists to prove the commit
 * path can supply every field today without new record state; it is not
 * wired into that path.
 */
export function managedEventEnvelopeFrom(
  event: ManagedSessionEvent,
): ManagedEventEnvelope {
  return Object.freeze({
    v: MANAGED_EVENT_ENVELOPE_FORMAT_VERSION,
    sessionId: event.sessionKey.sessionId,
    tenantId: event.sessionKey.tenantId,
    workspaceId: event.sessionKey.workspaceId,
    stream: 'authoritative_journal',
    sequence: event.sequence,
    eventId: event.eventId,
    kind: event.kind,
    occurredAt: event.occurredAt,
    payloadRef: Object.freeze({
      digest: managedSessionEventsDigest([event]),
    }),
  });
}

/** The idempotence key of a parsed envelope: `(tenantId, sessionId,
 * stream, sequence)`. */
export function managedEventEnvelopeKey(
  envelope: ManagedEventEnvelope,
): ManagedEventEnvelopeKey {
  return Object.freeze({
    tenantId: envelope.tenantId,
    sessionId: envelope.sessionId,
    stream: envelope.stream,
    sequence: envelope.sequence,
  });
}

/**
 * Redelivery-safe comparison: two parses announce the same committed event
 * when their keys are exactly equal. A broker may redeliver a fact any
 * number of times, and the committed row it identifies cannot change, so
 * equality compares the key (tenant included) and nothing
 * else — differing surroundings with an equal key still name the one fact,
 * and anything unparseable announces nothing.
 */
export function isManagedEventEnvelopeRedelivered(
  delivered: unknown,
  seen: unknown,
): boolean {
  const keyOf = (candidate: unknown): ManagedEventEnvelopeKey | null => {
    try {
      return managedEventEnvelopeKey(parseManagedEventEnvelope(candidate));
    } catch (error) {
      if (error instanceof ManagedSessionRecordError) return null;
      throw error;
    }
  };
  const left = keyOf(delivered);
  const right = keyOf(seen);
  return (
    left !== null &&
    right !== null &&
    left.tenantId === right.tenantId &&
    left.sessionId === right.sessionId &&
    left.stream === right.stream &&
    left.sequence === right.sequence
  );
}

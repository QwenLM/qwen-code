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
  managedSessionJsonDigest,
  type ManagedSessionEvent,
  type ManagedSessionEventKind,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// The managed-event-envelope/1 contract: the distribution notice an
// EventTransport publishes after a commit — `authoritative_journal` for a
// Session Authority journal fact (cross-node wake), `public_event` for a row
// of the public `managed_agent_event` stream (materialization). The design
// invariants pin it: only committed facts fly, the transport is never
// Session truth and an offset is never a recovery credential. So the
// envelope identifies the committed row by its tenant-scoped ordering key
// (tenantId + sessionId + stream + sequence), carries the row's own
// timestamp and kind, and binds the body by digest only — the payload body
// stays in the SQL record. No TypeScript runtime path consumes the envelope
// (the gate test proves that); the Java control plane is its producer and
// consumer, mirroring these rules against the shared fixtures.

/** The envelope format version carried by `v`. */
export const MANAGED_EVENT_ENVELOPE_FORMAT_VERSION = 1;

/**
 * The committed source whose sequence an envelope names. A Session keeps two
 * independent counters — the journal's commit sequence and the public
 * `managed_agent_event.sequence_id` — that reuse the same numbers for
 * different facts, so a sequence is only an identity together with its
 * stream. `public_event` is an additive extension of v1: every envelope
 * valid before it stays valid with the same meaning.
 */
export const MANAGED_EVENT_ENVELOPE_STREAMS = Object.freeze([
  'authoritative_journal',
  'public_event',
] as const);

export type ManagedEventEnvelopeStream =
  (typeof MANAGED_EVENT_ENVELOPE_STREAMS)[number];

/**
 * The byte ceiling of a `public_event` kind: the public event type column
 * (`managed_agent_event.event_type`) and the public API both cap a type at
 * 128 characters, and the grammar below is ASCII, so characters and UTF-8
 * bytes agree.
 */
export const MANAGED_PUBLIC_EVENT_KIND_MAX_BYTES = 128;

/**
 * The `public_event` kind grammar: lowercase dot-separated segments, each
 * starting with a letter (`turn.accepted`, `item.output_text.delta`). The
 * public type set is open — a later minor version may add types — so the
 * kind is checked by shape, never against a closed list; the journal stream
 * keeps its closed record vocabulary.
 */
export const MANAGED_PUBLIC_EVENT_KIND_PATTERN =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

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
 * One committed event as distributed to other nodes. On the journal stream
 * `sessionId`, `tenantId` and `workspaceId` flatten the row's `sessionKey`;
 * `sequence`, `eventId`, `kind` and `occurredAt` are taken from the row
 * unchanged. `occurredAt` is the UTC Unix millisecond at which the event's
 * own writer recorded it — the recorder-side timestamp committed with the
 * event, so it precedes commit by however long the call took in flight. It
 * is not a commit order; ordering per Session rides `(tenantId, sessionId,
 * stream, sequence)` — within one stream, by `sequence`.
 */
interface ManagedEventEnvelopeFields {
  readonly v: 1;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly payloadRef: ManagedEventEnvelopePayloadRef;
}

/** A Session Authority journal fact; `kind` is the record vocabulary. */
export interface ManagedJournalEventEnvelope
  extends ManagedEventEnvelopeFields {
  readonly stream: 'authoritative_journal';
  readonly kind: ManagedSessionEventKind;
}

/**
 * A row of the public `managed_agent_event` stream: `sequence` is its
 * `sequence_id`, `kind` its public type, `occurredAt` its `created_at`, and
 * `workspaceId` the Session's workspace binding — for an unbound Session,
 * the workspace its journal records carry. The public row carries none, so a
 * Session with neither has no distributable rows.
 */
export interface ManagedPublicEventEnvelope extends ManagedEventEnvelopeFields {
  readonly stream: 'public_event';
  readonly kind: string;
}

export type ManagedEventEnvelope =
  | ManagedJournalEventEnvelope
  | ManagedPublicEventEnvelope;

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
  value: ManagedSessionJsonValue | undefined,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function assertPublicKind(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length > MANAGED_PUBLIC_EVENT_KIND_MAX_BYTES ||
    !MANAGED_PUBLIC_EVENT_KIND_PATTERN.test(value)
  ) {
    fail(
      `${label} must be a public event type: lowercase dot-separated segments of at most ${MANAGED_PUBLIC_EVENT_KIND_MAX_BYTES} characters.`,
    );
  }
  return value;
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
  const sessionId = assertManagedSessionStableId(
    body.sessionId,
    'envelope.sessionId',
  );
  const tenantId = assertManagedSessionStableId(
    body.tenantId,
    'envelope.tenantId',
  );
  const workspaceId = assertManagedSessionStableId(
    body.workspaceId,
    'envelope.workspaceId',
  );
  const stream = assertEnum(
    body.stream,
    MANAGED_EVENT_ENVELOPE_STREAMS,
    'envelope.stream',
  );
  const eventId = assertManagedSessionStableId(
    body.eventId,
    'envelope.eventId',
  );
  // The kind vocabulary is the stream's: the closed record vocabulary on the
  // journal, the open public type grammar on the public stream.
  const kind =
    stream === 'authoritative_journal'
      ? assertEnum(body.kind, MANAGED_SESSION_EVENT_KINDS, 'envelope.kind')
      : assertPublicKind(body.kind, 'envelope.kind');
  const occurredAt = assertManagedSessionTime(
    body.occurredAt,
    'envelope.occurredAt',
  );
  const payloadRef = Object.freeze({
    digest: assertManagedSessionDigest(
      ref.digest,
      'envelope.payloadRef.digest',
    ),
  });
  return Object.freeze({
    v: MANAGED_EVENT_ENVELOPE_FORMAT_VERSION,
    sessionId,
    tenantId,
    workspaceId,
    stream,
    sequence,
    eventId,
    kind,
    occurredAt,
    payloadRef,
  }) as ManagedEventEnvelope;
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
): ManagedJournalEventEnvelope {
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

/**
 * One committed row of the public `managed_agent_event` stream as the Java
 * control plane reads it back: `sequence` is `sequence_id`, `type` is
 * `event_type`, `data` is the parsed `data_json`, `createdAt` is
 * `created_at`, and `turnId` is null for a Session-level event. These nine
 * fields are the body a `public_event` envelope binds; identity metadata
 * (schema/projection versions, Item and Part ids) is left out. A stream
 * reconciliation rewrites rows in place — it empties a retracted delta's
 * `data` too — so the digest binds the row as published, not forever.
 */
export interface ManagedPublicEventRow {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly turnId: string | null;
  readonly type: string;
  readonly data: ManagedSessionJsonValue;
  readonly terminal: boolean;
  readonly createdAt: number;
}

const PUBLIC_EVENT_ROW_KEYS = [
  'tenantId',
  'sessionId',
  'sequence',
  'eventId',
  'turnId',
  'type',
  'data',
  'terminal',
  'createdAt',
] as const;

/** Parse one public event row, refusing anything an envelope cannot name. */
export function parseManagedPublicEventRow(
  value: unknown,
): ManagedPublicEventRow {
  const row = closed(value, PUBLIC_EVENT_ROW_KEYS, 'publicEvent');
  const sequence = assertManagedSessionSequence(
    row.sequence,
    'publicEvent.sequence',
  );
  if (sequence < 1) {
    fail('publicEvent.sequence must start at 1.');
  }
  if (typeof row.terminal !== 'boolean') {
    fail('publicEvent.terminal must be a boolean.');
  }
  // Check the data where the derivation digests it — two levels down, inside
  // the `[row]` list — so a non-JSON or over-deep value is refused here
  // exactly when the derivation would refuse it.
  managedSessionJsonDigest([{ data: row.data }]);
  return Object.freeze({
    tenantId: assertManagedSessionStableId(
      row.tenantId,
      'publicEvent.tenantId',
    ),
    sessionId: assertManagedSessionStableId(
      row.sessionId,
      'publicEvent.sessionId',
    ),
    sequence,
    eventId: assertManagedSessionStableId(row.eventId, 'publicEvent.eventId'),
    turnId:
      row.turnId === null
        ? null
        : assertManagedSessionStableId(row.turnId, 'publicEvent.turnId'),
    type: assertPublicKind(row.type, 'publicEvent.type'),
    data: row.data,
    terminal: row.terminal,
    createdAt: assertManagedSessionTime(row.createdAt, 'publicEvent.createdAt'),
  });
}

/**
 * The envelope of one committed public event row. The row carries no
 * workspace, so the Session's workspace is passed alongside it; the digest is
 * SHA-256 over the canonical JSON of the one-element list `[row]` — the
 * journal derivation's canonical form, over the nine row fields. A stream
 * reconciliation may later rewrite the row in place, so a receiver that
 * recomputes a different digest reads the row as changed since publication,
 * never as forged.
 */
export function managedEventEnvelopeFromPublicEvent(
  row: ManagedPublicEventRow,
  workspaceId: string,
): ManagedPublicEventEnvelope {
  const parsed = parseManagedPublicEventRow(row);
  return parseManagedEventEnvelope({
    v: MANAGED_EVENT_ENVELOPE_FORMAT_VERSION,
    sessionId: parsed.sessionId,
    tenantId: parsed.tenantId,
    workspaceId,
    stream: 'public_event',
    sequence: parsed.sequence,
    eventId: parsed.eventId,
    kind: parsed.type,
    occurredAt: parsed.createdAt,
    payloadRef: {
      digest: managedSessionJsonDigest([
        {
          tenantId: parsed.tenantId,
          sessionId: parsed.sessionId,
          sequence: parsed.sequence,
          eventId: parsed.eventId,
          turnId: parsed.turnId,
          type: parsed.type,
          data: parsed.data,
          terminal: parsed.terminal,
          createdAt: parsed.createdAt,
        },
      ]),
    },
  }) as ManagedPublicEventEnvelope;
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

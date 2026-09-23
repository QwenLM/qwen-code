/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { parseBranchCheckpointPayload } from '../services/branch-points.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { ManagedSessionJsonValue } from './managed-session-inbox.js';

export const MANAGED_SESSION_FORMAT_VERSION = 1;
export const MANAGED_SESSION_MINIMUM_READER = 'managed-session/1';

export const MANAGED_SESSION_HEADER_SUBTYPE = 'managed_session_header_v1';
export const MANAGED_SESSION_EVENT_SUBTYPE = 'managed_session_event_v1';
export const MANAGED_SESSION_COMMIT_SUBTYPE = 'managed_session_commit_v1';

export const MANAGED_SESSION_LIMITS = {
  maxIdBytes: 512,
  // Not frozen by the storage spec: a bound for free-form enum-adjacent fields
  // such as `source` or `stopReason`, borrowed from its error-message cap.
  maxTextBytes: 4096,
  maxJsonDepth: 64,
  maxEventBytes: 1024 * 1024,
  maxCommitMarkerBytes: 64 * 1024,
  maxTransactionEvents: 256,
  maxTransactionBytes: 8 * 1024 * 1024,
  defaultReadEvents: 100,
  maxReadEvents: 256,
} as const;

export const MANAGED_SESSION_EVENT_KINDS = [
  'input.accepted',
  'wake.requested',
  'activation.changed',
  'model.attempt',
  'message.committed',
  'tool.intent',
  'action.changed',
  'tool.receipt',
  'checkpoint.committed',
  'context.compacted',
  'cancel.requested',
  'turn.settled',
  'config.bound',
  'lifecycle.changed',
  'domain.committed',
] as const;

export type ManagedSessionEventKind =
  (typeof MANAGED_SESSION_EVENT_KINDS)[number];

/**
 * Closed v1 domain index. A name being parseable never means the capability is
 * implemented or admitted; enablement is decided per capability.
 */
export const MANAGED_SESSION_DOMAINS = [
  'config_install',
  'workspace_initialization',
  'skill_activation',
  'mcp_configuration',
  'mcp_operation',
  'hook_registration',
  'hook_execution',
  'tool_stage',
  'resource',
  'publication',
  'workspace_operation',
  'history_rewind',
  'history_copy',
  'history_maintenance',
  'channel_route',
  'channel_delivery',
  'schedule',
  'automation_run',
  'child_run',
  'child_acceptance',
  'memory_job',
  'goal_state',
  'todo_state',
  'plan_mode',
  'team_state',
  'team_task',
  'team_message',
  'team_plan',
  'session_message',
  'session_metadata',
  // New to the v1 index. None of the history domains above describes the
  // per-prompt file backups a session takes, and the rule for adding a name is
  // an explicit schema, producer and consumer: the recorder's sink commits it,
  // the message projection restores the original record, and the existing file
  // history accumulator folds those records into the session's snapshots.
  'file_history',
  // Also new to the v1 index. The source a session was created from is read
  // back as a record — the session directory, the transcript index's side-task
  // check and the bridge's listing all parse the original `systemPayload` — so
  // it cannot ride in `session_metadata`, whose body is a metadata patch. The
  // domain name is the only discriminator a reader has for a body shape, so a
  // second shape under one name would make neither readable.
  'session_source',
] as const;

export type ManagedSessionDomain = (typeof MANAGED_SESSION_DOMAINS)[number];

/**
 * The domains a caller may actually submit today. The registry above is the
 * closed v1 name space; recognising a name never means the capability is
 * implemented or admitted, so submission is gated separately.
 */
export const MANAGED_SESSION_ENABLED_DOMAINS: readonly ManagedSessionDomain[] =
  ['goal_state', 'session_metadata', 'file_history', 'session_source'];

export function assertManagedSessionDomainEnabled(
  domain: ManagedSessionDomain,
): void {
  if (!MANAGED_SESSION_ENABLED_DOMAINS.includes(domain)) {
    throw new ManagedSessionRecordError(
      `domain ${domain} is registered but not enabled for submission.`,
    );
  }
}

export const MANAGED_SESSION_ACTOR_CLASSES = [
  'harness',
  'coordinator',
  'trusted_entry',
  'authority',
] as const;

export type ManagedSessionActorClass =
  (typeof MANAGED_SESSION_ACTOR_CLASSES)[number];

export const MANAGED_SESSION_LIFECYCLE_STATES = [
  'idle',
  'active',
  'closing',
  'closed',
  'archived',
  'deleting',
  'deleted',
  'recovery_blocked',
] as const;

export type ManagedSessionLifecycleState =
  (typeof MANAGED_SESSION_LIFECYCLE_STATES)[number];

export const MANAGED_SESSION_ACTION_SOURCES = [
  'tool_call',
  'automation_run',
  'team_plan',
  'user_operation',
] as const;

export type ManagedSessionActionSource =
  (typeof MANAGED_SESSION_ACTION_SOURCES)[number];

export interface ManagedSessionKey {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface ManagedSessionDurableRef {
  readonly resourceId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly byteLength: number;
  readonly digest: string;
}

export type ManagedSessionSubject =
  | {
      readonly type: 'activation';
      readonly scopeId: string;
      readonly activationId: string;
      readonly epoch: number;
    }
  | { readonly type: 'turn'; readonly turnId: string }
  | {
      readonly type: 'hook_operation';
      readonly operationId: string;
      readonly occurrenceId: string;
    };

export interface ManagedSessionEvent {
  readonly v: 1;
  readonly sequence: number;
  readonly eventId: string;
  readonly sessionKey: ManagedSessionKey;
  readonly kind: ManagedSessionEventKind;
  readonly occurredAt: number;
  readonly subject?: ManagedSessionSubject;
  readonly payload: Readonly<Record<string, ManagedSessionJsonValue>>;
}

export interface ManagedSessionHeader {
  readonly formatVersion: number;
  readonly minimumReader: string;
  readonly sessionKey: ManagedSessionKey;
  readonly engine: 'managed';
  readonly definitionRef: ManagedSessionDurableRef;
  readonly rootSnapshotRef: ManagedSessionDurableRef;
  readonly createdBy: string;
  readonly baseTranscriptProof?: ManagedSessionDurableRef;
}

export interface ManagedSessionCommitMarker {
  readonly transactionId: string;
  readonly commandId: string;
  readonly operation: string;
  readonly contentDigest: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly eventsDigest: string;
  readonly previousCommitDigest: string | null;
}

export class ManagedSessionRecordError extends Error {
  readonly code: string = 'managed_session_invalid_record';

  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionRecordError';
  }
}

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function object(
  value: unknown,
  label: string,
): Record<string, ManagedSessionJsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, ManagedSessionJsonValue>;
}

function assertNoUnknownKeys(
  input: Record<string, ManagedSessionJsonValue>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      fail(`${label} has the unknown field "${key}".`);
    }
  }
}

function boundedString(
  value: ManagedSessionJsonValue | undefined,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must not contain control characters.`);
  }
  return value;
}

export function assertManagedSessionStableId(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): string {
  return boundedString(value, label, MANAGED_SESSION_LIMITS.maxIdBytes);
}

export function assertManagedSessionSequence(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer.`);
  }
  if (value === Number.MAX_SAFE_INTEGER) {
    fail(`${label} reached the maximum safe integer and cannot advance.`);
  }
  return value;
}

export function assertManagedSessionTime(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be UTC Unix milliseconds as a safe integer.`);
  }
  return value;
}

export function assertManagedSessionDigest(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

export function assertManagedSessionKey(
  value: ManagedSessionJsonValue | undefined,
  label = 'sessionKey',
): ManagedSessionKey {
  const record = object(value, label);
  assertNoUnknownKeys(record, ['tenantId', 'workspaceId', 'sessionId'], label);
  return {
    tenantId: assertKeyComponent(record['tenantId'], `${label}.tenantId`),
    workspaceId: assertKeyComponent(
      record['workspaceId'],
      `${label}.workspaceId`,
    ),
    sessionId: assertKeyComponent(record['sessionId'], `${label}.sessionId`),
  };
}

/**
 * §2.1 derives on-disk resource roots from these components, so they must be
 * usable as a single path segment.
 */
function assertKeyComponent(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): string {
  const id = assertManagedSessionStableId(value, label);
  if (/[/\\]/.test(id)) {
    fail(`${label} must not contain a path separator.`);
  }
  if (/^\.+$/.test(id)) {
    fail(`${label} must not be a relative path segment.`);
  }
  return id;
}

export function managedSessionKeysEqual(
  left: ManagedSessionKey,
  right: ManagedSessionKey,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  );
}

export function assertManagedSessionDurableRef(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): ManagedSessionDurableRef {
  const record = object(value, label);
  assertNoUnknownKeys(
    record,
    ['resourceId', 'kind', 'schemaVersion', 'byteLength', 'digest'],
    label,
  );
  return {
    resourceId: assertManagedSessionStableId(
      record['resourceId'],
      `${label}.resourceId`,
    ),
    kind: assertManagedSessionStableId(record['kind'], `${label}.kind`),
    schemaVersion: assertManagedSessionSequence(
      record['schemaVersion'],
      `${label}.schemaVersion`,
    ),
    byteLength: assertManagedSessionSequence(
      record['byteLength'],
      `${label}.byteLength`,
    ),
    digest: assertManagedSessionDigest(record['digest'], `${label}.digest`),
  };
}

export function assertManagedBranchRecord(
  value: unknown,
  sessionKey: ManagedSessionKey,
  recordId: string,
): ChatRecord {
  const record = object(value, 'branch record');
  if (
    record['type'] !== 'system' ||
    record['subtype'] !== 'branch_checkpoint' ||
    record['uuid'] !== recordId ||
    record['sessionId'] !== sessionKey.sessionId ||
    typeof record['timestamp'] !== 'string' ||
    !Number.isFinite(Date.parse(record['timestamp'])) ||
    typeof record['cwd'] !== 'string' ||
    typeof record['version'] !== 'string' ||
    (record['parentUuid'] !== null &&
      (typeof record['parentUuid'] !== 'string' ||
        record['parentUuid'].length === 0)) ||
    parseBranchCheckpointPayload(
      record['systemPayload'] as unknown as ChatRecord['systemPayload'],
    ) === undefined
  ) {
    fail('branch record does not match its committed identity or v1 payload.');
  }
  return record as unknown as ChatRecord;
}

function assertSubject(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): ManagedSessionSubject {
  const record = object(value, label);
  const type = record['type'];
  if (type === 'activation') {
    assertNoUnknownKeys(
      record,
      ['type', 'scopeId', 'activationId', 'epoch'],
      label,
    );
    return {
      type: 'activation',
      scopeId: assertManagedSessionStableId(
        record['scopeId'],
        `${label}.scopeId`,
      ),
      activationId: assertManagedSessionStableId(
        record['activationId'],
        `${label}.activationId`,
      ),
      epoch: assertManagedSessionSequence(record['epoch'], `${label}.epoch`),
    };
  }
  if (type === 'turn') {
    assertNoUnknownKeys(record, ['type', 'turnId'], label);
    return {
      type: 'turn',
      turnId: assertManagedSessionStableId(record['turnId'], `${label}.turnId`),
    };
  }
  if (type === 'hook_operation') {
    assertNoUnknownKeys(record, ['type', 'operationId', 'occurrenceId'], label);
    return {
      type: 'hook_operation',
      operationId: assertManagedSessionStableId(
        record['operationId'],
        `${label}.operationId`,
      ),
      occurrenceId: assertManagedSessionStableId(
        record['occurrenceId'],
        `${label}.occurrenceId`,
      ),
    };
  }
  return fail(`${label}.type must be activation, turn or hook_operation.`);
}

type FieldKind =
  | 'id'
  | 'idOrNull'
  | 'ids'
  | 'sequence'
  | 'sequenceOrNull'
  | 'time'
  | 'timeOrNull'
  | 'ref'
  | 'refOrNull'
  | 'refs'
  | 'text'
  | 'textOrNull'
  | 'subject'
  | 'json';

interface PayloadSchema {
  readonly fields: Readonly<Record<string, FieldKind>>;
  readonly optional?: readonly string[];
}

const EVENT_SCHEMAS: Readonly<Record<ManagedSessionEventKind, PayloadSchema>> =
  {
    'input.accepted': {
      fields: {
        inputId: 'id',
        turnId: 'id',
        source: 'text',
        contentRef: 'ref',
        deadline: 'timeOrNull',
        admissionRef: 'ref',
      },
    },
    'wake.requested': {
      fields: {
        wakeId: 'id',
        reason: 'text',
        subject: 'subject',
        sourceEventId: 'id',
        requiredSequence: 'sequence',
      },
    },
    'activation.changed': {
      fields: {
        activationId: 'id',
        epoch: 'sequence',
        workerId: 'id',
        subject: 'subject',
        phase: 'text',
        leaseDurationMs: 'sequenceOrNull',
        expiresAt: 'timeOrNull',
        installRef: 'refOrNull',
        boundaryRef: 'refOrNull',
        renewalSeq: 'sequence',
      },
      optional: ['renewalSeq'],
    },
    'model.attempt': {
      fields: {
        attemptId: 'id',
        routeRef: 'ref',
        inputCheckpointRef: 'refOrNull',
        state: 'text',
        usageRef: 'refOrNull',
      },
    },
    'message.committed': {
      fields: {
        messageId: 'id',
        role: 'text',
        contentRef: 'ref',
        modelAttemptId: 'idOrNull',
        parentMessageId: 'idOrNull',
      },
      optional: ['modelAttemptId'],
    },
    'tool.intent': {
      fields: {
        executionCallId: 'id',
        batchId: 'id',
        ordinal: 'sequence',
        toolDefinitionRef: 'ref',
        argsRef: 'ref',
        outcomeSource: 'text',
      },
    },
    'action.changed': {
      fields: {
        requestId: 'id',
        kind: 'text',
        source: 'text',
        inputRevision: 'sequence',
        optionsRef: 'refOrNull',
        state: 'text',
        decisionRef: 'refOrNull',
      },
    },
    'tool.receipt': {
      fields: {
        executionCallId: 'id',
        toolOutcomeRef: 'ref',
        resultRef: 'refOrNull',
        resources: 'refs',
        historyRevision: 'sequence',
      },
    },
    'checkpoint.committed': {
      fields: {
        checkpointId: 'id',
        coveredSequence: 'sequence',
        previousCheckpointId: 'idOrNull',
        stateRef: 'ref',
        boundary: 'textOrNull',
      },
    },
    'context.compacted': {
      fields: {
        compactionId: 'id',
        fromSequence: 'sequence',
        toSequence: 'sequence',
        summaryRef: 'ref',
        replacedMessageIds: 'ids',
        tokenCountsRef: 'refOrNull',
      },
    },
    'cancel.requested': {
      fields: {
        requestId: 'id',
        target: 'json',
        reason: 'text',
        requestedBy: 'text',
      },
    },
    'turn.settled': {
      fields: {
        turnId: 'id',
        outcome: 'text',
        stopReason: 'textOrNull',
        resultRef: 'refOrNull',
        usageRef: 'refOrNull',
        pendingOwnersRef: 'refOrNull',
      },
    },
    'config.bound': {
      fields: {
        revision: 'sequence',
        previousRevision: 'sequenceOrNull',
        bundleRef: 'ref',
        rootSnapshotRef: 'ref',
      },
    },
    'lifecycle.changed': {
      fields: {
        operationId: 'id',
        from: 'textOrNull',
        to: 'text',
        reason: 'text',
        pendingOwnersRef: 'refOrNull',
      },
    },
    'domain.committed': {
      fields: {
        domain: 'text',
        version: 'sequence',
        operationId: 'id',
        recordRef: 'ref',
      },
    },
  };

/**
 * Which actor class may request each kind. The authority still performs every
 * append; these entries constrain who is allowed to ask for it.
 */
const EVENT_ACTORS: Readonly<
  Record<ManagedSessionEventKind, readonly ManagedSessionActorClass[]>
> = {
  'input.accepted': ['trusted_entry'],
  'wake.requested': ['authority'],
  'activation.changed': ['coordinator'],
  'model.attempt': ['harness'],
  'message.committed': ['harness', 'trusted_entry'],
  'tool.intent': ['harness'],
  'action.changed': ['harness', 'trusted_entry'],
  'tool.receipt': ['trusted_entry'],
  'checkpoint.committed': ['harness'],
  'context.compacted': ['harness'],
  'cancel.requested': ['trusted_entry'],
  'turn.settled': ['harness', 'authority'],
  'config.bound': ['trusted_entry'],
  'lifecycle.changed': ['trusted_entry'],
  'domain.committed': ['trusted_entry'],
};

const HARNESS_ONLY_KINDS: readonly ManagedSessionEventKind[] = [
  'model.attempt',
  'tool.intent',
  'context.compacted',
  'checkpoint.committed',
];

function assertField(
  payload: Record<string, ManagedSessionJsonValue>,
  name: string,
  kind: FieldKind,
  label: string,
): void {
  const value = payload[name];
  const at = `${label}.${name}`;
  switch (kind) {
    case 'id':
      assertManagedSessionStableId(value, at);
      return;
    case 'idOrNull':
      if (value !== null) assertManagedSessionStableId(value, at);
      return;
    case 'ids':
      if (!Array.isArray(value)) fail(`${at} must be an array.`);
      value.forEach((item, index) =>
        assertManagedSessionStableId(item, `${at}[${index}]`),
      );
      return;
    case 'sequence':
      assertManagedSessionSequence(value, at);
      return;
    case 'sequenceOrNull':
      if (value !== null) assertManagedSessionSequence(value, at);
      return;
    case 'time':
      assertManagedSessionTime(value, at);
      return;
    case 'timeOrNull':
      if (value !== null) assertManagedSessionTime(value, at);
      return;
    case 'ref':
      assertManagedSessionDurableRef(value, at);
      return;
    case 'refOrNull':
      if (value !== null) assertManagedSessionDurableRef(value, at);
      return;
    case 'refs':
      if (!Array.isArray(value)) fail(`${at} must be an array.`);
      value.forEach((item, index) =>
        assertManagedSessionDurableRef(item, `${at}[${index}]`),
      );
      return;
    case 'text':
      boundedString(value, at, MANAGED_SESSION_LIMITS.maxTextBytes);
      return;
    case 'textOrNull':
      if (value !== null) {
        boundedString(value, at, MANAGED_SESSION_LIMITS.maxTextBytes);
      }
      return;
    case 'subject':
      assertSubject(value, at);
      return;
    case 'json':
      if (value === undefined) fail(`${at} is required.`);
      canonicalDigest(value, MANAGED_SESSION_LIMITS.maxEventBytes, at);
      return;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
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

function assertPayloadRules(
  kind: ManagedSessionEventKind,
  payload: Record<string, ManagedSessionJsonValue>,
): void {
  const at = `payload`;
  switch (kind) {
    case 'activation.changed': {
      const phase = assertEnum(
        payload['phase'],
        ['installing', 'active', 'released', 'revoked'] as const,
        `${at}.phase`,
      );
      const open = phase === 'installing' || phase === 'active';
      if (payload['expiresAt'] === null) {
        fail(`${at}.expiresAt must be present when phase is ${phase}.`);
      }
      if (open) {
        for (const name of ['leaseDurationMs', 'installRef']) {
          if (payload[name] === null) {
            fail(`${at}.${name} must be present when phase is ${phase}.`);
          }
        }
        if (payload['boundaryRef'] !== null) {
          fail(`${at}.boundaryRef must be null when phase is ${phase}.`);
        }
        return;
      }
      if (payload['boundaryRef'] === null) {
        fail(`${at}.boundaryRef must be present when phase is ${phase}.`);
      }
      return;
    }
    case 'model.attempt': {
      const state = assertEnum(
        payload['state'],
        ['started', 'output_committed', 'abandoned'] as const,
        `${at}.state`,
      );
      if (state === 'started' && payload['usageRef'] !== null) {
        fail(`${at}.usageRef must be null while the attempt is started.`);
      }
      return;
    }
    case 'action.changed': {
      assertEnum(
        payload['source'],
        MANAGED_SESSION_ACTION_SOURCES,
        `${at}.source`,
      );
      const state = assertEnum(
        payload['state'],
        ['requested', 'decided', 'cancelled', 'expired'] as const,
        `${at}.state`,
      );
      if ((state === 'decided') === (payload['decisionRef'] === null)) {
        fail(
          `${at}.decisionRef must be ${
            state === 'decided' ? 'present' : 'null'
          } when state is ${state}.`,
        );
      }
      return;
    }
    case 'lifecycle.changed': {
      assertEnum(payload['to'], MANAGED_SESSION_LIFECYCLE_STATES, `${at}.to`);
      if (payload['from'] !== null) {
        assertEnum(
          payload['from'],
          MANAGED_SESSION_LIFECYCLE_STATES,
          `${at}.from`,
        );
      }
      return;
    }
    case 'context.compacted': {
      const from = assertManagedSessionSequence(
        payload['fromSequence'],
        `${at}.fromSequence`,
      );
      const to = assertManagedSessionSequence(
        payload['toSequence'],
        `${at}.toSequence`,
      );
      if (to < from) {
        fail(`${at}.toSequence must not precede ${at}.fromSequence.`);
      }
      return;
    }
    case 'domain.committed': {
      const domain = assertEnum(
        payload['domain'],
        MANAGED_SESSION_DOMAINS,
        `${at}.domain`,
      );
      if (payload['version'] !== MANAGED_SESSION_FORMAT_VERSION) {
        fail(`${at}.version must be ${MANAGED_SESSION_FORMAT_VERSION}.`);
      }
      const recordRef = assertManagedSessionDurableRef(
        payload['recordRef'],
        `${at}.recordRef`,
      );
      if (recordRef.kind !== `managed-${domain}`) {
        fail(`${at}.recordRef.kind must be managed-${domain}.`);
      }
      if (recordRef.schemaVersion !== 1) {
        fail(`${at}.recordRef.schemaVersion must be 1.`);
      }
      return;
    }
    default:
      return;
  }
}

export function parseManagedSessionEvent(value: unknown): ManagedSessionEvent {
  const record = object(value, 'event');
  assertNoUnknownKeys(
    record,
    [
      'v',
      'sequence',
      'eventId',
      'sessionKey',
      'kind',
      'occurredAt',
      'subject',
      'payload',
    ],
    'event',
  );
  if (record['v'] !== MANAGED_SESSION_FORMAT_VERSION) {
    fail(`event.v must be ${MANAGED_SESSION_FORMAT_VERSION}.`);
  }
  const sequence = assertManagedSessionSequence(
    record['sequence'],
    'event.sequence',
  );
  if (sequence < 1) fail('event.sequence must start at 1.');
  const kind = assertEnum(
    record['kind'],
    MANAGED_SESSION_EVENT_KINDS,
    'event.kind',
  );
  const schema = EVENT_SCHEMAS[kind];
  const payload = object(record['payload'], 'payload');
  const names = Object.keys(schema.fields);
  assertNoUnknownKeys(payload, names, 'payload');
  const optional = schema.optional ?? [];
  for (const name of names) {
    if (!(name in payload)) {
      if (optional.includes(name)) continue;
      fail(`payload.${name} is required for ${kind}.`);
    }
    assertField(payload, name, schema.fields[name], 'payload');
  }
  assertPayloadRules(kind, payload);

  const subject =
    record['subject'] === undefined
      ? undefined
      : assertSubject(record['subject'], 'event.subject');
  if (HARNESS_ONLY_KINDS.includes(kind) && subject?.type !== 'activation') {
    fail(`${kind} requires an activation subject.`);
  }

  return {
    v: MANAGED_SESSION_FORMAT_VERSION,
    sequence,
    eventId: assertManagedSessionStableId(record['eventId'], 'event.eventId'),
    sessionKey: assertManagedSessionKey(
      record['sessionKey'],
      'event.sessionKey',
    ),
    kind,
    occurredAt: assertManagedSessionTime(
      record['occurredAt'],
      'event.occurredAt',
    ),
    ...(subject === undefined ? {} : { subject }),
    payload: Object.freeze(payload),
  };
}

/**
 * Rejects an actor class that may not request the kind. `action.changed` is
 * split by source and state because only the current Harness may raise a
 * tool_call request, while every final decision goes through the arbiter.
 */
export function assertManagedSessionEventActor(
  event: ManagedSessionEvent,
  actor: ManagedSessionActorClass,
): void {
  if (event.kind === 'action.changed') {
    const source = event.payload['source'] as ManagedSessionActionSource;
    const state = event.payload['state'] as string;
    const expected: ManagedSessionActorClass =
      state === 'requested' && source === 'tool_call'
        ? 'harness'
        : 'trusted_entry';
    if (actor !== expected) {
      fail(
        `action.changed ${state}/${source} must be requested by ${expected}, not ${actor}.`,
      );
    }
    assertHarnessSubject(event, actor);
    return;
  }
  if (!EVENT_ACTORS[event.kind].includes(actor)) {
    fail(`${event.kind} must not be requested by ${actor}.`);
  }
  assertHarnessSubject(event, actor);
}

/** Every kind the Harness may request is a Harness-advancing record. */
function assertHarnessSubject(
  event: ManagedSessionEvent,
  actor: ManagedSessionActorClass,
): void {
  if (actor === 'harness' && event.subject?.type !== 'activation') {
    fail(`${event.kind} from the harness requires an activation subject.`);
  }
}

const LIFECYCLE_TRANSITIONS: Readonly<
  Record<ManagedSessionLifecycleState, readonly ManagedSessionLifecycleState[]>
> = {
  idle: ['active', 'closing'],
  active: ['idle', 'closing'],
  closing: ['closed'],
  closed: ['archived', 'deleting'],
  archived: ['closed', 'deleting'],
  deleting: ['deleted'],
  deleted: [],
  // Recovery returns the session to the intended stage it saved when it
  // blocked, so the caller must still match `to` against that saved stage.
  recovery_blocked: [
    'idle',
    'active',
    'closing',
    'closed',
    'archived',
    'deleting',
  ],
};

export function isManagedSessionLifecycleTransitionAllowed(
  from: ManagedSessionLifecycleState | null,
  to: ManagedSessionLifecycleState,
): boolean {
  if (from === null) return to === 'idle';
  if (to === 'recovery_blocked') return from !== 'deleted';
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function parseManagedSessionHeader(
  value: unknown,
): ManagedSessionHeader {
  const record = object(value, 'header');
  assertNoUnknownKeys(
    record,
    [
      'formatVersion',
      'minimumReader',
      'sessionKey',
      'engine',
      'definitionRef',
      'rootSnapshotRef',
      'createdBy',
      'baseTranscriptProof',
    ],
    'header',
  );
  if (record['formatVersion'] !== MANAGED_SESSION_FORMAT_VERSION) {
    fail(
      `header.formatVersion ${String(record['formatVersion'])} is not supported by this reader.`,
    );
  }
  if (record['minimumReader'] !== MANAGED_SESSION_MINIMUM_READER) {
    fail(
      `header.minimumReader ${String(record['minimumReader'])} is not supported by this reader.`,
    );
  }
  if (record['engine'] !== 'managed') {
    fail('header.engine must be managed.');
  }
  const proof = record['baseTranscriptProof'];
  return {
    formatVersion: MANAGED_SESSION_FORMAT_VERSION,
    minimumReader: MANAGED_SESSION_MINIMUM_READER,
    sessionKey: assertManagedSessionKey(
      record['sessionKey'],
      'header.sessionKey',
    ),
    engine: 'managed',
    definitionRef: assertManagedSessionDurableRef(
      record['definitionRef'],
      'header.definitionRef',
    ),
    rootSnapshotRef: assertManagedSessionDurableRef(
      record['rootSnapshotRef'],
      'header.rootSnapshotRef',
    ),
    createdBy: assertManagedSessionStableId(
      record['createdBy'],
      'header.createdBy',
    ),
    ...(proof === undefined
      ? {}
      : {
          baseTranscriptProof: assertManagedSessionDurableRef(
            proof,
            'header.baseTranscriptProof',
          ),
        }),
  };
}

export function parseManagedSessionCommitMarker(
  value: unknown,
): ManagedSessionCommitMarker {
  const record = object(value, 'commit');
  assertNoUnknownKeys(
    record,
    [
      'transactionId',
      'commandId',
      'operation',
      'contentDigest',
      'firstSequence',
      'lastSequence',
      'eventCount',
      'eventsDigest',
      'previousCommitDigest',
    ],
    'commit',
  );
  const firstSequence = assertManagedSessionSequence(
    record['firstSequence'],
    'commit.firstSequence',
  );
  const lastSequence = assertManagedSessionSequence(
    record['lastSequence'],
    'commit.lastSequence',
  );
  const eventCount = assertManagedSessionSequence(
    record['eventCount'],
    'commit.eventCount',
  );
  if (firstSequence < 1) fail('commit.firstSequence must start at 1.');
  if (eventCount < 1) fail('commit.eventCount must cover at least one event.');
  if (eventCount > MANAGED_SESSION_LIMITS.maxTransactionEvents) {
    fail(
      `commit.eventCount exceeds ${MANAGED_SESSION_LIMITS.maxTransactionEvents} events.`,
    );
  }
  if (lastSequence - firstSequence + 1 !== eventCount) {
    fail('commit sequence range must match commit.eventCount.');
  }
  const previous = record['previousCommitDigest'];
  return {
    transactionId: assertManagedSessionStableId(
      record['transactionId'],
      'commit.transactionId',
    ),
    commandId: assertManagedSessionStableId(
      record['commandId'],
      'commit.commandId',
    ),
    operation: boundedString(
      record['operation'],
      'commit.operation',
      MANAGED_SESSION_LIMITS.maxTextBytes,
    ),
    contentDigest: assertManagedSessionDigest(
      record['contentDigest'],
      'commit.contentDigest',
    ),
    firstSequence,
    lastSequence,
    eventCount,
    eventsDigest: assertManagedSessionDigest(
      record['eventsDigest'],
      'commit.eventsDigest',
    ),
    previousCommitDigest:
      previous === null
        ? null
        : assertManagedSessionDigest(previous, 'commit.previousCommitDigest'),
  };
}

/**
 * Digest over the committed events. It covers full event content, not just
 * identities, so a replaced or corrupted body cannot match a stored marker.
 */
export function managedSessionEventsDigest(
  events: readonly ManagedSessionEvent[],
): string {
  return canonicalDigest(
    events,
    MANAGED_SESSION_LIMITS.maxTransactionBytes,
    'transaction events',
  );
}

function canonicalDigest(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  try {
    return managedToolDigest(value, maxBytes);
  } catch (cause) {
    return fail(
      `${label} is not canonically encodable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export function assertManagedSessionTransaction(
  events: readonly ManagedSessionEvent[],
  encodedBytes: number,
): void {
  if (events.length === 0) {
    fail('a transaction must contain at least one event.');
  }
  if (events.length > MANAGED_SESSION_LIMITS.maxTransactionEvents) {
    fail(
      `a transaction must not exceed ${MANAGED_SESSION_LIMITS.maxTransactionEvents} events.`,
    );
  }
  if (encodedBytes > MANAGED_SESSION_LIMITS.maxTransactionBytes) {
    fail(
      `a transaction must not exceed ${MANAGED_SESSION_LIMITS.maxTransactionBytes} bytes.`,
    );
  }
  const key = events[0].sessionKey;
  events.forEach((event, index) => {
    if (!managedSessionKeysEqual(event.sessionKey, key)) {
      fail('a transaction must not span sessions.');
    }
    if (index > 0 && event.sequence !== events[index - 1].sequence + 1) {
      fail('a transaction must append a contiguous sequence range.');
    }
  });
}

/**
 * Parses one raw record line. Duplicate keys survive in the wire bytes but are
 * silently collapsed by `JSON.parse`, so they are rejected before parsing.
 */
export function parseManagedSessionRecordJson(
  text: string,
  maxBytes: number,
): ManagedSessionJsonValue {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    fail(`record exceeds ${maxBytes} UTF-8 bytes.`);
  }
  assertNoDuplicateJsonKeys(text);
  try {
    return JSON.parse(text) as ManagedSessionJsonValue;
  } catch {
    return fail('record is not valid JSON.');
  }
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const stack: Array<Set<string>> = [];
  const enter = (): void => {
    if (stack.length + 1 > MANAGED_SESSION_LIMITS.maxJsonDepth) {
      fail(
        `record exceeds the maximum JSON depth of ${MANAGED_SESSION_LIMITS.maxJsonDepth}.`,
      );
    }
    stack.push(new Set<string>());
  };
  const readString = (): string => {
    let out = '';
    index++;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index++;
        return out;
      }
      if (char === '\\') {
        const escape = text[index + 1];
        index += 2;
        if (escape === 'u') {
          const code = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(code)) {
            fail('record has an invalid JSON unicode escape.');
          }
          index += 4;
          out += String.fromCharCode(Number.parseInt(code, 16));
          continue;
        }
        const decoded = JSON_ESCAPES[escape];
        if (decoded === undefined) {
          fail('record has an invalid JSON string escape.');
        }
        out += decoded;
        continue;
      }
      out += char;
      index++;
    }
    return fail('record has an unterminated JSON string.');
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const value = readString();
      // A string directly followed by ':' is a key in the enclosing object.
      let probe = index;
      while (probe < text.length && /\s/.test(text[probe])) probe++;
      if (text[probe] === ':' && stack.length > 0) {
        if (value === '__proto__') {
          fail('record must not use "__proto__" as a JSON key.');
        }
        const keys = stack[stack.length - 1];
        if (keys.has(value)) {
          fail(`record has the duplicate JSON key "${value}".`);
        }
        keys.add(value);
      }
      continue;
    }
    if (char === '{') {
      enter();
    } else if (char === '}') {
      stack.pop();
    } else if (char === '[') {
      // Array members are not keys of the enclosing object.
      enter();
    } else if (char === ']') {
      stack.pop();
    }
    index++;
  }
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionJsonValue } from './managed-session-inbox.js';
import {
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionKey,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  managedSessionKeysEqual,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from './managed-session-records.js';

export const HARNESS_CHECKPOINT_SCHEMA_VERSION = 1;

export const HARNESS_CHECKPOINT_PHASES = [
  'before_model',
  'model_output_committed',
  'await_action',
  'await_runtime',
  'results_ready',
  'turn_settled',
] as const;

export type HarnessCheckpointPhase = (typeof HARNESS_CHECKPOINT_PHASES)[number];

/**
 * Phases from which R2.S2 may start a model request. Awaited approvals and
 * in-flight Runtime work are R2.S3; those phases are runnable checkpoints
 * but not a finished-turn safety point.
 */
export const HARNESS_MODEL_START_PHASES: ReadonlySet<HarnessCheckpointPhase> =
  new Set([
    'before_model',
    'model_output_committed',
    'results_ready',
    'turn_settled',
  ]);

/** Event-payload boundary for a finished turn with no pending Harness work. */
export const HARNESS_TURN_COMPLETE_BOUNDARY = 'turn_complete';

/** Event-payload boundary for an approval or in-flight Runtime wait. */
export const HARNESS_DURABLE_WAIT_BOUNDARY = 'durable_wait';

export const HARNESS_ACTION_SOURCES = [
  'tool_call',
  'automation_run',
  'team_plan',
  'user_operation',
] as const;

export type HarnessActionSource = (typeof HARNESS_ACTION_SOURCES)[number];

export const HARNESS_TOOL_ITEM_STATES = [
  'not_started',
  'in_progress',
  'settled',
] as const;

export type HarnessToolItemState = (typeof HARNESS_TOOL_ITEM_STATES)[number];

export const HARNESS_TOOL_OUTCOME_SOURCES = [
  'runtime',
  'orchestration',
  'domain',
] as const;

export type HarnessToolOutcomeSource =
  (typeof HARNESS_TOOL_OUTCOME_SOURCES)[number];

export const HARNESS_RUNTIME_STATES = [
  'dispatch',
  'settled',
  'committed',
] as const;

export type HarnessRuntimeState = (typeof HARNESS_RUNTIME_STATES)[number];

export const HARNESS_APPROVAL_STATES = [
  'requested',
  'decided',
  'cancelled',
  'expired',
] as const;

export type HarnessApprovalState = (typeof HARNESS_APPROVAL_STATES)[number];

export const HARNESS_ATTEMPT_OUTPUT_STATES = [
  'started',
  'output_committed',
  'abandoned',
] as const;

export type HarnessAttemptOutputState =
  (typeof HARNESS_ATTEMPT_OUTPUT_STATES)[number];

export interface HarnessCheckpointIdentity {
  readonly schemaVersion: typeof HARNESS_CHECKPOINT_SCHEMA_VERSION;
  readonly sessionKey: ManagedSessionKey;
  readonly engine: 'managed';
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly activationId: string;
  readonly turnId: string | null;
  readonly promptId: string | null;
  readonly definitionRevision: string;
  readonly configRevision: string;
  readonly inputDigest: string;
  readonly previousCheckpointId: string | null;
}

export interface HarnessResumeRecording {
  readonly lastCompletedUuid: string | null;
  readonly turnParentUuids: readonly string[];
  readonly parentSessionId: string | null;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly lastAssistantModel: string | null;
  readonly executionEngine: 'managed';
}

/**
 * Resume state is rebuilt from the session log through `throughSequence`.
 * Large arrays live behind refs so the checkpoint does not clone the Agent.
 */
export interface HarnessResumeGroup {
  readonly source: 'session_log';
  readonly throughSequence: number;
  readonly recording: HarnessResumeRecording;
  readonly initialTurn: number;
  readonly consumedNotificationIds: readonly string[];
  readonly apiHistoryRef: ManagedSessionDurableRef | null;
  readonly fileHistoryRef: ManagedSessionDurableRef | null;
  readonly artifactRef: ManagedSessionDurableRef | null;
  readonly goalRecordsRef: ManagedSessionDurableRef | null;
  readonly goalCheckpointWindowRef: ManagedSessionDurableRef | null;
  readonly tokenCountsRef: ManagedSessionDurableRef | null;
  readonly uiTelemetryRef: ManagedSessionDurableRef | null;
  readonly attributionRef: ManagedSessionDurableRef | null;
  readonly goalRecoverySourceUuid: string | null;
}

export interface HarnessContinuationGroup {
  readonly phase: HarnessCheckpointPhase;
  readonly pendingEventIds: readonly string[];
}

export interface HarnessAttemptGroup {
  readonly attemptId: string;
  readonly routeRef: ManagedSessionDurableRef;
  readonly capabilityRef: ManagedSessionDurableRef | null;
  readonly samplingRef: ManagedSessionDurableRef | null;
  readonly outputState: HarnessAttemptOutputState;
  readonly usageRef: ManagedSessionDurableRef | null;
  readonly budgetConsumed: number;
}

export interface HarnessToolItem {
  readonly functionCallId: string;
  readonly toolName: string;
  readonly executionCallId: string;
  readonly modelMessageId: string;
  readonly partIndex: number;
  readonly ordinal: number;
  readonly inputDigest: string;
  readonly outcomeSource: HarnessToolOutcomeSource;
  readonly state: HarnessToolItemState;
  readonly outcomeRef: ManagedSessionDurableRef | null;
  readonly consumed: boolean;
}

export interface HarnessToolsGroup {
  readonly batchId: string | null;
  readonly items: readonly HarnessToolItem[];
}

export interface HarnessRuntimeBinding {
  readonly executionCallId: string;
  readonly invocationBindingId: string;
  readonly capabilityVersion: string;
  readonly policyVersion: string;
  readonly mediaVersion: string | null;
  readonly state: HarnessRuntimeState;
  readonly progressCursor: string | null;
}

export interface HarnessRuntimeGroup {
  readonly bindings: readonly HarnessRuntimeBinding[];
}

export interface HarnessApprovalGroup {
  readonly requestId: string;
  readonly kind: string;
  readonly source: HarnessActionSource;
  readonly optionsRef: ManagedSessionDurableRef;
  readonly inputRevision: string;
  readonly confirmationVersion: string | null;
  readonly state: HarnessApprovalState;
  readonly decisionRef: ManagedSessionDurableRef | null;
  readonly invocationRef: ManagedSessionDurableRef | null;
}

export interface HarnessOutputGroup {
  readonly llmContentRef: ManagedSessionDurableRef | null;
  readonly physicalStatus: string | null;
  readonly hookResultRef: ManagedSessionDurableRef | null;
  readonly mediaRefs: readonly ManagedSessionDurableRef[];
  readonly parentHistory: {
    readonly bindingId: string;
    readonly revision: number;
  } | null;
}

export interface HarnessFollowUpGroup {
  readonly pendingInputIds: readonly string[];
  readonly cancelRequestIds: readonly string[];
  readonly goalPermitIds: readonly string[];
  readonly cronIds: readonly string[];
  readonly notificationIds: readonly string[];
  readonly childRunIds: readonly string[];
  readonly stopBudgetRemaining: number | null;
  readonly scopeLineage: readonly string[];
}

export interface HarnessCheckpointV1 {
  readonly identity: HarnessCheckpointIdentity;
  readonly resume: HarnessResumeGroup;
  readonly continuation: HarnessContinuationGroup;
  readonly attempt: HarnessAttemptGroup | null;
  readonly tools: HarnessToolsGroup | null;
  readonly runtime: HarnessRuntimeGroup | null;
  readonly approval: HarnessApprovalGroup | null;
  readonly output: HarnessOutputGroup;
  readonly followUp: HarnessFollowUpGroup;
}

export type HarnessCheckpointParseFailureReason = 'opaque' | 'invalid';

export type HarnessCheckpointParseResult =
  | { readonly ok: true; readonly checkpoint: HarnessCheckpointV1 }
  | {
      readonly ok: false;
      readonly reason: HarnessCheckpointParseFailureReason;
      readonly message: string;
    };

export type HarnessRunAuthorization =
  | { readonly status: 'initial' }
  | { readonly status: 'runnable'; readonly checkpoint: HarnessCheckpointV1 }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'missing_checkpoint'
        | 'missing_state'
        | 'opaque_state'
        | 'invalid_state'
        | 'identity_mismatch';
      readonly message?: string;
    };

const ROOT_KEYS = [
  'identity',
  'resume',
  'continuation',
  'attempt',
  'tools',
  'runtime',
  'approval',
  'output',
  'followUp',
] as const;

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

function oneOf<T extends string>(
  value: ManagedSessionJsonValue | undefined,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

function idOrNull(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): string | null {
  if (value === null) return null;
  return assertManagedSessionStableId(value, label);
}

function refOrNull(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): ManagedSessionDurableRef | null {
  if (value === null) return null;
  return assertManagedSessionDurableRef(value, label);
}

function sequenceOrNull(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): number | null {
  if (value === null) return null;
  return assertManagedSessionSequence(value, label);
}

function jsonArray(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): ManagedSessionJsonValue[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be a JSON array.`);
  }
  return value;
}

function idList(
  value: ManagedSessionJsonValue | undefined,
  label: string,
): string[] {
  return jsonArray(value, label).map((item, index) =>
    assertManagedSessionStableId(item, `${label}[${index}]`),
  );
}

function uniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      fail(`${label} repeats "${id}".`);
    }
    seen.add(id);
  }
}

function parseIdentity(
  value: ManagedSessionJsonValue | undefined,
): HarnessCheckpointIdentity {
  const record = object(value, 'identity');
  assertNoUnknownKeys(
    record,
    [
      'schemaVersion',
      'sessionKey',
      'engine',
      'checkpointId',
      'coveredSequence',
      'activationId',
      'turnId',
      'promptId',
      'definitionRevision',
      'configRevision',
      'inputDigest',
      'previousCheckpointId',
    ],
    'identity',
  );
  if (record['schemaVersion'] !== HARNESS_CHECKPOINT_SCHEMA_VERSION) {
    fail('identity.schemaVersion must be 1.');
  }
  if (record['engine'] !== 'managed') {
    fail('identity.engine must be managed.');
  }
  return {
    schemaVersion: HARNESS_CHECKPOINT_SCHEMA_VERSION,
    sessionKey: assertManagedSessionKey(
      record['sessionKey'],
      'identity.sessionKey',
    ),
    engine: 'managed',
    checkpointId: assertManagedSessionStableId(
      record['checkpointId'],
      'identity.checkpointId',
    ),
    coveredSequence: assertManagedSessionSequence(
      record['coveredSequence'],
      'identity.coveredSequence',
    ),
    activationId: assertManagedSessionStableId(
      record['activationId'],
      'identity.activationId',
    ),
    turnId: idOrNull(record['turnId'], 'identity.turnId'),
    promptId: idOrNull(record['promptId'], 'identity.promptId'),
    definitionRevision: assertManagedSessionStableId(
      record['definitionRevision'],
      'identity.definitionRevision',
    ),
    configRevision: assertManagedSessionStableId(
      record['configRevision'],
      'identity.configRevision',
    ),
    inputDigest: assertManagedSessionDigest(
      record['inputDigest'],
      'identity.inputDigest',
    ),
    previousCheckpointId: idOrNull(
      record['previousCheckpointId'],
      'identity.previousCheckpointId',
    ),
  };
}

function parseRecording(
  value: ManagedSessionJsonValue | undefined,
): HarnessResumeRecording {
  const record = object(value, 'resume.recording');
  assertNoUnknownKeys(
    record,
    [
      'lastCompletedUuid',
      'turnParentUuids',
      'parentSessionId',
      'sourceType',
      'sourceId',
      'lastAssistantModel',
      'executionEngine',
    ],
    'resume.recording',
  );
  if (record['executionEngine'] !== 'managed') {
    fail('resume.recording.executionEngine must be managed.');
  }
  return {
    lastCompletedUuid: idOrNull(
      record['lastCompletedUuid'],
      'resume.recording.lastCompletedUuid',
    ),
    turnParentUuids: idList(
      record['turnParentUuids'],
      'resume.recording.turnParentUuids',
    ),
    parentSessionId: idOrNull(
      record['parentSessionId'],
      'resume.recording.parentSessionId',
    ),
    sourceType: idOrNull(record['sourceType'], 'resume.recording.sourceType'),
    sourceId: idOrNull(record['sourceId'], 'resume.recording.sourceId'),
    lastAssistantModel: idOrNull(
      record['lastAssistantModel'],
      'resume.recording.lastAssistantModel',
    ),
    executionEngine: 'managed',
  };
}

function parseResume(
  value: ManagedSessionJsonValue | undefined,
  coveredSequence: number,
): HarnessResumeGroup {
  const record = object(value, 'resume');
  assertNoUnknownKeys(
    record,
    [
      'source',
      'throughSequence',
      'recording',
      'initialTurn',
      'consumedNotificationIds',
      'apiHistoryRef',
      'fileHistoryRef',
      'artifactRef',
      'goalRecordsRef',
      'goalCheckpointWindowRef',
      'tokenCountsRef',
      'uiTelemetryRef',
      'attributionRef',
      'goalRecoverySourceUuid',
    ],
    'resume',
  );
  if (record['source'] !== 'session_log') {
    fail('resume.source must be session_log.');
  }
  const throughSequence = assertManagedSessionSequence(
    record['throughSequence'],
    'resume.throughSequence',
  );
  if (throughSequence !== coveredSequence) {
    fail('resume.throughSequence must equal identity.coveredSequence.');
  }
  const consumedNotificationIds = idList(
    record['consumedNotificationIds'],
    'resume.consumedNotificationIds',
  );
  uniqueIds(consumedNotificationIds, 'resume.consumedNotificationIds');
  return {
    source: 'session_log',
    throughSequence,
    recording: parseRecording(record['recording']),
    initialTurn: assertManagedSessionSequence(
      record['initialTurn'],
      'resume.initialTurn',
    ),
    consumedNotificationIds,
    apiHistoryRef: refOrNull(record['apiHistoryRef'], 'resume.apiHistoryRef'),
    fileHistoryRef: refOrNull(
      record['fileHistoryRef'],
      'resume.fileHistoryRef',
    ),
    artifactRef: refOrNull(record['artifactRef'], 'resume.artifactRef'),
    goalRecordsRef: refOrNull(
      record['goalRecordsRef'],
      'resume.goalRecordsRef',
    ),
    goalCheckpointWindowRef: refOrNull(
      record['goalCheckpointWindowRef'],
      'resume.goalCheckpointWindowRef',
    ),
    tokenCountsRef: refOrNull(
      record['tokenCountsRef'],
      'resume.tokenCountsRef',
    ),
    uiTelemetryRef: refOrNull(
      record['uiTelemetryRef'],
      'resume.uiTelemetryRef',
    ),
    attributionRef: refOrNull(
      record['attributionRef'],
      'resume.attributionRef',
    ),
    goalRecoverySourceUuid: idOrNull(
      record['goalRecoverySourceUuid'],
      'resume.goalRecoverySourceUuid',
    ),
  };
}

function parseContinuation(
  value: ManagedSessionJsonValue | undefined,
): HarnessContinuationGroup {
  const record = object(value, 'continuation');
  assertNoUnknownKeys(record, ['phase', 'pendingEventIds'], 'continuation');
  const pendingEventIds = idList(
    record['pendingEventIds'],
    'continuation.pendingEventIds',
  );
  uniqueIds(pendingEventIds, 'continuation.pendingEventIds');
  return {
    phase: oneOf(
      record['phase'],
      HARNESS_CHECKPOINT_PHASES,
      'continuation.phase',
    ),
    pendingEventIds,
  };
}

function parseAttempt(
  value: ManagedSessionJsonValue | undefined,
): HarnessAttemptGroup | null {
  if (value === null) return null;
  const record = object(value, 'attempt');
  assertNoUnknownKeys(
    record,
    [
      'attemptId',
      'routeRef',
      'capabilityRef',
      'samplingRef',
      'outputState',
      'usageRef',
      'budgetConsumed',
    ],
    'attempt',
  );
  const outputState = oneOf(
    record['outputState'],
    HARNESS_ATTEMPT_OUTPUT_STATES,
    'attempt.outputState',
  );
  const usageRef = refOrNull(record['usageRef'], 'attempt.usageRef');
  if (outputState === 'started' && usageRef !== null) {
    fail('attempt.usageRef must be null while outputState is started.');
  }
  return {
    attemptId: assertManagedSessionStableId(
      record['attemptId'],
      'attempt.attemptId',
    ),
    routeRef: assertManagedSessionDurableRef(
      record['routeRef'],
      'attempt.routeRef',
    ),
    capabilityRef: refOrNull(record['capabilityRef'], 'attempt.capabilityRef'),
    samplingRef: refOrNull(record['samplingRef'], 'attempt.samplingRef'),
    outputState,
    usageRef,
    budgetConsumed: assertManagedSessionSequence(
      record['budgetConsumed'],
      'attempt.budgetConsumed',
    ),
  };
}

function parseToolItem(
  value: ManagedSessionJsonValue,
  label: string,
): HarnessToolItem {
  const record = object(value, label);
  assertNoUnknownKeys(
    record,
    [
      'functionCallId',
      'toolName',
      'executionCallId',
      'modelMessageId',
      'partIndex',
      'ordinal',
      'inputDigest',
      'outcomeSource',
      'state',
      'outcomeRef',
      'consumed',
    ],
    label,
  );
  const state = oneOf(
    record['state'],
    HARNESS_TOOL_ITEM_STATES,
    `${label}.state`,
  );
  const outcomeRef = refOrNull(record['outcomeRef'], `${label}.outcomeRef`);
  if (state === 'settled' && outcomeRef === null) {
    fail(`${label}.outcomeRef is required once the item is settled.`);
  }
  if (state !== 'settled' && outcomeRef !== null) {
    fail(`${label}.outcomeRef must be null until the item is settled.`);
  }
  if (typeof record['consumed'] !== 'boolean') {
    fail(`${label}.consumed must be a boolean.`);
  }
  if (record['consumed'] && state !== 'settled') {
    fail(`${label} cannot be consumed before it is settled.`);
  }
  return {
    functionCallId: assertManagedSessionStableId(
      record['functionCallId'],
      `${label}.functionCallId`,
    ),
    toolName: assertManagedSessionStableId(
      record['toolName'],
      `${label}.toolName`,
    ),
    executionCallId: assertManagedSessionStableId(
      record['executionCallId'],
      `${label}.executionCallId`,
    ),
    modelMessageId: assertManagedSessionStableId(
      record['modelMessageId'],
      `${label}.modelMessageId`,
    ),
    partIndex: assertManagedSessionSequence(
      record['partIndex'],
      `${label}.partIndex`,
    ),
    ordinal: assertManagedSessionSequence(
      record['ordinal'],
      `${label}.ordinal`,
    ),
    inputDigest: assertManagedSessionDigest(
      record['inputDigest'],
      `${label}.inputDigest`,
    ),
    outcomeSource: oneOf(
      record['outcomeSource'],
      HARNESS_TOOL_OUTCOME_SOURCES,
      `${label}.outcomeSource`,
    ),
    state,
    outcomeRef,
    consumed: record['consumed'],
  };
}

function parseTools(
  value: ManagedSessionJsonValue | undefined,
): HarnessToolsGroup | null {
  if (value === null) return null;
  const record = object(value, 'tools');
  assertNoUnknownKeys(record, ['batchId', 'items'], 'tools');
  const items = jsonArray(record['items'], 'tools.items').map((item, index) =>
    parseToolItem(item, `tools.items[${index}]`),
  );
  uniqueIds(
    items.map((item) => item.executionCallId),
    'tools.items.executionCallId',
  );
  uniqueIds(
    items.map((item) => item.functionCallId),
    'tools.items.functionCallId',
  );
  const ordinals = new Set<number>();
  for (const item of items) {
    if (ordinals.has(item.ordinal)) {
      fail(`tools.items repeats ordinal ${item.ordinal}.`);
    }
    ordinals.add(item.ordinal);
  }
  return {
    batchId: idOrNull(record['batchId'], 'tools.batchId'),
    items,
  };
}

function parseRuntimeBinding(
  value: ManagedSessionJsonValue,
  label: string,
): HarnessRuntimeBinding {
  const record = object(value, label);
  assertNoUnknownKeys(
    record,
    [
      'executionCallId',
      'invocationBindingId',
      'capabilityVersion',
      'policyVersion',
      'mediaVersion',
      'state',
      'progressCursor',
    ],
    label,
  );
  return {
    executionCallId: assertManagedSessionStableId(
      record['executionCallId'],
      `${label}.executionCallId`,
    ),
    invocationBindingId: assertManagedSessionStableId(
      record['invocationBindingId'],
      `${label}.invocationBindingId`,
    ),
    capabilityVersion: assertManagedSessionStableId(
      record['capabilityVersion'],
      `${label}.capabilityVersion`,
    ),
    policyVersion: assertManagedSessionStableId(
      record['policyVersion'],
      `${label}.policyVersion`,
    ),
    mediaVersion: idOrNull(record['mediaVersion'], `${label}.mediaVersion`),
    state: oneOf(record['state'], HARNESS_RUNTIME_STATES, `${label}.state`),
    progressCursor: idOrNull(
      record['progressCursor'],
      `${label}.progressCursor`,
    ),
  };
}

function parseRuntime(
  value: ManagedSessionJsonValue | undefined,
): HarnessRuntimeGroup | null {
  if (value === null) return null;
  const record = object(value, 'runtime');
  assertNoUnknownKeys(record, ['bindings'], 'runtime');
  const bindings = jsonArray(record['bindings'], 'runtime.bindings').map(
    (item, index) => parseRuntimeBinding(item, `runtime.bindings[${index}]`),
  );
  uniqueIds(
    bindings.map((item) => item.executionCallId),
    'runtime.bindings.executionCallId',
  );
  uniqueIds(
    bindings.map((item) => item.invocationBindingId),
    'runtime.bindings.invocationBindingId',
  );
  return { bindings };
}

function parseApproval(
  value: ManagedSessionJsonValue | undefined,
): HarnessApprovalGroup | null {
  if (value === null) return null;
  const record = object(value, 'approval');
  assertNoUnknownKeys(
    record,
    [
      'requestId',
      'kind',
      'source',
      'optionsRef',
      'inputRevision',
      'confirmationVersion',
      'state',
      'decisionRef',
      'invocationRef',
    ],
    'approval',
  );
  const state = oneOf(
    record['state'],
    HARNESS_APPROVAL_STATES,
    'approval.state',
  );
  const source = oneOf(
    record['source'],
    HARNESS_ACTION_SOURCES,
    'approval.source',
  );
  const decisionRef = refOrNull(record['decisionRef'], 'approval.decisionRef');
  if (state === 'decided' && decisionRef === null) {
    fail('approval.decisionRef is required once the approval is decided.');
  }
  if (state !== 'decided' && decisionRef !== null) {
    fail('approval.decisionRef must be null until the approval is decided.');
  }
  const invocationRef = refOrNull(
    record['invocationRef'],
    'approval.invocationRef',
  );
  if (source === 'tool_call' && invocationRef === null) {
    fail('approval.invocationRef is required for a tool_call approval.');
  }
  if (source === 'user_operation' && invocationRef !== null) {
    fail('approval.invocationRef must be null for a user_operation approval.');
  }
  return {
    requestId: assertManagedSessionStableId(
      record['requestId'],
      'approval.requestId',
    ),
    kind: assertManagedSessionStableId(record['kind'], 'approval.kind'),
    source,
    optionsRef: assertManagedSessionDurableRef(
      record['optionsRef'],
      'approval.optionsRef',
    ),
    inputRevision: assertManagedSessionStableId(
      record['inputRevision'],
      'approval.inputRevision',
    ),
    confirmationVersion: idOrNull(
      record['confirmationVersion'],
      'approval.confirmationVersion',
    ),
    state,
    decisionRef,
    invocationRef,
  };
}

function parseParentHistory(
  value: ManagedSessionJsonValue | undefined,
): HarnessOutputGroup['parentHistory'] {
  if (value === null) return null;
  const record = object(value, 'output.parentHistory');
  assertNoUnknownKeys(
    record,
    ['bindingId', 'revision'],
    'output.parentHistory',
  );
  return {
    bindingId: assertManagedSessionStableId(
      record['bindingId'],
      'output.parentHistory.bindingId',
    ),
    revision: assertManagedSessionSequence(
      record['revision'],
      'output.parentHistory.revision',
    ),
  };
}

function parseOutput(
  value: ManagedSessionJsonValue | undefined,
): HarnessOutputGroup {
  const record = object(value, 'output');
  assertNoUnknownKeys(
    record,
    [
      'llmContentRef',
      'physicalStatus',
      'hookResultRef',
      'mediaRefs',
      'parentHistory',
    ],
    'output',
  );
  return {
    llmContentRef: refOrNull(record['llmContentRef'], 'output.llmContentRef'),
    physicalStatus: idOrNull(record['physicalStatus'], 'output.physicalStatus'),
    hookResultRef: refOrNull(record['hookResultRef'], 'output.hookResultRef'),
    mediaRefs: jsonArray(record['mediaRefs'], 'output.mediaRefs').map(
      (item, index) =>
        assertManagedSessionDurableRef(item, `output.mediaRefs[${index}]`),
    ),
    parentHistory: parseParentHistory(record['parentHistory']),
  };
}

function parseFollowUp(
  value: ManagedSessionJsonValue | undefined,
): HarnessFollowUpGroup {
  const record = object(value, 'followUp');
  assertNoUnknownKeys(
    record,
    [
      'pendingInputIds',
      'cancelRequestIds',
      'goalPermitIds',
      'cronIds',
      'notificationIds',
      'childRunIds',
      'stopBudgetRemaining',
      'scopeLineage',
    ],
    'followUp',
  );
  const pendingInputIds = idList(
    record['pendingInputIds'],
    'followUp.pendingInputIds',
  );
  const cancelRequestIds = idList(
    record['cancelRequestIds'],
    'followUp.cancelRequestIds',
  );
  const goalPermitIds = idList(
    record['goalPermitIds'],
    'followUp.goalPermitIds',
  );
  const cronIds = idList(record['cronIds'], 'followUp.cronIds');
  const notificationIds = idList(
    record['notificationIds'],
    'followUp.notificationIds',
  );
  const childRunIds = idList(record['childRunIds'], 'followUp.childRunIds');
  uniqueIds(pendingInputIds, 'followUp.pendingInputIds');
  uniqueIds(cancelRequestIds, 'followUp.cancelRequestIds');
  uniqueIds(goalPermitIds, 'followUp.goalPermitIds');
  uniqueIds(cronIds, 'followUp.cronIds');
  uniqueIds(notificationIds, 'followUp.notificationIds');
  uniqueIds(childRunIds, 'followUp.childRunIds');
  return {
    pendingInputIds,
    cancelRequestIds,
    goalPermitIds,
    cronIds,
    notificationIds,
    childRunIds,
    stopBudgetRemaining: sequenceOrNull(
      record['stopBudgetRemaining'],
      'followUp.stopBudgetRemaining',
    ),
    scopeLineage: idList(record['scopeLineage'], 'followUp.scopeLineage'),
  };
}

function toolItems(
  tools: HarnessToolsGroup | null,
): readonly HarnessToolItem[] {
  return tools?.items ?? [];
}

function runtimeBindings(
  runtime: HarnessRuntimeGroup | null,
): readonly HarnessRuntimeBinding[] {
  return runtime?.bindings ?? [];
}

function assertRuntimeMatchesTools(
  tools: HarnessToolsGroup | null,
  runtime: HarnessRuntimeGroup | null,
): void {
  const calls = new Set(toolItems(tools).map((item) => item.executionCallId));
  for (const binding of runtimeBindings(runtime)) {
    if (!calls.has(binding.executionCallId)) {
      fail(
        `runtime binding ${binding.executionCallId} has no matching tool item.`,
      );
    }
  }
}

function assertPhaseShape(checkpoint: HarnessCheckpointV1): void {
  const { phase } = checkpoint.continuation;
  const items = toolItems(checkpoint.tools);
  const bindings = runtimeBindings(checkpoint.runtime);
  const inFlightTools = items.some((item) => item.state === 'in_progress');
  const unsettledTools = items.some((item) => item.state !== 'settled');
  const dispatchRuntime = bindings.some((item) => item.state === 'dispatch');

  if (phase === 'before_model') {
    if (checkpoint.attempt !== null) {
      fail('before_model cannot carry a model attempt.');
    }
    if (items.length > 0 || bindings.length > 0) {
      fail('before_model cannot carry tools or runtime bindings.');
    }
    if (checkpoint.approval !== null) {
      fail('before_model cannot carry an approval.');
    }
    return;
  }

  if (checkpoint.attempt === null) {
    fail(`${phase} requires a model attempt.`);
  }
  if (checkpoint.attempt.outputState === 'started') {
    fail('an in-flight model stream is not a runnable checkpoint phase.');
  }

  if (phase === 'model_output_committed') {
    if (checkpoint.attempt.outputState !== 'output_committed') {
      fail('model_output_committed requires outputState output_committed.');
    }
    if (checkpoint.approval !== null) {
      fail('model_output_committed cannot carry an approval.');
    }
    if (inFlightTools || dispatchRuntime) {
      fail('model_output_committed cannot carry in-flight tools.');
    }
    return;
  }

  if (phase === 'await_action') {
    if (
      checkpoint.approval === null ||
      checkpoint.approval.state !== 'requested'
    ) {
      fail('await_action requires a requested approval.');
    }
    if (
      checkpoint.approval.source === 'user_operation' &&
      bindings.length > 0
    ) {
      fail('a user_operation approval cannot carry runtime bindings.');
    }
    return;
  }

  if (phase === 'await_runtime') {
    if (!inFlightTools || !dispatchRuntime) {
      fail('await_runtime requires in-progress tools and dispatch bindings.');
    }
    if (checkpoint.approval?.state === 'requested') {
      fail('await_runtime cannot keep a requested approval.');
    }
    return;
  }

  if (phase === 'results_ready') {
    if (items.length === 0 || unsettledTools) {
      fail('results_ready requires every tool item to be settled.');
    }
    if (dispatchRuntime || inFlightTools) {
      fail('results_ready cannot carry in-flight tools.');
    }
    if (checkpoint.approval?.state === 'requested') {
      fail('results_ready cannot keep a requested approval.');
    }
    return;
  }

  if (
    inFlightTools ||
    dispatchRuntime ||
    checkpoint.approval?.state === 'requested'
  ) {
    fail('turn_settled cannot carry in-flight tools or a requested approval.');
  }
}

function parseHarnessCheckpointObject(
  value: ManagedSessionJsonValue,
): HarnessCheckpointV1 {
  const record = object(value, 'harness checkpoint');
  assertNoUnknownKeys(record, ROOT_KEYS, 'harness checkpoint');
  const identity = parseIdentity(record['identity']);
  const checkpoint: HarnessCheckpointV1 = {
    identity,
    resume: parseResume(record['resume'], identity.coveredSequence),
    continuation: parseContinuation(record['continuation']),
    attempt: parseAttempt(record['attempt']),
    tools: parseTools(record['tools']),
    runtime: parseRuntime(record['runtime']),
    approval: parseApproval(record['approval']),
    output: parseOutput(record['output']),
    followUp: parseFollowUp(record['followUp']),
  };
  assertRuntimeMatchesTools(checkpoint.tools, checkpoint.runtime);
  assertPhaseShape(checkpoint);
  return checkpoint;
}

export function parseHarnessCheckpointV1(bytes: Buffer): HarnessCheckpointV1 {
  return parseHarnessCheckpointObject(
    parseManagedSessionRecordJson(
      bytes.toString('utf8'),
      MANAGED_SESSION_LIMITS.maxEventBytes,
    ),
  );
}

export function tryParseHarnessCheckpointV1(
  bytes: Buffer,
): HarnessCheckpointParseResult {
  let json: ManagedSessionJsonValue;
  try {
    json = parseManagedSessionRecordJson(
      bytes.toString('utf8'),
      MANAGED_SESSION_LIMITS.maxEventBytes,
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'opaque',
      message:
        error instanceof Error ? error.message : 'unreadable checkpoint state',
    };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      ok: false,
      reason: 'opaque',
      message: 'checkpoint state is not a JSON object.',
    };
  }
  const identity = json['identity'];
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    identity['schemaVersion'] === undefined
  ) {
    return {
      ok: false,
      reason: 'opaque',
      message: 'checkpoint state has no Harness schemaVersion.',
    };
  }
  try {
    return { ok: true, checkpoint: parseHarnessCheckpointObject(json) };
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) {
      return { ok: false, reason: 'invalid', message: error.message };
    }
    throw error;
  }
}

export function encodeHarnessCheckpointV1(
  checkpoint: HarnessCheckpointV1,
): Buffer {
  return Buffer.from(JSON.stringify(checkpoint), 'utf8');
}

function formatHarnessIdentity(input: {
  readonly sessionKey: ManagedSessionKey;
  readonly checkpointId: string;
  readonly coveredSequence: number;
}): string {
  return `${input.checkpointId}@${input.coveredSequence} ${input.sessionKey.tenantId}/${input.sessionKey.workspaceId}/${input.sessionKey.sessionId}`;
}

export function authorizeParsedHarnessCheckpoint(
  checkpoint: HarnessCheckpointV1,
  expected: {
    readonly sessionKey: ManagedSessionKey;
    readonly checkpointId: string;
    readonly coveredSequence: number;
  },
): Extract<HarnessRunAuthorization, { status: 'runnable' | 'blocked' }> {
  if (
    !managedSessionKeysEqual(
      checkpoint.identity.sessionKey,
      expected.sessionKey,
    ) ||
    checkpoint.identity.checkpointId !== expected.checkpointId ||
    checkpoint.identity.coveredSequence !== expected.coveredSequence ||
    checkpoint.identity.engine !== 'managed'
  ) {
    return {
      status: 'blocked',
      reason: 'identity_mismatch',
      message: `checkpoint ${formatHarnessIdentity(checkpoint.identity)} does not match ${formatHarnessIdentity(
        {
          sessionKey: expected.sessionKey,
          checkpointId: expected.checkpointId,
          coveredSequence: expected.coveredSequence,
        },
      )}`,
    };
  }
  return { status: 'runnable', checkpoint };
}

export function createInitialHarnessCheckpoint(input: {
  readonly sessionKey: ManagedSessionKey;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly activationId: string;
  readonly turnId: string | null;
  readonly promptId: string | null;
  readonly definitionRevision: string;
  readonly configRevision: string;
  readonly inputDigest: string;
  readonly previousCheckpointId: string | null;
  readonly pendingEventIds?: readonly string[];
  readonly initialTurn?: number;
}): HarnessCheckpointV1 {
  return {
    identity: {
      schemaVersion: HARNESS_CHECKPOINT_SCHEMA_VERSION,
      sessionKey: input.sessionKey,
      engine: 'managed',
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      activationId: input.activationId,
      turnId: input.turnId,
      promptId: input.promptId,
      definitionRevision: input.definitionRevision,
      configRevision: input.configRevision,
      inputDigest: input.inputDigest,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      source: 'session_log',
      throughSequence: input.coveredSequence,
      recording: {
        lastCompletedUuid: null,
        turnParentUuids: [],
        parentSessionId: null,
        sourceType: null,
        sourceId: null,
        lastAssistantModel: null,
        executionEngine: 'managed',
      },
      initialTurn: input.initialTurn ?? 0,
      consumedNotificationIds: [],
      apiHistoryRef: null,
      fileHistoryRef: null,
      artifactRef: null,
      goalRecordsRef: null,
      goalCheckpointWindowRef: null,
      tokenCountsRef: null,
      uiTelemetryRef: null,
      attributionRef: null,
      goalRecoverySourceUuid: null,
    },
    continuation: {
      phase: 'before_model',
      pendingEventIds: [...(input.pendingEventIds ?? [])],
    },
    attempt: null,
    tools: null,
    runtime: null,
    approval: null,
    output: {
      llmContentRef: null,
      physicalStatus: null,
      hookResultRef: null,
      mediaRefs: [],
      parentHistory: null,
    },
    followUp: {
      pendingInputIds: [],
      cancelRequestIds: [],
      goalPermitIds: [],
      cronIds: [],
      notificationIds: [],
      childRunIds: [],
      stopBudgetRemaining: null,
      scopeLineage: [],
    },
  };
}

/**
 * Next-turn-ready v1 after a finished turn with no pending work. Phase is
 * `before_model` so the following model request may start; attempt/tools
 * from the completed turn stay in the log rather than in this checkpoint.
 */
export function createNextTurnReadyHarnessCheckpoint(input: {
  readonly previous: HarnessCheckpointV1;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
  readonly activationId: string;
  readonly turnId: string | null;
  readonly promptId: string | null;
}): HarnessCheckpointV1 {
  return {
    identity: {
      ...input.previous.identity,
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      activationId: input.activationId,
      turnId: input.turnId,
      promptId: input.promptId,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      ...input.previous.resume,
      throughSequence: input.coveredSequence,
    },
    continuation: {
      phase: 'before_model',
      pendingEventIds: [],
    },
    attempt: null,
    tools: null,
    runtime: null,
    approval: null,
    output: {
      llmContentRef: null,
      physicalStatus: null,
      hookResultRef: null,
      mediaRefs: [],
      parentHistory: input.previous.output.parentHistory,
    },
    followUp: input.previous.followUp,
  };
}

/**
 * Approval wait (safety point B). Requires a committed model attempt and a
 * requested approval; does not start or settle tools.
 */
export function createAwaitActionHarnessCheckpoint(input: {
  readonly previous: HarnessCheckpointV1;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
  readonly attempt: HarnessAttemptGroup;
  readonly approval: HarnessApprovalGroup;
}): HarnessCheckpointV1 {
  return {
    identity: {
      ...input.previous.identity,
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      ...input.previous.resume,
      throughSequence: input.coveredSequence,
    },
    continuation: {
      phase: 'await_action',
      pendingEventIds: [],
    },
    attempt: input.attempt,
    tools: input.previous.tools,
    runtime: input.previous.runtime,
    approval: input.approval,
    output: input.previous.output,
    followUp: input.previous.followUp,
  };
}

/**
 * Safety point C: an admitted Runtime tool is in progress. Coordinator owns
 * dispatch; the next model request stays blocked until results_ready.
 */
export function createAwaitRuntimeHarnessCheckpoint(input: {
  readonly previous: HarnessCheckpointV1;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
  readonly attempt: HarnessAttemptGroup;
  readonly tools: HarnessToolsGroup;
  readonly runtime: HarnessRuntimeGroup;
}): HarnessCheckpointV1 {
  if (input.previous.approval?.state === 'requested') {
    throw new ManagedSessionRecordError(
      'await_runtime cannot keep a requested approval.',
    );
  }
  return {
    identity: {
      ...input.previous.identity,
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      ...input.previous.resume,
      throughSequence: input.coveredSequence,
    },
    continuation: {
      phase: 'await_runtime',
      pendingEventIds: [],
    },
    attempt: input.attempt,
    tools: input.tools,
    runtime: input.runtime,
    approval: null,
    output: input.previous.output,
    followUp: input.previous.followUp,
  };
}

/**
 * After admitted Runtime work settles, the turn may start the next model
 * request from `results_ready`. Dispatch bindings are no longer in flight.
 */
export function createResultsReadyHarnessCheckpoint(input: {
  readonly previous: HarnessCheckpointV1;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
  readonly outcomeRef: ManagedSessionDurableRef;
}): HarnessCheckpointV1 {
  if (input.previous.continuation.phase !== 'await_runtime') {
    throw new ManagedSessionRecordError(
      'results_ready resume requires an await_runtime checkpoint.',
    );
  }
  if (input.previous.attempt === null || input.previous.tools === null) {
    throw new ManagedSessionRecordError(
      'results_ready requires the waited attempt and tools.',
    );
  }
  return {
    identity: {
      ...input.previous.identity,
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      ...input.previous.resume,
      throughSequence: input.coveredSequence,
    },
    continuation: {
      phase: 'results_ready',
      pendingEventIds: [],
    },
    attempt: input.previous.attempt,
    tools: {
      batchId: input.previous.tools.batchId,
      items: input.previous.tools.items.map((item) =>
        item.state === 'in_progress'
          ? {
              ...item,
              state: 'settled',
              outcomeRef: input.outcomeRef,
              consumed: false,
            }
          : item,
      ),
    },
    runtime: {
      bindings: runtimeBindings(input.previous.runtime).map((binding) =>
        binding.state === 'dispatch'
          ? { ...binding, state: 'settled' }
          : binding,
      ),
    },
    approval: null,
    output: input.previous.output,
    followUp: input.previous.followUp,
  };
}

/**
 * After the original Runtime receipts are present on the next model
 * request, mark those settled items consumed. Phase stays
 * `results_ready` so the same turn may still start the model.
 */
export function createConsumedRuntimeResultsHarnessCheckpoint(input: {
  readonly previous: HarnessCheckpointV1;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
}): HarnessCheckpointV1 {
  if (input.previous.continuation.phase !== 'results_ready') {
    throw new ManagedSessionRecordError(
      'consumed Runtime results require a results_ready checkpoint.',
    );
  }
  if (input.previous.tools === null) {
    throw new ManagedSessionRecordError(
      'consumed Runtime results require the settled tools.',
    );
  }
  return {
    identity: {
      ...input.previous.identity,
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      ...input.previous.resume,
      throughSequence: input.coveredSequence,
    },
    continuation: {
      phase: 'results_ready',
      pendingEventIds: [],
    },
    attempt: input.previous.attempt,
    tools: {
      batchId: input.previous.tools.batchId,
      items: input.previous.tools.items.map((item) =>
        item.state === 'settled' && item.consumed === false
          ? { ...item, consumed: true }
          : item,
      ),
    },
    runtime: input.previous.runtime,
    approval: null,
    output: input.previous.output,
    followUp: input.previous.followUp,
  };
}

/**
 * After a durable wait is resolved, the turn continues without a new model
 * start reservation. Phase is `model_output_committed` so the next model
 * request is allowed; the requested approval is cleared.
 */
export function createModelOutputCommittedHarnessCheckpoint(input: {
  readonly previous: HarnessCheckpointV1;
  readonly checkpointId: string;
  readonly coveredSequence: number;
  readonly previousCheckpointId: string | null;
}): HarnessCheckpointV1 {
  if (input.previous.attempt === null) {
    throw new ManagedSessionRecordError(
      'model_output_committed requires the waited attempt.',
    );
  }
  return {
    identity: {
      ...input.previous.identity,
      checkpointId: input.checkpointId,
      coveredSequence: input.coveredSequence,
      previousCheckpointId: input.previousCheckpointId,
    },
    resume: {
      ...input.previous.resume,
      throughSequence: input.coveredSequence,
    },
    continuation: {
      phase: 'model_output_committed',
      pendingEventIds: [],
    },
    attempt: input.previous.attempt,
    tools: input.previous.tools,
    runtime: input.previous.runtime,
    approval: null,
    output: input.previous.output,
    followUp: input.previous.followUp,
  };
}

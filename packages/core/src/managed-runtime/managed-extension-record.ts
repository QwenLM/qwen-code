/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionKey,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  assertManagedSessionTime,
  MANAGED_SESSION_DOMAINS,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  managedSessionKeysEqual,
  type ManagedSessionDomain,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
  type ManagedSessionKey,
} from './managed-session-records.js';
import { MANAGED_TOOL_RESULT_KINDS } from './managed-tool-result.js';

// The managed-extension-record/1 contract (H0b of #12827): the records that
// the Stage H capabilities share. The shared fixtures in
// contracts/managed-extension-record-v1.fixtures.json pin it, and
// ManagedExtensionRecords in packages/sdk-java/managed-agent-server replays
// the same cases. The Session authority commits them (H0c, see
// managed-extension-projection.ts).

export const MANAGED_EXTENSION_RECORD_LIMITS = Object.freeze({
  /** The Managed Session stable ID rule, which every id field follows. */
  maxIdBytes: MANAGED_SESSION_LIMITS.maxIdBytes,
  /** The lease bounds of the durable Session store's writer lease. */
  minLeaseDurationMs: 1000,
  maxLeaseDurationMs: 300_000,
  maxGrantPhases: 16,
  maxPhaseLength: 64,
  /** The Monitor tool's own ceilings. */
  maxMonitorEvents: 10_000,
  maxMonitorIdleTimeoutMs: 600_000,
  maxMonitorDebounceMs: 600_000,
} as const);

export const MANAGED_EXTENSION_RECORD_KINDS = Object.freeze({
  monitorRun: 'managed-monitor_run',
  monitorOutput: MANAGED_TOOL_RESULT_KINDS.manifest,
} as const);

const RUN_STATES = [
  'reserved',
  'admitted',
  'running',
  'waiting',
  'settled',
  'failed',
  'cancelled',
  'recovery_blocked',
] as const;
const EXECUTION_STATES = [
  'intent',
  'dispatch_started',
  'running_attached',
  'settled',
  'not_started_proven',
  'outcome_unknown',
  'corrupt',
] as const;
const DELIVERY_STATES = [
  'planned',
  'sending',
  'partial',
  'delivered',
  'accepting',
  'accepted',
  'consumed',
  'unknown',
  'rejected',
  'cancelled',
] as const;
const DELIVERY_TARGETS = ['channel', 'session'] as const;
const RECOVERY_REASONS = [
  'outcome_unknown',
  'execution_corrupt',
  'runtime_lost',
  'dispatch_unknown',
  'handler_unavailable',
] as const;
const QUOTA_REASONS = [
  'count_limit',
  'rate_limit',
  'depth_limit',
  'byte_limit',
  'budget_exhausted',
  'duration_limit',
] as const;
const STOP_REASONS = [
  'exited',
  'max_events',
  'idle_timeout',
  'start_failed',
  'watch_failed',
  'quota_exceeded',
  'stop_requested',
] as const;

export type ExtensionStateLine = 'run' | 'execution' | 'delivery';
export type ExtensionRunState = (typeof RUN_STATES)[number];
export type ExtensionExecutionState = (typeof EXECUTION_STATES)[number];
export type ExtensionDeliveryState = (typeof DELIVERY_STATES)[number];
export type ExtensionDeliveryTarget = (typeof DELIVERY_TARGETS)[number];
export type ExtensionRecoveryReason = (typeof RECOVERY_REASONS)[number];
export type ExtensionQuotaReason = (typeof QUOTA_REASONS)[number];
export type ExtensionReason = ExtensionRecoveryReason | ExtensionQuotaReason;
export type MonitorStopReason = (typeof STOP_REASONS)[number];

type Transitions<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

interface StateLine<State extends string> {
  readonly states: readonly State[];
  readonly transitions: Transitions<State>;
}

function line<State extends string>(
  states: readonly State[],
  transitions: Record<State, readonly State[]>,
): StateLine<State> {
  const frozen = {} as Record<State, readonly State[]>;
  for (const state of states) {
    frozen[state] = Object.freeze([...transitions[state]]);
  }
  return Object.freeze({
    states: Object.freeze([...states]),
    transitions: Object.freeze(frozen),
  });
}

/**
 * The three state lines and the single steps each allows. A logical run,
 * its physical execution and the delivery of its result are separate facts:
 * none of them may stand in for another.
 */
export const MANAGED_EXTENSION_STATE_LINES = Object.freeze({
  run: line(RUN_STATES, {
    reserved: ['admitted', 'failed', 'cancelled'],
    admitted: ['running', 'waiting', 'failed', 'cancelled', 'recovery_blocked'],
    running: ['waiting', 'settled', 'failed', 'cancelled', 'recovery_blocked'],
    waiting: ['running', 'settled', 'failed', 'cancelled', 'recovery_blocked'],
    settled: [],
    failed: [],
    cancelled: [],
    recovery_blocked: ['running', 'waiting', 'settled', 'failed', 'cancelled'],
  }),
  execution: line(EXECUTION_STATES, {
    intent: [
      'dispatch_started',
      'not_started_proven',
      'outcome_unknown',
      'corrupt',
    ],
    dispatch_started: [
      'running_attached',
      'settled',
      'not_started_proven',
      'outcome_unknown',
      'corrupt',
    ],
    running_attached: ['settled', 'outcome_unknown', 'corrupt'],
    settled: [],
    not_started_proven: [],
    outcome_unknown: [
      'running_attached',
      'settled',
      'not_started_proven',
      'corrupt',
    ],
    corrupt: [],
  }),
  delivery: line(DELIVERY_STATES, {
    planned: ['sending', 'accepting', 'cancelled'],
    sending: ['delivered', 'partial', 'unknown', 'rejected'],
    partial: ['sending', 'unknown'],
    delivered: [],
    accepting: ['accepted', 'unknown', 'rejected'],
    accepted: ['consumed'],
    consumed: [],
    unknown: ['delivered', 'partial', 'accepted', 'rejected'],
    rejected: [],
    cancelled: [],
  }),
});

/** The delivery states each target can reach. */
export const MANAGED_EXTENSION_DELIVERY_TARGETS = Object.freeze({
  channel: Object.freeze([
    'planned',
    'sending',
    'partial',
    'delivered',
    'unknown',
    'rejected',
    'cancelled',
  ] as const),
  session: Object.freeze([
    'planned',
    'accepting',
    'accepted',
    'consumed',
    'unknown',
    'rejected',
    'cancelled',
  ] as const),
});

export const MANAGED_EXTENSION_REASONS = Object.freeze({
  recovery: Object.freeze([...RECOVERY_REASONS]),
  quota: Object.freeze([...QUOTA_REASONS]),
});

/** Why a Monitor ended, by the state its run ended in. */
export const MANAGED_EXTENSION_MONITOR_STOP_REASONS = Object.freeze({
  settled: Object.freeze(['exited', 'max_events', 'idle_timeout'] as const),
  failed: Object.freeze([
    'start_failed',
    'watch_failed',
    'quota_exceeded',
  ] as const),
  cancelled: Object.freeze(['stop_requested'] as const),
});

export interface OperationGrant {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
  readonly domain: ManagedSessionDomain;
  readonly operationRevision: number;
  readonly ownerId: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly workspaceGeneration: string;
  readonly resourceScope: {
    /** The committed domain record that holds the operation's plan. */
    readonly recordRef: ManagedSessionDurableRef;
    /** The phases of that plan the grant admits. */
    readonly phases: readonly string[];
  };
  readonly leaseDurationMs: number;
  readonly expiresAt: number;
}

export interface DefinitionPin {
  readonly definitionId: string;
  readonly definitionRevision: number;
  readonly definitionDigest: string;
}

export interface ExtensionRun {
  readonly state: ExtensionRunState;
  readonly reason: ExtensionReason | null;
  readonly definition: DefinitionPin | null;
  readonly executionCallId: string | null;
  readonly effectId: string | null;
  readonly dispatchId: string | null;
  readonly deliveryId: string | null;
  readonly execution: ExtensionExecutionState | null;
  readonly runtime: {
    readonly runtimeBindingId: string;
    /** Decimal text, so a 64-bit value never passes through Number. */
    readonly generation: string;
  } | null;
  readonly delivery: {
    readonly target: ExtensionDeliveryTarget;
    readonly state: ExtensionDeliveryState;
  } | null;
}

/** The body of a `managed-monitor_run` domain record. */
export interface MonitorRun {
  readonly monitorId: string;
  readonly ownerScopeId: string;
  /** The start call's `argsRef`, which holds the command and its directory. */
  readonly commandRef: ManagedSessionDurableRef;
  readonly maxEvents: number;
  readonly idleTimeoutMs: number;
  readonly debounceMs: number;
  readonly startReceiptRef: ManagedSessionDurableRef | null;
  readonly observationSequence: number;
  readonly lastObservationRef: ManagedSessionDurableRef | null;
  readonly notifiedThrough: number;
  readonly stopReason: MonitorStopReason | null;
  readonly outputRef: ManagedSessionDurableRef | null;
  readonly run: ExtensionRun;
}

const LIMITS = MANAGED_EXTENSION_RECORD_LIMITS;
const LINES = MANAGED_EXTENSION_STATE_LINES;
const GENERATION_PATTERN = /^[1-9][0-9]{0,18}$/;
const MAX_GENERATION = 2n ** 63n - 1n;
const PHASE_PATTERN = new RegExp(
  `^[a-z][a-z0-9_]{0,${LIMITS.maxPhaseLength - 1}}$`,
);
const TERMINAL_RUN_STATES: readonly ExtensionRunState[] = [
  'settled',
  'failed',
  'cancelled',
];
/** Physical states that prove nothing is still running. */
const PROVEN_EXECUTION_STATES: readonly ExtensionExecutionState[] = [
  'settled',
  'not_started_proven',
];
const UNSTARTED_EXECUTION_STATES: ReadonlyArray<ExtensionExecutionState | null> =
  [null, 'intent', 'dispatch_started', 'not_started_proven'];

const GRANT_KEYS = [
  'domain',
  'expiresAt',
  'leaseDurationMs',
  'operationId',
  'operationRevision',
  'ownerId',
  'resourceScope',
  'sessionKey',
  'workspaceGeneration',
] as const;
const SCOPE_KEYS = ['phases', 'recordRef'] as const;
const PIN_KEYS = [
  'definitionDigest',
  'definitionId',
  'definitionRevision',
] as const;
const RUN_KEYS = [
  'definition',
  'delivery',
  'deliveryId',
  'dispatchId',
  'effectId',
  'execution',
  'executionCallId',
  'reason',
  'runtime',
  'state',
] as const;
const RUNTIME_KEYS = ['generation', 'runtimeBindingId'] as const;
const DELIVERY_KEYS = ['state', 'target'] as const;
const MONITOR_KEYS = [
  'commandRef',
  'debounceMs',
  'idleTimeoutMs',
  'lastObservationRef',
  'maxEvents',
  'monitorId',
  'notifiedThrough',
  'observationSequence',
  'outputRef',
  'ownerScopeId',
  'run',
  'startReceiptRef',
  'stopReason',
] as const;
/** The fields that no revision of a monitor may change. */
const MONITOR_FIXED_KEYS = [
  'monitorId',
  'ownerScopeId',
  'commandRef',
  'maxEvents',
  'idleTimeoutMs',
  'debounceMs',
] as const;

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

/**
 * Copies an object's fields when its own keys are exactly `keys`, so every
 * later check and use reads one snapshot.
 */
function closed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, unknown> {
  if (typeof value !== 'object' || value === null) {
    fail(`${label} must be a JSON object.`);
  }
  // An array fails here too, since its prototype is Array.prototype.
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain JSON object.`);
  }
  const present = Object.keys(value);
  if (
    present.length !== keys.length ||
    present.some((key) => !keys.includes(key as Key))
  ) {
    fail(`${label} must have exactly the keys ${keys.join(', ')}.`);
  }
  const snapshot = {} as Record<Key, unknown>;
  for (const key of keys) {
    snapshot[key] = (value as Record<Key, unknown>)[key];
  }
  return snapshot;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function id(value: unknown, label: string): string {
  return assertManagedSessionStableId(value as ManagedSessionJsonValue, label);
}

function count(value: unknown, label: string, min = 0, max?: number): number {
  const number = assertManagedSessionSequence(
    value as ManagedSessionJsonValue,
    label,
  );
  if (number < min || (max !== undefined && number > max)) {
    // Pair to the Java store's identical refusal, so a cross-language
    // failure reads alike wherever the boundary caught it.
    fail(
      max !== undefined
        ? `${label} must be an integer from ${min} to ${max}.`
        : `${label} must be an integer from ${min} or more.`,
    );
  }
  return number;
}

function generation(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !GENERATION_PATTERN.test(value) ||
    BigInt(value) > MAX_GENERATION
  ) {
    fail(`${label} must be canonical decimal text from 1 to 2^63-1.`);
  }
  return value;
}

function ref(value: unknown, label: string): ManagedSessionDurableRef {
  return Object.freeze(
    assertManagedSessionDurableRef(value as ManagedSessionJsonValue, label),
  );
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function attempt<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return undefined;
    throw error;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The run states after which no observation, output or run change may land. */
export function isTerminalRunState(state: ExtensionRunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

function isTerminal(state: ExtensionRunState): boolean {
  return isTerminalRunState(state);
}

function isRecoveryReason(
  reason: ExtensionReason | null,
): reason is ExtensionRecoveryReason {
  return (RECOVERY_REASONS as readonly string[]).includes(reason ?? '');
}

function isQuotaReason(
  reason: ExtensionReason | null,
): reason is ExtensionQuotaReason {
  return (QUOTA_REASONS as readonly string[]).includes(reason ?? '');
}

function transitionsOf(
  stateLine: ExtensionStateLine,
): Transitions<string> | undefined {
  return Object.hasOwn(LINES, stateLine)
    ? (LINES[stateLine].transitions as Transitions<string>)
    : undefined;
}

/** Whether one step of `stateLine` may go from `from` to `to`. */
export function isExtensionTransitionAllowed(
  stateLine: ExtensionStateLine,
  from: string,
  to: string,
): boolean {
  const transitions = transitionsOf(stateLine);
  return (
    transitions !== undefined &&
    Object.hasOwn(transitions, from) &&
    transitions[from].includes(to)
  );
}

/**
 * A revision moves a state line by one allowed step at most, so every step,
 * and the evidence it rests on, is committed before the next one acts.
 */
function advances(
  stateLine: ExtensionStateLine,
  from: string,
  to: string,
): boolean {
  return from === to || isExtensionTransitionAllowed(stateLine, from, to);
}

export function parseOperationGrant(value: unknown): OperationGrant {
  const grant = closed(value, GRANT_KEYS, 'grant');
  const domain = oneOf(grant.domain, MANAGED_SESSION_DOMAINS, 'grant.domain');
  const scope = closed(grant.resourceScope, SCOPE_KEYS, 'grant.resourceScope');
  const recordRef = ref(scope.recordRef, 'grant.resourceScope.recordRef');
  // The same pairing `domain.committed` requires of its recordRef.
  if (recordRef.kind !== `managed-${domain}` || recordRef.schemaVersion !== 1) {
    fail(
      `grant.resourceScope.recordRef must reference managed-${domain} version 1.`,
    );
  }
  if (
    !Array.isArray(scope.phases) ||
    scope.phases.length === 0 ||
    scope.phases.length > LIMITS.maxGrantPhases
  ) {
    fail(
      `grant.resourceScope.phases must list 1 to ${LIMITS.maxGrantPhases} phases.`,
    );
  }
  // Array.from visits holes too, so a sparse array fails on its first hole.
  const phases = Array.from(scope.phases as unknown[], (phase, index) => {
    if (typeof phase !== 'string' || !PHASE_PATTERN.test(phase)) {
      fail(
        `grant.resourceScope.phases[${index}] must match ${PHASE_PATTERN.source}.`,
      );
    }
    return phase;
  });
  if (new Set(phases).size !== phases.length) {
    fail('grant.resourceScope.phases must not repeat a phase.');
  }
  return Object.freeze({
    sessionKey: Object.freeze(
      assertManagedSessionKey(
        grant.sessionKey as ManagedSessionJsonValue,
        'grant.sessionKey',
      ),
    ),
    operationId: id(grant.operationId, 'grant.operationId'),
    domain,
    operationRevision: count(
      grant.operationRevision,
      'grant.operationRevision',
      1,
    ),
    ownerId: id(grant.ownerId, 'grant.ownerId'),
    workspaceGeneration: generation(
      grant.workspaceGeneration,
      'grant.workspaceGeneration',
    ),
    resourceScope: Object.freeze({
      recordRef,
      phases: Object.freeze(phases),
    }),
    leaseDurationMs: count(
      grant.leaseDurationMs,
      'grant.leaseDurationMs',
      LIMITS.minLeaseDurationMs,
      LIMITS.maxLeaseDurationMs,
    ),
    expiresAt: assertManagedSessionTime(
      grant.expiresAt as ManagedSessionJsonValue,
      'grant.expiresAt',
    ),
  });
}

/**
 * Whether `next` may replace `previous` at a Runtime's per-operation gate: a
 * renewal of the same revision that only extends the lease, or a later
 * revision of the same operation that does not go back to an older
 * Workspace generation. An earlier revision is stale.
 */
export function isOperationGrantSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  const before = attempt(() => parseOperationGrant(previous));
  const after = attempt(() => parseOperationGrant(next));
  if (
    !before ||
    !after ||
    !managedSessionKeysEqual(before.sessionKey, after.sessionKey) ||
    before.operationId !== after.operationId ||
    before.domain !== after.domain
  ) {
    return false;
  }
  if (after.operationRevision === before.operationRevision) {
    return (
      after.expiresAt > before.expiresAt &&
      sameJson({ ...before, expiresAt: 0 }, { ...after, expiresAt: 0 })
    );
  }
  return (
    after.operationRevision > before.operationRevision &&
    BigInt(after.workspaceGeneration) >= BigInt(before.workspaceGeneration)
  );
}

export function parseDefinitionPin(
  value: unknown,
  label = 'definition',
): DefinitionPin {
  const pin = closed(value, PIN_KEYS, label);
  return Object.freeze({
    definitionId: id(pin.definitionId, `${label}.definitionId`),
    definitionRevision: count(
      pin.definitionRevision,
      `${label}.definitionRevision`,
      1,
    ),
    definitionDigest: assertManagedSessionDigest(
      pin.definitionDigest as ManagedSessionJsonValue,
      `${label}.definitionDigest`,
    ),
  });
}

/** Whether two pins agree: a definition revision never names two digests. */
export function isDefinitionPinConsistent(
  first: unknown,
  second: unknown,
): boolean {
  const a = attempt(() => parseDefinitionPin(first));
  const b = attempt(() => parseDefinitionPin(second));
  return (
    a !== undefined &&
    b !== undefined &&
    (a.definitionId !== b.definitionId ||
      a.definitionRevision !== b.definitionRevision ||
      a.definitionDigest === b.definitionDigest)
  );
}

function parseReason(value: unknown, label: string): ExtensionReason | null {
  return nullable(value, (reason) =>
    oneOf(reason, [...RECOVERY_REASONS, ...QUOTA_REASONS], label),
  );
}

function assertReason(
  label: string,
  run: Pick<
    ExtensionRun,
    'state' | 'reason' | 'execution' | 'runtime' | 'dispatchId'
  >,
): void {
  const { state, reason } = run;
  const allowed =
    state === 'recovery_blocked'
      ? isRecoveryReason(reason)
      : state === 'running' || state === 'waiting'
        ? reason === null || isRecoveryReason(reason)
        : state === 'failed'
          ? reason === null || isQuotaReason(reason)
          : reason === null;
  if (!allowed) fail(`${label}.reason does not fit the ${state} state.`);
  if (reason === 'outcome_unknown' && run.execution !== 'outcome_unknown') {
    fail(`${label}.reason outcome_unknown needs an unknown execution.`);
  }
  if ((reason === 'execution_corrupt') !== (run.execution === 'corrupt')) {
    fail(`${label}.reason is execution_corrupt exactly when it is corrupt.`);
  }
  if (reason === 'runtime_lost' && run.runtime === null) {
    fail(`${label}.reason runtime_lost needs the Runtime binding it lost.`);
  }
  if (
    reason === 'runtime_lost' &&
    state === 'recovery_blocked' &&
    run.execution === 'running_attached'
  ) {
    fail(`${label} cannot be blocked on a lost Runtime while attached.`);
  }
  if (reason === 'dispatch_unknown' && run.dispatchId === null) {
    fail(`${label}.reason dispatch_unknown needs a dispatchId.`);
  }
}

/**
 * Parses the run block every Stage H record embeds: the three state lines,
 * the reason, the pinned definition, the stable identities and the Runtime
 * binding, together with the rules that tie them to each other.
 */
export function parseExtensionRun(value: unknown, label = 'run'): ExtensionRun {
  const run = closed(value, RUN_KEYS, label);
  const optionalId = (field: (typeof RUN_KEYS)[number]) =>
    nullable(run[field], (each) => id(each, `${label}.${field}`));
  const parsed: ExtensionRun = {
    state: oneOf(run.state, RUN_STATES, `${label}.state`),
    reason: parseReason(run.reason, `${label}.reason`),
    definition: nullable(run.definition, (pin) =>
      parseDefinitionPin(pin, `${label}.definition`),
    ),
    executionCallId: optionalId('executionCallId'),
    effectId: optionalId('effectId'),
    dispatchId: optionalId('dispatchId'),
    deliveryId: optionalId('deliveryId'),
    execution: nullable(run.execution, (state) =>
      oneOf(state, EXECUTION_STATES, `${label}.execution`),
    ),
    runtime: nullable(run.runtime, (runtime) => {
      const binding = closed(runtime, RUNTIME_KEYS, `${label}.runtime`);
      return Object.freeze({
        runtimeBindingId: id(
          binding.runtimeBindingId,
          `${label}.runtime.runtimeBindingId`,
        ),
        generation: generation(
          binding.generation,
          `${label}.runtime.generation`,
        ),
      });
    }),
    delivery: nullable(run.delivery, (delivery) => {
      const entry = closed(delivery, DELIVERY_KEYS, `${label}.delivery`);
      const target = oneOf(
        entry.target,
        DELIVERY_TARGETS,
        `${label}.delivery.target`,
      );
      return Object.freeze({
        target,
        state: oneOf(
          entry.state,
          MANAGED_EXTENSION_DELIVERY_TARGETS[target],
          `${label}.delivery.state`,
        ),
      });
    }),
  };
  const { state, execution, delivery } = parsed;

  if (parsed.executionCallId !== null && parsed.effectId !== null) {
    fail(`${label} names one physical identity at most.`);
  }
  if (
    execution !== null &&
    parsed.executionCallId === null &&
    parsed.effectId === null
  ) {
    fail(`${label}.execution needs an executionCallId or an effectId.`);
  }
  if (parsed.runtime !== null && execution === null) {
    fail(`${label}.runtime needs an execution.`);
  }
  if ((parsed.deliveryId !== null) !== (delivery?.target === 'channel')) {
    fail(`${label}.deliveryId is set exactly for a channel delivery.`);
  }
  if (state === 'reserved' && (execution !== null || delivery !== null)) {
    fail(`${label} has nothing dispatched while reserved.`);
  }
  // An execution that nobody can prove never passes for a settled one.
  if (
    (execution === 'outcome_unknown' || execution === 'corrupt') &&
    state !== 'recovery_blocked'
  ) {
    fail(
      `${label}.state must be recovery_blocked while execution is ${execution}.`,
    );
  }
  if (
    isTerminal(state) &&
    execution !== null &&
    !PROVEN_EXECUTION_STATES.includes(execution)
  ) {
    fail(`${label}.state ${state} needs an execution proven to have ended.`);
  }
  if (state === 'settled' && execution === 'not_started_proven') {
    fail(`${label} cannot settle an execution that never started.`);
  }
  // Nor go on: the execution line has ended, so the run could only fail or
  // be cancelled, and its task would show a run that is not happening.
  if (
    (state === 'running' || state === 'waiting') &&
    execution === 'not_started_proven'
  ) {
    fail(`${label} cannot run on an execution that never started.`);
  }
  if (
    delivery?.target === 'session' &&
    delivery.state !== 'planned' &&
    delivery.state !== 'cancelled' &&
    !isTerminal(state)
  ) {
    fail(`${label}.delivery cannot hand over a result before the run ends.`);
  }
  assertReason(label, parsed);
  return Object.freeze(parsed);
}

function setOnce(before: unknown, after: unknown): boolean {
  return before === null || sameJson(before, after);
}

/**
 * Whether `next` may follow `previous` as the next revision of one run: each
 * state line stays or takes one allowed step, an execution starts at
 * `intent` and a delivery at `planned`, identities and the pinned definition
 * never change once set, the pin and the Runtime binding are recorded by the
 * dispatch, the binding changes only when an unknown execution is attached
 * again under a later generation, and a run that ended changes only its
 * delivery, with the delivery ID a first Channel delivery brings.
 */
export function isExtensionRunSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  const before = attempt(() => parseExtensionRun(previous));
  const after = attempt(() => parseExtensionRun(next));
  if (!before || !after || !advances('run', before.state, after.state)) {
    return false;
  }
  if (
    isTerminal(before.state) &&
    !sameJson(
      { ...before, delivery: null, deliveryId: null },
      { ...after, delivery: null, deliveryId: null },
    )
  ) {
    return false;
  }
  if (
    !setOnce(before.definition, after.definition) ||
    !setOnce(before.executionCallId, after.executionCallId) ||
    !setOnce(before.effectId, after.effectId) ||
    !setOnce(before.dispatchId, after.dispatchId) ||
    !setOnce(before.deliveryId, after.deliveryId)
  ) {
    return false;
  }
  // A run is pinned to its definition and bound to its Runtime by the time
  // it dispatches, never later.
  const dispatched = before.execution !== null && before.execution !== 'intent';
  if (dispatched && before.definition === null && after.definition !== null) {
    return false;
  }
  if (
    before.execution === null
      ? after.execution !== null && after.execution !== 'intent'
      : after.execution === null ||
        !advances('execution', before.execution, after.execution)
  ) {
    return false;
  }
  if (
    before.delivery === null
      ? after.delivery !== null && after.delivery.state !== 'planned'
      : after.delivery === null ||
        before.delivery.target !== after.delivery.target ||
        !advances('delivery', before.delivery.state, after.delivery.state)
  ) {
    return false;
  }
  if (before.runtime === null) return after.runtime === null || !dispatched;
  if (sameJson(before.runtime, after.runtime)) return true;
  return (
    after.runtime !== null &&
    before.execution === 'outcome_unknown' &&
    after.execution === 'running_attached' &&
    BigInt(after.runtime.generation) > BigInt(before.runtime.generation)
  );
}

/**
 * Whether `value` may open a run: it starts reserved or admitted, with no
 * execution beyond an intent and no delivery beyond a plan, so the first
 * revision of a record never skips a step the later ones take one at a time.
 */
export function isExtensionRunStart(value: unknown): boolean {
  const run = attempt(() => parseExtensionRun(value));
  return (
    run !== undefined &&
    (run.state === 'reserved' || run.state === 'admitted') &&
    (run.execution === null || run.execution === 'intent') &&
    (run.delivery === null || run.delivery.state === 'planned')
  );
}

/** Parses the body of a `managed-monitor_run` domain record. */
export function parseMonitorRun(value: unknown): MonitorRun {
  const monitor = closed(value, MONITOR_KEYS, 'monitorRun');
  const run = parseExtensionRun(monitor.run, 'monitorRun.run');
  // A Monitor is started by one tool call and delivers through its
  // notification watermark, not through a dispatch or a delivery.
  if (
    run.executionCallId === null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.delivery !== null ||
    run.definition !== null
  ) {
    fail('monitorRun.run must name its start call and nothing else.');
  }
  const maxEvents = count(
    monitor.maxEvents,
    'monitorRun.maxEvents',
    1,
    LIMITS.maxMonitorEvents,
  );
  const observationSequence = count(
    monitor.observationSequence,
    'monitorRun.observationSequence',
    0,
    maxEvents,
  );
  const parsed: MonitorRun = {
    monitorId: id(monitor.monitorId, 'monitorRun.monitorId'),
    ownerScopeId: id(monitor.ownerScopeId, 'monitorRun.ownerScopeId'),
    commandRef: ref(monitor.commandRef, 'monitorRun.commandRef'),
    maxEvents,
    idleTimeoutMs: count(
      monitor.idleTimeoutMs,
      'monitorRun.idleTimeoutMs',
      1,
      LIMITS.maxMonitorIdleTimeoutMs,
    ),
    debounceMs: count(
      monitor.debounceMs,
      'monitorRun.debounceMs',
      0,
      LIMITS.maxMonitorDebounceMs,
    ),
    startReceiptRef: nullable(monitor.startReceiptRef, (each) =>
      ref(each, 'monitorRun.startReceiptRef'),
    ),
    observationSequence,
    lastObservationRef: nullable(monitor.lastObservationRef, (each) =>
      ref(each, 'monitorRun.lastObservationRef'),
    ),
    notifiedThrough: count(
      monitor.notifiedThrough,
      'monitorRun.notifiedThrough',
      0,
      observationSequence,
    ),
    stopReason: nullable(monitor.stopReason, (reason) =>
      oneOf(reason, STOP_REASONS, 'monitorRun.stopReason'),
    ),
    outputRef: nullable(monitor.outputRef, (each) => {
      const output = ref(each, 'monitorRun.outputRef');
      if (
        output.kind !== MANAGED_EXTENSION_RECORD_KINDS.monitorOutput ||
        output.schemaVersion !== 1
      ) {
        fail(
          `monitorRun.outputRef must reference ${MANAGED_EXTENSION_RECORD_KINDS.monitorOutput} version 1.`,
        );
      }
      return output;
    }),
    run,
  };
  const { execution, state } = run;
  const { startReceiptRef, stopReason } = parsed;

  if ((parsed.lastObservationRef === null) !== (observationSequence === 0)) {
    fail('monitorRun.lastObservationRef is set exactly after an observation.');
  }
  if (
    startReceiptRef === null &&
    (observationSequence > 0 || execution === 'running_attached')
  ) {
    fail('monitorRun.startReceiptRef must be set once the watch started.');
  }
  if (
    startReceiptRef !== null &&
    UNSTARTED_EXECUTION_STATES.includes(execution)
  ) {
    fail('monitorRun.startReceiptRef must be null before the watch starts.');
  }
  if (startReceiptRef !== null && run.runtime === null) {
    fail(
      'monitorRun.startReceiptRef needs the Runtime binding that started it.',
    );
  }
  if ((stopReason === null) === isTerminal(state)) {
    fail('monitorRun.stopReason is set exactly when the run ends.');
  }
  const fitting: readonly MonitorStopReason[] = Object.hasOwn(
    MANAGED_EXTENSION_MONITOR_STOP_REASONS,
    state,
  )
    ? MANAGED_EXTENSION_MONITOR_STOP_REASONS[
        state as keyof typeof MANAGED_EXTENSION_MONITOR_STOP_REASONS
      ]
    : [];
  if (stopReason !== null && !fitting.includes(stopReason)) {
    fail(
      `monitorRun.stopReason ${stopReason} does not fit the ${state} state.`,
    );
  }
  if (
    state === 'settled' &&
    (execution !== 'settled' || startReceiptRef === null)
  ) {
    fail('monitorRun.run settles only with a watch that started and ended.');
  }
  if (stopReason === 'max_events' && observationSequence !== maxEvents) {
    fail('monitorRun.stopReason max_events needs maxEvents observations.');
  }
  if (
    stopReason === 'start_failed' &&
    (startReceiptRef !== null || execution === null)
  ) {
    fail(
      'monitorRun.stopReason start_failed needs a watch that never started.',
    );
  }
  if (stopReason === 'watch_failed' && startReceiptRef === null) {
    fail('monitorRun.stopReason watch_failed needs a watch that started.');
  }
  if ((stopReason === 'quota_exceeded') !== isQuotaReason(run.reason)) {
    fail('monitorRun.stopReason is quota_exceeded exactly for a quota reason.');
  }
  return Object.freeze(parsed);
}

/**
 * Whether `value` may be the first revision of a monitor: its run opens, and
 * it has written no output, which needs a watch. It cannot have observed
 * anything either, since an observation needs a start receipt.
 */
export function isMonitorRunStart(value: unknown): boolean {
  const monitor = attempt(() => parseMonitorRun(value));
  return (
    monitor !== undefined &&
    isExtensionRunStart(monitor.run) &&
    monitor.outputRef === null
  );
}

/**
 * Whether `next` may follow `previous` as a later revision of one monitor:
 * its definition is fixed, its run moves forward, its observation and
 * notification watermarks never go back, observations grow only while a
 * watch is attached, a new Runtime generation brings a
 * new start receipt and nothing else does, and once it ended only the
 * notification watermark may still advance.
 */
export function isMonitorRunSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  const before = attempt(() => parseMonitorRun(previous));
  const after = attempt(() => parseMonitorRun(next));
  if (
    !before ||
    !after ||
    MONITOR_FIXED_KEYS.some((key) => !sameJson(before[key], after[key])) ||
    !isExtensionRunSuccessor(before.run, after.run) ||
    after.observationSequence < before.observationSequence ||
    // Only an attached watch observes, so a lost or ended one adds nothing.
    (after.observationSequence > before.observationSequence &&
      before.run.execution !== 'running_attached' &&
      after.run.execution !== 'running_attached') ||
    after.notifiedThrough < before.notifiedThrough ||
    (after.observationSequence === before.observationSequence &&
      !sameJson(before.lastObservationRef, after.lastObservationRef)) ||
    (before.outputRef !== null && after.outputRef === null)
  ) {
    return false;
  }
  if (
    isTerminal(before.run.state) &&
    !sameJson(
      { ...before, notifiedThrough: 0 },
      { ...after, notifiedThrough: 0 },
    )
  ) {
    return false;
  }
  const rebuilt =
    before.run.runtime !== null &&
    !sameJson(before.run.runtime, after.run.runtime);
  return rebuilt
    ? before.startReceiptRef === null ||
        !sameJson(before.startReceiptRef, after.startReceiptRef)
    : setOnce(before.startReceiptRef, after.startReceiptRef);
}

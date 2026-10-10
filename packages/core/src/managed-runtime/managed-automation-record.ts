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
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  boundedString,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// The `managed-schedule` and `managed-automation_run` record bodies,
// schema version 1 (H6 of #12827): a Schedule definition and its
// AutomationRuns, the durable occurrence ledger the scanner claims against
// (docs/design/2026-10-04-managed-automation.md, decisions 1, 2, 6 and 7).
// The shared fixtures in contracts/managed-automation-record-v1.fixtures.json
// pin both bodies, and ManagedExtensionRecords in
// packages/sdk-java/managed-agent-server replays the same cases.

export const SCHEDULE_KIND = 'schedule';
export const AUTOMATION_RUN_KIND = 'automation_run';

/** The overlap policies a Schedule picks exactly one of (H6 decision 4). */
export const SCHEDULE_OVERLAP_POLICIES = Object.freeze([
  'skip',
  'queue_one',
  'allow',
] as const);
/** The catch-up policies; unbounded catch-up has no name here (decision 5). */
export const SCHEDULE_CATCH_UP_POLICIES = Object.freeze([
  'none',
  'latest',
  'bounded',
] as const);
/** The two target modes, frozen into each run's intent (decision 6). */
export const SCHEDULE_SESSION_MODES = Object.freeze([
  'persistent',
  'per_run',
] as const);

export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];
export type ScheduleCatchUpPolicy = (typeof SCHEDULE_CATCH_UP_POLICIES)[number];
export type ScheduleSessionMode = (typeof SCHEDULE_SESSION_MODES)[number];

/** The body of a `managed-schedule` schema version 1. */
export interface Schedule {
  readonly kind: typeof SCHEDULE_KIND;
  readonly scheduleId: string;
  readonly ownerScopeId: string;
  readonly goal: string;
  /** A five-field schedule: minute hour day-of-month month day-of-week. */
  readonly cron: string;
  /** The IANA timezone the cron fields read in. */
  readonly timezone: string;
  /** The definition revision this record revision carries, from 1 up. */
  readonly definitionRevision: number;
  /** The digest of the definition content at this revision. */
  readonly definitionDigest: string;
  /** The prompt resource revision the runs of this definition fire with. */
  readonly promptRef: ManagedSessionDurableRef;
  readonly sessionMode: ScheduleSessionMode;
  /** The bound Session of a persistent schedule; else null. */
  readonly targetSessionId: string | null;
  readonly overlap: ScheduleOverlapPolicy;
  readonly catchUp: ScheduleCatchUpPolicy;
  /** The newest missed occurrences bounded catch-up fires; else null. */
  readonly catchUpLimit: number | null;
  readonly enabled: boolean;
  readonly run: ExtensionRun;
}

/** The body of a `managed-automation_run` schema version 1. */
export interface AutomationRun {
  readonly kind: typeof AUTOMATION_RUN_KIND;
  readonly automationRunId: string;
  readonly scheduleId: string;
  /** The definition revision this run fired with; frozen at intent. */
  readonly definitionRevision: number;
  /**
   * `schedule:<slot>` for a timer occurrence (the UTC instant, seconds,
   * canonical), `manual:<commandId>` for a manual run. `webhook:<eventId>`
   * stays reserved until the webhook ingress slice lands and is refused.
   */
  readonly occurrenceKey: string;
  readonly sessionMode: ScheduleSessionMode;
  /** The frozen target of a persistent run; else null (decision 6). */
  readonly targetSessionId: string | null;
  readonly run: ExtensionRun;
}

const SCHEDULE_KEYS = [
  'catchUp',
  'catchUpLimit',
  'cron',
  'definitionDigest',
  'definitionRevision',
  'enabled',
  'goal',
  'kind',
  'overlap',
  'ownerScopeId',
  'promptRef',
  'run',
  'scheduleId',
  'sessionMode',
  'targetSessionId',
  'timezone',
] as const;
/** The fields that no revision of a Schedule may change. */
const SCHEDULE_FIXED_KEYS = ['kind', 'ownerScopeId', 'scheduleId'] as const;
const AUTOMATION_RUN_KEYS = [
  'automationRunId',
  'definitionRevision',
  'kind',
  'occurrenceKey',
  'run',
  'scheduleId',
  'sessionMode',
  'targetSessionId',
] as const;
/** The fields that no revision of an AutomationRun may change. */
const AUTOMATION_RUN_FIXED_KEYS = [
  'automationRunId',
  'definitionRevision',
  'kind',
  'occurrenceKey',
  'scheduleId',
  'sessionMode',
  'targetSessionId',
] as const;
const TERMINAL_RUN_STATES: readonly ExtensionRunState[] = [
  'settled',
  'failed',
  'cancelled',
];
/** The digit atoms each cron field accepts, with their value bounds. */
const CRON_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;
const CRON_PART = /^[0-9*,/-]{1,64}$/;
const CRON_DIGITS = /^[0-9]{1,10}$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,63}(\/[A-Za-z0-9_+-]{1,64}){0,2}$/;
const SLOT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const MAX_COUNT = 9007199254740990;

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function closed<Key extends string>(
  label: string,
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
    fail(`${label} must have exactly the keys ${keys.join(', ')}.`);
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function id(value: ManagedSessionJsonValue, label: string): string {
  return assertManagedSessionStableId(value, label);
}

function text(value: ManagedSessionJsonValue, label: string): string {
  return boundedString(value, label, MANAGED_SESSION_LIMITS.maxTextBytes);
}

function count(
  value: ManagedSessionJsonValue,
  label: string,
  min: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > MAX_COUNT
  ) {
    fail(`${label} must be an integer from ${min} to ${MAX_COUNT}.`);
  }
  return value;
}

function boolean(value: ManagedSessionJsonValue, label: string): boolean {
  if (typeof value !== 'boolean') {
    fail(`${label} must be boolean.`);
  }
  return value;
}

function ref(value: ManagedSessionJsonValue, label: string) {
  return Object.freeze(assertManagedSessionDurableRef(value, label));
}

function nullable<T>(
  value: ManagedSessionJsonValue,
  parse: (value: ManagedSessionJsonValue) => T,
): T | null {
  return value === null ? null : parse(value);
}

function oneOf<T extends string>(
  value: ManagedSessionJsonValue,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
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

// One cron field: comma-separated atoms, each `*`, `*/n`, a digit value or
// a range `a-b`, any of them carrying a `/n` step. Values stay inside the
// field's bounds, steps are positive and a range never wraps — the same
// lexical checks both validators run, so no tz database is consulted here.
function cronField(
  field: string,
  name: string,
  min: number,
  max: number,
): void {
  for (const atom of field.split(',')) {
    const [base, stepText, ...rest] = atom.split('/');
    if (
      rest.length > 0 ||
      base === undefined ||
      base === '' ||
      !CRON_PART.test(atom)
    ) {
      fail(`cron ${name} field must use digit, range, list or step atoms.`);
    }
    if (stepText !== undefined) {
      if (!CRON_DIGITS.test(stepText)) {
        fail(`cron ${name} field must use digit, range, list or step atoms.`);
      }
      const step = Number(stepText);
      if (step < 1 || step > max) {
        fail(`cron ${name} field steps must stay within 1-${max}.`);
      }
    }
    if (base === '*') {
      continue;
    }
    const range = base.split('-');
    if (range.length > 2 || range.some((end) => !CRON_DIGITS.test(end))) {
      fail(`cron ${name} field must use digit, range, list or step atoms.`);
    }
    const [from, to] = range.map(Number);
    if (from === undefined || from < min || from > max) {
      fail(`cron ${name} field values must stay within ${min}-${max}.`);
    }
    if (to !== undefined) {
      if (to < min || to > max) {
        fail(`cron ${name} field values must stay within ${min}-${max}.`);
      }
      if (from >= to) {
        fail(`cron ${name} field ranges must not wrap.`);
      }
    }
  }
}

function cron(value: ManagedSessionJsonValue): string {
  const expression = text(value, 'cron');
  const fields = expression.split(' ');
  if (expression !== fields.join(' ') || fields.length !== 5) {
    fail('cron must have exactly five fields.');
  }
  CRON_BOUNDS.forEach(({ name, min, max }, index) =>
    cronField(fields[index]!, name, min, max),
  );
  return expression;
}

// A timezone name is shape-checked only: host tz databases disagree about
// which names resolve, so resolving here would let the same bytes commit
// on one host and refuse on another. Resolution happens when the H6b
// admission and scanner evaluate the definition on a pinned database.
function timezone(value: ManagedSessionJsonValue): string {
  const name = text(value, 'timezone');
  if (!TIMEZONE.test(name)) {
    fail('timezone must have the IANA timezone name form.');
  }
  return name;
}

/** A purely logical lifecycle: no execution, delivery or physical identity. */
function logicalRun(value: unknown, label: string) {
  const run = parseExtensionRun(value, `${label}.run`);
  if (
    run.executionCallId !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.definition !== null ||
    run.execution !== null ||
    run.runtime !== null ||
    run.delivery !== null
  ) {
    fail(`${label} run must stay a purely logical lifecycle.`);
  }
  return run;
}

function targetSession(
  sessionMode: ScheduleSessionMode,
  targetSessionId: string | null,
  label: string,
): void {
  if ((sessionMode === 'persistent') !== (targetSessionId !== null)) {
    fail(
      `${label} targetSessionId is frozen exactly for the persistent target mode.`,
    );
  }
}

export function parseScheduleRecord(value: unknown): Schedule {
  const body = closed('Schedule', value, SCHEDULE_KEYS);
  if (body.kind !== SCHEDULE_KIND) {
    fail(`Schedule kind must be 'schedule' in schema version 1.`);
  }
  const run = logicalRun(body.run, 'Schedule');
  const sessionMode = oneOf(
    body.sessionMode,
    SCHEDULE_SESSION_MODES,
    'sessionMode',
  );
  const targetSessionId = nullable(body.targetSessionId, (each) =>
    id(each, 'targetSessionId'),
  );
  targetSession(sessionMode, targetSessionId, 'Schedule');
  const catchUp = oneOf(body.catchUp, SCHEDULE_CATCH_UP_POLICIES, 'catchUp');
  const catchUpLimit = nullable(body.catchUpLimit, (each) =>
    count(each, 'catchUpLimit', 1),
  );
  if ((catchUp === 'bounded') !== (catchUpLimit !== null)) {
    fail('Schedule catchUpLimit is set exactly for bounded catch-up.');
  }
  return Object.freeze({
    kind: SCHEDULE_KIND,
    scheduleId: id(body.scheduleId, 'scheduleId'),
    ownerScopeId: id(body.ownerScopeId, 'ownerScopeId'),
    goal: text(body.goal, 'goal'),
    cron: cron(body.cron),
    timezone: timezone(body.timezone),
    definitionRevision: count(body.definitionRevision, 'definitionRevision', 1),
    definitionDigest: assertManagedSessionDigest(
      body.definitionDigest,
      'definitionDigest',
    ),
    promptRef: ref(body.promptRef, 'promptRef'),
    sessionMode,
    targetSessionId,
    overlap: oneOf(body.overlap, SCHEDULE_OVERLAP_POLICIES, 'overlap'),
    catchUp,
    catchUpLimit,
    enabled: boolean(body.enabled, 'enabled'),
    run,
  });
}

/**
 * Whether `value` may open a Schedule: its purely logical run opens. A
 * definition revision's fields are free to move later; its identity is
 * not.
 */
export function isScheduleStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseScheduleRecord(value);
    return isExtensionRunStart(record.run);
  });
}

/**
 * Whether `next` may follow `previous` as a later revision of one
 * Schedule: its identity is fixed, its run moves forward, its definition
 * revision advances by exactly one with each new record revision —
 * append-only, as the AgentDefinition contract is — and once the run is
 * terminal the definition is frozen for good.
 */
export function isScheduleSuccessor(previous: unknown, next: unknown): boolean {
  return accepts(() => {
    const before = parseScheduleRecord(previous);
    const after = parseScheduleRecord(next);
    if (
      SCHEDULE_FIXED_KEYS.some((key) => !same(before[key], after[key])) ||
      !isExtensionRunSuccessor(before.run, after.run) ||
      after.definitionRevision !== before.definitionRevision + 1
    ) {
      return false;
    }
    if (TERMINAL_RUN_STATES.includes(before.run.state)) {
      return same({ ...before, run: null }, { ...after, run: null });
    }
    return true;
  });
}

function occurrenceKey(value: ManagedSessionJsonValue): string {
  const key = text(value, 'occurrenceKey');
  const separator = key.indexOf(':');
  const kind = separator < 0 ? '' : key.slice(0, separator);
  const valuePart = separator < 0 ? '' : key.slice(separator + 1);
  if (kind === 'schedule') {
    const parsed = Number.isNaN(Date.parse(valuePart))
      ? null
      : new Date(valuePart);
    if (
      !SLOT.test(valuePart) ||
      parsed === null ||
      parsed.toISOString() !== `${valuePart.slice(0, 19)}.000Z`
    ) {
      fail(
        'AutomationRun occurrenceKey slot must be a canonical UTC instant to the second.',
      );
    }
    return key;
  }
  if (kind === 'manual') {
    id(valuePart, 'occurrenceKey commandId');
    return key;
  }
  if (kind === 'webhook') {
    fail(
      'AutomationRun webhook occurrences are reserved until their slice lands.',
    );
  }
  fail(
    'AutomationRun occurrenceKey must be schedule:<slot> or manual:<commandId>.',
  );
}

export function parseAutomationRunRecord(value: unknown): AutomationRun {
  const body = closed('AutomationRun', value, AUTOMATION_RUN_KEYS);
  if (body.kind !== AUTOMATION_RUN_KIND) {
    fail(`AutomationRun kind must be 'automation_run' in schema version 1.`);
  }
  const run = parseExtensionRun(body.run, 'AutomationRun.run');
  // One occurrence, claimed under one durable dispatch: the scanner is no
  // tool call of this Session, the run names its effect only when the
  // dispatch has one, and it never carries its own definition pin — the
  // definition it fired with freezes on the body.
  if (
    run.executionCallId !== null ||
    run.dispatchId === null ||
    run.definition !== null
  ) {
    fail(
      'AutomationRun run must name its dispatch, no call and no definition.',
    );
  }
  // The delivery of a settled run reconciles on Channel rules, but the
  // run's model work is never retried for it (decision 7): a delivery
  // line beyond its plan exists only after the run ended.
  if (
    run.delivery !== null &&
    run.delivery.state !== 'planned' &&
    !TERMINAL_RUN_STATES.includes(run.state)
  ) {
    fail('AutomationRun delivery moves past its plan only once the run ended.');
  }
  const sessionMode = oneOf(
    body.sessionMode,
    SCHEDULE_SESSION_MODES,
    'sessionMode',
  );
  const targetSessionId = nullable(body.targetSessionId, (each) =>
    id(each, 'targetSessionId'),
  );
  targetSession(sessionMode, targetSessionId, 'AutomationRun');
  return Object.freeze({
    kind: AUTOMATION_RUN_KIND,
    automationRunId: id(body.automationRunId, 'automationRunId'),
    scheduleId: id(body.scheduleId, 'scheduleId'),
    definitionRevision: count(body.definitionRevision, 'definitionRevision', 1),
    occurrenceKey: occurrenceKey(body.occurrenceKey),
    sessionMode,
    targetSessionId,
    run,
  });
}

/** Whether `value` may open an AutomationRun: its run opens. */
export function isAutomationRunStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseAutomationRunRecord(value);
    return isExtensionRunStart(record.run);
  });
}

/**
 * Whether `next` may follow `previous` as a later revision of one
 * AutomationRun: the occurrence identity, the pinned definition revision
 * and the frozen target never change, so only its run moves, under the
 * shared block's rules — a run that ended changes only its delivery,
 * which reconciles and never re-fires the model.
 */
export function isAutomationRunSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseAutomationRunRecord(previous);
    const after = parseAutomationRunRecord(next);
    return (
      AUTOMATION_RUN_FIXED_KEYS.every((key) => same(before[key], after[key])) &&
      isExtensionRunSuccessor(before.run, after.run)
    );
  });
}

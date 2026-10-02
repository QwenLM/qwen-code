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
} from './managed-extension-record.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

export interface HookRegistration {
  readonly registrationId: string;
  readonly catalogId: string;
  readonly catalogRevision: number;
  readonly catalogRef: ManagedSessionDurableRef;
  readonly run: ExtensionRun;
}

export interface HookExecution {
  readonly hookExecutionId: string;
  readonly occurrenceId: string;
  readonly runtimeSessionId: string;
  readonly registrationId: string;
  readonly eventName: string;
  readonly ordinal: number;
  readonly hookId: string;
  readonly planRef: ManagedSessionDurableRef;
  readonly inputRef: ManagedSessionDurableRef;
  readonly resultRef: ManagedSessionDurableRef | null;
  readonly onceKey: string | null;
  readonly cancelRequested: boolean;
  readonly run: ExtensionRun;
}

const REGISTRATION_KEYS = [
  'registrationId',
  'catalogId',
  'catalogRevision',
  'catalogRef',
  'run',
] as const;
const EXECUTION_KEYS = [
  'hookExecutionId',
  'occurrenceId',
  'runtimeSessionId',
  'registrationId',
  'eventName',
  'ordinal',
  'hookId',
  'planRef',
  'inputRef',
  'resultRef',
  'onceKey',
  'cancelRequested',
  'run',
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
    fail(`Hook record must have exactly the keys ${keys.join(', ')}.`);
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function ref(value: ManagedSessionJsonValue, label: string) {
  return Object.freeze(assertManagedSessionDurableRef(value, label));
}

function pinnedRun(value: unknown, effectId: string) {
  const run = parseExtensionRun(value);
  if (
    run.definition === null ||
    run.effectId !== effectId ||
    run.executionCallId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.delivery !== null
  ) {
    fail(
      'Hook run must pin its catalog, identify its effect and have no delivery.',
    );
  }
  return run;
}

export function parseHookRegistration(value: unknown): HookRegistration {
  const body = closed(value, REGISTRATION_KEYS);
  const registrationId = assertManagedSessionStableId(
    body.registrationId,
    'registrationId',
  );
  const catalogId = assertManagedSessionStableId(body.catalogId, 'catalogId');
  const catalogRevision = assertManagedSessionSequence(
    body.catalogRevision,
    'catalogRevision',
  );
  const catalogRef = ref(body.catalogRef, 'catalogRef');
  const run = pinnedRun(body.run, registrationId);
  if (
    catalogRevision < 1 ||
    run.definition!.definitionId !== catalogId ||
    run.definition!.definitionRevision !== catalogRevision ||
    run.execution !== null
  ) {
    fail(
      'Hook registration must pin its catalog resource and have no execution.',
    );
  }
  return Object.freeze({
    registrationId,
    catalogId,
    catalogRevision,
    catalogRef,
    run,
  });
}

export function parseHookExecution(value: unknown): HookExecution {
  const body = closed(value, EXECUTION_KEYS);
  const hookExecutionId = assertManagedSessionStableId(
    body.hookExecutionId,
    'hookExecutionId',
  );
  const run = pinnedRun(body.run, hookExecutionId);
  if (run.execution === null)
    fail('Hook execution must have an execution state.');
  if (typeof body.cancelRequested !== 'boolean')
    fail('Hook cancelRequested must be boolean.');
  const resultRef =
    body.resultRef === null ? null : ref(body.resultRef, 'resultRef');
  if (
    (run.state === 'settled' && resultRef === null) ||
    (resultRef !== null && run.execution !== 'settled')
  ) {
    fail(
      'Hook result requires a settled execution; successful executions need a result.',
    );
  }
  return Object.freeze({
    hookExecutionId,
    occurrenceId: assertManagedSessionStableId(
      body.occurrenceId,
      'occurrenceId',
    ),
    runtimeSessionId: assertManagedSessionStableId(
      body.runtimeSessionId,
      'runtimeSessionId',
    ),
    registrationId: assertManagedSessionStableId(
      body.registrationId,
      'registrationId',
    ),
    eventName: assertManagedSessionStableId(body.eventName, 'eventName'),
    ordinal: assertManagedSessionSequence(body.ordinal, 'ordinal'),
    hookId: assertManagedSessionStableId(body.hookId, 'hookId'),
    planRef: ref(body.planRef, 'planRef'),
    inputRef: ref(body.inputRef, 'inputRef'),
    resultRef,
    onceKey:
      body.onceKey === null
        ? null
        : assertManagedSessionStableId(body.onceKey, 'onceKey'),
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

export function isHookRegistrationStart(value: unknown): boolean {
  return accepts(() => isExtensionRunStart(parseHookRegistration(value).run));
}

export function isHookExecutionStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseHookExecution(value);
    return (
      isExtensionRunStart(record.run) &&
      record.resultRef === null &&
      !record.cancelRequested
    );
  });
}

export function isHookRegistrationSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseHookRegistration(previous);
    const after = parseHookRegistration(next);
    return (
      !['settled', 'failed', 'cancelled'].includes(before.run.state) &&
      REGISTRATION_KEYS.filter((key) => key !== 'run').every((key) =>
        same(before[key], after[key]),
      ) &&
      isExtensionRunSuccessor(before.run, after.run)
    );
  });
}

export function isHookExecutionSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseHookExecution(previous);
    const after = parseHookExecution(next);
    return (
      EXECUTION_KEYS.filter(
        (key) =>
          key !== 'run' && key !== 'resultRef' && key !== 'cancelRequested',
      ).every((key) => same(before[key], after[key])) &&
      isExtensionRunSuccessor(before.run, after.run) &&
      (!before.cancelRequested || after.cancelRequested) &&
      (before.resultRef === null || same(before.resultRef, after.resultRef)) &&
      (!['settled', 'failed', 'cancelled'].includes(before.run.state) ||
        same(before, after))
    );
  });
}

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
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

export interface HistoryMaintenance {
  readonly schemaVersion: 1;
  readonly kind: 'context_compression';
  readonly operationId: string;
  readonly expectedCompactionRevision: number;
  readonly historyCutSequence: number;
  readonly requestRef: ManagedSessionDurableRef;
  readonly phase: 'admitted' | 'generating' | 'candidate' | 'settled';
  readonly attempt: number;
  readonly candidateRef: ManagedSessionDurableRef | null;
  readonly outcome: 'compressed' | 'noop' | 'failed' | null;
  readonly failureCode: string | null;
  readonly compactionRevision: number | null;
  readonly run: ExtensionRun;
}

const KEYS = [
  'schemaVersion',
  'kind',
  'operationId',
  'expectedCompactionRevision',
  'historyCutSequence',
  'requestRef',
  'phase',
  'attempt',
  'candidateRef',
  'outcome',
  'failureCode',
  'compactionRevision',
  'run',
] as const;

function fail(message: string): never {
  throw new ManagedSessionRecordError(`History maintenance ${message}`);
}

function sequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(`${label} must be a non-negative safe integer.`);
  return value as number;
}

export function parseHistoryMaintenance(value: unknown): HistoryMaintenance {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== KEYS.length ||
    Object.keys(value).some(
      (key) => !KEYS.includes(key as (typeof KEYS)[number]),
    )
  )
    fail(`must have exactly the keys ${KEYS.join(', ')}.`);
  const body = value as Record<string, ManagedSessionJsonValue>;
  if (body['schemaVersion'] !== 1 || body['kind'] !== 'context_compression')
    fail('must be a schema version 1 context_compression.');
  const phase = body['phase'];
  if (
    !['admitted', 'generating', 'candidate', 'settled'].includes(String(phase))
  )
    fail('has an invalid phase.');
  const outcome = body['outcome'];
  if (
    outcome !== null &&
    !['compressed', 'noop', 'failed'].includes(String(outcome))
  )
    fail('has an invalid outcome.');
  const run = parseExtensionRun(body['run']);
  if (
    run.definition !== null ||
    run.executionCallId !== null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.execution !== null ||
    run.runtime !== null ||
    run.delivery !== null
  )
    fail('run must be purely logical.');
  const candidateRef =
    body['candidateRef'] === null
      ? null
      : Object.freeze(
          assertManagedSessionDurableRef(body['candidateRef'], 'candidateRef'),
        );
  const compactionRevision =
    body['compactionRevision'] === null
      ? null
      : sequence(body['compactionRevision'], 'compactionRevision');
  const failureCode =
    body['failureCode'] === null
      ? null
      : assertManagedSessionStableId(body['failureCode'], 'failureCode');
  const attempt = sequence(body['attempt'], 'attempt');
  const expectedCompactionRevision = sequence(
    body['expectedCompactionRevision'],
    'expectedCompactionRevision',
  );
  const historyCutSequence = sequence(
    body['historyCutSequence'],
    'historyCutSequence',
  );
  if (historyCutSequence < expectedCompactionRevision)
    fail('history cut must not precede its compaction revision.');
  if (
    phase === 'admitted' &&
    (attempt !== 0 || candidateRef !== null || run.state !== 'admitted')
  )
    fail('admission must have no attempt or candidate.');
  if (
    (phase === 'generating' || phase === 'candidate') &&
    (attempt < 1 || !['running', 'recovery_blocked'].includes(run.state))
  )
    fail('an active phase requires a running or blocked attempt.');
  if (phase === 'generating' && candidateRef !== null)
    fail('generation must not already have a candidate.');
  if (phase === 'candidate' && candidateRef === null)
    fail('candidate phase requires its durable candidate.');
  if (
    phase !== 'settled' &&
    (outcome !== null || failureCode !== null || compactionRevision !== null)
  )
    fail('an active operation must not have an outcome.');
  if (phase === 'settled') {
    if (
      outcome === null ||
      run.state !== (outcome === 'failed' ? 'failed' : 'settled')
    )
      fail('a settled phase requires its terminal outcome.');
    if ((outcome === 'failed') !== (failureCode !== null))
      fail('only a failed outcome carries a failure code.');
    if (
      outcome === 'compressed'
        ? candidateRef === null ||
          compactionRevision === null ||
          compactionRevision <= expectedCompactionRevision
        : compactionRevision !== null
    )
      fail('only a compressed outcome carries its new compaction revision.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'context_compression',
    operationId: assertManagedSessionStableId(
      body['operationId'],
      'operationId',
    ),
    expectedCompactionRevision,
    historyCutSequence,
    requestRef: Object.freeze(
      assertManagedSessionDurableRef(body['requestRef'], 'requestRef'),
    ),
    phase: phase as HistoryMaintenance['phase'],
    attempt,
    candidateRef,
    outcome: outcome as HistoryMaintenance['outcome'],
    failureCode,
    compactionRevision,
    run,
  });
}

export function isHistoryMaintenanceStart(value: unknown): boolean {
  try {
    return parseHistoryMaintenance(value).phase === 'admitted';
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return false;
    throw error;
  }
}

export function isHistoryMaintenanceSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  try {
    const before = parseHistoryMaintenance(previous);
    const after = parseHistoryMaintenance(next);
    if (
      before.phase === 'settled' ||
      !isExtensionRunSuccessor(before.run, after.run)
    )
      return false;
    for (const key of [
      'operationId',
      'kind',
      'schemaVersion',
      'expectedCompactionRevision',
      'historyCutSequence',
      'requestRef',
    ] as const)
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        return false;
    if (
      before.candidateRef !== null &&
      JSON.stringify(before.candidateRef) !== JSON.stringify(after.candidateRef)
    )
      return false;
    if (after.phase === 'settled')
      return (
        after.attempt === before.attempt &&
        (after.outcome !== 'compressed' || before.phase === 'candidate')
      );
    if (before.phase === 'admitted')
      return after.phase === 'generating' && after.attempt === 1;
    if (before.phase === 'candidate')
      return after.phase === 'candidate' && after.attempt === before.attempt;
    return after.phase === 'candidate'
      ? after.attempt === before.attempt
      : after.phase === 'generating' &&
          (after.attempt === before.attempt ||
            after.attempt === before.attempt + 1);
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return false;
    throw error;
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isExtensionRunStart,
  isExtensionRunSuccessor,
  MANAGED_EXTENSION_REASONS,
  parseExtensionRun,
  type ExtensionExecutionState,
  type ExtensionRun,
  type ExtensionRunState,
} from './managed-extension-record.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import { MANAGED_TOOL_RESULT_KINDS } from './managed-tool-result.js';

// The `managed-child_run` record body, schema version 1 (H3 of #12827):
// one background Shell per record, under the Session that started it. The
// reference design assigns background Shell `child_run.kind = "shell"`; H4
// extends the domain to the other child kinds under its own body version.
// The shared fixtures in contracts/managed-child-run-record-v1.fixtures.json
// pin this body, and ManagedExtensionRecords in
// packages/sdk-java/managed-agent-server replays the same cases. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export type ChildRunKind = 'shell';

/** Why a background Shell ended, by the state its run ended in. */
export const CHILD_RUN_STOP_REASONS = Object.freeze({
  settled: Object.freeze(['exited'] as const),
  failed: Object.freeze([
    'start_failed',
    'process_failed',
    'quota_exceeded',
  ] as const),
  cancelled: Object.freeze(['stop_requested'] as const),
});

export type ChildRunStopReason =
  (typeof CHILD_RUN_STOP_REASONS)[keyof typeof CHILD_RUN_STOP_REASONS][number];

/** The body of a `managed-child_run` schema version 1 (`kind: "shell"`). */
export interface ChildRun {
  readonly kind: ChildRunKind;
  readonly shellId: string;
  readonly ownerScopeId: string;
  /** The start call's `argsRef`, which holds the command and its directory. */
  readonly commandRef: ManagedSessionDurableRef;
  /** The supervisor's physical start receipt, set once the process starts. */
  readonly startReceiptRef: ManagedSessionDurableRef | null;
  /** The growing output manifest: `managed-tool-result-manifest` version 1. */
  readonly outputRef: ManagedSessionDurableRef | null;
  readonly stopReason: ChildRunStopReason | null;
  /** Set once and never cleared: a stop has been requested of the owner. */
  readonly stopRequested: boolean;
  /** Exit evidence; at least one of the pair is proven when a Shell exits. */
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly run: ExtensionRun;
}

const BODY_KEYS = [
  'commandRef',
  'exitCode',
  'exitSignal',
  'kind',
  'outputRef',
  'ownerScopeId',
  'run',
  'shellId',
  'startReceiptRef',
  'stopReason',
  'stopRequested',
] as const;
/** The fields that no revision of a background Shell may change. */
const FIXED_KEYS = ['commandRef', 'kind', 'ownerScopeId', 'shellId'] as const;
const TERMINAL_RUN_STATES: readonly ExtensionRunState[] = [
  'settled',
  'failed',
  'cancelled',
];
const UNSTARTED_EXECUTION_STATES: ReadonlyArray<ExtensionExecutionState | null> =
  [null, 'intent', 'dispatch_started', 'not_started_proven'];
const EXIT_SIGNAL_PATTERN = /^[A-Z][A-Z0-9]{0,15}$/;

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
    fail(`Child run must have exactly the keys ${keys.join(', ')}.`);
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function id(value: ManagedSessionJsonValue, label: string): string {
  return assertManagedSessionStableId(value, label);
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

function setOnce(before: unknown, after: unknown): boolean {
  return before === null || same(before, after);
}

export function parseChildRun(value: unknown): ChildRun {
  const body = closed(value, BODY_KEYS);
  if (body.kind !== 'shell') {
    fail(`Child run kind must be 'shell' in schema version 1.`);
  }
  const run = parseExtensionRun(body.run);
  // A background Shell is started by one tool call and is observed through
  // its task projection and output Artifact; it has no delivery line.
  if (
    run.executionCallId === null ||
    run.effectId !== null ||
    run.dispatchId !== null ||
    run.deliveryId !== null ||
    run.delivery !== null ||
    run.definition !== null
  ) {
    fail('Child run must name its start call and nothing else.');
  }
  const execution = run.execution;
  const startReceiptRef = nullable(body.startReceiptRef, (each) =>
    ref(each, 'startReceiptRef'),
  );
  if (
    startReceiptRef !== null &&
    UNSTARTED_EXECUTION_STATES.includes(execution)
  ) {
    fail('Child run startReceiptRef must be null before the process starts.');
  }
  if (
    startReceiptRef === null &&
    (execution === 'running_attached' || execution === 'settled')
  ) {
    fail('Child run startReceiptRef must be set once the process started.');
  }
  if (startReceiptRef !== null && run.runtime === null) {
    fail(
      'Child run startReceiptRef needs the Runtime binding that started it.',
    );
  }
  const outputRef = nullable(body.outputRef, (each) => {
    const output = ref(each, 'outputRef');
    if (
      output.kind !== MANAGED_TOOL_RESULT_KINDS.manifest ||
      output.schemaVersion !== 1
    ) {
      fail(
        `Child run outputRef must reference ${MANAGED_TOOL_RESULT_KINDS.manifest} version 1.`,
      );
    }
    return output;
  });
  // Output needs a started process: nothing writes the manifest before one.
  if (outputRef !== null && startReceiptRef === null) {
    fail('Child run outputRef needs a start receipt.');
  }
  const stopReason = nullable(body.stopReason, (reason) => {
    if (
      typeof reason !== 'string' ||
      !Object.values(CHILD_RUN_STOP_REASONS).some((fitting) =>
        (fitting as readonly string[]).includes(reason),
      )
    ) {
      fail('Child run stopReason is not a closed stop reason.');
    }
    return reason as ChildRunStopReason;
  });
  const stopRequested = body.stopRequested;
  if (typeof stopRequested !== 'boolean') {
    fail('Child run stopRequested must be boolean.');
  }
  if (stopReason === 'stop_requested' && !stopRequested) {
    fail('Child run stop_requested needs its stop request.');
  }
  const exitCode = nullable(body.exitCode, (code) => {
    if (
      typeof code !== 'number' ||
      !Number.isInteger(code) ||
      code < 0 ||
      code > 255
    ) {
      fail('Child run exitCode must be an integer from 0 to 255.');
    }
    return code;
  });
  const exitSignal = nullable(body.exitSignal, (signal) => {
    if (typeof signal !== 'string' || !EXIT_SIGNAL_PATTERN.test(signal)) {
      fail('Child run exitSignal must be an uppercase signal name.');
    }
    return signal;
  });
  if ((stopReason === null) !== !TERMINAL_RUN_STATES.includes(run.state)) {
    fail('Child run stopReason is set exactly when the run ends.');
  }
  if (stopReason !== null) {
    const fitting: readonly ChildRunStopReason[] = Object.hasOwn(
      CHILD_RUN_STOP_REASONS,
      run.state,
    )
      ? CHILD_RUN_STOP_REASONS[run.state as keyof typeof CHILD_RUN_STOP_REASONS]
      : [];
    if (!fitting.includes(stopReason)) {
      fail(
        `Child run stopReason ${stopReason} does not fit the ${run.state} state.`,
      );
    }
  }
  // Every terminal run names the ending execution line: a natural exit is
  // proven only by an observed settled execution under its receipt, a
  // pre-start failure lands on not_started_proven, and an honored stop or a
  // later failure settles the execution that the receipt proves started.
  if (run.state === 'settled' && execution !== 'settled') {
    fail('Child run settled needs its settled execution.');
  }
  if (run.state === 'cancelled' && execution !== 'settled') {
    fail('Child run cancelled needs its settled execution.');
  }
  if (
    run.state === 'failed' &&
    execution !== 'settled' &&
    execution !== 'not_started_proven'
  ) {
    fail('Child run failed needs settled or not_started_proven execution.');
  }
  if (
    stopReason === 'start_failed' &&
    (startReceiptRef !== null || execution !== 'not_started_proven')
  ) {
    fail('Child run start_failed needs a process that never started.');
  }
  if (stopReason === 'process_failed' && startReceiptRef === null) {
    fail('Child run process_failed needs a process that started.');
  }
  if (
    (stopReason === 'process_failed' || stopReason === 'quota_exceeded') &&
    execution !== 'settled'
  ) {
    fail('Child run process failure needs its settled execution.');
  }
  const quota =
    run.reason !== null &&
    (MANAGED_EXTENSION_REASONS.quota as readonly string[]).includes(run.reason);
  if ((stopReason === 'quota_exceeded') !== quota) {
    fail('Child run stopReason is quota_exceeded exactly for a quota reason.');
  }
  // Exit evidence is proven exactly when a Shell exits: a stop by anyone
  // else carries no exit status, and a failure proves none either.
  if (
    stopReason === 'exited'
      ? exitCode === null && exitSignal === null
      : exitCode !== null || exitSignal !== null
  ) {
    fail('Child run exitCode or exitSignal is proven exactly when it exits.');
  }
  return Object.freeze({
    kind: 'shell',
    shellId: id(body.shellId, 'shellId'),
    ownerScopeId: id(body.ownerScopeId, 'ownerScopeId'),
    commandRef: ref(body.commandRef, 'commandRef'),
    startReceiptRef,
    outputRef,
    stopReason,
    stopRequested,
    exitCode,
    exitSignal,
    run,
  });
}

/**
 * Whether `value` may open a background Shell: its run opens, nobody has
 * asked it to stop yet, and it has written no output, which needs a started
 * process.
 */
export function isChildRunStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseChildRun(value);
    return (
      isExtensionRunStart(record.run) &&
      !record.stopRequested &&
      record.outputRef === null
    );
  });
}

/**
 * Whether `next` may follow `previous` as a later revision of one background
 * Shell: its identity is fixed, its run moves forward, its start receipt is
 * set once and never changes — a re-attach under a later generation keeps
 * the receipt whose process it proves, while a changed receipt is refused as
 * the shape of a rerun — its stop request is set but never cleared, its
 * output may grow but is never removed, and once the run is terminal the
 * total freeze enforces everything, including that exit evidence can never
 * have been set beforehand.
 */
export function isChildRunSuccessor(previous: unknown, next: unknown): boolean {
  return accepts(() => {
    const before = parseChildRun(previous);
    const after = parseChildRun(next);
    if (
      FIXED_KEYS.some((key) => !same(before[key], after[key])) ||
      !isExtensionRunSuccessor(before.run, after.run) ||
      (before.outputRef !== null && after.outputRef === null) ||
      (before.stopRequested && !after.stopRequested) ||
      !setOnce(before.startReceiptRef, after.startReceiptRef)
    ) {
      return false;
    }
    if (TERMINAL_RUN_STATES.includes(before.run.state)) {
      return same(before, after);
    }
    return true;
  });
}

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

// The `managed-child_run` record bodies under recordRef `managed-child_run`
// schema version 1: one closed shape per `kind`, dispatched by the body's
// own `kind` field. H3 of #12827 defined `kind: "shell"` (one background
// Shell per record); H4 of #12827 adds `kind: "child_agent"` (one child
// Session per record). The shared fixtures in
// contracts/managed-child-run-record-v1.fixtures.json pin both shapes, and
// ManagedExtensionRecords in packages/sdk-java/managed-agent-server replays
// the same cases. See docs/design/2026-10-03-managed-shell-monitor-runtime.md
// and docs/design/2026-10-06-managed-child-agent-runtime.md.

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

/** Why a child agent ended, by the state its run ended in. */
export const CHILD_AGENT_STOP_REASONS = Object.freeze({
  settled: Object.freeze(['completed'] as const),
  failed: Object.freeze([
    'creation_failed',
    'child_failed',
    'quota_exceeded',
  ] as const),
  cancelled: Object.freeze(['stop_requested'] as const),
});

export type ChildAgentStopReason =
  (typeof CHILD_AGENT_STOP_REASONS)[keyof typeof CHILD_AGENT_STOP_REASONS][number];

/** The body of a `managed-child_run` schema version 1 (`kind: "shell"`). */
export interface ChildRun {
  readonly kind: 'shell';
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

/** How the child agent's result reaches its parent. */
export type ChildCompletion = 'tool' | 'sent';
/** The Workspace isolation policy fixed at launch. */
export type ChildWorkspaceMode = 'shared' | 'snapshot' | 'worktree';

/** The body of a `managed-child_run` schema version 1 (`kind: "child_agent"`). */
export interface ChildAgentRun {
  readonly kind: 'child_agent';
  readonly childRunId: string;
  /** The parent activation scope that owns the child and receives its result. */
  readonly ownerScopeId: string;
  /** The root of the nesting tree; the owning Session for a first-level child. */
  readonly rootSessionId: string;
  readonly depth: number;
  readonly completion: ChildCompletion;
  /** The launch input — the child's first prompt — held by the parent Session. */
  readonly inputRef: ManagedSessionDurableRef;
  readonly workspaceMode: ChildWorkspaceMode;
  /** The relative directory within the bound Workspace, `.` for its root. */
  readonly workingDirectory: string;
  /** Set once, with the dispatch that admitted the idempotent creation. */
  readonly childSessionId: string | null;
  /** Set at launch for a continuation, never changed. */
  readonly predecessorChildRunId: string | null;
  /** The logical result version; exactly 1 in schema version 1. */
  readonly resultVersion: number;
  /** The parent-held copy of the terminal result content. */
  readonly resultRef: ManagedSessionDurableRef | null;
  /** The parent-held copy of the child's terminal receipt. */
  readonly terminalReceiptRef: ManagedSessionDurableRef | null;
  readonly stopReason: ChildAgentStopReason | null;
  /** Set once and never cleared: a cancel request, including the cascade's. */
  readonly stopRequested: boolean;
  readonly run: ExtensionRun;
}

/**
 * The body of any `managed-child_run` schema version 1 record. `ChildRun`
 * keeps the meaning H3 shipped — a background Shell — and the dispatching
 * parse returns it for `kind: "shell"`.
 */
export type AnyChildRun = ChildRun | ChildAgentRun;

const SHELL_KEYS = [
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
const SHELL_FIXED_KEYS = [
  'commandRef',
  'kind',
  'ownerScopeId',
  'shellId',
] as const;
const CHILD_AGENT_KEYS = [
  'childRunId',
  'childSessionId',
  'completion',
  'depth',
  'inputRef',
  'kind',
  'ownerScopeId',
  'predecessorChildRunId',
  'resultRef',
  'resultVersion',
  'rootSessionId',
  'run',
  'stopReason',
  'stopRequested',
  'terminalReceiptRef',
  'workspaceMode',
  'workingDirectory',
] as const;
// The fields that no revision of a child agent may change. `resultVersion`
// is not here on purpose: the parser forces it to 1, so no two revisions
// can ever differ on it, and a fixed-key entry for it could never refuse.
const CHILD_AGENT_FIXED_KEYS = [
  'childRunId',
  'completion',
  'depth',
  'inputRef',
  'kind',
  'ownerScopeId',
  'predecessorChildRunId',
  'rootSessionId',
  'workspaceMode',
  'workingDirectory',
] as const;
const TERMINAL_RUN_STATES: readonly ExtensionRunState[] = [
  'settled',
  'failed',
  'cancelled',
];
const UNSTARTED_EXECUTION_STATES: ReadonlyArray<ExtensionExecutionState | null> =
  [null, 'intent', 'dispatch_started', 'not_started_proven'];
const EXIT_SIGNAL_PATTERN = /^[A-Z][A-Z0-9]{0,15}$/;
const WORKSPACE_MODES: readonly ChildWorkspaceMode[] = [
  'shared',
  'snapshot',
  'worktree',
];
const MAX_DEPTH = 8;

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

function stopReasonOf<Reason extends string>(
  value: ManagedSessionJsonValue,
  reasons: Record<string, readonly Reason[]>,
  run: ExtensionRun,
): Reason | null {
  const stopReason = nullable(value, (reason) => {
    if (
      typeof reason !== 'string' ||
      !Object.values(reasons).some((fitting) =>
        (fitting as readonly string[]).includes(reason),
      )
    ) {
      fail('Child run stopReason is not a closed stop reason.');
    }
    return reason as Reason;
  });
  if ((stopReason === null) !== !TERMINAL_RUN_STATES.includes(run.state)) {
    fail('Child run stopReason is set exactly when the run ends.');
  }
  if (stopReason !== null) {
    const fitting: readonly Reason[] = Object.hasOwn(reasons, run.state)
      ? reasons[run.state]!
      : [];
    if (!fitting.includes(stopReason)) {
      fail(
        `Child run stopReason ${stopReason} does not fit the ${run.state} state.`,
      );
    }
  }
  return stopReason;
}

function stopFlags(
  stopReason: string | null,
  stopRequestedValue: ManagedSessionJsonValue,
  run: ExtensionRun,
): boolean {
  if (typeof stopRequestedValue !== 'boolean') {
    fail('Child run stopRequested must be boolean.');
  }
  if (stopReason === 'stop_requested' && !stopRequestedValue) {
    fail('Child run stop_requested needs its stop request.');
  }
  const quota =
    run.reason !== null &&
    (MANAGED_EXTENSION_REASONS.quota as readonly string[]).includes(run.reason);
  if ((stopReason === 'quota_exceeded') !== quota) {
    fail('Child run stopReason is quota_exceeded exactly for a quota reason.');
  }
  return stopRequestedValue;
}

/** Parses the body of a `managed-child_run` schema version 1 record. */
export function parseChildRun(value: unknown): AnyChildRun {
  const kind =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['kind']
      : undefined;
  if (kind === 'shell') return parseChildShellRecord(value);
  if (kind === 'child_agent') return parseChildAgentRun(value);
  fail('Child run kind must be one of shell, child_agent in schema version 1.');
}

/** Parses a `kind: "shell"` child run and refuses any other kind. */
export function parseChildShellRun(value: unknown): ChildRun {
  const record = parseChildRun(value);
  if (record.kind !== 'shell') {
    fail(
      `Child run kind must be 'shell' for this consumer, got ${record.kind}.`,
    );
  }
  return record;
}

function parseChildShellRecord(value: unknown): ChildRun {
  const body = closed(value, SHELL_KEYS);
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
  const stopReason = stopReasonOf(body.stopReason, CHILD_RUN_STOP_REASONS, run);
  const stopRequested = stopFlags(stopReason, body.stopRequested, run);
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

function parseChildAgentRun(value: unknown): ChildAgentRun {
  const body = closed(value, CHILD_AGENT_KEYS);
  const run = parseExtensionRun(body.run);
  // A child agent is started by one tool call; its result travels the
  // session delivery line its relay scans, never an effect identity or an
  // external delivery.
  if (
    run.executionCallId === null ||
    run.effectId !== null ||
    run.deliveryId !== null
  ) {
    fail(
      'Child run must name its start call, never an effect or a channel delivery.',
    );
  }
  const delivery = run.delivery;
  if (delivery === null || delivery.target !== 'session') {
    fail('Child run delivery must target the parent session.');
  }
  // The launched definition is pinned no later than the dispatch that
  // admits the creation; the shared successor rule makes it unaddable
  // after that dispatch, so its absence can never be repaired.
  if (
    run.execution !== null &&
    run.execution !== 'intent' &&
    run.definition === null
  ) {
    fail('Child run must pin the definition it dispatched.');
  }
  const depth = body.depth;
  if (
    typeof depth !== 'number' ||
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > MAX_DEPTH
  ) {
    fail(`Child run depth must be an integer from 1 to ${MAX_DEPTH}.`);
  }
  const completion = body.completion;
  if (completion !== 'tool' && completion !== 'sent') {
    fail(`Child run completion must be 'tool' or 'sent'.`);
  }
  const inputRef = ref(body.inputRef, 'inputRef');
  const workspaceMode = body.workspaceMode;
  if (
    typeof workspaceMode !== 'string' ||
    !(WORKSPACE_MODES as readonly string[]).includes(workspaceMode)
  ) {
    fail(
      `Child run workspaceMode must be one of ${WORKSPACE_MODES.join(', ')}.`,
    );
  }
  const workingDirectory = body.workingDirectory;
  if (
    typeof workingDirectory !== 'string' ||
    !isRelativeDirectory(workingDirectory)
  ) {
    fail('Child run workingDirectory must be a normalized relative directory.');
  }
  const childSessionId = nullable(body.childSessionId, (each) =>
    id(each, 'childSessionId'),
  );
  // The Session exists only once the control plane admitted its creation.
  if (
    childSessionId !== null &&
    UNSTARTED_EXECUTION_STATES.includes(run.execution)
  ) {
    fail('Child run childSessionId needs its admitted creation dispatch.');
  }
  if (
    childSessionId === null &&
    (run.execution === 'running_attached' || run.execution === 'settled')
  ) {
    fail('Child run childSessionId is set once creation is proven.');
  }
  // The Session the child runs in is hosted by a Runtime binding, set with
  // the dispatch and unaddable once dispatched, like the definition pin.
  if (childSessionId !== null && run.runtime === null) {
    fail('Child run childSessionId needs the Runtime binding that hosts it.');
  }
  // A dispatch that never started (not_started_proven) may carry no
  // binding; the dispatch itself may never lack one — the shared successor
  // rules forbid adding it later, and the chain would never reach attach.
  // The same holds of a recoverable unknown dispatch: without the binding
  // it claimed, the re-attach and the original-result paths are both
  // unreachable, so the unknown could never be recovered as H0b frames it.
  if (
    (run.execution === 'dispatch_started' ||
      run.execution === 'outcome_unknown') &&
    run.runtime === null
  ) {
    fail('Child run dispatch needs a Runtime binding.');
  }
  const predecessorChildRunId = nullable(body.predecessorChildRunId, (each) =>
    id(each, 'predecessorChildRunId'),
  );
  const resultVersion = body.resultVersion;
  if (resultVersion !== 1) {
    fail('Child run resultVersion must be 1 in schema version 1.');
  }
  const resultRef = nullable(body.resultRef, (each) => ref(each, 'resultRef'));
  const terminalReceiptRef = nullable(body.terminalReceiptRef, (each) =>
    ref(each, 'terminalReceiptRef'),
  );
  // The result and its receipt appear only together, in the revision that
  // settles the run: a half-result can never be committed early, and a
  // settled run carries both.
  if ((resultRef !== null) !== (terminalReceiptRef !== null)) {
    fail('Child run resultRef and terminalReceiptRef change only together.');
  }
  if ((resultRef !== null) !== (run.state === 'settled')) {
    fail(
      'Child run resultRef and terminalReceiptRef are set exactly when the run settles.',
    );
  }
  if (
    (run.state === 'failed' || run.state === 'cancelled') !==
    (delivery.state === 'cancelled')
  ) {
    fail(
      'Child run delivery cancelled is set exactly when the run ends without a result.',
    );
  }
  const stopReason = stopReasonOf(
    body.stopReason,
    CHILD_AGENT_STOP_REASONS,
    run,
  );
  const stopRequested = stopFlags(stopReason, body.stopRequested, run);
  // Every terminal run names the ending execution line: a completion is the
  // child's own settled execution, a failure before creation lands on
  // not_started_proven, and an honored stop or a later failure settles the
  // execution that the child Session's existence proves started.
  if (run.state === 'settled' && run.execution !== 'settled') {
    fail('Child run settled needs its settled execution.');
  }
  if (
    run.state === 'cancelled' &&
    run.execution !== 'settled' &&
    run.execution !== 'not_started_proven'
  ) {
    fail('Child run cancelled needs settled or not_started_proven execution.');
  }
  if (
    run.state === 'failed' &&
    run.execution !== 'settled' &&
    run.execution !== 'not_started_proven'
  ) {
    fail('Child run failed needs settled or not_started_proven execution.');
  }
  if (
    stopReason === 'creation_failed' &&
    (run.execution !== 'not_started_proven' || childSessionId !== null)
  ) {
    fail('Child run creation_failed needs a creation that never started.');
  }
  if (stopReason === 'child_failed' && run.execution !== 'settled') {
    fail('Child run child_failed needs its settled execution.');
  }
  return Object.freeze({
    kind: 'child_agent',
    childRunId: id(body.childRunId, 'childRunId'),
    ownerScopeId: id(body.ownerScopeId, 'ownerScopeId'),
    rootSessionId: id(body.rootSessionId, 'rootSessionId'),
    depth,
    completion,
    inputRef,
    workspaceMode: workspaceMode as ChildWorkspaceMode,
    workingDirectory,
    childSessionId,
    predecessorChildRunId,
    resultVersion,
    resultRef,
    terminalReceiptRef,
    stopReason,
    stopRequested,
    run,
  });
}

/** A normalized relative directory: `.` or NFC text without `.`/`..` segments. */
function isRelativeDirectory(value: string): boolean {
  if (value === '.') return true;
  // A drive spec (`C:/x`, drive-relative `C:x`) resolves absolute on
  // Windows — the platform the backslash clause defends.
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  if (
    value
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return false;
  }
  try {
    assertManagedSessionStableId(value, 'workingDirectory');
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return false;
    throw error;
  }
  return true;
}

/**
 * Whether `value` may open its chain: a Shell's run opens with no stop
 * request and no output; a child agent's run opens with the delivery planned,
 * no Session created, no result and no stop request.
 */
export function isChildRunStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseChildRun(value);
    if (!isExtensionRunStart(record.run) || record.stopRequested) return false;
    if (record.kind === 'shell') return record.outputRef === null;
    return (
      record.run.delivery !== null &&
      record.run.delivery.state === 'planned' &&
      record.childSessionId === null &&
      record.resultRef === null &&
      record.terminalReceiptRef === null
    );
  });
}

/**
 * Whether `next` may follow `previous` as a later revision of the same
 * record, per kind: the identity is fixed, the run moves forward, a Shell's
 * start receipt is set once and never changes while its output may only
 * grow, a child agent's Session is created once, either kind's stop
 * request is set but never cleared, and once the run is terminal the
 * remaining rules freeze everything but the child agent's delivery line.
 * The result and its receipt need no set-once rule here: they appear
 * exactly at the settling revision, and the terminal freeze forbids any
 * restatement from then on.
 */
export function isChildRunSuccessor(previous: unknown, next: unknown): boolean {
  return accepts(() => {
    const before = parseChildRun(previous);
    const after = parseChildRun(next);
    if (before.kind !== after.kind) return false;
    if (before.kind === 'shell' && after.kind === 'shell') {
      if (
        SHELL_FIXED_KEYS.some((key) => !same(before[key], after[key])) ||
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
    }
    if (before.kind !== 'child_agent' || after.kind !== 'child_agent') {
      return false;
    }
    // Once the run is terminal the record changes only its delivery line:
    // the run's own freeze confines movement to the delivery, and nothing
    // outside the run may change at all.
    if (TERMINAL_RUN_STATES.includes(before.run.state)) {
      const beforeRest = { ...before, run: null };
      const afterRest = { ...after, run: null };
      return (
        same(beforeRest, afterRest) &&
        isExtensionRunSuccessor(before.run, after.run)
      );
    }
    return (
      CHILD_AGENT_FIXED_KEYS.every((key) => same(before[key], after[key])) &&
      isExtensionRunSuccessor(before.run, after.run) &&
      (!before.stopRequested || after.stopRequested) &&
      setOnce(before.childSessionId, after.childSessionId)
    );
  });
}

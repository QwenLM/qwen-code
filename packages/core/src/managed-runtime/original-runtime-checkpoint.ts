/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import type { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  HARNESS_TURN_COMPLETE_BOUNDARY,
  parseHarnessCheckpointV1,
  type HarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  assertManagedSessionDurableRef,
  managedSessionKeysEqual,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
} from './managed-session-records.js';

export interface OriginalRuntimeCheckpointIdentity {
  readonly executionCallId: string;
  readonly activationId: string;
  readonly activationEpoch: number;
  readonly turnId: string;
  readonly promptId: string;
  readonly modelCallId: string;
  readonly invocationBindingId: string;
  readonly inputDigest: string;
  readonly toolName: string;
  readonly argsRef: ManagedSessionDurableRef;
  readonly intentSequence: number;
  readonly checkpointRef: ManagedSessionDurableRef;
}

function requireFact(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export async function readOriginalRuntimeCheckpointChain(
  snapshot: ReturnType<typeof readOnlyManagedSessionSnapshot>,
  authority: LocalManagedSessionAuthority,
) {
  const events = authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  );
  const authorization = await authority.harnessRunAuthorization();
  requireFact(authorization.status === 'runnable', 'checkpoint_not_runnable');
  const latest = authority.lastEventOfKind('checkpoint.committed');
  requireFact(latest !== undefined, 'checkpoint_missing');
  const checkpoints = events.filter(
    (event) => event.kind === 'checkpoint.committed',
  );
  const checkpointStates = new Map<string, HarnessCheckpointV1>();
  let previousCheckpointId: string | null = null;
  for (const event of checkpoints) {
    const ref = assertManagedSessionDurableRef(
      event.payload['stateRef'],
      'checkpoint state',
    );
    const state = parseHarnessCheckpointV1(await snapshot.resources.read(ref));
    requireFact(
      ref.kind === 'managed-checkpoint' &&
        ref.schemaVersion === 1 &&
        state.identity.checkpointId === event.payload['checkpointId'] &&
        state.identity.coveredSequence === event.payload['coveredSequence'] &&
        state.identity.coveredSequence < event.sequence &&
        state.identity.previousCheckpointId ===
          event.payload['previousCheckpointId'] &&
        state.identity.previousCheckpointId === previousCheckpointId &&
        event.subject?.type === 'activation' &&
        state.identity.activationId === event.subject.activationId &&
        managedSessionKeysEqual(state.identity.sessionKey, snapshot.sessionKey),
      'checkpoint_event_body_conflict',
    );
    checkpointStates.set(state.identity.checkpointId, state);
    previousCheckpointId = state.identity.checkpointId;
  }
  const current = authorization.checkpoint;
  return { events, checkpoints, checkpointStates, current, latest };
}

export async function verifyOriginalRuntimeCheckpointCoverage(
  snapshot: ReturnType<typeof readOnlyManagedSessionSnapshot>,
  authority: LocalManagedSessionAuthority,
  binding: OriginalRuntimeCheckpointIdentity,
  outcomeRef: ManagedSessionDurableRef,
  sequence: number,
) {
  const { events, checkpoints, checkpointStates, current, latest } =
    await readOriginalRuntimeCheckpointChain(snapshot, authority);
  requireFact(
    current.identity.coveredSequence >= sequence,
    'receipt_not_covered',
  );
  const originalSubject = (event: ManagedSessionEvent) =>
    event.subject?.type === 'activation' &&
    event.subject.activationId === binding.activationId &&
    event.subject.epoch === binding.activationEpoch;
  requireFact(
    originalSubject(latest) &&
      current.identity.activationId === binding.activationId &&
      current.identity.turnId === binding.turnId &&
      current.identity.promptId === binding.promptId,
    'checkpoint_original_identity_conflict',
  );
  requireFact(
    events
      .filter((event) => event.sequence > latest.sequence)
      .every(
        (event) =>
          event.kind === 'activation.changed' &&
          event.payload['activationId'] === binding.activationId &&
          event.payload['epoch'] === binding.activationEpoch,
      ),
    'uncovered_later_work',
  );
  const originalCheckpoint = checkpoints.find((event) =>
    isDeepStrictEqual(event.payload['stateRef'], binding.checkpointRef),
  );
  const dispatch =
    originalCheckpoint &&
    checkpointStates.get(originalCheckpoint.payload['checkpointId'] as string);
  const intent = events.find(
    (event) => event.sequence === binding.intentSequence,
  );
  const dispatchItem = dispatch?.tools?.items.find(
    (item) => item.executionCallId === binding.executionCallId,
  );
  const dispatchRuntime = dispatch?.runtime?.bindings.find(
    (item) => item.executionCallId === binding.executionCallId,
  );
  requireFact(
    dispatch?.continuation.phase === 'await_runtime' &&
      dispatch.identity.activationId === binding.activationId &&
      dispatch.identity.turnId === binding.turnId &&
      dispatch.identity.promptId === binding.promptId &&
      dispatchItem?.state === 'in_progress' &&
      dispatchItem.toolName === binding.toolName &&
      dispatchItem.outcomeSource === 'runtime' &&
      dispatchItem.functionCallId === binding.modelCallId &&
      dispatchItem.inputDigest === binding.inputDigest &&
      dispatchRuntime?.state === 'dispatch' &&
      dispatchRuntime.invocationBindingId === binding.invocationBindingId &&
      originalSubject(originalCheckpoint!) &&
      intent?.kind === 'tool.intent' &&
      originalSubject(intent) &&
      intent.payload['outcomeSource'] === 'runtime' &&
      intent.payload['executionCallId'] === binding.executionCallId &&
      isDeepStrictEqual(intent.payload['argsRef'], binding.argsRef) &&
      dispatch.identity.coveredSequence >= binding.intentSequence,
    'original_dispatch_evidence_conflict',
  );
  const matchesTool = (state: HarnessCheckpointV1, consumed: boolean) => {
    const item = state.tools?.items.find(
      (item) => item.executionCallId === binding.executionCallId,
    );
    const runtime = state.runtime?.bindings.find(
      (item) => item.executionCallId === binding.executionCallId,
    );
    return (
      item?.state === 'settled' &&
      item.toolName === binding.toolName &&
      item.outcomeSource === 'runtime' &&
      item.functionCallId === binding.modelCallId &&
      item.inputDigest === binding.inputDigest &&
      isDeepStrictEqual(item.outcomeRef, outcomeRef) &&
      (!consumed || item.consumed) &&
      runtime?.invocationBindingId === binding.invocationBindingId &&
      runtime.state !== 'dispatch'
    );
  };
  const noPendingWork = (state: HarnessCheckpointV1) =>
    state.continuation.pendingEventIds.length === 0 &&
    state.tools?.items.every((item) => item.state === 'settled') !== false &&
    state.runtime?.bindings.every((item) => item.state !== 'dispatch') !==
      false &&
    state.approval?.state !== 'requested';
  requireFact(noPendingWork(current), 'checkpoint_pending_work');
  const toolState =
    current.continuation.phase === 'before_model'
      ? checkpointStates.get(current.identity.previousCheckpointId ?? '')
      : current;
  const represented = new Set(
    toolState?.tools?.items.map((item) => item.executionCallId),
  );
  requireFact(
    dispatch.tools!.items.every((item) =>
      represented.has(item.executionCallId),
    ) &&
      events
        .filter(
          (event) =>
            event.kind === 'tool.intent' &&
            event.sequence > originalCheckpoint!.sequence &&
            event.sequence <= current.identity.coveredSequence,
        )
        .every((event) =>
          represented.has(event.payload['executionCallId'] as string),
        ),
    'checkpoint_unrepresented_tool_work',
  );
  if (current.continuation.phase === 'before_model') {
    const covered = current.identity.coveredSequence;
    const companion = events.find((event) => event.sequence === covered + 1);
    const tx = snapshot.transactions.find(
      (tx) => tx.lastSequence === latest.sequence,
    );
    const previous =
      current.identity.previousCheckpointId === null
        ? undefined
        : checkpointStates.get(current.identity.previousCheckpointId);
    requireFact(
      latest.payload['boundary'] === HARNESS_TURN_COMPLETE_BOUNDARY &&
        latest.sequence === covered + 2 &&
        companion?.kind === 'turn.settled' &&
        companion.payload['turnId'] === binding.turnId &&
        originalSubject(companion) &&
        tx?.firstSequence === covered + 1 &&
        tx.eventCount === 2 &&
        previous !== undefined &&
        previous.identity.activationId === binding.activationId &&
        previous.identity.turnId === binding.turnId &&
        previous.identity.promptId === binding.promptId &&
        ['results_ready', 'turn_settled'].includes(
          previous.continuation.phase,
        ) &&
        noPendingWork(previous) &&
        previous.tools?.items.every((item) => item.consumed) === true &&
        previous.identity.coveredSequence >= sequence &&
        matchesTool(previous, true),
      'turn_complete_consumed_history_not_qualified',
    );
  } else {
    requireFact(
      latest.sequence === current.identity.coveredSequence + 1 &&
        (current.continuation.phase === 'results_ready' ||
          (current.continuation.phase === 'turn_settled' &&
            current.tools?.items.every((item) => item.consumed) === true)) &&
        matchesTool(current, false),
      'checkpoint_original_tool_not_settled',
    );
  }
  return {
    journalRevision: snapshot.head.journalRevision,
    committedSequence: authority.committedSequence,
    commitDigest: snapshot.head.lastCommitDigest,
    checkpointId: current.identity.checkpointId,
    coveredSequence: current.identity.coveredSequence,
    phase: current.continuation.phase,
  };
}

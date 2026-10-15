/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  HARNESS_TURN_COMPLETE_BOUNDARY,
  parseHarnessCheckpointV1,
  type HarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  managedSessionKeysEqual,
  parseManagedSessionRecordJson,
  type ManagedSessionEvent,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import {
  parseToolPublicationBinding,
  toolPublicationManifestIdentity,
} from './managed-tool-publication.js';
import {
  parseToolResultEnvelope,
  parseToolResultManifestBytes,
} from './managed-tool-result.js';

export type OriginalReceiptCheckpointObservation =
  | { readonly status: 'unresolved'; readonly reason: string }
  | {
      readonly status: 'matched';
      readonly publicationId: string;
      readonly executionCallId: string;
      readonly journalRevision: number;
      readonly committedSequence: number;
      readonly commitDigest: string | null;
      readonly receiptSequence: number;
      readonly checkpointId: string;
      readonly coveredSequence: number;
      readonly phase: HarnessCheckpointV1['continuation']['phase'];
    };

function requireFact(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function object(value: unknown): Record<string, unknown> {
  requireFact(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_snapshot_object',
  );
  return value as Record<string, unknown>;
}

/** One original publication observation, never a physical release decision. */
export async function inspectOriginalReceiptCheckpointCoverage(
  value: unknown,
): Promise<OriginalReceiptCheckpointObservation> {
  try {
    const snapshot = readOnlyManagedSessionSnapshot(value);
    const original = object(object(value)['original']);
    const binding = parseToolPublicationBinding(original['binding']);
    const csi = object(object(value)['originalCSI']);
    requireFact(
      managedSessionKeysEqual(binding.sessionKey, snapshot.sessionKey) &&
        original['publicationId'] === binding.publicationId &&
        csi['bindingId'] === binding.runtimeBindingId &&
        csi['runtimeGeneration'] === binding.bindingGeneration,
      'original_scope_conflict',
    );
    const sequence = assertManagedSessionSequence(
      original['receiptSequence'] as ManagedSessionJsonValue,
      'receipt sequence',
    );
    const revision = assertManagedSessionSequence(
      original['receiptRevision'] as ManagedSessionJsonValue,
      'receipt revision',
    );
    const outcomeRef = assertManagedSessionDurableRef(
      original['outcomeRef'] as ManagedSessionJsonValue,
      'original outcome',
    );
    const manifestRef = assertManagedSessionDurableRef(
      original['manifestRef'] as ManagedSessionJsonValue,
      'original manifest',
    );
    requireFact(
      outcomeRef.kind === 'managed-tool-outcome' &&
        manifestRef.kind === 'managed-tool-result-manifest',
      'original_resource_kind',
    );
    const authority = await LocalManagedSessionAuthority.open({
      journal: snapshot.journal,
      sessionKey: snapshot.sessionKey,
      resources: snapshot.resources,
      cwd: '.',
      version: 'readonly-csi-observation',
    });
    requireFact(
      authority.compactedThroughSequence === 0,
      'compaction_not_qualified',
    );
    const activation = authority.currentActivation;
    requireFact(
      activation?.activationId === binding.activationId &&
        activation.epoch === binding.activationEpoch,
      'original_activation_changed',
    );
    const events = authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    );
    const receipts = events.filter(
      (event) =>
        event.kind === 'tool.receipt' &&
        event.payload['executionCallId'] === binding.executionCallId,
    );
    requireFact(receipts.length === 1, 'original_receipt_missing_or_repeated');
    const receipt = receipts[0];
    const transaction = snapshot.transactions[revision - 1];
    requireFact(
      receipt.sequence === sequence &&
        receipt.payload['historyRevision'] === sequence &&
        transaction?.operation === 'recordToolResult' &&
        transaction.commandId === binding.executionCallId &&
        transaction.firstSequence === sequence &&
        transaction.lastSequence === sequence &&
        transaction.contentDigest === outcomeRef.digest &&
        isDeepStrictEqual(receipt.payload['toolOutcomeRef'], outcomeRef) &&
        isDeepStrictEqual(receipt.payload['resultRef'], manifestRef) &&
        isDeepStrictEqual(receipt.payload['resources'], [manifestRef]),
      'original_receipt_conflict',
    );
    const saved = object(
      parseManagedSessionRecordJson(
        (await snapshot.resources.read(outcomeRef)).toString('utf8'),
        2 * 1024 * 1024,
      ),
    );
    const envelope = parseToolResultEnvelope(saved['envelope']);
    const identity = toolPublicationManifestIdentity(binding);
    const history = saved['history'];
    const hostedHistory =
      history !== null && typeof history === 'object' && !Array.isArray(history)
        ? (history as Record<string, unknown>)
        : undefined;
    requireFact(
      saved['decision'] === 'committed' &&
        envelope.capture?.captureStatus === 'complete' &&
        isDeepStrictEqual(envelope.capture.manifest, manifestRef),
      'original_outcome_not_complete',
    );
    requireFact(
      (Object.keys(saved).length === 4 &&
        saved['version'] === 1 &&
        isDeepStrictEqual(saved['identity'], identity)) ||
        (Object.keys(saved).length === 5 &&
          saved['schemaVersion'] === 1 &&
          isDeepStrictEqual(saved['manifestRef'], manifestRef) &&
          hostedHistory !== undefined &&
          Object.keys(hostedHistory).length === 4 &&
          typeof hostedHistory['messageId'] === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            hostedHistory['messageId'],
          ) &&
          typeof hostedHistory['timestamp'] === 'string' &&
          hostedHistory['timestamp'].trim().length > 0 &&
          typeof hostedHistory['model'] === 'string' &&
          hostedHistory['model'].trim().length > 0 &&
          Array.isArray(hostedHistory['parts'])),
      'outcome_profile_not_qualified',
    );
    const manifest = parseToolResultManifestBytes(
      await snapshot.resources.read(manifestRef),
    );
    requireFact(
      Object.entries(identity).every(([key, value]) =>
        isDeepStrictEqual(manifest[key as keyof typeof manifest], value),
      ) &&
        manifest.captureStatus === 'complete' &&
        manifest.capturePolicy === 'complete_required' &&
        manifest.captureScope === 'process_pipes' &&
        manifest.contents.every((content) => content.state === 'sealed'),
      'original_manifest_conflict',
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
      const state = parseHarnessCheckpointV1(
        await snapshot.resources.read(ref),
      );
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
          managedSessionKeysEqual(
            state.identity.sessionKey,
            snapshot.sessionKey,
          ),
        'checkpoint_event_body_conflict',
      );
      checkpointStates.set(state.identity.checkpointId, state);
      previousCheckpointId = state.identity.checkpointId;
    }
    const current = authorization.checkpoint;
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
        current.identity.promptId === binding.reference.promptId,
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
      checkpointStates.get(
        originalCheckpoint.payload['checkpointId'] as string,
      );
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
        dispatch.identity.promptId === binding.reference.promptId &&
        dispatchItem?.state === 'in_progress' &&
        dispatchItem.toolName === 'run_shell_command' &&
        dispatchItem.outcomeSource === 'runtime' &&
        dispatchItem.functionCallId === binding.modelCallId &&
        dispatchItem.inputDigest === binding.reference.argsDigest.slice(7) &&
        dispatchRuntime?.state === 'dispatch' &&
        dispatchRuntime.invocationBindingId === binding.reference.callId &&
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
        item.toolName === 'run_shell_command' &&
        item.outcomeSource === 'runtime' &&
        item.functionCallId === binding.modelCallId &&
        item.inputDigest === binding.reference.argsDigest.slice(7) &&
        isDeepStrictEqual(item.outcomeRef, outcomeRef) &&
        (!consumed || item.consumed) &&
        runtime?.invocationBindingId === binding.reference.callId &&
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
          previous.identity.promptId === binding.reference.promptId &&
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
      status: 'matched',
      publicationId: binding.publicationId,
      executionCallId: binding.executionCallId,
      journalRevision: snapshot.head.journalRevision,
      committedSequence: authority.committedSequence,
      commitDigest: snapshot.head.lastCommitDigest,
      receiptSequence: sequence,
      checkpointId: current.identity.checkpointId,
      coveredSequence: current.identity.coveredSequence,
      phase: current.continuation.phase,
    };
  } catch (error) {
    return {
      status: 'unresolved',
      reason: error instanceof Error ? error.message : 'invalid_snapshot',
    };
  }
}

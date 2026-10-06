/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { readOriginalRuntimeCheckpointChain } from './original-runtime-checkpoint.js';
import {
  HARNESS_TURN_COMPLETE_BOUNDARY,
  type HarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  assertManagedSessionDurableRef,
  parseManagedSessionRecordJson,
  type ManagedSessionEvent,
} from './managed-session-records.js';
import {
  convertManagedRuntimeToolResult,
  type ManagedRuntimeInlineResult,
} from './managed-runtime-tool-response.js';
import { normalizeWorkspaceRelativePath } from './managed-workspace-relative-path.js';
import { parseManagedToolFileHistoryState } from '../tools/managed-tool-file-history-protocol.js';

export type OriginalFileCheckpointObservation =
  | { readonly status: 'unresolved'; readonly reason: string }
  | {
      readonly status: 'matched';
      readonly executionCallId: string;
      readonly journalRevision: number;
      readonly committedSequence: number;
      readonly commitDigest: string | null;
      readonly outcomeDigest: string;
      readonly resultSequence: number;
      readonly checkpointId: string;
      readonly coveredSequence: number;
    };

function requireFact(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function object(value: unknown): Record<string, unknown> {
  requireFact(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_file_snapshot_object',
  );
  return value as Record<string, unknown>;
}

function counter(value: unknown): bigint {
  requireFact(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value),
    'invalid_file_execution_counter',
  );
  const result = BigInt(value);
  requireFact(result <= 2n ** 63n - 1n, 'invalid_file_execution_counter');
  return result;
}

const noPendingWork = (state: HarnessCheckpointV1) =>
  state.continuation.pendingEventIds.length === 0 &&
  state.tools?.items.every((item) => item.state === 'settled') !== false &&
  state.runtime?.bindings.every((item) => item.state !== 'dispatch') !==
    false &&
  state.approval?.state !== 'requested';

/** Native file settlement only; it never establishes worker or volume release. */
export async function inspectOriginalFileCheckpointCoverage(
  value: unknown,
): Promise<OriginalFileCheckpointObservation> {
  try {
    const encoded = object(value);
    requireFact(
      encoded['format'] === 'qwen-csi-session-checkpoint-snapshot/1',
      'file_snapshot_format_not_qualified',
    );
    const snapshot = readOnlyManagedSessionSnapshot(value);
    const execution = object(encoded['originalExecution']);
    const csi = object(encoded['originalCSI']);
    const reference = object(execution['reference']);
    requireFact(
      execution['state'] === 'SETTLED' &&
        execution['bindingId'] === csi['bindingId'] &&
        execution['runtimeGeneration'] === csi['runtimeGeneration'] &&
        execution['harnessSessionId'] === snapshot.sessionKey.sessionId &&
        execution['runtimeSessionId'] === reference['sessionId'] &&
        execution['turnId'] === reference['promptId'] &&
        execution['toolCallId'] === reference['callId'] &&
        execution['requestDigest'] === reference['argsDigest'] &&
        reference['dispatchMode'] === 'deferred' &&
        Object.keys(reference).sort().join(',') ===
          'argsDigest,callId,dispatchMode,promptId,sessionId' &&
        typeof execution['executionCallId'] === 'string' &&
        typeof execution['requestDigest'] === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(execution['requestDigest']),
      'original_file_execution_conflict',
    );
    const dispatchGeneration = counter(execution['dispatchGeneration']);
    requireFact(
      dispatchGeneration > 0n &&
        counter(execution['authorizedDispatchGeneration']) ===
          dispatchGeneration &&
        counter(execution['authorizedBindingVersion']) > 0n &&
        counter(execution['authorizedBindingVersion']) <
          counter(String(csi['sealedBindingVersion'])),
      'original_file_dispatch_not_authorized',
    );
    const result = object(execution['result']);
    requireFact(
      ['success', 'error', 'cancelled', 'not_started'].includes(
        String(result['executionStatus']),
      ) &&
        result['executionStatus'] === execution['executionStatus'] &&
        Object.keys(result).every((key) =>
          ['executionStatus', 'responseParts', 'error'].includes(key),
        ) &&
        (Array.isArray(result['responseParts']) ||
          (result['executionStatus'] !== 'success' &&
            result['responseParts'] === undefined)),
      'original_file_result_not_qualified',
    );
    if (result['error'] !== undefined) {
      const error = object(result['error']);
      requireFact(
        typeof error['message'] === 'string' &&
          error['message'].length > 0 &&
          Object.keys(error).every((key) =>
            ['message', 'type'].includes(key),
          ) &&
          (error['type'] === undefined || typeof error['type'] === 'string'),
        'original_file_error_not_qualified',
      );
    }
    const authority = await LocalManagedSessionAuthority.open({
      journal: snapshot.journal,
      sessionKey: snapshot.sessionKey,
      resources: snapshot.resources,
      cwd: '.',
      version: 'readonly-csi-file-observation',
    });
    const { events, checkpoints, checkpointStates, current, latest } =
      await readOriginalRuntimeCheckpointChain(snapshot, authority);
    const activation = authority.currentActivation;
    const originalSubject = (event: ManagedSessionEvent) =>
      event.subject?.type === 'activation' &&
      event.subject.activationId === activation?.activationId &&
      event.subject.epoch === activation?.epoch;
    requireFact(
      activation !== undefined &&
        activation.epoch === 1 &&
        authority.compactedThroughSequence === 0 &&
        originalSubject(latest) &&
        current.identity.activationId === activation.activationId &&
        noPendingWork(current) &&
        events
          .filter((event) => event.sequence > latest.sequence)
          .every(
            (event) =>
              event.kind === 'activation.changed' &&
              event.payload['activationId'] === activation.activationId &&
              event.payload['epoch'] === activation.epoch,
          ),
      'file_session_tail_not_settled',
    );
    const intents = events.filter(
      (event) =>
        event.kind === 'tool.intent' &&
        event.payload['executionCallId'] === execution['executionCallId'],
    );
    requireFact(intents.length === 1, 'file_intent_missing_or_repeated');
    const intent = intents[0];
    const argsRef = assertManagedSessionDurableRef(
      intent.payload['argsRef'],
      'file intent input',
    );
    const input = object(
      parseManagedSessionRecordJson(
        (await snapshot.resources.read(argsRef)).toString('utf8'),
        2 * 1024 * 1024,
      ),
    );
    requireFact(
      argsRef.kind === 'managed-tool-input' &&
        originalSubject(intent) &&
        intent.payload['outcomeSource'] === 'runtime' &&
        input['harnessSessionId'] === snapshot.sessionKey.sessionId &&
        input['runtimeSessionId'] === execution['runtimeSessionId'] &&
        typeof input['payloadJson'] === 'string' &&
        `sha256:${createHash('sha256').update(input['payloadJson']).digest('hex')}` ===
          execution['requestDigest'],
      'file_original_input_conflict',
    );
    const payload = object(
      parseManagedSessionRecordJson(input['payloadJson'], 256 * 1024),
    );
    const toolName = payload['toolName'];
    requireFact(
      typeof toolName === 'string' &&
        ['read_file', 'write_file', 'edit'].includes(toolName),
      'file_tool_not_qualified',
    );
    const definitionRef = assertManagedSessionDurableRef(
      intent.payload['toolDefinitionRef'],
      'file tool definition',
    );
    const definition = object(
      parseManagedSessionRecordJson(
        (await snapshot.resources.read(definitionRef)).toString('utf8'),
        256 * 1024,
      ),
    );
    requireFact(
      definitionRef.kind === 'managed-tool-definition' &&
        definition['name'] === toolName,
      'file_tool_definition_conflict',
    );
    requireFact(
      ((result['responseParts'] ?? []) as readonly unknown[]).every((part) => {
        const value = object(part);
        return (
          Object.keys(value).length === 1 &&
          (typeof value['text'] === 'string' ||
            (value['inlineData'] !== undefined &&
              typeof object(value['inlineData'])['data'] === 'string' &&
              typeof object(value['inlineData'])['mimeType'] === 'string' &&
              Object.keys(object(value['inlineData'])).every((key) =>
                ['data', 'mimeType', 'displayName'].includes(key),
              ) &&
              (object(value['inlineData'])['displayName'] === undefined ||
                typeof object(value['inlineData'])['displayName'] ===
                  'string')))
        );
      }),
      'file_response_parts_not_qualified',
    );
    const dispatchEvent = checkpoints.find((event) => {
      const state = checkpointStates.get(
        event.payload['checkpointId'] as string,
      )!;
      return (
        state.continuation.phase === 'await_runtime' &&
        state.tools?.items.some(
          (item) =>
            item.executionCallId === execution['executionCallId'] &&
            item.state === 'in_progress',
        )
      );
    });
    requireFact(
      dispatchEvent !== undefined,
      'file_dispatch_checkpoint_missing',
    );
    const dispatch = checkpointStates.get(
      dispatchEvent.payload['checkpointId'] as string,
    )!;
    const item = dispatch.tools!.items.find(
      (item) => item.executionCallId === execution['executionCallId'],
    )!;
    const runtime = dispatch.runtime?.bindings.find(
      (binding) => binding.executionCallId === execution['executionCallId'],
    );
    requireFact(
      originalSubject(dispatchEvent) &&
        dispatch.identity.activationId === activation.activationId &&
        dispatch.identity.turnId === execution['turnId'] &&
        dispatch.identity.promptId === execution['turnId'] &&
        dispatch.identity.coveredSequence >= intent.sequence &&
        item.toolName === toolName &&
        item.outcomeSource === 'runtime' &&
        item.inputDigest === execution['requestDigest'].slice(7) &&
        runtime?.invocationBindingId === execution['executionCallId'] &&
        runtime.state === 'dispatch',
      'file_dispatch_identity_conflict',
    );
    const consumed = [...checkpointStates.values()].find((state) => {
      const settled = state.tools?.items.find(
        (tool) => tool.executionCallId === execution['executionCallId'],
      );
      return (
        ['results_ready', 'turn_settled'].includes(state.continuation.phase) &&
        settled?.state === 'settled' &&
        settled.consumed
      );
    });
    const settled = consumed?.tools?.items.find(
      (tool) => tool.executionCallId === execution['executionCallId'],
    );
    requireFact(
      consumed !== undefined &&
        consumed.identity.activationId === activation.activationId &&
        consumed.identity.turnId === execution['turnId'] &&
        consumed.identity.promptId === execution['turnId'] &&
        settled?.outcomeSource === 'runtime' &&
        settled.functionCallId === item.functionCallId &&
        settled.toolName === item.toolName &&
        settled.inputDigest === item.inputDigest &&
        settled.outcomeRef !== null &&
        noPendingWork(consumed) &&
        consumed.tools?.items.every((tool) => tool.consumed) === true,
      'file_result_not_consumed',
    );
    const outcomeRef = settled.outcomeRef;
    const settledRuntime = consumed.runtime?.bindings.find(
      (binding) => binding.executionCallId === execution['executionCallId'],
    );
    requireFact(
      settledRuntime?.invocationBindingId === runtime.invocationBindingId &&
        settledRuntime.state !== 'dispatch' &&
        current.identity.coveredSequence >= consumed.identity.coveredSequence &&
        dispatch.tools!.items.every((tool) =>
          consumed.tools!.items.some(
            (settled) => settled.executionCallId === tool.executionCallId,
          ),
        ) &&
        [...checkpointStates.values()]
          .filter(
            (state) =>
              state.identity.coveredSequence >=
              consumed.identity.coveredSequence,
          )
          .every((state) => {
            const later = state.tools?.items.find(
              (tool) => tool.executionCallId === execution['executionCallId'],
            );
            return (
              later === undefined ||
              (later.state === 'settled' &&
                later.consumed &&
                later.functionCallId === item.functionCallId &&
                later.toolName === item.toolName &&
                later.inputDigest === item.inputDigest &&
                isDeepStrictEqual(later.outcomeRef, outcomeRef))
            );
          }),
      'file_settled_checkpoint_conflict',
    );
    const converted = convertManagedRuntimeToolResult(
      toolName,
      item.functionCallId,
      {
        ...result,
        responseParts: result['responseParts'] ?? [],
      } as unknown as ManagedRuntimeInlineResult,
      undefined,
    );
    const outcome = parseManagedSessionRecordJson(
      (await snapshot.resources.read(outcomeRef)).toString('utf8'),
      2 * 1024 * 1024,
    );
    requireFact(
      outcomeRef.kind === 'managed-tool-outcome' &&
        isDeepStrictEqual(outcome, {
          executionCallId: execution['executionCallId'],
          ...converted[0],
        }),
      'file_model_outcome_conflict',
    );
    const messages = [];
    const assistants = [];
    for (const event of events.filter(
      (event) => event.kind === 'message.committed',
    )) {
      const ref = assertManagedSessionDurableRef(
        event.payload['contentRef'],
        'file message',
      );
      const record = object(
        parseManagedSessionRecordJson(
          (await snapshot.resources.read(ref)).toString('utf8'),
          2 * 1024 * 1024,
        ),
      );
      if (record['daemonPromptId'] !== execution['turnId']) continue;
      const parts = object(record['message'])['parts'];
      requireFact(
        ref.kind === 'managed-message' &&
          record['uuid'] === event.payload['messageId'] &&
          record['sessionId'] === snapshot.sessionKey.sessionId &&
          record['type'] === event.payload['role'],
        'file_message_identity_conflict',
      );
      if (
        record['type'] === 'assistant' &&
        record['uuid'] === item.modelMessageId
      )
        assistants.push({ event, parts });
      if (record['type'] !== 'tool_result' || !Array.isArray(parts)) continue;
      if (
        parts.some(
          (part) =>
            object(object(part)['functionResponse'])['id'] ===
            item.functionCallId,
        )
      )
        messages.push({ event, record, parts });
    }
    requireFact(
      assistants.length === 1 &&
        originalSubject(assistants[0].event) &&
        assistants[0].event.sequence < intent.sequence &&
        Array.isArray(assistants[0].parts) &&
        object(object(assistants[0].parts[item.partIndex])['functionCall'])[
          'id'
        ] === item.functionCallId &&
        object(object(assistants[0].parts[item.partIndex])['functionCall'])[
          'name'
        ] === toolName &&
        messages.length === 1 &&
        originalSubject(messages[0].event) &&
        messages[0].event.sequence > dispatchEvent.sequence &&
        consumed.identity.coveredSequence >= messages[0].event.sequence &&
        messages[0].parts.length === 1 &&
        isDeepStrictEqual(messages[0].parts, converted),
      'file_model_history_conflict',
    );
    const modelArgs = object(
      object(object(assistants[0].parts[item.partIndex])['functionCall'])[
        'args'
      ],
    );
    requireFact(
      typeof modelArgs['file_path'] === 'string' &&
        isDeepStrictEqual(payload['input'], {
          ...modelArgs,
          file_path: normalizeWorkspaceRelativePath(
            modelArgs['file_path'].trim(),
          ),
        }),
      'file_model_arguments_conflict',
    );
    const history = events.findLast(
      (event) =>
        event.kind === 'domain.committed' &&
        event.payload['domain'] === 'file_history',
    );
    if (toolName !== 'read_file' || history !== undefined) {
      requireFact(history !== undefined, 'file_history_missing');
      const ref = assertManagedSessionDurableRef(
        history.payload['recordRef'],
        'file history',
      );
      const record = object(
        parseManagedSessionRecordJson(
          (await snapshot.resources.read(ref)).toString('utf8'),
          2 * 1024 * 1024,
        ),
      );
      const state = object(record['state']);
      const parsed = parseManagedToolFileHistoryState({
        ownerSessionId: state['ownerSessionId'],
        revision: 0,
        snapshots: state['snapshots'],
      });
      const paths = new Set(
        parsed.snapshots.flatMap((row) => Object.keys(row.trackedFileBackups)),
      );
      const files = object(state['files']);
      if (record['record'] !== undefined) {
        const projection = object(record['record']);
        const payload = object(projection['systemPayload']);
        requireFact(
          Object.keys(projection).sort().join(',') ===
            'cwd,parentUuid,sessionId,subtype,systemPayload,timestamp,type,uuid,version' &&
            typeof projection['uuid'] === 'string' &&
            projection['uuid'].length > 0 &&
            (projection['parentUuid'] === null ||
              (typeof projection['parentUuid'] === 'string' &&
                projection['parentUuid'].length > 0)) &&
            projection['sessionId'] === snapshot.sessionKey.sessionId &&
            typeof projection['timestamp'] === 'string' &&
            Number.isFinite(Date.parse(projection['timestamp'])) &&
            projection['type'] === 'system' &&
            projection['subtype'] === 'file_history_snapshot' &&
            typeof projection['cwd'] === 'string' &&
            typeof projection['version'] === 'string' &&
            Object.keys(payload).join(',') === 'snapshots' &&
            isDeepStrictEqual(payload['snapshots'], state['snapshots']),
          'file_history_projection_not_qualified',
        );
      }
      requireFact(
        ref.kind === 'managed-file_history' &&
          record['schemaVersion'] === 1 &&
          record['operationId'] === history.payload['operationId'] &&
          typeof record['revision'] === 'number' &&
          Number.isSafeInteger(record['revision']) &&
          record['revision'] > 0 &&
          Object.keys(record).every((key) =>
            [
              'operationId',
              'revision',
              'previousRecordRef',
              'schemaVersion',
              'state',
              'pendingTurn',
              'pendingMessageId',
              'pendingUndo',
              'undoReceipts',
              'record',
            ].includes(key),
          ) &&
          Object.keys(state).sort().join(',') ===
            'files,ownerSessionId,snapshots' &&
          record['pendingTurn'] === null &&
          record['pendingUndo'] === null &&
          record['pendingMessageId'] === undefined &&
          state['ownerSessionId'] === snapshot.sessionKey.sessionId &&
          Array.isArray(record['undoReceipts']) &&
          record['undoReceipts'].length === 0 &&
          Object.keys(files).length === paths.size &&
          Object.entries(files).every(([path, value]) => {
            if (!paths.has(path)) return false;
            if (value === null) return true;
            const file = object(value);
            return (
              Object.keys(file).sort().join(',') === 'digest,mode' &&
              typeof file['digest'] === 'string' &&
              /^sha256:[a-f0-9]{64}$/.test(file['digest']) &&
              typeof file['mode'] === 'number' &&
              Number.isSafeInteger(file['mode']) &&
              file['mode'] >= 0 &&
              file['mode'] <= 0o7777
            );
          }) &&
          current.identity.coveredSequence >= history.sequence &&
          (toolName === 'read_file' ||
            (history.sequence > messages[0].event.sequence &&
              parsed.snapshots.some(
                (row) =>
                  row.promptId === execution['turnId'] &&
                  Object.hasOwn(
                    row.trackedFileBackups,
                    String(object(payload['input'])['file_path']),
                  ),
              ))),
        'file_history_tail_not_settled',
      );
    }
    if (current.continuation.phase === 'before_model') {
      const previous = checkpointStates.get(
        current.identity.previousCheckpointId ?? '',
      );
      const companion = events.find(
        (event) => event.sequence === current.identity.coveredSequence + 1,
      );
      const tx = snapshot.transactions.find(
        (tx) => tx.lastSequence === latest.sequence,
      );
      requireFact(
        latest.payload['boundary'] === HARNESS_TURN_COMPLETE_BOUNDARY &&
          latest.sequence === current.identity.coveredSequence + 2 &&
          companion?.kind === 'turn.settled' &&
          originalSubject(companion) &&
          companion.payload['turnId'] === current.identity.turnId &&
          tx?.firstSequence === companion.sequence &&
          tx.eventCount === 2 &&
          previous !== undefined &&
          noPendingWork(previous) &&
          previous.tools?.items.every((tool) => tool.consumed) === true &&
          previous.identity.activationId === activation.activationId &&
          previous.identity.turnId === current.identity.turnId &&
          previous.identity.promptId === current.identity.promptId,
        'file_turn_complete_not_qualified',
      );
    } else
      requireFact(
        ['results_ready', 'turn_settled'].includes(
          current.continuation.phase,
        ) &&
          latest.sequence === current.identity.coveredSequence + 1 &&
          current.tools?.items.every((tool) => tool.consumed) === true,
        'file_checkpoint_tail_not_consumed',
      );
    return {
      status: 'matched',
      executionCallId: execution['executionCallId'],
      journalRevision: snapshot.head.journalRevision,
      committedSequence: authority.committedSequence,
      commitDigest: snapshot.head.lastCommitDigest,
      outcomeDigest: outcomeRef.digest,
      resultSequence: messages[0].event.sequence,
      checkpointId: current.identity.checkpointId,
      coveredSequence: current.identity.coveredSequence,
    };
  } catch (error) {
    return {
      status: 'unresolved',
      reason: error instanceof Error ? error.message : 'invalid_file_snapshot',
    };
  }
}

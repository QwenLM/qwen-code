/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { verifyOriginalRuntimeCheckpointCoverage } from './original-runtime-checkpoint.js';
import { type HarnessCheckpointV1 } from './managed-harness-checkpoint.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  managedSessionKeysEqual,
  parseManagedSessionRecordJson,
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
    requireFact(
      object(value)['format'] === 'qwen-csi-receipt-checkpoint-snapshot/1',
      'snapshot format is unsupported.',
    );
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
    const coverage = await verifyOriginalRuntimeCheckpointCoverage(
      snapshot,
      authority,
      {
        ...binding,
        promptId: binding.reference.promptId,
        inputDigest: binding.reference.argsDigest.slice(7),
        invocationBindingId: binding.reference.callId,
        toolName: 'run_shell_command',
      },
      outcomeRef,
      sequence,
    );
    return {
      status: 'matched',
      publicationId: binding.publicationId,
      executionCallId: binding.executionCallId,
      ...coverage,
      receiptSequence: sequence,
    };
  } catch (error) {
    return {
      status: 'unresolved',
      reason: error instanceof Error ? error.message : 'invalid_snapshot',
    };
  }
}

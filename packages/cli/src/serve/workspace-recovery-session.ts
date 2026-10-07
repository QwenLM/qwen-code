/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  describeTransaction,
  parseStoredTransaction,
  requireStoredTransactionMatches,
  type StoredTransaction,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  HARNESS_TURN_COMPLETE_BOUNDARY,
  parseHarnessCheckpointV1,
  type HarnessCheckpointV1,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  MANAGED_SESSION_LIMITS,
  assertManagedSessionDurableRef,
  managedSessionEventsDigest,
  managedSessionKeysEqual,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  isToolResultEnvelopeOf,
  isToolResultPageAt,
  parseToolResultEnvelope,
  parseToolResultManifestBytes,
  parseToolResultPageBytes,
  parseToolResultSealRequest,
  type ToolResultManifest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  parseToolPublicationBinding,
  toolPublicationManifestIdentity,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-publication.js';
import { parseManagedToolFileHistoryState } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import { validateTranscriptRecord } from '@qwen-code/qwen-code-core/utils/transcript-records.js';
import {
  encodeManagedContextBinding,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
import { parseHostedFileHistoryRecord } from './hosted-file-history-protocol.js';
import { readHostedApprovalDefinition } from './hosted-tool-approval.js';
import {
  isHostedWorkspaceProfile,
  isHostedWorkspaceShellProfile,
} from './hosted-workspace-profiles.js';

export interface RecoverySessionSource {
  readonly sessionId: string;
  readonly binding: ManagedContextBinding;
  readonly configRef: string;
  readonly policyRef: string;
  readonly approvalMode: string;
  readonly publicSession: {
    readonly version: number;
    readonly status: string;
    readonly lastSequence: number;
    readonly harnessBootId: string | null;
    readonly harnessEventEpoch: number;
    readonly harnessLastEventId: number;
    readonly deletedAt: number | null;
  };
  readonly creation: {
    readonly actorIdHex: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly turnId: string | null;
    readonly createdAt: number;
  };
  readonly retirement: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly generation: number;
    readonly retiredAt: number;
    readonly recoveryProtected: boolean;
  } | null;
  readonly head: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly state: string;
    readonly storageVersion: number;
    readonly writerId: string | null;
    readonly writerGeneration: number;
    readonly writerLeaseUntil: string | null;
    readonly journalRevision: number;
    readonly committedSequence: number;
    readonly lastCommitDigest: string | null;
    readonly activationEpoch: number;
    readonly latestCheckpointResourceId: string | null;
    readonly compactedThroughRevision: number;
    readonly recoveryStatus: string;
    readonly recoveryDetailCode: string | null;
  } | null;
}

export interface RecoveryPublicationReceipt {
  readonly publicationId: string;
  readonly binding: unknown;
  readonly terminalRef: ManagedSessionDurableRef;
  readonly outcomeRef: ManagedSessionDurableRef;
  readonly manifestRef: ManagedSessionDurableRef | null;
  readonly receiptSequence: number;
  readonly receiptRevision: number;
  readonly seals: ReadonlyArray<{
    readonly streamId: string;
    readonly segmentCount: number;
    readonly byteLength: number;
    readonly digest: string;
  }>;
}

export interface RecoverySessionIO {
  transactions(): AsyncIterable<StoredTransaction>;
  read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  enqueue(ref: ManagedSessionDurableRef): Promise<void>;
  nextReference(): Promise<ManagedSessionDurableRef | null>;
  completeReference(ref: ManagedSessionDurableRef): Promise<void>;
  publicationReceipt(request: {
    sessionId: string;
    executionCallId: string;
    sequence: number;
    outcomeRef: ManagedSessionDurableRef;
    manifestRef: ManagedSessionDurableRef | null;
  }): Promise<RecoveryPublicationReceipt>;
  publicationObject(request: {
    sessionId: string;
    publicationId: string;
    slotKey: string;
  }): Promise<{
    slotKey: string;
    resourceId: string | null;
    kind: string | null;
    byteLength: number;
    digest: string;
    bytesBase64: string;
  }>;
  verifyBackup(request: {
    ownerSessionId: string;
    filePath: string;
    backupFileName: string;
    version: number;
    backupTime: string;
  }): Promise<void>;
}

const DOMAINS = [
  'session_metadata',
  'file_history',
  'goal_state',
  'session_source',
];
const RESOURCE_KINDS = new Set([
  'managed-definition',
  'managed-root',
  'managed-input',
  'managed-admission',
  'managed-activation-install',
  'managed-activation-boundary',
  'managed-tool-input',
  'managed-tool-definition',
  'managed-tool-args',
  'managed-tool-outcome',
  'managed-action-options',
  'managed-action-decision',
  'managed-message',
  'managed-turn-result',
  'managed-compaction-summary',
  'managed-checkpoint',
  'managed-api-history',
  ...DOMAINS.map((domain) => `managed-${domain}`),
  ...Object.values(MANAGED_TOOL_RESULT_KINDS),
  'managed-tool-terminal',
  'managed-hosted-model-route',
  'managed-hosted-model-usage',
]);

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Workspace recovery: ${message}.`);
}

function object(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected a resource object',
  );
  return value as Record<string, unknown>;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.toString('base64') === value, 'invalid base64 bytes');
  return bytes;
}

function json(bytes: Buffer): ManagedSessionJsonValue {
  return parseManagedSessionRecordJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    bytes.length,
  );
}

function durableRef(value: unknown): ManagedSessionDurableRef {
  return assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'recovery resource',
  );
}

async function enqueueRefs(
  value: unknown,
  io: RecoverySessionIO,
): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) await enqueueRefs(item, io);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (
      ['resourceId', 'kind', 'schemaVersion', 'byteLength', 'digest'].every(
        (key) => Object.hasOwn(record, key),
      )
    ) {
      await io.enqueue(durableRef(record));
    } else {
      for (const item of Object.values(record)) await enqueueRefs(item, io);
    }
  }
}

function readerRecord(
  value: unknown,
  sessionId: string,
): Record<string, unknown> {
  const parsed = validateTranscriptRecord(value);
  const record = object(value);
  requireValue(
    parsed.record &&
      parsed.diagnostics.length === 0 &&
      parsed.record.sessionId === sessionId &&
      typeof record['cwd'] === 'string' &&
      typeof record['version'] === 'string' &&
      typeof record['timestamp'] === 'string',
    'invalid reader-facing record',
  );
  return record;
}

function settledCheckpoint(checkpoint: HarnessCheckpointV1): boolean {
  return (
    ['before_model', 'turn_settled'].includes(checkpoint.continuation.phase) &&
    checkpoint.continuation.pendingEventIds.length === 0 &&
    checkpoint.attempt?.outputState !== 'started' &&
    (checkpoint.tools?.items ?? []).every(
      (item) => item.state === 'settled' && item.consumed,
    ) &&
    (checkpoint.runtime?.bindings ?? []).every(
      (item) => item.state !== 'dispatch',
    ) &&
    checkpoint.approval === null &&
    checkpoint.followUp.pendingInputIds.length === 0 &&
    checkpoint.followUp.cancelRequestIds.length === 0 &&
    checkpoint.followUp.goalPermitIds.length === 0 &&
    checkpoint.followUp.cronIds.length === 0 &&
    checkpoint.followUp.notificationIds.length === 0 &&
    checkpoint.followUp.childRunIds.length === 0
  );
}

export async function verifyRecoverySession(
  source: RecoverySessionSource,
  io: RecoverySessionIO,
): Promise<{ fileHistory: 'captured' | 'not_captured' }> {
  encodeManagedContextBinding(source.binding);
  const head = source.head;
  const retirement = source.retirement;
  requireValue(
    retirement == null ||
      (retirement.tenantId === source.binding.tenantId &&
        retirement.sessionId === source.sessionId &&
        typeof retirement.operationId === 'string' &&
        retirement.operationId.length > 0 &&
        retirement.operationId.length <= 128 &&
        retirement.generation === 1 &&
        Number.isSafeInteger(retirement.retiredAt) &&
        retirement.retiredAt > 0 &&
        retirement.recoveryProtected === false &&
        source.publicSession.status === 'DELETED' &&
        Number.isSafeInteger(source.publicSession.deletedAt) &&
        Number(source.publicSession.deletedAt) > 0 &&
        (!head ||
          (head.state === 'DELETED' &&
            head.latestCheckpointResourceId === null &&
            head.writerId === null &&
            head.writerLeaseUntil === null))),
    'invalid pinned retirement',
  );
  let revision = 0;
  let sequence = 0;
  let commitDigest: string | null = null;
  let activationEpoch = 0;
  let latestCheckpoint: {
    id: string;
    ref: ManagedSessionDurableRef;
    boundary: unknown;
    state: HarnessCheckpointV1;
  } | null = null;
  let activeTurn: string | null = null;
  let hasContinuation = false;
  let lastWorkSequence = 0;
  let lastCheckpointSequence = 0;
  let hasHistory = false;
  const domains = new Map<
    string,
    { revision: number; ref: ManagedSessionDurableRef }
  >();
  let latestHistoryPending = false;
  const key = head && {
    tenantId: head.tenantId,
    workspaceId: head.workspaceId,
    sessionId: source.sessionId,
  };
  requireValue(
    !head ||
      (head.sessionId === source.sessionId &&
        head.tenantId === source.binding.tenantId &&
        head.storageVersion === 1 &&
        head.journalRevision >= 1 &&
        head.compactedThroughRevision === 0 &&
        head.recoveryStatus === 'READY'),
    'unsupported private journal head',
  );

  async function read(ref: ManagedSessionDurableRef): Promise<Buffer> {
    const validated = durableRef(ref);
    requireValue(
      validated.schemaVersion === 1 && RESOURCE_KINDS.has(validated.kind),
      'unsupported resource protocol',
    );
    await io.enqueue(validated);
    const bytes = await io.read(validated);
    requireValue(
      bytes.length === validated.byteLength &&
        digest(bytes) === validated.digest,
      'resource bytes conflict',
    );
    return bytes;
  }

  async function backups(value: unknown): Promise<void> {
    const state = parseManagedToolFileHistoryState({
      ownerSessionId: source.sessionId,
      revision: 0,
      snapshots: value,
    });
    hasHistory = true;
    for (const snapshot of state.snapshots) {
      for (const [filePath, backup] of Object.entries(
        snapshot.trackedFileBackups,
      )) {
        requireValue(!backup.failed, 'file history backup failed');
        if (backup.backupFileName !== null) {
          await io.verifyBackup({
            ownerSessionId: state.ownerSessionId,
            filePath,
            ...backup,
            backupFileName: backup.backupFileName,
          });
        }
      }
    }
  }

  async function domainBody(
    ref: ManagedSessionDurableRef,
  ): Promise<Record<string, unknown>> {
    const body = object(json(await read(ref)));
    requireValue(
      Number.isSafeInteger(body['revision']) &&
        (body['revision'] as number) > 0 &&
        typeof body['operationId'] === 'string',
      'invalid domain record',
    );
    if (body['previousRecordRef'] !== null) {
      const previousRef = durableRef(body['previousRecordRef']);
      requireValue(
        previousRef.kind === ref.kind,
        'domain predecessor kind conflicts',
      );
      const previous = object(json(await read(previousRef)));
      requireValue(
        previous['revision'] === (body['revision'] as number) - 1,
        'domain predecessor revision conflicts',
      );
    } else {
      requireValue(body['revision'] === 1, 'missing domain predecessor');
    }
    if (ref.kind === 'managed-session_metadata') {
      requireValue(
        typeof body['title'] === 'string' && body['title'].length > 0,
        'invalid session title',
      );
    } else {
      const record = readerRecord(body['record'], source.sessionId);
      const subtype =
        ref.kind === 'managed-file_history'
          ? 'file_history_snapshot'
          : ref.kind.slice('managed-'.length);
      requireValue(
        record['type'] === 'system' && record['subtype'] === subtype,
        'domain reader record conflicts',
      );
      if (ref.kind === 'managed-file_history') {
        const snapshots = object(record['systemPayload'])['snapshots'];
        await backups(snapshots);
        if ('state' in body) {
          const { state } = parseHostedFileHistoryRecord(
            body,
            source.sessionId,
          );
          requireValue(
            isDeepStrictEqual(state.snapshots, snapshots),
            'Hosted history snapshots conflict',
          );
        }
      }
    }
    await enqueueRefs(body, io);
    return body;
  }

  async function manifest(
    ref: ManagedSessionDurableRef,
    receipt?: RecoveryPublicationReceipt,
  ): Promise<ToolResultManifest> {
    requireValue(
      ref.kind === MANAGED_TOOL_RESULT_KINDS.manifest,
      'invalid manifest kind',
    );
    const parsed = parseToolResultManifestBytes(await read(ref));
    requireValue(
      parsed.tenantId === source.binding.tenantId &&
        parsed.sessionId === source.sessionId &&
        parsed.captureStatus === 'complete' &&
        parsed.captureScope === 'process_pipes' &&
        parsed.capturePolicy === 'complete_required' &&
        !parsed.upstreamTruncated &&
        parsed.contents.length === 2,
      'incomplete or foreign Shell capture',
    );
    if (receipt) {
      const pagedStreams = parsed.contents
        .filter((stream) => 'pages' in stream.body)
        .map((stream) => stream.streamId);
      requireValue(
        receipt.seals.length === pagedStreams.length &&
          receipt.seals.every((seal) => pagedStreams.includes(seal.streamId)),
        'original Shell capture seal ownership conflicts',
      );
    }
    for (const [streamIndex, stream] of parsed.contents.entries()) {
      requireValue(
        ['stdout', 'stderr'].includes(stream.streamId) &&
          stream.role === stream.streamId &&
          stream.state === 'sealed',
        'invalid Shell stream',
      );
      const hash = createHash('sha256');
      let count = 0;
      if ('ref' in stream.body) {
        hash.update(await read(stream.body.ref));
      } else {
        for (const [pageIndex, pageRef] of stream.body.pages.entries()) {
          const page = parseToolResultPageBytes(await read(pageRef.ref));
          requireValue(
            isToolResultPageAt(parsed, streamIndex, pageIndex, page),
            'Shell page position conflicts',
          );
          for (const [index, segment] of page.segments.entries()) {
            const ordinal = page.firstOrdinal + index;
            let bytes: Buffer;
            if (receipt) {
              const slotKey = `segment:${stream.streamId}:${ordinal}`;
              const stored = await io.publicationObject({
                sessionId: source.sessionId,
                publicationId: receipt.publicationId,
                slotKey,
              });
              bytes = decodeBase64(stored.bytesBase64);
              requireValue(
                stored.slotKey === slotKey &&
                  stored.kind === null &&
                  stored.resourceId === null &&
                  stored.byteLength === segment.byteLength &&
                  stored.digest === segment.digest,
                'original Shell segment metadata conflicts',
              );
            } else {
              bytes = await read({
                resourceId: digest(
                  Buffer.from(
                    JSON.stringify([
                      parsed.captureId,
                      stream.streamId,
                      ordinal,
                    ]),
                  ),
                ),
                kind: MANAGED_TOOL_RESULT_KINDS.content,
                schemaVersion: 1,
                ...segment,
              });
            }
            requireValue(
              bytes.length === segment.byteLength &&
                digest(bytes) === segment.digest,
              'Shell segment bytes conflict',
            );
            hash.update(bytes);
            count++;
          }
        }
        const seal = {
          segmentCount: count,
          byteLength: stream.byteLength,
          digest: stream.digest,
        };
        if (receipt) {
          requireValue(
            isDeepStrictEqual(
              receipt.seals.find((item) => item.streamId === stream.streamId),
              { streamId: stream.streamId, ...seal },
            ),
            'original Shell seal conflicts',
          );
        } else {
          const bytes = Buffer.from(JSON.stringify(seal));
          const stored = await read({
            resourceId: digest(
              Buffer.from(
                JSON.stringify([parsed.captureId, stream.streamId, 'seal']),
              ),
            ),
            kind: MANAGED_TOOL_RESULT_KINDS.content,
            schemaVersion: 1,
            byteLength: bytes.length,
            digest: digest(bytes),
          });
          parseToolResultSealRequest({
            captureId: parsed.captureId,
            streamId: stream.streamId,
            ...object(json(stored)),
          });
        }
      }
      requireValue(
        hash.digest('hex') === stream.digest,
        'full Shell stream digest conflicts',
      );
    }
    await io.completeReference(ref);
    return parsed;
  }

  async function toolReceipt(event: ManagedSessionEvent): Promise<void> {
    const outcomeRef = durableRef(event.payload['toolOutcomeRef']);
    requireValue(
      outcomeRef.kind === 'managed-tool-outcome',
      'invalid Shell outcome kind',
    );
    const outcome = object(json(await read(outcomeRef)));
    const envelope = parseToolResultEnvelope(outcome['envelope']);
    const manifestRef = envelope.capture?.manifest ?? null;
    requireValue(
      event.payload['historyRevision'] === event.sequence &&
        isDeepStrictEqual(event.payload['resultRef'], manifestRef) &&
        isDeepStrictEqual(
          event.payload['resources'],
          manifestRef ? [manifestRef] : [],
        ) &&
        ((envelope.executionStatus === 'not_started' &&
          envelope.capture === null) ||
          (outcome['decision'] === 'committed' &&
            envelope.capture?.captureStatus === 'complete') ||
          (outcome['decision'] === 'blocked' &&
            envelope.capture?.captureStatus === 'detached')),
      'unsettled or conflicting Shell receipt',
    );
    if (outcome['version'] === 1) {
      const identity = object(outcome['identity']);
      requireValue(
        identity['tenantId'] === source.binding.tenantId &&
          identity['sessionId'] === source.sessionId &&
          identity['executionCallId'] === event.payload['executionCallId'],
        'local Shell identity conflicts',
      );
      if (envelope.executionStatus === 'not_started') return;
      requireValue(manifestRef, 'local Shell receipt has no capture');
      const parsed = await manifest(manifestRef);
      requireValue(
        isToolResultEnvelopeOf(envelope, parsed),
        'local Shell envelope conflicts',
      );
      requireValue(
        isDeepStrictEqual(
          identity,
          Object.fromEntries(
            [
              'tenantId',
              'sessionId',
              'turnId',
              'executionCallId',
              'callId',
              'invocationDigest',
              'bindingGeneration',
              'captureId',
              'revision',
            ].map((field) => [
              field,
              parsed[field as keyof ToolResultManifest],
            ]),
          ),
        ),
        'local Shell identity conflicts',
      );
    } else {
      requireValue(
        outcome['schemaVersion'] === 1 &&
          isDeepStrictEqual(outcome['manifestRef'], manifestRef),
        'invalid original Shell outcome',
      );
      const history = object(outcome['history']);
      requireValue(
        typeof history['messageId'] === 'string' &&
          typeof history['timestamp'] === 'string' &&
          typeof history['model'] === 'string' &&
          Array.isArray(history['parts']),
        'invalid Shell reader history',
      );
      if (envelope.executionStatus === 'not_started') return;
      // A detached start handle owns no publication delivery: the durable
      // proof of its process is the child_run record, not a publication
      // receipt, so replay stops at the family check for it.
      if (envelope.capture?.captureStatus === 'detached') return;
      const receipt = await io.publicationReceipt({
        sessionId: source.sessionId,
        executionCallId: event.payload['executionCallId'] as string,
        sequence: event.sequence,
        outcomeRef,
        manifestRef,
      });
      const binding = parseToolPublicationBinding(receipt.binding);
      requireValue(
        receipt.publicationId === binding.publicationId &&
          key &&
          managedSessionKeysEqual(binding.sessionKey, key) &&
          binding.executionCallId === event.payload['executionCallId'] &&
          binding.intentSequence < event.sequence &&
          receipt.receiptSequence === event.sequence &&
          receipt.receiptRevision === revision &&
          isDeepStrictEqual(receipt.outcomeRef, outcomeRef) &&
          isDeepStrictEqual(receipt.manifestRef, manifestRef),
        'original publication receipt conflicts',
      );
      await enqueueRefs(binding, io);
      requireValue(
        receipt.terminalRef.kind === 'managed-tool-terminal',
        'invalid original terminal kind',
      );
      requireValue(
        isDeepStrictEqual(
          parseToolResultEnvelope(json(await read(receipt.terminalRef))),
          envelope,
        ),
        'original terminal outcome conflicts',
      );
      requireValue(manifestRef, 'original Shell capture lacks a manifest');
      const parsed = await manifest(manifestRef, receipt);
      requireValue(
        isToolResultEnvelopeOf(envelope, parsed) &&
          Object.entries(toolPublicationManifestIdentity(binding)).every(
            ([field, value]) =>
              parsed[field as keyof ToolResultManifest] === value,
          ),
        'original publication manifest identity conflicts',
      );
    }
  }

  for await (const raw of io.transactions()) {
    requireValue(head && key, 'journal exists without private head');
    const tx = parseStoredTransaction({ ...raw, recordEncoding: 'identity' });
    requireValue(
      tx.journalRevision === revision + 1 &&
        tx.journalRevision <= head.journalRevision &&
        tx.byteLength <= MANAGED_SESSION_LIMITS.maxTransactionBytes,
      'journal revisions or size conflict',
    );
    const bytes = decodeBase64(tx.recordBytesBase64);
    requireValue(
      bytes.length === tx.byteLength && digest(bytes) === tx.recordDigest,
      'transaction bytes conflict',
    );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    requireValue(text.endsWith('\n'), 'incomplete transaction JSONL');
    const records = text
      .slice(0, -1)
      .split('\n')
      .map((line) =>
        parseManagedSessionRecordJson(
          line,
          MANAGED_SESSION_LIMITS.maxEventBytes,
        ),
      );
    const descriptor = describeTransaction(
      records,
      bytes,
      activationEpoch,
      key,
    );
    requireStoredTransactionMatches(tx, descriptor);
    revision++;
    if (revision === 1) {
      requireValue(
        descriptor.operation === 'session.create',
        'missing genesis',
      );
      const header = parseManagedSessionHeader(
        object(records[1])['managedSession'],
      );
      requireValue(
        object(object(records[0])['systemPayload'])['engine'] === 'managed' &&
          header.definitionRef.kind === 'managed-definition' &&
          header.rootSnapshotRef.kind === 'managed-root',
        'invalid genesis',
      );
      const definition = object(json(await read(header.definitionRef)));
      // The /2 profiles are the same Hosted files/shell surfaces plus glob;
      // the W1b bundle doc puts Hosted files and Shell profiles inside the
      // capture closure, so one /2 Session must not abort recovery of the
      // whole shared storage.
      requireValue(
        definition['engine'] === 'managed' &&
          definition['sessionId'] === source.sessionId &&
          definition['mcpServers'] === undefined &&
          (definition['toolProfile'] === undefined ||
            isHostedWorkspaceProfile(definition['toolProfile'])),
        'unsupported Hosted profile',
      );
      requireValue(
        readHostedApprovalDefinition(definition) &&
          (definition['captureBytes'] === undefined ||
            (isHostedWorkspaceShellProfile(definition['toolProfile']) &&
              Number.isSafeInteger(definition['captureBytes']) &&
              (definition['captureBytes'] as number) >= 1 &&
              (definition['captureBytes'] as number) <= 2 ** 41)),
        'invalid frozen Hosted definition',
      );
      requireValue(
        typeof object(json(await read(header.rootSnapshotRef)))['cwd'] ===
          'string',
        'invalid root snapshot',
      );
      await enqueueRefs(header, io);
      continue;
    }
    requireValue(
      descriptor.operation !== 'session.create' &&
        descriptor.firstSequence === sequence + 1 &&
        descriptor.eventCount === records.length - 1 &&
        descriptor.eventCount <= MANAGED_SESSION_LIMITS.maxTransactionEvents &&
        descriptor.previousCommitDigest === commitDigest,
      'journal sequence or commit chain conflicts',
    );
    const events = records
      .slice(0, -1)
      .map((record) =>
        parseManagedSessionEvent(object(record)['managedSession']),
      );
    requireValue(
      descriptor.eventsDigest === managedSessionEventsDigest(events) &&
        descriptor.lastSequence === sequence + events.length,
      'commit marker content conflicts',
    );
    for (const event of events) {
      requireValue(
        event.sequence === sequence + 1,
        'noncontiguous event sequence',
      );
      if (event.kind === 'input.accepted') {
        requireValue(activeTurn === null, 'overlapping unresolved inputs');
        activeTurn = event.payload['turnId'] as string;
      } else if (event.kind === 'turn.settled') {
        requireValue(
          activeTurn === event.payload['turnId'],
          'turn settlement has no accepted input',
        );
        requireValue(
          event.payload['pendingOwnersRef'] === null,
          'turn has pending owners',
        );
        activeTurn = null;
      } else if (
        ['model.attempt', 'tool.intent', 'tool.receipt'].includes(event.kind)
      ) {
        hasContinuation = true;
        lastWorkSequence = event.sequence;
      }
      if (
        event.kind === 'action.changed' &&
        event.payload['state'] === 'requested'
      ) {
        hasContinuation = true;
        lastWorkSequence = event.sequence;
      }
      if (
        event.kind === 'message.committed' &&
        ['assistant', 'tool_result'].includes(event.payload['role'] as string)
      ) {
        hasContinuation = true;
        lastWorkSequence = event.sequence;
      }
      if (event.kind === 'domain.committed') {
        const domain = event.payload['domain'] as string;
        requireValue(DOMAINS.includes(domain), 'unsupported committed domain');
        const ref = durableRef(event.payload['recordRef']);
        requireValue(
          ref.kind === `managed-${domain}`,
          'domain reference kind conflicts',
        );
        const body = await domainBody(ref);
        const prior = domains.get(domain);
        requireValue(
          body['revision'] === (prior?.revision ?? 0) + 1 &&
            isDeepStrictEqual(body['previousRecordRef'], prior?.ref ?? null) &&
            body['operationId'] === event.payload['operationId'],
          'domain journal chain conflicts',
        );
        domains.set(domain, { revision: body['revision'] as number, ref });
        if (domain === 'file_history')
          latestHistoryPending =
            body['pendingTurn'] != null || body['pendingUndo'] != null;
      }
      if (event.kind === 'checkpoint.committed') {
        const ref = durableRef(event.payload['stateRef']);
        requireValue(
          ref.kind === 'managed-checkpoint' &&
            (event.payload['coveredSequence'] as number) <=
              tx.firstSequence - 1 &&
            event.payload['previousCheckpointId'] ===
              (latestCheckpoint?.id ?? null),
          'checkpoint coverage or predecessor conflicts',
        );
        const state = parseHarnessCheckpointV1(await read(ref));
        requireValue(
          managedSessionKeysEqual(state.identity.sessionKey, key) &&
            state.identity.checkpointId === event.payload['checkpointId'] &&
            state.identity.coveredSequence ===
              event.payload['coveredSequence'] &&
            state.identity.previousCheckpointId ===
              event.payload['previousCheckpointId'],
          'checkpoint identity conflicts',
        );
        latestCheckpoint = {
          id: state.identity.checkpointId,
          ref,
          boundary: event.payload['boundary'],
          state,
        };
        lastCheckpointSequence = event.sequence;
        await enqueueRefs(state, io);
        if (state.resume.fileHistoryRef) {
          const history = object(json(await read(state.resume.fileHistoryRef)));
          requireValue(
            history['ownerSessionId'] === source.sessionId,
            'checkpoint file history owner conflicts',
          );
          parseManagedToolFileHistoryState(history);
          await backups(history['snapshots']);
        }
      }
      if (event.kind === 'tool.receipt') await toolReceipt(event);
      const recordRef =
        event.kind === 'message.committed'
          ? event.payload['contentRef']
          : event.kind === 'turn.settled'
            ? event.payload['resultRef']
            : event.kind === 'context.compacted'
              ? event.payload['summaryRef']
              : null;
      if (recordRef) {
        const record = readerRecord(
          json(await read(durableRef(recordRef))),
          source.sessionId,
        );
        if (event.kind === 'message.committed')
          requireValue(
            record['uuid'] === event.payload['messageId'] &&
              record['type'] === event.payload['role'] &&
              record['parentUuid'] === event.payload['parentMessageId'],
            'message journal identity conflicts',
          );
        await enqueueRefs(record, io);
      }
      await enqueueRefs(event.payload, io);
      sequence = event.sequence;
    }
    activationEpoch = descriptor.activationEpoch;
    commitDigest = descriptor.commitDigest;
  }
  requireValue(
    !head ||
      (revision === head.journalRevision &&
        sequence === head.committedSequence &&
        commitDigest === head.lastCommitDigest &&
        activationEpoch === head.activationEpoch &&
        (retirement
          ? head.latestCheckpointResourceId === null
          : (latestCheckpoint?.ref.resourceId ?? null) ===
            head.latestCheckpointResourceId)),
    'journal does not match pinned private head',
  );
  requireValue(
    activeTurn === null &&
      !latestHistoryPending &&
      (latestCheckpoint
        ? (latestCheckpoint.boundary === HARNESS_TURN_COMPLETE_BOUNDARY ||
            (!hasContinuation &&
              latestCheckpoint.state.identity.turnId === null)) &&
          lastWorkSequence < lastCheckpointSequence &&
          settledCheckpoint(latestCheckpoint.state)
        : !hasContinuation),
    'cut has unfinished Harness work',
  );
  for (;;) {
    const ref = await io.nextReference();
    if (ref === null) break;
    const bytes = await read(ref);
    if (ref.kind === MANAGED_TOOL_RESULT_KINDS.manifest)
      throw new Error(
        'Workspace recovery: Shell manifest has no verified journal receipt.',
      );
    if (
      ref.kind.startsWith('managed-') &&
      DOMAINS.some((domain) => ref.kind === `managed-${domain}`)
    )
      await domainBody(ref);
    else if (ref.kind === 'managed-checkpoint') {
      const state = parseHarnessCheckpointV1(bytes);
      requireValue(
        key && managedSessionKeysEqual(state.identity.sessionKey, key),
        'checkpoint closure owner conflicts',
      );
      await enqueueRefs(state, io);
    } else if (ref.kind === 'managed-api-history') {
      const history = json(bytes);
      requireValue(Array.isArray(history), 'invalid API history');
      await enqueueRefs(history, io);
    } else if (ref.kind !== MANAGED_TOOL_RESULT_KINDS.content)
      await enqueueRefs(json(bytes), io);
    await io.completeReference(ref);
  }
  return { fileHistory: hasHistory ? 'captured' : 'not_captured' };
}

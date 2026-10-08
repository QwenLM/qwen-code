/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  describeTransaction,
  type StoredTransaction,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { createInitialHarnessCheckpoint } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { scanManagedSessionJournal } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import { ResourceToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  assertManagedSessionDurableRef,
  managedSessionEventsDigest,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  verifyRecoverySession,
  type RecoverySessionIO,
  type RecoverySessionSource,
} from './workspace-recovery-session.js';
import {
  createRecoveryRpc,
  runRecoveryWorker,
} from './workspace-recovery-worker.js';
import {
  recoveryDigest,
  type RecoveryRpc,
} from './workspace-recovery-bundle.js';

const SESSION = '6d629e8b-ceb2-4c98-9fa2-2b1a34777517';
const KEY = {
  tenantId: 'tenant',
  workspaceId: 'private-workspace',
  sessionId: SESSION,
};
const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function fixture(
  definition: Record<string, unknown> = {
    toolProfile: 'hosted-workspace-files/1',
  },
) {
  const resources = new Map<string, Buffer>();
  const refs = new Map<string, ManagedSessionDurableRef>();
  const complete = new Set<string>();
  const transactions: StoredTransaction[] = [];
  const source: Omit<RecoverySessionSource, 'head'> & {
    head: NonNullable<RecoverySessionSource['head']>;
  } = {
    sessionId: SESSION,
    binding: {
      tenantId: 'tenant',
      workspaceId: 'public-workspace',
      workspaceGeneration: '1',
      storageId: 'storage',
      cwdRelative: '.',
      contextConfigRef: 'config',
      contextRevision: '1',
    },
    configRef: 'config',
    policyRef: 'policy',
    approvalMode: 'default',
    retirement: null,
    publicSession: {
      version: 1,
      status: 'READY',
      lastSequence: 0,
      harnessBootId: null,
      harnessEventEpoch: 0,
      harnessLastEventId: 0,
      deletedAt: null,
    },
    creation: {
      actorIdHex: '01',
      idempotencyKey: 'created',
      requestDigest: 'a'.repeat(64),
      turnId: null,
      createdAt: 1,
    },
    head: {
      ...KEY,
      state: 'SEALED',
      storageVersion: 1,
      writerId: 'writer',
      writerGeneration: 1,
      writerLeaseUntil: null,
      journalRevision: 0,
      committedSequence: 0,
      lastCommitDigest: null,
      activationEpoch: 0,
      latestCheckpointResourceId: null,
      compactedThroughRevision: 0,
      recoveryStatus: 'READY',
      recoveryDetailCode: null,
    },
  };
  function resource(kind: string, value: unknown): ManagedSessionDurableRef {
    return publish(kind, Buffer.from(JSON.stringify(value)));
  }
  function publish(kind: string, bytes: Buffer): ManagedSessionDurableRef {
    const ref = {
      resourceId: `resource-${resources.size}`,
      kind,
      schemaVersion: 1,
      byteLength: bytes.length,
      digest: hash(bytes),
    };
    resources.set(ref.resourceId, bytes);
    return ref;
  }
  function tx(records: unknown[]) {
    const bytes = Buffer.from(
      records.map((value) => JSON.stringify(value)).join('\n') + '\n',
    );
    const descriptor = describeTransaction(
      records,
      bytes,
      source.head!.activationEpoch,
      KEY,
    );
    const { refs: _refs, ...metadata } = descriptor;
    const transaction: StoredTransaction = {
      ...metadata,
      journalRevision: transactions.length + 1,
      recordBytesBase64: bytes.toString('base64'),
      byteLength: bytes.length,
      recordDigest: hash(bytes),
    };
    transactions.push(transaction);
    source.head = {
      ...source.head!,
      journalRevision: transaction.journalRevision,
      committedSequence: transaction.lastSequence,
      lastCommitDigest: transaction.commitDigest,
      activationEpoch: transaction.activationEpoch,
      latestCheckpointResourceId:
        transaction.latestCheckpointResourceId ??
        source.head!.latestCheckpointResourceId,
    };
  }
  function event(
    kind: ManagedSessionEvent['kind'],
    payload: Record<string, unknown>,
  ): ManagedSessionEvent {
    return {
      v: 1,
      sequence: source.head!.committedSequence + 1,
      eventId: `event-${source.head!.committedSequence + 1}`,
      sessionKey: KEY,
      kind,
      occurredAt: 1,
      payload,
      ...(kind === 'checkpoint.committed' || kind === 'model.attempt'
        ? {
            subject: {
              type: 'activation',
              scopeId: 'activation',
              activationId: 'activation',
              epoch: 1,
            },
          }
        : {}),
    } as ManagedSessionEvent;
  }
  function append(events: ManagedSessionEvent[]) {
    const records = events.map((managedSession) => ({
      subtype: 'managed_session_event_v1',
      sessionId: SESSION,
      managedSession,
    }));
    tx([
      ...records,
      {
        subtype: 'managed_session_commit_v1',
        sessionId: SESSION,
        managedSession: {
          transactionId: `tx-${transactions.length}`,
          commandId: `command-${transactions.length}`,
          operation: 'test',
          contentDigest: 'a'.repeat(64),
          firstSequence: events[0].sequence,
          lastSequence: events.at(-1)!.sequence,
          eventCount: events.length,
          eventsDigest: managedSessionEventsDigest(events),
          previousCommitDigest: source.head!.lastCommitDigest,
        },
      },
    ]);
  }
  tx([
    {
      subtype: 'session_execution_engine',
      sessionId: SESSION,
      systemPayload: { version: 1, engine: 'managed' },
    },
    {
      subtype: 'managed_session_header_v1',
      sessionId: SESSION,
      managedSession: {
        formatVersion: 1,
        minimumReader: 'managed-session/1',
        sessionKey: KEY,
        engine: 'managed',
        definitionRef: resource('managed-definition', {
          engine: 'managed',
          sessionId: SESSION,
          ...definition,
        }),
        rootSnapshotRef: resource('managed-root', { cwd: '/original/cwd' }),
        createdBy: 'hosted-harness',
      },
    },
  ]);
  const io: RecoverySessionIO = {
    async *transactions() {
      yield* transactions;
    },
    read: vi.fn(async (ref) => {
      const bytes = resources.get(ref.resourceId);
      if (!bytes) throw new Error('missing_resource');
      return bytes;
    }),
    enqueue: async (ref) => {
      const prior = refs.get(ref.resourceId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(ref))
        throw new Error('reference_conflict');
      refs.set(ref.resourceId, ref);
    },
    nextReference: async () =>
      [...refs.values()].find((ref) => !complete.has(ref.resourceId)) ?? null,
    completeReference: async (ref) => {
      complete.add(ref.resourceId);
    },
    publicationReceipt: vi.fn(async () => {
      throw new Error('unexpected_publication');
    }),
    publicationObject: vi.fn(async () => {
      throw new Error('unexpected_object');
    }),
    verifyBackup: vi.fn(async () => {}),
  };
  const record = (subtype?: string, systemPayload?: unknown) => ({
    uuid: 'record-id',
    parentUuid: null,
    sessionId: SESSION,
    type: 'system',
    timestamp: '2026-10-01T00:00:00.000Z',
    cwd: '/original/cwd',
    version: 'hosted-harness/1',
    ...(subtype ? { subtype, systemPayload } : {}),
  });
  return {
    source,
    io,
    resources,
    transactions,
    resource,
    publish,
    event,
    append,
    record,
    complete,
    refs,
    tx,
  };
}

async function hostedModelFixture(
  settled = true,
  turn?: (session: ManagedSession) => Promise<void>,
) {
  const f = fixture();
  f.transactions.length = 0;
  const records: unknown[] = [];
  const session = await openManagedSession({
    runtimeBaseDir: '/unused',
    transcriptPath: '/unused',
    sessionId: SESSION,
    sessionKey: KEY,
    cwd: '/original/cwd',
    version: 'hosted-harness/1',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: f.resource('managed-definition', {
        engine: 'managed',
        sessionId: SESSION,
        toolProfile: 'hosted-workspace-files/1',
      }),
      rootSnapshotRef: f.resource('managed-root', { cwd: '/original/cwd' }),
      createdBy: 'hosted-harness',
    },
    resourceStore: {
      read: f.io.read,
      publish: async (kind, bytes) => f.publish(kind, bytes),
    },
    journalStore: {
      open: async () => ({
        sessionKey: KEY,
        read: async () =>
          scanManagedSessionJournal(
            Buffer.from(records.map((r) => JSON.stringify(r) + '\n').join('')),
            KEY,
          ),
        appendTransaction: async (batch) => {
          f.tx([...batch]);
          records.push(...batch);
        },
        seal: async () => {},
        abort: async () => {},
      }),
    },
  });
  try {
    await session.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'prompt',
        sessionKey: KEY,
        contentDigest: 'a'.repeat(64),
      },
      {
        inputId: 'prompt',
        turnId: 'prompt',
        source: 'hosted-harness',
        contentRef: f.resource('managed-input', 'prompt'),
        admissionRef: f.resource('managed-admission', { promptId: 'prompt' }),
        deadline: null,
        wakeReason: 'input',
      },
    );
    await createManagedHarnessHandle(session).run(async () => {
      await new ManagedHookActivationController(session).runTurn(
        'prompt',
        async (scope) => {
          const complete = await scope.beginMainAttempt('test-model');
          await complete(true, [{ totalTokenCount: 7 }]);
        },
      );
      if (turn) await turn(session);
      if (settled)
        await session.sink.write({
          uuid: 'turn-result',
          parentUuid: null,
          sessionId: SESSION,
          timestamp: '2026-10-02T00:00:00.000Z',
          cwd: '/original/cwd',
          version: 'hosted-harness/1',
          type: 'system',
          subtype: 'turn_result',
          systemPayload: { promptId: 'prompt', state: 'completed', endedAt: 1 },
        });
    });
  } finally {
    await session.close();
  }
  const attempts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'model.attempt');
  return {
    ...f,
    attempts,
    routeRef: assertManagedSessionDurableRef(
      attempts[0].payload['routeRef'],
      'routeRef',
    ),
    usageRef: assertManagedSessionDurableRef(
      attempts[1].payload['usageRef'],
      'usageRef',
    ),
  };
}

async function shellFixture(
  remote = false,
  directStreams: 'none' | 'stdout' | 'both' = 'none',
) {
  const f = fixture();
  const identity = {
    tenantId: 'tenant',
    sessionId: SESSION,
    turnId: 'prompt',
    executionCallId: 'execution',
    callId: 'call',
    invocationDigest: 'sha256:' + 'a'.repeat(64),
    bindingGeneration: '1',
    captureId: 'capture',
    revision: 1,
  };
  const store = new ResourceToolResultSegmentStore({
    read: f.io.read,
    async publish(kind, bytes, resourceId = `capture-${f.resources.size}`) {
      f.resources.set(resourceId, bytes);
      return {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: hash(bytes),
      };
    },
  });
  const capture = new LocalShellResultCapture(
    store,
    {
      publish: async (kind, bytes) => {
        const resourceId = `capture-${f.resources.size}`;
        f.resources.set(resourceId, bytes);
        return {
          resourceId,
          kind,
          schemaVersion: 1,
          byteLength: bytes.length,
          digest: hash(bytes),
        };
      },
      read: f.io.read,
    },
    identity,
  );
  capture.setStarted(1);
  const binary =
    directStreams === 'none'
      ? Buffer.from([0xff, 0, 0xa1, 0x41])
      : Buffer.alloc(2 * 1024 * 1024 + 1, 0x91);
  await capture.write('stdout', binary);
  await capture.finish('stdout', true);
  await capture.finish('stderr', true);
  capture.setProcessResult({
    rawOutput: binary,
    output: 'preview',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 1,
    executionMethod: 'child_process',
  });
  let envelope = await capture.finalize('success', [{ text: 'preview' }]);
  let manifestRef = envelope.capture!.manifest!;
  const originalManifest = parseToolResultManifestBytes(
    f.resources.get(manifestRef.resourceId)!,
  );
  if (directStreams !== 'none') {
    const contents = originalManifest.contents.map((stream) => {
      if (stream.streamId !== 'stdout' && directStreams !== 'both')
        return stream;
      const bytes = stream.streamId === 'stdout' ? binary : Buffer.alloc(0);
      const ref = {
        resourceId: `body-${stream.streamId}`,
        kind: 'managed-tool-result-content',
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: hash(bytes),
      };
      f.resources.set(ref.resourceId, bytes);
      return { ...stream, body: { ref } };
    });
    manifestRef = f.resource('managed-tool-result-manifest', {
      ...originalManifest,
      contents,
    });
    envelope = {
      ...envelope,
      capture: { ...envelope.capture!, manifest: manifestRef },
    };
  }
  const argsRef = f.resource('managed-tool-input', {
    toolName: 'run_shell_command',
    input: { command: 'command' },
  });
  f.append([
    f.event('input.accepted', {
      inputId: 'prompt',
      turnId: 'prompt',
      source: 'hosted-harness',
      contentRef: f.resource('managed-input', 'prompt'),
      admissionRef: f.resource('managed-admission', { promptId: 'prompt' }),
      deadline: null,
    }),
  ]);
  const initial = createInitialHarnessCheckpoint({
    sessionKey: KEY,
    checkpointId: 'initial',
    coveredSequence: 1,
    activationId: 'activation',
    turnId: null,
    promptId: null,
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: 'a'.repeat(64),
    previousCheckpointId: null,
  });
  const checkpointRef = f.resource('managed-checkpoint', initial);
  f.append([
    f.event('checkpoint.committed', {
      checkpointId: 'initial',
      coveredSequence: 1,
      previousCheckpointId: null,
      stateRef: checkpointRef,
      boundary: null,
    }),
  ]);
  const history = {
    messageId: 'shell-history',
    timestamp: '2026-10-01T00:00:00.000Z',
    model: 'model',
    parts: [{ text: 'preview' }],
  };
  const outcomeRef = f.resource(
    'managed-tool-outcome',
    remote
      ? {
          schemaVersion: 1,
          decision: 'committed',
          envelope,
          manifestRef,
          history,
        }
      : { version: 1, decision: 'committed', envelope, identity },
  );
  f.append([
    f.event('tool.receipt', {
      executionCallId: 'execution',
      toolOutcomeRef: outcomeRef,
      resultRef: manifestRef,
      resources: [manifestRef],
      historyRevision: 3,
    }),
  ]);
  const terminalRef = f.resource('managed-tool-terminal', envelope);
  const binding = {
    publication: 'managed-tool-publication/1',
    publicationId: 'publication',
    sessionKey: KEY,
    turnId: 'prompt',
    executionCallId: 'execution',
    modelCallId: 'model-call',
    runtimeBindingId: 'runtime-binding',
    reference: {
      sessionId: 'runtime',
      promptId: 'runtime',
      callId: 'call',
      argsDigest: identity.invocationDigest,
    },
    bindingGeneration: '1',
    captureId: 'capture',
    revision: 1,
    captureScope: 'process_pipes',
    capturePolicy: 'complete_required',
    argsRef,
    requestDigest: 'sha256:' + 'b'.repeat(64),
    writerId: 'writer',
    writerGeneration: 1,
    activationId: 'activation',
    activationEpoch: 1,
    intentSequence: 1,
    checkpointRef,
  };
  const seals = ['stdout', 'stderr']
    .filter(
      (streamId) =>
        directStreams !== 'both' &&
        !(directStreams === 'stdout' && streamId === 'stdout'),
    )
    .map((streamId) => ({
      streamId,
      segmentCount: streamId === 'stdout' ? 1 : 0,
      byteLength: streamId === 'stdout' ? binary.length : 0,
      digest: hash(streamId === 'stdout' ? binary : Buffer.alloc(0)),
    }));
  if (remote) {
    vi.mocked(f.io.publicationReceipt).mockResolvedValue({
      publicationId: 'publication',
      binding,
      terminalRef,
      outcomeRef,
      manifestRef,
      receiptSequence: 3,
      receiptRevision: 4,
      seals,
    });
    vi.mocked(f.io.publicationObject).mockImplementation(
      async ({ slotKey }) => ({
        slotKey,
        resourceId: null,
        kind: null,
        byteLength: binary.length,
        digest: hash(binary),
        bytesBase64: binary.toString('base64'),
      }),
    );
  }
  const state = createInitialHarnessCheckpoint({
    sessionKey: KEY,
    checkpointId: 'final',
    coveredSequence: 3,
    activationId: 'activation',
    turnId: 'prompt',
    promptId: 'prompt',
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: 'a'.repeat(64),
    previousCheckpointId: 'initial',
  });
  const settled = f.event('turn.settled', {
    turnId: 'prompt',
    outcome: 'completed',
    stopReason: null,
    resultRef: f.resource(
      'managed-turn-result',
      f.record('turn_result', { promptId: 'prompt', state: 'completed' }),
    ),
    usageRef: null,
    pendingOwnersRef: null,
  });
  const checkpoint = {
    ...f.event('checkpoint.committed', {
      checkpointId: 'final',
      coveredSequence: 3,
      previousCheckpointId: 'initial',
      stateRef: f.resource('managed-checkpoint', state),
      boundary: 'turn_complete',
    }),
    sequence: 5,
    eventId: 'final-checkpoint',
  };
  f.append([settled, checkpoint]);
  const localSegmentId = hash(
    Buffer.from(JSON.stringify(['capture', 'stdout', 0])),
  );
  const emptySealId = hash(
    Buffer.from(JSON.stringify(['capture', 'stderr', 'seal'])),
  );
  await store.close();
  return { ...f, localSegmentId, emptySealId, manifestRef, seals, binary };
}

async function detachedShellFixture(options: { partial?: boolean } = {}) {
  const f = fixture();
  const partial = options.partial === true;
  const manifestRef = partial
    ? f.resource('managed-tool-result-manifest', {
        toolResult: 'managed-tool-result/1',
        type: 'manifest',
        tenantId: 'tenant',
        sessionId: SESSION,
        turnId: 'prompt',
        executionCallId: 'execution',
        callId: 'call',
        invocationDigest: 'sha256:' + 'a'.repeat(64),
        bindingGeneration: '1',
        captureId: 'capture',
        revision: 1,
        executionStatus: 'error',
        exitCode: null,
        signal: null,
        captureScope: 'process_pipes',
        capturePolicy: 'complete_required',
        captureStatus: 'partial',
        captureReason: 'storage_failed',
        upstreamTruncated: false,
        contents: [
          {
            streamId: 'stdout',
            role: 'stdout',
            mimeType: 'application/octet-stream',
            state: 'incomplete',
            byteLength: 0,
            digest: hash(Buffer.alloc(0)),
            missingRanges: [{ start: 0, end: null }],
            body: { pages: [] },
          },
        ],
      })
    : null;
  const envelope = {
    executionStatus: partial ? ('error' as const) : ('success' as const),
    responseParts: [
      { text: 'Background shell started under unit qwen-bg-call.' },
    ],
    capture: partial
      ? {
          captureStatus: 'partial' as const,
          captureReason: 'storage_failed' as const,
          manifest: manifestRef,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        }
      : {
          captureStatus: 'detached' as const,
          captureReason: null,
          manifest: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
  };
  const history = {
    messageId: '123e4567-e89b-42d3-a456-426614174000',
    timestamp: '2026-10-01T00:00:00.000Z',
    model: 'model',
    parts: [{ text: 'Background shell started under unit qwen-bg-call.' }],
  };
  f.append([
    f.event('input.accepted', {
      inputId: 'prompt',
      turnId: 'prompt',
      source: 'hosted-harness',
      contentRef: f.resource('managed-input', 'prompt'),
      admissionRef: f.resource('managed-admission', { promptId: 'prompt' }),
      deadline: null,
    }),
  ]);
  const initial = createInitialHarnessCheckpoint({
    sessionKey: KEY,
    checkpointId: 'initial',
    coveredSequence: 1,
    activationId: 'activation',
    turnId: null,
    promptId: null,
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: 'a'.repeat(64),
    previousCheckpointId: null,
  });
  const checkpointRef = f.resource('managed-checkpoint', initial);
  f.append([
    f.event('checkpoint.committed', {
      checkpointId: 'initial',
      coveredSequence: 1,
      previousCheckpointId: null,
      stateRef: checkpointRef,
      boundary: null,
    }),
  ]);
  const outcomeRef = f.resource('managed-tool-outcome', {
    schemaVersion: 1,
    decision: 'blocked',
    envelope,
    manifestRef,
    history,
  });
  f.append([
    f.event('tool.receipt', {
      executionCallId: 'execution',
      toolOutcomeRef: outcomeRef,
      resultRef: manifestRef,
      resources: manifestRef ? [manifestRef] : [],
      historyRevision: 3,
    }),
  ]);
  const state = createInitialHarnessCheckpoint({
    sessionKey: KEY,
    checkpointId: 'final',
    coveredSequence: 3,
    activationId: 'activation',
    turnId: 'prompt',
    promptId: 'prompt',
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: 'a'.repeat(64),
    previousCheckpointId: 'initial',
  });
  const settled = f.event('turn.settled', {
    turnId: 'prompt',
    outcome: 'completed',
    stopReason: null,
    resultRef: f.resource(
      'managed-turn-result',
      f.record('turn_result', { promptId: 'prompt', state: 'completed' }),
    ),
    usageRef: null,
    pendingOwnersRef: null,
  });
  const checkpoint = {
    ...f.event('checkpoint.committed', {
      checkpointId: 'final',
      coveredSequence: 3,
      previousCheckpointId: 'initial',
      stateRef: f.resource('managed-checkpoint', state),
      boundary: 'turn_complete',
    }),
    sequence: 5,
    eventId: 'final-checkpoint',
  };
  f.append([settled, checkpoint]);
  return { ...f, outcomeRef };
}

function retiredFixture(turnId: string | null = null) {
  const f = fixture();
  f.append([
    f.event('domain.committed', {
      domain: 'session_metadata',
      version: 1,
      operationId: 'title',
      recordRef: f.resource('managed-session_metadata', {
        operationId: 'title',
        revision: 1,
        previousRecordRef: null,
        title: 'retained',
      }),
    }),
  ]);
  const state = createInitialHarnessCheckpoint({
    sessionKey: KEY,
    checkpointId: 'retained',
    coveredSequence: 1,
    activationId: 'activation',
    turnId,
    promptId: turnId,
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: 'a'.repeat(64),
    previousCheckpointId: null,
  });
  const checkpointRef = f.resource('managed-checkpoint', state);
  f.append([
    f.event('checkpoint.committed', {
      checkpointId: 'retained',
      coveredSequence: 1,
      previousCheckpointId: null,
      stateRef: checkpointRef,
      boundary: null,
    }),
  ]);
  f.source.head = {
    ...f.source.head,
    state: 'DELETED',
    writerId: null,
    writerLeaseUntil: null,
    latestCheckpointResourceId: null,
  };
  Object.assign(f.source.publicSession, { status: 'DELETED', deletedAt: 1 });
  Object.assign(f.source, {
    retirement: {
      tenantId: KEY.tenantId,
      sessionId: SESSION,
      operationId: 'delete',
      generation: 1,
      retiredAt: 2,
      recoveryProtected: false,
    },
  });
  return { ...f, checkpointRef };
}

const HISTORY_PROMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HISTORY_RECEIPT = {
  requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  promptId: HISTORY_PROMPT,
  filesChanged: ['absent.txt'],
  conflict: false,
};

function hostedHistoryFixture(
  fields: Record<string, unknown> = {},
  filePath = 'absent.txt',
) {
  const f = fixture();
  const snapshots = [
    {
      promptId: HISTORY_PROMPT,
      timestamp: '2026-10-01T00:00:00.000Z',
      trackedFileBackups: {
        [filePath]: {
          backupFileName: null,
          version: 0,
          backupTime: '2026-10-01T00:00:00.000Z',
        },
      },
    },
  ];
  const historyRef = f.resource('managed-file_history', {
    operationId: 'history',
    revision: 1,
    previousRecordRef: null,
    schemaVersion: 1,
    state: {
      ownerSessionId: SESSION,
      snapshots,
      files: { [filePath]: null },
    },
    pendingTurn: null,
    pendingUndo: null,
    undoReceipts: [{ ...HISTORY_RECEIPT, filesChanged: [filePath] }],
    ...fields,
    record: f.record('file_history_snapshot', { snapshots }),
  });
  f.append([
    f.event('domain.committed', {
      domain: 'file_history',
      version: 1,
      operationId: 'history',
      recordRef: historyRef,
    }),
  ]);
  return { ...f, historyRef };
}

describe('migration profile evidence', () => {
  it('refuses absolute Hosted history during migration', async () => {
    const f = hostedHistoryFixture({}, '/original/cwd/absent.txt');
    await expect(
      verifyRecoverySession(f.source, f.io, 'migration'),
    ).rejects.toThrow();
  });
  it.each([
    {},
    { toolProfile: 'hosted-workspace-files/2' },
    { toolProfile: 'hosted-workspace-shell/1' },
    { toolProfile: 'hosted-workspace-shell/2' },
    { toolProfile: 'hosted-workspace-files/1', hookCatalog: {} },
    { toolProfile: 'hosted-workspace-files/1', captureBytes: 1024 },
  ])('rejects unsupported frozen definition %j', async (definition) => {
    const f = fixture(definition);
    await expect(
      verifyRecoverySession(f.source, f.io, 'migration'),
    ).rejects.toThrow('unsupported migration profile');
  });
});

describe('verifyRecoverySession', () => {
  it.each([
    {},
    { undoReceipts: undefined },
    {
      undoReceipts: [
        HISTORY_RECEIPT,
        {
          ...HISTORY_RECEIPT,
          requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          filesChanged: [],
          conflict: true,
        },
      ],
    },
  ])('preserves valid and legacy Hosted undo history (%j)', async (fields) => {
    const f = hostedHistoryFixture(fields);
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'captured',
    });
    expect(f.io.read).toHaveBeenCalledWith(f.historyRef);
    expect(f.complete.size).toBe(f.refs.size);
    expect(f.io.verifyBackup).not.toHaveBeenCalled();
  });

  it.each([
    { undoReceipts: {} },
    { undoReceipts: null },
    { undoReceipts: [{ ...HISTORY_RECEIPT, requestId: 'invalid' }] },
    {
      undoReceipts: [
        {
          ...HISTORY_RECEIPT,
          promptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ],
    },
    { undoReceipts: [HISTORY_RECEIPT, HISTORY_RECEIPT] },
    { undoReceipts: [{ ...HISTORY_RECEIPT, filesChanged: ['untracked.txt'] }] },
    { undoReceipts: [{ ...HISTORY_RECEIPT, conflict: true }] },
    {
      undoReceipts: [
        { ...HISTORY_RECEIPT, filesChanged: ['absent.txt', 'absent.txt'] },
      ],
    },
    { undoReceipts: [{ ...HISTORY_RECEIPT, extra: true }] },
    { pendingMessageId: 42 },
    { pendingMessageId: 'message-without-turn' },
  ])('refuses Hosted records the live reader rejects (%j)', async (fields) => {
    const f = hostedHistoryFixture(fields);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      /Invalid Hosted file history/u,
    );
    expect(f.io.read).toHaveBeenCalledWith(f.historyRef);
    expect(f.complete.has(f.historyRef.resourceId)).toBe(false);
  });

  it('verifies retained settled checkpoint bytes after permanent retirement clears its pointer', async () => {
    const f = retiredFixture();
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.io.read).toHaveBeenCalledWith(f.checkpointRef);
    expect(f.complete.size).toBe(f.refs.size);
  });

  it('requires retirement evidence before accepting a cleared checkpoint pointer', async () => {
    const f = retiredFixture();
    Object.assign(f.source, { retirement: null });
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'pinned private head',
    );
  });

  it.each([
    { tenantId: 'foreign' },
    { sessionId: 'foreign' },
    { operationId: '' },
    { generation: 2 },
    { retiredAt: 1.5 },
    { recoveryProtected: true },
  ])('rejects unsupported retirement evidence (%j)', async (damage) => {
    const f = retiredFixture();
    Object.assign(f.source.retirement!, damage);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'invalid pinned retirement',
    );
  });

  it('rejects retirement without the public tombstone or with a remaining writer', async () => {
    const f = retiredFixture();
    Object.assign(f.source.publicSession, { status: 'CLOSED' });
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'invalid pinned retirement',
    );
    Object.assign(f.source.publicSession, { status: 'DELETED' });
    f.source.head = { ...f.source.head, writerId: 'remaining-writer' };
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'invalid pinned retirement',
    );
  });

  it('still rejects unfinished work and corrupt checkpoint bytes after retirement', async () => {
    const pending = retiredFixture('pending-turn');
    await expect(
      verifyRecoverySession(pending.source, pending.io),
    ).rejects.toThrow('unfinished Harness work');
    const corrupt = retiredFixture();
    corrupt.resources.set(corrupt.checkpointRef.resourceId, Buffer.from('{}'));
    await expect(
      verifyRecoverySession(corrupt.source, corrupt.io),
    ).rejects.toThrow('resource bytes conflict');
  });

  it('still rejects a changed watermark after retirement', async () => {
    const f = retiredFixture();
    f.source.head = {
      ...f.source.head,
      journalRevision: f.source.head.journalRevision + 1,
    };
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'pinned private head',
    );
  });
  it('verifies route and usage resources written by an actual Hosted model turn without Hooks', async () => {
    const f = await hostedModelFixture();
    expect(f.attempts.map((event) => event.payload['state'])).toEqual([
      'started',
      'output_committed',
    ]);
    expect(f.routeRef.kind).toBe('managed-hosted-model-route');
    expect(f.usageRef.kind).toBe('managed-hosted-model-usage');
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    for (const ref of [f.routeRef, f.usageRef]) {
      expect(f.io.read).toHaveBeenCalledWith(ref);
      expect(f.complete.has(ref.resourceId)).toBe(true);
    }
  });

  it.each(['routeRef', 'usageRef'] as const)(
    'refuses a missing or corrupted Hosted model %s',
    async (field) => {
      const missing = await hostedModelFixture();
      missing.resources.delete(missing[field].resourceId);
      await expect(
        verifyRecoverySession(missing.source, missing.io),
      ).rejects.toThrow('missing_resource');
      const corrupt = await hostedModelFixture();
      const bytes = Buffer.from(
        corrupt.resources.get(corrupt[field].resourceId)!,
      );
      bytes[0] ^= 1;
      corrupt.resources.set(corrupt[field].resourceId, bytes);
      await expect(
        verifyRecoverySession(corrupt.source, corrupt.io),
      ).rejects.toThrow('resource bytes conflict');
    },
  );

  it('still refuses an actual Hosted model turn without its settlement', async () => {
    const f = await hostedModelFixture(false);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'unfinished Harness work',
    );
  });

  it('verifies a settled turn whose assistant message is chunked past the inline limit', async () => {
    const text = '长'.repeat(70_000);
    const f = await hostedModelFixture(true, async (session) => {
      await session.sink.write({
        uuid: 'big-answer',
        parentUuid: null,
        sessionId: SESSION,
        timestamp: '2026-10-02T00:00:01.000Z',
        cwd: '/original/cwd',
        version: 'hosted-harness/1',
        type: 'assistant',
        message: { role: 'model', parts: [{ text }] },
      });
    });
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    // Manifest and parts were read and pinned through the reference closure.
    const kinds = [...f.refs.values()].map((ref) => ref.kind);
    expect(kinds).toContain('managed-message-chunks');
    expect(kinds).toContain('managed-message-part');
    const manifest = [...f.refs.values()].find(
      (ref) => ref.kind === 'managed-message-chunks',
    )!;
    const parts = (
      JSON.parse(f.resources.get(manifest.resourceId)!.toString('utf8')) as {
        parts: ManagedSessionDurableRef[];
      }
    ).parts;
    const reassembled = Buffer.concat(
      parts.map((part) => f.resources.get(part.resourceId)!),
    );
    const record = JSON.parse(reassembled.toString('utf8')) as {
      message?: { parts?: Array<{ text?: string }> };
    };
    expect(record.message?.parts?.[0]?.text).toBe(text);

    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'chunked-recovery-'),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = createRecoveryRpc(input, output);
    const sourceJson = JSON.stringify(f.source);
    const sourceDigest = recoveryDigest(sourceJson);
    const context = {
      protocol: 'workspace-recovery/1',
      mode: 'capture',
      request: {
        operationId: '00000000-0000-4000-8000-000000000001',
        tenantId: KEY.tenantId,
        storageId: f.source.binding.storageId,
        sourceRoot: join(root, 'source'),
        bundleRoot: join(root, 'bundle'),
        fileHistoryRoot: join(root, 'history'),
        fenceOperationId: '00000000-0000-4000-8000-000000000002',
        mountRevision: 2,
      },
      registration: {
        tenantId: KEY.tenantId,
        storageId: f.source.binding.storageId,
        mountRevision: 2,
      },
      sourceDigest: recoveryDigest(`${sourceJson}\n`),
      sessionCount: 1,
      capture: null as null | { operationId: string; manifestDigest: string },
    };
    const assets = new Map<string, unknown>();
    const authority: RecoveryRpc = async (method, value) => {
      const params = value as Record<string, unknown>;
      if (method === 'context') return context;
      if (method === 'sessions')
        return {
          sessions: [
            { sessionId: SESSION, source: f.source, sourceJson, sourceDigest },
          ],
          nextSessionId: null,
        };
      if (method === 'transaction')
        return {
          ...f.transactions[Number(params['revision']) - 1],
          recordEncoding: 'identity',
        };
      if (method === 'resource') {
        const ref = params['ref'] as ManagedSessionDurableRef;
        return { ref, bytesBase64: (await f.io.read(ref)).toString('base64') };
      }
      if (method === 'enqueueRef') {
        await f.io.enqueue(params['ref'] as ManagedSessionDurableRef);
        return {};
      }
      if (method === 'nextRef') return f.io.nextReference();
      if (method === 'completeRef') {
        await f.io.completeReference(params['ref'] as ManagedSessionDurableRef);
        return {};
      }
      if (method === 'asset') {
        assets.set(String(params['key']), params['metadata']);
        return params['metadata'];
      }
      if (method === 'assetLookup')
        return assets.get(String(params['key'])) ?? null;
      if (method === 'assetPage')
        return {
          assets: [...assets]
            .filter(([key]) => key > String(params['afterKey'] ?? ''))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, metadata]) => ({ key, metadata })),
          nextKey: null,
        };
      if (method === 'sessionComplete') return {};
      if (method === 'finish') return params;
      throw new Error(`Unexpected recovery RPC ${method}`);
    };
    output.on('data', (bytes: Buffer) => {
      const request = JSON.parse(bytes.toString()) as {
        id: number;
        method: string;
        params: unknown;
      };
      void authority(request.method, request.params).then(
        (result) =>
          input.write(`${JSON.stringify({ id: request.id, result })}\n`),
        (error: Error) =>
          input.write(
            `${JSON.stringify({ id: request.id, error: { code: error.message } })}\n`,
          ),
      );
    });
    try {
      for (const directory of [
        context.request.sourceRoot,
        context.request.bundleRoot,
        context.request.fileHistoryRoot,
        join(context.request.bundleRoot, 'workspace'),
      ])
        await mkdir(directory);
      f.complete.clear();
      const capture = (await runRecoveryWorker(rpc)) as {
        manifestDigest: string;
        result: { sessionCount: number; entries: number; assets: number };
      };
      context.capture = {
        operationId: context.request.operationId,
        manifestDigest: capture.manifestDigest,
      };
      context.mode = 'verify';
      f.complete.clear();
      const verify = (await runRecoveryWorker(rpc)) as typeof capture;
      expect(verify.manifestDigest).toBe(capture.manifestDigest);
      expect(verify.result).toEqual(capture.result);
    } finally {
      input.destroy();
      output.destroy();
      await rm(root, { recursive: true, force: true });
    }

    f.resources.delete(parts[1].resourceId);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'missing_resource',
    );
    f.resources.set(parts[1].resourceId, Buffer.alloc(parts[1].byteLength));
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'resource bytes conflict',
    );
  });

  it('distinguishes an absent head from a writer-created head without genesis', async () => {
    const f = fixture();
    f.transactions.length = 0;
    f.source.head = {
      ...f.source.head,
      state: 'ACTIVE',
      writerLeaseUntil: '2000-01-01T00:00:00',
      journalRevision: 0,
      committedSequence: 0,
      lastCommitDigest: null,
    };
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'unsupported private journal head',
    );
    await expect(
      verifyRecoverySession({ ...f.source, head: null }, f.io),
    ).resolves.toEqual({ fileHistory: 'not_captured' });
    expect(f.io.read).not.toHaveBeenCalled();
  });

  it('does not mistake a business resourceId argument for a durable reference', async () => {
    const f = fixture();
    f.append([
      f.event('message.committed', {
        messageId: 'record-id',
        role: 'system',
        parentMessageId: null,
        contentRef: f.resource(
          'managed-message',
          f.record('slash_command', { resourceId: 'business-id' }),
        ),
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.refs.has('business-id')).toBe(false);
  });

  it('refuses an unexplained referenced resource protocol', async () => {
    const f = fixture();
    const unknown = f.resource('managed-unknown-protocol', {});
    f.append([
      f.event('message.committed', {
        messageId: 'record-id',
        role: 'system',
        parentMessageId: null,
        contentRef: f.resource(
          'managed-message',
          f.record('slash_command', { unknown }),
        ),
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'unsupported resource protocol',
    );
  });

  it('streams transactions while verifying their resource closure before advancing', async () => {
    const f = fixture();
    let previousRecordRef: ManagedSessionDurableRef | null = null;
    for (let index = 0; index < 150; index++) {
      const recordRef = f.resource('managed-session_metadata', {
        operationId: `title-${index}`,
        revision: index + 1,
        previousRecordRef,
        title: `title-${index}`,
      });
      f.append([
        f.event('domain.committed', {
          domain: 'session_metadata',
          version: 1,
          operationId: `title-${index}`,
          recordRef,
        }),
      ]);
      previousRecordRef = recordRef;
    }
    f.io.transactions = async function* () {
      for (const tx of f.transactions) {
        yield tx;
        expect(f.io.read).toHaveBeenCalled();
        if (tx.journalRevision > 1) {
          const first = JSON.parse(
            Buffer.from(tx.recordBytesBase64, 'base64')
              .toString()
              .split('\n')[0],
          ) as {
            managedSession: {
              payload: { recordRef: ManagedSessionDurableRef };
            };
          };
          expect(f.io.read).toHaveBeenCalledWith(
            first.managedSession.payload.recordRef,
          );
        }
      }
    };
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
  });
  it('verifies local binary output and the original empty stderr seal', async () => {
    const f = await shellFixture();
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.io.read).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: f.emptySealId }),
    );
    const missing = await shellFixture();
    missing.resources.delete(missing.emptySealId);
    await expect(
      verifyRecoverySession(missing.source, missing.io),
    ).rejects.toThrow('missing_resource');
  });

  it('refuses corrupt local output bytes beyond the preview', async () => {
    const f = await shellFixture();
    f.resources.set(f.localSegmentId, Buffer.from([0xff, 0, 0xa1, 0x42]));
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'resource bytes conflict',
    );
  });

  it('verifies remote original publication bytes and requires both original seals', async () => {
    const f = await shellFixture(true);
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.io.publicationObject).toHaveBeenCalledWith({
      sessionId: SESSION,
      publicationId: 'publication',
      slotKey: 'segment:stdout:0',
    });
    const missing = await shellFixture(true);
    const receipt = await missing.io.publicationReceipt({
      sessionId: SESSION,
      executionCallId: 'execution',
      sequence: 3,
      outcomeRef: missing.manifestRef,
      manifestRef: missing.manifestRef,
    });
    vi.mocked(missing.io.publicationReceipt).mockResolvedValue({
      ...receipt,
      seals: receipt.seals.slice(0, 1),
    });
    await expect(
      verifyRecoverySession(missing.source, missing.io),
    ).rejects.toThrow('seal ownership conflicts');
  });

  it('accepts original O2 body.ref content above 2 MiB without SQL seals', async () => {
    const f = await shellFixture(true, 'both');
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.io.read).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'body-stdout',
        byteLength: 2 * 1024 * 1024 + 1,
      }),
    );
    expect(f.io.read).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'body-stderr', byteLength: 0 }),
    );
    expect(f.io.publicationObject).not.toHaveBeenCalled();
  });

  it('refuses corrupted original O2 body.ref bytes', async () => {
    const f = await shellFixture(true, 'both');
    const bytes = Buffer.from(f.binary);
    bytes[bytes.length - 1] ^= 1;
    f.resources.set('body-stdout', bytes);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'resource bytes conflict',
    );
  });

  it('requires the empty paged stderr seal when stdout uses body.ref', async () => {
    const f = await shellFixture(true, 'stdout');
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    const missing = await shellFixture(true, 'stdout');
    const receipt = await missing.io.publicationReceipt({
      sessionId: SESSION,
      executionCallId: 'execution',
      sequence: 3,
      outcomeRef: missing.manifestRef,
      manifestRef: missing.manifestRef,
    });
    vi.mocked(missing.io.publicationReceipt).mockResolvedValue({
      ...receipt,
      seals: [],
    });
    await expect(
      verifyRecoverySession(missing.source, missing.io),
    ).rejects.toThrow('seal ownership conflicts');
  });

  it('refuses unexplained seals for direct content and conflicting paged seals', async () => {
    const direct = await shellFixture(true, 'both');
    const receipt = await direct.io.publicationReceipt({
      sessionId: SESSION,
      executionCallId: 'execution',
      sequence: 3,
      outcomeRef: direct.manifestRef,
      manifestRef: direct.manifestRef,
    });
    vi.mocked(direct.io.publicationReceipt).mockResolvedValue({
      ...receipt,
      seals: [
        {
          streamId: 'stdout',
          segmentCount: 0,
          byteLength: direct.binary.length,
          digest: hash(direct.binary),
        },
      ],
    });
    await expect(
      verifyRecoverySession(direct.source, direct.io),
    ).rejects.toThrow('seal ownership conflicts');
    const paged = await shellFixture(true, 'stdout');
    const saved = await paged.io.publicationReceipt({
      sessionId: SESSION,
      executionCallId: 'execution',
      sequence: 3,
      outcomeRef: paged.manifestRef,
      manifestRef: paged.manifestRef,
    });
    vi.mocked(paged.io.publicationReceipt).mockResolvedValue({
      ...saved,
      seals: saved.seals.map((seal) => ({ ...seal, digest: 'a'.repeat(64) })),
    });
    await expect(verifyRecoverySession(paged.source, paged.io)).rejects.toThrow(
      'original Shell seal conflicts',
    );
  });

  it('refuses a remote receipt at a different original journal revision', async () => {
    const f = await shellFixture(true);
    const receipt = await f.io.publicationReceipt({
      sessionId: SESSION,
      executionCallId: 'execution',
      sequence: 3,
      outcomeRef: f.manifestRef,
      manifestRef: f.manifestRef,
    });
    vi.mocked(f.io.publicationReceipt).mockResolvedValue({
      ...receipt,
      receiptRevision: 5,
    });
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'original publication receipt conflicts',
    );
  });

  it('replays a detached background start handle like the not-started family', async () => {
    const f = await detachedShellFixture();
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.io.publicationReceipt).not.toHaveBeenCalled();
    expect(f.io.publicationObject).not.toHaveBeenCalled();
    expect(f.complete.size).toBe(f.refs.size);
  });

  it('keeps refusing a blocked partial or committed-free receipt', async () => {
    const partial = await detachedShellFixture({ partial: true });
    await expect(
      verifyRecoverySession(partial.source, partial.io),
    ).rejects.toThrow('unsettled or conflicting Shell receipt');
    const committedFree = await detachedShellFixture();
    committedFree.resources.delete(
      (committedFree.outcomeRef as { resourceId: string }).resourceId,
    );
    await expect(
      verifyRecoverySession(committedFree.source, committedFree.io),
    ).rejects.toThrow();
  });
  it('uses the actual private workspace key and verifies an initial journal', async () => {
    const f = fixture();
    expect(await verifyRecoverySession(f.source, f.io)).toEqual({
      fileHistory: 'not_captured',
    });
    expect(f.complete.size).toBe(f.refs.size);
    expect(f.io.publicationReceipt).not.toHaveBeenCalled();
  });

  it.each([
    { toolProfile: 'hosted-workspace-files/1' },
    { toolProfile: 'hosted-workspace-files/2' },
    { toolProfile: 'hosted-workspace-shell/1', captureBytes: 1024 },
    { toolProfile: 'hosted-workspace-shell/2', captureBytes: 1024 },
  ])('recovers every saved Workspace profile (%j)', async (definition) => {
    // One refused profile would abort recovery for the whole Workspace,
    // so recovery reads the same profile vocabulary creation persists.
    const f = fixture(definition);
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
  });

  it.each([
    { toolProfile: 'hosted-workspace-files/3' },
    { toolProfile: 'hosted-workspace-files/2', captureBytes: 1024 },
  ])('still refuses an unknown Hosted definition (%j)', async (definition) => {
    const f = fixture(definition);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      /unsupported Hosted profile|invalid frozen Hosted definition/u,
    );
  });

  it('rejects changed bytes even when the stored transaction metadata was not changed', async () => {
    const f = fixture();
    f.transactions[0] = {
      ...f.transactions[0],
      recordBytesBase64: Buffer.from('changed\n').toString('base64'),
    };
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'transaction bytes conflict',
    );
  });

  it('rejects a skipped journal revision and a truncated fixed cut', async () => {
    const f = fixture();
    f.transactions[0] = { ...f.transactions[0], journalRevision: 2 };
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'journal revisions',
    );
    f.transactions[0] = { ...f.transactions[0], journalRevision: 1 };
    f.source.head = { ...f.source.head!, journalRevision: 2 };
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'pinned private head',
    );
  });

  it('rejects a resource digest mismatch and conflicting same-ID metadata', async () => {
    const f = fixture();
    f.resources.set('resource-0', Buffer.from('{}'));
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'resource bytes conflict',
    );
    const other = fixture();
    await other.io.enqueue({
      resourceId: 'resource-0',
      kind: 'managed-root',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'a'.repeat(64),
    });
    await expect(verifyRecoverySession(other.source, other.io)).rejects.toThrow(
      'reference_conflict',
    );
  });

  it('refuses a runnable before_model checkpoint with an unresolved accepted input', async () => {
    const f = fixture();
    const inputRef = f.resource('managed-input', 'prompt');
    f.append([
      f.event('input.accepted', {
        inputId: 'turn',
        turnId: 'turn',
        source: 'hosted-harness',
        contentRef: inputRef,
        admissionRef: f.resource('managed-admission', { promptId: 'turn' }),
        deadline: null,
      }),
    ]);
    const state = createInitialHarnessCheckpoint({
      sessionKey: KEY,
      checkpointId: 'checkpoint',
      coveredSequence: 1,
      activationId: 'activation',
      turnId: null,
      promptId: null,
      definitionRevision: 'definition',
      configRevision: 'config',
      inputDigest: 'a'.repeat(64),
      previousCheckpointId: null,
    });
    f.append([
      f.event('checkpoint.committed', {
        checkpointId: 'checkpoint',
        coveredSequence: 1,
        previousCheckpointId: null,
        stateRef: f.resource('managed-checkpoint', state),
        boundary: null,
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'unfinished Harness work',
    );
  });

  it('accepts an initial before_model checkpoint without pending work', async () => {
    const f = fixture();
    f.append([
      f.event('domain.committed', {
        domain: 'session_metadata',
        version: 1,
        operationId: 'title',
        recordRef: f.resource('managed-session_metadata', {
          operationId: 'title',
          revision: 1,
          previousRecordRef: null,
          title: 'title',
        }),
      }),
    ]);
    const state = createInitialHarnessCheckpoint({
      sessionKey: KEY,
      checkpointId: 'checkpoint',
      coveredSequence: 1,
      activationId: 'activation',
      turnId: null,
      promptId: null,
      definitionRevision: 'definition',
      configRevision: 'config',
      inputDigest: 'a'.repeat(64),
      previousCheckpointId: null,
    });
    f.append([
      f.event('checkpoint.committed', {
        checkpointId: 'checkpoint',
        coveredSequence: 1,
        previousCheckpointId: null,
        stateRef: f.resource('managed-checkpoint', state),
        boundary: null,
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'not_captured',
    });
  });

  it('verifies every retained backup and preserves original-absence nulls', async () => {
    const f = fixture();
    const snapshots = [
      {
        promptId: 'prompt',
        timestamp: '2026-10-01T00:00:00.000Z',
        trackedFileBackups: {
          'existing.txt': {
            backupFileName: 'backup',
            version: 1,
            backupTime: '2026-10-01T00:00:00.000Z',
          },
          'new.txt': {
            backupFileName: null,
            version: 0,
            backupTime: '2026-10-01T00:00:00.000Z',
          },
        },
      },
    ];
    const ref = f.resource('managed-file_history', {
      operationId: 'history',
      revision: 1,
      previousRecordRef: null,
      record: f.record('file_history_snapshot', { snapshots }),
    });
    f.append([
      f.event('domain.committed', {
        domain: 'file_history',
        version: 1,
        operationId: 'history',
        recordRef: ref,
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).resolves.toEqual({
      fileHistory: 'captured',
    });
    expect(f.io.verifyBackup).toHaveBeenCalledWith({
      ownerSessionId: SESSION,
      filePath: 'existing.txt',
      backupFileName: 'backup',
      version: 1,
      backupTime: '2026-10-01T00:00:00.000Z',
    });
    expect(
      vi
        .mocked(f.io.verifyBackup)
        .mock.calls.every(([request]) => request.backupFileName !== null),
    ).toBe(true);
    vi.mocked(f.io.verifyBackup).mockRejectedValue(new Error('missing_backup'));
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'missing_backup',
    );
  });

  it('rejects unsupported committed domains and broken domain predecessors', async () => {
    const f = fixture();
    f.append([
      f.event('domain.committed', {
        domain: 'mcp_configuration',
        version: 1,
        operationId: 'mcp',
        recordRef: f.resource('managed-mcp_configuration', {}),
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'unsupported committed domain',
    );
    const other = fixture();
    other.append([
      other.event('domain.committed', {
        domain: 'session_metadata',
        version: 1,
        operationId: 'title',
        recordRef: other.resource('managed-session_metadata', {
          operationId: 'title',
          revision: 2,
          previousRecordRef: null,
          title: 'title',
        }),
      }),
    ]);
    await expect(verifyRecoverySession(other.source, other.io)).rejects.toThrow(
      'missing domain predecessor',
    );
  });

  it('rejects a pending Hosted history undo and a foreign reader record', async () => {
    const f = fixture();
    f.append([
      f.event('domain.committed', {
        domain: 'file_history',
        version: 1,
        operationId: 'history',
        recordRef: f.resource('managed-file_history', {
          operationId: 'history',
          revision: 1,
          previousRecordRef: null,
          schemaVersion: 1,
          state: { ownerSessionId: SESSION, snapshots: [], files: {} },
          pendingTurn: null,
          pendingUndo: { requestId: 'undo', promptId: 'prompt' },
          record: f.record('file_history_snapshot', { snapshots: [] }),
        }),
      }),
    ]);
    await expect(verifyRecoverySession(f.source, f.io)).rejects.toThrow(
      'unfinished Harness work',
    );
    const other = fixture();
    other.append([
      other.event('message.committed', {
        messageId: 'record-id',
        role: 'system',
        parentMessageId: null,
        contentRef: other.resource('managed-message', {
          ...other.record('slash_command', {}),
          sessionId: 'wrong',
        }),
      }),
    ]);
    await expect(verifyRecoverySession(other.source, other.io)).rejects.toThrow(
      'invalid reader-facing record',
    );
  });
});

describe('migration profile eligibility', () => {
  it('accepts settled files and refuses an uninitialized retained member', async () => {
    const f = fixture();
    await expect(
      verifyRecoverySession(f.source, f.io, 'migration'),
    ).resolves.toBeDefined();
    await expect(
      verifyRecoverySession({ ...f.source, head: null }, f.io, 'migration'),
    ).rejects.toThrow('uninitialized migration member');
  });
});

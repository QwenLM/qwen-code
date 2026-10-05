/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';
import { ManagedShellResultSession } from './managed-shell-result-session.js';
import { createManagedHarnessHandle } from './managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import { resetManagedRuntimeDispatchGatesForTest } from './managed-runtime-dispatch-gate.js';
import { scanManagedSessionJournal } from './managed-session-storage.js';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import { inspectOriginalReceiptCheckpointCoverage } from './original-receipt-checkpoint.js';
import { parseToolPublicationBinding } from './managed-tool-publication.js';

const cleanup: Array<() => Promise<void>> = [];
const key = { tenantId: 't', workspaceId: 'w', sessionId: 'checkpoint-test' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  resetManagedRuntimeDispatchGatesForTest();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(batch = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-coverage-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    runtimeBaseDir,
    'chats',
    `${key.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey: key,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from('{}'),
  );
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId: key.sessionId,
    transcriptPath,
  });
  cleanup.push(() => lease.release());
  const session = await openManagedSession({
    runtimeBaseDir,
    transcriptPath,
    sessionId: key.sessionId,
    sessionKey: key,
    cwd: root,
    version: 'test',
    workerId: 'owner',
    activationLeaseDurationMs: 300000,
    lease,
    resourceStore: resources,
    create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
  });
  cleanup.push(async () => {
    await session.close();
    await session.releaseActivation();
    await session.authority.close();
  });
  const segments = await LocalToolResultSegmentStore.openWritable({
    lease,
    sessionKey: key,
  });
  cleanup.push(() => segments.close());
  const harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  const args = { command: 'inert fixture' };
  const argsRef = await resources.publish(
    'managed-tool-input',
    Buffer.from(JSON.stringify(args)),
  );
  const toolDefinitionRef = await resources.publish(
    'managed-tool-definition',
    Buffer.from('{}'),
  );
  const argsDigest = managedToolDigest(args);
  await session.authority.appendExecutionEvent(
    {
      operation: 'recordToolIntent',
      commandId: 'intent',
      sessionKey: key,
      contentDigest: argsDigest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'intent',
      sessionKey: key,
      kind: 'tool.intent',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: session.activation.activationId,
        ...session.activation,
      },
      payload: {
        executionCallId: 'execution',
        batchId: 'batch',
        ordinal: 0,
        toolDefinitionRef,
        argsRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation: session.activation },
  );
  const intentSequence = session.authority.committedSequence;
  const call = {
    functionCallId: 'call',
    toolName: 'run_shell_command',
    executionCallId: 'execution',
    invocationBindingId: 'call',
    capabilityVersion: 'cap',
    policyVersion: 'policy',
    mediaVersion: null,
    modelMessageId: 'model-message',
    partIndex: 0,
    ordinal: 0,
    inputDigest: argsDigest,
    progressCursor: null,
    attemptId: 'attempt',
    routeRef: await resources.publish('managed-route', Buffer.from('{}')),
  };
  await harness.commitAwaitRuntimeBatch(
    batch
      ? [
          call,
          {
            ...call,
            functionCallId: 'call-2',
            executionCallId: 'execution-2',
            invocationBindingId: 'call-2',
            ordinal: 1,
          },
        ]
      : [call],
    { turnId: 'turn', promptId: 'prompt' },
  );
  const shell = new ManagedShellResultSession(
    session,
    segments,
    '19',
    () => lease.assertOwnedAndUnchanged(),
    'runtime-session',
  );
  const capture = await shell.prepare({
    reference: {
      sessionId: 'runtime-session',
      promptId: 'prompt',
      callId: 'call',
      argsDigest: `sha256:${argsDigest}`,
    },
    capture: {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: 'turn',
      executionCallId: 'execution',
      bindingGeneration: '19',
      capturePolicy: 'complete_required',
    },
  });
  capture.sink.setStarted(42);
  await capture.sink.finish('stdout', true);
  await capture.sink.finish('stderr', true);
  capture.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 42,
    executionMethod: 'child_process',
  });
  const envelope = await capture.sink.finalize('success', []);
  const dispatchRef = session.authority.latestCheckpoint!.stateRef;
  const binding = parseToolPublicationBinding({
    publication: 'managed-tool-publication/1',
    publicationId: 'publication',
    sessionKey: key,
    turnId: 'turn',
    executionCallId: 'execution',
    modelCallId: 'call',
    runtimeBindingId: 'java-binding',
    reference: {
      sessionId: 'runtime-session',
      promptId: 'prompt',
      callId: 'call',
      argsDigest: `sha256:${argsDigest}`,
    },
    bindingGeneration: '19',
    captureId: capture.identity.captureId,
    revision: 1,
    captureScope: 'process_pipes',
    capturePolicy: 'complete_required',
    argsRef,
    requestDigest: `sha256:${'1'.repeat(64)}`,
    writerId: 'writer',
    writerGeneration: 1,
    activationId: session.activation.activationId,
    activationEpoch: session.activation.epoch,
    intentSequence,
    checkpointRef: dispatchRef,
  });
  const receipt = await shell.accept(capture.identity, envelope);
  async function snapshot() {
    return snapshotOf(session, resources, transcriptPath, {
      publicationId: binding.publicationId,
      binding,
      receiptSequence: receipt.historyRevision!,
      outcomeRef: receipt.outcomeRef,
      manifestRef: receipt.manifest!,
    });
  }
  return { session, harness, resources, receipt, snapshot };
}

interface Original {
  publicationId: string;
  binding: ReturnType<typeof parseToolPublicationBinding>;
  receiptSequence: number;
  outcomeRef: ManagedSessionDurableRef;
  manifestRef: ManagedSessionDurableRef;
}

async function snapshotOf(
  session: ManagedSession,
  resources: LocalManagedSessionResourceStore,
  transcriptPath: string,
  original: Original,
) {
  const records = (await fs.readFile(transcriptPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const batches = [records.slice(0, 2)];
  let pending = [];
  for (const record of records.slice(2)) {
    pending.push(record);
    if (record.subtype === 'managed_session_commit_v1') {
      batches.push(pending);
      pending = [];
    }
  }
  const stored = new Map<
    string,
    {
      ref: ManagedSessionDurableRef;
      bytesBase64: string;
      referencedRevisions: number[];
    }
  >();
  let epoch = 0;
  let latest: string | null = null;
  const transactions = [];
  for (const [index, batch] of batches.entries()) {
    const bytes = Buffer.from(
      batch.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const marker = index === 0 ? null : batch.at(-1)!.managedSession;
    for (const record of batch) {
      if (record.managedSession?.kind === 'activation.changed')
        epoch = record.managedSession.payload.epoch;
      if (record.managedSession?.kind === 'checkpoint.committed')
        latest = record.managedSession.payload.stateRef.resourceId;
    }
    transactions.push({
      journalRevision: index + 1,
      recordEncoding: 'identity',
      recordBytesBase64: bytes.toString('base64'),
      byteLength: bytes.length,
      recordDigest: sha(bytes),
      activationEpoch: epoch,
      transactionId: marker?.transactionId ?? `session.create:${key.sessionId}`,
      operation: marker?.operation ?? 'session.create',
      commandId: marker?.commandId ?? `session.create:${key.sessionId}`,
      contentDigest: marker?.contentDigest ?? sha(bytes),
      firstSequence: marker?.firstSequence ?? 0,
      lastSequence: marker?.lastSequence ?? 0,
      eventCount: marker?.eventCount ?? 0,
      eventsDigest: marker?.eventsDigest ?? null,
      previousCommitDigest: marker?.previousCommitDigest ?? null,
      commitDigest: marker ? managedToolDigest(marker) : null,
      latestCheckpointResourceId: batch.some(
        (record) => record.managedSession?.kind === 'checkpoint.committed',
      )
        ? latest
        : null,
    });
    const pending: unknown[] = [...batch];
    const seen = new Set<string>();
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        pending.push(...value);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      if (Object.hasOwn(row, 'resourceId') && Object.hasOwn(row, 'digest')) {
        const ref = assertManagedSessionDurableRef(
          row as ManagedSessionJsonValue,
          'test ref',
        );
        if (seen.has(ref.resourceId)) continue;
        seen.add(ref.resourceId);
        const bytes = await resources.read(ref);
        const entry = stored.get(ref.resourceId) ?? {
          ref,
          bytesBase64: bytes.toString('base64'),
          referencedRevisions: [],
        };
        entry.referencedRevisions.push(index + 1);
        stored.set(ref.resourceId, entry);
        if (ref.kind === 'managed-checkpoint')
          pending.push(parseHarnessCheckpointV1(bytes));
      } else pending.push(...Object.values(row));
    }
  }
  const scan = scanManagedSessionJournal(
    Buffer.concat(
      batches.map((batch) =>
        Buffer.from(
          batch.map((record) => JSON.stringify(record)).join('\n') + '\n',
        ),
      ),
    ),
    key,
  );
  return {
    format: 'qwen-csi-receipt-checkpoint-snapshot/1',
    sessionKey: key,
    originalCSI: { bindingId: 'java-binding', runtimeGeneration: '19' },
    original: {
      ...original,
      receiptRevision: transactions.find(
        (tx) => tx.lastSequence === original.receiptSequence,
      )!.journalRevision,
    },
    head: {
      state: 'ACTIVE',
      storageVersion: 1,
      writerGeneration: 1,
      journalRevision: transactions.length,
      committedSequence: scan.committed,
      lastCommitDigest: scan.lastMarkerDigest,
      activationEpoch: epoch,
      latestCheckpointResourceId: latest,
      compactedThroughRevision: 0,
      recoveryStatus: 'READY',
      recoveryDetailCode: null,
    },
    transactions,
    resources: [...stored.values()],
  };
}

describe('original receipt checkpoint observation', () => {
  it('permits already committed dependencies without repeating their reference revision', async () => {
    const f = await fixture();
    await f.harness.resolveAwaitRuntime(
      f.receipt.executionCallId,
      f.receipt.outcomeRef,
    );
    const snapshot = await f.snapshot();
    const outcome = snapshot.resources.find(
      (row) => row.ref.resourceId === f.receipt.outcomeRef.resourceId,
    )!;
    outcome.referencedRevisions = [snapshot.original.receiptRevision];
    expect(
      await inspectOriginalReceiptCheckpointCoverage(snapshot),
    ).toMatchObject({ status: 'matched' });
  });

  it.each(['unconsumed', 'pending-batch', 'later-intent', 'later-consume'])(
    'refuses a real turn-complete with %s predecessor',
    async (state) => {
      const f = await fixture();
      await f.harness.resolveAwaitRuntime(
        f.receipt.executionCallId,
        f.receipt.outcomeRef,
      );
      if (state === 'pending-batch') {
        await f.harness.consumeRuntimeResults();
        await f.harness.settleConsumedRuntimeContinuation();
        const prior = parseHarnessCheckpointV1(
          (await f.session.authority.readCheckpointState())!,
        );
        await f.session.authority.commitCheckpoint(
          {
            operation: 'testPendingCheckpoint',
            commandId: 'pending',
            sessionKey: key,
            contentDigest: '2'.repeat(64),
          },
          {
            boundary: null,
            state: encodeHarnessCheckpointV1({
              ...prior,
              tools: {
                batchId: 'batch',
                items: [
                  ...prior.tools!.items,
                  {
                    ...prior.tools!.items[0],
                    functionCallId: 'other-call',
                    executionCallId: 'other-execution',
                    ordinal: 1,
                    state: 'not_started',
                    outcomeRef: null,
                    consumed: false,
                  },
                ],
              },
            }),
          },
          { class: 'harness', activation: f.session.activation },
        );
      }
      if (state === 'later-intent' || state === 'later-consume') {
        if (state === 'later-intent') {
          await f.harness.consumeRuntimeResults();
          await f.harness.settleConsumedRuntimeContinuation();
        }
        const argsRef = await f.resources.publish(
          'managed-tool-input',
          Buffer.from('{}'),
        );
        const toolDefinitionRef = await f.resources.publish(
          'managed-tool-definition',
          Buffer.from('{}'),
        );
        await f.session.authority.appendExecutionEvent(
          {
            operation: 'recordToolIntent',
            commandId: 'later-intent',
            sessionKey: key,
            contentDigest: argsRef.digest,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: 'later-intent',
            sessionKey: key,
            kind: 'tool.intent',
            occurredAt: Date.now(),
            subject: {
              type: 'activation',
              scopeId: f.session.activation.activationId,
              ...f.session.activation,
            },
            payload: {
              executionCallId: 'later-execution',
              batchId: 'later-batch',
              ordinal: 0,
              toolDefinitionRef,
              argsRef,
              outcomeSource: 'runtime',
            },
          }),
          { class: 'harness', activation: f.session.activation },
        );
        if (state === 'later-consume') {
          await f.harness.consumeRuntimeResults();
          expect(
            await inspectOriginalReceiptCheckpointCoverage(await f.snapshot()),
          ).toEqual({
            status: 'unresolved',
            reason: 'checkpoint_unrepresented_tool_work',
          });
          await f.harness.settleConsumedRuntimeContinuation();
          expect(
            await inspectOriginalReceiptCheckpointCoverage(await f.snapshot()),
          ).toEqual({
            status: 'unresolved',
            reason: 'checkpoint_unrepresented_tool_work',
          });
        }
      }
      const resultRef = await f.resources.publish(
        'managed-turn-result',
        Buffer.from('{}'),
      );
      await f.session.authority.commitTurnComplete(
        {
          operation: 'settleTurn',
          commandId: 'turn-done',
          sessionKey: key,
          contentDigest: '1'.repeat(64),
        },
        {
          turn: {
            turnId: 'turn',
            outcome: 'completed',
            stopReason: 'end_turn',
            resultRef,
            occurredAt: Date.now(),
            eventId: 'turn-done',
          },
          boundary: 'turn_complete',
          state: (identity, previous) =>
            encodeHarnessCheckpointV1(
              createNextTurnReadyHarnessCheckpoint({
                previous,
                ...identity,
                activationId: f.session.activation.activationId,
                turnId: 'turn',
                promptId: 'prompt',
              }),
            ),
        },
        { class: 'harness', activation: f.session.activation },
      );
      expect(await f.session.authority.harnessRunAuthorization()).toMatchObject(
        { status: 'runnable' },
      );
      expect(
        await inspectOriginalReceiptCheckpointCoverage(await f.snapshot()),
      ).toEqual({
        status: 'unresolved',
        reason: state.startsWith('later-')
          ? 'checkpoint_unrepresented_tool_work'
          : 'turn_complete_consumed_history_not_qualified',
      });
    },
  );
  it('rejects the real receipt-only window and matches original results_ready without writer acquisition', async () => {
    const f = await fixture();
    const acquire = vi.spyOn(LocalManagedSessionAuthority, 'acquireWriter');
    const stale = await f.snapshot();
    expect(await inspectOriginalReceiptCheckpointCoverage(stale)).toEqual({
      status: 'unresolved',
      reason: 'receipt_not_covered',
    });
    await f.harness.resolveAwaitRuntime(
      f.receipt.executionCallId,
      f.receipt.outcomeRef,
    );
    const snapshot = await f.snapshot();
    const before = JSON.stringify(snapshot);
    expect(
      await inspectOriginalReceiptCheckpointCoverage(snapshot),
    ).toMatchObject({
      status: 'matched',
      phase: 'results_ready',
      receiptSequence: 5,
    });
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(acquire).not.toHaveBeenCalled();
    const reader = readOnlyManagedSessionSnapshot(snapshot);
    await expect(
      reader.journal.seal({
        lastCommitSequence: 0,
        committedPrefixHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('cannot write');
    await expect(
      reader.resources.publish('anything', Buffer.alloc(0)),
    ).rejects.toThrow('cannot write');
  });

  it('rejects an unfinished real batch after one receipt is covered', async () => {
    const f = await fixture(true);
    await f.harness.resolveAwaitRuntime(
      f.receipt.executionCallId,
      f.receipt.outcomeRef,
    );
    expect(
      await inspectOriginalReceiptCheckpointCoverage(await f.snapshot()),
    ).toMatchObject({ status: 'unresolved' });
  });

  it('requires consumption evidence before accepting atomic turn-complete companions', async () => {
    const f = await fixture();
    await f.harness.resolveAwaitRuntime(
      f.receipt.executionCallId,
      f.receipt.outcomeRef,
    );
    await f.harness.consumeRuntimeResults();
    await f.harness.settleConsumedRuntimeContinuation();
    expect(
      await inspectOriginalReceiptCheckpointCoverage(await f.snapshot()),
    ).toMatchObject({ status: 'matched', phase: 'turn_settled' });
    const covered = f.session.authority.committedSequence;
    const resultRef = await f.resources.publish(
      'managed-turn-result',
      Buffer.from('{}'),
    );
    await f.session.authority.commitTurnComplete(
      {
        operation: 'settleTurn',
        commandId: 'turn-done',
        sessionKey: key,
        contentDigest: '1'.repeat(64),
      },
      {
        turn: {
          turnId: 'turn',
          outcome: 'completed',
          stopReason: 'end_turn',
          resultRef,
          occurredAt: Date.now(),
          eventId: 'turn-done',
        },
        boundary: 'turn_complete',
        state: (identity, previous) =>
          encodeHarnessCheckpointV1(
            createNextTurnReadyHarnessCheckpoint({
              previous,
              ...identity,
              activationId: f.session.activation.activationId,
              turnId: 'turn',
              promptId: 'prompt',
            }),
          ),
      },
      { class: 'harness', activation: f.session.activation },
    );
    expect(
      await inspectOriginalReceiptCheckpointCoverage(await f.snapshot()),
    ).toMatchObject({
      status: 'matched',
      phase: 'before_model',
      coveredSequence: covered,
      committedSequence: covered + 2,
    });
  });

  const mutations = {
    truncated: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      s.transactions.pop(),
    revision: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      s.transactions[2].journalRevision++,
    descriptor: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.transactions[2].commandId = 'another'),
    missingResource: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      s.resources.pop(),
    resourceBytes: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.resources[0].bytesBase64 = Buffer.from('changed').toString('base64')),
    references: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      s.resources[0].referencedRevisions.pop(),
    checkpointPointer: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.head.latestCheckpointResourceId = 'another'),
    blockedRecovery: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.head.recoveryStatus = 'BLOCKED_RESOURCE'),
    compaction: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.head.compactedThroughRevision = 1),
    receiptSequence: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      s.original.receiptSequence++,
    receiptRevision: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      s.original.receiptRevision++,
    outcome: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.original.outcomeRef = s.original.manifestRef),
    activation: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.original.binding = { ...s.original.binding, activationId: 'another' }),
    csiBinding: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.originalCSI.bindingId = 'another'),
    runtimeCall: (s: Awaited<ReturnType<typeof snapshotOf>>) =>
      (s.original.binding = {
        ...s.original.binding,
        reference: { ...s.original.binding.reference, callId: 'java-binding' },
      }),
  };
  it.each(Object.entries(mutations))(
    'refuses %s without modifying the snapshot',
    async (_name, mutate) => {
      const f = await fixture();
      await f.harness.resolveAwaitRuntime(
        f.receipt.executionCallId,
        f.receipt.outcomeRef,
      );
      const snapshot = await f.snapshot();
      mutate(snapshot);
      const before = JSON.stringify(snapshot);
      expect(
        await inspectOriginalReceiptCheckpointCoverage(snapshot),
      ).toMatchObject({ status: 'unresolved' });
      expect(JSON.stringify(snapshot)).toBe(before);
    },
  );
});

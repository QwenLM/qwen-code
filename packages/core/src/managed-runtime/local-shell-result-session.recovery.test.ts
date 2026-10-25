/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { createManagedHarnessHandle } from './managed-harness-factory.js';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from './managed-runtime-dispatch-gate.js';
import {
  ManagedShellResultSession,
  type LocalShellCaptureRequest,
} from './managed-shell-result-session.js';
import {
  ResourceToolResultSegmentStore,
  type DurableToolResultResourceStore,
} from './resource-tool-result-store.js';
import type { ToolResultEnvelope } from './managed-tool-result.js';

const fixtures: Array<{
  root: string;
  session: ManagedSession;
  lease: SessionWriterLease;
  leaseReleased: boolean;
}> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.session.close();
    if (!fixture.leaseReleased) {
      await fixture.session.releaseActivation();
      await fixture.session.authority.close();
      await fixture.lease.release();
    } else {
      await fixture.session.authority.close().catch(() => undefined);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
  resetManagedRuntimeDispatchGatesForTest();
});

async function fixture(
  options: { complete?: boolean; foreignIntent?: boolean } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'shell-recovery-receipt-'));
  const runtimeBaseDir = path.join(root, 'runtime');
  await mkdir(runtimeBaseDir);
  const transcriptPath = path.join(runtimeBaseDir, 'session.jsonl');
  const key = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: randomUUID(),
  };
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId: key.sessionId,
    transcriptPath,
  });
  const native = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey: key,
  });
  const session = await openManagedSession({
    runtimeBaseDir,
    transcriptPath,
    sessionId: key.sessionId,
    sessionKey: key,
    cwd: root,
    version: 'test',
    workerId: 'worker-a',
    activationLeaseDurationMs: 60_000,
    lease,
    create: {
      definitionRef: await native.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await native.publish('managed-root', Buffer.from('{}')),
      createdBy: 'test',
    },
  });
  const cleanup = { root, session, lease, leaseReleased: false };
  fixtures.push(cleanup);
  const harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  const input = { command: 'printf hello', is_background: false };
  const argsDigest = managedToolDigest(input);
  const promptId = 'prompt-a';
  const executionCallId = 'execution-a';
  const modelCallId = 'model-call-a';
  const workerCallId = 'worker-call-a';
  const argsRef = await native.publish(
    'managed-tool-args',
    Buffer.from(JSON.stringify(input)),
  );
  const definitionRef = await native.publish(
    'managed-tool-definition',
    Buffer.from('{}'),
  );
  await session.authority.appendExecutionEvent(
    {
      operation: 'toolIntent',
      commandId: 'intent-a',
      sessionKey: key,
      contentDigest: argsRef.digest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'intent-a',
      sessionKey: key,
      kind: 'tool.intent',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: session.activation.activationId,
        ...session.activation,
      },
      payload: {
        executionCallId: options.foreignIntent
          ? 'foreign-execution'
          : executionCallId,
        batchId: 'batch-a',
        ordinal: 0,
        toolDefinitionRef: definitionRef,
        argsRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation: session.activation },
  );
  await harness.commitAwaitRuntimeBatch(
    [
      {
        functionCallId: modelCallId,
        toolName: 'run_shell_command',
        executionCallId,
        invocationBindingId: workerCallId,
        capabilityVersion: 'cap-a',
        policyVersion: 'policy-a',
        mediaVersion: null,
        modelMessageId: 'model-a',
        partIndex: 0,
        ordinal: 0,
        inputDigest: argsDigest,
        progressCursor: null,
        attemptId: 'attempt-a',
        routeRef: await native.publish('managed-route', Buffer.from('{}')),
      },
    ],
    { turnId: promptId, promptId },
  );
  const captureRoot = path.join(root, 'captured-resources');
  await mkdir(captureRoot);
  const durable: DurableToolResultResourceStore = {
    async publish(kind, bytes, resourceId = randomUUID()) {
      const ref = {
        kind,
        resourceId,
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
      const file = path.join(captureRoot, resourceId);
      try {
        await writeFile(file, bytes, { flag: 'wx' });
      } catch {
        if (!(await readFile(file)).equals(bytes))
          throw new Error('Resource conflict.');
      }
      return ref;
    },
    read(ref) {
      return readFile(path.join(captureRoot, ref.resourceId));
    },
  };
  const request: LocalShellCaptureRequest = {
    reference: {
      sessionId: promptId,
      promptId,
      callId: workerCallId,
      argsDigest: `sha256:${argsDigest}`,
    },
    capture: {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: promptId,
      executionCallId,
      bindingGeneration: '1',
      capturePolicy: 'complete_required',
    },
  };
  const createAdmission = (store: ResourceToolResultSegmentStore) =>
    new ManagedShellResultSession(
      session,
      store,
      '1',
      () => lease.assertOwnedAndUnchanged(),
      promptId,
      durable,
    );
  const producerStore = new ResourceToolResultSegmentStore(durable);
  let candidate: ToolResultEnvelope = {
    executionStatus: 'cancelled',
    responseParts: [{ text: 'original preview' }],
    error: { message: 'Cancelled output is unavailable.' },
    capture: {
      captureStatus: 'unavailable',
      captureReason: 'producer_lost',
      manifest: null,
      previewTruncated: true,
      deliveryStatus: 'blocked',
    },
  };
  let identity:
    | Awaited<ReturnType<ManagedShellResultSession['prepare']>>['identity']
    | undefined;
  if (options.complete) {
    const prepared = await createAdmission(producerStore).prepare(
      request,
      modelCallId,
    );
    identity = prepared.identity;
    prepared.sink.setStarted(42);
    await prepared.sink.write('stdout', Buffer.from('hello'));
    await prepared.sink.finish('stdout', true);
    await prepared.sink.finish('stderr', true);
    prepared.sink.setProcessResult({
      rawOutput: Buffer.from('hello'),
      output: 'hello',
      exitCode: null,
      signal: 15,
      error: null,
      aborted: true,
      pid: 42,
      executionMethod: 'child_process',
    });
    const complete = await prepared.sink.finalize('cancelled', [
      { text: 'hello' },
    ]);
    expect(complete.capture?.captureStatus).toBe('complete');
    candidate = {
      ...complete,
      capture: { ...complete.capture!, deliveryStatus: 'blocked' },
    };
  }
  await producerStore.close();
  const originalActivation = session.activation;
  await session.replaceActivation();
  expect(session.activation.activationId).not.toBe(
    originalActivation.activationId,
  );
  expect(session.activation.epoch).toBeGreaterThan(originalActivation.epoch);
  const authorization = await session.authority.harnessRunAuthorization();
  expect(authorization.status).toBe('runnable');
  if (authorization.status === 'runnable')
    expect(authorization.checkpoint.identity.activationId).toBe(
      originalActivation.activationId,
    );
  const freshStore = new ResourceToolResultSegmentStore(durable);
  const admission = createAdmission(freshStore);
  const receipts = () =>
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter(
        (e) =>
          e.kind === 'tool.receipt' &&
          e.payload['executionCallId'] === executionCallId,
      );
  return {
    root,
    session,
    lease,
    cleanup,
    key,
    transcriptPath,
    native,
    durable,
    captureRoot,
    request,
    modelCallId,
    candidate,
    freshStore,
    admission,
    receipts,
    identity,
    createAdmission,
  };
}

it('recovers a null-manifest cancellation under a new activation without relaxing ordinary prepare', async () => {
  const f = await fixture();
  await expect(f.admission.prepare(f.request, f.modelCallId)).rejects.toThrow(
    /not committed/,
  );
  const receipt = await f.admission.acceptRecoveredCancelled(
    f.request,
    f.modelCallId,
    f.candidate,
  );
  expect(receipt).toMatchObject({
    executionCallId: 'execution-a',
    manifest: null,
    deliveryStatus: 'blocked',
    historyRevision: null,
  });
  const saved = JSON.parse(
    (await f.session.resources.read(receipt.outcomeRef)).toString(),
  );
  expect(saved).toMatchObject({
    version: 1,
    decision: 'blocked',
    identity: {
      sessionId: f.key.sessionId,
      turnId: 'prompt-a',
      executionCallId: 'execution-a',
      callId: 'worker-call-a',
      bindingGeneration: '1',
    },
    envelope: {
      executionStatus: 'cancelled',
      capture: {
        captureStatus: 'unavailable',
        captureReason: 'producer_lost',
        manifest: null,
      },
    },
  });
  const journal = await LocalJsonlManagedSessionJournalStore.read(
    f.transcriptPath,
    f.key,
  );
  expect(journal.events.filter((e) => e.kind === 'tool.receipt')).toHaveLength(
    1,
  );
  expect(f.receipts()[0].payload['toolOutcomeRef']).toEqual(receipt.outcomeRef);
  await f.freshStore.close();
});

it('admits a real complete manifest through a fresh store, verifying nonempty stdout and empty stderr seals', async () => {
  const f = await fixture({ complete: true });
  const range = vi.spyOn(f.freshStore, 'readRange');
  const receipt = await f.admission.acceptRecoveredCancelled(
    f.request,
    f.modelCallId,
    f.candidate,
  );
  expect(receipt.manifest).toEqual(f.candidate.capture!.manifest);
  expect(receipt.deliveryStatus).toBe('committed');
  expect(range.mock.calls).toContainEqual([
    expect.objectContaining({ streamId: 'stdout', offset: 0, length: 5 }),
  ]);
  expect(range.mock.calls).toContainEqual([
    expect.objectContaining({ streamId: 'stderr', offset: 0, length: 0 }),
  ]);
  const read = await f.freshStore.readRange({
    manifestRef: receipt.manifest!,
    expectedIdentity: f.identity!,
    streamId: 'stdout',
    offset: 0,
    length: 5,
  });
  expect(read).toEqual({ status: 'ok', result: Buffer.from('hello') });
  expect(f.receipts()).toHaveLength(1);
  await f.freshStore.close();
});

it.each([
  'corrupt stdout',
  'missing stdout seal',
  'missing empty stderr seal',
] as const)('refuses %s without a cancellation receipt', async (fault) => {
  const f = await fixture({ complete: true });
  const identity = f.identity!;
  const resourceId = (stream: string, ordinal: number | 'seal') =>
    createHash('sha256')
      .update(JSON.stringify([identity.captureId, stream, ordinal]))
      .digest('hex');
  if (fault === 'corrupt stdout')
    await writeFile(
      path.join(f.captureRoot, resourceId('stdout', 0)),
      Buffer.from('wrong'),
    );
  else
    await rm(
      path.join(
        f.captureRoot,
        resourceId(
          fault === 'missing empty stderr seal' ? 'stderr' : 'stdout',
          'seal',
        ),
      ),
    );
  await expect(
    f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, f.candidate),
  ).rejects.toThrow();
  expect(f.receipts()).toHaveLength(0);
  await f.freshStore.close();
});

it('refuses a correctly stored manifest naming a foreign Turn', async () => {
  const f = await fixture({ complete: true });
  const manifest = JSON.parse(
    (await f.durable.read(f.candidate.capture!.manifest!)).toString(),
  );
  const foreign = await f.durable.publish(
    'managed-tool-result-manifest',
    Buffer.from(JSON.stringify({ ...manifest, turnId: 'foreign-turn' })),
  );
  await expect(
    f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, {
      ...f.candidate,
      capture: { ...f.candidate.capture!, manifest: foreign },
    }),
  ).rejects.toThrow(/bind the original/);
  expect(f.receipts()).toHaveLength(0);
  await f.freshStore.close();
});

it('refuses an intent belonging to a different execution', async () => {
  const f = await fixture({ foreignIntent: true });
  await expect(
    f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, f.candidate),
  ).rejects.toThrow(/intent is missing/);
  expect(f.receipts()).toHaveLength(0);
  await f.freshStore.close();
});

it('refuses after the actual current writer lease is released', async () => {
  const f = await fixture();
  await f.lease.release();
  f.cleanup.leaseReleased = true;
  await expect(
    f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, f.candidate),
  ).rejects.toThrow();
  expect(f.receipts()).toHaveLength(0);
  await f.freshStore.close();
});

it('refuses a released current activation even when the original intent is valid', async () => {
  const f = await fixture();
  await f.session.releaseActivation();
  await expect(
    f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, f.candidate),
  ).rejects.toThrow(/no longer writable/);
  expect(f.receipts()).toHaveLength(0);
  await f.freshStore.close();
});

it('returns the original durable receipt on a lost-reply retry without rewriting it', async () => {
  const f = await fixture();
  const receipt = await f.admission.acceptRecoveredCancelled(
    f.request,
    f.modelCallId,
    f.candidate,
  );
  const saved = await f.session.resources.read(receipt.outcomeRef);
  const publish = vi.spyOn(f.session.resources, 'publish');
  const publishCapture = vi.spyOn(f.durable, 'publish');
  const committed = f.session.authority.committedSequence;
  await f.freshStore.close();
  const fresh = new ResourceToolResultSegmentStore(f.durable);
  const restored = f.createAdmission(fresh);
  expect(
    await restored.acceptRecoveredCancelled(
      f.request,
      f.modelCallId,
      undefined,
    ),
  ).toEqual(receipt);
  expect(f.session.authority.committedSequence).toBe(committed);
  expect(f.receipts()).toHaveLength(1);
  expect(await f.session.resources.read(receipt.outcomeRef)).toEqual(saved);
  expect(publish).not.toHaveBeenCalled();
  expect(publishCapture).not.toHaveBeenCalled();
  await fresh.close();
});

it.each(['success', 'error'] as const)(
  'refuses a recovered %s result without producing a cancellation receipt',
  async (executionStatus) => {
    const f = await fixture();
    await expect(
      f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, {
        ...f.candidate,
        executionStatus,
      }),
    ).rejects.toThrow('not a blocked cancellation');
    expect(f.receipts()).toHaveLength(0);
    await f.freshStore.close();
  },
);

it('refuses an unacknowledged recovered result without producing a cancellation receipt', async () => {
  const f = await fixture();
  await expect(
    f.admission.acceptRecoveredCancelled(f.request, f.modelCallId, {
      ...f.candidate,
      capture: { ...f.candidate.capture!, deliveryStatus: 'pending' },
    }),
  ).rejects.toThrow('not a blocked cancellation');
  expect(f.receipts()).toHaveLength(0);
  await f.freshStore.close();
});

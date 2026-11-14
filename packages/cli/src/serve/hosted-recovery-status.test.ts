/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  inspectHostedRecovery,
  type HostedRecoverySession,
} from './hosted-recovery-status.js';
import { oweHostedTurnCleanup } from './hosted-turn-cleanup.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(checkpoint = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-recovery-status-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const managed = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    workerId: 'test',
    version: 'test',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  cleanups.push(() => managed.close());
  const session: HostedRecoverySession = {
    managed,
    blocked: false,
    mcpRecovering: 0,
  };
  const submit = async (promptId = randomUUID()) => {
    const content = Buffer.from('[]');
    await managed.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: promptId,
        sessionKey,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      },
      {
        inputId: promptId,
        turnId: promptId,
        source: 'hosted-harness',
        contentRef: await managed.resources.publish('managed-input', content),
        admissionRef: await managed.resources.publish(
          'managed-admission',
          Buffer.from('{}'),
        ),
        deadline: null,
        wakeReason: 'input',
      },
    );
    return promptId;
  };
  const promptId = await submit();
  if (checkpoint) await createManagedHarnessHandle(managed).ensureRunnable();
  const terminal = () =>
    managed.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'turn_result',
      cwd: root,
      version: 'test',
      systemPayload: {
        promptId,
        state: 'cancelled',
        stopReason: 'cancelled',
        endedAt: Date.now(),
      },
    });
  return { session, managed, promptId, submit, terminal };
}

it.each([false, true])(
  'proves next-turn readiness from committed terminal (checkpoint=%s)',
  async (checkpoint) => {
    const f = await fixture(checkpoint);
    expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
      inputSettled: false,
      continuationReady: false,
      nextTurnAllowed: false,
    });
    await f.terminal();
    const sequence = f.managed.authority.committedSequence;
    expect(await inspectHostedRecovery(f.session, f.promptId)).toEqual({
      state: 'ready',
      reasonCode: null,
      promptId: f.promptId,
      inputSettled: true,
      continuationReady: true,
      nextTurnAllowed: true,
    });
    expect(f.managed.authority.committedSequence).toBe(sequence);
  },
);

it('does not let an old settled input admit work over a newer input', async () => {
  const f = await fixture(true);
  await f.terminal();
  await f.submit();
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'awaiting_evidence',
    reasonCode: 'inputs_unsettled',
    inputSettled: true,
    continuationReady: false,
    nextTurnAllowed: false,
  });
});

it('does not mistake an old clean checkpoint for a terminal companion', async () => {
  const f = await fixture(true);
  const activation = f.managed.activation;
  const resultRef = await f.managed.resources.publish(
    'managed-turn-result',
    Buffer.from(
      JSON.stringify({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: f.managed.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'turn_result',
        cwd: '/tmp',
        version: 'test',
        systemPayload: {
          promptId: f.promptId,
          state: 'error',
          stopReason: 'error',
          endedAt: Date.now(),
        },
      }),
    ),
  );
  await f.managed.authority.appendExecutionEvent(
    {
      operation: 'settleTurn',
      commandId: randomUUID(),
      sessionKey: f.managed.authority.sessionHeader.sessionKey,
      contentDigest: resultRef.digest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: `turn:${f.promptId}`,
      sessionKey: f.managed.authority.sessionHeader.sessionKey,
      kind: 'turn.settled',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: activation.activationId,
        ...activation,
      },
      payload: {
        turnId: f.promptId,
        outcome: 'error',
        stopReason: 'error',
        resultRef,
        usageRef: null,
        pendingOwnersRef: null,
      },
    }),
    { class: 'harness', activation },
  );
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'operator_required',
    reasonCode: 'continuation_unready',
    inputSettled: true,
    continuationReady: false,
    nextTurnAllowed: false,
  });
});

it('keeps native active and recovered owners closed after terminal commit', async () => {
  const f = await fixture(true);
  await f.terminal();
  f.session.recoveredTurn = f.promptId;
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'recovering',
    inputSettled: true,
    continuationReady: false,
    nextTurnAllowed: false,
  });
});

it('does not infer settlement for a foreign prompt', async () => {
  const f = await fixture();
  await f.terminal();
  expect(await inspectHostedRecovery(f.session, randomUUID())).toMatchObject({
    state: 'operator_required',
    reasonCode: 'original_input_missing',
    inputSettled: false,
    nextTurnAllowed: false,
  });
});

it('separates durable terminal proof from original Runtime cleanup debt', async () => {
  const f = await fixture(true);
  const broker = new HostedWorkspaceBroker(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    f.managed.authority.sessionHeader.sessionKey,
    f.promptId,
  );
  broker.runtime = {
    bindingId: 'binding',
    generation: '1',
    workspaceGeneration: '1',
  };
  await oweHostedTurnCleanup(f.managed, f.promptId, broker);
  await f.terminal();
  const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'cleanup_pending',
    reasonCode: 'runtime_cleanup_pending',
    inputSettled: true,
    continuationReady: true,
    nextTurnAllowed: false,
  });
  expect(release).not.toHaveBeenCalled();
});

it('keeps a cleanup-only latch payable after its durable debt cleared', async () => {
  const f = await fixture(true);
  await f.terminal();
  f.session.blocked = true;
  f.session.cleanupBlocked = true;
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'cleanup_pending',
    reasonCode: 'runtime_cleanup_pending',
    inputSettled: true,
    continuationReady: true,
    nextTurnAllowed: false,
  });
});

it.each([false, true])(
  'distinguishes missing checkpoint bytes from a failed read (transient=%s)',
  async (transient) => {
    const f = await fixture(true);
    await f.terminal();
    vi.spyOn(f.managed.authority, 'harnessRunAuthorization').mockResolvedValue({
      status: 'blocked',
      reason: 'missing_state',
      ...(transient ? { message: 'store unavailable' } : {}),
    });
    expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
      state: transient ? 'awaiting_evidence' : 'operator_required',
      reasonCode: 'checkpoint_missing_state',
      inputSettled: true,
      continuationReady: false,
      nextTurnAllowed: false,
    });
  },
);

it('keeps checkpoint and file-history read failures closed', async () => {
  const f = await fixture(true);
  await f.terminal();
  const authorization = vi
    .spyOn(f.managed.authority, 'harnessRunAuthorization')
    .mockRejectedValue(new Error('read failed'));
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'awaiting_evidence',
    reasonCode: 'recovery_evidence_unavailable',
    nextTurnAllowed: false,
  });
  authorization.mockRestore();
  vi.spyOn(f.managed.authority, 'domainRecord').mockImplementationOnce(() => {
    throw new Error('file history unavailable');
  });
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'awaiting_evidence',
    reasonCode: 'recovery_evidence_unavailable',
    nextTurnAllowed: false,
  });
});

it('rejects a positive read that raced another journal commit', async () => {
  const f = await fixture(true);
  await f.terminal();
  const original = f.managed.authority.harnessRunAuthorization.bind(
    f.managed.authority,
  );
  vi.spyOn(
    f.managed.authority,
    'harnessRunAuthorization',
  ).mockImplementationOnce(async () => {
    const result = await original();
    await f.submit();
    return result;
  });
  expect(await inspectHostedRecovery(f.session, f.promptId)).toMatchObject({
    state: 'awaiting_evidence',
    reasonCode: 'evidence_changed',
    nextTurnAllowed: false,
  });
});

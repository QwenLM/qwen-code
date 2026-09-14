/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
import {
  createManagedHarnessHandle,
  ManagedHarnessBlockedError,
  type ManagedDurableWaitCommit,
} from './managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  HARNESS_DURABLE_WAIT_BOUNDARY,
  HARNESS_TURN_COMPLETE_BOUNDARY,
  parseHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import {
  ManagedSessionConflictError,
  type ManagedSessionCommand,
} from './managed-session-authority.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const DIGEST = '9'.repeat(64);
const sessionId = '550e8400-e29b-41d4-a716-4466554400bb';
const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId };
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function ref(kind = 'managed-test'): ManagedSessionDurableRef {
  return {
    resourceId: 'res-1',
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: DIGEST,
  };
}

interface Workspace {
  runtimeBaseDir: string;
  projectRoot: string;
  transcriptPath: string;
}

async function createWorkspace(): Promise<Workspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-hf-'));
  temporaryDirectories.add(root);
  const projectRoot = path.join(root, 'project');
  const runtimeBaseDir = path.join(root, 'runtime');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  const transcriptPath = path.join(
    new Storage(projectRoot, runtimeBaseDir).getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return { runtimeBaseDir, projectRoot, transcriptPath };
}

function open(workspace: Workspace): Promise<ManagedSession> {
  return openManagedSession({
    runtimeBaseDir: workspace.runtimeBaseDir,
    sessionId,
    transcriptPath: workspace.transcriptPath,
    sessionKey,
    cwd: workspace.projectRoot,
    version: 'test',
    workerId: 'worker-1',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: ref('managed-definition'),
      rootSnapshotRef: ref('managed-root'),
      createdBy: 'daemon',
    },
  });
}

function command(operation: string, commandId: string): ManagedSessionCommand {
  return {
    operation,
    commandId,
    sessionKey,
    contentDigest: DIGEST,
  };
}

async function settleTurnComplete(
  session: ManagedSession,
  turnId = 'turn-1',
): Promise<void> {
  const resultRef = await session.resources.publish(
    'managed-turn-result',
    Buffer.from('{"state":"completed"}', 'utf8'),
  );
  await session.authority.commitTurnComplete(
    command('settleTurn', `settle-${turnId}`),
    {
      turn: {
        turnId,
        outcome: 'completed',
        stopReason: 'end_turn',
        resultRef,
        occurredAt: 1,
        eventId: `turn:${turnId}`,
      },
      boundary: HARNESS_TURN_COMPLETE_BOUNDARY,
      state: (identity, previous) =>
        encodeHarnessCheckpointV1(
          createNextTurnReadyHarnessCheckpoint({
            previous,
            ...identity,
            activationId: session.activation.activationId,
            turnId,
            promptId: turnId,
          }),
        ),
    },
    { class: 'harness', activation: session.activation },
  );
}

describe('managed harness factory', () => {
  it('does not treat opening or accepted input as a runnable start', async () => {
    const session = await open(await createWorkspace());
    expect(session.authority.restoreBasis()).toBe('initial');
    await session.authority.submitInput(command('submitInput', 'in-1'), {
      inputId: 'in-1',
      turnId: 'turn-1',
      source: 'web_shell',
      contentRef: ref(),
      deadline: null,
      admissionRef: ref(),
      wakeReason: 'input',
    });
    expect(session.authority.restoreBasis()).toBe('initial');
    await expect(session.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: 'initial',
      checkpointRef: null,
      restoreProofRef: null,
      recoveryStatus: 'ok',
    });
    expect(session.authority.latestCheckpoint).toBeUndefined();
    await session.close();
  });

  it('submits a before_model checkpoint before the Agent runs', async () => {
    const session = await open(await createWorkspace());
    const handle = createManagedHarnessHandle(session);
    const order: string[] = [];
    const result = await handle.run(async () => {
      order.push('agent');
      const authorization = await session.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status === 'runnable') {
        expect(authorization.checkpoint.continuation.phase).toBe(
          'before_model',
        );
      }
      expect(session.authority.latestCheckpoint?.boundary).toBeNull();
      expect(
        parseHarnessCheckpointV1(
          (await session.authority.readCheckpointState())!,
        ).continuation.phase,
      ).toBe('before_model');
      return 'read-final';
    });
    expect(result).toBe('read-final');
    expect(order).toEqual(['agent']);
    await expect(session.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: 'checkpoint',
      restoreProofRef: null,
      recoveryStatus: 'ok',
    });
    await expect(handle.run(async () => 'again')).rejects.toThrow(
      ManagedSessionConflictError,
    );
    await session.close();
  });

  it('is idempotent: a second ensure does not write another checkpoint', async () => {
    const session = await open(await createWorkspace());
    const handle = createManagedHarnessHandle(session);
    const first = await handle.ensureRunnable();
    const second = await handle.ensureRunnable();
    expect(second.identity.checkpointId).toBe(first.identity.checkpointId);
    expect(session.authority.latestCheckpoint?.checkpointId).toBe(
      first.identity.checkpointId,
    );
    await session.close();
  });

  it('blocks an opaque checkpoint instead of running the Agent', async () => {
    const session = await open(await createWorkspace());
    await session.authority.commitCheckpoint(
      command('commitCheckpoint', 'opaque'),
      { state: Buffer.from('first', 'utf8'), boundary: null },
      { class: 'harness', activation: session.activation },
    );
    const handle = createManagedHarnessHandle(session);
    let ran = false;
    await expect(
      handle.run(async () => {
        ran = true;
        return 'no';
      }),
    ).rejects.toBeInstanceOf(ManagedHarnessBlockedError);
    await expect(handle.ensureRunnable()).rejects.toMatchObject({
      reason: 'opaque_state',
    });
    expect(ran).toBe(false);
    expect(session.authority.restoreBasis()).toBe('checkpoint');
    await expect(session.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: 'checkpoint',
      restoreProofRef: null,
      recoveryStatus: 'blocked',
    });
    expect(
      (await session.authority.restoreBundle()).checkpointRef,
    ).not.toBeNull();
    await session.close();
  });

  it('blocks continuation without a checkpoint instead of running the Agent', async () => {
    const session = await open(await createWorkspace());
    await session.authority.appendExecution(
      command('appendExecution', 'model-1'),
      [
        {
          v: 1,
          sequence: session.authority.committedSequence + 1,
          eventId: 'evt-model-1',
          sessionKey,
          kind: 'model.attempt',
          occurredAt: 1,
          subject: {
            type: 'activation',
            scopeId: session.activation.activationId,
            activationId: session.activation.activationId,
            epoch: session.activation.epoch,
          },
          payload: {
            attemptId: 'att-1',
            routeRef: ref(),
            inputCheckpointRef: null,
            state: 'started',
            usageRef: null,
          },
        },
      ],
      { class: 'harness', activation: session.activation },
    );
    const handle = createManagedHarnessHandle(session);
    let ran = false;
    await expect(
      handle.run(async () => {
        ran = true;
        return 'no';
      }),
    ).rejects.toMatchObject({ reason: 'missing_checkpoint' });
    expect(ran).toBe(false);
    expect(session.authority.restoreBasis()).toBe('blocked');
    await expect(session.authority.restoreBundle()).resolves.toMatchObject({
      restoreBasis: null,
      checkpointRef: null,
      restoreProofRef: null,
      recoveryStatus: 'blocked',
    });
    await session.close();
  });

  it('lets only a matching live activation prepare the Harness', async () => {
    const session = await open(await createWorkspace());
    const handle = createManagedHarnessHandle({
      authority: session.authority,
      activation: { activationId: 'act-other', epoch: 1 },
    });
    await expect(handle.ensureRunnable()).rejects.toThrow(
      /not the committed activation/,
    );
    await session.close();
  });

  it('does not treat opening as a turn-complete boundary', async () => {
    const session = await open(await createWorkspace());
    const handle = createManagedHarnessHandle(session);
    await handle.ensureRunnable();
    await expect(handle.requestBoundary()).rejects.toThrow(
      /not at a turn-complete or durable-wait safety point/,
    );
    await expect(handle.detach()).rejects.toThrow(
      /cannot detach before a turn-complete or durable-wait checkpoint/,
    );
    await session.close();
  });

  it('replaces a drained handle after turn-complete without rewriting the checkpoint', async () => {
    const session = await open(await createWorkspace());
    const handle = createManagedHarnessHandle(session);
    await handle.ensureRunnable();
    const firstId = session.authority.latestCheckpoint?.checkpointId;
    await settleTurnComplete(session);
    const completeId = session.authority.latestCheckpoint?.checkpointId;
    expect(completeId).not.toBe(firstId);

    const boundary = await handle.requestBoundary();
    expect(boundary).toMatchObject({
      kind: 'turn_complete',
      checkpointId: completeId,
      activationId: handle.activation.activationId,
      epoch: handle.activation.epoch,
    });
    await handle.detach();
    await expect(handle.ensureRunnable()).rejects.toThrow(/detached/);

    const previousActivation = session.activation;
    const nextActivation = await session.replaceActivation();
    expect(nextActivation.activationId).not.toBe(
      previousActivation.activationId,
    );
    const stale = createManagedHarnessHandle({
      authority: session.authority,
      activation: previousActivation,
    });
    await expect(stale.ensureRunnable()).rejects.toThrow(
      /not the committed activation/,
    );

    const next = createManagedHarnessHandle(session);
    const checkpoint = await next.ensureRunnable();
    expect(checkpoint.identity.checkpointId).toBe(completeId);
    expect(session.authority.latestCheckpoint?.checkpointId).toBe(completeId);
    expect(session.authority.latestCheckpoint?.boundary).toBe(
      HARNESS_TURN_COMPLETE_BOUNDARY,
    );
    await session.close();
  });

  it('commits an approval wait before the next model start is allowed', async () => {
    const workspace = await createWorkspace();
    const session = await open(workspace);
    const handle = createManagedHarnessHandle(session);
    await handle.ensureRunnable();
    const refs = await waitRefs(session);
    const boundary = await handle.commitDurableWait(waitCommit(refs));
    expect(boundary.kind).toBe('durable_wait');
    expect(session.authority.latestCheckpoint?.boundary).toBe(
      HARNESS_DURABLE_WAIT_BOUNDARY,
    );
    expect(
      parseHarnessCheckpointV1((await session.authority.readCheckpointState())!)
        .continuation.phase,
    ).toBe('await_action');
    await expect(handle.ensureRunnable()).rejects.toMatchObject({
      reason: 'invalid_state',
    });
    await expect(handle.requestBoundary()).resolves.toMatchObject({
      kind: 'durable_wait',
      checkpointId: boundary.checkpointId,
    });
    await expect(handle.resolveDurableWait()).rejects.toThrow(
      /before a final action decision/,
    );
    expect(session.authority.action('fc-1')?.state).toBe('requested');
    await handle.detach();
    await expect(handle.resolveDurableWait()).rejects.toThrow(/detached/);

    await decideAction(session);
    const next = createManagedHarnessHandle(session);
    const resumed = await next.resolveDurableWait();
    expect(resumed?.continuation.phase).toBe('model_output_committed');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
    const runnable = await next.ensureRunnable();
    expect(runnable.identity.checkpointId).toBe(resumed?.identity.checkpointId);
    expect(runnable.continuation.phase).toBe('model_output_committed');
    await session.close();

    const reopened = await openManagedSession({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionId,
      transcriptPath: workspace.transcriptPath,
      sessionKey,
      cwd: workspace.projectRoot,
      version: 'test',
      workerId: 'worker-1',
      activationLeaseDurationMs: 60_000,
    });
    expect(reopened.authority.action('fc-1')).toMatchObject({
      state: 'decided',
      requestId: 'fc-1',
    });
    expect(reopened.authority.action('fc-1')?.decisionRef).not.toBeNull();
    await reopened.close();
  });

  it('authorizes the original wait after a crash between the decision and resolve', async () => {
    const workspace = await createWorkspace();
    const session = await open(workspace);
    const handle = createManagedHarnessHandle(session);
    await handle.ensureRunnable();
    await handle.commitDurableWait(waitCommit(await waitRefs(session)));
    await decideAction(session);
    expect(session.authority.latestCheckpoint?.boundary).toBe(
      HARNESS_DURABLE_WAIT_BOUNDARY,
    );
    await session.close();

    const reopened = await openManagedSession({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionId,
      transcriptPath: workspace.transcriptPath,
      sessionKey,
      cwd: workspace.projectRoot,
      version: 'test',
      workerId: 'worker-1',
      activationLeaseDurationMs: 60_000,
    });
    expect(reopened.authority.action('fc-1')?.state).toBe('decided');
    expect(reopened.authority.latestCheckpoint?.boundary).toBe(
      HARNESS_DURABLE_WAIT_BOUNDARY,
    );
    const next = createManagedHarnessHandle(reopened);
    const resumed = await next.resolveDurableWait();
    expect(resumed?.continuation.phase).toBe('model_output_committed');
    const runnable = await next.ensureRunnable();
    expect(runnable.continuation.phase).toBe('model_output_committed');
    await reopened.close();
  });

  it('keeps a requested approval after the waiter handle is gone', async () => {
    const workspace = await createWorkspace();
    const session = await open(workspace);
    const handle = createManagedHarnessHandle(session);
    await handle.ensureRunnable();
    await handle.commitDurableWait(waitCommit(await waitRefs(session)));
    await handle.detach();
    expect(session.authority.action('fc-1')?.state).toBe('requested');
    await session.close();

    const reopened = await openManagedSession({
      runtimeBaseDir: workspace.runtimeBaseDir,
      sessionId,
      transcriptPath: workspace.transcriptPath,
      sessionKey,
      cwd: workspace.projectRoot,
      version: 'test',
      workerId: 'worker-1',
      activationLeaseDurationMs: 60_000,
    });
    expect(reopened.authority.action('fc-1')?.state).toBe('requested');
    expect(reopened.authority.latestCheckpoint?.boundary).toBe(
      HARNESS_DURABLE_WAIT_BOUNDARY,
    );
    const next = createManagedHarnessHandle(reopened);
    await expect(next.ensureRunnable()).rejects.toMatchObject({
      reason: 'invalid_state',
    });
    await expect(next.resolveDurableWait()).rejects.toThrow(
      /before a final action decision/,
    );
    await decideAction(reopened);
    const resumed = await next.resolveDurableWait();
    expect(resumed?.continuation.phase).toBe('model_output_committed');
    await reopened.close();
  });

  it('is idempotent for the same approval wait and rejects a second request', async () => {
    const session = await open(await createWorkspace());
    const handle = createManagedHarnessHandle(session);
    await handle.ensureRunnable();
    const refs = await waitRefs(session);
    const first = await handle.commitDurableWait(waitCommit(refs));
    const second = await handle.commitDurableWait(waitCommit(refs));
    expect(second.checkpointId).toBe(first.checkpointId);
    await expect(
      handle.commitDurableWait({
        ...waitCommit(refs),
        requestId: 'fc-2',
        attemptId: 'att-fc-2',
      }),
    ).rejects.toThrow(/already waiting on a different approval/);
    await expect(handle.resolveDurableWait()).rejects.toThrow(
      /before a final action decision/,
    );
    await decideAction(session);
    expect(session.authority.action('fc-1')?.state).toBe('decided');
    expect(await handle.resolveDurableWait()).not.toBeNull();
    expect(await handle.resolveDurableWait()).toBeNull();
    await expect(
      session.authority.resolveAction(
        {
          operation: 'resolveAction',
          commandId: 'resolveAction:fc-1:other',
          sessionKey,
          contentDigest: DIGEST,
        },
        {
          requestId: 'fc-1',
          state: 'cancelled',
          decisionRef: null,
        },
      ),
    ).rejects.toThrow(/already decided/);
    await session.close();
  });
});

async function waitRefs(session: ManagedSession): Promise<{
  optionsRef: ManagedSessionDurableRef;
  invocationRef: ManagedSessionDurableRef;
  routeRef: ManagedSessionDurableRef;
}> {
  return {
    optionsRef: await session.resources.publish(
      'managed-approval',
      Buffer.from('[]', 'utf8'),
    ),
    invocationRef: await session.resources.publish(
      'managed-invocation',
      Buffer.from('{"toolCallId":"fc-1"}', 'utf8'),
    ),
    routeRef: await session.resources.publish(
      'managed-route',
      Buffer.from('{"model":"qwen3-coder-plus"}', 'utf8'),
    ),
  };
}

function waitCommit(
  refs: Awaited<ReturnType<typeof waitRefs>>,
): ManagedDurableWaitCommit {
  return {
    requestId: 'fc-1',
    kind: 'execute',
    source: 'tool_call',
    optionsRef: refs.optionsRef,
    inputRevision: 'rev-1',
    invocationRef: refs.invocationRef,
    attemptId: 'att-fc-1',
    routeRef: refs.routeRef,
  };
}

async function decideAction(
  session: ManagedSession,
  requestId = 'fc-1',
): Promise<void> {
  const decisionRef = await session.resources.publish(
    'managed-decision',
    Buffer.from('{"optionId":"allow"}', 'utf8'),
  );
  await session.authority.resolveAction(
    {
      operation: 'resolveAction',
      commandId: `resolveAction:${requestId}`,
      sessionKey,
      contentDigest: decisionRef.digest,
    },
    { requestId, state: 'decided', decisionRef },
  );
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHarnessCheckpointV1 } from './managed-harness-checkpoint.js';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  LocalManagedRuntimeOutcomes,
  unresolvedRuntimeWorkReason,
} from './managed-runtime-outcomes.js';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';

const sessionKeyOf = (id: string) => ({
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: id,
});

const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

async function resource(value: string) {
  const { createHash } = await import('node:crypto');
  return {
    resourceId: `ref-${value}`,
    kind: value,
    schemaVersion: 1,
    byteLength: Buffer.byteLength(value),
    digest: createHash('sha256').update(value).digest('hex'),
  };
}

interface OpenedSession {
  readonly session: ManagedSession;
  /** Finishes the adopted lease as a handoff seal, so a reopen takes it over. */
  readonly seal: () => Promise<void>;
}

async function openSession(root: string, id: string): Promise<OpenedSession> {
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(runtimeBaseDir, 'chats', `${id}.jsonl`);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const sessionKey = sessionKeyOf(id);
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId: id,
    transcriptPath,
  });
  const session = await openManagedSession({
    runtimeBaseDir,
    sessionId: id,
    transcriptPath,
    sessionKey,
    cwd: root,
    version: 'test',
    workerId: 'worker-a',
    activationLeaseDurationMs: 60_000,
    lease,
    create: {
      definitionRef: await resource('definition'),
      rootSnapshotRef: await resource('root'),
      createdBy: 'test',
    },
  });
  return {
    session,
    seal: async () => {
      await session.close();
      await session.releaseActivation();
      const proof = session.authority.commitProof;
      await lease.sealForHandoff({
        last_commit_sequence: proof.lastCommitSequence,
        committed_prefix_hash: proof.committedPrefixHash,
      });
    },
  };
}

const admission = (
  id: string,
  params: Record<string, unknown> = {},
  promptId = 'prompt-a',
) => ({
  functionCallId: id,
  toolName: 'read_file',
  promptId,
  params,
  toolDefinition: { name: 'read_file', parametersJsonSchema: {} },
  workerIncarnation: 'incarnation-a',
});

const events = (session: ManagedSession, kind: string) =>
  session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === kind);

async function checkpointOf(session: ManagedSession) {
  const state = await session.authority.readCheckpointState();
  return state ? parseHarnessCheckpointV1(state) : undefined;
}

describe('LocalManagedRuntimeOutcomes', () => {
  it('admits a call with its intent and an await_runtime checkpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-admit');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(
        admission('call-a', { file_path: '/workspace/a.txt' }),
      );

      const intents = events(session, 'tool.intent');
      expect(intents).toHaveLength(1);
      const intent = intents[0]!;
      expect(intent.subject).toMatchObject({
        type: 'activation',
        activationId: session.activation.activationId,
      });
      expect(intent.payload).toMatchObject({
        executionCallId: 'call-a',
        batchId: 'batch-call-a',
        ordinal: 0,
        outcomeSource: 'runtime',
      });
      const argsRef = intent.payload['argsRef'] as {
        resourceId: string;
        digest: string;
      };
      const args = JSON.parse(
        (await session.resources.read(argsRef as never)).toString(),
      ) as Record<string, unknown>;
      expect(args).toEqual({ file_path: '/workspace/a.txt' });

      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.continuation.phase).toBe('await_runtime');
      expect(checkpoint.identity.turnId).toBe('prompt-a');
      expect(checkpoint.identity.promptId).toBe('prompt-a');
      const item = checkpoint.tools?.items[0];
      expect(item).toMatchObject({
        functionCallId: 'call-a',
        toolName: 'read_file',
        executionCallId: 'call-a',
        modelMessageId: 'local-model-message:prompt-a',
        partIndex: 0,
        ordinal: 0,
        inputDigest: managedToolDigest({ file_path: '/workspace/a.txt' }),
        outcomeSource: 'runtime',
        state: 'in_progress',
        outcomeRef: null,
        consumed: false,
      });
      const binding = checkpoint.runtime?.bindings[0];
      expect(binding).toMatchObject({
        executionCallId: 'call-a',
        invocationBindingId: 'incarnation-a:call-a',
        capabilityVersion: 'managed-runtime-tool-v2',
        policyVersion: 'host-approval-v1',
        mediaVersion: null,
        state: 'dispatch',
      });
    } finally {
      await session.close();
    }
  });

  it("accumulates a prompt's calls in one batch with rising ordinals", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-accumulates');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.admit(admission('call-b'));

      const intents = events(session, 'tool.intent');
      expect(intents.map((intent) => intent.payload['ordinal'])).toEqual([
        0, 1,
      ]);
      expect(intents.map((intent) => intent.payload['batchId'])).toEqual([
        'batch-call-a',
        'batch-call-a',
      ]);
      // One published tool definition serves both calls.
      const refs = intents.map(
        (intent) =>
          (intent.payload['toolDefinitionRef'] as { resourceId: string })
            .resourceId,
      );
      expect(new Set(refs).size).toBe(1);

      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.tools?.batchId).toBe('batch-call-a');
      expect(
        checkpoint.tools?.items.map((item) => item.executionCallId),
      ).toEqual(['call-a', 'call-b']);
      expect(
        checkpoint.runtime?.bindings.map((binding) => binding.state),
      ).toEqual(['dispatch', 'dispatch']);
    } finally {
      await session.close();
    }
  });

  it('settles a call with its outcome, receipt and checkpoint item', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-settle');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      const outcomeRef = await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'success',
        payload: { executionStatus: 'success', responseParts: [] },
      });

      const stored = JSON.parse(
        (await session.resources.read(outcomeRef)).toString(),
      ) as Record<string, unknown>;
      expect(stored).toMatchObject({
        version: 1,
        identity: { sessionId: 'session-settle', executionCallId: 'call-a' },
        executionStatus: 'success',
        result: { executionStatus: 'success', responseParts: [] },
      });

      const receipts = events(session, 'tool.receipt');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.payload).toMatchObject({
        executionCallId: 'call-a',
        resultRef: outcomeRef,
        resources: [outcomeRef],
        historyRevision: receipts[0]!.sequence,
      });

      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.continuation.phase).toBe('results_ready');
      expect(checkpoint.tools?.items[0]).toMatchObject({
        executionCallId: 'call-a',
        state: 'settled',
        outcomeRef,
        consumed: false,
      });

      await outcomes.finalizeBatch();
      const closed = (await checkpointOf(session))!;
      expect(closed.continuation.phase).toBe('turn_settled');
      expect(closed.tools?.items[0]).toMatchObject({ consumed: true });
    } finally {
      await session.close();
    }
  });

  it('settles a refused call as not started, with the same evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-not-started');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'not_started',
        payload: {
          executionStatus: 'not_started',
          responseParts: [],
          error: { message: 'The Runtime worker refused the tool call.' },
        },
      });
      const receipts = events(session, 'tool.receipt');
      expect(receipts).toHaveLength(1);
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.continuation.phase).toBe('results_ready');
      const stored = JSON.parse(
        (
          await session.resources.read(
            receipts[0]!.payload['toolOutcomeRef'] as never,
          )
        ).toString(),
      ) as Record<string, unknown>;
      expect(stored['executionStatus']).toBe('not_started');
    } finally {
      await session.close();
    }
  });

  it('starts Runtime evidence on a log that recorded without checkpoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-legacy');
    try {
      // A M5a-era record: the model ran, and no checkpoint was ever written.
      const attempt = await session.resources.publish(
        'managed-model-attempt',
        Buffer.from('{}'),
      );
      await session.authority.appendExecutionEvent(
        {
          operation: 'recordModelAttempt',
          commandId: 'attempt-1',
          sessionKey: session.authority.sessionHeader.sessionKey,
          contentDigest: attempt.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: 'attempt-1',
          sessionKey: session.authority.sessionHeader.sessionKey,
          kind: 'model.attempt',
          occurredAt: 1,
          subject: {
            type: 'activation',
            scopeId: session.activation.activationId,
            activationId: session.activation.activationId,
            epoch: session.activation.epoch,
          },
          payload: {
            attemptId: 'attempt-1',
            routeRef: attempt,
            inputCheckpointRef: null,
            state: 'output_committed',
            usageRef: null,
          },
        }),
        { class: 'harness', activation: session.activation },
      );
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.continuation.phase).toBe('await_runtime');
      expect(checkpoint.tools?.items[0]?.executionCallId).toBe('call-a');
    } finally {
      await session.close();
    }
  });

  it('admits concurrent calls with distinct ordinals in one batch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-concurrent');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await Promise.all([
        outcomes.admit(admission('call-a')),
        outcomes.admit(admission('call-b')),
      ]);
      const intents = events(session, 'tool.intent');
      expect(intents).toHaveLength(2);
      expect(intents.map((intent) => intent.payload['ordinal']).sort()).toEqual(
        [0, 1],
      );
      expect(
        new Set(intents.map((intent) => intent.payload['batchId'])).size,
      ).toBe(1);
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.tools?.items).toHaveLength(2);
      expect(checkpoint.runtime?.bindings).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it('re-admits a call idempotently for the same call id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-idempotent');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.admit(admission('call-a'));
      expect(events(session, 'tool.intent')).toHaveLength(1);
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.tools?.items).toHaveLength(1);
      expect(checkpoint.runtime?.bindings).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('answers nothing for a log without checkpoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-empty');
    try {
      await expect(
        unresolvedRuntimeWorkReason(session.authority),
      ).resolves.toBeUndefined();
    } finally {
      await session.close();
    }
  });
});

describe('restored runtime block', () => {
  it('answers for a log whose dispatch never settled, across a reopen', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(root, 'session-unsettled');
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await seal();
    }

    const { session: restored } = await openSession(root, 'session-unsettled');
    try {
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toContain('never settled');
    } finally {
      await restored.close();
    }
  });

  it('answers nothing for a log at results_ready across a reopen', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(
        root,
        'session-results-ready',
      );
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'success',
        payload: { executionStatus: 'success', responseParts: [] },
      });
      // Closed between the commit and the batch's consumption.
      await seal();
    }

    const { session: restored } = await openSession(
      root,
      'session-results-ready',
    );
    try {
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toBeUndefined();
      // The leftover continuation closes at the next admission: the turn is
      // not replayed, and the new prompt's batch is its own.
      const outcomes = new LocalManagedRuntimeOutcomes(restored);
      await outcomes.admit(admission('call-b', {}, 'prompt-b'));
      const intents = events(restored, 'tool.intent');
      expect(intents).toHaveLength(2);
      expect(intents[1]!.payload).toMatchObject({
        batchId: 'batch-call-b',
        ordinal: 0,
      });
      const checkpoint = (await checkpointOf(restored))!;
      expect(checkpoint.continuation.phase).toBe('await_runtime');
      expect(checkpoint.identity.turnId).toBe('prompt-b');
      expect(checkpoint.attempt?.attemptId).toBe('attempt:prompt-b');
      expect(
        checkpoint.tools?.items.map((item) => item.executionCallId),
      ).toEqual(['call-b']);
    } finally {
      await restored.close();
    }
  });

  it('starts a fresh batch and attempt for the prompt after a settled turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-prompts');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'success',
        payload: { executionStatus: 'success', responseParts: [] },
      });
      await outcomes.finalizeBatch();
      expect((await checkpointOf(session))!.continuation.phase).toBe(
        'turn_settled',
      );

      await outcomes.admit(admission('call-b', {}, 'prompt-b'));
      const intents = events(session, 'tool.intent');
      expect(intents).toHaveLength(2);
      expect(intents[1]!.payload).toMatchObject({
        batchId: 'batch-call-b',
        ordinal: 0,
      });
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.identity.turnId).toBe('prompt-b');
      expect(checkpoint.attempt?.attemptId).toBe('attempt:prompt-b');
      expect(
        checkpoint.tools?.items.map((item) => item.executionCallId),
      ).toEqual(['call-b']);
    } finally {
      await session.close();
    }
  });

  it('answers nothing for a log whose batch finished', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(root, 'session-finished');
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'success',
        payload: { executionStatus: 'success', responseParts: [] },
      });
      await outcomes.finalizeBatch();
      await seal();
    }

    const { session: restored } = await openSession(root, 'session-finished');
    try {
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toBeUndefined();
    } finally {
      await restored.close();
    }
  });
});

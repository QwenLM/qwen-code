/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

      // A different tool publishes its own definition once, and the first
      // tool's definition keeps serving later calls.
      await outcomes.admit({
        ...admission('call-c'),
        toolName: 'write_file',
        params: { file_path: '/workspace/c.txt', content: 'c' },
        toolDefinition: { name: 'write_file', parametersJsonSchema: {} },
      });
      await outcomes.admit(admission('call-d'));
      const afterRefs = events(session, 'tool.intent').map(
        (intent) =>
          (intent.payload['toolDefinitionRef'] as { resourceId: string })
            .resourceId,
      );
      expect(new Set(afterRefs).size).toBe(2);
      expect(afterRefs[3]).toBe(refs[0]);

      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.tools?.batchId).toBe('batch-call-a');
      expect(
        checkpoint.tools?.items.map((item) => item.executionCallId),
      ).toEqual(['call-a', 'call-b', 'call-c', 'call-d']);
      expect(
        checkpoint.runtime?.bindings.map((binding) => binding.state),
      ).toEqual(['dispatch', 'dispatch', 'dispatch', 'dispatch']);
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
      // A batch that only ever refused never wrote a checkpoint, and closing
      // it is a no-op rather than a blocked-authorization failure.
      await expect(
        new LocalManagedRuntimeOutcomes(session).finalizeBatch(),
      ).resolves.toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('refuses an inadmissible call before anything durable is written', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-oversized');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      const oversized = 'x'.repeat(256 * 1024 + 8);
      await expect(
        outcomes.admit(
          admission('call-a', {
            file_path: '/workspace/a.txt',
            content: oversized,
          }),
        ),
      ).rejects.toThrow();
      expect(events(session, 'tool.intent')).toHaveLength(0);
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.tools).toBeNull();
    } finally {
      await session.close();
    }
  });
});

describe('admission failure recovery', () => {
  it('retries the route publish that a transient failure rejected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-routefail');
    try {
      const original = session.resources.publish.bind(session.resources);
      let failed = 0;
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind: string, bytes: Buffer) => {
          if (kind === 'managed-execution-route' && failed === 0) {
            failed += 1;
            throw new Error('disk pressure');
          }
          return original(kind, bytes);
        },
      );
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await expect(outcomes.admit(admission('call-a'))).rejects.toThrow(
        'disk pressure',
      );
      expect(events(session, 'tool.intent')).toHaveLength(1);

      await outcomes.admit(admission('call-b'));
      expect(failed).toBe(1);
      expect(events(session, 'tool.intent')).toHaveLength(2);
      await outcomes.admit(admission('call-c'));
      const routePublishes = vi
        .mocked(session.resources.publish)
        .mock.calls.filter((call) => call[0] === 'managed-execution-route');
      expect(routePublishes).toHaveLength(2);
      const checkpoint = (await checkpointOf(session))!;
      expect(
        checkpoint.tools?.items.map((item) => item.executionCallId),
      ).toEqual(['call-b', 'call-c']);
    } finally {
      await session.close();
    }
  });
});

describe('restored runtime block', () => {
  it('settles a settled-but-unsettled crash victim and re-records its result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(root, 'session-recovering');
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      const harness = (
        outcomes as unknown as {
          harness: {
            resolveAwaitRuntime: (id: string, ref: never) => Promise<unknown>;
          };
        }
      ).harness;
      let sabotaged = false;
      const settling = harness.resolveAwaitRuntime.bind(harness);
      harness.resolveAwaitRuntime = async (id, ref) => {
        if (!sabotaged) {
          sabotaged = true;
          throw new Error('crashed between the receipt and the settlement');
        }
        return settling(id, ref);
      };
      await outcomes.admit(admission('call-a'));
      // The durable outcome and receipt land; the checkpoint settlement
      // crashes where the process died between the two commits.
      await expect(
        outcomes.settle({
          functionCallId: 'call-a',
          executionStatus: 'success',
          payload: {
            executionStatus: 'success',
            responseParts: [{ type: 'text', text: 'the answer' }],
          },
        }),
      ).rejects.toThrow('crashed between');
      expect(events(session, 'tool.receipt')).toHaveLength(1);
      const crashed = (await checkpointOf(session))!;
      expect(crashed.continuation.phase).toBe('await_runtime');
      await seal();
    }

    const { session: restored } = await openSession(root, 'session-recovering');
    try {
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toContain('never settled');

      // The receipts prove the calls, so the restore settles them and the
      // outcome becomes the missing tool_result record.
      await new LocalManagedRuntimeOutcomes(
        restored,
      ).recoverCommittedReceipts();
      const checkpoint = (await checkpointOf(restored))!;
      expect(checkpoint.continuation.phase).toBe('results_ready');
      const resultsRecorded = events(restored, 'message.committed').filter(
        (event) => event.payload['role'] === 'tool_result',
      );
      expect(resultsRecorded).toHaveLength(1);
      const body = await restored.resources.read(
        resultsRecorded[0]!.payload['contentRef'] as never,
      );
      expect(body.toString()).toContain('call-a');
      expect(body.toString()).toContain('the answer');
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toBeUndefined();
    } finally {
      await restored.close();
    }
  });

  it('re-records a settled result whose record died with the process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(root, 'session-unrecorded');
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'success',
        payload: {
          executionStatus: 'success',
          responseParts: [{ type: 'text', text: 'settled but unrecorded' }],
        },
      });
      // Every checkpoint commit landed; the recorder's tool_result record
      // never did — the process died between the resolve and the write.
      await seal();
    }

    const { session: restored } = await openSession(root, 'session-unrecorded');
    try {
      // Nothing is pending, yet the restore repair still runs: the settled
      // outcome becomes the tool_result the session history needs.
      await new LocalManagedRuntimeOutcomes(
        restored,
      ).recoverCommittedReceipts();
      const resultsRecorded = events(restored, 'message.committed').filter(
        (event) => event.payload['role'] === 'tool_result',
      );
      expect(resultsRecorded).toHaveLength(1);
      const body = await restored.resources.read(
        resultsRecorded[0]!.payload['contentRef'] as never,
      );
      expect(body.toString()).toContain('call-a');
      expect(body.toString()).toContain('settled but unrecorded');
      const checkpoint = (await checkpointOf(restored))!;
      expect(checkpoint.continuation.phase).toBe('results_ready');
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toBeUndefined();
    } finally {
      await restored.close();
    }
  });

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

  it('lets the same turn close its own results at the batch end, never mid-round', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    const { session } = await openSession(root, 'session-live-turn');
    try {
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await outcomes.settle({
        functionCallId: 'call-a',
        executionStatus: 'success',
        payload: { executionStatus: 'success', responseParts: [] },
      });
      // The same prompt's next call joins the open batch: the live turn's
      // own results_ready must not be closed by another admission — its
      // close is the batch end, after the recorder's records are flushed,
      // so a sealed log never claims the model saw results it did not.
      await outcomes.admit(admission('call-b'));
      const checkpoint = (await checkpointOf(session))!;
      expect(checkpoint.continuation.phase).toBe('await_runtime');
      const items = checkpoint.tools?.items ?? [];
      expect(items).toMatchObject([
        { executionCallId: 'call-a', state: 'settled', consumed: false },
        { executionCallId: 'call-b', state: 'in_progress', consumed: false },
      ]);
      const phases: string[] = [];
      for (const event of events(session, 'checkpoint.committed')) {
        phases.push(
          parseHarnessCheckpointV1(
            await session.resources.read(event.payload['stateRef'] as never),
          ).continuation.phase,
        );
      }
      expect(phases).not.toContain('turn_settled');
    } finally {
      await session.close();
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

  it('answers a reason for a checkpoint that cannot be read', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(root, 'session-gone-state');
      const outcomes = new LocalManagedRuntimeOutcomes(session);
      await outcomes.admit(admission('call-a'));
      await seal();
      // A checkpoint whose state no longer exists on disk.
      const stateRoot = path.join(
        root,
        'runtime',
        'resources',
        'session-gone-state',
      );
      let removed = 0;
      for (const kind of await fs.readdir(stateRoot)) {
        const dir = path.join(stateRoot, kind);
        for (const file of await fs.readdir(dir)) {
          if (file.startsWith('.')) continue;
          const candidate = path.join(dir, file);
          const content = await fs.readFile(candidate);
          removed += content.includes('ckpt-') ? 1 : 0;
          if (content.includes('ckpt-')) {
            await fs.writeFile(candidate, Buffer.alloc(0));
          }
        }
      }
      expect(removed).toBeGreaterThan(0);
    }

    const { session: restored } = await openSession(root, 'session-gone-state');
    try {
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toContain('cannot be read');
    } finally {
      await restored.close();
    }
  });

  it('answers a reason for a checkpoint it cannot parse', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outcomes-'));
    roots.add(root);
    {
      const { session, seal } = await openSession(root, 'session-bad-state');
      const garbage = Buffer.from('{"v":2,"opaque":true}', 'utf8');
      await session.authority.commitCheckpoint(
        {
          operation: 'commitCheckpoint',
          commandId: 'garbage-checkpoint-1',
          sessionKey: session.authority.sessionHeader.sessionKey,
          contentDigest: createHash('sha256').update(garbage).digest('hex'),
        },
        { state: garbage, boundary: null },
        { class: 'harness', activation: session.activation },
      );
      await seal();
    }

    const { session: restored } = await openSession(root, 'session-bad-state');
    try {
      await expect(
        unresolvedRuntimeWorkReason(restored.authority),
      ).resolves.toContain('cannot be parsed');
    } finally {
      await restored.close();
    }
  });
});

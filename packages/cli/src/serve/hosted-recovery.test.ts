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
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import type { LlmPreparedRequest } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type { Part } from '@google/genai';
import {
  hostedRuntimeSessionId,
  HostedWorkspaceBroker,
} from './hosted-workspace-broker.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { HostedApprovalWaiters } from './hosted-tool-approval.js';
import {
  hasHostedCleanupDebt,
  oweHostedTurnCleanup,
  reconcileHostedTurnCleanup,
} from './hosted-turn-cleanup.js';
import {
  createHostedModelRequest,
  findHostedModelRequest,
  findHostedCommittedModelOutput,
  publishHostedModelRequest,
} from './hosted-model-recovery.js';
import { HostedTextDeltaStream } from './hosted-text-deltas.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(promptId: string = randomUUID()) {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-recovery-'));
  directories.push(root);
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const options = {
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    activationLeaseDurationMs: 60_000,
  };
  const session = await openManagedSession({
    ...options,
    workerId: 'first',
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
  const content = Buffer.from('[]');
  await session.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: promptId,
      sessionKey,
      contentDigest: createHash('sha256').update(content).digest('hex'),
    },
    {
      inputId: promptId,
      turnId: promptId,
      source: 'test',
      contentRef: await resources.publish('managed-input', content),
      admissionRef: await resources.publish(
        'managed-admission',
        Buffer.from('{}'),
      ),
      deadline: null,
      wakeReason: 'input',
    },
  );
  await createManagedHarnessHandle(session).ensureRunnable();
  const terminal = () =>
    session.sink.write({
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
        state: 'completed',
        stopReason: 'end_turn',
        endedAt: Date.now(),
      },
    });
  const brokerOptions = { baseUrl: 'http://127.0.0.1:1', token: 'fixture' };
  const broker = new HostedWorkspaceBroker(
    brokerOptions,
    sessionKey,
    hostedRuntimeSessionId(promptId),
  );
  broker.runtime = {
    bindingId: 'original-binding',
    generation: '7',
    workspaceGeneration: '3',
  };
  return {
    session,
    promptId,
    broker,
    brokerOptions,
    terminal,
    reopen: () => openManagedSession({ ...options, workerId: 'replacement' }),
  };
}

it.each(['ordinary-prompt', 'monitor:wake:run'])(
  'reports scoped cleanup confirmation for %s',
  async (promptId) => {
    const f = await fixture(promptId);
    try {
      await oweHostedTurnCleanup(f.session, f.promptId, f.broker);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      expect(
        await reconcileHostedTurnCleanup(
          f.session,
          f.brokerOptions,
          'other-prompt',
        ),
      ).toEqual(new Map());
      expect(
        await reconcileHostedTurnCleanup(
          f.session,
          f.brokerOptions,
          f.promptId,
        ),
      ).toEqual(new Map([[f.promptId, 'owed']]));
      expect(release).not.toHaveBeenCalled();
      await f.terminal();
      expect(
        await reconcileHostedTurnCleanup(
          f.session,
          f.brokerOptions,
          f.promptId,
        ),
      ).toEqual(new Map([[f.promptId, 'confirmed']]));
      expect(release).toHaveBeenCalledOnce();
      await reconcileHostedTurnCleanup(f.session, f.brokerOptions, f.promptId);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await f.session.close();
    }
  },
);

it.each([undefined, 'already loaded'])(
  'refreshes saved-batch context only when missing (%s)',
  async (context) => {
    const f = await fixture();
    try {
      vi.spyOn(f.broker, 'acquire').mockResolvedValue();
      const fetchWorkspaceContext = vi.fn().mockResolvedValue(undefined);
      const receiver = {
        session: f.session,
        broker: f.broker,
        warmed: Promise.resolve(),
        promptId: f.promptId,
        declarations: vi.fn().mockResolvedValue([]),
        executeNative: vi.fn().mockResolvedValue([]),
        fetchWorkspaceContext,
        context: { read: () => context, write: vi.fn() },
      };
      await Reflect.apply(
        HostedWorkspaceToolTurn.prototype.resumeSavedNativeBatch,
        receiver,
        [
          {
            plan: {
              promptId: f.promptId,
              calls: [],
              runtime: { runtimeSessionId: f.promptId, ...f.broker.runtime },
              round: 1,
              model: 'fixture',
            },
            inputs: [],
            parts: [],
          },
          0,
          new AbortController().signal,
        ],
      );
      expect(fetchWorkspaceContext).toHaveBeenCalledTimes(
        context === undefined ? 1 : 0,
      );
      expect(receiver.declarations).toHaveBeenCalledOnce();
    } finally {
      await f.session.close();
    }
  },
);

it('retains terminal cleanup debt across a failed release and a cold replacement', async () => {
  const f = await fixture();
  await oweHostedTurnCleanup(f.session, f.promptId, f.broker);
  const release = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'release')
    .mockRejectedValueOnce(new Error('lost release reply'))
    .mockResolvedValue();
  await reconcileHostedTurnCleanup(f.session, f.brokerOptions);
  expect(release).not.toHaveBeenCalled();
  await f.terminal();
  await expect(
    reconcileHostedTurnCleanup(f.session, f.brokerOptions),
  ).rejects.toThrow('lost release reply');
  expect(hasHostedCleanupDebt(f.session)).toBe(true);
  await f.session.close();
  const replacement = await f.reopen();
  try {
    await reconcileHostedTurnCleanup(replacement, f.brokerOptions);
    expect(release).toHaveBeenLastCalledWith({
      bindingId: 'original-binding',
      generation: '7',
    });
    expect(hasHostedCleanupDebt(replacement)).toBe(false);
    await reconcileHostedTurnCleanup(replacement, f.brokerOptions);
    expect(release).toHaveBeenCalledTimes(2);
    expect(
      replacement.authority
        .eventsInSequenceRange(1, replacement.authority.committedSequence)
        .filter((event) => event.kind === 'turn.settled'),
    ).toHaveLength(1);
    await expect(
      oweHostedTurnCleanup(replacement, f.promptId, f.broker),
    ).rejects.toThrow('already released');
  } finally {
    await replacement.close();
  }
});

it('releases recovered file-history work only after its durable Turn terminal', async () => {
  const f = await fixture();
  try {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = f.broker.runtime;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    let crashSnapshot = true;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockImplementation(
      async (operation) => {
        if (operation.action === 'snapshot' && crashSnapshot) {
          crashSnapshot = false;
          throw new Error('crash before history marker clears');
        }
        return {
          ownerSessionId:
            f.session.authority.sessionHeader.sessionKey.sessionId,
          snapshots: [],
          files: {},
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      'original-execution',
    );
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written once' }],
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        expect(
          f.session.authority
            .eventsInSequenceRange(1, f.session.authority.committedSequence)
            .filter((event) => event.kind === 'turn.settled'),
        ).toHaveLength(1);
      });
    const harness = createManagedHarnessHandle(f.session);
    const commit = async (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) => {
      const uuid = identity?.uuid ?? randomUUID();
      await f.session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: f.session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        model,
        cwd: '/fixture',
        version: 'test',
        daemonPromptId: f.promptId,
        message: { role: type === 'assistant' ? 'model' : 'user', parts },
      });
      return uuid;
    };
    const original = new HostedWorkspaceToolTurn(
      f.brokerOptions,
      f.session,
      harness,
      f.promptId,
      commit,
      () => true,
      undefined,
      undefined,
      {
        settings: { mode: 'yolo', timeoutMs: 15 },
        waiters: new HostedApprovalWaiters(),
      },
    );
    const call = {
      name: 'write_file',
      callId: 'original-call',
      args: { file_path: 'original.txt', content: 'written once' },
      isClientInitiated: false,
      prompt_id: f.promptId,
    };
    await expect(
      original.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'fixture',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Hosted tool turn requires recovery');
    const authorization = await f.session.authority.harnessRunAuthorization();
    expect(authorization.status).toBe('runnable');
    if (authorization.status !== 'runnable') throw new Error('Not runnable');
    expect(authorization.checkpoint.continuation.phase).toBe('results_ready');
    const replacement = new HostedWorkspaceToolTurn(
      f.brokerOptions,
      f.session,
      harness,
      f.promptId,
      async () => {
        throw new Error('Recovery must not reexecute tools');
      },
      () => true,
    );
    await replacement.resumeCommittedResults(new AbortController().signal);
    await replacement.consumeResults();
    await replacement.finish();
    expect(release).not.toHaveBeenCalled();
    expect(hasHostedCleanupDebt(f.session)).toBe(true);
    await f.terminal();
    await replacement.cleanup();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith({
      bindingId: 'original-binding',
      generation: '7',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(hasHostedCleanupDebt(f.session)).toBe(false);
  } finally {
    await f.session.close();
  }
});

const prepared: LlmPreparedRequest = {
  request: {
    model: 'fixture',
    contents: [{ role: 'user', parts: [{ text: 'original' }] }],
    config: { temperature: 0.3 },
  },
  history: [{ role: 'user', parts: [{ text: 'original' }] }],
  completedToolCallIds: [],
  routeSelector: 'openai:fixture',
  providerPin: 'a'.repeat(64),
  promptTokensForClamp: 12,
};

it.each([false, true])(
  'restores an unfinished request even when stream Finished was recorded (%s)',
  async (finished) => {
    const f = await fixture();
    const request = createHostedModelRequest(
      f.session,
      f.promptId,
      prepared,
      0,
      false,
      undefined,
      { bootId: 'source-boot', eventEpoch: 'source-epoch' },
    );
    await new ManagedHookActivationController(f.session).runTurn(
      f.promptId,
      async (scope) => {
        const finish = await scope.beginMainAttempt(
          'fixture',
          await publishHostedModelRequest(f.session, request),
        );
        if (finished) await finish(true, {});
      },
    );
    await f.session.close();
    const replacement = await f.reopen();
    try {
      expect(await findHostedModelRequest(replacement, f.promptId)).toEqual(
        request,
      );
      await createManagedHarnessHandle(replacement).adoptPreparedContinuation(
        f.promptId,
        true,
      );
      expect(
        (await replacement.authority.harnessRunAuthorization()).status,
      ).toBe('runnable');
    } finally {
      await replacement.close();
    }
  },
);

it('does not reuse an older snapshot after a newer unsupported attempt', async () => {
  const f = await fixture();
  try {
    const request = createHostedModelRequest(
      f.session,
      f.promptId,
      prepared,
      0,
      false,
      undefined,
      { bootId: 'source-boot', eventEpoch: 'source-epoch' },
    );
    await new ManagedHookActivationController(f.session).runTurn(
      f.promptId,
      async (scope) => {
        await scope.beginMainAttempt(
          'fixture',
          await publishHostedModelRequest(f.session, request),
        );
        await scope.beginMainAttempt('fixture');
      },
    );
    expect(await findHostedModelRequest(f.session, f.promptId)).toBeUndefined();
    expect(
      await publishHostedModelRequest(f.session, {
        ...request,
        workspaceContext: 'x'.repeat(64 * 1024),
      }),
    ).toBeUndefined();
  } finally {
    await f.session.close();
  }
});

it('rejects saved authentication fields before attempting inference', async () => {
  const f = await fixture();
  try {
    const request = createHostedModelRequest(
      f.session,
      f.promptId,
      {
        ...prepared,
        request: {
          ...prepared.request,
          config: {
            ...prepared.request.config,
            httpOptions: { headers: { Authorization: 'fixture-secret' } },
          } as LlmPreparedRequest['request']['config'],
        },
      },
      0,
      false,
      undefined,
      { bootId: 'source-boot', eventEpoch: 'source-epoch' },
    );
    await new ManagedHookActivationController(f.session).runTurn(
      f.promptId,
      async (scope) => {
        await scope.beginMainAttempt(
          'fixture',
          await publishHostedModelRequest(f.session, request),
        );
      },
    );
    await expect(findHostedModelRequest(f.session, f.promptId)).rejects.toThrow(
      'Invalid saved model request',
    );
  } finally {
    await f.session.close();
  }
});

it('retracts only the original streamed message after replacement, once', async () => {
  const f = await fixture();
  const prior = new HostedTextDeltaStream(f.session, f.promptId);
  await prior.delta('committed earlier round');
  const priorId = prior.takeMessageId();
  const orphan = new HostedTextDeltaStream(f.session, f.promptId);
  await orphan.delta('orphan one');
  await orphan.delta('orphan two');
  const id = orphan.takeMessageId()!;
  const source = {
    sourceActivation: f.session.activation,
    sourceBootId: 'old-boot',
    sourceEventEpoch: 'old-epoch',
  };
  const oldDeltas = f.session.authority
    .eventsInSequenceRange(1, f.session.authority.committedSequence)
    .filter(
      (event) =>
        event.kind === 'message.delta' && event.payload['messageId'] === id,
    );
  await f.session.close();
  const replacement = await f.reopen();
  try {
    const stream = new HostedTextDeltaStream(replacement, f.promptId);
    await stream.retractOriginal(id, source);
    await stream.retractOriginal(id, source);
    const retracts = replacement.authority
      .eventsInSequenceRange(1, replacement.authority.committedSequence)
      .filter((event) => event.kind === 'message.retracted');
    expect(retracts).toHaveLength(1);
    expect(retracts[0].payload).toEqual({
      messageId: id,
      turnId: f.promptId,
      fromSequence: oldDeltas[0].sequence,
      throughSequence: oldDeltas.at(-1)!.sequence,
      sourceBootId: 'old-boot',
      sourceEventEpoch: 'old-epoch',
    });
    expect(retracts[0].payload['messageId']).not.toBe(priorId);
    stream.bindMessageId(randomUUID());
    await stream.delta('surviving answer');
  } finally {
    await replacement.close();
  }
});

it.each([true, false])(
  'recognizes committed final output as terminal-only compensation (saved request=%s)',
  async (saved) => {
    const f = await fixture();
    try {
      const request = createHostedModelRequest(
        f.session,
        f.promptId,
        prepared,
        0,
        false,
        undefined,
        { bootId: 'source-boot', eventEpoch: 'source-epoch' },
      );
      await new ManagedHookActivationController(f.session).runTurn(
        f.promptId,
        async (scope) => {
          const finish = await scope.beginMainAttempt(
            'fixture',
            saved
              ? await publishHostedModelRequest(f.session, request)
              : undefined,
          );
          await finish(true, {});
        },
      );
      await f.session.sink.write({
        uuid: request.messageId,
        parentUuid: null,
        sessionId: f.session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        daemonPromptId: f.promptId,
        model: 'fixture',
        cwd: '/fixture',
        version: 'test',
        message: { role: 'model', parts: [{ text: 'already committed' }] },
      });
      expect(
        await findHostedModelRequest(f.session, f.promptId),
      ).toBeUndefined();
      expect(
        await findHostedCommittedModelOutput(f.session, f.promptId),
      ).toEqual(saved ? request : { promptId: f.promptId });
      await f.terminal();
      expect(
        f.session.authority
          .eventsInSequenceRange(1, f.session.authority.committedSequence)
          .filter(
            (event) =>
              event.kind === 'model.attempt' &&
              event.payload['state'] === 'started',
          ),
      ).toHaveLength(1);
    } finally {
      await f.session.close();
    }
  },
);

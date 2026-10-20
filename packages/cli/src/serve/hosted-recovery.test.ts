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
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
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
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_READ_PROFILE,
} from './hosted-workspace-profiles.js';

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

it.each([
  ['a'.repeat(243), false],
  ['a'.repeat(244), true],
  ['a'.repeat(496), true],
  ['猫'.repeat(140), true],
] as const)(
  'preserves cleanup identity through confirmation (case %#)',
  async (promptId, hashed) => {
    const f = await fixture(promptId);
    const original = `hosted-cleanup:${promptId}:${f.broker.runtimeSessionId}`;
    const expected = hashed
      ? `hosted-cleanup:${createHash('sha256').update(original).digest('hex')}`
      : original;
    const cleanupEvents = () =>
      f.session.authority
        .eventsInSequenceRange(1, f.session.authority.committedSequence)
        .filter((event) => event.kind === 'hosted.cleanup');
    try {
      await oweHostedTurnCleanup(f.session, promptId, f.broker);
      await oweHostedTurnCleanup(f.session, promptId, f.broker);
      expect(cleanupEvents()).toHaveLength(1);
      expect(cleanupEvents()[0]!.payload['cleanupId']).toBe(expected);
      expect(cleanupEvents()[0]!.eventId).toBe(`${expected}:owed`);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      await f.terminal();
      await reconcileHostedTurnCleanup(f.session, f.brokerOptions, promptId);
      await reconcileHostedTurnCleanup(f.session, f.brokerOptions, promptId);
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith({
        bindingId: 'original-binding',
        generation: '7',
      });
      expect(cleanupEvents().map((event) => event.payload['state'])).toEqual([
        'owed',
        'confirmed',
      ]);
      expect(cleanupEvents()[1]!.payload['cleanupId']).toBe(expected);
      expect(cleanupEvents()[1]!.eventId).toBe(`${expected}:confirmed`);
      expect(
        Buffer.byteLength(cleanupEvents()[1]!.eventId),
      ).toBeLessThanOrEqual(512);
      expect(hasHostedCleanupDebt(f.session)).toBe(false);
    } finally {
      await f.session.close();
    }
  },
);

it('journals cleanup for a maximum-length stable prompt without changing its owner', async () => {
  const f = await fixture();
  const promptId = 'a'.repeat(512);
  const broker = new HostedWorkspaceBroker(
    f.brokerOptions,
    f.session.authority.sessionHeader.sessionKey,
    hostedRuntimeSessionId(promptId),
  );
  broker.runtime = f.broker.runtime;
  try {
    await oweHostedTurnCleanup(f.session, promptId, broker);
    const event = f.session.authority
      .eventsInSequenceRange(1, f.session.authority.committedSequence)
      .findLast((event) => event.kind === 'hosted.cleanup')!;
    const original = `hosted-cleanup:${promptId}:${promptId}`;
    expect(event.payload['cleanupId']).toBe(
      `hosted-cleanup:${createHash('sha256').update(original).digest('hex')}`,
    );
    const descriptor = JSON.parse(
      (
        await f.session.resources.read(
          event.payload['descriptorRef'] as unknown as Parameters<
            typeof f.session.resources.read
          >[0],
        )
      ).toString('utf8'),
    );
    expect(descriptor).toMatchObject({
      promptId,
      runtimeSessionId: promptId,
      fileHistoryTurnId: promptId,
      ...broker.runtime,
    });
  } finally {
    await f.session.close();
  }
});

it.each([244, 245])(
  'confirms an existing raw cleanup identity after cold recovery (%s bytes)',
  async (length) => {
    const promptId = 'a'.repeat(length);
    const f = await fixture(promptId);
    const cleanupId = `hosted-cleanup:${promptId}:${f.broker.runtimeSessionId}`;
    const descriptorRef = await f.session.resources.publish(
      'hosted-turn-cleanup',
      Buffer.from(
        JSON.stringify({
          v: 1,
          sessionKey: f.session.authority.sessionHeader.sessionKey,
          promptId,
          runtimeSessionId: f.broker.runtimeSessionId,
          ...f.broker.runtime,
          fileHistoryTurnId: promptId,
        }),
      ),
    );
    try {
      // This exact legacy owed event fits; only its confirmation ID does not.
      await f.session.authority.appendExecutionEvent(
        {
          operation: 'hostedCleanup',
          commandId: `${cleanupId}:owed`,
          sessionKey: f.session.authority.sessionHeader.sessionKey,
          contentDigest: createHash('sha256')
            .update(`${descriptorRef.digest}:owed`)
            .digest('hex'),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `${cleanupId}:owed`,
          sessionKey: f.session.authority.sessionHeader.sessionKey,
          kind: 'hosted.cleanup',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: f.session.activation.activationId,
            ...f.session.activation,
          },
          payload: { cleanupId, descriptorRef, state: 'owed' },
        }),
        { class: 'harness', activation: f.session.activation },
      );
      await f.terminal();
    } finally {
      await f.session.close();
    }
    const replacement = await f.reopen();
    const events = () =>
      replacement.authority
        .eventsInSequenceRange(1, replacement.authority.committedSequence)
        .filter((event) => event.kind === 'hosted.cleanup');
    try {
      await oweHostedTurnCleanup(replacement, promptId, f.broker);
      expect(events()).toHaveLength(1);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      await reconcileHostedTurnCleanup(replacement, f.brokerOptions, promptId);
      await reconcileHostedTurnCleanup(replacement, f.brokerOptions, promptId);
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith({
        bindingId: 'original-binding',
        generation: '7',
      });
      expect(events().map((event) => event.payload)).toEqual([
        { cleanupId, descriptorRef, state: 'owed' },
        { cleanupId, descriptorRef, state: 'confirmed' },
      ]);
      expect(events()[1]!.eventId).not.toBe(`${cleanupId}:confirmed`);
      expect(Buffer.byteLength(events()[1]!.eventId)).toBeLessThanOrEqual(512);
      expect(hasHostedCleanupDebt(replacement)).toBe(false);
      await expect(
        oweHostedTurnCleanup(replacement, promptId, f.broker),
      ).rejects.toThrow('already released');
    } finally {
      await replacement.close();
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

it.each([
  'snapshot',
  'retired',
  'retired-new-call',
  'retired-release-lost',
  'retired-corrupt-outcome',
  'retired-workspace-changed',
  'retired-read-only',
  'retired-write-history-missing',
  'retired-multi-batch',
  // #13753 I3: a snapshot child's read profile resumes the same way.
  'retired-read-profile',
  'retired-read-profile-new-call',
])(
  'retains original cleanup through committed-result recovery (%s)',
  async (mode) => {
    const f = await fixture();
    const readProfile = mode.startsWith('retired-read-profile');
    const profile = readProfile
      ? HOSTED_WORKSPACE_READ_PROFILE
      : HOSTED_WORKSPACE_FILE_PROFILE;
    const readOnly = mode === 'retired-read-only' || readProfile;
    try {
      let runtime = f.broker.runtime;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'capabilityDigest',
        'get',
      ).mockReturnValue(WORKSPACE_CAPABILITY_DIGEST);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = runtime;
        },
      );
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockResolvedValue();
      let crashSnapshot = mode === 'snapshot';
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'fileHistory',
      ).mockImplementation(async (operation) => {
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
      });
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepare')
        .mockResolvedValueOnce('original-execution')
        .mockResolvedValue('second-execution');
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
          if (mode !== 'snapshot' && release.mock.calls.length === 1) {
            if (mode === 'retired-release-lost')
              throw new Error('lost original release reply');
            expect(hasHostedCleanupDebt(f.session)).toBe(true);
            expect(
              f.session.authority
                .eventsInSequenceRange(1, f.session.authority.committedSequence)
                .some((event) => event.kind === 'turn.settled'),
            ).toBe(false);
            return;
          }
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
        { profile },
      );
      const call = {
        name: readOnly ? 'read_file' : 'write_file',
        callId: 'original-call',
        args: readOnly
          ? { file_path: 'original.txt' }
          : { file_path: 'original.txt', content: 'written once' },
        isClientInitiated: false,
        prompt_id: f.promptId,
      };
      const originalRun = original.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'fixture',
        new AbortController().signal,
      );
      if (mode === 'snapshot')
        await expect(originalRun).rejects.toThrow(
          'Hosted tool turn requires recovery',
        );
      else await originalRun;
      if (mode === 'retired-multi-batch') {
        await original.consumeResults();
        original.setModelRound(1);
        const next = {
          ...call,
          name: 'read_file',
          callId: 'second-call',
          args: { file_path: 'original.txt' },
        };
        await original.execute(
          [next],
          [
            {
              functionCall: {
                id: next.callId,
                name: next.name,
                args: next.args,
              },
            },
          ],
          'fixture',
          new AbortController().signal,
        );
      }
      const authorization = await f.session.authority.harnessRunAuthorization();
      expect(authorization.status).toBe('runnable');
      if (authorization.status !== 'runnable') throw new Error('Not runnable');
      expect(authorization.checkpoint.continuation.phase).toBe('results_ready');
      if (readOnly)
        expect(
          f.session.authority.domainRecord('file_history'),
        ).toBeUndefined();
      if (mode === 'retired-write-history-missing') {
        const domainRecord = f.session.authority.domainRecord.bind(
          f.session.authority,
        );
        vi.spyOn(f.session.authority, 'domainRecord').mockImplementation(
          (domain) =>
            domain === 'file_history' ? undefined : domainRecord(domain),
        );
      }
      if (mode !== 'snapshot')
        runtime = {
          bindingId: 'replacement-binding',
          generation: '8',
          workspaceGeneration: mode === 'retired-workspace-changed' ? '4' : '3',
        };
      if (mode === 'retired-corrupt-outcome') {
        const read = f.session.resources.read.bind(f.session.resources);
        const outcome = authorization.checkpoint.tools!.items[0].outcomeRef!;
        vi.spyOn(f.session.resources, 'read').mockImplementation(
          async (ref) => {
            if (ref.resourceId === outcome.resourceId)
              throw new Error('corrupt original outcome');
            return read(ref);
          },
        );
      }
      const replacement = new HostedWorkspaceToolTurn(
        f.brokerOptions,
        f.session,
        harness,
        f.promptId,
        async () => {
          throw new Error('Recovery must not reexecute tools');
        },
        () => true,
        undefined,
        undefined,
        undefined,
        { profile },
      );
      if (
        mode === 'retired-release-lost' ||
        mode === 'retired-corrupt-outcome' ||
        mode === 'retired-workspace-changed' ||
        mode === 'retired-write-history-missing'
      ) {
        await expect(replacement.resumeCommittedResults()).rejects.toThrow(
          'Hosted tool turn requires recovery',
        );
        await expect(replacement.finish()).rejects.toThrow(
          'Hosted tool turn requires recovery',
        );
        expect(hasHostedCleanupDebt(f.session)).toBe(true);
        expect(acquire).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledTimes(
          mode === 'retired-release-lost' ? 1 : 0,
        );
        return;
      }
      await replacement.resumeCommittedResults(new AbortController().signal);
      await replacement.consumeResults();
      if (
        mode === 'retired-new-call' ||
        mode === 'retired-read-profile-new-call'
      ) {
        const next = { ...call, callId: 'new-call' };
        await expect(
          replacement.execute(
            [next],
            [
              {
                functionCall: {
                  id: next.callId,
                  name: next.name,
                  args: next.args,
                },
              },
            ],
            'fixture',
            new AbortController().signal,
          ),
        ).rejects.toThrow('Submit remaining tool work in a new Turn');
      }
      await replacement.finish();
      expect(release).toHaveBeenCalledTimes(mode === 'snapshot' ? 0 : 1);
      expect(acquire).toHaveBeenCalledTimes(mode === 'snapshot' ? 2 : 1);
      expect(prepare).toHaveBeenCalledTimes(
        mode === 'retired-multi-batch' ? 2 : 1,
      );
      expect(hasHostedCleanupDebt(f.session)).toBe(true);
      await f.terminal();
      await replacement.cleanup();
      expect(release).toHaveBeenCalledTimes(mode === 'snapshot' ? 1 : 2);
      expect(release).toHaveBeenCalledWith({
        bindingId: 'original-binding',
        generation: '7',
      });
      expect(execute).toHaveBeenCalledTimes(
        mode === 'retired-multi-batch' ? 2 : 1,
      );
      expect(hasHostedCleanupDebt(f.session)).toBe(false);
    } finally {
      await f.session.close();
    }
  },
);

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

it('restores a screenshot-sized model request from a cold session owner', async () => {
  const f = await fixture();
  const data = Buffer.alloc(5 * 1024 * 1024, 0x61).toString('base64');
  const content = {
    role: 'user',
    parts: [{ inlineData: { mimeType: 'image/png', data } }],
  };
  const request = createHostedModelRequest(
    f.session,
    f.promptId,
    {
      ...prepared,
      history: [content],
      request: { ...prepared.request, contents: [content] },
    },
    0,
    false,
    undefined,
    { bootId: 'source-boot', eventEpoch: 'source-epoch' },
  );
  await new ManagedHookActivationController(f.session).runTurn(
    f.promptId,
    async (scope) => {
      const ref = await publishHostedModelRequest(f.session, request);
      expect(ref?.byteLength).toBeGreaterThan(8 * 1024 * 1024);
      await scope.beginMainAttempt('fixture', ref);
    },
  );
  await f.session.close();
  const replacement = await f.reopen();
  try {
    expect(await findHostedModelRequest(replacement, f.promptId)).toEqual(
      request,
    );
  } finally {
    await replacement.close();
  }
});

it.each(
  [false, true].flatMap((finished) =>
    [0, 16].flatMap((round) =>
      [undefined, false, true].map((allowPersistentRetry) => ({
        finished,
        allowPersistentRetry,
        round,
      })),
    ),
  ),
)(
  'restores an unfinished request even when stream Finished was recorded (%s)',
  async ({ finished, allowPersistentRetry, round }) => {
    const f = await fixture();
    const request = createHostedModelRequest(
      f.session,
      f.promptId,
      {
        ...prepared,
        ...(allowPersistentRetry === undefined ? {} : { allowPersistentRetry }),
      },
      round,
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
        workspaceContext: 'x'.repeat(32 * 1024 * 1024),
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

it.each([true, false, 'image-history'])(
  'recognizes committed final output as terminal-only compensation (saved request=%s)',
  async (saved) => {
    const f = await fixture();
    try {
      const request = createHostedModelRequest(
        f.session,
        f.promptId,
        saved === 'image-history'
          ? {
              ...prepared,
              history: [
                {
                  role: 'user',
                  parts: [
                    { text: '[Image #0123456789ab: image/png, 3 bytes]' },
                  ],
                },
              ],
            }
          : prepared,
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
      if (saved === 'image-history')
        expect(
          await findHostedModelRequest(f.session, f.promptId),
        ).toBeUndefined();
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

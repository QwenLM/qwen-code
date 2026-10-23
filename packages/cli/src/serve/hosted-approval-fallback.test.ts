/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  createHttpManagedSessionStores,
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HOSTED_APPROVAL_OPTIONS,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';

it.each([
  { padding: 62_000, decision: 'allow' },
  { padding: 63_080, decision: 'allow' },
])(
  'keeps final-plan recovery consistent with approval at $padding content bytes',
  async ({ padding, decision }) => {
    const limit = HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
    const root = await mkdtemp(path.join(tmpdir(), 'g3-approval-inline-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    };
    const promptId = randomUUID();
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    const session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'approval-inline-test',
      workerId: 'approval-inline-test',
      activationLeaseDurationMs: 60_000,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              toolProfile: 'hosted-workspace-files/1',
            }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from('{}'),
        ),
        createdBy: 'approval-inline-test',
      },
    });
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    let releasePrepare: (() => void) | undefined;
    try {
      const content = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'write original.txt' }]),
      );
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
          source: 'approval-inline-test',
          contentRef: await resources.publish('managed-input', content),
          admissionRef: await resources.publish(
            'managed-admission',
            Buffer.from('{}'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      const harness = createManagedHarnessHandle(session);
      await harness.ensureRunnable();
      const remote = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:1',
        sessionKey,
        writerId: 'approval-inline-test',
      });
      const published: Array<{
        kind: string;
        bytes: number;
        plan?: Record<string, unknown>;
      }> = [];
      const localPublish = session.resources.publish.bind(session.resources);
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind, bytes) => {
          published.push({
            kind,
            bytes: bytes.byteLength,
            ...(kind === 'hosted-approval-continuation'
              ? { plan: JSON.parse(bytes.toString()) }
              : {}),
          });
          await remote.resourceStore.publish(kind, bytes);
          return localPublish(kind, bytes);
        },
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'capabilityDigest',
        'get',
      ).mockReturnValue(WORKSPACE_CAPABILITY_DIGEST);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'original-binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'fileHistory',
      ).mockResolvedValue({
        ownerSessionId: sessionKey.sessionId,
        snapshots: [],
        files: {},
      });
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepare')
        .mockImplementation(
          () =>
            new Promise<string>((resolve) => {
              releasePrepare = () => resolve('original-execution');
            }),
        );
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'file written' }],
        });
      const waiters = new HostedApprovalWaiters();
      const turn = new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        session,
        harness,
        promptId,
        async (type, parts, model, identity) => {
          const uuid = identity?.uuid ?? randomUUID();
          await session.sink.write({
            uuid,
            parentUuid: null,
            sessionId: sessionKey.sessionId,
            timestamp: identity?.timestamp ?? new Date().toISOString(),
            type,
            model,
            cwd: root,
            version: 'approval-inline-test',
            daemonPromptId: promptId,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
          });
          return uuid;
        },
        (_type, parts) => Buffer.byteLength(JSON.stringify(parts)) <= limit,
        undefined,
        undefined,
        { settings: { mode: 'default', timeoutMs: 60_000 }, waiters },
      );
      const call = {
        name: 'write_file',
        callId: 'original-call',
        args: { file_path: 'original.txt', content: 'x'.repeat(padding) },
        isClientInitiated: false,
        prompt_id: promptId,
      };
      running = turn
        .execute(
          [call],
          [
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'fixture-model',
          controller.signal,
        )
        .catch((cause) => cause);
      let requestId = '';
      // Same family as #14084: the observed chain is a serial run of
      // fsync-backed publishes and journal commits; 5s flaked on the
      // loaded deterministic-verification runner.
      await vi.waitFor(
        async () => {
          const authorization =
            await session.authority.harnessRunAuthorization();
          expect(authorization.status).toBe('runnable');
          if (authorization.status !== 'runnable')
            throw new Error('not runnable');
          expect(authorization.checkpoint.continuation.phase).toBe(
            'await_action',
          );
          requestId = authorization.checkpoint.approval!.requestId;
          expect(session.authority.action(requestId)?.state).toBe('requested');
        },
        { timeout: 10_000 },
      );
      const action = session.authority.action(requestId)!;
      const options = JSON.parse(
        (await session.resources.read(action.optionsRef!)).toString(),
      );
      expect(options.v).toBe(padding === 62_000 ? 3 : 2);
      if (padding === 63_080)
        expect(options).not.toHaveProperty('continuationRef');
      expect(
        published.find((item) => item.kind === 'managed-message')!.bytes,
      ).toBeLessThanOrEqual(limit);
      expect(
        published.find((item) => item.kind === 'managed-tool-input')!.bytes,
      ).toBeLessThanOrEqual(limit);
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      await expect(
        resolveHostedAction(session, waiters, requestId, {
          optionId: decision,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        }),
      ).resolves.toMatchObject({ status: 200 });
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1), {
        timeout: 10_000,
      });
      expect(execute).not.toHaveBeenCalled();
      const plans = published.filter(
        (item) => item.kind === 'hosted-approval-continuation',
      );
      const finalEvents = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'hosted.batch.planned');
      expect(plans).toHaveLength(padding === 62_000 ? 2 : 0);
      expect(finalEvents).toHaveLength(padding === 62_000 ? 1 : 0);
      expect(published.every((item) => item.bytes <= limit)).toBe(true);
      const restored = await findHostedApprovalContinuation(session, promptId);
      if (padding === 62_000) expect(restored?.plan.stage).toBe('final');
      else expect(restored).toBeUndefined();
      releasePrepare!();
      expect(await running).not.toBeInstanceOf(Error);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.parse(execute.mock.calls[0][1]).input).toEqual(call.args);
      await turn.consumeResults();
      await turn.finish();
    } finally {
      controller.abort();
      releasePrepare?.();
      await running;
      vi.restoreAllMocks();
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

function approvalSelectionFixture(
  legacyVersion: 1 | 2,
  final: boolean,
  previousBatch = false,
) {
  const bytes = new Map<string, Buffer>();
  const resource = (kind: string, body: object): ManagedSessionDurableRef => {
    const data = Buffer.from(JSON.stringify(body));
    const ref = {
      resourceId: `resource-${bytes.size}`,
      kind,
      schemaVersion: 1,
      byteLength: data.byteLength,
      digest: createHash('sha256').update(data).digest('hex'),
    };
    bytes.set(ref.resourceId, data);
    return ref;
  };
  const planRef = resource('hosted-approval-continuation', {});
  const inputRef = resource('managed-tool-input', {});
  const optionsRef = (
    requestId: string,
    functionCallId: string,
    v: 1 | 2 | 3,
  ) =>
    resource('managed-action-options', {
      v,
      requestId,
      turnId: 'prompt',
      functionCallId,
      toolName: 'write_file',
      policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      inputRevision: 1,
      createdAt: 1,
      expiresAt: 60_001,
      options: HOSTED_APPROVAL_OPTIONS,
      ...(v >= 2 ? { inputRef } : {}),
      ...(v === 3 ? { continuationRef: planRef } : {}),
    });
  const actions = new Map([
    [
      'first',
      {
        requestId: 'first',
        inputRevision: 1,
        optionsRef: optionsRef('first', 'call-first', 3),
      },
    ],
    [
      'legacy',
      {
        requestId: 'legacy',
        inputRevision: 1,
        optionsRef: optionsRef('legacy', 'call-legacy', legacyVersion),
      },
    ],
  ]);
  const request = (requestId: string, sequence: number) => ({
    kind: 'action.changed',
    sequence,
    payload: { requestId, source: 'tool_call', state: 'requested' },
  });
  const events = [
    ...(previousBatch ? [request('legacy', 9)] : []),
    {
      kind: 'message.committed',
      sequence: 10,
      payload: { messageId: 'current-batch', role: 'assistant' },
    },
    request('first', 11),
    ...(previousBatch
      ? [
          {
            kind: 'action.changed',
            sequence: 12,
            payload: {
              requestId: 'legacy',
              source: 'tool_call',
              state: 'cancelled',
            },
          },
        ]
      : [request('legacy', 12)]),
    ...(final
      ? [
          {
            kind: 'hosted.batch.planned',
            sequence: 13,
            payload: { batchId: 'current-batch', planRef },
          },
        ]
      : []),
  ];
  const read = vi.fn(async (ref: ManagedSessionDurableRef) => {
    if (ref.resourceId === planRef.resourceId)
      throw new Error('current plan selected');
    return bytes.get(ref.resourceId)!;
  });
  const session = {
    authority: {
      committedSequence: 13,
      harnessRunAuthorization: async () => ({
        status: 'runnable',
        checkpoint: {
          continuation: {
            phase: final ? 'model_output_committed' : 'await_action',
          },
        },
      }),
      eventsInSequenceRange: () => events,
      action: (id: string) => actions.get(id),
    },
    sink: {
      project: async () => [
        {
          uuid: 'current-batch',
          type: 'assistant',
          daemonPromptId: 'prompt',
          message: {
            parts: ['call-first', 'call-legacy'].map((id) => ({
              functionCall: { id },
            })),
          },
        },
      ],
    },
    resources: { read },
  } as unknown as ManagedSession;
  return { session, read, planRef };
}

it.each([
  { legacyVersion: 1 as const, final: false },
  { legacyVersion: 2 as const, final: false },
  { legacyVersion: 1 as const, final: true },
  { legacyVersion: 2 as const, final: true },
])(
  'declines a current v$legacyVersion approval before selecting a plan (final=$final)',
  async ({ legacyVersion, final }) => {
    const { session, read, planRef } = approvalSelectionFixture(
      legacyVersion,
      final,
    );
    await expect(
      findHostedApprovalContinuation(session, 'prompt'),
    ).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalledWith(planRef);
  },
);

it('keeps a later batch recoverable when an earlier legacy Action updates', async () => {
  const { session, read, planRef } = approvalSelectionFixture(2, true, true);
  await expect(
    findHostedApprovalContinuation(session, 'prompt'),
  ).rejects.toThrow('current plan selected');
  expect(read).toHaveBeenCalledWith(planRef);
});

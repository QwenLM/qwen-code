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
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import {
  endHostedAction,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';

afterEach(() => vi.restoreAllMocks());

it.each(['allow', 'deny', 'cancelled', 'expired'])(
  'restores the original native batch and final Action under a replacement owner (%s)',
  async (decision) => {
    const root = await mkdtemp(path.join(tmpdir(), 'g3-step3-baseline-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: randomUUID(),
    };
    const promptId = randomUUID();
    const options = {
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: sessionKey.sessionId,
      sessionKey,
      version: 'g3-step3-baseline',
      activationLeaseDurationMs: 60_000,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    const first = await openManagedSession({
      ...options,
      workerId: 'baseline-original',
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
        createdBy: 'baseline-probe',
      },
    });
    let closed = false;
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      const harness = createManagedHarnessHandle(first);
      const content = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'write original.txt' }]),
      );
      await first.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: promptId,
          sessionKey,
          contentDigest: createHash('sha256').update(content).digest('hex'),
        },
        {
          inputId: promptId,
          turnId: promptId,
          source: 'baseline-probe',
          contentRef: await resources.publish('managed-input', content),
          admissionRef: await resources.publish(
            'managed-admission',
            Buffer.from('{}'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      await harness.ensureRunnable();
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
      const prepare = vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare');
      const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
      const turn = new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'fixture-no-traffic' },
        first,
        harness,
        promptId,
        async (type, parts, model, identity) => {
          const uuid = identity?.uuid ?? randomUUID();
          await first.sink.write({
            uuid,
            parentUuid: null,
            sessionId: sessionKey.sessionId,
            timestamp: identity?.timestamp ?? new Date().toISOString(),
            type,
            model,
            cwd: root,
            version: 'g3-step3-baseline',
            daemonPromptId: promptId,
            message: { role: type === 'assistant' ? 'model' : 'user', parts },
          });
          return uuid;
        },
        () => true,
        undefined,
        undefined,
        {
          settings: { mode: 'default', timeoutMs: 60_000 },
          waiters: new HostedApprovalWaiters(),
        },
      );
      const call = {
        name: 'write_file',
        callId: 'original-call',
        args: { file_path: 'original.txt', content: 'one original batch' },
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
      await vi.waitFor(
        async () => {
          const authorization = await first.authority.harnessRunAuthorization();
          expect(authorization.status).toBe('runnable');
          if (authorization.status !== 'runnable')
            throw new Error('not runnable');
          expect(authorization.checkpoint.continuation.phase).toBe(
            'await_action',
          );
          requestId = authorization.checkpoint.approval!.requestId;
          expect(first.authority.action(requestId)?.state).toBe('requested');
        },
        { timeout: 10_000 },
      );
      const action = first.authority.action(requestId)!;
      const descriptor = JSON.parse(
        (await first.resources.read(action.optionsRef!)).toString(),
      );
      await first.close();
      closed = true;
      controller.abort();
      await running;
      const replacement = await openManagedSession({
        ...options,
        workerId: 'baseline-replacement',
      });
      try {
        expect(replacement.authority.action(requestId)?.state).toBe(
          'requested',
        );
        if (decision === 'allow' || decision === 'deny') {
          const answer = await resolveHostedAction(
            replacement,
            new HostedApprovalWaiters(),
            requestId,
            {
              optionId: decision,
              inputRevision: 1,
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            },
          );
          expect(answer.status).toBe(200);
        } else {
          await endHostedAction(
            replacement,
            requestId,
            decision as 'cancelled' | 'expired',
          );
        }
        const saved = await findHostedApprovalContinuation(
          replacement,
          promptId,
        );
        expect(saved?.plan).toMatchObject({
          promptId,
          batchId: first.authority
            .eventsInSequenceRange(1, first.authority.committedSequence)
            .find(
              (event) =>
                event.kind === 'message.committed' &&
                event.payload['role'] === 'assistant',
            )?.payload['messageId'],
          stage: 'approval',
          actionId: requestId,
          runtime: {
            bindingId: 'original-binding',
            generation: '1',
            runtimeSessionId: promptId,
          },
        });
        expect(saved!.plan.calls[0].call).toEqual(call);
        expect(saved!.plan.calls[0].prepareKey).toBe(
          `${promptId}:${saved!.plan.calls[0].runtimeCallId}`,
        );
        expect(saved!.inputs[0].input).toEqual(call.args);
        expect(descriptor.v).toBe(3);
        expect(prepare).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        const harness = createManagedHarnessHandle(replacement);
        await harness.resolveDurableWait();
        await harness.adoptPreparedContinuation(promptId);
        const adopted = await replacement.authority.harnessRunAuthorization();
        expect(adopted).toMatchObject({
          status: 'runnable',
          checkpoint: {
            identity: { activationId: replacement.activation.activationId },
            continuation: { phase: 'model_output_committed' },
          },
        });
      } finally {
        await replacement.close();
      }
    } finally {
      controller.abort();
      await running;
      if (!closed) await first.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

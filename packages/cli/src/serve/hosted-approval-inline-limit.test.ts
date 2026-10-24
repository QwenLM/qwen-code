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
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  createHttpManagedSessionStores,
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';

it.each([
  { padding: 62_000, decision: 'allow' },
  { padding: 62_000, decision: 'deny' },
  { padding: 63_500, decision: 'allow' },
  { padding: 63_500, decision: 'deny' },
])(
  'completes native approval at $padding content bytes ($decision)',
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
      const published: Array<{ kind: string; bytes: number }> = [];
      const localPublish = session.resources.publish.bind(session.resources);
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind, bytes) => {
          published.push({ kind, bytes: bytes.byteLength });
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
        .mockResolvedValue('original-execution');
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
      // #14084: the observed chain is a serial run of fsync-backed publishes
      // and journal commits; 5s flaked on a loaded ubuntu-latest runner.
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
      if (padding === 63_500)
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
      const result = await running;
      expect(result).not.toBeInstanceOf(Error);
      expect(prepare).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
      expect(execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
      if (decision === 'allow') {
        expect(JSON.parse(execute.mock.calls[0][1]).input).toEqual(call.args);
        expect(result).toMatchObject([
          {
            functionResponse: {
              id: call.callId,
              response: { executionStatus: 'success' },
            },
          },
        ]);
      } else {
        expect(JSON.stringify(result)).toContain('owner denied');
      }
      const plans = published.filter(
        (item) => item.kind === 'hosted-approval-continuation',
      );
      expect(plans).toHaveLength(padding === 62_000 ? 2 : 0);
      expect(published.every((item) => item.bytes <= limit)).toBe(true);
      await turn.consumeResults();
      await turn.finish();
      expect(await session.authority.harnessRunAuthorization()).toMatchObject({
        status: 'runnable',
        checkpoint: {
          continuation: {
            phase:
              decision === 'allow' ? 'turn_settled' : 'model_output_committed',
          },
        },
      });
    } finally {
      controller.abort();
      await running;
      vi.restoreAllMocks();
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

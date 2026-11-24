/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  files,
  useToolApprovals,
  waitFor,
} from './hosted-harness-session-approvals.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import {
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_APPROVAL_TIMEOUT_MS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  endHostedAction,
  readHostedActionOptions,
  resolveHostedAction,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';
import { HOSTED_QUESTION_POLICY } from './hosted-user-question.js';

describe('Hosted Harness tool approvals', () => {
  useToolApprovals();

  const questionResponse = {
    answers: [{ questionId: 'q1', optionIds: ['q1o2'] }],
    inputRevision: 1,
    policyRevision: HOSTED_QUESTION_POLICY,
  };

  async function parkedQuestion(
    pinned = true,
    terminal?: 'cancelled' | 'expired' | 'decided',
    timeoutMs = 60_000,
  ) {
    const runtime = {
      bindingId: 'question-original-binding',
      generation: '7',
      workspaceGeneration: '3',
    };
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const claims = new WeakMap<HostedWorkspaceBroker, string>();
    const calls: string[] = [];
    let provisionerKind = pinned ? 'local-process' : undefined;
    const warm = vi.mocked(HostedWorkspaceBroker.prototype.warm);
    warm.mockImplementation(async function (this: HostedWorkspaceBroker) {
      calls.push('warm');
      this.runtime = { ...runtime };
      this.provisionerKind = provisionerKind;
    });
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      calls.push('acquire');
      this.runtime = { ...runtime };
      this.provisionerKind = provisionerKind;
      claims.set(this, randomUUID());
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockImplementation(
      function (this: HostedWorkspaceBroker) {
        return claims.get(this);
      },
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockImplementation(async function (this: HostedWorkspaceBroker, claim) {
        expect(claim).toBe(claims.get(this));
        calls.push('releaseMount');
      });
    const wait = vi
      .spyOn(HostedApprovalWaiters.prototype, 'wait')
      .mockRejectedValueOnce(
        new HostedToolRecoveryRequiredError('question writer interrupted'),
      );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'ask_user_question',
        callId: 'question-original-call',
        args: {
          questions: [
            {
              question: 'Which target?',
              header: 'Target',
              options: [
                { label: 'A', description: 'First target' },
                { label: 'B', description: 'Second target' },
              ],
            },
          ],
        },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      throw new Error('Interrupted question unexpectedly continued.');
    });
    const original = await app(true);
    const created = await headers(supertest(original).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
        approvalMode: 'yolo',
        approvalTimeoutMs: timeoutMs,
      })
      .expect(200);
    const originalRequest = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const prompt = [{ type: 'text', text: 'Ask for the target' }];
    await originalRequest(
      supertest(original).post(`/session/${SESSION_ID}/prompt`),
    )
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await originalRequest(
        supertest(original).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      });
    });
    const managed = (wakeDeps.last as { session: { managed: ManagedSession } })
      .session.managed;
    const saved = await findHostedApprovalContinuation(managed, PROMPT_ID);
    expect(saved?.plan.stage).toBe('approval');
    expect(saved?.plan.runtime).toEqual({
      ...runtime,
      runtimeSessionId: PROMPT_ID,
      ...(pinned ? { provisionerKind: 'local-process' } : {}),
    });
    const requestId = saved!.plan.actionId!;
    const options = await readHostedActionOptions(
      managed,
      managed.authority.action(requestId)!,
    );
    if (terminal === 'decided')
      expect(
        (
          await resolveHostedAction(
            managed,
            new HostedApprovalWaiters(),
            requestId,
            questionResponse,
          )
        ).status,
      ).toBe(200);
    else if (terminal) await endHostedAction(managed, requestId, terminal);
    await managed.close();
    provisionerKind = 'local-process';
    wait.mockRestore();
    state.model.mockReset();
    state.model.mockImplementation(
      async ({ resumeFromToolResults, signal }) => {
        signal.throwIfAborted();
        expect(JSON.stringify(resumeFromToolResults)).toContain('q1o2');
        calls.push('model');
        return { text: 'question recovered', model: 'test-model' };
      },
    );
    warm.mockClear();
    acquire.mockClear();
    releaseMount.mockClear();
    calls.length = 0;
    const replacement = await app(true);
    return {
      runtime,
      calls,
      warm,
      acquire,
      releaseMount,
      requestId,
      expiresAt: options.expiresAt,
      replacement,
      async load() {
        const loaded = await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        )
          .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
          .expect(200);
        return (request: supertest.Test) =>
          headers(request).set(
            'X-Qwen-Client-Id',
            loaded.body.clientId as string,
          );
      },
    };
  }

  it.each([true, false])(
    'cold question recovery preserves owner acquisition order (pinned: %s)',
    async (pinned) => {
      const f = await parkedQuestion(pinned);
      const authorize = await f.load();
      if (pinned)
        await waitFor(() =>
          expect(f.calls).toEqual(['acquire', 'releaseMount']),
        );
      else expect(f.calls).toEqual([]);
      expect(f.warm).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(
        supertest(f.replacement).post(
          `/session/${SESSION_ID}/actions/${f.requestId}/resolve`,
        ),
      )
        .send(questionResponse)
        .expect(200);
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(f.calls).toEqual(
        pinned
          ? ['acquire', 'releaseMount', 'acquire', 'model']
          : ['warm', 'acquire', 'model'],
      );
      for (const [expected] of f.acquire.mock.calls)
        expect(expected).toEqual({
          runtimeBindingId: f.runtime.bindingId,
          generation: f.runtime.generation,
        });
      expect(
        f.acquire.mock.contexts.every(
          (broker) =>
            (broker as HostedWorkspaceBroker).runtimeSessionId === PROMPT_ID,
        ),
      ).toBe(true);
      if (pinned)
        expect(f.acquire.mock.contexts[0]).toBe(f.acquire.mock.contexts[1]);
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      if (!pinned) {
        const managed = (
          wakeDeps.last as { session: { managed: ManagedSession } }
        ).session.managed;
        const final = managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .findLast((event) => event.kind === 'hosted.batch.planned')!;
        const planRef = assertManagedSessionDurableRef(
          final.payload['planRef'],
          'final question plan',
        );
        const plan = JSON.parse(
          (await managed.resources.read(planRef)).toString(),
        ) as { runtime: object };
        expect(plan.runtime).not.toHaveProperty('provisionerKind');
      }
      await authorize(
        supertest(f.replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each(['cancelled', 'expired'] as const)(
    'cold question recovery settles %s without acquiring a Runtime',
    async (terminal) => {
      const f = await parkedQuestion(true, terminal);
      const authorize = await f.load();
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(f.calls).toEqual([]);
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
      expect(f.releaseMount).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(
        supertest(f.replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each(['cancelled', 'expired', 'decided-then-cancelled'] as const)(
    'cold question recovery stops a busy owner safely (%s)',
    async (outcome) => {
      const decided = outcome === 'decided-then-cancelled';
      const f = await parkedQuestion(
        true,
        decided ? 'decided' : undefined,
        5000,
      );
      f.acquire.mockRejectedValue(
        new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
      );
      const authorize = await f.load();
      await waitFor(() => expect(f.acquire).toHaveBeenCalled());
      if (outcome === 'expired')
        vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
      else
        await authorize(
          supertest(f.replacement).post(`/session/${SESSION_ID}/cancel`),
        )
          .send({ promptId: PROMPT_ID })
          .expect(204);
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(f.acquire).toHaveBeenCalledOnce();
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.releaseMount).not.toHaveBeenCalled();
      if (decided) {
        expect(state.model).toHaveBeenCalledOnce();
        expect(state.model.mock.calls[0][0].signal.aborted).toBe(true);
      } else expect(state.model).not.toHaveBeenCalled();
      expect(f.calls).not.toContain('model');
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      const managed = (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed;
      expect(managed.authority.action(f.requestId)?.state).toBe(
        decided ? 'decided' : outcome,
      );
      const results = (await managed.sink.project()).filter(
        (item) => item.type === 'tool_result',
      );
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results)).not.toContain('q1o2');
      expect(
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .findLast(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          )?.payload,
      ).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
      await managed.close();
    },
  );

  it('cold question recovery settles cancellation after the original owner is acquired', async () => {
    const f = await parkedQuestion(true, 'decided');
    const acquire = f.acquire.getMockImplementation()!;
    f.acquire.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      expected,
    ) {
      await acquire.call(this, expected);
      (
        wakeDeps.last as { session: { active: { abort: AbortController } } }
      ).session.active.abort.abort();
    });
    const authorize = await f.load();
    const managed = (wakeDeps.last as { session: { managed: ManagedSession } })
      .session.managed;
    try {
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
      const status = await authorize(
        supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      expect(f.acquire).toHaveBeenCalledOnce();
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.calls).not.toContain('model');
      expect(
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .findLast(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          )?.payload,
      ).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
    } finally {
      await managed.close();
    }
  });

  it.each([
    'bindingId',
    'generation',
    'workspaceGeneration',
    'provisionerKind',
  ])(
    'cold question recovery blocks changed %s without warming a substitute',
    async (changed) => {
      const f = await parkedQuestion();
      f.acquire.mockImplementation(async function (
        this: HostedWorkspaceBroker,
      ) {
        this.runtime = {
          ...f.runtime,
          ...(changed !== 'provisionerKind' ? { [changed]: 'changed' } : {}),
        };
        this.provisionerKind =
          changed === 'provisionerKind' ? 'ssh' : 'local-process';
      });
      const authorize = await f.load();
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      });
      expect(f.acquire).toHaveBeenCalledExactlyOnceWith({
        runtimeBindingId: f.runtime.bindingId,
        generation: f.runtime.generation,
      });
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.releaseMount).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      await (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed.close();
    },
  );

  it.each(['write_file', 'exit_plan_mode'] as const)(
    'rechecks live approval after a cold restore while preserving %s approval semantics',
    async (toolName) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'original-binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      const wait = vi
        .spyOn(HostedApprovalWaiters.prototype, 'wait')
        .mockRejectedValueOnce(
          new HostedToolRecoveryRequiredError('writer lost during approval'),
        );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: toolName,
          callId: 'original-call',
          args:
            toolName === 'write_file'
              ? { file_path: 'notes.txt', content: 'hello' }
              : { plan: 'Write the notes after approval.' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
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
          'test-model',
          signal,
        );
        return { text: 'not reached', model: 'test-model' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: files,
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          ...(toolName === 'exit_plan_mode'
            ? {
                approvalSelection: {
                  mode: 'default',
                  revision: 1,
                  planMode: true,
                },
              }
            : {}),
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      });
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const action = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!;
      expect(action).toBeDefined();
      const requestId = action.payload['requestId'] as string;
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
      wait.mockRestore();
      state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 2 });
      state.model.mockResolvedValue({ text: 'done', model: 'test-model' });
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      if (toolName === 'exit_plan_mode') {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
        await headers(
          supertest(replacement).post(
            `/session/${SESSION_ID}/actions/${requestId}/resolve`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            optionId: 'deny',
            inputRevision: 1,
            policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
          })
          .expect(200);
      }
      await waitFor(async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(
        toolName === 'write_file' ? 1 : 0,
      );
      const restored = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        restored.events.filter(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['requestId'] === requestId &&
            event.payload['state'] === 'decided',
        ),
      ).toHaveLength(1);
      await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .expect(204);
    },
  );

  it.each([
    ['hosted-workspace-files/1', true],
    ['hosted-workspace-files/2', false],
    ['hosted-workspace-files/3', true],
    ['hosted-workspace-shell/1', true],
    ['hosted-workspace-read/1', false],
  ] as const)(
    'queries live policy only for eligible profile %s',
    async (toolProfile, live) => {
      state.model.mockImplementation(async ({ toolTurn, signal }) => {
        const call = {
          name: 'read_file',
          callId: randomUUID(),
          args: { file_path: 'notes.txt' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
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
          'test-model',
          signal,
        );
        await toolTurn!.consumeResults();
        return { text: 'done', model: 'test-model' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile,
          approvalMode: 'yolo',
        })
        .expect(200);
      const prompt = [{ type: 'text', text: 'read notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(state.approvalQueries.length > 0).toBe(live);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
    },
  );

  async function definitions(): Promise<unknown[]> {
    const paths = (await readdir(state.root, { recursive: true })).filter(
      (entry) =>
        entry.includes(`managed-definition${path.sep}`) &&
        !path.basename(entry).startsWith('.'),
    );
    return Promise.all(
      paths.map(async (entry) =>
        JSON.parse(await readFile(path.join(state.root, entry), 'utf8')),
      ),
    );
  }

  it('accepts the classifier auto mode for a files Session', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'auto',
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('auto');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('pins a mode that can ask at creation and refuses other modes', async () => {
    const server = await app(true);
    const create = (extra: Record<string, unknown>) =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...extra,
      });
    for (const extra of [
      { approvalMode: 'plan' },
      { approvalMode: null },
      { approvalMode: 'default', approvalTimeoutMs: 999 },
    ]) {
      const refused = await create({ toolProfile: files, ...extra });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_hosted_approval');
    }
    expect(await definitions()).toEqual([]);

    const noTools = await create({ approvalMode: 'plan' });
    expect(noTools.status).toBe(200);
    expect(noTools.body).not.toHaveProperty('approvalMode');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      noTools.body.clientId as string,
    );
    expect(await definitions()).toEqual([
      { engine: 'managed', sessionId: SESSION_ID },
    ]);
  });

  it.each([
    { approvalMode: 'plan', approvalTimeoutMs: 60_000 },
    { approvalMode: 'default' },
    { approvalTimeoutMs: 60_000 },
  ])(
    'refuses to load a tool Session whose saved approval is %o',
    async (saved) => {
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const managed = await openManagedSession({
        runtimeBaseDir: state.root,
        transcriptPath: '',
        sessionId: SESSION_ID,
        sessionKey,
        cwd: state.root,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        }),
        resourceStore,
        create: {
          definitionRef: await resourceStore.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: files,
                ...saved,
              }),
            ),
          ),
          rootSnapshotRef: await resourceStore.publish(
            'managed-root',
            Buffer.from(JSON.stringify({ cwd: state.root })),
          ),
          createdBy: 'hosted-harness',
        },
        requireNew: true,
      });
      await managed.close();
      const loaded = await headers(
        supertest(await app(true)).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(409);
      expect(loaded.body.code).toBe('hosted_tool_profile_conflict');
    },
  );

  it('pins valid approval settings for a selectable yolo Session', async () => {
    const created = await headers(
      supertest(await app(true)).post('/session'),
    ).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'yolo',
      approvalTimeoutMs: 5,
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('yolo');
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'yolo',
        approvalTimeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
      },
    ]);
  });

  it.each(['default', 'auto-edit', 'auto', 'yolo'] as const)(
    'keeps custom initial %s identity and timeout while applying live and cold Turn overrides',
    async (initialMode) => {
      const identity = {
        agentId: `agent_${'a'.repeat(32)}`,
        revision: '1',
        digest: 'b'.repeat(64),
      };
      const agentDefinition = { ...identity, model: { id: 'configured' } };
      const requestIds: string[] = [];
      const wait = HostedApprovalWaiters.prototype.wait;
      vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
        function (this: HostedApprovalWaiters, requestId, ...rest) {
          requestIds.push(requestId);
          return wait.call(this, requestId, ...rest);
        },
      );
      state.model.mockImplementation(async ({ toolTurn, signal }) => {
        const call = {
          name: 'write_file',
          callId: randomUUID(),
          args: { file_path: 'override.txt', content: 'selected' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
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
          'test-model',
          signal,
        );
        await toolTurn!.consumeResults();
        return { text: 'done', model: 'test-model' };
      });
      let server = await app(true);
      const createBody = {
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
        approvalMode: initialMode,
        approvalTimeoutMs: 12_345,
        agentDefinition,
      };
      const created = await headers(supertest(server).post('/session')).send(
        createBody,
      );
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const saved = {
        engine: 'managed',
        sessionId: SESSION_ID,
        agentDefinition,
        toolProfile: files,
        ...(initialMode === 'yolo'
          ? {}
          : {
              approvalMode: initialMode,
              approvalTimeoutMs: 12_345,
            }),
      };
      expect(await definitions()).toEqual([saved]);
      const initialJournal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const send = async (mode: 'default' | 'yolo', revision: number) => {
        const prompt = [
          { type: 'text', text: 'write using the admitted policy' },
        ];
        const promptId = randomUUID();
        const askedBefore = requestIds.length;
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            approvalSelection: { mode, revision },
          })
          .expect(202);
        if (mode === 'default') {
          await waitFor(() => expect(requestIds).toHaveLength(askedBefore + 1));
          const resources = LocalManagedSessionResourceStore.create({
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          const journal = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          const requested = journal.events.findLast(
            (event) =>
              event.kind === 'action.changed' &&
              event.payload['requestId'] === requestIds.at(-1),
          );
          const options = JSON.parse(
            (
              await resources.read(
                assertManagedSessionDurableRef(
                  requested!.payload['optionsRef'],
                  'approval options',
                ),
              )
            ).toString('utf8'),
          );
          expect(options.expiresAt - options.createdAt).toBe(
            initialMode === 'yolo' ? HOSTED_APPROVAL_TIMEOUT_MS : 12_345,
          );
          await headers(
            supertest(server).post(
              `/session/${SESSION_ID}/actions/${requestIds.at(-1)}/resolve`,
            ),
          )
            .set('X-Qwen-Client-Id', clientId)
            .send({
              optionId: 'allow',
              inputRevision: 1,
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            })
            .expect(200);
        }
        await waitFor(async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        });
        expect(requestIds).toHaveLength(
          askedBefore + (mode === 'default' ? 1 : 0),
        );
      };
      await send('default', 1);
      await send('yolo', 2);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      server = await app(true);
      // An earlier committed create whose ACK was lost still conflicts;
      // the connector must load its original definition instead of recreating it.
      await headers(supertest(server).post('/session'))
        .send(createBody)
        .expect(409);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: files,
        agentDefinition: identity,
      });
      expect(loaded.status).toBe(200);
      expect(loaded.body.approvalMode).toBe(initialMode);
      clientId = loaded.body.clientId as string;
      await send('default', 3);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(3);
      for (const definition of await definitions())
        expect(definition).toEqual(saved);
      const finalJournal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(finalJournal.header!.definitionRef).toEqual(
        initialJournal.header!.definitionRef,
      );
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    },
  );

  it('answers approvals through the resolve route across turns and a reload', async () => {
    const requestIds: string[] = [];
    const wait = HostedApprovalWaiters.prototype.wait;
    vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
      function (this: HostedApprovalWaiters, requestId, ...rest) {
        requestIds.push(requestId);
        return wait.call(this, requestId, ...rest);
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: randomUUID(),
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'default',
      approvalTimeoutMs: 60_000,
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('default');
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'default',
        approvalTimeoutMs: 60_000,
      },
    ]);
    const answer = (clientId: string, requestId: string, optionId: string) =>
      headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        });
    const runTurn = async (clientId: string, promptId: string) => {
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      const count = requestIds.length + 1;
      await waitFor(() => expect(requestIds).toHaveLength(count));
      return requestIds.at(-1)!;
    };
    const finished = async (clientId: string) =>
      waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });

    let clientId = created.body.clientId as string;
    const first = await runTurn(clientId, PROMPT_ID);
    const missing = await answer('other-client', first, 'allow');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('hosted_session_not_found');
    const unknown = await answer(
      clientId,
      `tool_approval_${'0'.repeat(32)}`,
      'allow',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('action_not_found');
    const invalid = await answer(clientId, first, 'later');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_action_response');
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    // Reading the options fails before anything is written.
    const failure = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(new Error('store down'));
    const failed = await answer(clientId, first, 'allow');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('action_resolution_failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('store down'));
    failure.mockRestore();
    log.mockRestore();
    const allowed = await answer(clientId, first, 'allow');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({
      requestId: first,
      state: 'decided',
      optionId: 'allow',
    });
    await finished(clientId);
    expect((await answer(clientId, first, 'allow')).status).toBe(200);
    const changed = await answer(clientId, first, 'deny');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('action_already_resolved');

    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.approvalMode).toBe('default');
    clientId = loaded.body.clientId as string;
    const secondPrompt = randomUUID();
    const second = await runTurn(clientId, secondPrompt);
    expect(second).not.toBe(first);
    expect((await answer(clientId, second, 'allow')).status).toBe(200);
    await finished(clientId);

    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(2);
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events
        .filter((event: { type: string }) => event.type === 'turn_complete')
        .map((event: { promptId: string }) => event.promptId),
    ).toEqual([PROMPT_ID, secondPrompt]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  async function waitingSession() {
    const requestIds: string[] = [];
    const wait = HostedApprovalWaiters.prototype.wait;
    vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
      function (this: HostedApprovalWaiters, requestId, ...rest) {
        requestIds.push(requestId);
        return wait.call(this, requestId, ...rest);
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'edit',
        callId: 'call-1',
        args: { file_path: 'a.txt', old_string: 'a', new_string: 'b' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'default',
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'edit a' }];
    const submit = async (promptId: string) => {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      const count = requestIds.length + 1;
      await waitFor(() => expect(requestIds).toHaveLength(count));
    };
    await submit(PROMPT_ID);
    const answer = (optionId: string) =>
      headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestIds.at(-1)}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        });
    const status = async () =>
      (
        await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId)
      ).body;
    return { server, clientId, answer, status, submit };
  }

  it('streams a message_retracted envelope when a restarted attempt retracts its prefix', async () => {
    state.model.mockImplementationOnce(async (input) => {
      const deltas = (
        input as {
          textDeltas?: {
            delta(text: string): Promise<void>;
            retract(): Promise<void>;
          };
        }
      ).textDeltas;
      await deltas!.delta('orphaned prefix');
      await deltas!.retract();
      await deltas!.delta('recovered');
      return { text: 'recovered', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'yolo',
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'retry' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const events = transcript.body.events as Array<{
      id: number;
      type: string;
      promptId?: string;
      data?: {
        turnId?: string;
        messageId?: string;
        fromSequence?: number;
        update?: { sessionUpdate?: string; content?: { text?: string } };
      };
    }>;
    const chunks = events.filter((event) => event.type === 'session_update');
    const retractions = events.filter(
      (event) => event.type === 'message_retracted',
    );
    expect(retractions).toHaveLength(1);
    expect(retractions[0]!.promptId).toBe(PROMPT_ID);
    expect(retractions[0]!.data?.turnId).toBe(PROMPT_ID);
    // The retraction names the orphaned prefix's first delta and lands
    // between the orphaned chunks and the replay's.
    expect(retractions[0]!.data?.fromSequence).toBe(chunks[0]!.id);
    expect(retractions[0]!.id).toBeGreaterThan(chunks[0]!.id);
    const replayed = chunks.filter((chunk) => chunk.id > retractions[0]!.id);
    expect(
      replayed.map((chunk) => chunk.data?.update?.content?.text).join(''),
    ).toBe('recovered');
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('blocks the Session at once when recording an answer stops its writes', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    const failed = await answer('allow');
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('hosted_turn_recovery_required');
    expect(failed.body.reason).toBe('writes_stopped');
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
    expect((await answer('allow')).body.code).toBe(
      'hosted_turn_recovery_required',
    );
    expect((await answer('allow')).body.reason).toBe('writes_stopped');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('journal down'));
    // The stopped writer outranks turn_blocked on every gate, not only the
    // resolve route: a fresh prompt and both runtime routes name it.
    const followUp = [{ type: 'text', text: 'again' }];
    const prompted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: followUp,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(followUp)).digest('hex')}`,
      });
    expect(prompted.status).toBe(409);
    expect(prompted.body.code).toBe('hosted_turn_recovery_required');
    expect(prompted.body.reason).toBe('writes_stopped');
    for (const route of ['continue', 'cancel'] as const) {
      const refused = await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/${route}`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: 'ckpt-lost',
          activationId: 'act-lost',
        });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('writes_stopped');
    }
    // The same outrank pins the files/rewind gate: it carries the busy code
    // before any body validation, so a stopped writer is named here too.
    const rewound = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_turn_recovery_required');
    expect(rewound.body.reason).toBe('writes_stopped');
  });

  it('retains the turn recovery error on cold load of a pending file edit', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockRejectedValueOnce(
      new Error('lost execution reply'),
    );
    expect((await answer('allow')).status).toBe(200);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    const history = await headers(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .send({})
      .expect(204);
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockClear();
    state.model.mockClear();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: files });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false,"ground":"phase_await_runtime","groundDetail":null}`,
    );
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.fileHistory).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each(['pending-snapshot', 'history-settled'])(
    'reloads settled file results after %s without redispatch',
    async (phase) => {
      vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
      const { server, clientId, answer, status } = await waitingSession();
      const fileState = {
        ownerSessionId: SESSION_ID,
        snapshots: [],
        files: {},
      };
      if (phase === 'pending-snapshot') {
        vi.mocked(
          HostedWorkspaceBroker.prototype.fileHistory,
        ).mockImplementation(async (operation) => {
          if (operation.action === 'snapshot')
            throw new Error('snapshot reply lost');
          return fileState;
        });
      } else {
        vi.spyOn(
          HostedWorkspaceToolTurn.prototype,
          'consumeResults',
        ).mockRejectedValueOnce(
          new HostedToolRecoveryRequiredError(
            new Error('interrupted before model continuation'),
          ),
        );
      }
      expect((await answer('allow')).status).toBe(200);
      await waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        }),
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      vi.mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockResolvedValue(fileState)
        .mockClear();
      state.model.mockImplementationOnce(
        async ({ toolTurn, resumeFromToolResults }) => {
          expect(resumeFromToolResults).toHaveLength(1);
          await toolTurn!.consumeResults();
          return {
            text: 'resumed from saved file result',
            model: 'test-model',
          };
        },
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(200);
      const recoveredId = loaded.body.clientId as string;
      await waitFor(async () => {
        const response = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', recoveredId);
        expect(response.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      expect(HostedWorkspaceBroker.prototype.fileHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: phase === 'pending-snapshot' ? 'snapshot' : 'bind',
        }),
      );
      const history = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', recoveredId);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', recoveredId)
        .send({})
        .expect(204);
      expect(
        (
          await headers(
            supertest(server).post(`/session/${SESSION_ID}/load`),
          ).send({ managedSessionStore: store(), toolProfile: files })
        ).status,
      ).toBe(200);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    },
  );

  it('passively reattaches a live Turn and cancels it without opening another writer', async () => {
    const { server, clientId, answer, status } = await waitingSession();
    // The frozen binding fences both resident reattach branches: a foreign
    // tenant or Workspace meets the budget-bounded already_attached refusal,
    // while a drifted Session Store address refuses with the retryable
    // conflict its only caller needs to retry instead of failing the Turn.
    for (const [changed, expected] of [
      [{ tenantId: 'other' }, 409],
      [{ workspaceId: 'other' }, 409],
      [{ baseUrl: 'https://other-store.test' }, 409],
    ] as const) {
      for (const recovery of [
        { passiveManagedRuntimeRecovery: true },
        { driveRuntimeRecovery: true },
      ]) {
        const refused = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: { ...store(), ...changed },
          ...recovery,
        });
        expect(refused.status).toBe(expected);
      }
    }
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({ managedSessionStore: store(), toolProfile: files })
      .expect(409);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        passiveManagedRuntimeRecovery: true,
      })
      .expect(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({ clientId, approvalMode: 'default' });
    expect(loaded.body._meta).toBeUndefined();
    expect(await status()).toMatchObject({ hasActivePrompt: true });
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      }),
    );
    expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    const late = await answer('allow');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('action_cancelled');
  });

  it('refuses answers once the Session is recovery-blocked', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'resolveAction',
    ).mockRejectedValueOnce(new Error('fenced'));
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    const refused = await answer('allow');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('turn_blocked');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fenced'));
  });

  it('asks again in the Turn after one whose calls were all refused', async () => {
    const { server, clientId, answer, status, submit } = await waitingSession();
    const finished = () =>
      waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        }),
      );
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'default',
        approvalTimeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
      },
    ]);
    expect((await answer('deny')).status).toBe(200);
    await finished();
    const second = randomUUID();
    await submit(second);
    expect((await answer('allow')).status).toBe(200);
    await finished();
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events
        .filter((event: { type: string }) => event.type === 'turn_complete')
        .map((event: { promptId: string }) => event.promptId),
    ).toEqual([PROMPT_ID, second]);
  });

  it('keeps a replay retryable when it fails before writing on a stopped Session', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    expect((await answer('allow')).status).toBe(200);
    await waitFor(async () =>
      expect(await status()).toMatchObject({ hasActivePrompt: false }),
    );
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'renamed' })
      .expect(503);
    // Only a Session whose writes stopped refuses the next write as well.
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'renamed again' })
      .expect(503);
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockRejectedValueOnce(new Error('store unavailable'));
    const failed = await answer('allow');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('action_resolution_failed');
    expect((await answer('allow')).status).toBe(200);
    const changed = await answer('deny');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('action_already_resolved');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('store unavailable'),
    );
  });

  it('asks again in the next Turn after an approval expired unanswered', async () => {
    const { answer, status, submit } = await waitingSession();
    const finished = () =>
      waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        }),
      );
    // An answer after the expiry time expires the Action at once.
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + HOSTED_APPROVAL_TIMEOUT_MS);
    const late = await answer('allow');
    now.mockRestore();
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('action_expired');
    await finished();
    await submit(randomUUID());
    expect((await answer('allow')).status).toBe(200);
    await finished();
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
  });
});

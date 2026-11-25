/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  neverStartedReconcile,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import {
  AUTOMATION_ID,
  AUTOMATION_SLOT,
  automationDefinition,
  capturedWakeSession,
  mockBrokerBroker,
  recoveryFileSession,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import type { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LlmRequestPreparationError } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import { AUTOMATION_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('clears predispatch partial intent file history before the cancelled terminal', async () => {
    let originalManaged: Awaited<ReturnType<typeof openManagedSession>>;
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
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    let prepareOrdinal = 0;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
      async () => {
        if (prepareOrdinal++ === 0) return 'original-execution-1';
        const authority = originalManaged.authority;
        const commandId = `hosted-cancel:${PROMPT_ID}`;
        await authority.appendExecutionEvent(
          {
            operation: 'requestCancel',
            commandId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: createHash('sha256').update(PROMPT_ID).digest('hex'),
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: commandId,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'cancel.requested',
            occurredAt: Date.now(),
            payload: {
              requestId: commandId,
              target: { turnId: PROMPT_ID },
              reason: 'user',
              requestedBy: 'hosted',
            },
          }),
          { class: 'trusted_entry' },
        );
        throw new Error('crash after first prepared intent');
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      originalManaged = (
        toolTurn as unknown as { session: typeof originalManaged }
      ).session;
      const calls = [0, 1].map((ordinal) => ({
        name: 'write_file',
        callId: `original-call-${ordinal}`,
        args: { file_path: `original-${ordinal}.txt`, content: 'original' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      }));
      await toolTurn!.execute(
        calls,
        calls.map((call) => ({
          functionCall: { id: call.callId, name: call.name, args: call.args },
        })),
        'test-model',
        signal,
      );
      return { text: 'never reached', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      approvalMode: 'yolo',
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'write original' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      },
      { timeout: settleTimeoutMs() },
    );
    const before = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    expect(
      before.events.filter((event) => event.kind === 'tool.intent'),
    ).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacementServer = await app(true);
    const loaded = await headers(
      supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(loaded.status).toBe(200);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    const after = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const terminals = after.events.filter(
      (event) => event.kind === 'turn.settled',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].payload['outcome']).toBe('cancelled');
    expect(state.model).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await headers(
      supertest(replacementServer).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
    const nextServer = await app(true);
    const reloaded = await headers(
      supertest(nextServer).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(reloaded.status).toBe(200);
    const nextPromptId = '55555555-5555-4555-8555-555555555555';
    const nextPrompt = [{ type: 'text', text: 'say hello after cancellation' }];
    await headers(supertest(nextServer).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', reloaded.body.clientId)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === nextPromptId,
        ),
      ).toHaveLength(1);
      const status = await headers(
        supertest(nextServer).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', reloaded.body.clientId);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    expect(state.model).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    await headers(supertest(nextServer).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', reloaded.body.clientId)
      .expect(204);
  });

  it('targets the original active turn when the durable cancel reply arrives late', async () => {
    let originalManaged: Awaited<ReturnType<typeof openManagedSession>>;
    let finishModel!: () => void;
    let releaseCancelAck!: () => void;
    let cancelCommitted = false;
    const modelGate = new Promise<void>((resolve) => {
      finishModel = resolve;
    });
    const cancelAckGate = new Promise<void>((resolve) => {
      releaseCancelAck = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      originalManaged = (
        toolTurn as unknown as { session: typeof originalManaged }
      ).session;
      await modelGate;
      return { text: 'original answer completed', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      approvalMode: 'yolo',
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'complete original answer' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(originalManaged).toBeDefined());
    const append = originalManaged!.authority.appendExecutionEvent.bind(
      originalManaged!.authority,
    );
    vi.spyOn(
      originalManaged!.authority,
      'appendExecutionEvent',
    ).mockImplementation(async (...args) => {
      const result = await append(...args);
      if (args[0].operation === 'requestCancel') {
        cancelCommitted = true;
        await cancelAckGate;
      }
      return result;
    });
    const cancelResponse = headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId)
      .timeout(settleTimeoutMs())
      .then((response) => response);
    // A preceding assertion can fail before the request is awaited below.
    void cancelResponse.catch(() => {});
    let finishNextModel!: () => void;
    try {
      await vi.waitFor(() => expect(cancelCommitted).toBe(true), {
        timeout: settleTimeoutMs(),
      });
      finishModel();
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      let nextSignal: AbortSignal | undefined;
      const nextModelGate = new Promise<void>((resolve) => {
        finishNextModel = resolve;
      });
      state.model.mockImplementationOnce(async ({ signal }) => {
        nextSignal = signal;
        await nextModelGate;
        return { text: 'next answer completed', model: 'test-model' };
      });
      const nextPrompt = [{ type: 'text', text: 'complete the next answer' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .send({
          prompt: nextPrompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(nextSignal).toBeDefined());
      releaseCancelAck();
      const cancelled = await cancelResponse;
      expect(cancelled.status).toBe(204);
      expect(nextSignal!.aborted).toBe(false);
      finishNextModel();
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
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
      expect(
        journal.events.filter((event) => event.kind === 'cancel.requested'),
      ).toHaveLength(1);
      expect(
        journal.events.filter((event) => event.kind === 'turn.settled'),
      ).toHaveLength(2);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .expect(204);
    } finally {
      finishModel();
      releaseCancelAck();
      finishNextModel?.();
      await cancelResponse.catch(() => {});
    }
  });

  it.each([false, true])(
    'keeps a later active Turn safe from a delayed original cancellation (public children: %s)',
    async (publicChildren) => {
      if (publicChildren) mockBrokerBroker();
      const server = await app(publicChildren);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          ...(publicChildren
            ? {
                toolProfile: 'hosted-workspace-shell/1',
                approvalMode: 'yolo',
                publicChildAgentsVersion: 1,
              }
            : {}),
        })
        .expect(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', created.body.clientId);
      const idle = () =>
        vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).expect(200);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
      const prompt = [{ type: 'text', text: 'original' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await idle();
      const attached = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
          ...(publicChildren
            ? {
                toolProfile: 'hosted-workspace-shell/1',
                publicChildAgentsVersion: 1,
              }
            : {}),
        })
        .expect(200);
      expect(attached.body.clientId).toBe(created.body.clientId);
      let laterSignal!: AbortSignal;
      let finishLater!: () => void;
      state.model.mockImplementationOnce(
        ({ signal }) =>
          new Promise((resolve) => {
            laterSignal = signal;
            finishLater = () => resolve({ text: 'later', model: 'test-model' });
            signal.addEventListener('abort', finishLater, { once: true });
          }),
      );
      const later = randomUUID();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: later, payloadDigest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(2), {
        timeout: settleTimeoutMs(),
      });
      const cancel = (promptId: unknown) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`)).send(
          {
            promptId,
          },
        );
      try {
        await cancel(PROMPT_ID).expect(204);
        expect(laterSignal.aborted).toBe(false);
        await cancel(randomUUID()).expect(409);
        await cancel(null).expect(400);
        expect(laterSignal.aborted).toBe(false);
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).expect(200);
        expect(status.body.hasActivePrompt).toBe(true);
        await cancel(later).expect(204);
        expect(laterSignal.aborted).toBe(true);
      } finally {
        finishLater();
      }
      await idle();
      await cancel(PROMPT_ID).expect(204);
      await cancel(later).expect(204);
      const saved = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        saved.events
          .filter((event) => event.kind === 'cancel.requested')
          .map((event) => event.payload['target']),
      ).toEqual([
        ...(publicChildren ? [{ turnId: PROMPT_ID }] : []),
        { turnId: later },
      ]);
      expect(state.model).toHaveBeenCalledTimes(2);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('refuses a targeted cancel for an original parked Turn without aborting or driving it', async () => {
    const f = await recoveryFileSession();
    state.model.mockRejectedValueOnce(new LlmRequestPreparationError('parked'));
    await f.submit();
    await f.idle();
    const response = await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/cancel`))
      .send({ promptId: PROMPT_ID })
      .expect(409);
    expect(response.body.code).toBe('hosted_turn_recovery_required');
    expect(state.model).toHaveBeenCalledOnce();
    const authority = f.resident.managed.authority;
    expect(
      authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'cancel.requested'),
    ).toEqual([]);
  });

  it.each([false, true])(
    'refuses a delayed original cancellation load for a later parked input (cold: %s)',
    async (cold) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      const later = randomUUID();
      const prompt = [{ type: 'text', text: 'later parked input' }];
      state.model.mockRejectedValueOnce(
        new LlmRequestPreparationError('parked'),
      );
      await f
        .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
        .send({
          prompt,
          promptId: later,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await f.idle();
      f.resident.recoveredTurn = later;
      await f.owe(later);
      f.resident.monitorWake?.close();
      if (cold) await f.resident.managed.close();
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      releases.mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
      const server = cold ? await app(true) : f.server;
      const response = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
          cancellationPromptId: PROMPT_ID,
        })
        .expect(409);
      expect(response.body.code).toBe('hosted_cancel_identity_mismatch');
      expect(
        response.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
      ).toBeUndefined();
      expect(response.body.clientId).toBeUndefined();
      expect(f.resident.recoveredTurn).toBe(later);
      expect(releases).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
      expect(state.model).toHaveBeenCalledTimes(2);
      const saved = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        saved.events.some(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === later,
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    'settles only the original parked input when a later wake-owned input is queued (cold: %s)',
    async (cold) => {
      const f = await recoveryFileSession();
      state.model.mockRejectedValueOnce(
        new LlmRequestPreparationError('parked'),
      );
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      const managed = f.resident.managed;
      const key = managed.authority.sessionHeader.sessionKey;
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      await automations.define({
        scheduleId: AUTOMATION_ID,
        operationId: randomUUID(),
        definition: automationDefinition,
      });
      const queued = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.now(),
      });
      const originalRun = managed.authority.extensionRecord(
        'automation_run',
        queued.run!.automationRunId,
      );
      expect(originalRun).toBeDefined();
      const before = managed.authority.eventsInSequenceRange(
        1,
        managed.authority.committedSequence,
      );
      expect(
        before.findLast((event) => event.kind === 'input.accepted')?.payload,
      ).toMatchObject({
        turnId: queued.inputId,
        source: AUTOMATION_INPUT_SOURCE,
      });
      expect(
        before.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toBe(false);
      // Observe this cancellation request separately from the independent queued-input pump.
      vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
        function (this: HostedMonitorWakeScheduler) {
          this.close();
        },
      );
      if (cold) await managed.close();
      const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
      const warm = vi.mocked(HostedWorkspaceBroker.prototype.warm);
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      const cancel = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
        .mockResolvedValue();
      acquire.mockClear();
      warm.mockClear();
      release.mockClear();
      const server = cold ? await app(true) : f.server;
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
          cancellationPromptId: PROMPT_ID,
        })
        .expect(200);
      expect(
        loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
      ).toBeUndefined();
      const current = cold ? capturedWakeSession() : f.resident;
      current.monitorWake?.close();
      const authority = current.managed.authority;
      const after = authority.eventsInSequenceRange(
        1,
        authority.committedSequence,
      );
      expect(
        after
          .filter((event) => event.kind === 'turn.settled')
          .map((event) => ({
            turnId: event.payload['turnId'],
            outcome: event.payload['outcome'],
          })),
      ).toEqual([{ turnId: PROMPT_ID, outcome: 'cancelled' }]);
      expect(
        after.some(
          (event) =>
            event.kind === 'cancel.requested' &&
            (event.payload['target'] as { turnId?: string } | undefined)
              ?.turnId === queued.inputId,
        ),
      ).toBe(false);
      expect(
        authority.extensionRecord(
          'automation_run',
          queued.run!.automationRunId,
        ),
      ).toEqual(originalRun);
      expect(state.model).toHaveBeenCalledOnce();
      expect(state.model.mock.calls[0]?.[0].promptId).toBe(PROMPT_ID);
      expect(cancel).not.toHaveBeenCalled();
      for (const broker of [
        ...acquire.mock.contexts,
        ...warm.mock.contexts,
        ...release.mock.contexts,
      ]) {
        expect((broker as HostedWorkspaceBroker).runtimeSessionId).not.toBe(
          hostedRuntimeSessionId(queued.inputId),
        );
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .expect(204);
    },
  );

  it.each([false, true])(
    'holds the original cancellation load gate across its await and releases it after settlement (failure: %s)',
    async (failSettlement) => {
      const f = await recoveryFileSession();
      state.model.mockRejectedValueOnce(
        new LlmRequestPreparationError('parked'),
      );
      await f.submit();
      await f.idle();
      const original =
        f.resident.managed.authority.harnessRunAuthorization.bind(
          f.resident.managed.authority,
        );
      let entered!: () => void;
      let release!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorization = vi
        .spyOn(f.resident.managed.authority, 'harnessRunAuthorization')
        .mockImplementationOnce(async () => {
          entered();
          await gate;
          return original();
        });
      if (failSettlement)
        authorization.mockRejectedValueOnce(new Error('settle unavailable'));
      const loading = headers(
        supertest(f.server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
          cancellationPromptId: PROMPT_ID,
        })
        .then((response) => response);
      try {
        await entering;
        expect(f.resident.hooksBusy).toBe(true);
        if (!failSettlement) {
          await f.resident.managed.sink.write({
            uuid: randomUUID(),
            parentUuid: null,
            sessionId: SESSION_ID,
            timestamp: new Date().toISOString(),
            type: 'system',
            subtype: 'turn_result',
            cwd: state.root,
            version: 'hosted-harness/1',
            daemonPromptId: PROMPT_ID,
            systemPayload: {
              promptId: PROMPT_ID,
              state: 'cancelled',
              stopReason: 'cancelled',
              endedAt: Date.now(),
            },
          } as ChatRecord);
          f.resident.blocked = false;
        }
        const prompt = [{ type: 'text', text: 'must wait for original load' }];
        const rejected = await f
          .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: randomUUID(),
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(409);
        expect(rejected.body.code).toBe('hosted_hook_operation_active');
        expect(state.model).toHaveBeenCalledOnce();
      } finally {
        release();
      }
      const loaded = await loading;
      expect(loaded.status).toBe(failSettlement ? 409 : 200);
      expect(f.resident.hooksBusy).toBe(false);
      expect(state.model).toHaveBeenCalledOnce();
      const events = f.resident.managed.authority.eventsInSequenceRange(
        1,
        f.resident.managed.authority.committedSequence,
      );
      expect(
        events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toBe(!failSettlement);
      if (!failSettlement) {
        const prompt = [{ type: 'text', text: 'after original load' }];
        await f
          .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: randomUUID(),
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await f.idle();
        expect(state.model).toHaveBeenCalledTimes(2);
      }
    },
  );

  it('uses only cleanup attachment when the original cancellation load finds a terminal input after restart', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
    neverStartedReconcile.fn.mockClear();
    const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
    kick.mockClear();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
        cancellationPromptId: PROMPT_ID,
      })
      .expect(200);
    expect(loaded.body.recoveryCleanupOnly).toBe(true);
    expect(
      loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeUndefined();
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
    expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    expect(state.model).toHaveBeenCalledOnce();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
  });

  const recoveryReplayCases = [
    ['cancel', 'admitted'],
    ['cancel', 'settled'],
    ['continue', 'admitted'],
    ['continue', 'settled'],
  ] as const;

  it.each(recoveryReplayCases)(
    'keeps a later parked input and its held Runtime untouched by an original %s %s replay',
    async (route, replay) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      const authority = f.resident.managed.authority;
      const checkpointId = 'original-checkpoint';
      const activationId = 'original-activation';
      if (replay === 'admitted')
        f.resident.admissions.set(PROMPT_ID, {
          digest: `recovery:${checkpointId}:${activationId}`,
          lastEventId: authority.committedSequence,
        });
      else f.resident.admissions.delete(PROMPT_ID);
      const later = randomUUID();
      const bytes = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'later' }]),
      );
      await authority.submitInput(
        {
          operation: 'submitInput',
          commandId: later,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: createHash('sha256').update(bytes).digest('hex'),
        },
        {
          inputId: later,
          turnId: later,
          source: 'hosted-harness',
          contentRef: await f.resident.managed.resources.publish(
            'managed-input',
            bytes,
          ),
          admissionRef: await f.resident.managed.resources.publish(
            'managed-admission',
            Buffer.from('{}'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      const lease = {
        promptId: later,
        runtimeSessionId: hostedRuntimeSessionId(later),
      };
      f.resident.recoveredTurn = later;
      f.resident.runtimeLeaseHeld = lease;
      f.resident.runtimeLeaseOwedByTerminalRoute = true;
      const before = authority.eventsInSequenceRange(
        1,
        authority.committedSequence,
      );
      expect(before.some((event) => event.kind === 'hosted.cleanup')).toBe(
        false,
      );
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      const response = await f
        .authorize(
          supertest(f.server).post(
            `/session/${SESSION_ID}/managed-runtime/${route}`,
          ),
        )
        .send({ promptId: PROMPT_ID, checkpointId, activationId })
        .expect(200);
      expect(response.body).toMatchObject({
        accepted: true,
        promptId: PROMPT_ID,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
      expect(f.resident.runtimeLeaseHeld).toBe(lease);
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(true);
      expect(f.resident.recoveredTurn).toBe(later);
      expect(
        authority.eventsInSequenceRange(1, authority.committedSequence),
      ).toEqual(before);
      expect(
        before.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toBe(true);
      expect(
        before.some(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === later,
        ),
      ).toBe(false);
      expect(state.model).toHaveBeenCalledOnce();
    },
  );

  it.each(recoveryReplayCases)(
    'retries only the original held Runtime cleanup on its %s %s replay',
    async (route, replay) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      const authority = f.resident.managed.authority;
      const checkpointId = 'original-checkpoint';
      const activationId = 'original-activation';
      if (replay === 'admitted')
        f.resident.admissions.set(PROMPT_ID, {
          digest: `recovery:${checkpointId}:${activationId}`,
          lastEventId: authority.committedSequence,
        });
      else f.resident.admissions.delete(PROMPT_ID);
      const lease = {
        promptId: PROMPT_ID,
        runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
      };
      f.resident.runtimeLeaseHeld = lease;
      f.resident.runtimeLeaseOwedByTerminalRoute = true;
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      release.mockRejectedValueOnce(
        new Error('original handback is unavailable'),
      );
      const send = () =>
        f
          .authorize(
            supertest(f.server).post(
              `/session/${SESSION_ID}/managed-runtime/${route}`,
            ),
          )
          .send({ promptId: PROMPT_ID, checkpointId, activationId })
          .expect(200);
      await send();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(f.resident.runtimeLeaseHeld).toBe(lease);
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(true);
      await send();
      await vi.waitFor(() =>
        expect(f.resident.runtimeLeaseHeld).toBeUndefined(),
      );
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(false);
      expect(release).toHaveBeenCalledTimes(2);
      expect(
        release.mock.contexts.map(
          (broker) => (broker as HostedWorkspaceBroker).runtimeSessionId,
        ),
      ).toEqual([lease.runtimeSessionId, lease.runtimeSessionId]);
      expect(state.model).toHaveBeenCalledOnce();
    },
  );
});

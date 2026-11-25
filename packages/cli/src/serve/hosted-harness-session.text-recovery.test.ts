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
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
  writeSettledToolHistory,
} from './hosted-harness-session.test-helper.js';
import {
  AUTOMATION_ID,
  AUTOMATION_SLOT,
  capturedWakeSession,
  fireBody,
  mockBrokerBroker,
  prewriteAutomationCrashedTurnSession,
  prewriteAutomationSession,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { getApiHistoryPromptId } from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import { type Server } from 'node:http';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as modelRecovery from './hosted-model-recovery.js';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { SessionTranscriptChangedError } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { type LlmPreparedRequest } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { settleCrashedWakeTurnAftermath } from './hosted-harness-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import {
  HostedApprovalWaiters,
  endHostedAction,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import { automationRunId } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it.each([
    ['cancelled', 'harness_interruption', ['user', 'assistant', 'tool_result']],
    ['cancelled', 'cancelled', []],
    ['error', 'deadline_exceeded', []],
    ['error', 'error', []],
  ] as const)(
    'keeps settled tool history whole after %s/%s (#14256)',
    async (outcome, stopReason, expectedTypes) => {
      mockBrokerBroker();
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        })
        .expect(200);
      const managed = capturedWakeSession().managed;
      const completedId = `${PROMPT_ID}:completed`;
      await writeSettledToolHistory(
        managed,
        completedId,
        'completed',
        'end_turn',
      );
      await writeSettledToolHistory(managed, PROMPT_ID, outcome, stopReason);
      const projected = await managed.sink.projectModelHistory();
      const savedIds = projected.apiHistory.map(
        (entry) => getApiHistoryPromptId(entry) ?? null,
      );
      const snapshotId = randomUUID();
      await managed.sink.write({
        uuid: snapshotId,
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        cwd: state.root,
        version: 'hosted-harness/1',
        type: 'system',
        subtype: 'chat_compression',
        systemPayload: {
          info: {
            compressionStatus: CompressionStatus.COMPRESSED,
            originalTokenCount: 100,
            newTokenCount: 50,
          },
          compressedHistory: projected.apiHistory,
          promptIds: savedIds,
          summaryPrefixLength: 0,
        },
      });
      const prompt = [{ type: 'text', text: 'please continue' }];
      const nextPromptId = randomUUID();
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .send({
          prompt,
          promptId: nextPromptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce(), {
        timeout: settleTimeoutMs(),
      });
      const input = state.model.mock.calls[0]![0] as unknown as {
        history: ChatRecord[];
      };
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', created.body.clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(
        input.history
          .filter((entry) => entry.daemonPromptId === PROMPT_ID)
          .map((entry) => entry.type),
      ).toEqual(expectedTypes);
      expect(
        input.history
          .filter(
            (entry) => entry.daemonPromptId === completedId && entry.message,
          )
          .map((entry) => entry.type),
      ).toEqual(['user', 'assistant', 'tool_result']);
      expect(
        input.history.find((entry) => entry.uuid === snapshotId)?.systemPayload,
      ).toMatchObject({
        promptIds: expect.arrayContaining([PROMPT_ID, completedId]),
      });
      expect(
        (await managed.sink.projectModelRecords()).find(
          (entry) => entry.uuid === snapshotId,
        )?.systemPayload,
      ).toMatchObject({
        promptIds: savedIds,
      });
      expect(
        (await managed.sink.project())
          .filter((entry) => entry.daemonPromptId === PROMPT_ID)
          .map((entry) => entry.type),
      ).toEqual(['user', 'assistant', 'tool_result']);
      expect(
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .find(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          )?.payload,
      ).toMatchObject({ outcome, stopReason });
    },
  );

  it('excludes a naked interrupted instruction from the next prompt (PR #15959)', async () => {
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const managed = capturedWakeSession().managed;
    const instruction = 'write INTERRUPTED_REPRO before answering';
    const content = Buffer.from(
      JSON.stringify([{ type: 'text', text: instruction }]),
    );
    await managed.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: PROMPT_ID,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        contentDigest: createHash('sha256').update(content).digest('hex'),
      },
      {
        inputId: PROMPT_ID,
        turnId: PROMPT_ID,
        source: 'hosted-harness',
        contentRef: await managed.resources.publish('managed-input', content),
        admissionRef: await managed.resources.publish(
          'managed-admission',
          Buffer.from('{}'),
        ),
        deadline: null,
        wakeReason: 'input',
      },
    );
    await createManagedHarnessHandle(managed).ensureRunnable();
    const uuid = randomUUID();
    await managed.sink.write({
      uuid,
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      cwd: state.root,
      version: 'hosted-harness/1',
      type: 'user',
      daemonPromptId: PROMPT_ID,
      message: { role: 'user', parts: [{ text: instruction }] },
    });
    await managed.sink.write({
      uuid: randomUUID(),
      parentUuid: uuid,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      cwd: state.root,
      version: 'hosted-harness/1',
      type: 'system',
      subtype: 'turn_result',
      daemonPromptId: PROMPT_ID,
      systemPayload: {
        promptId: PROMPT_ID,
        state: 'cancelled',
        stopReason: 'harness_interruption',
        endedAt: Date.now(),
      },
    });
    const prompt = [{ type: 'text', text: 'answer this new question only' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce(), {
      timeout: settleTimeoutMs(),
    });
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const input = state.model.mock.calls[0]![0] as unknown as {
      history: ChatRecord[];
      prompt: string;
    };
    expect(input.prompt).toContain('answer this new question only');
    expect(
      input.history.filter((entry) => entry.daemonPromptId === PROMPT_ID),
    ).toEqual([]);
  });

  it('keeps a turn that ended unanswered out of the next wake turn history', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    // The first run fails from its turn's own error.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('settled');
      },
      { timeout: settleTimeoutMs() },
    );
    const exploded = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    // The next occurrence's wake turn never receives the exploded turn's
    // prompt: what ended without an answer is over.
    state.model.mockClear();
    const slot = 'schedule:2026-03-08T11:00:00Z';
    const fired = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(fired.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
    });
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      promptId?: string;
      history?: Array<{ type?: string; daemonPromptId?: string }>;
    };
    expect(modelInput.promptId).toBe(
      `${automationRunId(AUTOMATION_ID, slot)}:input`,
    );
    expect(
      (modelInput.history ?? []).some(
        (entry) =>
          entry.type === 'user' && entry.daemonPromptId === `${exploded}:input`,
      ),
    ).toBe(false);
    // Let the second run reach its own settle before the teardown.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('settled');
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
  }, 45_000);

  it('retries the crashed input consume against a transient transcript conflict', async () => {
    const inputId = await prewriteAutomationCrashedTurnSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      // One moved-journal conflict on the first consume attempt, then the
      // writer owns the transcript again: the attempt is a retry, never a
      // drop, or every later reload re-classifies the same crash.
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let thrown = 0;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        function (this: ManagedSessionRecordSink, record) {
          if (
            record.type === 'system' &&
            record.subtype === 'turn_result' &&
            thrown === 0
          ) {
            thrown += 1;
            throw new SessionTranscriptChangedError();
          }
          return originalWrite.call(this, record);
        },
      );
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: undefined,
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      expect(thrown).toBe(1);
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      const run = automations
        .runs()
        .find((each) => each.occurrenceKey === AUTOMATION_SLOT);
      expect(run?.run.state).toBe('failed');
      expect(run?.run.execution).toBe('outcome_unknown');
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('preserves the named store failure on session status when turn_result cannot commit', async () => {
    // Admission passes; the turn_result append dies once with a simulated
    // exhausted 503, latching the authority's writer. Every later settlement
    // write then dies with ManagedSessionWritesStoppedError without ever
    // reaching the store again, ending the turn recovery-blocked with the
    // named failure only remembered in memory (#13800 P1).
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    state.model.mockReset();
    state.model.mockResolvedValue({
      text: 'stub reply',
      model: 'stub-model',
    });
    const originalAppend =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    let settlementAttempts = 0;
    const failing = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockImplementation(async function (
        this: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
      ) {
        // The settlement commit is the only batch carrying a turn.settled
        // event: the transcript records before it commit as
        // message.committed and the whole turn_result record itself is
        // published as a resource, so the literal only names the terminal
        // write.
        if (!JSON.stringify(records).includes('"turn.settled"')) {
          return originalAppend.call(this, records);
        }
        settlementAttempts += 1;
        throw new ManagedSessionStoreHttpError(
          503,
          'synthetic-http-retry-exhaustion',
          'synthetic 503 after HTTP retries are spent',
        );
      });
    const prompt = [{ type: 'text', text: 'hello' }];
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: randomUUID(), payloadDigest: digest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
          expect(status.body.recoveryReason).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: 30_000 },
      );
    } finally {
      failing.mockRestore();
    }
    // The latch is what the block rests on: only the first settlement
    // reached the store; the retry died on the authority's stopped writer
    // without appending again.
    expect(settlementAttempts).toBe(1);
    // The uncertain-write constraint is preserved: the next prompt is still
    // refused on the same block — the named failure only mirrors into memory,
    // it does not claim a persisted terminal state.
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId: randomUUID(), payloadDigest: digest });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 60_000);

  it.each([
    { cause: 'the stopped writer', preparationFailure: false },
    { cause: 'an unrelated failure', preparationFailure: true },
  ])(
    'preserves the named store failure when resident model recovery meets $cause',
    async ({ preparationFailure }) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const text = 'recover the interrupted model';
      const prompt = [{ type: 'text', text }];
      state.model.mockReset();
      state.model.mockImplementationOnce(async (input) => {
        const prepare = (
          input as unknown as {
            prepareModel(
              prepared: LlmPreparedRequest,
              round: number,
              pending: boolean,
            ): Promise<
              | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
              | undefined
            >;
          }
        ).prepareModel;
        const ref = await prepare(
          {
            request: {
              model: 'model-b',
              contents: [{ role: 'user', parts: [{ text }] }],
              config: {},
            },
            history: [],
            completedToolCallIds: [],
            routeSelector: 'openai:model-b',
            providerPin: 'a'.repeat(64),
            promptTokensForClamp: 0,
          },
          0,
          false,
        );
        const attempt = await input.modelScope!.beginMainAttempt(
          'model-b',
          ref,
        );
        await attempt(false, []);
        throw new Error('interrupted model');
      });
      const originalAppend =
        LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
      let storeUnavailable = true;
      let settlementAttempts = 0;
      const append = vi
        .spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        )
        .mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          if (
            storeUnavailable &&
            JSON.stringify(records).includes('"turn.settled"')
          ) {
            settlementAttempts += 1;
            throw new ManagedSessionStoreTransportError(
              'terminal write unavailable',
            );
          }
          return originalAppend.call(this, records);
        });
      const stderr = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const status = () =>
        headers(supertest(server).get(`/session/${SESSION_ID}/status`)).set(
          'X-Qwen-Client-Id',
          clientId,
        );
      let preparation: { mockRestore(): void } | undefined;
      try {
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await vi.waitFor(
          async () => {
            const blocked = await status();
            expect(blocked.body.hasActivePrompt).toBe(false);
            expect(blocked.body.recoveryBlocked).toBe(true);
            expect(blocked.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: settleTimeoutMs() },
        );
        expect(settlementAttempts).toBe(1);
        storeUnavailable = false;
        const appended = append.mock.calls.length;
        stderr.mockClear();
        if (preparationFailure)
          preparation = vi
            .spyOn(modelRecovery, 'findHostedCommittedModelOutput')
            .mockRejectedValueOnce(
              new Error('recovery preparation unavailable'),
            );
        const redriven = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ managedSessionStore: store(), driveRuntimeRecovery: true });
        expect(redriven.status).toBe(409);
        expect(redriven.body.code).toBe('hosted_turn_recovery_required');
        await vi.waitFor(
          async () => {
            const blocked = await status();
            expect(blocked.body.hasActivePrompt).toBe(false);
            expect(blocked.body.recoveryBlocked).toBe(true);
            expect(blocked.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: settleTimeoutMs() },
        );
        expect(state.model).toHaveBeenCalledOnce();
        expect(append).toHaveBeenCalledTimes(appended);
        if (preparationFailure) {
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted recovery redrive failed: Error: recovery preparation unavailable',
            ),
          );
        } else {
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted Harness recovery remained blocked: ManagedSessionWritesStoppedError:',
            ),
          );
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted recovery redrive failed: ManagedSessionWritesStoppedError:',
            ),
          );
        }
      } finally {
        append.mockRestore();
        preparation?.mockRestore();
        stderr.mockRestore();
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('names the store on the block a cancelled turn leaves when its settlement cannot commit', async () => {
    // A cancelled turn keeps 'cancelled' as its outcome, so the prompt
    // route never names its cause for the record — but the block its dead
    // turn.settled write leaves is the store's, and the status surface must
    // say so rather than show a bare boolean (#13800).
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let finish!: () => void;
    state.model.mockReset();
    state.model.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: '', model: 'stub-model' });
        }),
    );
    const originalAppend =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    const failing = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockImplementation(async function (
        this: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
      ) {
        if (!JSON.stringify(records).includes('"turn.settled"')) {
          return originalAppend.call(this, records);
        }
        throw new ManagedSessionStoreTransportError('store flap');
      });
    const prompt = [{ type: 'text', text: 'cancel me' }];
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: randomUUID(), payloadDigest: digest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce());
      await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      finish();
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
          expect(status.body.recoveryReason).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: 30_000 },
      );
    } finally {
      failing.mockRestore();
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 60_000);

  it.each(['expired', 'cancelled'])(
    'settles a saved final native plan without new inference (%s)',
    async (actionEnd) => {
      let originalManaged: import('@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js').ManagedSession;
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
        async (requestId) => {
          if (actionEnd !== 'cancelled') return;
          const authority = originalManaged.authority;
          const commandId = `hosted-cancel:${PROMPT_ID}`;
          await authority.appendExecutionEvent(
            {
              operation: 'requestCancel',
              commandId,
              sessionKey: authority.sessionHeader.sessionKey,
              contentDigest: createHash('sha256')
                .update(PROMPT_ID)
                .digest('hex'),
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
          await endHostedAction(originalManaged, requestId, 'cancelled');
        },
      );
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const crash = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(function (this: ManagedSessionRecordSink, record) {
          if (record.type === 'tool_result')
            return Promise.reject(new Error('crash after final plan'));
          return originalWrite.call(this, record);
        });
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        originalManaged = (
          toolTurn as unknown as { session: typeof originalManaged }
        ).session;
        const call = {
          name: 'write_file',
          callId: 'original-call',
          args: { file_path: 'original.txt', content: 'original' },
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
        return { text: 'never reached', model: 'test-model' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        approvalMode: 'default',
        approvalTimeoutMs: 1000,
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
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .expect(204);
      crash.mockRestore();
      const replacementServer = await app(true);
      const loaded = await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
      expect(loaded.status).toBe(200);
      await vi.waitFor(
        async () => {
          const journal = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          const terminals = journal.events.filter(
            (event) => event.kind === 'turn.settled',
          );
          expect(terminals).toHaveLength(1);
          expect(terminals[0].payload['outcome']).toBe('cancelled');
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .expect(204);
    },
  );

  it.each([
    { broker: false, toolProfile: undefined, redrive: false },
    { broker: true, toolProfile: undefined, redrive: false },
    { broker: true, toolProfile: 'hosted-workspace-files/1', redrive: false },
    { broker: false, toolProfile: undefined, redrive: true },
  ])(
    'compensates a committed final answer without inference or unowned release (%o)',
    async (scenario) => {
      const withBroker = scenario.broker;
      const prepared = {
        request: {
          model: 'test-model',
          contents: [{ role: 'user', parts: [{ text: 'park me' }] }],
          config: { temperature: 0.3 },
        },
        history: [{ role: 'user', parts: [{ text: 'park me' }] }],
        completedToolCallIds: [],
        routeSelector: 'openai:test-model',
        providerPin: 'a'.repeat(64),
        promptTokensForClamp: 12,
      };
      state.model.mockImplementation(async (input) => {
        const prepare = (
          input as unknown as {
            prepareModel: (
              request: unknown,
              round: number,
              pending: boolean,
              context?: string,
            ) => Promise<
              | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
              | undefined
            >;
          }
        ).prepareModel;
        const ref = await prepare(prepared, 0, false);
        const finish = await input.modelScope!.beginMainAttempt(
          'test-model',
          ref,
        );
        await finish(true, {});
        return { text: 'committed original answer', model: 'test-model' };
      });
      const server = await app(withBroker);
      await parkUnsettledPlainTurn(server, scenario.toolProfile);
      if (!scenario.redrive)
        vi.mocked(
          LocalManagedSessionResourceStore.prototype.publish,
        ).mockRestore();
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockImplementation(async () => {
          throw new Error('no tool profile must not release runtime');
        });
      const replacementServer = await app(withBroker);
      const loaded = await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
      expect(loaded.status).toBe(200);
      if (scenario.redrive) {
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId);
            expect(status.body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: true,
            });
          },
          { timeout: 15_000, interval: 100 },
        );
        vi.mocked(
          LocalManagedSessionResourceStore.prototype.publish,
        ).mockRestore();
        await headers(
          supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
        )
          .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
          .expect(200);
      }
      await vi.waitFor(
        async () => {
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
            journal.events.filter((event) => event.kind === 'turn.settled'),
          ).toHaveLength(1);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(state.model).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: 15_000, interval: 100 },
      );
      await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .expect(204);
    },
  );

  // Parks a plain Session with its Turn unsettled: the settlement's durable
  // write is refused, so the input stays accepted-but-unsettled.
  async function parkUnsettledPlainTurn(
    server: Server,
    toolProfile?: string,
  ): Promise<void> {
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      ...(toolProfile ? { toolProfile } : {}),
    });
    const clientId = created.body.clientId as string;
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      return kind === 'managed-turn-result'
        ? Promise.reject(new Error('store lost the settlement'))
        : publish.call(this, kind, bytes);
    });
    const prompt = [{ type: 'text', text: 'park me' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
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
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: isSlowTestHost() ? 30_000 : 1_000 },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    log.mockRestore();
  }

  it('marks the publication flag not-applicable on a profile-less cold refusal', async () => {
    const server = await app(true);
    await parkUnsettledPlainTurn(server);
    const parked = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    // The load's own open installs one activation record; the guard decides
    // at that boundary, before close() appends its release record after it.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (unsettled_input): {"incompletePublication":null,"unsettled":["${PROMPT_ID}"],"resume":null,"settle":null,"through":${parked.events.at(-1)!.sequence + 1}}`,
    );
  });

  it('names the broker posture when a takeover load has no Runtime to take over', async () => {
    const server = await app(true);
    await parkUnsettledPlainTurn(server);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const takeover = {
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    };
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send(takeover);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('takeover_unsupported');
    // The stderr tag carries exactly the body reason's token, so the two
    // channels of the same refusal never disagree.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (takeover_unsupported): profile=none broker=ready`,
    );
    const plain = await app();
    const refusedPlain = await headers(
      supertest(plain).post(`/session/${SESSION_ID}/load`),
    ).send(takeover);
    expect(refusedPlain.status).toBe(409);
    expect(refusedPlain.body.code).toBe('hosted_turn_recovery_required');
    expect(refusedPlain.body.reason).toBe('takeover_unsupported');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (takeover_unsupported): profile=none broker=none`,
    );
  });

  it('names the blocked authorization reason a refused restore discarded', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
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
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: isSlowTestHost() ? 30_000 : 1_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'identity_mismatch',
      message: 'checkpoint names another session',
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some(
          (line) =>
            line.includes('load refused (restore_blocked): basis=checkpoint') &&
            line.includes('reason=identity_mismatch') &&
            line.includes('message=checkpoint names another session'),
        ),
    ).toBe(true);
  });

  it('declines a drive takeover when the refused restore is durably blocked', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
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
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'identity_mismatch',
      message: 'checkpoint names another session',
    });
    // The drive shape asked for a takeover answer: a durable blocked
    // verdict can never change on retry, so it declines with its typed
    // reason instead of inviting an unbounded retry.
    const drive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(drive.status).toBe(409);
    expect(drive.body.code).toBe('hosted_turn_recovery_declined');
    expect(drive.body.reason).toBe('checkpoint_blocked');
    // The cancellation shape keeps the baseline retriable refusal even on
    // the same durable verdict: nothing may terminalize for a cancel.
    const passive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
  });

  it('refuses an attached cancellation redrive of a parked no-tool Turn retriably', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    // The terminal settlement write fails: the Turn stays parked in the
    // attached Session — its input accepted, never settled, nothing live.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (record.subtype === 'turn_result')
          throw new Error('settlement unavailable');
        return originalWrite.call(this, record);
      });
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    write.mockRestore();
    // A drive redrive keeps the typed decline.
    const drive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(drive.status).toBe(409);
    expect(drive.body.code).toBe('hosted_turn_recovery_declined');
    expect(drive.body.reason).toBe('model_start');
    // The cancellation redrive must NOT mint the plain attach the old arm
    // answered (R10-1): no kernel is consulted here, so nothing "mirrors an
    // inapplicable" — a 200 would let the coordinator's cancel land as a
    // no-op and wedge this Session permanently.
    const passive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
    // The parked Turn also answers the plain cancel route honestly: no
    // live execution can be aborted, so 204 would certify a cancel that
    // never happened (R10-3's sibling route).
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
  });
});

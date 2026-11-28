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
  domainEnablement,
  headers,
  settleTimeoutMs,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import {
  BOOT_ID_2,
  CALL,
  acquireSpy,
  loadReplacement,
  replacementApp,
  replacementHeaders,
  spyOnAcquire,
  storeFor,
  useRuntimeTakeover,
} from './hosted-harness-session-takeover.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Part } from '@google/genai';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
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
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import {
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import { HostedModelUnavailableError } from './hosted-agent-definition.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { teamMemberPreamble } from './hosted-member-chain.js';

describe('Hosted Harness Runtime turn takeover', () => {
  useRuntimeTakeover();

  /**
   * Drives a Workspace turn to the parked agent wait through the
   * PRODUCTION admission itself (R1-8): the model launches a foreground
   * `agent` call, `acceptChildAgent`'s `commitAwaitAgent` lands the
   * durable wait, and the owner's death is staged by failing the
   * cancellation-time abandoned fold — the checkpoint stays at
   * `await_agent` and the journal keeps every step of the admission.
   */
  async function parkAgentWaitTurn(): Promise<{ clientId: string }> {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    spyOnAcquire().mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const sabotage = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (
          record.type === 'tool_result' &&
          record.daemonPromptId === PROMPT_ID
        )
          throw new Error('settlement unavailable');
        return originalWrite.call(this, record);
      });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const agentCall = {
      name: 'agent',
      callId: 'call-1',
      args: {
        description: 'audit the diff',
        prompt: 'review the change',
        run_in_background: false,
      },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [agentCall],
          [
            {
              functionCall: {
                id: 'call-1',
                name: 'agent',
                args: agentCall.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [{ type: 'text', text: 'launch the audit' }];
    const payloadDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(prompt))
      .digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const latestCheckpointState = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const checkpoint = journal.events.findLast(
        (event) => event.kind === 'checkpoint.committed',
      );
      if (checkpoint === undefined) return undefined;
      return JSON.parse(
        (
          await resources.read(
            assertManagedSessionDurableRef(
              checkpoint.payload['stateRef'],
              'checkpoint',
            ),
          )
        ).toString(),
      );
    };
    // The wait is durable exactly when the admission's checkpoint names it:
    // anything earlier (the Session's initial checkpoint) must not pass.
    await vi.waitFor(
      async () => {
        expect((await latestCheckpointState())?.continuation.phase).toBe(
          'await_agent',
        );
      },
      { timeout: settleTimeoutMs() },
    );
    // The owner "crashes": the cancellation reaches the abandoned fold,
    // whose write was sabotaged — the wait stays parked, and the durable
    // record is exactly what the library-level wedge hand-mints.
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    sabotage.mockRestore();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const savedState = await latestCheckpointState();
    expect(savedState.continuation.phase).toBe('await_agent');
    expect(savedState.agentWait.runs).toMatchObject([
      {
        childRunId: `${PROMPT_ID}:call-1`,
        functionCallId: 'call-1',
        consumed: false,
      },
    ]);
    return { clientId: created.body.clientId as string };
  }

  /**
   * The two-resume shape R2 exposes (R2-2/R2-1/R2-3): fg1 folded live and
   * its wait resolved — the checkpoint carries the all-consumed group.
   * `orphan` additionally admits fg2 in the admit→commit gap, so its own
   * wait row never minted; `carried` stops there, a clean carried shape
   * whose round holds no sibling gap.
   */
  async function parkAgentWaitResumeShape(
    shape: 'orphan' | 'carried',
  ): Promise<void> {
    state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journalStore = new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: state.root,
      sessionId: SESSION_ID,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore,
      resourceStore: resources,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              sessionId: SESSION_ID,
              toolProfile: 'hosted-workspace-shell/1',
            }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from(JSON.stringify({ cwd: state.root })),
        ),
        createdBy: 'hosted-harness',
      },
    });
    try {
      const harness = createManagedHarnessHandle(managed);
      const contentRef = await managed.resources.publish(
        'managed-input',
        Buffer.from(JSON.stringify([{ type: 'text', text: 'audit' }])),
      );
      const admissionRef = await managed.resources.publish(
        'managed-admission',
        Buffer.from(
          JSON.stringify({ promptId: PROMPT_ID, digest: 'a'.repeat(64) }),
        ),
      );
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: PROMPT_ID,
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: PROMPT_ID,
          turnId: PROMPT_ID,
          source: 'hosted-harness',
          contentRef,
          admissionRef,
          deadline: null,
          wakeReason: 'input',
        },
      );
      await harness.ensureRunnable();
      const children = new HostedChildAgentSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      const definition = {
        definitionId: 'hosted-agent/hosted-workspace-shell/1',
        definitionRevision: 1,
        definitionDigest: managed.authority.sessionHeader.definitionRef.digest,
      };
      const fg1 = `${PROMPT_ID}:call-1`;
      const launched1 = await children.admit({
        childRunId: fg1,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'first audit',
        prompt: 'review one',
        definition,
        workspaceMode: 'shared',
        workingDirectory: '.',
        executionCallId: fg1,
      });
      // The dead batch's own round: it reached call-1's wait; the orphan
      // shape's call-2 is the call its owner never reached.
      const parts =
        shape === 'orphan'
          ? [
              { functionCall: { id: 'call-1', name: 'agent', args: {} } },
              { functionCall: { id: 'call-2', name: 'agent', args: {} } },
            ]
          : [{ functionCall: { id: 'call-1', name: 'agent', args: {} } }];
      await managed.sink.write({
        uuid: 'assistant-1',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: state.root,
        version: 'test',
        daemonPromptId: PROMPT_ID,
        message: { role: 'model', parts },
      });
      await harness.commitAwaitAgent(
        [
          {
            childRunId: fg1,
            functionCallId: 'call-1',
            toolName: 'agent',
            modelMessageId: 'assistant-1',
            consumed: false,
          },
        ],
        { turnId: PROMPT_ID, promptId: PROMPT_ID },
        { attemptId: 'attempt-1', routeRef: launched1.inputRef },
      );
      await children.dispatchStarted(fg1, {
        dispatchId: 'dispatch-1',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach(fg1, 'child-session-1');
      await children.settleCompleted(fg1, {
        result: Buffer.from('{"review":"one clean"}', 'utf8'),
        receipt: Buffer.from('{"stopReason":"end_turn"}', 'utf8'),
      });
      await children.accept(fg1, {});
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: 'assistant-1',
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: state.root,
        version: 'test',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'agent',
                response: { output: '{"review":"one clean"}' },
              },
            },
          ],
        },
      });
      const advanced = await harness.resolveAwaitAgent(fg1);
      expect(advanced?.continuation.phase).toBe('model_output_committed');
      if (shape === 'orphan') {
        const fg2 = `${PROMPT_ID}:call-2`;
        // Admitted in the admit→commit gap: the wait row for call-2 was
        // never minted, so the cancelled takeover meets it as a ledger
        // orphan, never as another wait (R2-2).
        await children.admit({
          childRunId: fg2,
          ownerScopeId: SESSION_ID,
          rootSessionId: SESSION_ID,
          completion: 'tool',
          description: 'second audit',
          prompt: 'review two',
          definition,
          workspaceMode: 'shared',
          workingDirectory: '.',
          executionCallId: fg2,
        });
      }
    } finally {
      await managed.close();
    }
  }

  it('settles the cancelled takeover of an admitted foreground orphan without waiting on it (R2-2)', async () => {
    await parkAgentWaitResumeShape('orphan');
    const { server, loaded } = await loadReplacement(
      true,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    expect(recovery.phase).toBe('await_agent');
    // The orphan never settles in this test: an un-aborted fill would hold
    // this reply hostage to the child's terminal forever.
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const body = JSON.stringify(transcript.body);
    // The admitted orphan meets the live arm's abandoned answer, never the
    // never-admitted one and never a poll.
    expect(body).toContain('cancelled before the child agent finished');
    expect(body).not.toContain(
      'cancelled before this child agent was admitted',
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 8000);

  // A6 (R1-4): the ledger-less gap block's observable outcome at the real
  // continue route — the family error becomes a retriable recovery block,
  // never a fabricated never-ran fold. The drift is built into the load
  // (suppressChildAgents on a version-0 lane), not hand-passed.
  it('blocks the ledger-less child gap on continue and still lets cancel terminate (A6)', async () => {
    await parkAgentWaitResumeShape('orphan');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    spyOnAcquire().mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: 'hosted-workspace-shell/1',
      driveRuntimeRecovery: true,
      // The drift the guard exists for: the replacement loads without the
      // child lane the original admitted its children under.
      suppressChildAgents: true,
    });
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    const retried = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(retried.status).toBe(409);
    expect(retried.body.code).toBe('hosted_turn_recovery_required');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The gap owes an answer; it must not receive a fabricated one.
    expect(JSON.stringify(transcript.body)).not.toContain(
      'interrupted before this child agent was admitted',
    );
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const settledTranscript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const settledBody = JSON.stringify(settledTranscript.body);
    expect(settledBody).toContain('outcome is unknown');
    expect(settledBody).not.toContain('never ran');
    expect(settledTranscript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ promptId: PROMPT_ID })
      .expect(204);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 30_000);

  // A6 (R1-2): the cancel route pre-aborts the gap fill so the cancel
  // settles at once. Under the same drift the guard must stay exempt there
  // — a throwing fill would wedge the cancel in a deterministic 503 loop
  // and the Turn could never settle.
  it('still settles the cancelled takeover when the child ledger drifted away (A6)', async () => {
    await parkAgentWaitResumeShape('orphan');
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: 'hosted-workspace-shell/1',
      passiveManagedRuntimeRecovery: true,
      suppressChildAgents: true,
    });
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // Without the ledger the pre-aborted fill answers the unknown outcome
    // — terminating, but claiming nothing about a child it cannot see.
    const cancelledBody = JSON.stringify(transcript.body);
    expect(cancelledBody).toContain('outcome is unknown');
    expect(cancelledBody).not.toContain('never ran');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 20_000);

  it('the carried all-consumed continue adopts the takeover without claiming the mount (R2-1/R2-3)', async () => {
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    spyOnAcquire().mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_agent');
    expect(recovery.executions).toMatchObject([
      {
        functionCallId: 'call-1',
        outcome: 'known',
        status: { state: 'settled' },
      },
    ]);
    // The model's next round after the recovery emits a Runtime tool: its
    // turn-bound batch is the fault line R2-1 names — without the resolved
    // adoption it throws "Runtime work cannot continue a prior activation."
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [CALL],
          [
            {
              functionCall: {
                id: CALL.callId,
                name: CALL.name,
                args: CALL.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    acquireSpy.mockClear();
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    // The Runtime batch committed as takeover-era work: the shell round's
    // own durable wait is what follows the adopted continue.
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
    // The agent-side of this arm must not claim the mount in advance:
    // resumeCommittedResults's unconditional acquire is exactly what would
    // refuse a later foreground agent call (R2-3). The carried shape's own
    // resume leg performs no acquire before the model's tool work asks.
    const firstAcquireOrder =
      acquireSpy.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER;
    const firstExecuteOrder = vi
      .mocked(HostedWorkspaceBroker.prototype.execute)
      .mock.invocationCallOrder.at(-1)!;
    expect(firstAcquireOrder).toBeLessThan(firstExecuteOrder);
    expect(
      acquireSpy.mock.calls.length,
      'the acquire belongs to the model-round tool work, never the resume arm',
    ).toBe(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('a faulting adoption read blocks the continue before the model round starts (R2-9)', async () => {
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    let calls = 0;
    const originalAuthorization =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      calls += 1;
      // The gate read answers; every later read faults — one of them is
      // the carried adoption's own authorization.
      if (calls > 1) throw new Error('store hiccup');
      return originalAuthorization.call(this);
    });
    state.model.mockClear();
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    // The swallowed-read shape would start the model round anyway; the
    // guarded one blocks the Turn first.
    expect(state.model).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('admits a continue for the parked agent wait (R1-8)', async () => {
    await parkAgentWaitTurn();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_agent');
    expect(recovery.executions).toMatchObject([
      {
        functionCallId: 'call-1',
        outcome: 'known',
        status: { state: 'executing' },
      },
    ]);
    // The gate this PR exists for: reverting it makes this answer 409
    // hosted_turn_recovery_required while the parent stays wedged.
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    // The re-driven Turn now waits on the ledger for a child that never
    // settles in this test: abandon it the way a live cancel would, so
    // the test leaves nothing in flight.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('preserves the named store failure on session status when the continuation settle cannot commit', async () => {
    // The parked carry has its child finished and consumed, so one
    // continue only owes the final model answer. The answer commits, but
    // the turn.settled journal batch itself dies once with a simulated
    // exhausted 503 — the fallback settlement then dies on the latched
    // writer, and the named failure lives in memory surfaced by
    // /session/:id/status (#13800 P2).
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(
      true,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    expect(recovery.activationId).toBeDefined();
    state.model.mockClear();
    state.model.mockResolvedValue({
      text: 'recovered reply',
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
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    try {
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
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
    // reached the store; the fallback died on the authority's stopped
    // writer without appending again (#13800 R2-9).
    expect(settlementAttempts).toBe(1);
    // The uncertain-write constraint is preserved: the same block keeps
    // refusing any further continuation — the named failure only mirrors
    // into memory and never claims a persisted terminal state.
    const replayed = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 60_000);

  it('keeps a model failure named when the continuation also meets the store', async () => {
    // The redriven answer fails on the model route, then the tool turn's
    // own finish dies against the store. The settlement still commits, and
    // it must keep the more actionable model-side name the turn already
    // computed instead of overwriting it with the store's (#13800).
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(
      true,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    expect(recovery.activationId).toBeDefined();
    state.model.mockReset();
    state.model.mockRejectedValue(new HostedModelUnavailableError());
    const finish = vi
      .spyOn(HostedWorkspaceToolTurn.prototype, 'finish')
      .mockRejectedValueOnce(new ManagedSessionStoreTransportError('flap'));
    try {
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 30_000 },
      );
      expect(finish).toHaveBeenCalled();
    } finally {
      finish.mockRestore();
    }
    // The settlement committed, so the store failure it met on the way
    // leaves no block behind: the Session is not wedged, and no reason is
    // reported for a block that does not exist (#13800 R2-12). The status
    // route omits the key when no reason is recorded.
    const status = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(status.body.recoveryBlocked).toBe(false);
    expect(status.body.recoveryReason).toBeUndefined();
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === PROMPT_ID,
    );
    expect(settled.at(-1)?.payload['stopReason']).toBe('model_unavailable');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 60_000);

  it('preserves the named store failure on session status when automatic bare-load recovery cannot settle', async () => {
    // The automatic bare-load resume drives the turn entirely inside
    // startHostedRecoveredTurn — it routes through neither the prompt
    // route nor a manual continue. A publication Session parked mid-round
    // resumes by itself on the next bare load: the owned Runtime sibling
    // is answered from its records, so the model only owes the final
    // answer. The answer succeeds, but the turn.settled journal batch
    // dies once with a simulated exhausted 503 — resumed.catch then
    // records the named failure in memory, surfaced by /session/:id/status
    // (#13800).
    domainEnablement.childRun = true;
    try {
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const manifest = await resources.publish(
        'managed-tool-result-manifest',
        Buffer.from(
          JSON.stringify({
            toolResult: 'managed-tool-result/1',
            type: 'manifest',
            tenantId: key.tenantId,
            sessionId: SESSION_ID,
            turnId: PROMPT_ID,
            executionCallId: 'shell-execution',
            callId: 'model-shell-call',
            invocationDigest: 'digest',
            bindingGeneration: '1',
            captureId: randomUUID(),
            revision: 1,
            executionStatus: 'success',
            exitCode: 0,
            signal: null,
            captureScope: 'process_pipes',
            capturePolicy: 'complete_required',
            captureStatus: 'complete',
            captureReason: null,
            upstreamTruncated: false,
            contents: ['stdout', 'stderr'].map((streamId) => ({
              streamId,
              role: streamId,
              mimeType: 'application/octet-stream',
              state: 'sealed',
              byteLength: 0,
              digest: createHash('sha256').update('').digest('hex'),
              missingRanges: [],
              body: { pages: [] },
            })),
          }),
        ),
      );
      const envelope = {
        executionStatus: 'success' as const,
        responseParts: [{ text: 'hi' }],
        capture: {
          manifest,
          captureStatus: 'complete' as const,
          captureReason: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding-1',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
        executionCallId: 'shell-execution',
        runtimeBindingId: 'binding-1',
        bindingGeneration: '1',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue(
        envelope,
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'acknowledgeV3',
      ).mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockResolvedValue('1');
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      state.publicationRequest.mockImplementation(
        async (
          resourceStore: LocalManagedSessionResourceStore,
          route: string,
          body: unknown,
        ) => {
          if (route === '/grants') return { state: 'OPEN' };
          if (route === '/receipts/verify') return body;
          if (route.endsWith('/finished')) return { result: envelope };
          if (route.endsWith('/admissions/prepare'))
            return resourceStore.publish(
              'managed-tool-outcome',
              Buffer.from(JSON.stringify(body)),
            );
          throw new Error('Unexpected publication route ' + route);
        },
      );
      const first = await app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"task_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const teamCall = [
        {
          name: 'team_create',
          callId: 'call-0',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      const batch = [
        {
          name: 'run_shell_command',
          callId: 'model-shell-call',
          args: { command: 'printf hi' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit the auth module', description: 'd' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        // A team call after the crash point never runs: it commits nothing.
        {
          name: 'task_create',
          callId: 'call-3',
          args: { subject: 'Fix the auth module', description: 'f' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        await toolTurn!.declarations(signal);
        await toolTurn!.execute(
          teamCall,
          teamCall.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        const answers = await toolTurn!.execute(
          batch,
          batch.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        void answers;
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'shell then sibling' }];
      await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
            supertest(first).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(killed).toBe(true);
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      await headers(supertest(first).delete(`/session/${SESSION_ID}`));
      // The injection arms only once the dead Harness is gone: every
      // journal batch around the recovery still commits — receipt
      // recovery, Runtime sibling answers, model records — and the 503
      // hits only the batch that carries the turn's settled event.
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
      let resumed: Part[] | undefined;
      state.model.mockImplementationOnce(async (input) => {
        resumed = [
          ...((input as { resumeFromToolResults?: Part[] })
            .resumeFromToolResults ?? []),
        ];
        return { text: 'resumed', model: 'test-model' };
      });
      const second = await app(true);
      const loaded = await headers(
        supertest(second).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      try {
        expect(loaded.status).toBe(200);
        // The bare load really drove the round — the model answered
        // against the journaled results — and only then did the
        // settlement write die, so the status converges to the named
        // failure rather than to a load refusal.
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        // An empty replay is defined too: pin that the load really passed
        // the journaled siblings through, by the batch's own call ids.
        for (const id of ['model-shell-call', 'call-2', 'call-3'])
          expect(
            resumed!.some((part) => part.functionResponse?.id === id),
          ).toBe(true);
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-3')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(second).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
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
      // Only the recovered turn's own settlement reached the store; nothing
      // on the bare-load path retried it past the stopped writer (#13800
      // R2-9).
      expect(settlementAttempts).toBe(1);
      // The uncertain-write constraint is preserved: the same block keeps
      // refusing any further turn — the named failure only mirrors into
      // memory and never claims a persisted terminal state.
      const refusedPrompt = [{ type: 'text', text: 'hello' }];
      const refused = await headers(
        supertest(second).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: refusedPrompt,
          promptId: '22222222-2222-4222-8222-222222222222',
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(refusedPrompt)).digest('hex')}`,
        });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      await headers(supertest(second).delete(`/session/${SESSION_ID}`));
    } finally {
      domainEnablement.childRun = true;
    }
  }, 60_000);

  it('preserves the named store failure computed by the turn when bare-load recovery cannot settle', async () => {
    // The same automatic bare-load resume as the witness above, but the
    // failure bites one commit earlier: the model has already answered,
    // and the assistant record's own journal batch dies once with a
    // synthetic exhausted 503. executeHostedTurn's model stage names the
    // store failure itself, yet the terminal write then dies on the armed
    // write latch — the helper's catch sees only
    // ManagedSessionWritesStoppedError and must keep the stopReason the
    // turn already computed (#13800).
    domainEnablement.childRun = true;
    try {
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const manifest = await resources.publish(
        'managed-tool-result-manifest',
        Buffer.from(
          JSON.stringify({
            toolResult: 'managed-tool-result/1',
            type: 'manifest',
            tenantId: key.tenantId,
            sessionId: SESSION_ID,
            turnId: PROMPT_ID,
            executionCallId: 'shell-execution',
            callId: 'model-shell-call',
            invocationDigest: 'digest',
            bindingGeneration: '1',
            captureId: randomUUID(),
            revision: 1,
            executionStatus: 'success',
            exitCode: 0,
            signal: null,
            captureScope: 'process_pipes',
            capturePolicy: 'complete_required',
            captureStatus: 'complete',
            captureReason: null,
            upstreamTruncated: false,
            contents: ['stdout', 'stderr'].map((streamId) => ({
              streamId,
              role: streamId,
              mimeType: 'application/octet-stream',
              state: 'sealed',
              byteLength: 0,
              digest: createHash('sha256').update('').digest('hex'),
              missingRanges: [],
              body: { pages: [] },
            })),
          }),
        ),
      );
      const envelope = {
        executionStatus: 'success' as const,
        responseParts: [{ text: 'hi' }],
        capture: {
          manifest,
          captureStatus: 'complete' as const,
          captureReason: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding-1',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
        executionCallId: 'shell-execution',
        runtimeBindingId: 'binding-1',
        bindingGeneration: '1',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue(
        envelope,
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'acknowledgeV3',
      ).mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockResolvedValue('1');
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      state.publicationRequest.mockImplementation(
        async (
          resourceStore: LocalManagedSessionResourceStore,
          route: string,
          body: unknown,
        ) => {
          if (route === '/grants') return { state: 'OPEN' };
          if (route === '/receipts/verify') return body;
          if (route.endsWith('/finished')) return { result: envelope };
          if (route.endsWith('/admissions/prepare'))
            return resourceStore.publish(
              'managed-tool-outcome',
              Buffer.from(JSON.stringify(body)),
            );
          throw new Error('Unexpected publication route ' + route);
        },
      );
      const first = await app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"task_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const teamCall = [
        {
          name: 'team_create',
          callId: 'call-0',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      const batch = [
        {
          name: 'run_shell_command',
          callId: 'model-shell-call',
          args: { command: 'printf hi' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit the auth module', description: 'd' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        // A team call after the crash point never runs: it commits nothing.
        {
          name: 'task_create',
          callId: 'call-3',
          args: { subject: 'Fix the auth module', description: 'f' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        await toolTurn!.declarations(signal);
        await toolTurn!.execute(
          teamCall,
          teamCall.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        const answers = await toolTurn!.execute(
          batch,
          batch.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        void answers;
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'shell then sibling' }];
      await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
            supertest(first).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(killed).toBe(true);
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      await headers(supertest(first).delete(`/session/${SESSION_ID}`));
      // One shot, one commit earlier than the witness above: the batch that
      // carries the model's own assistant record is the only one refused.
      // Later batches pass through the injection again, but the armed write
      // latch keeps the terminal write from ever reaching the store.
      const originalAppend =
        LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
      let armed = true;
      const failing = vi
        .spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        )
        .mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          const body = JSON.stringify(records);
          if (
            !armed ||
            !body.includes('"message.committed"') ||
            !body.includes('"role":"assistant"')
          ) {
            return originalAppend.call(this, records);
          }
          armed = false;
          throw new ManagedSessionStoreHttpError(
            503,
            'synthetic-http-retry-exhaustion',
            'synthetic 503 after HTTP retries are spent',
          );
        });
      let resumed: Part[] | undefined;
      state.model.mockImplementationOnce(async (input) => {
        resumed = [
          ...((input as { resumeFromToolResults?: Part[] })
            .resumeFromToolResults ?? []),
        ];
        return { text: 'resumed', model: 'test-model' };
      });
      const second = await app(true);
      const loaded = await headers(
        supertest(second).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      try {
        expect(loaded.status).toBe(200);
        // The bare load really drove the round — the model answered
        // against the journaled results — and only then did the assistant
        // commit die, so the named failure comes from the turn's own
        // bookkeeping rather than from the latch marker.
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        // An empty replay is defined too: pin that the load really passed
        // the journaled siblings through, by the batch's own call ids.
        for (const id of ['model-shell-call', 'call-2', 'call-3'])
          expect(
            resumed!.some((part) => part.functionResponse?.id === id),
          ).toBe(true);
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-3')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(second).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
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
      // The one shot really fired: the assistant batch met the store, not
      // some later write (#13800 R2-9).
      expect(armed).toBe(false);
      // The uncertain-write constraint is preserved: the same block keeps
      // refusing any further turn — the named failure only mirrors into
      // memory and never claims a persisted terminal state.
      const refusedPrompt = [{ type: 'text', text: 'hello' }];
      const refused = await headers(
        supertest(second).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: refusedPrompt,
          promptId: '55555555-5555-4555-8555-555555555555',
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(refusedPrompt)).digest('hex')}`,
        });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      // The journal agrees: no turn.settled for the recovered turn landed.
      // The transcript also carries the crashed first Harness's events, so
      // the scan keys on the turn rather than on the kind alone (#13800
      // R2-13).
      const saved = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        saved.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toEqual([]);
      await headers(supertest(second).delete(`/session/${SESSION_ID}`));
    } finally {
      domainEnablement.childRun = true;
    }
  }, 60_000);

  it('settles the parked agent wait through the cancel route (R1-8)', async () => {
    await parkAgentWaitTurn();
    const { server, loaded } = await loadReplacement(
      true,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    expect(recovery.phase).toBe('await_agent');
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    // The cancelled takeover folded the live arm's abandoned answer and
    // advanced the checkpoint past its wait — exactly once.
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    expect(
      journal.events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === PROMPT_ID,
      ),
    ).toHaveLength(1);
    const checkpoint = journal.events.findLast(
      (event) => event.kind === 'checkpoint.committed',
    )!;
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const savedState = JSON.parse(
      (
        await resources.read(
          assertManagedSessionDurableRef(
            checkpoint.payload['stateRef'],
            'checkpoint',
          ),
        )
      ).toString(),
    );
    // The cancelled terminal advanced the checkpoint past the wait and
    // closed the Turn boundary — no carried group survives the turn's end
    // (encode drops the key for a null group, so the field is absent).
    expect(savedState.continuation.phase).toBe('before_model');
    expect(savedState.agentWait ?? null).toBeNull();
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(JSON.stringify(transcript.body)).toContain(
      'cancelled before the child agent finished',
    );
    expect(JSON.stringify(transcript.body)).toContain('"turn_complete"');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  /**
   * H4e-b3: a member's board call parked on `await_command` by an owner
   * that died mid-wait. The member is a child Session whose first input
   * carries its member preamble, so its board tools ride the command
   * channel; the cancel's abandoned answer is sabotaged, so the wait stays
   * parked with its outbound already settled.
   */
  async function parkCommandWaitTurn(): Promise<void> {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const sabotage = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (
          record.type === 'tool_result' &&
          record.daemonPromptId === PROMPT_ID
        )
          throw new Error('settlement unavailable');
        return originalWrite.call(this, record);
      });
    const server = await app(true);
    const parent = '44444444-4444-4444-8444-444444444444';
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      lineage: {
        parentSessionId: parent,
        rootSessionId: parent,
        parentChildRunId: 'run-leaf',
        depth: 1,
      },
    });
    expect(created.status).toBe(200);
    const boardCall = {
      name: 'task_create',
      callId: 'call-1',
      args: { subject: 'ship it', description: 'land the fix' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [boardCall],
          [
            {
              functionCall: {
                id: 'call-1',
                name: 'task_create',
                args: boardCall.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [
      {
        type: 'text',
        text:
          teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
          'write the board',
      },
    ];
    const payloadDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(prompt))
      .digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const latestCheckpointState = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const checkpoint = journal.events.findLast(
        (event) => event.kind === 'checkpoint.committed',
      );
      if (checkpoint === undefined) return undefined;
      return JSON.parse(
        (
          await resources.read(
            assertManagedSessionDurableRef(
              checkpoint.payload['stateRef'],
              'checkpoint',
            ),
          )
        ).toString(),
      );
    };
    // Park and outbound both durable before the "crash": the cancel then
    // settles a committed entry, never a call that had not sent yet.
    await vi.waitFor(
      async () => {
        expect((await latestCheckpointState())?.continuation.phase).toBe(
          'await_command',
        );
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        });
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'session_command',
          ),
        ).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    sabotage.mockRestore();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const savedState = await latestCheckpointState();
    expect(savedState.continuation.phase).toBe('await_command');
    expect(savedState.commandWait.runs).toMatchObject([
      { functionCallId: 'call-1', folded: false },
    ]);
  }

  // The command wait recovers like the agent wait: the coordinator's
  // continue re-enters it and folds the call from its journal. A gate
  // that admits only the agent wait leaves the member's Turn refused
  // forever.
  it('admits a continue for the parked command wait and folds it from the journal', async () => {
    await parkCommandWaitTurn();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_command');
    expect(recovery.executions).toMatchObject([
      {
        functionCallId: 'call-1',
        outcome: 'known',
        status: { state: 'executing' },
      },
    ]);
    // The member's Turn never held the mount: its resume must not claim
    // the Workspace it shares with its lead.
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The cancelled entry answers as its journal committed it.
    expect(JSON.stringify(transcript.body)).toContain(
      'The command was cancelled before it ran; it never left.',
    );
    expect(acquire).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('hands the mount back when a continued Turn goes recovery blocked again (#13800)', async () => {
    await parkCommandWaitTurn();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'continue-claim',
    );
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    state.model.mockImplementationOnce(async () => {
      throw new HostedToolRecoveryRequiredError(new Error('uncertain again'));
    });
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    // The recovery fleet's own lane parks like the prompt route: the mount
    // goes back once, the READY identity stays for the next re-drive.
    expect(
      releaseMount.mock.calls.filter(([claim]) => claim === 'continue-claim'),
    ).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  // R13-1: a continue that settles the member's Turn without resuming it
  // must still answer the committed board call from its command journal.
  // The fold skips committed-nothing calls (`uncommitted: 'none'`), so a
  // fold without the Session's command funnel leaves call-1 unpaired under
  // the terminal record.
  it.each([
    {
      exit: 'the compensating settle after a lost resume',
      fault: () =>
        vi
          .spyOn(ManagedSessionRecordSink.prototype, 'project')
          .mockRejectedValueOnce(new Error('projection lost')),
    },
    {
      exit: 'the direct settle after a raw drive failure',
      fault: () =>
        vi
          .spyOn(HostedWorkspaceToolTurn.prototype, 'resumeCommandWaitRuns')
          .mockRejectedValueOnce(new Error('relay lost')),
    },
  ])(
    'answers the committed board command from its journal on $exit',
    async ({ fault }) => {
      await parkCommandWaitTurn();
      const { server, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      const injected = fault();
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The fault fired: the resume never answered call-1 itself.
      expect(injected).toHaveBeenCalled();
      const transcript = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      const events = transcript.body.events as Array<{
        type: string;
        promptId?: string;
        data?: {
          record?: {
            type?: string;
            message?: {
              parts?: Array<{
                functionResponse?: { id?: string; response?: unknown };
              }>;
            };
          };
        };
      }>;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      const answers = events
        .filter(
          (event) =>
            event.type === 'managed_journal_event' &&
            event.data?.record?.type === 'tool_result',
        )
        .flatMap((event) => event.data?.record?.message?.parts ?? [])
        .filter((part) => part.functionResponse?.id === 'call-1');
      expect(answers).toHaveLength(1);
      expect(JSON.stringify(answers[0]!.functionResponse!.response)).toContain(
        'The command was cancelled before it ran; it never left.',
      );
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    },
  );
});

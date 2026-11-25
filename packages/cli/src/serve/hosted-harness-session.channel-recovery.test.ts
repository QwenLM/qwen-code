/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  SESSION_ID,
  app,
  headers,
  hookPin,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  capturedWakeSession,
  mockBrokerBroker,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionStoreTransportError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { channelInputId } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { HostedChannelSession } from './hosted-channel-session.js';
import { submitPrEventInput } from './hosted-pr-watch-session.js';
import { PR_EVENT_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-pr-watch-operations.js';
import { commitHostedFileHistory } from './hosted-file-history.js';
import { oweHostedTurnCleanup } from './hosted-turn-cleanup.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { HOSTED_TOOL_APPROVAL_POLICY } from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { createMonitorWakeRunTurn } from './hosted-monitor-wake-turn.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  /**
   * A pump-owned turn died inside write_file, leaving an await_runtime
   * checkpoint and file_history.pendingTurn. Shared by the attachment
   * and the transient-retry witnesses. `inputSource` selects which wake
   * source owns the parked turn — channel by default, pr_event for the
   * PR-watch load-gate witness.
   */
  async function prewriteChannelWriteInterruption(
    cleanupDebt = false,
    previousPromptId?: string,
    interruption: 'runtime' | 'queued' | 'approval' = 'runtime',
    inputSource: 'channel' | 'pr_event' = 'channel',
  ): Promise<string> {
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
              toolProfile: 'hosted-workspace-files/1',
              ...(cleanupDebt || previousPromptId
                ? {}
                : { hookCatalog: hookPin }),
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
    const channelIdentity = {
      tenantId: 'tenant',
      channelInstanceId: 'mail-1',
      accountGeneration: 1,
      platformEventId: '1700:99',
      semanticRevision: 1,
    };
    const channelTurn =
      inputSource === 'pr_event'
        ? `prw-${'c'.repeat(64)}:input`
        : channelInputId(channelIdentity);
    try {
      const channels = new HostedChannelSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );

      if (previousPromptId) {
        const content = Buffer.from(
          JSON.stringify([{ type: 'text', text: 'prior completed turn' }]),
        );
        await managed.authority.submitInput(
          {
            operation: 'submitInput',
            commandId: previousPromptId,
            sessionKey: key,
            contentDigest: createHash('sha256').update(content).digest('hex'),
          },
          {
            inputId: previousPromptId,
            turnId: previousPromptId,
            source: 'hosted-harness',
            contentRef: await resources.publish('managed-input', content),
            admissionRef: await resources.publish(
              'managed-admission',
              Buffer.from('{}'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        );
        await createManagedHarnessHandle(managed).ensureRunnable();
        await managed.sink.write({
          uuid: `${previousPromptId}:terminal`,
          parentUuid: null,
          sessionId: SESSION_ID,
          timestamp: new Date().toISOString(),
          type: 'system',
          subtype: 'turn_result',
          cwd: state.root,
          version: 'hosted-harness/1',
          daemonPromptId: previousPromptId,
          systemPayload: {
            promptId: previousPromptId,
            state: 'completed',
            stopReason: 'end_turn',
            endedAt: Date.now(),
          },
        } as ChatRecord);
      }
      if (inputSource === 'pr_event') {
        await submitPrEventInput(managed, key, {
          inputId: channelTurn,
          owner: 'Owner',
          repo: 'Repo',
          prNumber: 7,
          transition: 'ci_failure',
          headSha: 'a'.repeat(40),
          evidence: 'Failed checks: build.',
          text: 'write deploy.txt',
          episode: 1,
        });
      } else {
        await channels.submitInput({
          inputId: channelTurn,
          channelInstanceId: channelIdentity.channelInstanceId,
          accountId: 'agent@example.com',
          accountGeneration: channelIdentity.accountGeneration,
          platformEventId: channelIdentity.platformEventId,
          semanticRevision: 1,
          scope: {
            kind: 'chat_thread',
            senderId: null,
            chatId: 'alice@example.com',
            threadId: 'thread-1',
          },
          policy: {
            adapter: 'email',
            senderPolicy: 'allowlist',
            allowedSenders: ['alice@example.com'],
            dispatchMode: 'followup',
          },
          senderId: 'alice@example.com',
          chatId: 'alice@example.com',
          threadId: 'thread-1',
          subject: 'Deploy',
          text: 'write deploy.txt',
          attachments: [],
          replyContext: { parent: '<a@example.com>', references: [] },
        });
      }
      if (interruption === 'queued') return channelTurn;
      // The wake turn began — its user record is minted — and died inside
      // write_file before the tool result arrived.
      await managed.sink.write({
        uuid: `${channelTurn}:user`,
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: channelTurn,
        message: { role: 'user', parts: [{ text: 'write deploy.txt' }] },
      } as ChatRecord);
      const harness = createManagedHarnessHandle(managed);
      await harness.ensureRunnable();
      if (interruption === 'approval') {
        const requestId = 'channel-recovery-approval';
        const invocationRef = await resources.publish(
          'managed-tool-input',
          Buffer.from('{}'),
        );
        const now = Date.now();
        const optionsRef = await resources.publish(
          'managed-action-options',
          Buffer.from(
            JSON.stringify({
              v: 3,
              requestId,
              turnId: channelTurn,
              functionCallId: 'approval-call',
              toolName: 'write_file',
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
              inputRevision: 1,
              createdAt: now,
              expiresAt: now + 600_000,
              options: [
                { id: 'allow', label: 'Allow' },
                { id: 'deny', label: 'Deny' },
              ],
            }),
          ),
        );
        await harness.commitDurableWait(
          {
            requestId,
            kind: 'permission',
            source: 'tool_call',
            optionsRef,
            inputRevision: '1',
            invocationRef,
            attemptId: 'approval-attempt',
            routeRef: invocationRef,
          },
          { turnId: channelTurn, promptId: channelTurn },
        );
        return channelTurn;
      }
      if (cleanupDebt) {
        const broker = new HostedWorkspaceBroker(
          { baseUrl: 'http://127.0.0.1:1', token: 'test' },
          key,
          channelTurn,
        );
        broker.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
        await oweHostedTurnCleanup(managed, channelTurn, broker);
      }
      const activation = managed.activation;
      const executionId = 'exec-channel-write';
      const toolDefinitionRef = await resources.publish(
        'managed-tool-definition',
        Buffer.from(JSON.stringify({ name: 'write_file' })),
      );
      const toolInput = await resources.publish(
        'managed-tool-input',
        Buffer.from(
          JSON.stringify({
            harnessSessionId: SESSION_ID,
            runtimeSessionId: channelTurn,
            payloadJson: JSON.stringify({
              toolName: 'write_file',
              input: { file_path: 'deploy.txt', content: 'x' },
            }),
          }),
        ),
      );
      await managed.authority.appendExecutionEvent(
        {
          operation: 'toolIntent',
          commandId: `tool-intent:${executionId}`,
          sessionKey: key,
          contentDigest: toolInput.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-intent:${executionId}`,
          sessionKey: key,
          kind: 'tool.intent',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            ...activation,
          },
          payload: {
            executionCallId: executionId,
            batchId: 'batch-1',
            ordinal: 0,
            toolDefinitionRef,
            argsRef: toolInput,
            outcomeSource: 'runtime',
          },
        }),
        { class: 'harness', activation },
      );
      await harness.commitAwaitRuntimeBatch(
        [
          {
            functionCallId: 'call-1',
            toolName: 'write_file',
            executionCallId: executionId,
            invocationBindingId: executionId,
            capabilityVersion: 'workspace-capability/1',
            policyVersion: 'preapproved-workspace-tools/1',
            mediaVersion: null,
            modelMessageId: 'message-1',
            partIndex: 0,
            ordinal: 0,
            inputDigest: 'a'.repeat(64),
            progressCursor: null,
            attemptId: 'attempt-1',
            routeRef: toolInput,
          },
        ],
        { turnId: channelTurn, promptId: channelTurn },
      );
      await commitHostedFileHistory(managed, {
        schemaVersion: 1,
        state: { ownerSessionId: SESSION_ID, snapshots: [], files: {} },
        pendingTurn: channelTurn,
        pendingUndo: null,
      });
    } finally {
      await managed.close();
    }
    return channelTurn;
  }

  async function loadChannelWakePark(
    interruption: 'runtime' | 'queued' | 'approval' = 'runtime',
  ) {
    const turnId = await prewriteChannelWriteInterruption(
      false,
      undefined,
      interruption,
    );
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    return {
      turnId,
      server,
      clientId: loaded.body.clientId,
      resident: capturedWakeSession(),
    };
  }

  it('recovers a blocked channel wake through its interruption funnel', async () => {
    const { turnId, server, clientId, resident } = await loadChannelWakePark();
    const scheduler = resident.monitorWake as unknown as {
      deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
    };
    scheduler.deps.failed(new Error('wake pump failure'));
    await scheduler.deps.recoverBlocked();
    expect(resident.blocked).toBe(false);
    const settlements = resident.managed.authority
      .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
      .filter(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
      );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'harness_interruption',
    });
    expect(
      (await hostedHistory.readHostedFileHistory(resident.managed))
        ?.pendingTurn ?? null,
    ).toBeNull();
    const channels = (resident as unknown as { channels: HostedChannelSession })
      .channels;
    expect(await channels.planReply(turnId)).toBeUndefined();
    await scheduler.deps.recoverBlocked();
    expect(state.model).not.toHaveBeenCalled();
    const prompt = [{ type: 'text', text: 'what happened to the deployment?' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce(), {
      timeout: settleTimeoutMs(),
    });
    const input = state.model.mock.calls[0]![0] as unknown as {
      history: ChatRecord[];
    };
    expect(
      input.history.find(
        (entry) => entry.daemonPromptId === turnId && entry.type === 'user',
      )?.message?.parts,
    ).toEqual([{ text: 'write deploy.txt' }]);
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
  });

  it('never cancels a queued channel input while repairing a blocked wake pump', async () => {
    const { turnId, server, clientId, resident } =
      await loadChannelWakePark('queued');
    const scheduler = resident.monitorWake as unknown as {
      deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
    };
    scheduler.deps.failed(new Error('wake input read failure'));
    await scheduler.deps.recoverBlocked();
    expect(resident.blocked).toBe(true);
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .filter(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
        ),
    ).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('keeps channel approval resolvable after a wake pump failure', async () => {
    const { turnId, server, clientId, resident } =
      await loadChannelWakePark('approval');
    const scheduler = resident.monitorWake as unknown as {
      deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
    };
    scheduler.deps.failed(
      new Error('wake pump failed with an approval pending'),
    );
    await scheduler.deps.recoverBlocked();
    expect(resident.blocked).toBe(false);
    expect(
      resident.managed.authority.action('channel-recovery-approval')?.state,
    ).toBe('requested');
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
        ),
    ).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    await headers(
      supertest(server).post(
        `/session/${SESSION_ID}/actions/channel-recovery-approval/resolve`,
      ),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        optionId: 'allow',
        inputRevision: 1,
        policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      })
      .expect(200);
    expect(
      resident.managed.authority.action('channel-recovery-approval')?.state,
    ).toBe('decided');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it.each(['broker', 'checkpoint'] as const)(
    'retries blocked channel recovery after a %s refusal',
    async (fault) => {
      const { turnId, server, clientId, resident } =
        await loadChannelWakePark();
      const checkpoint =
        fault === 'checkpoint'
          ? vi
              .spyOn(resident.managed.authority, 'harnessRunAuthorization')
              .mockResolvedValue({ status: 'blocked', reason: 'invalid_state' })
          : undefined;
      if (fault === 'broker')
        vi.mocked(HostedWorkspaceBroker.prototype.status).mockRejectedValueOnce(
          new Error('broker unavailable'),
        );
      const scheduler = resident.monitorWake as unknown as {
        deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
      };
      scheduler.deps.failed(new Error('wake pump failure'));
      await scheduler.deps.recoverBlocked();
      expect(resident.blocked).toBe(true);
      expect(
        (await hostedHistory.readHostedFileHistory(resident.managed))
          ?.pendingTurn,
      ).toBe(turnId);
      checkpoint?.mockRestore();
      await scheduler.deps.recoverBlocked();
      expect(resident.blocked).toBe(false);
      const settlements = resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .filter(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
        );
      expect(settlements).toHaveLength(1);
      expect(settlements[0]!.payload).toMatchObject({
        outcome: 'cancelled',
        stopReason: 'harness_interruption',
      });
      expect(
        (await hostedHistory.readHostedFileHistory(resident.managed))
          ?.pendingTurn ?? null,
      ).toBeNull();
      expect(state.model).not.toHaveBeenCalled();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    },
  );

  it('refuses a fresh prompt while a channel wake holds a Runtime park', async () => {
    const { server, clientId, resident } = await loadChannelWakePark();
    const promptId = randomUUID();
    const prompt = [{ type: 'text', text: 'Wait for channel recovery' }];
    const response = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(409);
    expect(response.body.code).toBe('hosted_turn_recovery_in_progress');
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === promptId,
        ),
    ).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('recovers a channel turn interrupted inside a Write at attachment instead of refusing the load', async () => {
    // The R4 P1 witness: the load gate refused every attachment shape (the
    // input is pump-owned, so no takeover can match the marker) and the
    // pump that would settle the turn never started. The gate now lets the
    // pump's own recovery load.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const server = await app(true);
    // Refused 409 hosted_turn_recovery_required before the gate exception.
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // …and the pump settles right after attachment, with the stop proven
    // through the Broker rather than assumed.
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
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === channelTurn,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload).toMatchObject({
          outcome: 'cancelled',
          stopReason: 'harness_interruption',
        });
      },
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(
      async () => {
        const history = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .expect(200);
        expect(history.body.history?.pendingTurn ?? null).toBeNull();
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      vi.mocked(HostedWorkspaceBroker.prototype.status),
    ).toHaveBeenCalled();
    // The handback lands after the durable markers the waitFor blocks on
    // above; asserting it synchronously races them (round 6's flaky probe).
    await vi.waitFor(
      async () => {
        expect(
          vi.mocked(HostedWorkspaceBroker.prototype.release),
        ).toHaveBeenCalled();
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('cold-loads a pr_event turn parked inside a Workspace write instead of refusing the load', async () => {
    // R2-1: the load gate's pump-owned exemption must cover pr_event too.
    // The input is pump-owned, so no takeover can match its pendingTurn;
    // narrowing isPumpOwnedToolTurn back to channel-only refuses this load
    // 409 hosted_turn_recovery_required and kills the pump that would
    // settle the turn.
    const prEventTurn = await prewriteChannelWriteInterruption(
      false,
      undefined,
      'runtime',
      'pr_event',
    );
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const readJournal = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
    // The park really is a pr_event turn's, not a channel one.
    const accepted = (await readJournal()).events.filter(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['turnId'] === prEventTurn,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload['source']).toBe(PR_EVENT_INPUT_SOURCE);
    // …and the pump recovers the parked attempt right after attachment
    // rather than delivering the input as a fresh turn: no model call, and
    // the turn settles. That is what proves the load let through a turn
    // genuinely owing a file-history recovery. pr_event rides the generic
    // wake-crash aftermath, whose terminal label differs from the
    // channel-specific one, so the label itself is not pinned here.
    await vi.waitFor(
      async () => {
        const settled = (await readJournal()).events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === prEventTurn,
        );
        expect(settled).toHaveLength(1);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('retries an interrupted channel Write recovery after a transient fault instead of latching blocked', async () => {
    // The R6 P1 witness: one Broker-status fault, healthy afterwards. The
    // pump must not latch session.blocked on the first attempt — it
    // retries and the settlement still lands.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    const status = vi.spyOn(HostedWorkspaceBroker.prototype, 'status');
    status.mockRejectedValueOnce(new Error('broker hiccup'));
    status.mockResolvedValue({ state: 'settled' });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
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
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === channelTurn,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload).toMatchObject({ outcome: 'cancelled' });
      },
      { timeout: settleTimeoutMs() },
    );
    // The first attempt died at the fault; the busy retry proved the stop
    // on the second pass — never a terminal block.
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(
      async () => {
        const history = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .expect(200);
        expect(history.body.history?.pendingTurn ?? null).toBeNull();
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('keeps an interrupted channel Write honest when the stop throws post-cancel and the retry reclaims the record', async () => {
    // R8-1 through the wake funnel: attempt 1 cancels the parked execution
    // and its post-cancel poll reads a still-reconcilable unknown — a throw
    // exit of the stop loop. The busy-cadence retry then reads the
    // reclaimed record as a definitive not-found, so only the unobserved id
    // carried across the attempts keeps the settle from journaling a
    // cancellation nobody witnessed.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValueOnce({ state: 'executing' })
      .mockResolvedValueOnce({ state: 'unknown' })
      // The retry: the Broker reclaimed the record.
      .mockResolvedValue(undefined);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
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
          journal.events.filter(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === channelTurn,
          ),
        ).toHaveLength(1);
      },
      { timeout: settleTimeoutMs() },
    );
    // The parked execution's journaled outcome is the honest unobservable
    // one — never the cancelled a witnessed stop would have earned.
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const outcomes = (
      transcript.body.events as Array<{ data?: { record?: ChatRecord } }>
    )
      .filter(
        (event) =>
          event.data?.record?.type === 'tool_result' &&
          event.data.record.daemonPromptId === channelTurn,
      )
      .map(
        (event) =>
          (
            event.data?.record?.message?.parts?.[0]?.functionResponse
              ?.response as Record<string, unknown> | undefined
          )?.['executionStatus'],
      );
    expect(outcomes).toEqual(['unknown']);
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('keeps an interrupted channel Write unsettled while its settle cannot verify the park', async () => {
    // R9-2 through the wake funnel: the stop proves cleanly, but the
    // settle's own authorization re-read faults transiently — a
    // retry-inviting refusal the funnel must answer busy with, never a
    // terminal record over a turn whose parked executions the settle
    // could not see.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    // Hold the stop's first Broker read until the load answered, so the
    // settle block arms deterministically behind it; the block then
    // catches the settle's own re-read and the funnel's retryable check.
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => {
        await statusGate;
        return { state: 'settled' };
      });
    let blockSettleReads = false;
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      if (blockSettleReads)
        return {
          status: 'blocked',
          reason: 'missing_state',
          message: 'Session Store answered 503',
        } as never;
      return original.call(this);
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // The pump is parked in the stop's gated Broker read now; arm the
    // settle block behind it and let the stop through.
    await vi.waitFor(
      () => {
        expect(status.mock.calls.length).toBeGreaterThan(0);
      },
      { timeout: settleTimeoutMs() },
    );
    blockSettleReads = true;
    releaseStatus();
    // The settle's refusal surfaces as the retry-inviting busy answer.
    await vi.waitFor(
      () => {
        expect(
          stderr.mock.calls.some(([line]) =>
            String(line).includes(
              'defers its recovery to the next wake attempt',
            ),
          ),
        ).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    const readSettled = async () =>
      (
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        })
      ).events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === channelTurn,
      );
    // While the block holds, no terminal record lands over the park the
    // settle could not verify.
    expect(await readSettled()).toHaveLength(0);
    // The block lifts; the busy-cadence retry settles the turn for real.
    blockSettleReads = false;
    await vi.waitFor(
      async () => {
        expect(await readSettled()).toHaveLength(1);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it.each([false, true])(
    'retains cleanup debt after interrupted channel settlement until original-owner release succeeds (retry refused: %s)',
    async (retryRefused) => {
      const channelTurn = await prewriteChannelWriteInterruption(true);
      mockBrokerBroker();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'settled',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      let finishAutomaticRetry!: () => void;
      const automaticRetry = new Promise<void>((resolve) => {
        finishAutomaticRetry = resolve;
      });
      release.mockRejectedValueOnce(new Error('release unavailable'));
      release.mockImplementationOnce(async () => {
        await automaticRetry;
        if (retryRefused) throw new Error('retry unavailable');
      });
      const kick = HostedMonitorWakeScheduler.prototype.kick;
      // Drive the retry at a barrier so the load overlaps it without racing
      // the scheduler's clock.
      const kicks = vi
        .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
        .mockImplementation(() => undefined)
        .mockImplementationOnce(function (this: HostedMonitorWakeScheduler) {
          kick.call(this);
        });
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      });
      expect(loaded.status).toBe(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        );
      const readJournal = () =>
        LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
      await vi.waitFor(
        async () => {
          expect(release).toHaveBeenCalledTimes(1);
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).expect(200);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        // #14101: the debt settle crosses fsync-backed journal commits; the
        // default 1s waitFor window flaked on a loaded ubuntu-latest runner.
        { timeout: settleTimeoutMs() },
      );
      const parked = await readJournal();
      const terminals = parked.events.filter(
        (event) => event.kind === 'turn.settled',
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.payload['turnId']).toBe(channelTurn);
      expect(
        parked.events.filter((event) => event.kind === 'hosted.cleanup'),
      ).toHaveLength(1);
      expect(release).toHaveBeenLastCalledWith({
        bindingId: 'binding',
        generation: '1',
      });
      expect(state.model).not.toHaveBeenCalled();
      const nextPrompt = [{ type: 'text', text: 'must remain blocked' }];
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({
          prompt: nextPrompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
        })
        .expect(409);
      expect((await readJournal()).events).toHaveLength(parked.events.length);
      expect(state.model).not.toHaveBeenCalled();
      const redriven = await (async () => {
        const wake = kicks.mock.contexts[0] as HostedMonitorWakeScheduler;
        let initialPassFinished = false;
        await wake.exclusive(async () => {
          initialPassFinished = true;
        }, settleTimeoutMs());
        expect(initialPassFinished).toBe(true);
        kick.call(wake);
        const cleanup = await import('./hosted-turn-cleanup.js');
        const debt = vi.spyOn(cleanup, 'hasHostedCleanupDebt');
        try {
          await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2), {
            timeout: settleTimeoutMs(),
          });
          debt.mockClear();
          const managed = capturedWakeSession().managed;
          const loading = headers(
            supertest(server).post(`/session/${SESSION_ID}/load`),
          )
            .send({
              managedSessionStore: store(),
              passiveManagedRuntimeRecovery: true,
            })
            .then((response) => response);
          await vi.waitFor(
            () =>
              expect(
                debt.mock.calls.some(([session]) => session === managed),
              ).toBe(true),
            { timeout: settleTimeoutMs() },
          );
          finishAutomaticRetry();
          return await loading;
        } finally {
          finishAutomaticRetry();
          debt.mockRestore();
        }
      })();
      expect(redriven.status).toBe(200);
      expect(redriven.body.clientId).toBe(loaded.body.clientId);
      expect(release).toHaveBeenCalledTimes(retryRefused ? 3 : 2);
      expect(release).toHaveBeenLastCalledWith({
        bindingId: 'binding',
        generation: '1',
      });
      for (const [owner] of release.mock.calls) {
        expect(owner).toEqual({ bindingId: 'binding', generation: '1' });
      }
      for (const broker of release.mock.contexts) {
        expect((broker as HostedWorkspaceBroker).runtimeSessionId).toBe(
          hostedRuntimeSessionId(channelTurn),
        );
      }
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).expect(200);
      expect(status.body.recoveryBlocked).toBe(false);
      const journal = await readJournal();
      const confirmed = journal.events.filter(
        (event) =>
          event.kind === 'hosted.cleanup' &&
          event.payload['state'] === 'confirmed',
      );
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.sequence).toBeGreaterThan(terminals[0]!.sequence);
      expect(
        journal.events.filter((event) => event.kind === 'turn.settled'),
      ).toHaveLength(1);
      await authorize(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).expect(204);
    },
  );

  it('crosses a durable store fault to 503 instead of mislabelling it as 400 (F10)', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const body = (operationId: string, id: string, text: string) => ({
      operationId,
      kind: 'submit_input',
      inputId: id,
      channelInstanceId: 'mail-1',
      accountId: 'agent@example.com',
      accountGeneration: 1,
      platformEventId: `1700:${id === 'chin-f10a' ? 88 : 89}`,
      semanticRevision: 1,
      senderId: 'alice@example.com',
      chatId: 'alice@example.com',
      threadId: 'thread-1',
      subject: 'Bug',
      text,
      attachments: [
        {
          fileName: 'a.txt',
          mimeType: 'text/plain',
          bytesBase64: Buffer.from('note').toString('base64'),
        },
      ],
      replyContext: { parent: '<a@example.com>', references: [] },
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'alice@example.com',
        threadId: 'thread-1',
      },
      policy: {
        adapter: 'email',
        senderPolicy: 'allowlist',
        allowedSenders: ['alice@example.com'],
        dispatchMode: 'followup',
      },
    });
    // The store's own transient fault must never answer as a deterministic
    // verdict: its message class falls to the retryable envelope.
    const failed = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'publish')
      .mockImplementationOnce(async () => {
        throw new ManagedSessionStoreTransportError('Session Store flap');
      });
    const first = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send(body('aaaaaaaa-0000-4000-8000-000000000001', 'chin-f10a', 'reply'));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: 'channel_operation_failed' });
    failed.mockRestore();
    // A record-validation refusal stays the deterministic 400.
    const second = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send(
        body(
          'aaaaaaaa-0000-4000-8000-000000000002',
          'chin-f10b',
          '€'.repeat(30_000),
        ),
      );
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({
      code: 'invalid_channel_operation',
    });
    // And the healthy path admits the same work afterwards.
    const third = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send(body('aaaaaaaa-0000-4000-8000-000000000003', 'chin-f10a', 'reply'));
    expect(third.status).toBe(202);
    // The admitted turn must reach its terminal record before the close —
    // a delete that lands mid-turn answers 409 (hosted_session_busy).
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
          journal.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === 'chin-f10a',
          ),
        ).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    // The terminal record lands while the pump's own busy epoch is still
    // closing out, so the close can answer 409 for one more tick — a
    // refused close is a no-op, and the retry converges (F10's gate).
    await vi.waitFor(
      async () => {
        expect(
          (
            await headers(
              supertest(server).delete(`/session/${SESSION_ID}`),
            ).set('X-Qwen-Client-Id', clientId)
          ).status,
        ).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  it('accepts claim-fenced channel reconciliation only for an unknown settlement', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      })
      .expect(200);
    const request = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send(body);
    const operationId = `channel-reconcile:${'a'.repeat(64)}`;
    const body = {
      operationId,
      kind: 'settle_delivery',
      deliveryId: 'missing',
      outcome: 'unknown',
    };
    const settle = vi.spyOn(HostedChannelSession.prototype, 'settle');
    await request({ ...body, operationId: `${operationId}x` }).expect(400);
    await request({ ...body, outcome: 'rejected' }).expect(400);
    await request({ ...body, kind: 'cancel_delivery' }).expect(400);
    expect(settle).not.toHaveBeenCalled();
    await request(body).expect(409);
    expect(settle).toHaveBeenLastCalledWith('missing', 'unknown', operationId);
    await request({ ...body, operationId: randomUUID() }).expect(409);
    expect(settle).toHaveBeenLastCalledWith('missing', 'unknown', undefined);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
  });

  it('retries consumed channel cleanup while keeping new turns blocked', async () => {
    const previous = 'previous-prompt';
    const channelTurn = await prewriteChannelWriteInterruption(false, previous);
    mockBrokerBroker();
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const owners: string[] = [];
    let faults = 0;
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        owners.push(this.runtimeSessionId);
        if (this.runtimeSessionId === channelTurn)
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_session_not_found',
          );
        if (this.runtimeSessionId === previous && faults-- > 0)
          throw new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable');
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const resident = capturedWakeSession();
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      previous,
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, previous, broker);
    faults = 2;
    const params = wakeDeps.last as Parameters<
      typeof createMonitorWakeRunTurn
    >[0];
    expect(
      await createMonitorWakeRunTurn(params)({
        turnId: channelTurn,
        text: 'write deploy.txt',
        source: 'channel',
      }),
    ).toBe('busy');
    const scheduler = (
      resident as unknown as {
        monitorWake: {
          deps: {
            next: () => Promise<unknown>;
            recoverBlocked: () => Promise<void>;
          };
        };
      }
    ).monitorWake;
    expect(await scheduler.deps.next()).toBeUndefined();
    expect(resident.blocked).toBe(true);
    expect(resident.cleanupBlocked).toBe(true);
    await scheduler.deps.recoverBlocked();
    expect(owners.filter((id) => id === previous)).toHaveLength(2);
    expect(resident.blocked).toBe(true);
    await scheduler.deps.recoverBlocked();
    expect(owners.filter((id) => id === previous)).toHaveLength(3);
    expect(resident.blocked).toBe(false);
    expect(resident.cleanupBlocked).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    const events = resident.managed.authority.eventsInSequenceRange(
      1,
      resident.managed.authority.committedSequence,
    );
    expect(
      events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === channelTurn,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === 'hosted.cleanup').at(-1)!.payload[
        'state'
      ],
    ).toBe('confirmed');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
  });

  it('settles a channel wake whose missing Runtime has another prompt cleanup owner (R2-63)', async () => {
    const previous = 'previous-prompt';
    const channelTurn = await prewriteChannelWriteInterruption(false, previous);
    mockBrokerBroker();
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockImplementation(async function (this: HostedWorkspaceBroker) {
      if (this.runtimeSessionId === channelTurn)
        throw new HostedWorkspaceBrokerRejection(
          404,
          'runtime_session_not_found',
        );
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const resident = capturedWakeSession();
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      previous,
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, previous, broker);
    const params = wakeDeps.last as Parameters<
      typeof createMonitorWakeRunTurn
    >[0];
    const runTurn = createMonitorWakeRunTurn(params);
    await expect(
      runTurn({
        turnId: channelTurn,
        text: 'write deploy.txt',
        source: 'channel',
      }),
    ).resolves.toBe('settled');
    expect(resident.blocked).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    const events = resident.managed.authority.eventsInSequenceRange(
      1,
      resident.managed.authority.committedSequence,
    );
    expect(
      events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === channelTurn,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === 'hosted.cleanup').at(-1)!.payload[
        'state'
      ],
    ).toBe('confirmed');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
  });
});

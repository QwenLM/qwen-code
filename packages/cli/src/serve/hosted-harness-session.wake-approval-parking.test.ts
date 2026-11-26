/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SESSION_ID,
  app,
  domainEnablement,
  headers,
  setupHostedTextSession,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  mockApprovalTurn,
  mockPublicShellApproval,
  statsOf,
  statusOf,
} from './hosted-harness-session-suspension.test-helper.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as approvalContinuation from './hosted-approval-continuation.js';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { ManagedSessionStoreTransportError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { type ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { HostedChannelSession } from './hosted-channel-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
} from './hosted-tool-approval.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import * as idleSuspension from './hosted-session-suspension.js';
import {
  hostedWakeContinuationId,
  isHostedWakeContinuationId,
} from './hosted-wake-continuation.js';

describe('idle suspension', () => {
  beforeEach(setupHostedTextSession);

  // The wake Turn's approval: a file write, or with `shell` a Shell call on a
  // version-0 Shell Session's Shell lane, whose load reattaches the monitor
  // run's deliveries.
  async function mockWakeApproval(turnId: string, shell: boolean) {
    if (!shell) return mockApprovalTurn(turnId);
    await mockPublicShellApproval(false, true, turnId);
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'listStagedDeliveries',
    ).mockResolvedValue([]);
  }

  const executedToolName = () =>
    (
      JSON.parse(
        vi.mocked(HostedWorkspaceBroker.prototype.execute).mock.calls[0]![1],
      ) as { toolName: string }
    ).toolName;

  // A wake Turn has no coordinator row, so its own pump is the only thing
  // that can resume it after the Harness dies inside its approval wait. A
  // Store fault while reading the saved continuation only delays it.
  async function resumeMonitorWakeAfterDeath(fault: boolean, shell = false) {
    domainEnablement.monitorRun = true;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const turnId = 'monitor-1:notify:1';
    const toolProfile = shell
      ? 'hosted-workspace-shell/1'
      : 'hosted-workspace-files/1';
    await mockWakeApproval(turnId, shell);
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    const saved = vi.spyOn(
      approvalContinuation,
      'findHostedApprovalContinuation',
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const read = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
    try {
      const original = await app(true);
      await headers(supertest(original).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile,
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const live = (
        wakeDeps.last as {
          session: {
            managed: ManagedSession;
            monitorWake?: { kick(): void; close(): void };
          };
        }
      ).session;
      const monitors = new HostedMonitorSession(
        {
          authority: live.managed.authority,
          resources: live.managed.resources,
        },
        key,
      );
      const binding = { runtimeBindingId: 'binding-1', generation: '1' };
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', binding);
      await monitors.attach('monitor-1', binding, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await live.managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await live.managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
      live.monitorWake?.kick();
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      // The generation dies at the wait point: its pump stops and nothing
      // after it reaches the journal, exactly as after a SIGKILL.
      live.monitorWake?.close();
      await live.managed.close();
      if (fault)
        saved.mockRejectedValueOnce(
          new ManagedSessionStoreTransportError('Store unavailable'),
        );
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile,
          passiveManagedRuntimeRecovery: true,
        })
        .expect(200);
      const clientId = loaded.body.clientId as string;
      const requestId = (await read()).events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      await vi.waitFor(
        async () => {
          expect((await statusOf(replacement, clientId)).body).toMatchObject({
            hasActivePrompt: true,
          });
        },
        { timeout: 5000 },
      );
      await headers(
        supertest(replacement).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await read()).events.find(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === turnId,
            )?.payload,
          ).toMatchObject({ outcome: 'completed' });
          // The journal settles the Turn before its run releases the Runtime
          // and frees the Session's active slot, which the close requires.
          expect(
            (await statusOf(replacement, clientId).expect(200)).body
              .hasActivePrompt,
          ).toBe(false);
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      expect(executedToolName()).toBe(
        shell ? 'run_shell_command' : 'write_file',
      );
      expect(state.model).toHaveBeenLastCalledWith(
        expect.objectContaining({ resumeFromToolResults: expect.any(Array) }),
      );
      expect(
        (await read()).events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            isHostedWakeContinuationId(String(event.payload['turnId'])),
        ),
      ).toBe(false);
      await headers(supertest(replacement).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      if (fault) expect(saved.mock.calls.length).toBeGreaterThan(1);
    } finally {
      saved.mockRestore();
      waiting.mockRestore();
      state.approvalSelections.clear();
    }
  }

  // S4 (#18149): a wake-started Turn's approval wait parks behind a
  // certificate that claims its own wake, and the passive load decision
  // delivery sends resumes it through the pump. Without the control plane's
  // bit the wait stays resident.
  async function parkMonitorWakeApproval(advertised: boolean, shell = false) {
    const toolProfile = shell
      ? 'hosted-workspace-shell/1'
      : 'hosted-workspace-files/1';
    domainEnablement.monitorRun = true;
    state.wakeDispatch = true;
    state.actionParking = true;
    state.wakeActionParking = advertised;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const turnId = 'monitor-1:notify:1';
    await mockWakeApproval(turnId, shell);
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    // The direct journal writes below do not count as admitted route work.
    const armIdle = vi
      .spyOn(idleSuspension, 'armIdleSuspension')
      .mockImplementation(() => undefined);
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const read = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
    try {
      const server = await app(true, undefined, true, { idleSuspendMs: 150 });
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile,
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const live = (
        wakeDeps.last as {
          session: {
            managed: ManagedSession;
            monitorWake?: { kick(): void; close(): void };
            suspension: { rearm(): void };
          };
        }
      ).session;
      const monitors = new HostedMonitorSession(
        {
          authority: live.managed.authority,
          resources: live.managed.resources,
        },
        key,
      );
      const binding = { runtimeBindingId: 'binding-1', generation: '1' };
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', binding);
      await monitors.attach('monitor-1', binding, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await live.managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await live.managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
      live.monitorWake?.kick();
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      // The monitor exits after its last notification, so the wait is the
      // Session's only live work.
      await monitors.settleQuiet('monitor-1', 'exited');
      armIdle.mockRestore();
      live.suspension.rearm();
      const requestId = (await read()).events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      let clientId = created.body.clientId as string;
      if (!advertised) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(state.wakeStamps).toEqual([]);
        expect(statsOf(server).cleanSuspensions).toBe(0);
        expect(statsOf(server).parkRefusals.wake_owned).toBeGreaterThan(0);
      } else {
        await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
          timeout: 5000,
        });
        const stamp = state.wakeStamps[0] as {
          dueAt: number;
          parkedTurn: { wakeAt: number };
        };
        expect(stamp).toEqual({
          pending: true,
          dueAt: stamp.parkedTurn.wakeAt,
          parkedTurn: expect.objectContaining({
            promptId: turnId,
            owner: 'wake',
          }),
        });
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, clientId)).status).toBe(404);
          },
          { timeout: 5000 },
        );
        const loaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .send({
            managedSessionStore: store(),
            toolProfile,
            passiveManagedRuntimeRecovery: true,
          })
          .expect(200);
        clientId = loaded.body.clientId as string;
        await vi.waitFor(
          async () => {
            expect((await statusOf(server, clientId)).body).toMatchObject({
              hasActivePrompt: true,
            });
          },
          { timeout: 5000 },
        );
      }
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      // The resident wait's test model refuses to continue live, so only the
      // resumed one completes; either way the Turn settles.
      await vi.waitFor(
        async () => {
          expect(
            (await read()).events.find(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === turnId,
            )?.payload,
          ).toMatchObject(advertised ? { outcome: 'completed' } : {});
        },
        { timeout: 5000 },
      );
      if (advertised) {
        expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(
          1,
        );
        expect(executedToolName()).toBe(
          shell ? 'run_shell_command' : 'write_file',
        );
        expect(
          (await read()).events.some(
            (event) =>
              event.kind === 'input.accepted' &&
              isHostedWakeContinuationId(String(event.payload['turnId'])),
          ),
        ).toBe(false);
      }
      // The resident Session suspends on its own once the Turn settles; let
      // it go before the next test reads the shared wake stamps.
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      armIdle.mockRestore();
      waiting.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.wakeActionParking = false;
      state.approvalSelections.clear();
    }
  }

  it('parks a monitor wake approval and resumes it through the passive load', () =>
    parkMonitorWakeApproval(true));

  it('keeps a monitor wake approval resident without the wake parking bit', () =>
    parkMonitorWakeApproval(false));

  it('parks a monitor wake Shell approval on a version-0 Shell Session', () =>
    parkMonitorWakeApproval(true, true));

  // S4b (#18149): a channel or pr_event Turn's approval wait parks like any
  // wake Turn's, and after its Harness dies in the wait the pump resumes it
  // instead of the channel funnel settling it without a reply. Allow runs
  // the tool once, and a completed channel Turn plans its one reply.
  async function resumePumpOwnedWakeApproval(
    source: 'channel' | 'pr_event',
    interruption: 'park' | 'death',
  ) {
    const parks = interruption === 'park';
    state.wakeDispatch = parks;
    state.actionParking = parks;
    state.wakeActionParking = parks;
    state.wakeStamps.length = 0;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const turnId =
      source === 'channel' ? 'chin-approval' : `prw-${'c'.repeat(64)}:input`;
    mockApprovalTurn(turnId);
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const read = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
    const resident = () =>
      (
        wakeDeps.last as {
          session: {
            managed: ManagedSession;
            monitorWake?: { kick(): void; close(): void };
            channels?: HostedChannelSession;
          };
        }
      ).session;
    try {
      const original = parks
        ? await app(true, undefined, true, { idleSuspendMs: 150 })
        : await app(true);
      const created = await headers(supertest(original).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      await headers(
        supertest(original).post(`/session/${SESSION_ID}/channels/operations`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send(
          source === 'channel'
            ? {
                operationId: randomUUID(),
                kind: 'submit_input',
                inputId: turnId,
                channelInstanceId: 'mail-1',
                accountId: 'agent@example.com',
                accountGeneration: 1,
                platformEventId: '1700:90',
                semanticRevision: 1,
                senderId: 'alice@example.com',
                chatId: 'alice@example.com',
                threadId: 'thread-1',
                subject: 'Notes',
                text: 'write notes',
                attachments: [],
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
              }
            : {
                operationId: randomUUID(),
                kind: 'submit_pr_event_input',
                inputId: turnId,
                owner: 'Owner',
                repo: 'Repo',
                prNumber: 7,
                transition: 'ci_failure',
                headSha: 'a'.repeat(40),
                evidence: 'Failed checks: build.',
                text: 'write notes',
                episode: 1,
              },
        )
        .expect(202);
      resident().monitorWake?.kick();
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      if (parks) {
        await vi.waitFor(() => expect(state.wakeStamps).toHaveLength(1), {
          timeout: 5000,
        });
        expect(state.wakeStamps[0]).toMatchObject({
          pending: true,
          parkedTurn: { promptId: turnId, owner: 'wake' },
        });
        await vi.waitFor(
          async () => {
            expect(
              (await statusOf(original, created.body.clientId as string))
                .status,
            ).toBe(404);
          },
          { timeout: 5000 },
        );
      } else {
        // The generation dies at the wait point, exactly as after a SIGKILL.
        resident().monitorWake?.close();
        await resident().managed.close();
      }
      // A Harness that does not idle out takes the Session over, so the
      // reply plan never races a suspension of the resumed Session.
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
        })
        .expect(200);
      const clientId = loaded.body.clientId as string;
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).body).toMatchObject({
            hasActivePrompt: true,
          });
        },
        { timeout: 5000 },
      );
      const requestId = (await read()).events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId: 'allow',
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        })
        .expect(200);
      await vi.waitFor(
        async () => {
          expect(
            (await read()).events.find(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === turnId,
            )?.payload,
          ).toMatchObject({ outcome: 'completed' });
        },
        { timeout: 5000 },
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
      expect(
        (await read()).events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            isHostedWakeContinuationId(String(event.payload['turnId'])),
        ),
      ).toBe(false);
      await vi.waitFor(
        () =>
          expect(
            resident()
              .channels!.pendingDeliveries()
              .filter((delivery) => delivery.sourceTurnId === turnId),
          ).toHaveLength(source === 'channel' ? 1 : 0),
        { timeout: 5000 },
      );
      // The Turn holds its slot past its settle until its cleanup confirms.
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).body).toMatchObject({
            hasActivePrompt: false,
          });
        },
        { timeout: 5000 },
      );
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    } finally {
      waiting.mockRestore();
      state.wakeDispatch = false;
      state.actionParking = false;
      state.wakeActionParking = false;
      state.approvalSelections.clear();
    }
  }

  it.each([
    ['channel', 'park'],
    ['channel', 'death'],
    ['pr_event', 'park'],
    ['pr_event', 'death'],
  ] as const)('resumes a %s wake approval after a %s', (source, interruption) =>
    resumePumpOwnedWakeApproval(source, interruption),
  );

  it('resumes a monitor wake approval after its Harness dies in the wait', () =>
    resumeMonitorWakeAfterDeath(false));

  it('resumes a monitor wake Shell approval on a version-0 Shell Session after its Harness dies in the wait', () =>
    resumeMonitorWakeAfterDeath(false, true));

  it('retries a wake approval continuation read that a Store fault failed', () =>
    resumeMonitorWakeAfterDeath(true));

  // Stage 2 pre-check (#18149): a wake Turn is cancelled only through its
  // source's own Harness operation (an automation run's cancel_run, a child
  // run's stop), each sent after a load of its own. A plain load must attach
  // a Session whose wake Turn died in its approval wait, so that operation
  // reaches the Turn.
  it('attaches a Session whose wake Turn died in its approval wait through a plain load', async () => {
    domainEnablement.monitorRun = true;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const turnId = 'monitor-1:notify:1';
    mockApprovalTurn();
    state.model.mockImplementation(async ({ toolTurn, promptId, signal }) => {
      if (promptId !== turnId)
        return { text: 'continued', model: 'test-model' };
      const call = {
        name: 'write_file',
        callId: 'plain-load-call',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: turnId,
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
      throw new Error('The waiting Turn unexpectedly continued.');
    });
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    try {
      const original = await app(true);
      await headers(supertest(original).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const live = (
        wakeDeps.last as {
          session: {
            managed: ManagedSession;
            monitorWake?: { kick(): void; close(): void };
          };
        }
      ).session;
      const monitors = new HostedMonitorSession(
        {
          authority: live.managed.authority,
          resources: live.managed.resources,
        },
        key,
      );
      const binding = { runtimeBindingId: 'binding-1', generation: '1' };
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', binding);
      await monitors.attach('monitor-1', binding, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await live.managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await live.managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
      live.monitorWake?.kick();
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      live.monitorWake?.close();
      await live.managed.close();
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        })
        .expect(200);
      expect(loaded.body.clientId).toEqual(expect.any(String));
      await headers(supertest(replacement).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .expect(204);
    } finally {
      waiting.mockRestore();
      state.approvalSelections.clear();
    }
  });

  // The crash aftermath must leave a checkpoint the next turn can start
  // from: a wait left at await_action failed every later wake turn. A wait
  // with no saved continuation (an uncaptured batch), or one whose saved
  // continuation is durably refused, is one the pump cannot resume, so it
  // still meets the aftermath instead of being retried forever.
  async function settleMonitorWakeDeadInItsWait(refused: boolean) {
    domainEnablement.monitorRun = true;
    state.approvalSelections.set(SESSION_ID, { mode: 'default', revision: 0 });
    const turnId = 'monitor-1:notify:1';
    mockApprovalTurn();
    state.model.mockImplementation(async ({ toolTurn, promptId, signal }) => {
      if (promptId !== turnId)
        return { text: 'continued', model: 'test-model' };
      const call = {
        name: 'write_file',
        callId: 'aftermath-original-call',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: turnId,
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
      throw new Error('The waiting Turn unexpectedly continued.');
    });
    const waiting = vi.spyOn(HostedApprovalWaiters.prototype, 'wait');
    const saved = vi.spyOn(
      approvalContinuation,
      'findHostedApprovalContinuation',
    );
    if (refused)
      saved.mockRejectedValue(
        new Error('Original assistant batch is missing.'),
      );
    else saved.mockResolvedValue(undefined);
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const read = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
    const settledOf = async (id: string) =>
      (await read()).events.find(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === id,
      )?.payload;
    try {
      const original = await app(true);
      await headers(supertest(original).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const live = (
        wakeDeps.last as {
          session: {
            managed: ManagedSession;
            monitorWake?: { kick(): void; close(): void };
          };
        }
      ).session;
      const monitors = new HostedMonitorSession(
        {
          authority: live.managed.authority,
          resources: live.managed.resources,
        },
        key,
      );
      const binding = { runtimeBindingId: 'binding-1', generation: '1' };
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', binding);
      await monitors.attach('monitor-1', binding, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await live.managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await live.managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
      live.monitorWake?.kick();
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), {
        timeout: 5000,
      });
      // The generation dies at the wait point: its pump stops and nothing
      // after it reaches the journal, exactly as after a SIGKILL.
      live.monitorWake?.close();
      await live.managed.close();
      const requestId = (await read()).events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!.payload['requestId'] as string;
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
        })
        .expect(200);
      const continuation = hostedWakeContinuationId(turnId);
      const clientId = loaded.body.clientId as string;
      await vi.waitFor(
        async () => {
          expect(await settledOf(continuation)).toMatchObject({
            outcome: 'completed',
          });
          expect(
            (await statusOf(replacement, clientId).expect(200)).body
              .hasActivePrompt,
          ).toBe(false);
        },
        { timeout: 5000 },
      );
      expect(await settledOf(turnId)).toMatchObject({ outcome: 'error' });
      expect(
        (await read()).events.findLast(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['requestId'] === requestId,
        )?.payload['state'],
      ).toBe('cancelled');
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      await headers(supertest(replacement).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    } finally {
      saved.mockRestore();
      waiting.mockRestore();
      state.approvalSelections.clear();
    }
  }

  it('settles a monitor wake that died in its approval wait so its continuation can run', () =>
    settleMonitorWakeDeadInItsWait(false));

  it('settles a monitor wake whose saved approval continuation is durably refused', () =>
    settleMonitorWakeDeadInItsWait(true));
});

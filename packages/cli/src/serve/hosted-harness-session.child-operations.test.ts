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
  enforceInlineResourceLimit,
  headers,
  hookPin,
  listeners,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  capturedWakeSession,
  holdWakePass,
  mockBrokerBroker,
  prewriteMonitorSession,
  stillWaiting,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { ManagedSessionStoreHttpError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { monitorWakeNeedsRecovery } from './hosted-monitor-wake-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedSessionMessageSession } from './hosted-session-message-session.js';
import { HostedSessionCommandSession } from './hosted-session-command-session.js';
import { HostedTeamSession } from './hosted-team-session.js';
import { teamMemberPreamble } from './hosted-member-chain.js';
import { hostedWakeContinuationId } from './hosted-wake-continuation.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  // The journal shape a child run's acceptance leaves behind when its
  // notification input is still owed: accepted, never settled, and the
  // Session holds no prompt of its own.
  async function prewriteChildNotificationSession(): Promise<string> {
    return prewriteChildNotificationOfSource('child_agent');
  }

  // The same planted acceptance notification with a workflow source:
  // its kind never changes the journal shape, only the `source` the wake
  // and close paths predicate on (#13803 K2).
  async function prewriteWorkflowNotificationSession(): Promise<string> {
    return prewriteChildNotificationOfSource('workflow');
  }

  async function prewriteChildNotificationOfSource(
    source: 'child_agent' | 'workflow',
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
              toolProfile: 'hosted-workspace-shell/1',
              hookCatalog: hookPin,
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
    const turnId = 'run-1:accept:notify';
    try {
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: turnId,
          sessionKey: key,
          contentDigest: 'b'.repeat(64),
        },
        {
          inputId: turnId,
          turnId,
          source,
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from('{"text":"<task-notification />"}', 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
    return turnId;
  }

  // A Session that has accepted a child result: the restore verifier must
  // admit the child_acceptance domain its journal now carries.
  async function prewriteAcceptedChildSession(): Promise<string> {
    return prewriteAcceptedChildOfKind('child_agent');
  }

  // The same Session with its child result carried by a workflow record:
  // its notification input rides the workflow source through the wake and
  // close paths the monitor witness exercises for `monitor` (#13803 K2).
  async function prewriteAcceptedWorkflowChildSession(): Promise<string> {
    return prewriteAcceptedChildOfKind('workflow');
  }

  async function prewriteAcceptedChildOfKind(
    kind: 'child_agent' | 'workflow',
    interrupted = false,
  ): Promise<string> {
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
              hookCatalog: hookPin,
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
      const children = new HostedChildAgentSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      if (kind === 'child_agent') {
        await children.admit({
          childRunId: 'run-1',
          ownerScopeId: SESSION_ID,
          rootSessionId: SESSION_ID,
          completion: 'sent',
          description: 'audit the diff',
          prompt: 'review the change',
          definition: {
            definitionId: 'hosted-agent/hosted-workspace-shell/1',
            definitionRevision: 1,
            definitionDigest:
              managed.authority.sessionHeader.definitionRef.digest,
          },
          workspaceMode: 'shared',
          workingDirectory: '.',
          executionCallId: 'run-1',
        });
      } else {
        const script = 'return { answer: 1 };';
        await children.admitWorkflow({
          childRunId: 'run-1',
          ownerScopeId: SESSION_ID,
          rootSessionId: SESSION_ID,
          completion: 'sent',
          script,
          args: undefined,
          definition: {
            definitionId: 'workflow/unnamed',
            definitionRevision: 1,
            definitionDigest: createHash('sha256')
              .update(script, 'utf8')
              .digest('hex'),
          },
          workingDirectory: '.',
          executionCallId: 'run-1',
        });
      }
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach('run-1', '550e8400-e29b-41d4-a716-446655440001');
      await children.settleCompleted('run-1', {
        result: Buffer.from('审阅通过', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      });
      await children.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
      if (interrupted) {
        await managed.sink.write({
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: SESSION_ID,
          timestamp: new Date().toISOString(),
          type: 'user',
          cwd: state.root,
          version: 'hosted-harness/1',
          daemonPromptId: 'run-1:accept:notify',
          message: {
            role: 'user',
            parts: [{ text: 'original child notification' }],
          },
        });
      }
    } finally {
      await managed.close().catch(() => undefined);
    }
    return 'run-1:accept:notify';
  }

  // #13803 (K2): a workflow child's acceptance notification closes through
  // the same wake-owned drain — its source names the record's own kind. The
  // kick is parked so the close, never the live pump, owns this settle: the
  // load witness below exercises the pump; this one exercises the drain.
  it('settles a pending workflow child notification as session_closing when the Session closes', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteAcceptedWorkflowChildSession();
    mockBrokerBroker();
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
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
        event.payload['turnId'] === notificationTurnId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    expect(
      (
        await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
      ).status,
    ).toBe(404);
  });

  it('wires the wake pump with the shared recovery predicate (M3b)', async () => {
    domainEnablement.monitorRun = true;
    await prewriteMonitorSession();
    mockBrokerBroker();
    wakeDeps.last = undefined;
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(
      (wakeDeps.last as { needsRecovery?: unknown } | undefined)?.needsRecovery,
    ).toBe(monitorWakeNeedsRecovery);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it.each(['child_agent', 'workflow'] as const)(
    'continues an interrupted %s wake with no recovered call answer',
    async (kind) => {
      domainEnablement.childRun = true;
      const notificationTurnId = await prewriteAcceptedChildOfKind(kind, true);
      const continuation = hostedWakeContinuationId(notificationTurnId);
      mockBrokerBroker();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store() })
        .expect(200);
      await vi.waitFor(
        async () => {
          const session = capturedWakeSession();
          expect(
            session.managed.authority.eventsInSequenceRange(
              1,
              session.managed.authority.committedSequence,
            ),
          ).toContainEqual(
            expect.objectContaining({
              kind: 'turn.settled',
              payload: expect.objectContaining({
                turnId: continuation,
                outcome: 'completed',
              }),
            }),
          );
          expect(
            session.managed.authority
              .extensionRecordsInDomain('child_run')
              .at(-1)?.record,
          ).toMatchObject({ run: { delivery: { state: 'consumed' } } });
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledOnce();
      expect(state.model.mock.calls[0]![0]).toMatchObject({
        promptId: continuation,
        prompt: expect.stringContaining('审阅通过'),
      });
      const session = capturedWakeSession();
      const records = await session.managed.sink.project();
      expect(records.filter((entry) => entry.type === 'user')).toHaveLength(1);
      expect(
        records.filter(
          (entry) =>
            entry.subtype === 'turn_attempt' &&
            entry.daemonPromptId === continuation,
        ),
      ).toHaveLength(1);
      const events = session.managed.authority.eventsInSequenceRange(
        1,
        session.managed.authority.committedSequence,
      );
      const accepted = events.find(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['turnId'] === continuation,
      )!;
      const settled = events.find(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === notificationTurnId,
      )!;
      expect(accepted.sequence).toBeLessThan(settled.sequence);
      await vi.waitFor(
        async () => {
          expect(
            (
              await headers(
                supertest(server).post(`/session/${SESSION_ID}/detach`),
              )
                .set('X-Qwen-Client-Id', loaded.body.clientId as string)
                .send({})
            ).status,
          ).toBe(204);
        },
        { timeout: settleTimeoutMs() },
      );
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({ managedSessionStore: store() })
        .expect(200);
      expect(state.model).toHaveBeenCalledOnce();
    },
    60_000,
  );

  // R1-5: a pending child-acceptance notification is wake-pump work, not
  // a parked Turn — counted as unsettled, it would refuse every load and
  // wedge exactly the pump that was supposed to deliver it.
  it('loads a Session whose only owed input is a child acceptance notification', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteChildNotificationSession();
    mockBrokerBroker();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain('unsettled_input');
    // The load made the queued notification runnable: let its wake settle
    // before the close route executes, or DELETE races an active wake turn
    // (409 hosted_turn_active) and the fixture teardown races its journal
    // writes.
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
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    // The settled record lands while the pump's busy epoch is still
    // closing out, so the close can answer 409 for one more tick — a
    // refused close is a no-op, and the retry converges (F10's gate).
    await vi.waitFor(
      async () => {
        expect(
          (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
            .status,
        ).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  // #13803 (K2): the wake pump classifies a workflow child's acceptance
  // notification the same way — its source never wedges the load.
  it('loads a Session whose only owed input is a workflow acceptance notification', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteWorkflowNotificationSession();
    mockBrokerBroker();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain('unsettled_input');
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
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
        // The settle lands while the pump's busy epoch is still closing
        // out; the close answers 409 until the prompt is released.
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // R1-32: the reopen verifier must admit the child_acceptance domain —
  // a Session that has accepted a child result must reopen, never refuse
  // its own committed history as an unsupported domain.
  it('reopens a Session whose journal carries a child_acceptance commit', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteAcceptedChildSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
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
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'child_acceptance',
      ),
    ).toBe(true);
    // The acceptance left its notification owed: let the wake settle it
    // before the close route executes, exactly like the R1-5 lifecycle.
    await vi.waitFor(
      async () => {
        const settled = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        expect(
          settled.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
    // The settled record lands while the pump's busy epoch is still
    // closing out, so the close can answer 409 for one more tick — a
    // refused close is a no-op, and the retry converges (F10's gate).
    await vi.waitFor(
      async () => {
        expect(
          (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
            .status,
        ).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  // H4d-b: a parent with one attached child run, built through the real
  // funnels; `build` then commits the message state under test.
  async function prewriteMessageSession(
    build: (sides: {
      children: HostedChildAgentSession;
      messages: HostedSessionMessageSession;
      managed: Awaited<ReturnType<typeof openManagedSession>>;
    }) => Promise<void>,
  ): Promise<void> {
    state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
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
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: resources,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              sessionId: SESSION_ID,
              toolProfile: 'hosted-workspace-shell/1',
              hookCatalog: hookPin,
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
      const store = {
        authority: managed.authority,
        resources: managed.resources,
      };
      const children = new HostedChildAgentSession(store, key);
      await children.admit({
        childRunId: 'run-1',
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'sent',
        description: 'audit the diff',
        prompt: 'review the change',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-shell/1',
          definitionRevision: 1,
          definitionDigest:
            managed.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        workspaceMode: 'shared',
        executionCallId: 'run-1',
      });
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach('run-1', CHILD_SESSION_ID);
      await build({
        children,
        messages: new HostedSessionMessageSession(
          store,
          key,
          children,
          undefined,
        ),
        managed,
      });
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  const CHILD_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001';

  async function journalEvents() {
    return (
      await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      })
    ).events;
  }

  // H4d-b: a Session whose journal carries a child's message must reopen
  // (the restore verifier admits the domain), run the message's wake turn,
  // and commit the receipt's consumption once that turn settles.
  it('reopens a Session holding a child message and consumes it after its wake turn', async () => {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await vi.waitFor(
      async () => {
        const events = await journalEvents();
        expect(
          events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === 'msg_up:message',
          ),
        ).toBe(true);
        expect(
          events.filter(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'session_message',
          ),
        ).toHaveLength(2);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('maps the message route refusals and holds a child settlement for its message', async () => {
    await prewriteMessageSession(async ({ children }) => {
      await children.sendToChild({
        taskId: children.taskIdOf('run-1'),
        text: 'also check the tests',
        messageId: 'msg_down',
        continuationRunId: 'prompt:call-1',
        executionCallId: 'prompt:call-1',
        closing: false,
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const message = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), ...body });
    const child = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId: 'run-1', ...body });
    const invalid = await message({ messageId: 'msg_down', kind: 'teleport' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_message_operation');
    const missing = await message({
      messageId: 'msg_none',
      kind: 'handover',
      targetSessionId: CHILD_SESSION_ID,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('session_message_record');
    const pending = await child({
      kind: 'commit_result',
      result: 'done',
      receipt: '{}',
    });
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('child_messages_pending');
    await message({
      messageId: 'msg_down',
      kind: 'handover',
      targetSessionId: CHILD_SESSION_ID,
    }).expect(202);
    const wrongTarget = await message({
      messageId: 'msg_down',
      kind: 'handover',
      targetSessionId: randomUUID(),
    });
    expect(wrongTarget.status).toBe(409);
    expect(wrongTarget.body.code).toBe('session_message_conflict');
    await message({
      messageId: 'msg_down',
      kind: 'accepted',
      inputId: 'msg_down:message',
    }).expect(202);
    // The settlement must name the message it saw.
    const unseen = await child({
      kind: 'commit_result',
      result: 'done',
      receipt: '{}',
    });
    expect(unseen.status).toBe(409);
    expect(unseen.body.code).toBe('child_messages_pending');
    await child({
      kind: 'commit_result',
      result: 'done',
      receipt: '{}',
      messageCount: 1,
    }).expect(202);
    // A target store that faltered is a retry, never the target's verdict.
    const faltered = vi
      .spyOn(HostedSessionMessageSession.prototype, 'receive')
      .mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(503, 'store_unavailable', 'down'),
      );
    const content2 = Buffer.from('second question');
    const storeDown = await message({
      messageId: 'msg_late2',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content2.toString('base64'),
      contentDigest: createHash('sha256').update(content2).digest('hex'),
    });
    expect(storeDown.status).toBe(503);
    expect(storeDown.body.code).toBe('session_message_failed');
    faltered.mockRestore();
    // An append whose outcome is unknown is the same retryable store fault:
    // a 409 here would make the relay reject a message that may yet commit.
    const unsettled = vi
      .spyOn(HostedSessionMessageSession.prototype, 'receive')
      .mockRejectedValueOnce(
        new ManagedSessionAppendUnsettledError(new Error('ack lost')),
      );
    const unknownOutcome = await message({
      messageId: 'msg_late3',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content2.toString('base64'),
      contentDigest: createHash('sha256').update(content2).digest('hex'),
    });
    expect(unknownOutcome.status).toBe(503);
    expect(unknownOutcome.body.code).toBe('session_message_failed');
    unsettled.mockRestore();
    // A proven journal fence is the same store-side retryable answer: a 4xx
    // here would make the relay reject a message whose receipt is durable.
    const fenced = vi
      .spyOn(HostedSessionMessageSession.prototype, 'receive')
      .mockRejectedValueOnce(
        new ManagedSessionJournalFencedError('journal fenced'),
      );
    const fencedOutcome = await message({
      messageId: 'msg_late4',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content2.toString('base64'),
      contentDigest: createHash('sha256').update(content2).digest('hex'),
    });
    expect(fencedOutcome.status).toBe(503);
    expect(fencedOutcome.body.code).toBe('session_message_failed');
    fenced.mockRestore();
    const noReceipt = await message({ messageId: 'msg_down', kind: 'consume' });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.code).toBe('session_message_record');
    const content = Buffer.from('late question');
    const refused = await message({
      messageId: 'msg_late',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-2',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content.toString('base64'),
      contentDigest: createHash('sha256').update(content).digest('hex'),
    });
    // No such child run here: refused for good, before anything publishes.
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('session_message_record');
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // H4d-b: a parent with the attached run-1 loaded; `receive` posts one
  // child message to it through the route.
  async function loadMessageParent() {
    await prewriteMessageSession(async () => undefined);
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const receive = (messageId: string) => {
      const content = Buffer.from(`question ${messageId}`);
      return headers(
        supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          operationId: randomUUID(),
          messageId,
          kind: 'receive',
          route: 'to_parent',
          childRunId: 'run-1',
          senderSessionId: CHILD_SESSION_ID,
          contentBase64: content.toString('base64'),
          contentDigest: createHash('sha256').update(content).digest('hex'),
        })
        .then((response) => response);
    };
    return { server, receive, clientId: loaded.body.clientId as string };
  }

  // H4f × H4d-b: a stopped run's message turns stop with it — the one in
  // flight is aborted and the ones waiting behind it never run.
  it('stops the message turn in flight and the messages waiting behind it', async () => {
    const { server, receive, clientId } = await loadMessageParent();
    let signal!: AbortSignal;
    // An aborted model call rejects, as the provider's does.
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          signal.addEventListener(
            'abort',
            () => reject(new Error('The model call was aborted.')),
            { once: true },
          );
        }),
    );
    expect((await receive('msg_running')).status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
      timeout: settleTimeoutMs(),
    });
    expect((await receive('msg_waiting')).status).toBe(202);
    const stop = () =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), kind: 'stop' });
    // A message turn in flight is aborted; the waiting one never starts.
    expect((await stop()).status).toBe(202);
    expect(signal.aborted).toBe(true);
    const settledOf = async (turnId: string) =>
      (await journalEvents()).find(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
      )?.payload;
    await vi.waitFor(
      async () =>
        expect((await settledOf('msg_running:message'))?.['outcome']).toBe(
          'cancelled',
        ),
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await settledOf('msg_waiting:message')).toBeUndefined();
    // The relay's next stop, with no turn running, settles it.
    expect((await stop()).status).toBe(202);
    expect(await settledOf('msg_waiting:message')).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'stop_requested',
    });
    expect(state.model).toHaveBeenCalledTimes(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // H4f × H4d-b: the control plane can lose its attachment before a stop
  // reaches the Session. Its load carries the stop, so the first pass the
  // load kicks starts none of the waiting messages.
  it("loads a stopped run's Session without starting its waiting message", async () => {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
      stopMessages: true,
    });
    expect(loaded.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(state.model).not.toHaveBeenCalled();
    const stopped = await headers(
      supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ operationId: randomUUID(), kind: 'stop' });
    expect(stopped.status).toBe(202);
    expect(
      (await journalEvents()).find(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === 'msg_up:message',
      )?.payload,
    ).toMatchObject({ outcome: 'cancelled', stopReason: 'stop_requested' });
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // A load the resident Session refuses — its identity, its Store or its
  // tool profile — stops nothing; one it admits stops its messages from
  // then on.
  it("stops a resident Session's messages only by a load it admits", async () => {
    const { server, receive } = await loadMessageParent();
    const load = (descriptor: Record<string, unknown>) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: descriptor,
        passiveManagedRuntimeRecovery: true,
        stopMessages: true,
      });
    const wrongTenant = await load({ ...store(), tenantId: 'another' });
    expect(wrongTenant.status).toBe(409);
    const wrongStore = await load({
      ...store(),
      baseUrl: 'https://another-store.test',
    });
    expect(wrongStore.status).toBe(409);
    expect(wrongStore.body.code).toBe('hosted_session_store_mismatch');
    const wrongProfile = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      passiveManagedRuntimeRecovery: true,
      stopMessages: true,
    });
    expect(wrongProfile.status).toBe(409);
    expect(wrongProfile.body.code).toBe('hosted_tool_profile_conflict');
    expect((await receive('msg_runs')).status).toBe(202);
    await vi.waitFor(
      async () =>
        expect(
          (await journalEvents()).find(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === 'msg_runs:message',
          )?.payload['outcome'],
        ).toBe('completed'),
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    const calls = state.model.mock.calls.length;
    const admitted = await load(store());
    expect(admitted.status).toBe(200);
    expect((await receive('msg_held')).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(state.model.mock.calls.length).toBe(calls);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // A message turn that died inside its attempt in an earlier process is
  // not a waiting input: the pump no longer picks it for a stopped
  // Session, so the stop runs its aftermath and nothing stays owed.
  it('settles the crashed message turn of a stopped run', async () => {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages, managed }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: 'msg_up:message',
        message: { role: 'user', parts: [{ text: 'which branch?' }] },
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
      stopMessages: true,
    });
    expect(loaded.status).toBe(200);
    const stopped = await headers(
      supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ operationId: randomUUID(), kind: 'stop' });
    expect(stopped.status).toBe(202);
    expect(
      (await journalEvents()).some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === 'msg_up:message',
      ),
    ).toBe(true);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // A message turn that died inside its attempt in an earlier process
  // (or, with `attempted: false`, one still waiting), loaded before its run
  // stopped: the load's pump pass picks it, and is held at `holdAt`.
  async function loadCrashedMessageTurn({
    attempted = true,
    holdAt = 'transcript projection',
  }: {
    attempted?: boolean;
    holdAt?: 'input read' | 'transcript projection';
  } = {}) {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages, managed }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
      if (!attempted) return;
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: 'msg_up:message',
        message: { role: 'user', parts: [{ text: 'which branch?' }] },
      });
    });
    mockBrokerBroker();
    const pass = holdWakePass(holdAt);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(200);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    return {
      server,
      pass,
      authorize,
      stop: () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
        )
          .send({ operationId: randomUUID(), kind: 'stop' })
          .then((response) => response),
      recoveryBlocked: async () =>
        (
          await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          )
        ).body.recoveryBlocked as boolean,
      settles: async () =>
        (await journalEvents()).filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === 'msg_up:message',
        ).length,
    };
  }

  it('has a stop wait out the load pass over a crashed message turn', async () => {
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn();
    const stopping = stop();
    expect(await stillWaiting(stopping)).toBe('waiting');
    expect(await settles()).toBe(0);
    pass.open();
    expect((await stopping).status).toBe(202);
    expect(await recoveryBlocked()).toBe(false);
    expect(await settles()).toBe(1);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('leaves a crashed message turn the load pass left blocked to the pump', async () => {
    // The pass's aftermath loses its consume write once, so the pass
    // ends with the Session blocked and the input owed.
    const write = ManagedSessionRecordSink.prototype.write;
    let consumes = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumes += 1;
          if (consumes === 1)
            return Promise.reject(new Error('Store write lost to a 503'));
        }
        return write.call(this, record);
      },
    );
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn();
    const stopping = stop();
    expect(await stillWaiting(stopping)).toBe('waiting');
    pass.open();
    expect((await stopping).status).toBe(202);
    // The pass re-arms its blocked cycle, which settles the crash and
    // lifts the block; a consume by the stop would have left it blocked.
    await vi.waitFor(
      async () => {
        expect(await recoveryBlocked()).toBe(false);
        expect(await settles()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(consumes).toBe(2);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('re-arms the blocked cycle of a pass the stop stopped waiting for', async () => {
    const write = ManagedSessionRecordSink.prototype.write;
    let consumes = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumes += 1;
          if (consumes === 1)
            return Promise.reject(new Error('Store write lost to a 503'));
        }
        return write.call(this, record);
      },
    );
    // The stop's wait, cut from its production bound.
    const exclusive = HostedMonitorWakeScheduler.prototype.exclusive;
    vi.spyOn(
      HostedMonitorWakeScheduler.prototype,
      'exclusive',
    ).mockImplementation(function (this: HostedMonitorWakeScheduler, work) {
      return exclusive.call(this, work, 200);
    });
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn();
    // The wait expires before the pass has classified the crash: the stop
    // answers without settling anything.
    expect((await stop()).status).toBe(202);
    expect(await settles()).toBe(0);
    expect(consumes).toBe(0);
    pass.open();
    // The pass blocks and loses its consume. Its settle-verify read no
    // longer sees the stopped message input, and it re-arms all the same,
    // so its blocked cycle settles the crash and lifts the block.
    await vi.waitFor(
      async () => {
        expect(await recoveryBlocked()).toBe(false);
        expect(await settles()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(consumes).toBe(2);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a stop that waited leave a crashed message turn to a later stop when a prompt was admitted meanwhile', async () => {
    let modelEntered = false;
    let openModel!: () => void;
    const modelHeld = new Promise<void>((resolve) => {
      openModel = resolve;
    });
    state.model.mockImplementationOnce(async () => {
      modelEntered = true;
      await modelHeld;
      return { text: 'hello back', model: 'test-model' };
    });
    const { server, pass, authorize, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn({ holdAt: 'input read' });
    const stopping = stop();
    expect(await stillWaiting(stopping)).toBe('waiting');
    const prompt = [{ type: 'text', text: 'hello' }];
    const prompted = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(prompted.status).toBe(202);
    await vi.waitFor(() => expect(modelEntered).toBe(true), {
      timeout: 15_000,
    });
    pass.open();
    // The re-check after the wait finds the prompt: no aftermath runs
    // under it.
    expect((await stopping).status).toBe(202);
    expect(await settles()).toBe(0);
    openModel();
    // The relay's next stop, on an idle Session, settles the crash.
    await vi.waitFor(
      async () => {
        expect((await stop()).status).toBe(202);
        expect(await settles()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(await recoveryBlocked()).toBe(false);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a stop with no crashed message turn owed answer without waiting for the pass', async () => {
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn({ attempted: false, holdAt: 'input read' });
    // The waiting message settles cancelled at once, and nothing is left
    // that the pass could be settling. A stop that waited would hold until
    // the pass is let go, so the window can be wide.
    const stopping = stop();
    expect(
      await Promise.race([
        stopping.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 5_000)),
      ]),
    ).toBe('answered');
    expect((await stopping).status).toBe(202);
    expect(await settles()).toBe(1);
    pass.open();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await recoveryBlocked()).toBe(false);
    expect(await settles()).toBe(1);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('refuses a message once the Session close began', async () => {
    const { server, receive } = await loadMessageParent();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = LocalJsonlManagedSessionJournalHandle.prototype.seal;
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'seal',
    ).mockImplementation(async function (
      this: LocalJsonlManagedSessionJournalHandle,
      commit,
    ) {
      entered();
      await gate;
      await original.call(this, commit);
    });
    const closing = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    await started;
    try {
      // The close already cancelled the pending inputs: a receipt now
      // would wait for a turn nothing runs.
      const refused = await receive('msg_after_close');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_session_closing');
    } finally {
      release();
    }
    expect((await closing).status).toBe(204);
    expect(
      (await journalEvents()).some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['inputId'] === 'msg_after_close:message',
      ),
    ).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
  });

  it('lets a message admitted before the close land before its pending inputs are cancelled', async () => {
    const { server, receive } = await loadMessageParent();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = HostedSessionMessageSession.prototype.receive;
    vi.spyOn(
      HostedSessionMessageSession.prototype,
      'receive',
    ).mockImplementation(async function (
      this: HostedSessionMessageSession,
      ...args: Parameters<HostedSessionMessageSession['receive']>
    ) {
      entered();
      await gate;
      return original.apply(this, args);
    });
    const receiving = receive('msg_in_flight');
    await started;
    let closed = false;
    const closing = headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .then((response) => response)
      .finally(() => {
        closed = true;
      });
    // The close waits for the receipt that passed its check.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    release();
    const received = await receiving;
    expect(received.status).toBe(202);
    expect(received.body.inputId).toBe('msg_in_flight:message');
    expect((await closing).status).toBe(204);
    // Its input is cancelled with the other pending inputs, never left
    // waiting for a turn after the Session closed.
    const events = await journalEvents();
    expect(
      events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['inputId'] === 'msg_in_flight:message',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === 'msg_in_flight:message',
      ),
    ).toBe(true);
    expect(state.model).not.toHaveBeenCalled();
  });

  // H4e-b1: the reopen verifier admits the lead's team roster and board, so
  // a Session that led a team reopens with its own committed history.
  it('reopens a Session whose journal carries its team, board and plan with the plan gate off', async () => {
    domainEnablement.childRun = true;
    domainEnablement.teamPlan = true;
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
        const store = {
          authority: managed.authority,
          resources: managed.resources,
        };
        const children = new HostedChildAgentSession(store, key);
        const teams = new HostedTeamSession(store, key, children);
        await teams.run('team_create', { team_name: 'review' }, 'p:team');
        const member = teams.admitMember('alice');
        await children.admit({
          childRunId: 'run-1',
          ownerScopeId: SESSION_ID,
          rootSessionId: SESSION_ID,
          completion: 'sent',
          description: 'audit the diff',
          prompt: 'review the change',
          definition: {
            definitionId: 'hosted-agent/hosted-workspace-shell/1',
            definitionRevision: 1,
            definitionDigest:
              managed.authority.sessionHeader.definitionRef.digest,
          },
          workspaceMode: 'shared',
          workingDirectory: '.',
          executionCallId: 'run-1',
        });
        await teams.join({
          ...member,
          childRunId: 'run-1',
          planModeRequired: true,
        });
        await children.dispatchStarted('run-1', {
          dispatchId: 'plan-dispatch',
          runtime: { runtimeBindingId: 'plan-binding', generation: '1' },
        });
        await children.attach('run-1', CHILD_SESSION_ID);
        await teams.submitPlan('cmd_reopen_plan', 'run-1', 'Read then edit');
        domainEnablement.teamPlan = false;
        await children.settleFailed('run-1', {
          stopReason: 'child_failed',
          reason: null,
          started: true,
        });
        await teams.run(
          'task_create',
          { subject: 'audit', description: 'audit the diff' },
          'p:task',
        );
      } finally {
        await managed.close().catch(() => undefined);
      }
      mockBrokerBroker();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
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
        journal.events
          .filter((event) => event.kind === 'domain.committed')
          .map((event) => event.payload['domain']),
      ).toEqual(
        expect.arrayContaining([
          'team_state',
          'team_task',
          'team_plan',
          'child_run',
        ]),
      );
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    } finally {
      domainEnablement.childRun = true;
      domainEnablement.teamPlan = false;
    }
  });

  // An array-valued `lineage` must not be silently accepted as a root
  // Session — every non-plain-object lineage is a 400 with the same code
  // the malformed object shapes already get, and only absent or `null`
  // lineage means "root".
  it('refuses an array-valued lineage on session create', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
      lineage: [],
    });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('invalid_hosted_lineage');
    const scrambled = await headers(supertest(server).post('/session')).send({
      sessionId: randomUUID(),
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
      lineage: 'x',
    });
    expect(scrambled.status).toBe(400);
    expect(scrambled.body.code).toBe('invalid_hosted_lineage');
    const absent = await headers(supertest(server).post('/session')).send({
      sessionId: randomUUID(),
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
    });
    expect(absent.status).toBe(200);
  });

  // The record truth forbids an unproven start: intent-only runs
  // receive `409 child_operation_conflict` both for attach and for
  // fail-started=true. The relay reconciles from the record instead of
  // blaming the wire code, but the wire must refuse those calls anyway.
  it('refuses an attach or start-fail over a run that never dispatched', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
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
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
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
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    // The intent state has no legal successor for attach or for fail-truth.
    const attachRefused = await operation({
      kind: 'attach',
      childSessionId: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(attachRefused.status).toBe(409);
    expect(attachRefused.body.code).toBe('child_operation_record');
    const failRefused = await operation({
      kind: 'fail',
      stopReason: 'child_failed',
      started: true,
    });
    expect(failRefused.status).toBe(409);
    expect(failRefused.body.code).toBe('child_operation_record');
    // And the lawful path the honest chain takes: dispatch then attach.
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    await operation({
      kind: 'attach',
      childSessionId: '550e8400-e29b-41d4-a716-446655440001',
    }).expect(202);
    await posted;
  }, 60_000);

  // The never-started verdict names its minted Session on the wire:
  // `fail` with `creation_failed` accepts a `childSessionId` and a
  // replay restating it settles, but renaming it answers the relay's
  // readable refusal — 409 child_operation_record — and a malformed id
  // never reaches the record machine at all.
  it('commits a never-started verdict naming its minted Session', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    const childSessionId = '550e8400-e29b-41d4-a716-446655440099';
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
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
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
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
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const malformed = await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId: 42,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('invalid_child_operation');
    await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId,
    }).expect(202);
    // A replay restating the same Session is the same revision.
    await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId,
    }).expect(202);
    const renamed = await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId: '550e8400-e29b-41d4-a716-446655440098',
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('child_operation_record');
    await posted;
  }, 60_000);

  // #14387: the relay's recovery-blocked settlement for a child whose
  // Harness generation was lost — dispatched, never continued. The op
  // admits only the lost-Runtime reason, and a replay restating the same
  // verdict is the same revision.
  it('commits a recovery-blocked verdict over a lost generation', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    const childSessionId = '550e8400-e29b-41d4-a716-446655440099';
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
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
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
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
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    // Only the lost-Runtime reason is admitted; anything else is a 400.
    const badReason = await operation({
      kind: 'recovery_blocked',
      reason: 'child_failed',
      childSessionId,
    });
    expect(badReason.status).toBe(400);
    expect(badReason.body.code).toBe('invalid_child_operation');
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
      childSessionId,
    }).expect(202);
    // A replay restating the same verdict is the same revision.
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
      childSessionId,
    }).expect(202);
    await posted;
  }, 60_000);

  // #14387: the blocked settlement of a background child commits a
  // notification an already-idle parent only receives when the route kicks
  // its wake scheduler — the scheduler parks on an empty next() and never
  // rescans on its own. The kick fires on a replay too.
  it('kicks the wake scheduler of an idle parent on a recovery-blocked settlement', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const kick = vi
      .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
      .mockImplementation(() => {});
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
        name: 'agent',
        callId: 'call-1',
        args: {
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: true,
        },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
    // The background launch settles the parent's turn — the Session is
    // idle when the relay's verdict lands.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
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
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    await posted;
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    kick.mockClear();
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
    }).expect(202);
    expect(kick).toHaveBeenCalledTimes(1);
    // The settlement's idempotent skip does not extend to the delivery: a
    // replay restating the verdict kicks again.
    kick.mockClear();
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
    }).expect(202);
    expect(kick).toHaveBeenCalledTimes(1);
  }, 60_000);

  // Any early refusal of a claimed request — validation, profile, blocked —
  // still restores the stamped authority. A pre-try return leaking it
  // would attach the claim's lifecycle headers onto this shared client's
  // every later write, and a refusal like that restores nothing at all.
  it('never leaks the claimed stamp through an early refusal', async () => {
    domainEnablement.childRun = true;
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    state.authorizeOrdinary.mockRejectedValue(
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_lifecycle_active',
        'DRAINING',
      ),
    );
    // The validation arm: the childRunId the route rejects with 400
    // invalid_child_operation *after* the claim was stamped.
    state.setLifecycleAuthority.mockClear();
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/children/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        operationId: 'not-a-uuid',
        childRunId: 'prompt:call-1',
        kind: 'cancel',
        authority: {
          operationId: 'close-1',
          claimGeneration: 7,
          kind: 'close',
        },
      });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('invalid_child_operation');
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);

    // The profile arm: a Session with no child Agents at all answers
    // hosted_children_unavailable on the same seam — same restore.
    state.authorizeOrdinary.mockRejectedValue(
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_lifecycle_active',
        'DRAINING',
      ),
    );
    const files = await headers(supertest(server).post('/session')).send({
      sessionId: randomUUID(),
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(files.status).toBe(200);
    state.setLifecycleAuthority.mockClear();
    const filesRefused = await headers(
      supertest(server).post(
        `/session/${files.body.sessionId}/children/operations`,
      ),
    )
      .set('X-Qwen-Client-Id', files.body.clientId as string)
      .send({
        operationId: randomUUID(),
        childRunId: 'prompt:call-1',
        kind: 'cancel',
        authority: {
          operationId: 'close-1',
          claimGeneration: 7,
          kind: 'close',
        },
      });
    expect(filesRefused.status).toBe(409);
    expect(filesRefused.body.code).toBe('hosted_children_unavailable');
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
  });

  // P1 (lifecycle fence): with ordinary authorization closed by the
  // closing parent's fence, its own child cleanup must present the
  // matching lifecycle claim to pass — and nothing else may.
  it.each([
    'managed_session_lifecycle_active',
    'workspace_lifecycle_claim_fenced',
  ])(
    'admits claimed child operations while the %s fence holds',
    async (fenceCode) => {
      domainEnablement.childRun = true;
      mockBrokerBroker();
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      const childRunId = `${PROMPT_ID}:call-1`;
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const callRequest = {
          name: 'agent',
          callId: 'call-1',
          args: { description: 'audit the diff', prompt: 'review the change' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
          [callRequest],
          [
            {
              functionCall: {
                id: callRequest.callId,
                name: callRequest.name,
                args: callRequest.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        return { text: 'started', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'launch in the background' }];
      const posted = (async () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          }))();
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
                event.kind === 'domain.committed' &&
                event.payload['domain'] === 'child_run',
            ),
          ).toBe(true);
        },
        { timeout: 15_000, interval: 100 },
      );
      await posted;
      // Let the launch turn settle fully: the fence must close only after
      // its answers exist, not against mid-flight writes.
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 15_000, interval: 100 },
      );
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(409, fenceCode, 'DRAINING'),
      );
      const operation = (body: Record<string, unknown>) =>
        headers(
          supertest(server).post(`/session/${SESSION_ID}/children/operations`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ operationId: randomUUID(), childRunId, ...body });
      // No claim presented: the ordinary fence keeps refusing.
      const active = await operation({ kind: 'cancel' });
      expect(active.status).toBe(409);
      expect(active.body.code).toBe('hosted_lifecycle_operation_active');
      expect(state.authorizeLifecycle).not.toHaveBeenCalled();
      // The matching lifecycle claim: authorized through its own gate,
      // carrying the lifecycle kind the fence phase requires (the
      // pre-effects evaluation never asks for DRAINING). And at the
      // moment the child operation's verb commits, the store client still
      // carries the claim — the stamp is only restored at the route's
      // own boundary, never before the write.
      const originalRequestStop = HostedChildAgentSession.prototype.requestStop;
      let stampedDuringVerb: unknown;
      vi.spyOn(
        HostedChildAgentSession.prototype,
        'requestStop',
      ).mockImplementation(function (
        this: HostedChildAgentSession,
        runId: string,
      ) {
        stampedDuringVerb = state.setLifecycleAuthority.mock.calls.at(-1)?.[0];
        return originalRequestStop.call(this, runId);
      });
      const first = await operation({
        kind: 'cancel',
        authority: {
          operationId: 'close-1',
          claimGeneration: 7,
          kind: 'close',
        },
      });
      expect(first.status).toBe(202);
      expect(stampedDuringVerb).toEqual({
        operationId: 'close-1',
        claimGeneration: 7,
      });
      expect(state.authorizeLifecycle).toHaveBeenCalledTimes(1);
      expect(state.authorizeLifecycle).toHaveBeenLastCalledWith('close');
      // A claim the gate itself refuses: conflict, never a silent pass —
      // and the shared client authority is restored, so a fresh valid
      // claim can still be evaluated on the next request.
      state.authorizeLifecycle.mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_claim',
          'stale',
        ),
      );
      const conflict = await operation({
        kind: 'cancel',
        authority: {
          operationId: 'close-1',
          claimGeneration: 7,
          kind: 'close',
        },
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('hosted_lifecycle_operation_conflict');
      expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
      // The very next valid claim evaluates independently of that refusal:
      // it is passed its own lifecycle kind and gets its own gate answer.
      await operation({
        kind: 'cancel',
        authority: {
          operationId: 'close-2',
          claimGeneration: 8,
          kind: 'delete',
        },
      }).expect(202);
      expect(state.authorizeLifecycle).toHaveBeenCalledTimes(3);
      expect(state.authorizeLifecycle).toHaveBeenLastCalledWith('delete');
      log.mockRestore();
      state.authorizeOrdinary.mockReset();
      state.authorizeOrdinary.mockResolvedValue(undefined);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    },
    60_000,
  );

  it.each([
    'member',
    'child',
    'assistant-member',
    'assistant-child',
    'hook',
    'member-bob',
    'member-broadcast',
  ] as const)(
    'preserves the real model/record boundary for send_message: %s (#14062)',
    async (mode) => {
      await enforceInlineResourceLimit();
      const errors = vi.spyOn(stdio, 'writeStderrLineSafe');
      const member = mode !== 'child' && mode !== 'assistant-child';
      const assistantOverflow = mode.startsWith('assistant-');
      const commandLane = mode === 'member-bob' || mode === 'member-broadcast';
      const to =
        mode === 'member-bob'
          ? 'bob'
          : mode === 'member-broadcast'
            ? '*'
            : 'parent';
      const runCommand = HostedSessionCommandSession.prototype.runCommand;
      const commandCalls = vi
        .spyOn(HostedSessionCommandSession.prototype, 'runCommand')
        .mockImplementation(async function (
          this: HostedSessionCommandSession,
          params,
        ) {
          await runCommand.call(this, params);
          await this.handover(params.commandId, BOOT_ID);
          await this.answered(params.commandId, {
            outcome: 'answered',
            text: 'Scripted leader accepted the short message.',
          });
        });
      const dense = JSON.stringify(Array.from({ length: 6500 }, () => 'aa'));
      const message = assistantOverflow ? 'x'.repeat(65_400) : dense;
      const requests: Array<{
        messages: Array<{
          role: string;
          content?: unknown;
          tool_call_id?: string;
        }>;
      }> = [];
      const modelServer = createServer(async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const round = requests.length;
        const delta =
          round <= 2
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: round === 1 ? 'call-dense' : 'call-retry',
                    type: 'function',
                    function: {
                      name: 'send_message',
                      arguments: JSON.stringify({
                        to,
                        message:
                          round === 2
                            ? 'shorter'
                            : mode === 'hook'
                              ? 'original'
                              : message,
                      }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'RECOVERED_14062' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'issue-14062',
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'issue-14062',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: round <= 2 ? 'tool_calls' : 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
      listeners.add(modelServer);
      await new Promise<void>((resolve) =>
        modelServer.listen(0, '127.0.0.1', resolve),
      );
      const address = modelServer.address();
      if (!address || typeof address === 'string')
        throw new Error('No model address');
      const configDir = path.join(state.root, 'config');
      await mkdir(configDir);
      await writeFile(
        path.join(configDir, 'settings.json'),
        JSON.stringify({
          security: { auth: { selectedType: 'openai' } },
          model: { name: 'issue-14062' },
          telemetry: { enabled: false },
          modelProviders: {
            openai: [
              {
                id: 'issue-14062',
                envKey: 'OPENAI_API_KEY',
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                generationConfig: { contextWindowSize: 131_072 },
              },
            ],
          },
        }),
      );
      vi.stubEnv('QWEN_HOME', configDir);
      vi.stubEnv('QWEN_RUNTIME_DIR', path.join(state.root, 'model-runtime'));
      vi.stubEnv('OPENAI_API_KEY', 'test-key');
      vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`);
      vi.stubEnv('OPENAI_MODEL', 'issue-14062');
      vi.stubEnv('QWEN_MODEL', 'issue-14062');
      try {
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
        vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
          async function (this: HostedWorkspaceBroker) {
            this.runtime = {
              bindingId: 'binding',
              generation: '1',
              workspaceGeneration: '1',
            };
          },
        );
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'activeHoldRuntimeSessionIds',
        ).mockResolvedValue([]);
        const hookOutput = {
          hookSpecificOutput: {
            hookEventName: HookEventName.PreToolUse,
            updatedInput: { to: 'parent', message: dense },
          },
        };
        const hookResult = {
          success: true,
          outcome: 'success' as const,
          duration: 0,
          output: hookOutput,
        };
        expect(Buffer.byteLength(JSON.stringify(hookResult))).toBeLessThan(
          60 * 1024,
        );
        expect(
          Buffer.byteLength(JSON.stringify({ output: hookOutput })),
        ).toBeLessThan(60 * 1024);
        let rewrites = 0;
        if (mode === 'hook') {
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'authorizeLifecycle',
          ).mockResolvedValue();
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'hookControl',
          ).mockImplementation(async (operation) => {
            if (operation.kind === 'hook-catalog')
              return {
                operationId: operation.operationId,
                state: 'settled',
                catalog: {
                  ...operation.pin,
                  hooks: [
                    {
                      hookId: 'rewrite',
                      eventName: HookEventName.PreToolUse,
                      sequential: false,
                      async: false,
                      failClosed: true,
                      onceKey: null,
                      config: { type: 'command' },
                    },
                  ],
                },
              };
            return {
              operationId: operation.operationId,
              state: 'settled',
              result:
                operation.kind === 'hook-execute' && rewrites++ === 0
                  ? hookResult
                  : { success: true, outcome: 'success', duration: 0 },
            };
          });
        }
        const actual = await vi.importActual<
          typeof import('./hosted-harness-model.js')
        >('./hosted-harness-model.js');
        state.model.mockImplementationOnce(async (input) =>
          actual.runHostedHarnessTextTurn({
            ...input,
            resumeFromToolResults: undefined,
            sessionId: SESSION_ID,
            cwd: state.root,
            history: [],
            prompt: 'Send the message, shorten after refusal.',
            promptId: PROMPT_ID,
          }),
        );
        const server = await app(true);
        const created = await headers(supertest(server).post('/session'))
          .send({
            sessionId: SESSION_ID,
            sessionScope: 'thread',
            managedSessionStore: store(),
            toolProfile: 'hosted-workspace-shell/1',
            approvalMode: 'yolo',
            lineage: {
              parentSessionId: BOOT_ID,
              rootSessionId: BOOT_ID,
              parentChildRunId: 'run-leaf',
              depth: 1,
            },
            ...(mode === 'hook' ? { hookCatalog: hookPin } : {}),
          })
          .expect(200);
        const authorize = (request: supertest.Test) =>
          headers(request).set(
            'X-Qwen-Client-Id',
            created.body.clientId as string,
          );
        const prompt = [
          {
            type: 'text',
            text:
              (member
                ? teamMemberPreamble({ name: 'alice', teamName: 'review' })
                : '') + 'Send the message.',
          },
        ];
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(false);
          },
          { timeout: 30_000 },
        );
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        const settlement = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        );
        expect(settlement).toHaveLength(1);
        expect(settlement[0].payload['outcome']).toBe(
          assistantOverflow ? 'error' : 'completed',
        );
        const deliveries = journal.events.filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'session_message',
        );
        expect(deliveries).toHaveLength(
          assistantOverflow || commandLane ? 0 : 1,
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'session_command',
          ),
        ).toBe(commandLane);
        const commands =
          (
            commandCalls.mock.contexts[0] as
              | HostedSessionCommandSession
              | undefined
          )?.commands() ?? [];
        if (commandLane) {
          expect(commandCalls).toHaveBeenCalledOnce();
          expect(commandCalls.mock.calls[0][0]).toMatchObject({
            kind: 'member_message',
            args: { to, message: 'shorter' },
          });
          expect(commands).toHaveLength(1);
          expect(commands[0].run.delivery?.state).toBe('consumed');
        } else {
          expect(commandCalls).not.toHaveBeenCalled();
        }
        expect(requests).toHaveLength(assistantOverflow ? 1 : 3);
        if (assistantOverflow)
          expect(errors).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted assistant record exceeds the inline Session Store limit.',
            ),
          );
        if (!assistantOverflow) {
          expect(requests[1].messages).toContainEqual(
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'call-dense',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'text',
                  text: expect.stringContaining(
                    commandLane
                      ? 'once encoded (byte_limit) although it fits the 32768-byte member wrapper; shorten escape-dense content and retry.'
                      : 'once encoded (byte_limit); shorten the message or other arguments and retry.',
                  ),
                }),
              ]),
            }),
          );
          expect(requests[2].messages).toContainEqual(
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'call-retry',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'text',
                  text: expect.stringContaining(
                    commandLane
                      ? 'Scripted leader accepted'
                      : 'queued for delivery',
                  ),
                }),
              ]),
            }),
          );
        }
        const transcript = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        );
        expect(JSON.stringify(transcript.body)).toContain(
          assistantOverflow ? 'hosted_turn_failed' : 'RECOVERED_14062',
        );
        if (mode === 'member') {
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          ).expect(204);
          const loaded = await headers(
            supertest(server).post(`/session/${SESSION_ID}/load`),
          )
            .send({ managedSessionStore: store() })
            .expect(200);
          const reloaded = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(JSON.stringify(reloaded.body)).toContain(
            'once encoded (byte_limit)',
          );
          expect(JSON.stringify(reloaded.body)).toContain('RECOVERED_14062');
          expect(requests).toHaveLength(3);
          await headers(supertest(server).delete(`/session/${SESSION_ID}`))
            .set('X-Qwen-Client-Id', loaded.body.clientId as string)
            .expect(204);
        } else {
          await authorize(
            supertest(server).delete(`/session/${SESSION_ID}`),
          ).expect(204);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
    60_000,
  );
});

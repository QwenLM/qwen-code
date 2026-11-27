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
  hookPin,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import {
  capturedWakeSession,
  mockBrokerBroker,
  prewriteMonitorSession,
  recoveryFileSession,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { ManagedSessionStoreHttpError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { submitPrEventInput } from './hosted-pr-watch-session.js';
import { PR_EVENT_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-pr-watch-operations.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { readHostedClassifierUserText } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it.each([
    new TypeError('network timeout'),
    new ManagedSessionStoreHttpError(
      409,
      'managed_session_writer_conflict',
      'Writer fenced',
    ),
  ])(
    'keeps the Monitor wake scheduler after refused detach: %s',
    async (cause) => {
      mockBrokerBroker();
      const closeWake = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'close');
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
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          created.body.clientId as string,
        );
      state.authorizeOrdinary.mockRejectedValueOnce(cause);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(503);
      expect(closeWake).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
      await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).expect(200);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
      expect(closeWake).toHaveBeenCalledOnce();
      await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).expect(404);
    },
  );

  it('settles a pending Monitor notification as session_closing when the Session closes', async () => {
    domainEnablement.monitorRun = true;
    const notificationTurnId = await prewriteMonitorSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBe(true);
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

  it('settles a pending loop wakeup as session_closing when the Session closes', async () => {
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
    const loopTurnId = 'loop:wakeup-close-1';
    try {
      // A not-yet-due wakeup: the pump defers it, so only the close may
      // settle it. Without the loop source in the close lists it would
      // survive the DELETE and fire after reload.
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: loopTurnId,
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: loopTurnId,
          turnId: loopTurnId,
          source: 'loop',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from(JSON.stringify({ text: '/loop tick' }), 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
          notBefore: Date.now() + 3_600_000,
        },
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
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === loopTurnId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
  });

  it('settles a pending loop wakeup in the v2 lifecycle non-effects close', async () => {
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
    const loopTurnId = 'loop:wakeup-v2-close-1';
    try {
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: loopTurnId,
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: loopTurnId,
          turnId: loopTurnId,
          source: 'loop',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from(JSON.stringify({ text: '/loop tick' }), 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
          notBefore: Date.now() + 3_600_000,
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
    mockBrokerBroker();
    const server = await app(true);
    const authority = { operationId: 'v2-close-loop', claimGeneration: 1 };
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      lifecycleProtocolVersion: 2,
      lifecycleAuthority: authority,
    });
    expect(loaded.status).toBe(200);
    const cleanup = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The non-effects close phase must settle the parked loop wakeup; without
    // LOOP_INPUT_SOURCE in that phase's source list it survives the close.
    await cleanup(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile: 'hosted-workspace-shell/1',
        sessionKey: key,
        authority,
      })
      .expect(200);
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === loopTurnId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    await cleanup(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority })
      .expect(204);
  });

  it('settles a pending pr_event input as session_closing when the Session closes', async () => {
    // R2-2: a not-yet-due pr_event input the pump deferred. Without
    // PR_EVENT_INPUT_SOURCE in DELETE's settle source list it survives the
    // close and fires after reload, pinning Workspace close/delete.
    const inputId = `prw-${'e'.repeat(64)}:input`;
    await prewritePrEventInput(inputId, Date.now() + 3_600_000);
    mockBrokerBroker();
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
        event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    // Settled model-free: the close spoke for an input that never ran.
    expect(state.model).not.toHaveBeenCalled();
  });

  it('settles a pending pr_event input in the v2 lifecycle non-effects close', async () => {
    // R2-2, second arm: the settle_resources phase carries its own source
    // list. Without PR_EVENT_INPUT_SOURCE there the input survives the
    // non-effects close exactly as it would survive DELETE.
    const inputId = `prw-${'f'.repeat(64)}:input`;
    await prewritePrEventInput(inputId, Date.now() + 3_600_000);
    mockBrokerBroker();
    const server = await app(true);
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const authority = { operationId: 'v2-close-pr-event', claimGeneration: 1 };
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      lifecycleProtocolVersion: 2,
      lifecycleAuthority: authority,
    });
    expect(loaded.status).toBe(200);
    const cleanup = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await cleanup(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        protocolVersion: 2,
        phase: 'settle_resources',
        kind: 'close',
        toolProfile: 'hosted-workspace-shell/1',
        sessionKey: key,
        authority,
      })
      .expect(200);
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    expect(state.model).not.toHaveBeenCalled();
    await cleanup(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority })
      .expect(204);
  });

  it('admits a shell/3 Session with public children and approval selection', async () => {
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/3',
        approvalMode: 'default',
        publicChildAgentsVersion: 1,
      })
      .expect(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    // A load with the same public-child profile must reattach, not refuse the
    // profile the control plane admitted.
    const attached = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/3',
        publicChildAgentsVersion: 1,
        passiveManagedRuntimeRecovery: true,
      })
      .expect(200);
    expect(attached.body.clientId).toBe(created.body.clientId);
    // A prompt carrying approval selection is admitted on shell/3.
    const prompt = [{ type: 'text', text: 'plan this' }];
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        approvalSelection: { mode: 'yolo', revision: 1 },
      })
      .expect(202);
  });

  it('a shell/4 prompt turn creates its cron schedule through the wired store channel', async () => {
    mockBrokerBroker();
    state.model.mockReset();
    state.model.mockImplementation(async (input) => {
      // The production construction of HostedCronSession is the load path's
      // `session.crons` assignment; deleting it turns this drive into the
      // "Cron schedules are unavailable" refusal with an empty recorder.
      input.setLoopClassifier?.(async () => ({
        allowed: true,
        reason: null,
      }));
      const call = {
        name: 'cron_create',
        callId: 'call-cron-wired',
        args: {
          cron: '*/5 * * * *',
          prompt: '/loop watch CI',
          recurring: true,
        },
        isClientInitiated: false,
        prompt_id: input.promptId ?? '',
      };
      const responses = await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'stub-model',
        input.signal,
      );
      expect(responses[0].functionResponse?.response?.['executionStatus']).toBe(
        'success',
      );
      return { text: 'scheduled', model: 'stub-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/4',
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'schedule the watch' }];
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
        expect(state.automationCreates).toHaveLength(1);
      },
      { timeout: settleTimeoutMs() },
    );
    const created0 = state.automationCreates[0]!;
    expect(created0.definition['cron']).toBe('*/5 * * * *');
    expect(created0.definition['prompt']).toBe('/loop watch CI');
    expect(created0.definition['session_mode']).toBe('persistent');
    expect(created0.idempotencyKey).toMatch(/^loop:[0-9a-f]{64}:create$/u);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('cron_create without an active classifier is refused, not admitted unreviewed', async () => {
    mockBrokerBroker();
    state.model.mockReset();
    let seen: Record<string, unknown> | undefined;
    state.model.mockImplementation(async (input) => {
      // No setLoopClassifier: the arm-time review has no active classifier.
      const call = {
        name: 'cron_create',
        callId: 'call-cron-unclassified',
        args: {
          cron: '*/5 * * * *',
          prompt: '/loop watch CI',
          recurring: true,
        },
        isClientInitiated: false,
        prompt_id: input.promptId ?? '',
      };
      const responses = await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'stub-model',
        input.signal,
      );
      seen = responses[0].functionResponse?.response as Record<string, unknown>;
      return { text: 'refused', model: 'stub-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/4',
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'schedule the watch' }];
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
        expect(seen).toBeDefined();
      },
      { timeout: settleTimeoutMs() },
    );
    expect(seen!['error']).toContain(
      'No active permission classifier for cron arming.',
    );
    expect(state.automationCreates).toHaveLength(0);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('delivers a due loop wakeup through the wake pump as an ordinary turn', async () => {
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
    const loopTurnId = 'loop:wakeup-deliver-1';
    try {
      // A due wakeup: the pump must admit the loop source and pick it, not
      // park it. Deleting the loop admission or the notBefore pick strands it.
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: loopTurnId,
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: loopTurnId,
          turnId: loopTurnId,
          source: 'loop',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from(JSON.stringify({ text: '/loop tick' }), 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
          notBefore: Date.now() - 1_000,
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
    mockBrokerBroker();
    state.model.mockReset();
    state.model.mockResolvedValue({ text: 'stub reply', model: 'stub-model' });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        });
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === loopTurnId,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload['outcome']).toBe('completed');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(state.model).toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('delivers a committed pr_event input through the wake pump as an ordinary turn', async () => {
    // R2-9a: pr_event rides the wake pump. Deleting it from
    // isWakeInputSource makes the pump's next() skip the input, so no turn
    // ever runs and the wait below times out. The real funnel's envelope
    // must also read back as the turn's text.
    const inputId = `prw-${'d'.repeat(64)}:input`;
    await prewritePrEventInput(inputId);
    mockBrokerBroker();
    state.model.mockReset();
    state.model.mockResolvedValue({ text: 'stub reply', model: 'stub-model' });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
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
        const accepted = journal.events.filter(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['inputId'] === inputId,
        );
        expect(accepted).toHaveLength(1);
        expect(accepted[0]!.payload['source']).toBe(PR_EVENT_INPUT_SOURCE);
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload['outcome']).toBe('completed');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(state.model).toHaveBeenCalled();
    // The pump reads the pinned envelope's `text`, not its raw bytes: the
    // prompt must BE the wrapped text. The fragments are asserted from the
    // edges because the raw JSON also carries them, escaped — only a
    // startsWith/endsWith pair tells the prompt from the envelope bytes, and
    // an empty read fails both.
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      promptId?: string;
      prompt?: string;
    };
    expect(modelInput.promptId).toBe(inputId);
    expect(
      modelInput.prompt?.startsWith(
        '<pr-watch-event>\n<pr>Owner/Repo#7</pr>\n<transition>ci_failure</transition>\n',
      ),
    ).toBe(true);
    expect(
      modelInput.prompt?.endsWith(
        '</pr-watch-event>\nInspect the pull request.',
      ),
    ).toBe(true);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('defers a future loop wakeup and delivers it once due', async () => {
    const loopTurnId = 'loop:wakeup-compaction';
    await prewriteLoopWakeupInput(Date.now() + 600);
    mockBrokerBroker();
    state.model.mockReset();
    state.model.mockResolvedValue({ text: 'stub reply', model: 'stub-model' });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const readSettled = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      return journal.events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === loopTurnId,
      );
    };
    // Not yet due: the pump must park it on the deferral timer, not fire it
    // early. Removing the next()->deferUntil wiring strands it and the wait
    // below times out.
    expect(await readSettled()).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        const settled = await readSettled();
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload['outcome']).toBe('completed');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(state.model).toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('a delivered loop tick arms its successor through the wired funnel', async () => {
    const gateKey = 'QWEN_MANAGED_AGENT_LOOP_ENABLED';
    const gateBefore = process.env[gateKey];
    process.env[gateKey] = 'true';
    try {
      await prewriteLoopWakeupInput(
        Date.now() - 1_000,
        'hosted-workspace-shell/3',
      );
      // shell/3 reads the live approval selection (like shell/1); the staged
      // legacy-yolo Session must carry a matching selection row or the wake
      // turn's live read fails closed before it can arm the successor.
      state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
      mockBrokerBroker();
      state.model.mockReset();
      state.model.mockImplementation(async (input) => {
        // The delivered tick publishes its classifier and arms the next tick
        // through the tool turn the wake driver wired.
        input.setLoopClassifier?.(async () => ({
          allowed: true,
          reason: null,
        }));
        const call = {
          name: 'loop_wakeup',
          callId: 'call-successor-arm',
          args: { delaySeconds: 60, prompt: '/loop next tick' },
          isClientInitiated: false,
          prompt_id: input.promptId ?? '',
        };
        await input.toolTurn!.execute(
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
          'stub-model',
          input.signal,
        );
        return { text: 'armed successor', model: 'stub-model' };
      });
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      // Removing loops/wakeKick/setLoopClassifier from the wake driver's tool
      // turn makes the delivered tick's arm throw and no successor lands.
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
          const loopInputs = journal.events.filter(
            (event) =>
              event.kind === 'input.accepted' &&
              event.payload['source'] === 'loop',
          );
          expect(loopInputs).toHaveLength(2);
          const first = loopInputs.find(
            (event) => event.payload['inputId'] === 'loop:wakeup-compaction',
          );
          const successor = loopInputs.find(
            (event) => event.payload['inputId'] !== 'loop:wakeup-compaction',
          );
          expect(successor).toBeDefined();
          expect(successor!.payload['notBefore']).toBeGreaterThan(
            first!.payload['notBefore'] as number,
          );
        },
        { timeout: settleTimeoutMs(), interval: 50 },
      );
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    } finally {
      if (gateBefore === undefined) delete process.env[gateKey];
      else process.env[gateKey] = gateBefore;
    }
  });

  async function prewriteLoopWakeupInput(
    notBefore: number,
    toolProfile = 'hosted-workspace-shell/1',
  ): Promise<void> {
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
              toolProfile,
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
    const loopTurnId = 'loop:wakeup-compaction';
    try {
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: loopTurnId,
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: loopTurnId,
          turnId: loopTurnId,
          source: 'loop',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from(JSON.stringify({ text: '/loop tick' }), 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
          notBefore,
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  /**
   * A Session journal owning one committed pr_event input. With no
   * `notBefore` the input rides the real injection funnel and is due at
   * once; a future `notBefore` parks it past the pump's pick so only the
   * close path may settle it (the funnel itself carries no deferral).
   */
  async function prewritePrEventInput(
    inputId: string,
    notBefore?: number,
  ): Promise<void> {
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
      if (notBefore === undefined) {
        await submitPrEventInput(managed, key, {
          inputId,
          owner: 'Owner',
          repo: 'Repo',
          prNumber: 7,
          transition: 'ci_failure',
          headSha: 'a'.repeat(40),
          evidence: 'Failed checks: build.',
          text: 'Inspect the pull request.',
          episode: 1,
        });
      } else {
        await managed.authority.submitInput(
          {
            operation: 'submitInput',
            commandId: inputId,
            sessionKey: key,
            contentDigest: 'a'.repeat(64),
          },
          {
            inputId,
            turnId: inputId,
            source: PR_EVENT_INPUT_SOURCE,
            contentRef: await managed.resources.publish(
              'managed-input',
              Buffer.from(
                JSON.stringify({ text: 'Inspect the pull request.' }),
                'utf8',
              ),
            ),
            admissionRef: await managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
            notBefore,
          },
        );
      }
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  it('classifier user-text map carries loop continuations for arm vetting', async () => {
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
      const submit = async (turnId: string, source: string) => {
        const envelope =
          source === 'loop'
            ? { text: `text of ${turnId}` }
            : [{ type: 'text', text: `text of ${turnId}` }];
        await managed.authority.submitInput(
          {
            operation: 'submitInput',
            commandId: turnId,
            sessionKey: key,
            contentDigest: 'a'.repeat(64),
          },
          {
            inputId: turnId,
            turnId,
            source,
            contentRef: await managed.resources.publish(
              'managed-input',
              Buffer.from(JSON.stringify(envelope), 'utf8'),
            ),
            admissionRef: await managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
            notBefore: null,
          },
        );
      };
      await submit('loop:tick-1', 'loop');
      await submit('prompt-human', 'hosted-harness');
      const map = await readHostedClassifierUserText({
        managed,
      } as unknown as Parameters<typeof readHostedClassifierUserText>[0]);
      // A fired loop tick must find its own prompt here, or its successor
      // arm is refused as unavailable; removing loop from the map reds this.
      expect(map.get('loop:tick-1')).toBe('text of loop:tick-1');
      expect(map.get('prompt-human')).toBe('text of prompt-human');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it.each([false, true])(
    'suspends beside an unattempted deferred loop wakeup only where the control plane dispatches it (wakeDispatch=%s)',
    async (wakeDispatch) => {
      const notBefore = Date.now() + 3_600_000;
      await prewriteLoopWakeupInput(notBefore);
      mockBrokerBroker();
      state.wakeDispatch = wakeDispatch;
      state.wakeStamps.length = 0;
      try {
        const server = await app(true, undefined, true, { idleSuspendMs: 150 });
        const loaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
        });
        expect(loaded.status).toBe(200);
        const status = () =>
          headers(supertest(server).get(`/session/${SESSION_ID}/status`)).set(
            'X-Qwen-Client-Id',
            loaded.body.clientId as string,
          );
        if (wakeDispatch) {
          await vi.waitFor(
            async () => {
              expect((await status()).status).toBe(404);
            },
            { timeout: 5000 },
          );
          expect(state.wakeStamps).toEqual([
            { pending: true, dueAt: notBefore },
          ]);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 600));
          expect((await status()).status).toBe(200);
          expect(state.wakeStamps).toEqual([]);
          await headers(supertest(server).delete(`/session/${SESSION_ID}`));
        }
      } finally {
        state.wakeDispatch = false;
      }
    },
  );

  it('does not keep the Session busy while a loop wakeup is still deferred', async () => {
    await prewriteLoopWakeupInput(Date.now() + 3_600_000);
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(loaded.status).toBe(200);
    const compress = await headers(
      supertest(server).post(`/session/${SESSION_ID}/context/compress`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        operationId: 'compaction-deferred-loop',
        expectedCompactionRevision: 0,
      });
    // The parked wakeup must not trip the host busy() gate. This fixture has
    // no compression model config, so admission proceeds past busy() into
    // createConfig; removing the busy() carve-out instead refuses up front
    // with session_context_busy.
    expect(compress.body.code).not.toBe('session_context_busy');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('refuses context compaction while a due loop wakeup is still pending', async () => {
    await prewriteLoopWakeupInput(Date.now() - 1_000);
    mockBrokerBroker();
    // Park the pump so the due wakeup stays pending (unsettled) for the
    // admission check instead of being delivered as a turn.
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(loaded.status).toBe(200);
    const compress = await headers(
      supertest(server).post(`/session/${SESSION_ID}/context/compress`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        operationId: 'compaction-due-loop',
        expectedCompactionRevision: 0,
      });
    expect(compress.status).toBe(409);
    expect(compress.body.code).toBe('session_context_busy');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('refuses a pr_event input to a Session with no wake pump', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-external-files/1',
      })
      .expect(200);
    // The external-files profile installs neither automations nor channels,
    // so there is no in-process wake pump. A pr_event input must be refused,
    // not acknowledged into a Session that can never run it: a false 202 would
    // make the adapter record the transition as fired and drop it, while the
    // input also pins Workspace close/delete.
    const response = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        operationId: randomUUID(),
        kind: 'submit_pr_event_input',
        inputId: `prw-${'a'.repeat(64)}:input`,
        owner: 'Owner',
        repo: 'Repo',
        prNumber: 7,
        transition: 'ci_failure',
        headSha: 'a'.repeat(40),
        evidence: 'Failed checks: build.',
        text: 'Inspect the pull request.',
        episode: 1,
      });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('pr_event_wake_unavailable');
  });

  it('defers a pr_event input to a Session still in recovery cleanup', async () => {
    // A resident opened for recovery cleanup registers before its funnel and
    // pump exist, and the next full load replaces it with one that has both.
    // The permanent refusal retires the PR-watch binding, so this window must
    // answer retryably instead.
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
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
    const response = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        operationId: randomUUID(),
        kind: 'submit_pr_event_input',
        inputId: `prw-${'c'.repeat(64)}:input`,
        owner: 'Owner',
        repo: 'Repo',
        prNumber: 7,
        transition: 'ci_failure',
        headSha: 'a'.repeat(40),
        evidence: 'Failed checks: build.',
        text: 'Inspect the pull request.',
        episode: 1,
      });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('pr_event_wake_pending');
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
  });

  it('accepts a pr_event input into the resident Session that owns the wake pump', async () => {
    // R2-9b: the positive half of the refusal above. The default profile
    // installs a wake pump, so the route must commit through THIS
    // Session's own managed authority and session key — swapping either
    // lands the input nowhere (or refuses) and the journal read below
    // finds no admission.
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      })
      .expect(200);
    expect(capturedWakeSession().monitorWake).toBeDefined();
    const inputId = `prw-${'b'.repeat(64)}:input`;
    const response = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        operationId: randomUUID(),
        kind: 'submit_pr_event_input',
        inputId,
        owner: 'Owner',
        repo: 'Repo',
        prNumber: 7,
        transition: 'ci_failure',
        headSha: 'a'.repeat(40),
        evidence: 'Failed checks: build.',
        text: 'Inspect the pull request.',
        episode: 1,
      });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      inputId,
      turnId: inputId,
      replayed: false,
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
    const accepted = journal.events.filter(
      (event) =>
        event.kind === 'input.accepted' && event.payload['inputId'] === inputId,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toMatchObject({
      source: PR_EVENT_INPUT_SOURCE,
      turnId: inputId,
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });
});

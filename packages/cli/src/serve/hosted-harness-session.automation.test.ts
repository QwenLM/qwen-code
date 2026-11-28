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
  hookPin,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import {
  AUTOMATION_ID,
  AUTOMATION_SLOT,
  automationDefinition,
  fireBody,
  mockBrokerBroker,
  prewriteAutomationCrashedTurnSession,
  prewriteAutomationSession,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { ManagedSessionStoreHttpError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { ManagedSessionWritesStoppedError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import { automationRunId } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('defines, fires and settles an automation run through the operations route', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    // The route is the attached client's, like every Session mutation.
    const unattached = await headers(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({
      operationId: randomUUID(),
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(unattached.status).toBe(404);
    // Malformed operations never reach the funnel.
    const noOperationId = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(noOperationId.status).toBe(400);
    expect(noOperationId.body.code).toBe('invalid_automation_operation');
    expect(
      (
        await operations({
          kind: 'define_schedule',
          scheduleId: 'asch_nope',
          definition: automationDefinition,
        })
      ).status,
    ).toBe(400);
    expect(
      (await operations({ kind: 'define_schedule', scheduleId: AUTOMATION_ID }))
        .status,
    ).toBe(400);
    expect(
      (await operations({ kind: 'noop', scheduleId: AUTOMATION_ID })).status,
    ).toBe(400);
    expect(
      (await operations({ ...fireBody(1, ''), scheduleId: AUTOMATION_ID }))
        .status,
    ).toBe(400);
    expect(
      (await operations(fireBody(1, AUTOMATION_SLOT, 'webhook'))).status,
    ).toBe(400);
    expect((await operations({ ...fireBody(0) })).status).toBe(400);
    // An instant the turn text cannot render must die at admission, as a
    // request-shape error — not as a post-claim RangeError re-classified.
    const unrenderable = await operations({
      ...fireBody(),
      firedAt: Number.MAX_SAFE_INTEGER,
    });
    expect(unrenderable.status).toBe(400);
    expect(unrenderable.body.code).toBe('invalid_automation_operation');
    // Nothing defined yet: a fire is not found, not a 503.
    const missing = await operations(fireBody());
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('automation_not_found');
    // The mode gate and the contract answer their own codes.
    const perRun = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: { ...automationDefinition, sessionMode: 'per_run' },
    });
    expect(perRun.status).toBe(409);
    expect(perRun.body.code).toBe('automation_mode_disabled');
    // A gate the shell checks refuse is a pre-commit refusal of its own, so
    // the control plane can release the caller's key.
    const backgrounded = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: { ...automationDefinition, gate: 'sleep 5 &' },
    });
    expect(backgrounded.status).toBe(400);
    expect(backgrounded.body.code).toBe('automation_gate_invalid');
    const badCron = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: { ...automationDefinition, cron: '0 25 * * *' },
    });
    expect(badCron.status).toBe(400);
    expect(badCron.body.code).toBe('invalid_automation_operation');
    // Define: 202 with the committed definition; the same content replays.
    const defined = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(defined.status).toBe(202);
    expect(defined.body).toMatchObject({
      state: 'settled',
      replayed: false,
      schedule: {
        scheduleId: AUTOMATION_ID,
        revision: 1,
        definitionRevision: 1,
        goal: 'Nightly build',
        sessionMode: 'persistent',
        targetSessionId: SESSION_ID,
        overlap: 'skip',
        catchUp: 'none',
        catchUpLimit: null,
        enabled: true,
        state: 'admitted',
      },
    });
    expect(typeof defined.body.operationId).toBe('string');
    const replayedDefine = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(replayedDefine.status).toBe(202);
    expect(replayedDefine.body.replayed).toBe(true);
    const stale = await operations(fireBody(2));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('automation_revision_stale');
    // Fire: the run dispatches with its input; the wake pump delivers it
    // as a text turn while the Session idles; the run settles from the
    // turn's own result.
    const fired = await operations(fireBody());
    expect(fired.status).toBe(202);
    expect(fired.body.replayed).toBe(false);
    expect(fired.body.run).toMatchObject({
      scheduleId: AUTOMATION_ID,
      definitionRevision: 1,
      occurrenceKey: AUTOMATION_SLOT,
      state: 'running',
      execution: 'dispatch_started',
    });
    const runId = fired.body.run.automationRunId as string;
    expect(runId).toMatch(/^arun_[0-9a-f]{64}$/);
    expect(fired.body.inputId).toBe(`${runId}:input`);
    await vi.waitFor(
      async () => {
        const again = await operations(fireBody());
        expect(again.status).toBe(202);
        expect(again.body.replayed).toBe(true);
        expect(again.body.run.state).toBe('settled');
        expect(again.body.run.execution).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(state.model).toHaveBeenCalledTimes(1);
    const modelInput = state.model.mock.calls[0]![0] as {
      promptId?: string;
      prompt?: string;
    };
    expect(modelInput.promptId).toBe(`${runId}:input`);
    expect(modelInput.prompt).toContain('Scheduled automation: Nightly build');
    expect(modelInput.prompt?.endsWith('Run the build.')).toBe(true);
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body).toMatchObject({
      hasActivePrompt: false,
      recoveryBlocked: false,
    });
    // Retire: a new occurrence is refused, the settled one still replays.
    const retired = await operations({
      kind: 'retire_schedule',
      scheduleId: AUTOMATION_ID,
    });
    expect(retired.status).toBe(202);
    expect(retired.body.schedule).toMatchObject({
      revision: 2,
      state: 'cancelled',
      enabled: false,
    });
    const late = await operations(fireBody(2, 'manual:late', 'manual'));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('automation_retired');
    expect((await operations(fireBody())).body.run.state).toBe('settled');
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
    // Claim, dispatch, settle: three run revisions, and the automation
    // input's turn settled by the pump, not by the close path.
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'automation_run',
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${runId}:1`, `${runId}:2`, `${runId}:3`]);
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' &&
        event.payload['turnId'] === `${runId}:input`,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload['outcome']).toBe('completed');
  });

  it('cancels only the active automation occurrence and preserves later runs', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const operations = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ operationId: randomUUID(), ...body });
    const cancel = (occurrenceKey = AUTOMATION_SLOT) =>
      operations({
        kind: 'cancel_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey,
        automationRunId: automationRunId(AUTOMATION_ID, occurrenceKey),
      });
    expect(
      (
        await operations({
          kind: 'cancel_run',
          scheduleId: AUTOMATION_ID,
          occurrenceKey: '',
          automationRunId: automationRunId(AUTOMATION_ID, AUTOMATION_SLOT),
        })
      ).status,
    ).toBe(400);
    expect((await cancel('manual:missing')).status).toBe(404);
    let signal!: AbortSignal;
    let finish!: () => void;
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          finish = () => reject(new DOMException('Cancelled', 'AbortError'));
          signal.addEventListener('abort', finish, { once: true });
        }),
    );
    try {
      expect(
        (
          await operations({
            kind: 'define_schedule',
            scheduleId: AUTOMATION_ID,
            definition: automationDefinition,
          })
        ).status,
      ).toBe(202);
      expect((await operations(fireBody())).status).toBe(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
        timeout: settleTimeoutMs(),
      });
      expect(signal.aborted).toBe(false);
      expect(
        (
          await operations({
            kind: 'cancel_run',
            scheduleId: AUTOMATION_ID,
            occurrenceKey: AUTOMATION_SLOT,
            automationRunId: automationRunId(AUTOMATION_ID, 'manual:other'),
          })
        ).status,
      ).toBe(400);
      expect(signal.aborted).toBe(false);
      expect((await cancel()).status).toBe(202);
      expect(signal.aborted).toBe(true);
      await vi.waitFor(
        async () =>
          expect((await operations(fireBody())).body.run.state).toBe(
            'cancelled',
          ),
        { timeout: settleTimeoutMs() },
      );
      expect((await cancel()).body.run.state).toBe('cancelled');
      expect(
        (
          await operations({
            kind: 'define_schedule',
            scheduleId: AUTOMATION_ID,
            definition: automationDefinition,
          })
        ).body.schedule,
      ).toMatchObject({ enabled: true, revision: 1 });
      expect(
        (await operations(fireBody(1, 'manual:later', 'manual'))).status,
      ).toBe(202);
      await vi.waitFor(
        async () =>
          expect(
            (await operations(fireBody(1, 'manual:later', 'manual'))).body.run
              .state,
          ).toBe('settled'),
        { timeout: settleTimeoutMs() },
      );
      expect((await cancel('manual:later')).body.run.state).toBe('settled');
      expect(state.model).toHaveBeenCalledTimes(2);
    } finally {
      finish?.();
    }
  });

  it('cancels one queued automation without aborting foreground or sibling work', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    let signal!: AbortSignal;
    let finish!: () => void;
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          finish = () =>
            resolve({ text: 'foreground done', model: 'test-model' });
        }),
    );
    const prompt = [{ type: 'text', text: 'foreground held' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
        timeout: settleTimeoutMs(),
      });
      expect(
        (
          await operations({
            kind: 'define_schedule',
            scheduleId: AUTOMATION_ID,
            definition: automationDefinition,
          })
        ).status,
      ).toBe(202);
      expect((await operations(fireBody())).status).toBe(202);
      expect(
        (await operations(fireBody(1, 'manual:sibling', 'manual'))).status,
      ).toBe(202);
      expect(
        (
          await operations({
            kind: 'cancel_run',
            scheduleId: AUTOMATION_ID,
            occurrenceKey: AUTOMATION_SLOT,
            automationRunId: automationRunId(AUTOMATION_ID, AUTOMATION_SLOT),
          })
        ).status,
      ).toBe(202);
      expect(signal.aborted).toBe(false);
      expect(state.model).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(
        async () => {
          expect((await operations(fireBody())).body.run).toMatchObject({
            state: 'cancelled',
            execution: 'not_started_proven',
          });
          expect(
            (await operations(fireBody(1, 'manual:sibling', 'manual'))).body.run
              .state,
          ).toBe('settled');
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(2);
      expect(signal.aborted).toBe(false);
    } finally {
      finish?.();
    }
  });

  it('consumes a durable queued automation cancel on load without a model call', async () => {
    await prewriteAutomationSession(undefined, undefined, true);
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
    });
    expect(loaded.status).toBe(200);
    await vi.waitFor(
      async () => {
        const replay = await headers(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({ operationId: randomUUID(), ...fireBody() });
        expect(replay.body.run).toMatchObject({
          state: 'cancelled',
          execution: 'not_started_proven',
        });
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).not.toHaveBeenCalled();
  });

  // A prewrite whose journal carries one parked harness prompt beside the
  // queued automation input: the parked prompt keeps the wake pump blocked
  // on load (recovery verdict), like prewriteMonitorSession's do.
  async function prewriteAutomationParkedSession(): Promise<string> {
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
      // The parked prompt: an input that never ran a turn, so the Session
      // opens recovery-blocked and its wake pump does not start.
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: 'prompt-1',
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: 'prompt-1',
          turnId: 'prompt-1',
          source: 'hosted-harness',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from('[{"type":"text","text":"hi"}]', 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
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
      const fired = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.parse('2026-03-08T07:00:05Z'),
      });
      return fired.inputId;
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  it('reopens over a queued automation input as idle and runs it', async () => {
    // The Harness died between the dispatch and the turn: the input sits
    // accepted in the journal. On load it is nobody's parked Turn — the
    // pump delivers it — exactly like a monitor notification.
    const turnId = await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
      timeout: settleTimeoutMs(),
      interval: 50,
    });
    expect(
      (state.model.mock.calls[0]![0] as { promptId?: string }).promptId,
    ).toBe(turnId);
    await vi.waitFor(
      async () => {
        const again = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(again.status).toBe(202);
        expect(again.body.run.state).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body).toMatchObject({
      hasActivePrompt: false,
      recoveryBlocked: false,
    });
    // A user prompt is admitted right after: the queued input never
    // blocked the Session.
    const prompt = [{ type: 'text', text: 'hi' }];
    const answered = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(answered.status).toBe(202);
    await vi.waitFor(
      async () => {
        expect(state.model).toHaveBeenCalledTimes(2);
        const idle = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(idle.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('loads an automation-carrying journal through the Workspace restore verifier', async () => {
    const automationTurn = await prewriteAutomationSession(
      'hosted-workspace-files/1',
    );
    expect(automationTurn).toContain('arun_');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    // The verifier's domain list now reads the schedule and run records,
    // their prompt and input resources — or the session never reopens.
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const replayed = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody() });
    expect(replayed.status).toBe(202);
    expect(replayed.body.replayed).toBe(true);
    expect(replayed.body.run.state).toBe('running');
    await vi.waitFor(
      async () => {
        const settled = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(settled.status).toBe(202);
        expect(settled.body.run.state).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it.each([false, true])(
    'settles a crashed automation as failed/unknown with durable cancel=%s',
    async (cancel) => {
      const inputId = await prewriteAutomationCrashedTurnSession(cancel);
      mockBrokerBroker();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        );
      await vi.waitFor(
        async () => {
          const replayed = await authorize(
            supertest(server).post(
              `/session/${SESSION_ID}/automations/operations`,
            ),
          ).send({ operationId: randomUUID(), ...fireBody() });
          expect(replayed.status).toBe(202);
          expect(replayed.body.run.state).toBe('failed');
          expect(replayed.body.run.execution).toBe('outcome_unknown');
        },
        { timeout: settleTimeoutMs(), interval: 50 },
      );
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
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload['outcome']).toBe('error');
      });
      expect(state.model).not.toHaveBeenCalled();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('settles, consumes and unblocks on a crash, and later fires run once', async () => {
    await prewriteAutomationCrashedTurnSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The crashed wake turn settles failed/unknown first.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: settleTimeoutMs() },
    );
    const crashed = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    // The settlement of that crash is also its release: once settled and
    // consumed, the Session takes the next fire without a reload.
    const slot = 'schedule:2026-03-08T11:00:00Z';
    const zombieRun = automationRunId(AUTOMATION_ID, slot);
    await vi.waitFor(
      async () => {
        const accepted = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(accepted.status).toBe(202);
      },
      { timeout: settleTimeoutMs() },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    let journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === `${crashed}:input`,
      ),
    ).toBe(true);
    // Reload: the same crash no longer re-blocks, and the slot fires.
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
    const reloaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(reloaded.status).toBe(200);
    const authorizeReloaded = (request: supertest.Test) =>
      headers(request).set(
        'X-Qwen-Client-Id',
        reloaded.body.clientId as string,
      );
    const fired = await authorizeReloaded(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(fired.status).toBe(202);
    expect(fired.body.replayed).toBe(true);
    journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            String(event.payload['operationId']).startsWith(`${zombieRun}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${zombieRun}:1`, `${zombieRun}:2`, `${zombieRun}:3`]);
  }, 45_000);

  it('still refuses a fire while a parked block persists, even after the close path', async () => {
    await prewriteAutomationParkedSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBe(true);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The parked prompt keeps the Session blocked: a fresh fire is refused
    // before it could commit a run that cannot start.
    const slot = 'schedule:2026-03-08T11:00:00Z';
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_session_blocked');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const zombieRun = automationRunId(AUTOMATION_ID, slot);
    expect(
      (
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        })
      ).events.some(
        (event) =>
          event.kind === 'domain.committed' &&
          String(event.payload['operationId']).startsWith(`${zombieRun}:`),
      ),
    ).toBe(false);
    // The close path settles inputs only of the monitor/automation
    // sources, and the pinned prompt here is a user record: it keeps the
    // Session parked across a reload, and every fire keeps answering 409
    // instead of committing anything.
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const reloaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(reloaded.status).toBe(200);
    const authorizeReloaded = (request: supertest.Test) =>
      headers(request).set(
        'X-Qwen-Client-Id',
        reloaded.body.clientId as string,
      );
    const refusedAgain = await authorizeReloaded(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(refusedAgain.status).toBe(409);
    expect(refusedAgain.body.code).toBe('hosted_session_blocked');
    expect(
      (
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        })
      ).events.some(
        (event) =>
          event.kind === 'domain.committed' &&
          String(event.payload['operationId']).startsWith(`${zombieRun}:`),
      ),
    ).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles a pending automation input model-free on the close path', async () => {
    const turnId = await prewriteAutomationParkedSession();
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
    // Only DELETE's own settle may speak for an input that never ran: the
    // parked prompt kept the wake pump blocked, and the close path settled
    // it model-free, cancelling the run with its execution proven never to
    // have started.
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
        event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
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
    });
    try {
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      );
      const run = automations
        .runs()
        .find((each) => each.occurrenceKey === AUTOMATION_SLOT);
      expect(run?.run.state).toBe('cancelled');
      expect(run?.run.execution).toBe('not_started_proven');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('settles a failed automation run from its turn error through the wake runner catch', async () => {
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
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('answers a fire that lost its store with a retryable 503, and fires after recovery', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    // The queued slot from the prewrite settles first, so nothing but the
    // fire under test reads the store once the fault is armed.
    await vi.waitFor(
      async () => {
        expect((await operations(fireBody())).body.run.state).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    const read = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(
          503,
          'store_unavailable',
          'store down',
        ),
      );
    const slot = 'schedule:2026-03-08T09:00:00Z';
    const refused = await operations(fireBody(1, slot));
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('automation_operation_failed');
    read.mockRestore();
    // The transient fault never settled the occurrence: the claim
    // committed, so the re-drive dispatches that same run.
    const recovered = await operations(fireBody(1, slot));
    expect(recovered.status).toBe(202);
    expect(recovered.body.replayed).toBe(true);
    const runId = recovered.body.run.automationRunId as string;
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
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'automation_run' &&
            String(event.payload['operationId']).startsWith(`${runId}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${runId}:1`, `${runId}:2`]);
    await vi.waitFor(
      async () => {
        expect((await operations(fireBody(1, slot))).body.run.state).toBe(
          'settled',
        );
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('answers an operation against a dead journal writer with a retryable 503', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    await vi.waitFor(
      async () => {
        expect((await operations(fireBody())).body.run.state).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    // WritesStoppedError extends ManagedSessionRecordError: reordering the
    // arm below the plain-record arm would flip the answer to 400 — and
    // the scanner would record the slot skipped forever.
    const read = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(
        new ManagedSessionWritesStoppedError(new Error('writer died')),
      );
    const slot = 'schedule:2026-03-08T09:00:00Z';
    const refused = await operations(fireBody(1, slot));
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('automation_operation_failed');
    read.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });
});

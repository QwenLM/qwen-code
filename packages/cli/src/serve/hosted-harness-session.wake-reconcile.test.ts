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
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import {
  AUTOMATION_ID,
  AUTOMATION_SLOT,
  automationDefinition,
  fireBody,
  holdWakePass,
  mockBrokerBroker,
  mockRepairBroker,
  prewriteAutomationCrashedTurnSession,
  prewriteAutomationParkedWakeSession,
  prewriteAutomationSession,
  stillWaiting,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { automationRunId } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it("has a reconcile wait out the pump's own aftermath, then report the run it settled", async () => {
    await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    // A settled execution stops nothing; only the consume hangs, until
    // the test lets go: the aftermath is provably in flight when the
    // first reconcile answers.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let releaseConsume!: () => void;
    let consumeEntered!: () => void;
    const consuming = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      consumeEntered = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumeEntered();
          return consuming.then(() => originalWrite.call(this, record));
        }
        return originalWrite.call(this, record);
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const reconcile = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({
        operationId: randomUUID(),
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      });
    await entered;
    // The pump's own aftermath is mid-flight: the route waits the pass out
    // instead of competing for the checkpoint (#14538), then reports the
    // run the pass settled.
    const during = reconcile().then((response) => response);
    expect(
      await Promise.race([
        during.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
      ]),
    ).toBe('waiting');
    releaseConsume();
    const after = await during;
    expect(after.status).toBe(202);
    expect(after.body.repaired).toBe(false);
    expect(after.body.run.state).toBe('failed');
    expect(after.body.run.execution).toBe('outcome_unknown');
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('has the reconcile route itself repair a crash the pump left blocked, past an older deferred loop input', async () => {
    // The older not-yet-due loop input is first by journal order but never
    // attempted: the repair must target the crashed automation, not it.
    const inputId = await prewriteAutomationParkedWakeSession(
      'read_file',
      true,
    );
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    // The pump's one aftermath pass loses its lease release, which leaves
    // the Session blocked with the crashed input pending. From then on the
    // test parks every kick (a live pump would retry), so only the route's
    // own repair branch can finish the aftermath. In 'has a reconcile wait
    // out the pump's own aftermath, then report the run it settled' the
    // pump settles it instead, and the route only reports.
    let brokerDown = true;
    let pumpLive = true;
    let parkedKicks = 0;
    const releases: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      async () => {
        releases.push(brokerDown ? 'refused' : 'released');
        if (brokerDown) {
          pumpLive = false;
          throw new TypeError('Runtime Broker release lost to a 503');
        }
      },
    );
    const kick = HostedMonitorWakeScheduler.prototype.kick;
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      function (this: HostedMonitorWakeScheduler) {
        if (pumpLive) kick.call(this);
        else parkedKicks += 1;
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const status = async () =>
      (await authorize(supertest(server).get(`/session/${SESSION_ID}/status`)))
        .body as { recoveryBlocked: boolean; hasActivePrompt: boolean };
    const settledTurns = async () =>
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
          event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
      ).length;
    const reconcile = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({
        operationId: randomUUID(),
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      });
    await vi.waitFor(
      async () => {
        expect(releases).toEqual(['refused']);
        expect((await status()).recoveryBlocked).toBe(true);
        // The pump arms its retry only after the pass's settle-verify
        // read: a parked retry kick means that pass is over.
        expect(parkedKicks).toBeGreaterThan(0);
      },
      { timeout: 15_000 },
    );
    expect(await settledTurns()).toBe(0);
    // A route pass that loses its release too repairs nothing: the block
    // and the input stay. The run already failed in the pump's pass.
    const refused = await reconcile();
    expect(refused.status).toBe(202);
    expect(refused.body.repaired).toBe(false);
    expect(refused.body.run).toMatchObject({
      state: 'failed',
      execution: 'outcome_unknown',
    });
    expect(releases).toEqual(['refused', 'refused']);
    expect((await status()).recoveryBlocked).toBe(true);
    expect(await settledTurns()).toBe(0);
    brokerDown = false;
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let releaseConsume!: () => void;
    let consumeEntered!: () => void;
    const consuming = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      consumeEntered = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumeEntered();
          return consuming.then(() => originalWrite.call(this, record));
        }
        return originalWrite.call(this, record);
      },
    );
    const repairing = reconcile().then((response) => response);
    // A route that skips the repair answers without ever consuming.
    expect(
      await Promise.race([
        entered.then(() => 'consuming'),
        repairing.then(() => 'answered'),
      ]),
    ).toBe('consuming');
    // Mid-repair the route holds the turn slot, which a live pump would
    // read as busy.
    expect((await status()).hasActivePrompt).toBe(true);
    releaseConsume();
    const repaired = await repairing;
    expect(repaired.status).toBe(202);
    expect(repaired.body.repaired).toBe(true);
    expect(releases).toEqual(['refused', 'refused', 'released']);
    expect(await status()).toMatchObject({
      recoveryBlocked: false,
      hasActivePrompt: false,
    });
    expect(await settledTurns()).toBe(1);
    // Consumed: a further reconcile only reports the settled run.
    const reported = await reconcile();
    expect(reported.status).toBe(202);
    expect(reported.body.repaired).toBe(false);
    expect(reported.body.run).toMatchObject({
      state: 'failed',
      execution: 'outcome_unknown',
    });
    expect(releases).toEqual(['refused', 'refused', 'released']);
    expect(await settledTurns()).toBe(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  async function loadCrashedWake(inputId: string) {
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    return {
      server,
      authorize,
      status: async () =>
        (
          await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          )
        ).body as { recoveryBlocked: boolean; hasActivePrompt: boolean },
      settledTurns: async () =>
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
            event.payload['turnId'] === inputId,
        ).length,
      reconcile: () =>
        authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        )
          .send({
            operationId: randomUUID(),
            kind: 'reconcile_run',
            scheduleId: AUTOMATION_ID,
            occurrenceKey: AUTOMATION_SLOT,
          })
          .then((response) => response),
    };
  }

  it.each(['input read', 'transcript projection'] as const)(
    'has a reconcile wait out the load pass held at its %s, then report the run it settled',
    async (at) => {
      const inputId = await prewriteAutomationParkedWakeSession();
      mockBrokerBroker();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'settled',
      } as never);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const pass = holdWakePass(at);
      const { server, status, settledTurns, reconcile } =
        await loadCrashedWake(inputId);
      await vi.waitFor(() => expect(pass.held()).toBe(true), {
        timeout: 15_000,
      });
      const answer = reconcile();
      expect(await stillWaiting(answer)).toBe('waiting');
      expect(await settledTurns()).toBe(0);
      pass.open();
      // The pass settled the crash itself: the route repairs nothing, and
      // the failed run is what resolves the occurrence.
      const reported = await answer;
      expect(reported.status).toBe(202);
      expect(reported.body.repaired).toBe(false);
      expect(reported.body.run).toMatchObject({
        state: 'failed',
        execution: 'outcome_unknown',
      });
      expect((await status()).recoveryBlocked).toBe(false);
      expect(await settledTurns()).toBe(1);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
    45_000,
  );

  it('has a reconcile wait out a load pass whose aftermath failed, then repair what it left blocked', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    let brokerDown = true;
    const releases: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      async () => {
        releases.push(brokerDown ? 'refused' : 'released');
        if (brokerDown)
          throw new TypeError('Runtime Broker release lost to a 503');
      },
    );
    // After its aftermath lost the release, the pass's next input read is
    // its settle-verify read.
    const pass = holdWakePass('input read', () => releases.length === 1);
    const { server, status, settledTurns, reconcile } =
      await loadCrashedWake(inputId);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    expect((await status()).recoveryBlocked).toBe(true);
    brokerDown = false;
    const answer = reconcile();
    expect(await stillWaiting(answer)).toBe('waiting');
    expect(releases).toEqual(['refused']);
    pass.open();
    // The pass ends blocked and hands the pump to the waiting route before
    // its own retry fires: the route's repair is the one that settles.
    const repaired = await answer;
    expect(repaired.status).toBe(202);
    expect(repaired.body.repaired).toBe(true);
    expect(repaired.body.run).toMatchObject({
      state: 'failed',
      execution: 'outcome_unknown',
    });
    expect(releases).toEqual(['refused', 'released']);
    expect((await status()).recoveryBlocked).toBe(false);
    expect(await settledTurns()).toBe(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a reconcile report without settling when the load pass outlasts its wait', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    // The route's wait, cut from its production bound.
    const exclusive = HostedMonitorWakeScheduler.prototype.exclusive;
    vi.spyOn(
      HostedMonitorWakeScheduler.prototype,
      'exclusive',
    ).mockImplementation(function (this: HostedMonitorWakeScheduler, work) {
      return exclusive.call(this, work, 200);
    });
    const pass = holdWakePass('transcript projection');
    const { server, status, settledTurns, reconcile } =
      await loadCrashedWake(inputId);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    // The pass has not classified the crash yet, so the run still reads
    // as dispatched, and the route leaves the input to the pass.
    const reported = await reconcile();
    expect(reported.status).toBe(202);
    expect(reported.body.repaired).toBe(false);
    expect(reported.body.run).toMatchObject({
      state: 'running',
      execution: 'dispatch_started',
    });
    expect(await settledTurns()).toBe(0);
    pass.open();
    await vi.waitFor(
      async () => {
        expect((await status()).recoveryBlocked).toBe(false);
        expect(await settledTurns()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a reconcile that waited leave the turn slot to a prompt admitted meanwhile', async () => {
    // A crash with no Runtime park: a public prompt is admitted while the
    // load's pass is still reading the crashed input.
    const inputId = await prewriteAutomationCrashedTurnSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
    const pass = holdWakePass('input read');
    const { server, authorize, status, settledTurns, reconcile } =
      await loadCrashedWake(inputId);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    const answer = reconcile();
    expect(await stillWaiting(answer)).toBe('waiting');
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
    // The re-check after the wait finds the prompt's claim: the route
    // repairs nothing, and the prompt keeps its slot.
    const reported = await answer;
    expect(reported.status).toBe(202);
    expect(reported.body.repaired).toBe(false);
    expect((await status()).hasActivePrompt).toBe(true);
    expect(await settledTurns()).toBe(0);
    openModel();
    // Once the prompt ends, the pump settles the crash itself.
    await vi.waitFor(
      async () => {
        expect(await status()).toMatchObject({
          recoveryBlocked: false,
          hasActivePrompt: false,
        });
        expect(await settledTurns()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('treats a reconcile over a consumed crash as a settled-run replay', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const reconcile = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({
        operationId: randomUUID(),
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      });
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    // The aftermath — here performed by the pump's own cycle, the same
    // one the route drives when it is first — answers through the run.
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
      { timeout: 15_000 },
    );
    // Nothing of the crash is pending once settled and consumed: the
    // reconcile is a report of the settled run, not another repair.
    const replay = await reconcile();
    expect(replay.status).toBe(202);
    expect(replay.body.repaired).toBe(false);
    expect(replay.body.run.state).toBe('failed');
    expect(replay.body.run.execution).toBe('settled');
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const crashed = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            String(event.payload['operationId']).startsWith(`${crashed}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${crashed}:1`, `${crashed}:2`, `${crashed}:3`]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('reports a reconcile against a live wake turn without settling its run', async () => {
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
    expect(
      (
        await operations({
          kind: 'define_schedule',
          scheduleId: AUTOMATION_ID,
          definition: automationDefinition,
        })
      ).status,
    ).toBe(202);
    const inputId = `${automationRunId(AUTOMATION_ID, AUTOMATION_SLOT)}:input`;
    // The live turn's user record is durable before its model call: the
    // aftermath's crash test reads any record of the turn (here that user
    // record) as a prior attempt, so only the turn's hold on the slot
    // tells it apart from a turn that died there.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let userRecordWritten = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record) {
        await originalWrite.call(this, record);
        if (record.type === 'user' && record.daemonPromptId === inputId) {
          userRecordWritten = true;
        }
      },
    );
    let releaseModel!: () => void;
    let modelEntered = false;
    const modelHeld = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    state.model.mockImplementationOnce(async () => {
      modelEntered = true;
      await modelHeld;
      return { text: 'hello back', model: 'test-model' };
    });
    try {
      const fired = await operations(fireBody());
      expect(fired.status).toBe(202);
      expect(fired.body.inputId).toBe(inputId);
      await vi.waitFor(
        () => {
          expect(modelEntered).toBe(true);
          expect(userRecordWritten).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      // An overlap `skip` slot's reconcile while the turn runs: no
      // aftermath is in flight, so only the slot guard keeps the route
      // from classifying the live turn as crashed.
      const reconciled = await operations({
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      }).timeout(10_000);
      expect(reconciled.status).toBe(202);
      expect(reconciled.body.repaired).toBe(false);
      expect(reconciled.body.run).toMatchObject({
        state: 'running',
        execution: 'dispatch_started',
      });
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.hasActivePrompt).toBe(true);
    } finally {
      releaseModel();
      // A failed assertion must not leave the turn running into the
      // teardown, whose close refuses an active turn.
      // Cleanup, not proof: keep it short so a wedged turn still leaves the
      // assertion above inside this test's `}, 45_000);` ceiling.
      await vi
        .waitFor(
          async () => {
            const idle = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(idle.body.hasActivePrompt).toBe(false);
          },
          { timeout: 10_000 },
        )
        .catch(() => undefined);
    }
    // The turn the reconcile left alone settles its run itself.
    await vi.waitFor(
      async () => {
        const replayed = await operations(fireBody());
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('settled');
        expect(replayed.body.run.execution).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(state.model).toHaveBeenCalledTimes(1);
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
    expect(settled[0]!.payload['outcome']).toBe('completed');
  }, 45_000);

  it('refuses a prompt while a wake park is still unsettled, retriably', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    // The first projection the wake classification reads after the load
    // hangs until the test lets go: only the prompt route's own
    // checkpoint probe may answer this refusal, never the pump's later
    // classification (which would also refuse, from a shadowing cause).
    const originalProject = ManagedSessionRecordSink.prototype.project;
    let afterLoad = false;
    let hanging = false;
    let releaseClassify!: () => void;
    const classifyGate = new Promise<void>((resolve) => {
      releaseClassify = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'project').mockImplementation(
      function (this: ManagedSessionRecordSink) {
        if (afterLoad && !hanging) {
          hanging = true;
          return classifyGate.then(() => originalProject.call(this));
        }
        return originalProject.call(this);
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    afterLoad = true;
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: randomUUID(),
      payloadDigest,
    });
    // The coordinator's transient-window exemption retries exactly this
    // code until the pump settles the park.
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_in_progress');
    // Nothing was admitted: the checkpoint probe, not the admission path,
    // held the line.
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
          event.kind === 'input.accepted' &&
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    releaseClassify();
    repair.unlatch();
    // Drain the parked settle before teardown: an unsettled park keeps the
    // wake pump retrying past this test's end, and its settle failures land
    // in later tests' stderr spies. The pump's own view is the journal —
    // watch the consume, not a route: a status poll can answer before the
    // hung classification ever latches the block.
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
              event.payload['turnId'] === inputId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
  }, 45_000);

  it('refuses a prompt whose wake-park probe let the pump block the Session', async () => {
    await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    repair.unlatch();
    // Hold the pump itself before load: its first projection can otherwise
    // run before the load response reaches the test, leaving the wrong
    // consumer suspended at the probe below.
    let afterLoad = false;
    let releaseRun!: () => void;
    wakeDeps.runTurnGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    // The route probe's checkpoint read hangs next, so the block lands
    // strictly between the probe's start and its answer.
    const originalAuthorization =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    let probeHung = false;
    let probedResolve!: () => void;
    let releaseProbe!: () => void;
    const probed = new Promise<void>((resolve) => {
      probedResolve = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(function (this: LocalManagedSessionAuthority) {
      if (afterLoad && !probeHung) {
        probeHung = true;
        probedResolve();
        return probeGate.then(() => originalAuthorization.call(this));
      }
      return originalAuthorization.call(this);
    });
    // The worker release hangs last: the aftermath then holds the block
    // with the cancelled results already committed — exactly the window
    // in which the probe's answer (no in-progress items remain) can no
    // longer see the park.
    let releaseHung = false;
    let releasingResolve!: () => void;
    let releaseRelease!: () => void;
    const releasing = new Promise<void>((resolve) => {
      releasingResolve = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      releaseRelease = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      () => {
        repair.order.push('release');
        if (!releaseHung) {
          releaseHung = true;
          releasingResolve();
          return releaseGate;
        }
        return Promise.resolve();
      },
    );
    const server = await app(true);
    try {
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      afterLoad = true;
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      // Promise.resolve dispatches the supertest thenable at once (its
      // request only leaves on .then), so the probe is in flight while
      // the test drives the pump below.
      const prompted = Promise.resolve(
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: randomUUID(),
            payloadDigest,
          },
        ),
      );
      // The probe is in flight; the pump now classifies the same park,
      // and its aftermath stops, commits the cancelled results and parks
      // at the held release — the block the probe started before.
      await probed;
      releaseRun();
      await releasing;
      releaseProbe();
      const refused = await prompted;
      // The post-probe re-read, not the probe, held the line: the durable
      // session-scope code, while the transient-window one belongs to the
      // probe's own finding (the sibling pin above).
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('turn_blocked');
      // Nothing was admitted.
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
            event.kind === 'input.accepted' &&
            event.payload['source'] === 'hosted-harness',
        ),
      ).toBe(false);
      releaseRelease();
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 15_000 },
      );
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    } finally {
      releaseRun();
      releaseProbe();
      releaseRelease();
    }
  }, 45_000);
});

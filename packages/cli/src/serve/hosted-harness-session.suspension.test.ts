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
  mcpApp,
  settleTimeoutMs,
  setupHostedTextSession,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import {
  sleep,
  statsOf,
  statusOf,
} from './hosted-harness-session-suspension.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import supertest from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedMcpSession } from './hosted-mcp-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';

// Phase 1 of the stateless Hosted Harness design: an idle Session drains
// its non-terminal owners and seals its writer, and the next load cold-opens
// it. The gate refuses work while a teardown converges and keeps refusing
// after an uncertain one, until operator recovery.
describe('idle suspension', () => {
  beforeEach(setupHostedTextSession);

  async function createIdleSession(server: Server): Promise<string> {
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    return created.body.clientId as string;
  }

  async function createPooledIdleSession(server: Server): Promise<string> {
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: {
          instanceId: 'pod-a',
          bootId: BOOT_ID,
          placementEpoch: 1,
        },
      })
      .expect(200);
    return created.body.clientId as string;
  }

  async function expectSuspended(server: Server, clientId: string) {
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  }

  const loadSession = (server: Server) =>
    headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
      managedSessionStore: store(),
    });

  const isActivationRelease = (records: readonly unknown[]) =>
    (
      records as Array<{
        managedSession?: { kind?: string; payload?: { phase?: string } };
      }>
    ).some(
      (record) =>
        record.managedSession?.kind === 'activation.changed' &&
        record.managedSession?.payload?.phase === 'released',
    );

  it('stamps a clean suspension with nothing pending where the control plane dispatches wakes', async () => {
    state.wakeDispatch = true;
    state.wakeStamps.length = 0;
    try {
      const server = await app(false, undefined, true, { idleSuspendMs: 150 });
      const clientId = await createIdleSession(server);
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
      expect(state.wakeStamps).toEqual([{ pending: false, dueAt: 0 }]);
    } finally {
      state.wakeDispatch = false;
    }
  });

  it('releases a pooled placement only after the clean wake seal', async () => {
    state.wakeDispatch = true;
    state.suspensionPlacementRelease = true;
    try {
      const server = await app(false, 'pod-a', true, { idleSuspendMs: 150 });
      const clientId = await createPooledIdleSession(server);
      await expectSuspended(server, clientId);

      expect(state.ownershipTransitions).toEqual([
        'quiesce',
        'seal',
        'release',
      ]);
      expect(state.ownershipQuiesces).toHaveLength(1);
      expect(state.wakeStamps).toEqual([{ pending: false, dueAt: 0 }]);
      expect(state.ownershipReleases).toHaveLength(1);
      expect(state.ownershipReleases[0]).toMatchObject({
        instanceId: 'pod-a',
        bootId: BOOT_ID,
        placementEpoch: 1,
        operationId: expect.any(String),
      });
    } finally {
      state.wakeDispatch = false;
    }
  });

  it('keeps a pooled placement when the Store lacks the release capability', async () => {
    state.wakeDispatch = true;
    try {
      const server = await app(false, 'pod-a', true, { idleSuspendMs: 150 });
      const clientId = await createPooledIdleSession(server);
      await expectSuspended(server, clientId);

      expect(state.ownershipQuiesces).toHaveLength(0);
      expect(state.ownershipReleases).toHaveLength(0);
    } finally {
      state.wakeDispatch = false;
    }
  });

  it('retries only placement release with the identical operation and proof', async () => {
    state.wakeDispatch = true;
    state.suspensionPlacementRelease = true;
    state.ownershipReleaseFault = async (_request, attempt) => {
      if (attempt === 1) throw new Error('lost release acknowledgement');
    };
    let activationReleases = 0;
    state.appendFault = async (_journal, records, append) => {
      if (isActivationRelease(records)) activationReleases += 1;
      await append(records);
      return true;
    };
    try {
      const server = await app(false, 'pod-a', true, {
        idleSuspendMs: 100,
        suspendRetryBaseMs: 5,
        suspendRetryCap: 2,
      });
      const clientId = await createPooledIdleSession(server);
      await expectSuspended(server, clientId);

      expect(state.ownershipQuiesces).toHaveLength(1);
      expect(state.wakeStamps).toHaveLength(1);
      expect(activationReleases).toBe(1);
      expect(state.ownershipReleases).toHaveLength(2);
      expect(state.ownershipReleases[1]).toEqual(state.ownershipReleases[0]);
      expect(state.ownershipTransitions).toEqual([
        'quiesce',
        'seal',
        'release',
        'release',
      ]);
    } finally {
      state.wakeDispatch = false;
    }
  });

  it('suspends an idle session and cold-opens it on the next load', async () => {
    const server = await app(false, undefined, true, { idleSuspendMs: 150 });
    const clientId = await createIdleSession(server);
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
    const load = await loadSession(server);
    expect(load.status).toBe(200);
    expect((await statusOf(server, load.body.clientId)).status).toBe(200);
    expect(statsOf(server).cleanSuspensions).toBe(1);
  });

  it('reports its suspension counts on the instance metrics route', async () => {
    const server = await app(false, 'pod-a', true, { idleSuspendMs: 150 });
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: {
          instanceId: 'pod-a',
          bootId: BOOT_ID,
          placementEpoch: 1,
        },
      })
      .expect(200);
    await vi.waitFor(
      async () => {
        expect(
          (await statusOf(server, created.body.clientId as string)).status,
        ).toBe(404);
      },
      { timeout: 5000 },
    );
    const metrics = await headers(
      supertest(server).get('/internal/hosted-harness/v1/metrics'),
    ).expect(200);
    expect(metrics.body.suspension).toMatchObject({ cleanSuspensions: 1 });
  });

  it.each([
    ['parks the MCP owner when the Broker advertises parking', true],
    ['drains the MCP owner when the Broker does not', false],
  ])('%s', async (_name, parkable) => {
    const { server, authorize, requests } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-mcp/1',
      {},
      { idleSuspendMs: 2000 },
    );
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const original = acquire.getMockImplementation()!;
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      await original.call(this);
      this.mcpParkable = parkable;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'idle-claim',
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    const operation = () => ({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send(operation())
      .expect(202);
    await vi.waitFor(() =>
      expect(requests.some((request) => request.kind === 'mcp-configure')).toBe(
        true,
      ),
    );
    // The first configure belongs to this Session's posted operation; its
    // control context names the owner broker. A prior test's lingering idle
    // timer can drain an already-drained owner during this window, calling
    // releaseMount without an mcp-release, so scope the mount/release counts
    // to this owner rather than the prototype-wide spies.
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const configureCall = control.mock.calls.findIndex(
      ([operation]) => operation.kind === 'mcp-configure',
    );
    const owner = control.mock.contexts[configureCall] as HostedWorkspaceBroker;
    await vi.waitFor(() => expect(statsOf(server).cleanSuspensions).toBe(1), {
      timeout: 10_000,
    });
    const released = requests.filter((r) => r.kind === 'mcp-release');
    expect(released).toHaveLength(parkable ? 0 : 1);
    expect(
      releaseMount.mock.contexts.filter((context) => context === owner),
    ).toHaveLength(parkable ? 0 : 1);
    expect(
      vi
        .mocked(HostedWorkspaceBroker.prototype.release)
        .mock.contexts.filter((context) => context === owner),
    ).toHaveLength(0);

    requests.length = 0;
    const load = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-mcp/1',
      mcpServers: [
        {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      ],
    });
    expect(load.status).toBe(200);
    await headers(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .set('X-Qwen-Client-Id', load.body.clientId as string)
      .send(operation())
      .expect(202);
    expect(requests.some((r) => r.kind === 'mcp-configure')).toBe(!parkable);
    // Do not leak this second idle teardown into the next test's mock scope.
    await vi.waitFor(() => expect(statsOf(server).cleanSuspensions).toBe(2), {
      timeout: 10_000,
    });
  });

  it('an admitted mutation resets the idle timer', async () => {
    const server = await app(false, undefined, true, { idleSuspendMs: 4000 });
    const clientId = await createIdleSession(server);
    await sleep(2400);
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'still here' })
      .expect(200);
    // Past the original deadline (4000ms + ≤10% jitter = ≤4400ms) and before
    // the one the title re-armed (≥6400ms from the create). Each sleep(2400)
    // has 1600ms of overrun tolerance before its own bound, but the residency
    // check itself clears the worst-case original fire by only ~400ms, so the
    // two sleeps must total more than idleMs * 1.1 (#18053).
    await sleep(2400);
    expect((await statusOf(server, clientId)).status).toBe(200);
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  });

  it('a resident-reuse load resets the idle clock', async () => {
    const server = await app(false, undefined, true, { idleSuspendMs: 300 });
    const clientId = await createIdleSession(server);
    await sleep(200);
    // The load route is registered before the session middleware, so a
    // resident-reuse reply never reaches the middleware's noteActivity;
    // sendAttachment must reset the clock itself (qqqys R1-2).
    const reuse = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
      });
    expect(reuse.status).toBe(200);
    expect(reuse.body.clientId).toBe(clientId);
    // Past the original deadline (~300ms from create) but before the
    // re-armed one (~200 + 300ms): the reuse reset the clock, so the
    // Session is still resident.
    await sleep(200);
    expect((await statusOf(server, clientId)).status).toBe(200);
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  });

  it('an open event stream keeps the session resident', async () => {
    const server = await app(false, undefined, true, { idleSuspendMs: 150 });
    const clientId = await createIdleSession(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const stream = new AbortController();
    try {
      const opened = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: stream.signal,
        },
      );
      expect(opened.status).toBe(200);
      // An open stream is a reader the teardown would cut, so the predicate
      // refuses it across several idle periods.
      await sleep(500);
      expect((await statusOf(server, clientId)).status).toBe(200);
      expect(statsOf(server).cleanSuspensions).toBe(0);
      expect(statsOf(server).eligibilityFailures).toBeGreaterThanOrEqual(1);
      stream.abort();
      await vi.waitFor(
        async () => {
          expect((await statusOf(server, clientId)).status).toBe(404);
        },
        { timeout: 5000 },
      );
    } finally {
      stream.abort();
      server.closeAllConnections();
    }
  });

  it('a disconnected mutation keeps its own async tail counted', async () => {
    const server = await app(false, undefined, true, { idleSuspendMs: 200 });
    const clientId = await createIdleSession(server);
    let release!: () => void;
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stalled = false;
    // Stall the admitted request inside its own authorization await: the
    // work holds no busy flag and has not entered the authority's serial
    // queue yet, so only the admitted-work count keeps teardown off it.
    state.authorizeOrdinary.mockImplementation(async () => {
      if (!stalled) {
        stalled = true;
        await stall;
      }
    });
    const request = headers(
      supertest(server).post(`/session/${SESSION_ID}/title`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'disconnected caller' });
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    await vi.waitFor(
      async () => {
        expect(stalled).toBe(true);
      },
      { timeout: 5000 },
    );
    // The socket closes while the commit is still in flight. Releasing the
    // admitted unit here would let teardown start under live work.
    request.abort();
    await settled;
    await sleep(700);
    // The attempt raised its gate and is still waiting for the admitted unit,
    // so routes answer the reversible closing refusal — never a completed
    // suspension, which is what releasing on the socket's 'close' produced.
    const gated = await statusOf(server, clientId);
    expect(gated.status).toBe(409);
    expect(gated.body.code).toBe('hosted_session_closing');
    expect(statsOf(server).cleanSuspensions).toBe(0);
    release();
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  });

  it('a pending MCP operation keeps the session resident, not blocked', async () => {
    const server = await app(true, undefined, true, { idleSuspendMs: 150 });
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      toolProfile: 'hosted-workspace-mcp/1',
      mcpServers: [
        {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      ],
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    // The durable record an abandoned dispatch leaves behind: the route's
    // finally already cleared mcpBusy, so only the record holds the Session.
    // The owner close in teardown step 3 refuses while it is pending.
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    try {
      await sleep(600);
      expect((await statusOf(server, clientId)).status).toBe(200);
      expect(statsOf(server).cleanSuspensions).toBe(0);
      // The defect this pins: without the durable term the attempt spends its
      // retries and hands the Session a blocked gate every idle period.
      expect(statsOf(server).blockedTeardowns).toBe(0);
      expect(statsOf(server).eligibilityFailures).toBeGreaterThanOrEqual(1);
    } finally {
      pending.mockRestore();
    }
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  });

  it('a capped teardown ends the writer lease renewal', async () => {
    const server = await app(false, undefined, true, {
      idleSuspendMs: 150,
      suspendRetryBaseMs: 5,
      suspendRetryCap: 2,
      suspendReconcileMs: 400,
    });
    await createIdleSession(server);
    state.appendFault = async (_journal, records, _append) => {
      if (isActivationRelease(records)) throw new Error('store gone');
      return false;
    };
    await vi.waitFor(
      async () => {
        expect(statsOf(server).blockedTeardowns).toBe(1);
      },
      { timeout: 5000 },
    );
    // The bounded reconciliation only fences the old writer once the lease
    // lapses. The removed resident's Store client must not keep renewing it:
    // stopLocal() is never reached on this path, so the timer needs its own
    // stop (the activation renewal alone does not carry the writer lease).
    expect(state.writerRenewalStops).toBeGreaterThanOrEqual(1);
  });

  it('a parked input keeps the session resident', async () => {
    const server = await app(true, undefined, true, { idleSuspendMs: 150 });
    const clientId = await createIdleSession(server);
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
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
        const status = await statusOf(server, clientId);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    await sleep(400);
    const status = await statusOf(server, clientId);
    expect(status.status).toBe(200);
    expect(status.body.recoveryBlocked).toBe(true);
    expect(statsOf(server).revertedAttempts).toBeGreaterThanOrEqual(1);
    expect(statsOf(server).eligibilityFailures).toBeGreaterThanOrEqual(1);
    expect(statsOf(server).cleanSuspensions).toBe(0);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('a converging teardown answers closing to routes and loads alike', async () => {
    const server = await app(false, undefined, true, {
      idleSuspendMs: 150,
      suspendRetryBaseMs: 10,
      suspendRetryCap: 2,
    });
    const clientId = await createIdleSession(server);
    let release!: () => void;
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stalled = false;
    state.appendFault = async (_journal, records, _append) => {
      if (isActivationRelease(records) && !stalled) {
        stalled = true;
        await stall;
      }
      return false;
    };
    await vi.waitFor(
      async () => {
        expect(stalled).toBe(true);
      },
      { timeout: 5000 },
    );
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/title`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'too late' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_session_closing');
    const loadRefused = await loadSession(server);
    expect(loadRefused.status).toBe(409);
    expect(loadRefused.body.code).toBe('hosted_session_closing');
    release();
    await vi.waitFor(
      async () => {
        expect((await statusOf(server, clientId)).status).toBe(404);
      },
      { timeout: 5000 },
    );
  });

  it('an uncertain teardown blocks loads during reconciliation then auto-clears', async () => {
    const server = await app(false, undefined, true, {
      idleSuspendMs: 150,
      suspendRetryBaseMs: 5,
      suspendRetryCap: 2,
      suspendReconcileMs: 400,
    });
    const clientId = await createIdleSession(server);
    let releaseFailures = 0;
    state.appendFault = async (_journal, records, _append) => {
      // Fail the teardown's release attempts (cap 2), then recover: the
      // Store comes back, so the reconciled cold open succeeds.
      if (isActivationRelease(records) && releaseFailures < 2) {
        releaseFailures += 1;
        throw new Error('store gone');
      }
      return false;
    };
    // During the bounded reconciliation wait the gate stays blocked: loads
    // and reads meet the refusal, never a silent 404 that would let an
    // ordinary load re-open the Session before the old seal is fenced.
    await vi.waitFor(
      async () => {
        const load = await loadSession(server);
        expect(load.status).toBe(409);
        expect(load.body.code).toBe('hosted_session_teardown_blocked');
      },
      { timeout: 5000 },
    );
    const status = await statusOf(server, clientId);
    expect(status.status).toBe(409);
    expect(status.body.code).toBe('hosted_session_teardown_blocked');
    expect(statsOf(server).blockedTeardowns).toBe(1);
    // After the bound (writer lease expired + the capped attempt's in-flight
    // seal timed out), any acquire bumps the generation and fences the old
    // seal, so the gate auto-clears and the next load cold-opens without an
    // operator (design open question 8).
    await vi.waitFor(
      async () => {
        expect(statsOf(server).reconciledGates).toBe(1);
      },
      { timeout: 5000 },
    );
    // The gate auto-cleared without an operator: a subsequent load is no
    // longer gate-refused. (Whether it then succeeds depends on the Store's
    // acquire semantics; the local JSONL fixture can wedge the writer after
    // an uncertain teardown, so assert the gate is open, not the load result.
    // The clean suspend→cold-open path is covered by the happy-path test.)
    const load = await loadSession(server);
    expect(
      load.status === 409 &&
        load.body.code === 'hosted_session_teardown_blocked',
    ).toBe(false);
    expect(statsOf(server).cleanSuspensions).toBe(0);
  });

  it('a reconciled gate still surfaces a persistent Store outage as a load failure', async () => {
    const server = await app(false, undefined, true, {
      idleSuspendMs: 150,
      suspendRetryBaseMs: 5,
      suspendRetryCap: 2,
      suspendReconcileMs: 400,
    });
    await createIdleSession(server);
    state.appendFault = async (_journal, records, _append) => {
      if (isActivationRelease(records)) throw new Error('store gone');
      return false;
    };
    await vi.waitFor(
      async () => {
        expect(statsOf(server).reconciledGates).toBe(1);
      },
      { timeout: 5000 },
    );
    // The gate auto-cleared (no operator), but the Store is still down: the
    // cold open fails with a transient Store error, not the gate refusal.
    const load = await loadSession(server);
    expect(load.status).toBe(503);
    expect(load.body.code).not.toBe('hosted_session_teardown_blocked');
  });

  // The instance caps concurrent cold opens; the excess is refused with
  // the transient code the control plane classifies as a budget-exempt
  // wait, and the slot frees when the in-flight open completes.
  it('refuses cold opens past the instance cap until a slot frees', async () => {
    const server = await app(false, undefined, true, { coldOpenLimit: 1 });
    // The work poll reports this count as its free slots.
    const freeSlots = () =>
      (
        server as Server & {
          harnessRegistration: { freeColdOpenSlots: () => number };
        }
      ).harnessRegistration.freeColdOpenSlots();
    expect(freeSlots()).toBe(1);
    let release!: () => void;
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stalled = false;
    state.appendFault = async (_journal, _records, _append) => {
      if (!stalled) {
        stalled = true;
        await stall;
      }
      return false;
    };
    const creating = headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      })
      .then((response) => response);
    await vi.waitFor(
      async () => {
        expect(stalled).toBe(true);
      },
      { timeout: 5000 },
    );
    const refused = await headers(supertest(server).post('/session')).send({
      sessionId: '44444444-4444-4444-8444-444444444444',
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_session_open_busy');
    expect(statsOf(server).openBusyRefusals).toBe(1);
    expect(freeSlots()).toBe(0);
    release();
    expect((await creating).status).toBe(200);
    expect(freeSlots()).toBe(1);
    const retried = await headers(supertest(server).post('/session')).send({
      sessionId: '44444444-4444-4444-8444-444444444444',
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(retried.status).toBe(200);
    expect(statsOf(server).coldOpens).toBeGreaterThanOrEqual(2);
    expect(statsOf(server).coldOpenStoreMs).toBeGreaterThanOrEqual(0);
  });

  it('a cap-refused create publishes nothing and leaves no opening debt', async () => {
    const server = await app(false, 'pod-a', true, { coldOpenLimit: 1 });
    let release!: () => void;
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stalled = false;
    state.appendFault = async (_journal, _records, _append) => {
      if (!stalled) {
        stalled = true;
        await stall;
      }
      return false;
    };
    const placement = {
      instanceId: 'pod-a',
      bootId: BOOT_ID,
      placementEpoch: 1,
    };
    const creating = headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: placement,
      })
      .then((response) => response);
    await vi.waitFor(
      async () => {
        expect(stalled).toBe(true);
      },
      { timeout: 5000 },
    );
    const publish = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    );
    publish.mockClear();
    const refused = await headers(supertest(server).post('/session')).send({
      sessionId: '44444444-4444-4444-8444-444444444444',
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
      harnessPlacement: placement,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_session_open_busy');
    // The refusal precedes the resource publication and the opening
    // registration, so the control plane's transient retry neither leaks
    // unreferenced resources nor inflates openingSessions until attach.
    expect(publish).not.toHaveBeenCalled();
    release();
    expect((await creating).status).toBe(200);
    // The refused Session never attaches, so any opening debt it left
    // would survive the admitted create's attach and show up here.
    const drained = await headers(
      supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
    ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
    expect(drained.body.counters.openingSessions).toBe(0);
  });

  // Drain and suspension mark in synchronous sections: a Session whose
  // suspension teardown is converging refuses the drain's ownership
  // release instead of letting both close it at once.
  it('a converging suspension refuses the drain ownership release', async () => {
    const server = await app(false, 'pod-a', true, {
      idleSuspendMs: 150,
      suspendRetryBaseMs: 10,
      suspendRetryCap: 2,
    });
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
      harnessPlacement: {
        instanceId: 'pod-a',
        bootId: BOOT_ID,
        placementEpoch: 1,
      },
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let release!: () => void;
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stalled = false;
    state.appendFault = async (_journal, records, _append) => {
      const isRelease = (
        records as Array<{
          managedSession?: { kind?: string; payload?: { phase?: string } };
        }>
      ).some(
        (record) =>
          record.managedSession?.kind === 'activation.changed' &&
          record.managedSession?.payload?.phase === 'released',
      );
      if (isRelease && !stalled) {
        stalled = true;
        await stall;
      }
      return false;
    };
    await vi.waitFor(
      async () => {
        // Probe with a read: a mutation probe would itself reset the idle
        // timer and the gate would never close.
        const probe = await statusOf(server, clientId);
        expect(probe.body.code).toBe('hosted_session_closing');
      },
      { timeout: 5000 },
    );
    const drained = await headers(
      supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
    ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
    expect(drained.body.state).toBe('QUIESCING');
    const busy = await headers(
      supertest(server).post(`/session/${SESSION_ID}/ownership:release`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ operationId: randomUUID(), placementEpoch: 1 });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('hosted_ownership_release_busy');
    release();
  });
});

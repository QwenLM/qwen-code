/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { getSessionAgentEventHub } from '../session-agents/events.js';
import { createRateLimiter, type RateLimiterInstance } from '../rate-limit.js';
import {
  readAwaitedPermissions,
  readHostAck,
  readHostEvent,
  readHostTurnResult,
  registerAgentHostTransportRoutes,
} from './agent-hosts.js';

const { heartbeat, authenticate, orchestrator, getOrchestrator, ensure } =
  vi.hoisted(() => {
    const orchestrator = {
      pickupForHost: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      renewLease: vi.fn<(...args: unknown[]) => { ok: boolean }>(),
      acceptHostEvents: vi.fn<(...args: unknown[]) => unknown>(),
      completeHostTurn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      decisionsForHost: vi.fn<(...args: unknown[]) => unknown[]>(),
      releaseHostAssignment: vi.fn<(...args: unknown[]) => boolean>(),
      ready: vi.fn(async () => {}),
    };
    return {
      heartbeat: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      authenticate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      orchestrator,
      getOrchestrator: vi.fn<() => typeof orchestrator | undefined>(),
      ensure: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    };
  });

vi.mock(
  '@qwen-code/qwen-code-core/agents/workspace-agents/store.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/agents/workspace-agents/store.js')
    >()),
    authenticateAgentHost: authenticate,
    heartbeatAgentHost: heartbeat,
  }),
);
vi.mock('../session-agents/orchestrator.js', () => ({
  getSessionAgentOrchestrator: getOrchestrator,
}));
// The session-agent routes are not registered here, so there is no factory
// to create an orchestrator on demand; lookups fall back to the mock above.
vi.mock('./session-agents.js', () => ({
  ensureSessionAgentOrchestratorForRuntime: () => undefined,
}));
vi.mock('../agent-host-program-agents.js', () => ({
  createHostProgramAgentEnsurer: () => ensure,
}));

const SECRET = 'a'.repeat(32);
const V2_HOST = {
  id: 'host',
  name: 'mac',
  workspaceCwd: '/remote',
  providers: ['qwen', 'claude'],
  programs: [
    { program: 'qwen', available: true },
    { program: 'claude', available: true, version: '2.1.0' },
    { program: 'codex', available: false, reason: 'not installed' },
  ],
  protocol: 2,
  createdAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued `mockResolvedValueOnce` values; a test that
  // left some would hand them to the next test's first call.
  for (const fn of Object.values(orchestrator)) fn.mockReset();
  authenticate.mockResolvedValue(V2_HOST);
  getOrchestrator.mockReturnValue(orchestrator);
  orchestrator.decisionsForHost.mockReturnValue([]);
  ensure.mockResolvedValue([]);
});

function setup(
  initiallyEnabled = true,
  trusted = true,
  limiters: {
    rateLimiter?: RateLimiterInstance;
    hostRateLimiter?: RateLimiterInstance;
  } = {},
) {
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd: '/work/selected',
    primary: false,
    trusted,
  } as WorkspaceRuntime;
  let active = true;
  let enabled = initiallyEnabled;
  const registry = {
    list: () => (active ? [runtime] : []),
  } as unknown as WorkspaceRegistry;
  const app = express();
  registerAgentHostTransportRoutes(
    app,
    registry,
    limiters.rateLimiter,
    () => enabled,
    limiters.hostRateLimiter,
  );
  const post = (route: string, input: unknown, hostId = 'host') =>
    request(app)
      .post(`/agent-hosts/workspace/${hostId}/${route}`)
      .set('Authorization', `AgentHost ${SECRET}`)
      .send(input as object);
  return {
    disable: () => {
      enabled = false;
    },
    remove: () => {
      active = false;
    },
    poll: (waitMs = 1_000) => post('pickup', { waitMs }),
    beat: (input: Record<string, unknown>) => post('heartbeat', input),
    events: (input: Record<string, unknown>) => post('events', input),
    result: (input: Record<string, unknown>) => post('result', input),
    decisions: (input: Record<string, unknown>) => post('decisions', input),
    post,
    app,
  };
}

function limiter(max: number): RateLimiterInstance {
  const tier = { windowMs: 60_000, max };
  return createRateLimiter({
    tiers: { prompt: tier, mutation: tier, read: tier },
    hostname: '127.0.0.1',
  });
}

const LEASE = {
  sessionId: 'session-1',
  runId: 'run-1',
  attempt: 1,
  leaseId: 'lease-1',
};

it('stores the probe, renews the listed leases and returns decisions on heartbeat', async () => {
  heartbeat.mockResolvedValue(V2_HOST);
  orchestrator.renewLease
    .mockReturnValueOnce({ ok: true })
    .mockReturnValueOnce({ ok: false });
  const decision = {
    runId: 'run-1',
    attempt: 1,
    requestId: 'p1',
    optionId: 'allow',
  };
  orchestrator.decisionsForHost.mockReturnValue([decision]);

  const response = await setup().beat({
    workspaceCwd: '/remote',
    protocol: 2,
    providers: ['qwen', 'claude'],
    programs: V2_HOST.programs,
    enrollmentToken: 'fresh-token',
    runs: [
      { runId: 'run-1', attempt: 1, leaseId: 'lease-1' },
      { runId: 'run-2', attempt: 3, leaseId: 'lease-2' },
    ],
  });

  expect(response.status).toBe(200);
  expect(heartbeat).toHaveBeenCalledWith('/work/selected', 'host', SECRET, {
    workspaceCwd: '/remote',
    providers: ['qwen', 'claude'],
    enrollmentToken: 'fresh-token',
    programs: V2_HOST.programs,
    protocol: 2,
  });
  expect(orchestrator.renewLease).toHaveBeenNthCalledWith(
    1,
    'host',
    'run-1',
    1,
    'lease-1',
  );
  expect(response.body.leases).toEqual([
    { runId: 'run-1', ok: true },
    { runId: 'run-2', ok: false },
  ]);
  expect(response.body.decisions).toEqual([decision]);
  expect(ensure).toHaveBeenCalledWith('/work/selected', V2_HOST);
});

it('reports every lease lost when the workspace has no orchestrator', async () => {
  heartbeat.mockResolvedValue(V2_HOST);
  getOrchestrator.mockReturnValue(undefined);

  const response = await setup().beat({
    workspaceCwd: '/remote',
    protocol: 2,
    providers: ['qwen'],
    runs: [{ runId: 'run-1', attempt: 1, leaseId: 'lease-1' }],
  });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    leases: [{ runId: 'run-1', ok: false }],
    decisions: [],
  });
});

it('announces auto-created agents on the workspace event stream', async () => {
  heartbeat.mockResolvedValue(V2_HOST);
  ensure.mockResolvedValue([{ id: 'ag_1', name: 'claude-mac' }]);
  const frames: unknown[] = [];
  const unsubscribe = getSessionAgentEventHub('/work/selected').subscribe(
    (frame) => frames.push(frame),
  );
  try {
    await setup().beat({
      workspaceCwd: '/remote',
      protocol: 2,
      providers: ['qwen'],
    });
    expect(frames).toContainEqual({ type: 'changed', scope: 'agents' });
  } finally {
    unsubscribe();
  }
});

it('refuses a v1 Host heartbeat with an upgrade notice and never records it', async () => {
  heartbeat.mockResolvedValue({ ...V2_HOST, protocol: undefined });

  const response = await setup().beat({
    workspaceCwd: '/remote',
    providers: ['Qwen Code ACP'],
  });

  // Not 401: a v1 Host deletes its credential on that.
  expect(response.status).toBe(426);
  expect(response.body.error).toMatch(/protocol 2.*speaks 1.*Upgrade/);
  // Its presence is not refreshed, so the roster shows it offline.
  expect(heartbeat).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
});

it('rejects a malformed program probe', async () => {
  const response = await setup().beat({
    workspaceCwd: '/remote',
    protocol: 2,
    providers: ['qwen'],
    programs: [{ program: 'vim', available: true }],
  });

  expect(response.status).toBe(400);
  expect(heartbeat).not.toHaveBeenCalled();
});

it('does not expose host work for a collaboration-disabled workspace', async () => {
  const response = await setup(false).poll();

  expect(response.status).toBe(404);
  // Byte-identical to the unknown-workspace answer, so a caller cannot tell
  // which workspaces exist.
  expect(response.body).toEqual({ error: 'Workspace not found.' });
  expect(orchestrator.pickupForHost).not.toHaveBeenCalled();
});

it('hands a v2 assignment only to a v2 Host, for the programs it offers', async () => {
  const assignment = { protocol: 2, ...LEASE, program: 'claude' };
  orchestrator.pickupForHost.mockResolvedValue(assignment);

  const response = await setup().poll();

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ assignment });
  expect(orchestrator.pickupForHost).toHaveBeenCalledWith('host', [
    'qwen',
    'claude',
  ]);
});

it('never hands work to a v1 Host', async () => {
  authenticate.mockResolvedValue({
    ...V2_HOST,
    protocol: undefined,
    programs: undefined,
    providers: ['Qwen Code ACP'],
  });

  const response = await setup().poll(0);

  expect(response.status).toBe(204);
  expect(orchestrator.pickupForHost).not.toHaveBeenCalled();
});

it('wakes an idle pickup poll when a run is queued', async () => {
  orchestrator.pickupForHost
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ protocol: 2, ...LEASE, program: 'qwen' });
  // supertest only sends once awaited; start it now.
  const response = setup()
    .poll(20_000)
    .then((answer) => answer);
  await vi.waitFor(() =>
    expect(orchestrator.pickupForHost).toHaveBeenCalledTimes(2),
  );
  // Let the poll arm its 500 ms backoff wait.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const published = Date.now();
  getSessionAgentEventHub('/work/selected').publish({
    type: 'run',
    sessionId: 'session-1',
    runId: 'run-9',
    author: { agentId: 'ag', name: 'claude-mac' },
    status: 'queued',
    activityAt: Date.now(),
  });

  expect((await response).status).toBe(200);
  expect(orchestrator.pickupForHost).toHaveBeenCalledTimes(3);
  // Well inside the ~450 ms left on the backoff timer.
  expect(Date.now() - published).toBeLessThan(300);
});

it('stops polling when collaboration is disabled', async () => {
  const { poll, disable } = setup();
  orchestrator.pickupForHost.mockResolvedValue(undefined);
  const response = poll().then((answer) => answer);
  await vi.waitFor(() =>
    expect(orchestrator.pickupForHost).toHaveBeenCalledOnce(),
  );
  disable();

  expect((await response).status).toBe(404);
});

it('stops an open pickup poll when the Host credential is revoked', async () => {
  const { poll } = setup();
  orchestrator.pickupForHost.mockResolvedValue(undefined);
  const response = poll().then((answer) => answer);
  await vi.waitFor(() =>
    expect(orchestrator.pickupForHost).toHaveBeenCalledOnce(),
  );
  authenticate.mockResolvedValue(undefined);

  const answer = await response;
  expect(answer.status).toBe(401);
  expect(answer.body).toEqual({ error: 'Invalid Agent Host credential.' });
});

it('answers a failing pickup scan as retryable 503 without detail', async () => {
  orchestrator.pickupForHost.mockRejectedValue(
    new Error('/private/coordinator/path is broken'),
  );

  const response = await setup().poll(0);

  expect(response.status).toBe(503);
  expect(JSON.stringify(response.body)).not.toContain('/private');
});

it('folds a valid event batch and returns pending decisions', async () => {
  orchestrator.acceptHostEvents.mockReturnValue({
    ok: true,
    leaseExpiresAt: 99,
  });
  const decision = {
    runId: 'run-1',
    attempt: 1,
    requestId: 'p1',
    optionId: 'allow',
  };
  orchestrator.decisionsForHost.mockReturnValue([decision]);
  const batch = {
    ...LEASE,
    sequence: 1,
    events: [
      { type: 'text_delta', text: 'hello' },
      {
        type: 'permission_request',
        prompt: {
          requestId: 'p1',
          title: 'Run ls',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
    ],
  };

  const response = await setup().events(batch);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ok: true,
    leaseExpiresAt: 99,
    decisions: [decision],
  });
  expect(orchestrator.acceptHostEvents).toHaveBeenCalledWith('host', batch);
});

it('answers a stale lease on events with 409', async () => {
  orchestrator.acceptHostEvents.mockReturnValue({
    ok: false,
    reason: 'lease_mismatch',
  });

  const response = await setup().events({ ...LEASE, sequence: 2, events: [] });

  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: 'lease_mismatch' });
});

it('refuses a batch carrying an unknown event', async () => {
  const response = await setup().events({
    ...LEASE,
    sequence: 1,
    events: [{ type: 'shell', command: 'rm -rf /' }],
  });

  expect(response.status).toBe(400);
  expect(orchestrator.acceptHostEvents).not.toHaveBeenCalled();
});

it('completes a turn with the native session id', async () => {
  orchestrator.completeHostTurn.mockResolvedValue({ ok: true });
  const input = {
    ...LEASE,
    result: {
      status: 'completed',
      outputText: 'done',
      nativeSessionId: 'claude-session-1',
      totalTokens: 12,
    },
  };

  const response = await setup().result(input);

  expect(response.status).toBe(200);
  expect(orchestrator.completeHostTurn).toHaveBeenCalledWith('host', input);
});

it('answers a stale result with 409 and a failing one with 503', async () => {
  const { result } = setup();
  const input = {
    ...LEASE,
    result: { status: 'failed', outputText: '', error: 'boom' },
  };
  orchestrator.completeHostTurn.mockResolvedValueOnce({
    ok: false,
    reason: 'unknown_run',
  });
  expect((await result(input)).status).toBe(409);

  orchestrator.completeHostTurn.mockRejectedValueOnce(
    new Error('/private/path'),
  );
  const failed = await result(input);
  expect(failed.status).toBe(503);
  expect(JSON.stringify(failed.body)).not.toContain('/private');
});

it('refuses untrusted workspaces on every transport route', async () => {
  const app = setup(true, false);
  const responses = await Promise.all([
    app.poll(0),
    app.beat({ workspaceCwd: '/remote', protocol: 2, providers: ['qwen'] }),
    app.events({ ...LEASE, sequence: 1, events: [] }),
    app.result({ ...LEASE, result: { status: 'completed', outputText: '' } }),
    app.decisions({ waitMs: 0, awaiting: [] }),
  ]);

  for (const response of responses) expect(response.status).not.toBe(200);
  expect(heartbeat).not.toHaveBeenCalled();
  expect(orchestrator.pickupForHost).not.toHaveBeenCalled();
  expect(orchestrator.acceptHostEvents).not.toHaveBeenCalled();
  expect(orchestrator.completeHostTurn).not.toHaveBeenCalled();
  expect(orchestrator.decisionsForHost).not.toHaveBeenCalled();
});

it('directs a valid replacement token to enrollment instead of consuming it as a heartbeat', async () => {
  heartbeat.mockRejectedValue(
    new Error('Agent Host replacement requires enrollment.'),
  );

  const response = await setup().beat({
    workspaceCwd: '/remote',
    protocol: 2,
    providers: ['qwen'],
    enrollmentToken: 'replacement-token',
  });

  expect(response.status).toBe(409);
  expect(response.body).toEqual({
    error: 'Agent Host replacement requires enrollment.',
  });
});

it('validates Host events and results field by field', () => {
  expect(readHostEvent({ type: 'usage', totalTokens: 5 })).toEqual({
    type: 'usage',
    totalTokens: 5,
  });
  expect(readHostEvent({ type: 'usage', totalTokens: -1 })).toBeUndefined();
  expect(readHostEvent({ type: 'session_send', text: '   ' })).toBeUndefined();
  expect(
    readHostEvent({
      type: 'step',
      step: { id: 's', title: 'Read', status: 'done' },
    }),
  ).toBeUndefined();
  expect(
    readHostTurnResult({
      ...LEASE,
      result: {
        status: 'completed',
        outputText: 'x',
        error: 'e'.repeat(9_000),
      },
    })?.result.error,
  ).toHaveLength(4_096);
  expect(
    readHostTurnResult({
      ...LEASE,
      result: { status: 'running', outputText: '' },
    }),
  ).toBeUndefined();
});

it('clips over-long display text instead of refusing the event', () => {
  // A qwen shell permission's title is the raw command; refusing it would
  // drop the whole batch and leave the turn waiting on an unasked question.
  const event = readHostEvent({
    type: 'permission_request',
    prompt: {
      requestId: 'p',
      title: 'x'.repeat(5_000),
      inputPreview: 'i'.repeat(20_000),
      options: [{ optionId: 'a', name: 'n'.repeat(500), kind: 'allow_once' }],
    },
  });
  if (event?.type !== 'permission_request') {
    throw new Error('Expected a permission request event');
  }
  expect(event.prompt.title).toHaveLength(1_200);
  expect(event.prompt.inputPreview).toHaveLength(16_384);
  expect(event.prompt.options[0]!.name).toHaveLength(256);
  expect(
    readHostEvent({
      type: 'step',
      step: { id: 's', title: 't'.repeat(5_000), status: 'running' },
    }),
  ).toEqual({
    type: 'step',
    step: { id: 's', title: 't'.repeat(1_200), status: 'running' },
  });
  // Structure is still refused.
  expect(
    readHostEvent({
      type: 'permission_request',
      prompt: { requestId: 'p', title: 7, options: [] },
    }),
  ).toBeUndefined();
});

it('reads a cancellation from either ack shape', () => {
  expect(readHostAck({ ok: false, reason: 'cancelled' })).toEqual({
    ok: false,
    reason: 'cancelled',
    cancelled: true,
  });
  expect(readHostAck({ ok: true, cancelled: true })).toEqual({
    ok: false,
    cancelled: true,
  });
  expect(readHostAck({ ok: false, reason: 'lease_mismatch' })).toEqual({
    ok: false,
    reason: 'lease_mismatch',
    cancelled: false,
  });
  expect(readHostAck(undefined)).toEqual({ ok: false, cancelled: false });
});

it('reports a cancelled run in the heartbeat leases', async () => {
  heartbeat.mockResolvedValue(V2_HOST);
  orchestrator.renewLease
    .mockReturnValueOnce({ ok: false, reason: 'cancelled' } as never)
    .mockReturnValueOnce({ ok: true, cancelled: true } as never)
    .mockReturnValueOnce({ ok: true });

  const response = await setup().beat({
    workspaceCwd: '/remote',
    protocol: 2,
    providers: ['qwen'],
    runs: [
      { runId: 'run-1', attempt: 1, leaseId: 'lease-1' },
      { runId: 'run-2', attempt: 1, leaseId: 'lease-2' },
      { runId: 'run-3', attempt: 1, leaseId: 'lease-3' },
    ],
  });

  expect(response.body.leases).toEqual([
    { runId: 'run-1', ok: false, cancelled: true },
    { runId: 'run-2', ok: false, cancelled: true },
    { runId: 'run-3', ok: true },
  ]);
});

it('answers events and results of a cancelled run with 409 cancelled', async () => {
  const app = setup();
  orchestrator.acceptHostEvents.mockReturnValue({
    ok: false,
    reason: 'cancelled',
  });
  const events = await app.events({ ...LEASE, sequence: 1, events: [] });
  expect(events.status).toBe(409);
  expect(events.body).toEqual({ error: 'cancelled', cancelled: true });

  orchestrator.completeHostTurn.mockResolvedValue({
    ok: false,
    reason: 'unknown_run',
    cancelled: true,
  });
  const result = await app.result({
    ...LEASE,
    result: { status: 'completed', outputText: 'late' },
  });
  expect(result.status).toBe(409);
  expect(result.body).toEqual({ error: 'unknown_run', cancelled: true });
});

it('gives a claimed turn back when the Host hung up before it was written', async () => {
  const assignment = { protocol: 2, ...LEASE, program: 'claude' };
  orchestrator.pickupForHost.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return assignment;
  });

  await expect(setup().poll(1_000).timeout(100)).rejects.toThrow();

  await vi.waitFor(() =>
    expect(orchestrator.releaseHostAssignment).toHaveBeenCalledWith('host', {
      sessionId: 'session-1',
      runId: 'run-1',
      attempt: 1,
      leaseId: 'lease-1',
    }),
  );
});

it('does not release a turn the Host received', async () => {
  orchestrator.pickupForHost.mockResolvedValue({
    protocol: 2,
    ...LEASE,
    program: 'claude',
  });

  expect((await setup().poll()).status).toBe(200);
  expect(orchestrator.releaseHostAssignment).not.toHaveBeenCalled();
});

const P1 = { runId: 'run-1', attempt: 1, requestId: 'p1' };
const P2 = { runId: 'run-1', attempt: 1, requestId: 'p2' };

it('answers a decisions poll with unused decisions for awaited requests only', async () => {
  const used = { ...P1, optionId: 'allow', decisionId: 'd1' };
  const fresh = { ...P2, optionId: 'deny' };
  const other = { ...P1, runId: 'run-9', optionId: 'allow' };
  orchestrator.decisionsForHost.mockReturnValue([used, fresh, other]);

  const response = await setup().decisions({
    waitMs: 1_000,
    awaiting: [
      { ...P1, seen: ['id:d1'] },
      { ...P2, seen: [] },
    ],
  });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ decisions: [fresh] });
  expect(orchestrator.decisionsForHost).toHaveBeenCalledWith('host');
});

it('takes a second answer for a re-armed request', async () => {
  orchestrator.decisionsForHost.mockReturnValue([
    { ...P1, optionId: 'allow', decisionId: 'd2' },
  ]);

  const response = await setup().decisions({
    waitMs: 0,
    awaiting: [{ ...P1, seen: ['id:d1'] }],
  });

  expect(response.body.decisions).toHaveLength(1);
});

it('wakes a decisions poll when this Host gets a decision', async () => {
  orchestrator.decisionsForHost.mockReturnValue([]);
  const response = setup()
    .decisions({
      waitMs: 20_000,
      awaiting: [{ ...P1, seen: [] }],
    })
    .then((answer) => answer);
  await vi.waitFor(() =>
    expect(orchestrator.decisionsForHost).toHaveBeenCalled(),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const decision = { ...P1, optionId: 'allow' };
  orchestrator.decisionsForHost.mockReturnValue([decision]);
  const published = Date.now();
  getSessionAgentEventHub('/work/selected').publish({
    type: 'run',
    sessionId: 'session-1',
    runId: 'run-1',
    author: { agentId: 'ag', name: 'claude-mac', runtimeId: 'host' },
    status: 'awaiting_approval',
    activityAt: Date.now(),
  });

  const answer = await response;
  expect(answer.body).toEqual({ decisions: [decision] });
  // Well inside the 1 s backstop scan.
  expect(Date.now() - published).toBeLessThan(500);
});

it('answers an empty decisions poll at its deadline and refuses a malformed one', async () => {
  const app = setup();
  const empty = await app.decisions({
    waitMs: 0,
    awaiting: [{ ...P1, seen: [] }],
  });
  expect(empty.body).toEqual({ decisions: [] });

  const malformed = await app.decisions({
    waitMs: 0,
    awaiting: [{ ...P1, seen: 'id:d1' }],
  });
  expect(malformed.status).toBe(400);
  expect(readAwaitedPermissions([{ ...P1, attempt: 0 }])).toBeUndefined();
  expect(readAwaitedPermissions([P1])).toEqual([{ ...P1, seen: [] }]);
});

it('throttles Host traffic per authenticated Host, not by the general read tier', async () => {
  orchestrator.acceptHostEvents.mockReturnValue({ ok: true });
  const general = limiter(1);
  const perHost = limiter(3);
  const app = setup(true, true, {
    rateLimiter: general,
    hostRateLimiter: perHost,
  });
  const batch = (sequence: number) => ({ ...LEASE, sequence, events: [] });
  try {
    for (let sequence = 1; sequence <= 3; sequence++) {
      expect((await app.events(batch(sequence))).status).toBe(200);
    }
    const throttled = await app.events(batch(4));
    expect(throttled.status).toBe(429);
    expect(throttled.body).toMatchObject({ tier: 'agent-host' });
    // Another Host has its own budget.
    expect((await app.post('events', batch(1), 'host-2')).status).toBe(200);
  } finally {
    general.dispose();
    perHost.dispose();
  }
});

it('throttles failed Host authentication per source', async () => {
  authenticate.mockResolvedValue(undefined);
  const general = limiter(1);
  const app = setup(true, true, { rateLimiter: general });
  try {
    const first = await app.events({ ...LEASE, sequence: 1, events: [] });
    expect(first.status).toBe(401);
    const second = await app.events({ ...LEASE, sequence: 1, events: [] });
    expect(second.status).toBe(429);
    expect(orchestrator.acceptHostEvents).not.toHaveBeenCalled();
  } finally {
    general.dispose();
  }
});

it('throttles refusals before authentication per source', async () => {
  const general = limiter(1);
  const app = setup(true, true, { rateLimiter: general });
  try {
    // Malformed: no credential, no workspaceCwd.
    const first = await request(app.app)
      .post('/agent-hosts/workspace/host/heartbeat')
      .send({});
    expect(first.status).toBe(401);
    // Same source probing for workspaces: the budget is already spent.
    const second = await request(app.app)
      .post('/agent-hosts/elsewhere/host/pickup')
      .set('Authorization', `AgentHost ${SECRET}`)
      .send({ waitMs: 0 });
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ tier: 'read' });
    expect(heartbeat).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  } finally {
    general.dispose();
  }
});

it('answers an unknown workspace with 404 while the source has budget', async () => {
  const general = limiter(5);
  const app = setup(true, true, { rateLimiter: general });
  try {
    const response = await request(app.app)
      .post('/agent-hosts/elsewhere/host/events')
      .set('Authorization', `AgentHost ${SECRET}`)
      .send({ ...LEASE, sequence: 1, events: [] });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Workspace not found.' });
    expect(authenticate).not.toHaveBeenCalled();
  } finally {
    general.dispose();
  }
});

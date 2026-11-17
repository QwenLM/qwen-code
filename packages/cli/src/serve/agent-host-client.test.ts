/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AgentAdapterTurnInput,
  HostTurnAssignment,
  HostTurnEventBatch,
  HostTurnResult,
  SessionAgentPermissionPrompt,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  isAgentHostConnectionRunning,
  isCancellation,
  isRevocation,
  MAX_CONCURRENT_HOST_TURNS,
  sessionSendServerFor,
  startAgentHostConnection,
  stopAgentHostConnection,
} from './agent-host-client.js';
import {
  decisionsForAwaited,
  type HostAwaitedPermission,
  type HostDecision,
} from './agent-host-decisions.js';
import {
  AGENT_HOST_ALREADY_ENROLLED,
  AGENT_HOST_CREDENTIAL_REJECTED,
  AGENT_HOST_ENROLLMENT_REFUSED,
  AGENT_HOST_ENROLLMENT_UNAVAILABLE,
  AGENT_HOST_REPLACEMENT_REQUIRED,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';

const { getAdapter, openRelay, hasRelay } = vi.hoisted(() => ({
  getAdapter: vi.fn<(...args: unknown[]) => AgentAdapter>(),
  openRelay: vi.fn<(...args: unknown[]) => unknown>(),
  hasRelay: { value: true },
}));

vi.mock('./agent-host-programs.js', () => ({
  getHostProgramProbe: async () => [
    { program: 'qwen', available: true },
    { program: 'claude', available: true, version: '2.1.0' },
    { program: 'codex', available: false, reason: 'not installed' },
  ],
  availablePrograms: (probes: Array<{ program: string; available: boolean }>) =>
    probes.filter((probe) => probe.available).map((probe) => probe.program),
}));
vi.mock('./session-agents/adapters/index.js', () => ({ getAdapter }));
// Passed through; some cases fail reading the saved enrollment secret or
// saving the credential.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
  };
});
vi.mock('./agent-host-relay.js', () => ({
  openAgentHostRelayRun: openRelay,
  hasAgentHostRelay: () => hasRelay.value,
}));
// A remote qwen turn writes a Host-local session-agents binding first; keep
// that off the real agent store in these tests.
vi.mock(
  '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js',
  () => ({ updateSessionAgents: vi.fn(async () => ({})) }),
);

function assignment(
  runId: string,
  overrides: Partial<HostTurnAssignment> = {},
): HostTurnAssignment {
  return {
    protocol: 2,
    sessionId: 'chat-1',
    runId,
    attempt: 1,
    leaseId: `lease-${runId}`,
    leaseExpiresAt: Date.now() + 60_000,
    agent: { agentId: 'ag_claude', name: 'claude-mac', program: 'claude' },
    program: 'claude',
    prompt: 'Look at the bug.',
    ...overrides,
  };
}

/**
 * A fake coordinator: enroll, heartbeat (leases ok unless cancelled),
 * pickup from a queue (then idle 204s), a decisions long-poll filtered like
 * the real route, events and result recorded.
 */
function fakeCoordinator(queue: HostTurnAssignment[]) {
  const batches: HostTurnEventBatch[] = [];
  const results: HostTurnResult[] = [];
  const heartbeats: Array<Record<string, unknown>> = [];
  const decisionPolls: Array<{ awaiting: HostAwaitedPermission[] }> = [];
  const state: {
    eventStatus: number;
    /** Answer events (and results) with 409 `{cancelled: true}`. */
    cancelled: boolean;
    /** runIds the heartbeat reports cancelled. */
    cancelledLeases: Set<string>;
    decisions: HostDecision[];
  } = {
    eventStatus: 200,
    cancelled: false,
    cancelledLeases: new Set(),
    decisions: [],
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.endsWith('/enroll')) {
      return Response.json({ host: { id: 'host-1' }, secret: 's'.repeat(43) });
    }
    if (url.endsWith('/heartbeat')) {
      heartbeats.push(body);
      return Response.json({
        host: { id: 'host-1' },
        leases: (body.runs ?? []).map((run: { runId: string }) =>
          state.cancelledLeases.has(run.runId)
            ? { runId: run.runId, ok: false, cancelled: true }
            : { runId: run.runId, ok: true },
        ),
        decisions: state.decisions,
      });
    }
    if (url.endsWith('/decisions')) {
      decisionPolls.push(body);
      const deadline = Date.now() + 2_000;
      for (;;) {
        if (init?.signal?.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        const found = decisionsForAwaited(state.decisions, body.awaiting);
        if (found.length > 0 || Date.now() > deadline) {
          return Response.json({ decisions: found });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const runRoute = url.endsWith('/events') || url.endsWith('/result');
    if (state.cancelled && runRoute) {
      if (url.endsWith('/result')) results.push(body);
      return Response.json(
        { error: 'cancelled', cancelled: true },
        { status: 409 },
      );
    }
    if (url.endsWith('/pickup')) {
      const next = queue.shift();
      if (next) return Response.json({ assignment: next });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/events')) {
      if (state.eventStatus !== 200) {
        return Response.json(
          { error: 'lease_mismatch' },
          { status: state.eventStatus },
        );
      }
      batches.push(body);
      return Response.json({ ok: true, decisions: state.decisions });
    }
    if (url.endsWith('/result')) {
      results.push(body);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  });
  return { fetchMock, batches, results, heartbeats, decisionPolls, state };
}

/** Set `getAdapter` before calling: the first pickup runs immediately. */
async function withHost(
  coordinator: ReturnType<typeof fakeCoordinator>,
  body: (workspaceCwd: string) => Promise<void>,
) {
  const qwenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'host-v2-'));
  vi.stubEnv('QWEN_HOME', qwenHome);
  vi.stubGlobal('fetch', coordinator.fetchMock);
  const target = {
    serverUrl: 'http://127.0.0.1:18590',
    workspaceId: 'ws-test',
    workspaceCwd: qwenHome,
  };
  try {
    await startAgentHostConnection({
      ...target,
      bridge: {} as AcpSessionBridge,
      enrollmentToken: 'join-token',
    });
    await body(qwenHome);
  } finally {
    stopAgentHostConnection(target);
    getAdapter.mockReset();
    openRelay.mockReset();
    hasRelay.value = true;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(qwenHome, { recursive: true, force: true });
  }
}

describe('isRevocation', () => {
  // The transport error carries the route's body text as its message.
  const withStatus = (status: number, message: string) =>
    Object.assign(new Error(message), { status });

  it('matches the route 401 credential rejection', () => {
    expect(
      isRevocation(withStatus(401, 'Invalid Agent Host credential.')),
    ).toBe(true);
  });

  it('does not match the bearer gate 401 seen during a coordinator restart', () => {
    expect(isRevocation(withStatus(401, 'Unauthorized'))).toBe(false);
  });

  it('does not match a 401 with any other body', () => {
    expect(isRevocation(withStatus(401, 'Invalid Host header'))).toBe(false);
  });

  it('does not match non-401 statuses', () => {
    expect(
      isRevocation(withStatus(403, 'Invalid Agent Host credential.')),
    ).toBe(false);
    expect(isRevocation(withStatus(503, 'Agent Host store busy.'))).toBe(false);
  });

  it('does not match plain network failures', () => {
    expect(isRevocation(new TypeError('fetch failed'))).toBe(false);
    expect(isRevocation(undefined)).toBe(false);
  });
});

it('runs a v2 turn through the adapter, round-trips a permission and returns the native session id', async () => {
  const prompt: SessionAgentPermissionPrompt = {
    requestId: 'perm-1',
    title: 'Bash: ls',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  };
  let input: AgentAdapterTurnInput | undefined;
  const coordinator = fakeCoordinator([
    assignment('run-1', {
      nativeSessionId: 'claude-0',
      freshPrompt: 'The whole conversation.',
    }),
  ]);
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn(turn) {
      input = turn;
      turn.onEvent({ type: 'text_delta', text: 'Looking' });
      turn.onEvent({ type: 'permission_request', prompt });
      // The person answers; the coordinator hands the decision back.
      coordinator.state.decisions = [
        { runId: 'run-1', attempt: 1, requestId: 'perm-1', optionId: 'allow' },
      ];
      const optionId = await turn.awaitPermission(prompt);
      turn.onEvent({ type: 'permission_resolved', requestId: 'perm-1' });
      turn.onEvent({ type: 'session_send', text: '@codex-mac have a look' });
      return {
        status: 'completed',
        outputText: `chose ${optionId}`,
        nativeSessionId: 'claude-1',
      };
    },
  });
  await withHost(coordinator, async (workspaceCwd) => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1), {
      timeout: 5_000,
    });

    expect(getAdapter).toHaveBeenCalledWith('claude', {
      workspaceCwd,
      bridge: expect.anything(),
      agentId: 'ag_claude',
    });
    expect(input).toMatchObject({
      prompt: 'Look at the bug.',
      // Sent instead of `prompt` if the program refuses the resume.
      freshPrompt: 'The whole conversation.',
      nativeSessionId: 'claude-0',
      cwd: workspaceCwd,
    });
    expect(coordinator.results[0]).toEqual({
      sessionId: 'chat-1',
      runId: 'run-1',
      attempt: 1,
      leaseId: 'lease-run-1',
      result: {
        status: 'completed',
        outputText: 'chose allow',
        nativeSessionId: 'claude-1',
      },
    });
    // Ordered, gap-free batches carrying every event before the result.
    const sequences = coordinator.batches.map((batch) => batch.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(
      coordinator.batches
        .flatMap((batch) => batch.events)
        .map((event) => event.type),
    ).toEqual([
      'text_delta',
      'permission_request',
      'permission_resolved',
      'session_send',
    ]);
    expect(coordinator.heartbeats[0]).toMatchObject({
      protocol: 2,
      providers: ['qwen', 'claude'],
    });
  });
});

it(`runs at most ${MAX_CONCURRENT_HOST_TURNS} turns at once`, async () => {
  const queue = Array.from({ length: MAX_CONCURRENT_HOST_TURNS + 1 }, (_, i) =>
    assignment(`run-${i}`, { sessionId: `chat-${i}` }),
  );
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const coordinator = fakeCoordinator(queue);
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn() {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return { status: 'completed', outputText: 'ok' };
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() =>
      expect(releases).toHaveLength(MAX_CONCURRENT_HOST_TURNS),
    );
    // The fifth waits for a free slot.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(releases).toHaveLength(MAX_CONCURRENT_HOST_TURNS);
    releases[0]!();
    await vi.waitFor(() =>
      expect(releases).toHaveLength(MAX_CONCURRENT_HOST_TURNS + 1),
    );
    for (const release of releases) release();
    await vi.waitFor(() =>
      expect(coordinator.results).toHaveLength(MAX_CONCURRENT_HOST_TURNS + 1),
    );
    expect(peak).toBe(MAX_CONCURRENT_HOST_TURNS);
  });
});

it('aborts a turn whose lease the coordinator refuses and posts no result', async () => {
  let aborted = false;
  const coordinator = fakeCoordinator([assignment('run-1')]);
  coordinator.state.eventStatus = 409;
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn(turn) {
      turn.onEvent({ type: 'text_delta', text: 'working' });
      await new Promise<void>((resolve) =>
        turn.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      aborted = true;
      return { status: 'cancelled', outputText: '' };
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(coordinator.results).toEqual([]);
  });
});

it('reports an adapter that throws as a failed turn', async () => {
  const coordinator = fakeCoordinator([assignment('run-1')]);
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn() {
      throw new Error('claude: command not found');
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    expect(coordinator.results[0]!.result).toEqual({
      status: 'failed',
      outputText: '',
      error: 'claude: command not found',
    });
  });
});

it('reports the provider detail of a JSON-RPC error a turn rejects with', async () => {
  const coordinator = fakeCoordinator([assignment('run-1')]);
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn() {
      // The ACP SDK's RequestError: an Error carrying JSON-RPC `data`.
      throw Object.assign(new Error('Internal error'), {
        code: -32603,
        data: { details: '400 PROVIDER_400_READABLE_CAUSE' },
      });
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    expect(coordinator.results[0]!.result).toEqual({
      status: 'failed',
      outputText: '',
      error: '400 PROVIDER_400_READABLE_CAUSE',
    });
  });
});

it('plans the qwen hidden session id when the coordinator has none', async () => {
  let nativeSessionId: string | undefined;
  const coordinator = fakeCoordinator([
    assignment('run-1', { program: 'qwen' }),
  ]);
  getAdapter.mockReturnValue({
    program: 'qwen',
    async runTurn(turn) {
      nativeSessionId = turn.nativeSessionId;
      return { status: 'completed', outputText: 'ok' };
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    expect(nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

it('keeps a qwen binding relay across its run and closes it with the connection', async () => {
  const closed: string[] = [];
  openRelay.mockImplementation((runId: unknown) => ({
    url: `http://127.0.0.1:1/agent-host-relay/runs/${String(runId)}/send`,
    token: 'tok',
    close: () => closed.push(String(runId)),
  }));
  const coordinator = fakeCoordinator([
    assignment('run-1', { program: 'qwen' }),
  ]);
  getAdapter.mockImplementation((_program, options) => ({
    program: 'qwen',
    async runTurn() {
      (
        options as { sessionSend?: { rotate(): unknown } }
      ).sessionSend?.rotate();
      return { status: 'completed', outputText: 'ok' };
    },
  }));
  await withHost(coordinator, async (workspaceCwd) => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    expect(openRelay).toHaveBeenCalledTimes(1);
    const relayId = String(openRelay.mock.calls[0]![0]);
    expect(relayId).toMatch(/^qs-/);
    // The hidden session outlives the run, so its relay does too.
    expect(closed).toEqual([]);
    stopAgentHostConnection({
      serverUrl: 'http://127.0.0.1:18590',
      workspaceId: 'ws-test',
      workspaceCwd,
    });
    await vi.waitFor(() => expect(closed).toEqual([relayId]));
  });
});

it('keeps a qwen binding current on a daemon that can offer no relay', async () => {
  hasRelay.value = false;
  openRelay.mockReturnValue(undefined);
  const current: unknown[] = [];
  const coordinator = fakeCoordinator([
    assignment('run-1', { program: 'qwen' }),
  ]);
  getAdapter.mockImplementation((_program, options) => ({
    program: 'qwen',
    async runTurn() {
      const send = (
        options as {
          sessionSend?: { rotate(): unknown; isCurrent(): boolean };
        }
      ).sessionSend;
      send?.rotate();
      // No token was ever issued, so none can be stale: reusing the hidden
      // session must not be refused on every turn.
      current.push(send?.isCurrent());
      return { status: 'completed', outputText: 'ok' };
    },
  }));
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    expect(current).toEqual([true]);
  });
});

it('builds the session_send MCP command from a relay run', () => {
  vi.stubEnv('QWEN_CLI_ENTRY', '/opt/qwen/cli.js');
  try {
    const server = sessionSendServerFor({
      url: 'http://127.0.0.1:4170/agent-host-relay/runs/run-1/send',
      token: 'tok',
    });
    expect(server?.command).toBe(process.execPath);
    expect(server?.args.slice(-5)).toEqual([
      '/opt/qwen/cli.js',
      'agents',
      'session-send-mcp',
      '--url',
      'http://127.0.0.1:4170/agent-host-relay/runs/run-1/send',
    ]);
    expect(server?.env).toEqual({ QWEN_SESSION_SEND_TOKEN: 'tok' });
    expect(sessionSendServerFor(undefined)).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

/** The files a Host keeps for one connection under `qwenHome`. */
function hostFiles(
  qwenHome: string,
  serverUrl: string,
  workspaceId: string,
  workspaceCwd: string,
) {
  const key = createHash('sha256')
    .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
    .digest('hex');
  const dir = path.join(qwenHome, 'agent-hosts');
  return {
    credential: path.join(dir, `${key}.v2.json`),
    enrolling: path.join(dir, `${key}.enrolling.json`),
  };
}

/** How a saved enrollment secret names the token it was saved for. */
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const readJson = async (file: string) =>
  JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

describe('enrolling', () => {
  const serverUrl = 'http://127.0.0.1:18591';
  const workspaceId = 'ws-enroll';
  const workspaceCwd = '/enroll-test';
  const target = { serverUrl, workspaceId, workspaceCwd };

  /**
   * A coordinator that answers enrollment with `enroll` and every other
   * route as a quiet one; `sent` collects the secrets enrollments carried.
   */
  async function withCoordinator(
    enroll: (secret: string, url: string) => Promise<Response> | Response,
    body: (
      files: ReturnType<typeof hostFiles>,
      sent: string[],
    ) => Promise<void>,
    routes: (
      url: string,
      input: Record<string, unknown>,
    ) => Response | Promise<Response> | undefined = () => undefined,
  ) {
    const qwenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'host-enroll-'));
    const sent: string[] = [];
    vi.stubEnv('QWEN_HOME', qwenHome);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const input = init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : {};
        const answer = await routes(url, input);
        if (answer) return answer;
        if (url.endsWith('/enroll')) {
          sent.push(input['secret'] as string);
          return enroll(input['secret'] as string, url);
        }
        if (url.endsWith('/pickup')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(null, { status: 204 });
        }
        return Response.json({
          host: { id: 'host-1' },
          leases: [],
          decisions: [],
        });
      }),
    );
    try {
      await body(
        hostFiles(qwenHome, serverUrl, workspaceId, workspaceCwd),
        sent,
      );
    } finally {
      stopAgentHostConnection(target);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await fs.rm(qwenHome, { recursive: true, force: true });
    }
  }

  const connect = () =>
    startAgentHostConnection({
      ...target,
      bridge: {} as AcpSessionBridge,
      enrollmentToken: 'join-token',
    });

  it('saves its secret before enrolling, and completes an enrollment whose answer was lost', async () => {
    let answerLost = true;
    await withCoordinator(
      async (secret) => {
        if (answerLost) {
          // The coordinator enrolled the Host, and the answer never came.
          answerLost = false;
          throw new TypeError('fetch failed');
        }
        // As the coordinator answers a repeat of an enrollment it took.
        return Response.json({ host: { id: 'host-1' }, secret });
      },
      async (files, sent) => {
        await expect(connect()).rejects.toThrow('fetch failed');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: sent[0],
          tokenHashes: [tokenHash('join-token')],
        });
        await expect(fs.access(files.credential)).rejects.toThrow();

        await connect();

        expect(sent).toEqual([sent[0], sent[0]]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'host-1',
          secret: sent[0],
        });
        await expect(fs.access(files.enrolling)).rejects.toThrow();
      },
    );
  });

  it('keeps the secret an older coordinator minted, and drops its own', async () => {
    await withCoordinator(
      () => Response.json({ host: { id: 'host-1' }, secret: 'm'.repeat(43) }),
      async (files, sent) => {
        await connect();

        expect(sent).toHaveLength(1);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'host-1',
          secret: 'm'.repeat(43),
        });
        await expect(fs.access(files.enrolling)).rejects.toThrow();
      },
    );
  });

  it('makes a new secret after a revocation, not the one the revoked credential held', async () => {
    const saved = 'o'.repeat(43);
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'host-2' }, secret }),
      async (files, sent) => {
        // A finished enrollment whose secret file stayed behind; the
        // coordinator has since revoked that Host.
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'old',
            secret: saved,
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: saved }),
        );

        await connect();

        expect(sent).toHaveLength(1);
        expect(sent[0]).not.toBe(saved);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'host-2',
          secret: sent[0],
        });
      },
      (url) =>
        url.includes('/old/')
          ? Response.json(
              { error: AGENT_HOST_CREDENTIAL_REJECTED },
              { status: 401 },
            )
          : undefined,
    );
  });

  it('makes a new secret for a Replace when its saved credential holds the saved one', async () => {
    const saved = 'o'.repeat(43);
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'replacement' }, secret }),
      async (files, sent) => {
        // A finished enrollment whose secret file stayed behind.
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'old',
            secret: saved,
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: saved }),
        );

        await connect();

        expect(sent).toHaveLength(1);
        expect(sent[0]).not.toBe(saved);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'replacement',
          secret: sent[0],
        });
      },
      (url, input) =>
        url.includes('/old/') && input['enrollmentToken']
          ? Response.json(
              { error: AGENT_HOST_REPLACEMENT_REQUIRED },
              { status: 409 },
            )
          : undefined,
    );
  });

  it('drops its saved secret when the coordinator refuses the enrollment', async () => {
    await withCoordinator(
      () =>
        Response.json(
          { error: AGENT_HOST_ENROLLMENT_REFUSED },
          { status: 401 },
        ),
      async (files, sent) => {
        await expect(connect()).rejects.toThrow(AGENT_HOST_ENROLLMENT_REFUSED);

        // Nothing holds it: a failed join leaves no identity behind.
        expect(sent).toHaveLength(1);
        await expect(fs.access(files.enrolling)).rejects.toThrow();
      },
    );
  });

  it.each([
    // A bare 401 from a coordinator still starting says nothing about it.
    ['a bare 401', 401, 'Unauthorized'],
    // A busy or failing store says nothing of an earlier attempt either.
    [
      'an enrollment that did not complete',
      503,
      AGENT_HOST_ENROLLMENT_UNAVAILABLE,
    ],
  ])('keeps its saved secret through %s', async (_label, status, error) => {
    await withCoordinator(
      () => Response.json({ error }, { status }),
      async (files, sent) => {
        await expect(connect()).rejects.toThrow(error);

        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: sent[0],
          tokenHashes: [tokenHash('join-token')],
        });
      },
    );
  });

  it('makes a new secret for a Replace when its saved one is already enrolled', async () => {
    const stranded = 's'.repeat(43);
    await withCoordinator(
      (secret) =>
        secret === stranded
          ? Response.json(
              { error: AGENT_HOST_ALREADY_ENROLLED },
              { status: 409 },
            )
          : Response.json({ host: { id: 'replacement' }, secret }),
      async (files, sent) => {
        // An earlier join's answer was lost, and that Host stayed enrolled.
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );

        await connect();

        expect(sent).toHaveLength(2);
        expect(sent[0]).toBe(stranded);
        expect(sent[1]).not.toBe(stranded);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'replacement',
          secret: sent[1],
        });
        await expect(fs.access(files.enrolling)).rejects.toThrow();
      },
    );
  });

  it('keeps a revoked credential while its enrollment secret cannot be dropped', async () => {
    const saved = 'o'.repeat(43);
    let rejected = 0;
    await withCoordinator(
      () => Response.json({ error: 'unexpected' }, { status: 500 }),
      async (files) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'old',
            secret: saved,
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: saved }),
        );
        // Another process holds the secret file's lock.
        const release = await lockfile.lock(files.enrolling, {
          realpath: false,
        });
        try {
          await startAgentHostConnection({
            ...target,
            bridge: {} as AcpSessionBridge,
          });
          await vi.waitFor(() => expect(rejected).toBeGreaterThan(0));
          await new Promise((resolve) => setTimeout(resolve, 1_500));

          // The credential stays for the next attempt to drop both.
          await expect(fs.access(files.credential)).resolves.toBeUndefined();
          await expect(readJson(files.enrolling)).resolves.toMatchObject({
            secret: saved,
          });
        } finally {
          await release();
        }
      },
      (url) => {
        if (!url.endsWith('/pickup')) return undefined;
        rejected++;
        return Response.json(
          { error: AGENT_HOST_CREDENTIAL_REJECTED },
          { status: 401 },
        );
      },
    );
  });

  it('drops a revoked credential and a saved secret file that is not one', async () => {
    await withCoordinator(
      () => Response.json({ error: 'unexpected' }, { status: 500 }),
      async (files) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'old',
            secret: 'o'.repeat(43),
          }),
        );
        await fs.writeFile(files.enrolling, 'not json');

        await startAgentHostConnection({
          ...target,
          bridge: {} as AcpSessionBridge,
        });

        // It may hold the revoked secret, so it goes too, and the
        // credential with it.
        await vi.waitFor(async () => {
          await expect(fs.access(files.credential)).rejects.toThrow();
          await expect(fs.access(files.enrolling)).rejects.toThrow();
        });
      },
      (url) =>
        url.endsWith('/pickup')
          ? Response.json(
              { error: AGENT_HOST_CREDENTIAL_REJECTED },
              { status: 401 },
            )
          : undefined,
    );
  });

  it('takes the secret another process saved for a Replace meanwhile, rather than replacing it', async () => {
    const stranded = 's'.repeat(43);
    const other = 't'.repeat(43);
    await withCoordinator(
      async (secret) => {
        if (secret === stranded) {
          // Another daemon on this machine already made its own for it.
          const files = hostFiles(
            process.env['QWEN_HOME']!,
            serverUrl,
            workspaceId,
            workspaceCwd,
          );
          await fs.writeFile(
            files.enrolling,
            JSON.stringify({ schemaVersion: 1, secret: other }),
          );
          return Response.json(
            { error: AGENT_HOST_ALREADY_ENROLLED },
            { status: 409 },
          );
        }
        return Response.json({ host: { id: 'replacement' }, secret });
      },
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );

        await connect();

        expect(sent).toEqual([stranded, other]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'replacement',
          secret: other,
        });
      },
    );
  });

  it('finishes a Replace whose answer it lost while it held a credential, with the same command', async () => {
    const saved = 'x'.repeat(43);
    const pending = 'q'.repeat(43);
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'h2' }, secret }),
      async (files, sent) => {
        // The Replace's secret, saved for this command's token before the
        // answer that never came.
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: saved,
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({
            schemaVersion: 1,
            secret: pending,
            tokenHashes: [tokenHash('join-token')],
          }),
        );

        await connect();

        expect(sent).toEqual([pending]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'h2',
          secret: pending,
        });
      },
      // The token was spent, and the credential still works.
      (url, input) =>
        url.includes('/x/heartbeat') && input['enrollmentToken']
          ? Response.json({ error: 'refused' }, { status: 401 })
          : undefined,
    );
  });

  it('finishes, with the same command, a Replace that reused a secret another command saved', async () => {
    // A first Replace saved it and got no answer; a refreshed one reused it,
    // went through, and lost its answer.
    const reused = 'q'.repeat(43);
    let replaceAsked = 0;
    let enrolled = 0;
    await withCoordinator(
      (secret) => {
        if (enrolled++ === 0) throw new TypeError('fetch failed');
        return Response.json({ host: { id: 'h2' }, secret });
      },
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({
            schemaVersion: 1,
            secret: reused,
            tokenHashes: [tokenHash('the-first-replace')],
          }),
        );

        await expect(connect()).rejects.toThrow('fetch failed');
        await connect();

        expect(sent).toEqual([reused, reused]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'h2',
          secret: reused,
        });
      },
      (url, input) => {
        if (!url.includes('/x/heartbeat') || !input['enrollmentToken']) {
          return undefined;
        }
        // Valid on the first run, spent on the rerun.
        return replaceAsked++ === 0
          ? Response.json(
              { error: AGENT_HOST_REPLACEMENT_REQUIRED },
              { status: 409 },
            )
          : Response.json(
              { error: AGENT_HOST_CREDENTIAL_REJECTED },
              { status: 401 },
            );
      },
    );
  });

  it('does not take a Replace secret another command saved', async () => {
    // Joined again with a new token since; this run has that token.
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'h2' }, secret }),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
          }),
        );
        const pending = JSON.stringify({
          schemaVersion: 1,
          secret: 'q'.repeat(43),
          tokenHashes: [tokenHash('the-replace-token')],
        });
        await fs.writeFile(files.enrolling, pending);

        await expect(connect()).rejects.toThrow(
          'Invalid or expired Agent Host enrollment token.',
        );
        expect(sent).toEqual([]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'x',
        });
        await expect(fs.readFile(files.enrolling, 'utf8')).resolves.toBe(
          pending,
        );
      },
      (url, input) =>
        url.includes('/x/heartbeat') && input['enrollmentToken']
          ? Response.json(
              { error: AGENT_HOST_CREDENTIAL_REJECTED },
              { status: 401 },
            )
          : undefined,
    );
  });

  it('finishes a Replace of itself whose answer it lost, keeping that Replace’s secret through the revocation', async () => {
    const pending = 'q'.repeat(43);
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'h2' }, secret }),
      async (files, sent) => {
        // The Replace moved this Host's bindings and removed it.
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({
            schemaVersion: 1,
            secret: pending,
            tokenHashes: [tokenHash('join-token')],
          }),
        );

        await connect();

        expect(sent).toEqual([pending]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'h2',
          secret: pending,
        });
      },
      (url) =>
        url.includes('/x/')
          ? Response.json(
              { error: AGENT_HOST_CREDENTIAL_REJECTED },
              { status: 401 },
            )
          : undefined,
    );
  });

  it('puts back the earlier secret only over the one its refused Replace saved', async () => {
    const stranded = 's'.repeat(43);
    const other = 't'.repeat(43);
    await withCoordinator(
      async (secret) => {
        if (secret === stranded) {
          return Response.json(
            { error: AGENT_HOST_ALREADY_ENROLLED },
            { status: 409 },
          );
        }
        // Another process saved its own meanwhile; this Replace is refused.
        const files = hostFiles(
          process.env['QWEN_HOME']!,
          serverUrl,
          workspaceId,
          workspaceCwd,
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: other }),
        );
        return Response.json(
          { error: AGENT_HOST_ENROLLMENT_REFUSED },
          { status: 401 },
        );
      },
      async (files) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );

        await expect(connect()).rejects.toThrow(AGENT_HOST_ENROLLMENT_REFUSED);

        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: other,
        });
      },
    );
  });

  it('goes on, run again, with the credential its enrollment saved before the connection failed', async () => {
    let busy = true;
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'host-1' }, secret }),
      async (files, sent) => {
        await expect(connect()).rejects.toThrow(
          'Agent Host could not confirm its connection to the coordinator. Check the callback URL and saved credential, then join again with the same token.',
        );
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'host-1',
          secret: sent[0],
          enrollmentTokenHash: tokenHash('join-token'),
        });

        // The same command: its token is spent, by this enrollment.
        await connect();

        expect(sent).toHaveLength(1);
      },
      (url, input) => {
        if (!url.includes('/host-1/heartbeat')) return undefined;
        if (input['enrollmentToken']) {
          return Response.json({ error: 'refused' }, { status: 401 });
        }
        if (!busy) return undefined;
        // The first heartbeat meets a busy store.
        busy = false;
        return Response.json({ error: 'busy' }, { status: 503 });
      },
    );
  });

  it.each([
    ['an older version saved', 'v2', undefined],
    ['another command recorded', 'v2', tokenHash('an-earlier-join')],
    ['an older version saved under the older name', 'legacy', undefined],
  ])(
    'goes on, run again, after a re-join whose first heartbeat failed, with a credential %s',
    async (_label, where, recorded) => {
      let spent = false;
      let busy = true;
      await withCoordinator(
        () => Response.json({ error: 'unexpected' }, { status: 500 }),
        async (files, sent) => {
          const saved =
            where === 'legacy'
              ? files.credential.replace(/\.v2\.json$/, '.json')
              : files.credential;
          await fs.mkdir(path.dirname(saved), { recursive: true });
          await fs.writeFile(
            saved,
            JSON.stringify({
              schemaVersion: 1,
              serverUrl,
              workspaceId,
              hostId: 'x',
              secret: 'x'.repeat(43),
              ...(recorded ? { enrollmentTokenHash: recorded } : {}),
            }),
          );

          await expect(connect()).rejects.toThrow(
            'Agent Host could not confirm its connection to the coordinator. Check the callback URL and saved credential, then join again with the same token.',
          );
          await expect(readJson(files.credential)).resolves.toMatchObject({
            hostId: 'x',
            enrollmentTokenHash: tokenHash('join-token'),
          });

          await expect(connect()).resolves.toEqual({ recorded: true });

          expect(sent).toEqual([]);
        },
        (url, input) => {
          if (!url.includes('/x/heartbeat')) return undefined;
          if (input['enrollmentToken']) {
            // The first re-join spends the token.
            if (!spent) {
              spent = true;
              return undefined;
            }
            return Response.json({ error: 'refused' }, { status: 401 });
          }
          if (!busy) return undefined;
          busy = false;
          return Response.json({ error: 'busy' }, { status: 503 });
        },
      );
    },
  );

  it('starts on a re-join even when its credential cannot record the token', async () => {
    const saved = {
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'x',
      secret: 'x'.repeat(43),
    };
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await withCoordinator(
        () => Response.json({ error: 'unexpected' }, { status: 500 }),
        async (files) => {
          await fs.mkdir(path.dirname(files.credential), { recursive: true });
          await fs.writeFile(files.credential, JSON.stringify(saved));

          // Starts, but a rerun of this join would be refused.
          await expect(connect()).resolves.toEqual({ recorded: false });

          expect(stderr.mock.calls.map(([line]) => String(line))).toContain(
            'Agent Host credential could not record its enrollment: ENOSPC: no space left on device\n',
          );
          // Only a rerun of this command would have needed it.
          await expect(readJson(files.credential)).resolves.toEqual(saved);
        },
        (url, input) => {
          if (url.includes('/x/heartbeat') && input['enrollmentToken']) {
            // The next rename is the credential's save, after this answer.
            vi.mocked(fs.rename).mockRejectedValueOnce(
              Object.assign(new Error('ENOSPC: no space left on device'), {
                code: 'ENOSPC',
              }),
            );
          }
          return undefined;
        },
      );
    } finally {
      stderr.mockRestore();
      // Back to the real rename, should the rejection above not be used.
      vi.mocked(fs.rename).mockReset();
    }
  });

  it('does not point a re-join at a rerun when its credential could not record the token', async () => {
    const saved = {
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'x',
      secret: 'x'.repeat(43),
    };
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await withCoordinator(
        () => Response.json({ error: 'unexpected' }, { status: 500 }),
        async (files) => {
          await fs.mkdir(path.dirname(files.credential), { recursive: true });
          await fs.writeFile(files.credential, JSON.stringify(saved));

          // The record did not land, so the rerun would be refused: the
          // advice must not send the operator into it.
          await expect(connect()).rejects.toThrow(
            'Agent Host could not confirm its connection to the coordinator. Check the callback URL and saved credential.',
          );
          expect(stderr.mock.calls.map(([line]) => String(line))).toContain(
            'Agent Host credential could not record its enrollment: ENOSPC: no space left on device\n',
          );
          await expect(readJson(files.credential)).resolves.toEqual(saved);
        },
        (url, input) => {
          if (!url.includes('/x/heartbeat')) return undefined;
          if (input['enrollmentToken']) {
            // The next rename is the credential's save, after this answer.
            vi.mocked(fs.rename).mockRejectedValueOnce(
              Object.assign(new Error('ENOSPC: no space left on device'), {
                code: 'ENOSPC',
              }),
            );
            return undefined;
          }
          // The confirmation heartbeat meets a busy store.
          return Response.json({ error: 'busy' }, { status: 503 });
        },
      );
    } finally {
      stderr.mockRestore();
      // Back to the real rename, should the rejection above not be used.
      vi.mocked(fs.rename).mockReset();
    }
  });

  it('still points a rerun at itself when the credential already records the token', async () => {
    let busy = true;
    await withCoordinator(
      () => Response.json({ error: 'unexpected' }, { status: 500 }),
      async (files) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
            enrollmentTokenHash: tokenHash('join-token'),
          }),
        );

        await expect(connect()).rejects.toThrow(
          'Agent Host could not confirm its connection to the coordinator. Check the callback URL and saved credential, then join again with the same token.',
        );
      },
      (url, input) => {
        if (!url.includes('/x/heartbeat')) return undefined;
        // Answered as a repeat of the enrollment it records: token unspent.
        if (input['enrollmentToken']) return undefined;
        if (!busy) return undefined;
        busy = false;
        return Response.json({ error: 'busy' }, { status: 503 });
      },
    );
  });

  it('does not save a re-join’s token over a credential removed meanwhile', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await withCoordinator(
        () => Response.json({ error: 'unexpected' }, { status: 500 }),
        async (files) => {
          await fs.mkdir(path.dirname(files.credential), { recursive: true });
          await fs.writeFile(
            files.credential,
            JSON.stringify({
              schemaVersion: 1,
              serverUrl,
              workspaceId,
              hostId: 'x',
              secret: 'x'.repeat(43),
            }),
          );

          await connect();

          // Removed (revoked, say) by another process: not written back.
          expect(stderr.mock.calls.map(([line]) => String(line))).toContain(
            'Agent Host credential could not record its enrollment: Saved Agent Host credential was removed.\n',
          );
          await expect(fs.access(files.credential)).rejects.toThrow();
        },
        (url, input) => {
          if (url.includes('/x/heartbeat') && input['enrollmentToken']) {
            const files = hostFiles(
              process.env['QWEN_HOME']!,
              serverUrl,
              workspaceId,
              workspaceCwd,
            );
            return fs
              .rm(files.credential)
              .then(() =>
                Response.json({ host: { id: 'x' }, leases: [], decisions: [] }),
              );
          }
          return undefined;
        },
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('goes on, run again, even with a secret its enrollment left behind', async () => {
    // An older coordinator minted its own secret, and the proposed one's
    // file could not be dropped: it still names this command's token.
    await withCoordinator(
      () => Response.json({ error: 'unexpected' }, { status: 500 }),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
            enrollmentTokenHash: tokenHash('join-token'),
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({
            schemaVersion: 1,
            secret: 'q'.repeat(43),
            tokenHashes: [tokenHash('join-token')],
          }),
        );

        await connect();

        // Not sent again with the spent token.
        expect(sent).toEqual([]);
      },
      (url, input) =>
        url.includes('/x/heartbeat') && input['enrollmentToken']
          ? Response.json({ error: 'refused' }, { status: 401 })
          : undefined,
    );
  });

  it('waits for the same join sent again while it runs, rather than cutting it off', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const tokenHeartbeats: unknown[] = [];
    await withCoordinator(
      async (secret) => {
        // Its answer is on the way when the same join is sent again.
        await answered;
        return Response.json({ host: { id: 'host-1' }, secret });
      },
      async (_files, sent) => {
        // One daemon: its connect route passes the same bridge each time.
        const bridge = {} as AcpSessionBridge;
        const join = (enrollmentToken = 'join-token') =>
          startAgentHostConnection({ ...target, bridge, enrollmentToken });
        const first = join();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const again = join();
        answer();

        // Both get what the one join did, record included.
        await expect(Promise.all([first, again])).resolves.toEqual([
          { recorded: true },
          { recorded: true },
        ]);
        expect(sent).toHaveLength(1);
        // Joined, the same join sent again keeps the connection it made,
        // rather than starting it over.
        await expect(join()).resolves.toEqual({ recorded: true });
        expect(sent).toHaveLength(1);
        expect(tokenHeartbeats).toEqual([]);

        // Another token is another join: it replaces the connection.
        await join('newer-token');
        expect(tokenHeartbeats).toEqual(['newer-token']);
      },
      (url, input) => {
        if (url.endsWith('/heartbeat') && input['enrollmentToken']) {
          tokenHeartbeats.push(input['enrollmentToken']);
        }
        return undefined;
      },
    );
  });

  it('does not ask for the same token when a start without one cannot confirm', async () => {
    await withCoordinator(
      () => Response.json({ error: 'unexpected' }, { status: 500 }),
      async (files) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
          }),
        );

        await expect(
          startAgentHostConnection({
            ...target,
            bridge: {} as AcpSessionBridge,
          }),
        ).rejects.toThrow(
          /^Agent Host could not confirm its connection to the coordinator\. Check the callback URL and saved credential\.$/,
        );
      },
      (url) =>
        url.includes('/x/heartbeat')
          ? Response.json({ error: 'busy' }, { status: 503 })
          : undefined,
    );
  });

  it('still says the token is spent when another command spent it', async () => {
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'h2' }, secret }),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
            enrollmentTokenHash: tokenHash('an-earlier-join'),
          }),
        );

        // A Replace refused outright, say: it did nothing.
        await expect(connect()).rejects.toThrow(
          'Invalid or expired Agent Host enrollment token.',
        );
        expect(sent).toEqual([]);
      },
      (url, input) =>
        url.includes('/x/heartbeat') && input['enrollmentToken']
          ? Response.json({ error: 'refused' }, { status: 401 })
          : undefined,
    );
  });

  it('still says the token is spent when nothing of a Replace is saved', async () => {
    await withCoordinator(
      (secret) => Response.json({ host: { id: 'h2' }, secret }),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'x',
            secret: 'x'.repeat(43),
          }),
        );

        await expect(connect()).rejects.toThrow(
          'Invalid or expired Agent Host enrollment token.',
        );
        expect(sent).toEqual([]);
      },
      (url, input) =>
        url.includes('/x/heartbeat') && input['enrollmentToken']
          ? Response.json({ error: 'refused' }, { status: 401 })
          : undefined,
    );
  });

  it('puts back the earlier secret when a Replace is refused outright after its 409', async () => {
    const stranded = 's'.repeat(43);
    await withCoordinator(
      (secret) =>
        secret === stranded
          ? Response.json(
              { error: AGENT_HOST_ALREADY_ENROLLED },
              { status: 409 },
            )
          : // Expired, or its target gone: it did nothing.
            Response.json(
              { error: AGENT_HOST_ENROLLMENT_REFUSED },
              { status: 401 },
            ),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );

        await expect(connect()).rejects.toThrow(AGENT_HOST_ENROLLMENT_REFUSED);

        expect(sent).toHaveLength(2);
        // The join that enrolled it can still be finished.
        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: stranded,
          tokenHashes: [tokenHash('join-token')],
        });
      },
    );
  });

  it('makes no new secret for a Replace once its connection was stopped', async () => {
    const stranded = 's'.repeat(43);
    await withCoordinator(
      () => {
        stopAgentHostConnection(target);
        return Response.json(
          { error: AGENT_HOST_ALREADY_ENROLLED },
          { status: 409 },
        );
      },
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );

        await expect(connect()).rejects.toThrow();

        expect(sent).toEqual([stranded]);
        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: stranded,
          tokenHashes: [tokenHash('join-token')],
        });
      },
    );
  });

  it('leaves the secret a newer connection saved when a superseded one hears its 409 late', async () => {
    const stranded = 's'.repeat(43);
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>(
      (resolve) => (answerFirst = resolve),
    );
    let seen = 0;
    await withCoordinator(
      async (secret) => {
        if (secret === stranded) {
          // The first connection's 409 is held until the second is done.
          if (seen++ === 0) await firstAnswered;
          return Response.json(
            { error: AGENT_HOST_ALREADY_ENROLLED },
            { status: 409 },
          );
        }
        // The second connection's Replace went through; its answer is lost.
        throw new TypeError('fetch failed');
      },
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );
        // One daemon, so one bridge: only another token replaces the join.
        const bridge = {} as AcpSessionBridge;
        const first = startAgentHostConnection({
          ...target,
          bridge,
          enrollmentToken: 'join-token',
        });
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        // A newer join: the same one sent again would wait for the first.
        await expect(
          startAgentHostConnection({
            ...target,
            bridge,
            enrollmentToken: 'newer-token',
          }),
        ).rejects.toThrow('fetch failed');
        const own = sent[2];
        expect(own).not.toBe(stranded);

        // The superseded connection hears its 409 now, and stops there.
        answerFirst();
        await expect(first).rejects.toThrow('Agent Host connection replaced.');

        // Still the secret the Replace that went through holds.
        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: own,
          tokenHashes: [tokenHash('newer-token')],
        });
      },
    );
  });

  it('drops a revoked credential’s enrollment secret with it', async () => {
    const saved = 'o'.repeat(43);
    await withCoordinator(
      () => Response.json({ error: 'unexpected' }, { status: 500 }),
      async (files, sent) => {
        // A finished enrollment whose secret file stayed behind.
        await fs.mkdir(path.dirname(files.credential), { recursive: true });
        await fs.writeFile(
          files.credential,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'old',
            secret: saved,
          }),
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: saved }),
        );

        await startAgentHostConnection({
          ...target,
          bridge: {} as AcpSessionBridge,
        });

        // Revoked while connected: enrolled again later, without the
        // credential to compare with, it would bring the secret back.
        await vi.waitFor(async () => {
          await expect(fs.access(files.credential)).rejects.toThrow();
          await expect(fs.access(files.enrolling)).rejects.toThrow();
        });
        expect(sent).toEqual([]);
      },
      (url) =>
        url.endsWith('/pickup')
          ? Response.json(
              { error: AGENT_HOST_CREDENTIAL_REJECTED },
              { status: 401 },
            )
          : undefined,
    );
  });

  it.each([
    ['not JSON', 'not json'],
    [
      'from a newer version',
      JSON.stringify({ schemaVersion: 2, secret: 'k'.repeat(43) }),
    ],
    [
      'sent with more tokens than this version keeps',
      JSON.stringify({
        schemaVersion: 1,
        secret: 'k'.repeat(43),
        tokenHashes: Array.from({ length: 9 }, () => 'a'.repeat(64)),
      }),
    ],
    [
      'sent with a malformed token hash',
      JSON.stringify({
        schemaVersion: 1,
        secret: 'k'.repeat(43),
        tokenHashes: ['join-token'],
      }),
    ],
  ])(
    'does not enroll, nor replace its secret, when the saved one is %s',
    async (_label, content) => {
      await withCoordinator(
        () => Response.json({ host: { id: 'host-1' }, secret: 'm'.repeat(43) }),
        async (files, sent) => {
          await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
          await fs.writeFile(files.enrolling, content);

          await expect(connect()).rejects.toThrow(
            `Malformed Agent Host enrollment secret: ${files.enrolling}`,
          );

          expect(sent).toEqual([]);
          await expect(fs.readFile(files.enrolling, 'utf8')).resolves.toBe(
            content,
          );
        },
      );
    },
  );

  it('does not enroll, nor replace its secret, when it cannot read it', async () => {
    const saved = 'k'.repeat(43);
    const actual = (
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    ).readFile;
    await withCoordinator(
      () => Response.json({ host: { id: 'host-1' }, secret: 'm'.repeat(43) }),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        const kept = JSON.stringify({ schemaVersion: 1, secret: saved });
        await fs.writeFile(files.enrolling, kept);
        vi.mocked(fs.readFile).mockImplementation(((file, ...rest) =>
          String(file) === files.enrolling
            ? Promise.reject(
                Object.assign(new Error('EIO: i/o error, read'), {
                  code: 'EIO',
                }),
              )
            : actual(file, ...rest)) as typeof fs.readFile);
        try {
          await expect(connect()).rejects.toThrow('EIO');
        } finally {
          vi.mocked(fs.readFile).mockImplementation(actual);
        }

        // An enrollment may have taken that secret: it stays, and the token
        // is unspent, so the same join can be retried.
        expect(sent).toEqual([]);
        await expect(fs.readFile(files.enrolling, 'utf8')).resolves.toBe(kept);
      },
    );
  });

  it('leaves a secret another enrollment of this connection saved meanwhile', async () => {
    const other = 'n'.repeat(43);
    await withCoordinator(
      async (secret) => {
        // Saved by another enrollment of this connection while this one
        // waited for its answer.
        const files = hostFiles(
          process.env['QWEN_HOME']!,
          serverUrl,
          workspaceId,
          workspaceCwd,
        );
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: other }),
        );
        return Response.json({ host: { id: 'host-1' }, secret });
      },
      async (files) => {
        await connect();

        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: other,
        });
      },
    );
  });

  it.each([
    // A rerun of another command still finds its own token.
    [
      'adds this command’s token beside another’s',
      [tokenHash('the-first-replace')],
      [tokenHash('the-first-replace'), tokenHash('join-token')],
    ],
    [
      'records this command’s token once',
      [tokenHash('join-token')],
      [tokenHash('join-token')],
    ],
    // At most what it reads back: the oldest goes.
    [
      'keeps the latest eight tokens',
      Array.from({ length: 8 }, (_, i) => tokenHash(`command-${i}`)),
      [
        ...Array.from({ length: 7 }, (_, i) => tokenHash(`command-${i + 1}`)),
        tokenHash('join-token'),
      ],
    ],
  ])(
    '%s when it sends its saved secret again',
    async (_label, saved, expected) => {
      const kept = 'k'.repeat(43);
      await withCoordinator(
        () =>
          Response.json(
            { error: AGENT_HOST_ENROLLMENT_UNAVAILABLE },
            { status: 503 },
          ),
        async (files, sent) => {
          await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
          await fs.writeFile(
            files.enrolling,
            JSON.stringify({
              schemaVersion: 1,
              secret: kept,
              tokenHashes: saved,
            }),
          );

          await expect(connect()).rejects.toThrow(
            AGENT_HOST_ENROLLMENT_UNAVAILABLE,
          );
          await expect(readJson(files.enrolling)).resolves.toEqual({
            schemaVersion: 1,
            secret: kept,
            tokenHashes: expected,
          });

          // What it wrote, it reads back.
          await expect(connect()).rejects.toThrow(
            AGENT_HOST_ENROLLMENT_UNAVAILABLE,
          );
          expect(sent).toEqual([kept, kept]);
        },
      );
    },
  );

  it('keeps its saved secret when the credential cannot be saved after the enrollment', async () => {
    let failSave = true;
    await withCoordinator(
      (secret) => {
        if (failSave) {
          failSave = false;
          // The next rename is the credential's save, after this answer.
          vi.mocked(fs.rename).mockRejectedValueOnce(
            Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            }),
          );
        }
        return Response.json({ host: { id: 'host-1' }, secret });
      },
      async (files, sent) => {
        await expect(connect()).rejects.toThrow('ENOSPC');

        // The coordinator took the enrollment: the retry needs this secret.
        await expect(fs.access(files.credential)).rejects.toThrow();
        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: sent[0],
          tokenHashes: [tokenHash('join-token')],
        });

        await connect();

        expect(sent).toEqual([sent[0], sent[0]]);
        await expect(readJson(files.credential)).resolves.toMatchObject({
          hostId: 'host-1',
          secret: sent[0],
        });
      },
    );
  });

  it('keeps the new secret when a Replace retried after its 409 gets no definite answer', async () => {
    const stranded = 's'.repeat(43);
    await withCoordinator(
      (secret) =>
        secret === stranded
          ? Response.json(
              { error: AGENT_HOST_ALREADY_ENROLLED },
              { status: 409 },
            )
          : // Busy: the Replace may yet have gone through with this one.
            Response.json(
              { error: AGENT_HOST_ENROLLMENT_UNAVAILABLE },
              { status: 503 },
            ),
      async (files, sent) => {
        await fs.mkdir(path.dirname(files.enrolling), { recursive: true });
        await fs.writeFile(
          files.enrolling,
          JSON.stringify({ schemaVersion: 1, secret: stranded }),
        );

        await expect(connect()).rejects.toThrow(
          AGENT_HOST_ENROLLMENT_UNAVAILABLE,
        );

        expect(sent).toHaveLength(2);
        expect(sent[1]).not.toBe(stranded);
        await expect(readJson(files.enrolling)).resolves.toEqual({
          schemaVersion: 1,
          secret: sent[1],
          tokenHashes: [tokenHash('join-token')],
        });
      },
    );
  });

  it('starts on its new credential when the saved secret cannot be dropped after it', async () => {
    let release: (() => Promise<void>) | undefined;
    await withCoordinator(
      async (secret) => {
        const files = hostFiles(
          process.env['QWEN_HOME']!,
          serverUrl,
          workspaceId,
          workspaceCwd,
        );
        // Another process holds the secret file's lock past its retries.
        release = await lockfile.lock(files.enrolling, { realpath: false });
        return Response.json({ host: { id: 'host-1' }, secret });
      },
      async (files, sent) => {
        try {
          await connect();

          await expect(readJson(files.credential)).resolves.toMatchObject({
            hostId: 'host-1',
            secret: sent[0],
          });
          // Left behind, it is not reused: the credential holds it.
          await expect(readJson(files.enrolling)).resolves.toMatchObject({
            secret: sent[0],
          });
        } finally {
          await release?.();
        }
      },
    );
  });
});

it('retains a saved credential when rejoining sees only bare bearer 401s', async () => {
  const qwenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr12582-f1-'));
  const serverUrl = 'http://127.0.0.1:18582';
  const workspaceId = 'ws-test';
  const workspaceCwd = '/pr12582-test';
  const key = createHash('sha256')
    .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
    .digest('hex');
  const file = path.join(qwenDir, 'agent-hosts', `${key}.json`);
  const credential = JSON.stringify({
    schemaVersion: 1,
    serverUrl,
    workspaceId,
    hostId: 'host-saved',
    secret: 'saved-test-secret',
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, credential);
  const fetchMock = vi.fn(async () =>
    Response.json({ error: 'Unauthorized' }, { status: 401 }),
  );
  vi.stubEnv('QWEN_HOME', qwenDir);
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(
      startAgentHostConnection({
        bridge: {} as AcpSessionBridge,
        serverUrl,
        workspaceId,
        workspaceCwd,
        enrollmentToken: 'the-original-ui-join-token',
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalled();
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(credential);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(qwenDir, { recursive: true, force: true });
  }
});

it('re-enrolls a same-cwd saved Host for explicit replacement and protects its new credential from old revocation', async () => {
  const workspaceCwd = await fs.mkdtemp(
    path.join(os.tmpdir(), 'host-replacement-'),
  );
  const serverUrl = 'http://127.0.0.1:18584';
  const workspaceId = 'ws-replacement';
  const key = createHash('sha256')
    .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
    .digest('hex');
  const file = path.join(workspaceCwd, 'agent-hosts', `${key}.json`);
  const currentFile = path.join(workspaceCwd, 'agent-hosts', `${key}.v2.json`);
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'old',
      secret: 'old-secret',
    }),
  );
  const bridge = {
    listWorkspaceSessions: () => [],
  } as unknown as AcpSessionBridge;
  let replacementEnrolled = false;
  let newerWritten = false;
  let cleanupDone = false;
  const lock = lockfile.lock;
  const lockSpy = vi
    .spyOn(lockfile, 'lock')
    .mockImplementation(async (filePath, options) => {
      const release = await lock(filePath, options);
      return async () => {
        await release();
        if (newerWritten) cleanupDone = true;
      };
    });
  vi.stubEnv('QWEN_HOME', workspaceCwd);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const input = init?.body
        ? (JSON.parse(init.body as string) as {
            enrollmentToken?: string;
            token?: string;
          })
        : {};
      if (url.endsWith('/old/heartbeat') && input.enrollmentToken) {
        return Response.json(
          { error: 'Agent Host replacement requires enrollment.' },
          { status: 409 },
        );
      }
      if (url.endsWith('/enroll')) {
        expect(input.token).toBe('replacement-token');
        replacementEnrolled = true;
        return Response.json({
          host: { id: 'replacement' },
          secret: 'replacement-secret',
        });
      }
      if (url.endsWith('/pickup')) {
        await fs.writeFile(
          currentFile,
          JSON.stringify({
            schemaVersion: 1,
            serverUrl,
            workspaceId,
            hostId: 'newer',
            secret: 'newer-secret',
          }),
        );
        newerWritten = true;
        return Response.json(
          { error: 'Invalid Agent Host credential.' },
          { status: 401 },
        );
      }
      // Simulate the legacy client's unconditional deletion after revocation.
      await fs.rm(file, { force: true });
      return Response.json({ host: { id: 'replacement' } });
    }),
  );
  try {
    await startAgentHostConnection({
      bridge,
      serverUrl,
      workspaceId,
      workspaceCwd,
      enrollmentToken: 'replacement-token',
    });
    await vi.waitFor(() => expect(newerWritten).toBe(true));
    await vi.waitFor(() => expect(cleanupDone).toBe(true));
    expect(await fs.readdir(path.dirname(file))).toEqual([`${key}.v2.json`]);
    expect(replacementEnrolled).toBe(true);
    expect(JSON.parse(await fs.readFile(currentFile, 'utf8'))).toMatchObject({
      hostId: 'newer',
      secret: 'newer-secret',
    });
  } finally {
    lockSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(workspaceCwd, { recursive: true, force: true });
  }
});

it.each(['legacy', 'v2'])(
  'preserves a replacement credential when a stale %s startup resumes',
  async (version) => {
    const workspaceCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), 'host-stale-startup-'),
    );
    const serverUrl = 'http://127.0.0.1:18585';
    const workspaceId = 'ws-stale';
    const key = createHash('sha256')
      .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
      .digest('hex');
    const directory = path.join(workspaceCwd, 'agent-hosts');
    await fs.mkdir(directory);
    const currentFile = path.join(directory, `${key}.v2.json`);
    const old = {
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'old',
      secret: 'old-secret',
    };
    const replacement = {
      ...old,
      hostId: 'replacement',
      secret: 'replacement-secret',
    };
    await fs.writeFile(
      version === 'v2' ? currentFile : path.join(directory, `${key}.json`),
      JSON.stringify(old),
    );
    const lock = lockfile.lock;
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementationOnce(async (file, options) => {
        // The other process finishes replacement after this startup's read.
        await fs.writeFile(currentFile, JSON.stringify(replacement));
        return lock(file, options);
      });
    vi.stubEnv('QWEN_HOME', workspaceCwd);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Invalid Agent Host credential.' },
          { status: 401 },
        ),
      ),
    );
    try {
      await expect(
        startAgentHostConnection({
          bridge: {} as AcpSessionBridge,
          serverUrl,
          workspaceId,
          workspaceCwd,
        }),
      ).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(currentFile, 'utf8'))).toEqual(
        replacement,
      );
    } finally {
      lockSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await fs.rm(workspaceCwd, { recursive: true, force: true });
    }
  },
);

it.each(['write', 'remove'] as const)(
  'preserves the saved credential when the %s lock is compromised',
  async (operation) => {
    const workspaceCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), 'host-compromised-lock-'),
    );
    const serverUrl = 'http://127.0.0.1:18586';
    const workspaceId = 'ws-compromised';
    const key = createHash('sha256')
      .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
      .digest('hex');
    const directory = path.join(workspaceCwd, 'agent-hosts');
    await fs.mkdir(directory);
    const file = path.join(
      directory,
      `${key}${operation === 'write' ? '' : '.v2'}.json`,
    );
    const credential = JSON.stringify({
      schemaVersion: 1,
      serverUrl,
      workspaceId,
      hostId: 'saved',
      secret: 'saved-secret',
    });
    await fs.writeFile(file, credential);
    const compromised = new Error('Credential lock ownership was lost.');
    const release = vi.fn().mockRejectedValue(new Error('ERELEASED'));
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation(async (_file, options) => {
        options?.onCompromised?.(compromised);
        return release;
      });
    vi.stubEnv('QWEN_HOME', workspaceCwd);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Invalid Agent Host credential.' },
          { status: 401 },
        ),
      ),
    );
    try {
      await expect(
        startAgentHostConnection({
          bridge: {} as AcpSessionBridge,
          serverUrl,
          workspaceId,
          workspaceCwd,
          ...(operation === 'remove' ? { enrollmentToken: 'token' } : {}),
        }),
      ).rejects.toBe(compromised);
      expect(await fs.readFile(file, 'utf8')).toBe(credential);
      expect(await fs.readdir(directory)).toEqual([path.basename(file)]);
      expect(release).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await fs.rm(workspaceCwd, { recursive: true, force: true });
    }
  },
);

const PROMPT: SessionAgentPermissionPrompt = {
  requestId: 'perm-1',
  title: 'Bash: rm build',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
};

/** An adapter that streams once, then waits for its turn to be aborted. */
function adapterUntilAborted(order: string[]) {
  return {
    program: 'claude' as const,
    async runTurn(turn: AgentAdapterTurnInput) {
      turn.onEvent({ type: 'text_delta', text: 'working' });
      await new Promise<void>((resolve) =>
        turn.signal.addEventListener(
          'abort',
          () => {
            order.push('adapter aborted');
            resolve();
          },
          { once: true },
        ),
      );
      return { status: 'cancelled' as const, outputText: '' };
    },
  };
}

it('stops a run the heartbeat reports cancelled: adapter first, then the relay, and no result', async () => {
  const order: string[] = [];
  const coordinator = fakeCoordinator([assignment('run-1')]);
  openRelay.mockReturnValue({
    url: 'http://127.0.0.1:1/agent-host-relay/runs/run-1/send',
    token: 'tok',
    close: () => order.push('relay closed'),
  });
  getAdapter.mockReturnValue(adapterUntilAborted(order));
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(coordinator.batches).toHaveLength(1));
    coordinator.state.cancelledLeases.add('run-1');
    // The next heartbeat (every 5 s) carries the cancellation.
    await vi.waitFor(() => expect(order).toContain('relay closed'), {
      timeout: 8_000,
    });
    expect(order.slice(0, 2)).toEqual(['adapter aborted', 'relay closed']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(coordinator.results).toEqual([]);
  });
}, 15_000);

it('stops a run when events come back 409 cancelled', async () => {
  const order: string[] = [];
  const coordinator = fakeCoordinator([assignment('run-1')]);
  coordinator.state.cancelled = true;
  getAdapter.mockReturnValue(adapterUntilAborted(order));
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(order).toEqual(['adapter aborted']), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(coordinator.results).toEqual([]);
  });
});

it('discards a result the coordinator refuses as cancelled, without retrying', async () => {
  const coordinator = fakeCoordinator([assignment('run-1')]);
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn() {
      // Cancelled after the adapter already finished.
      coordinator.state.cancelled = true;
      return { status: 'completed', outputText: 'done' };
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(coordinator.results).toHaveLength(1);
  });
});

it('recognizes the cancellation refusal', () => {
  expect(isCancellation({ status: 409, cancelled: true })).toBe(true);
  expect(isCancellation({ status: 409 })).toBe(false);
  expect(isCancellation(undefined)).toBe(false);
});

it('waits on a person through one decisions long-poll, with no empty event batches', async () => {
  const coordinator = fakeCoordinator([assignment('run-1')]);
  let answer: string | undefined;
  getAdapter.mockReturnValue({
    program: 'claude',
    async runTurn(turn) {
      turn.onEvent({ type: 'permission_request', prompt: PROMPT });
      answer = await turn.awaitPermission(PROMPT);
      turn.onEvent({ type: 'permission_resolved', requestId: 'perm-1' });
      return { status: 'completed', outputText: answer };
    },
  });
  await withHost(coordinator, async () => {
    await vi.waitFor(() =>
      expect(coordinator.decisionPolls.length).toBeGreaterThan(0),
    );
    expect(coordinator.decisionPolls[0]!.awaiting).toEqual([
      { runId: 'run-1', attempt: 1, requestId: 'perm-1', seen: [] },
    ]);
    // Idle while the person decides: nothing is polled through events.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    coordinator.state.decisions = [
      { runId: 'run-1', attempt: 1, requestId: 'perm-1', optionId: 'allow' },
    ];
    await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
    expect(answer).toBe('allow');
    expect(
      coordinator.batches.filter((batch) => batch.events.length === 0),
    ).toEqual([]);
  });
});

it.each([
  ['with decision ids', 'd1', 'd2'],
  ['without decision ids (keyed by the answer)', undefined, undefined],
])(
  'hands a re-armed wait the second answer, not the resent first one (%s)',
  async (_label, firstId, secondId) => {
    const coordinator = fakeCoordinator([assignment('run-1')]);
    const answers: string[] = [];
    getAdapter.mockReturnValue({
      program: 'claude',
      async runTurn(turn) {
        turn.onEvent({ type: 'permission_request', prompt: PROMPT });
        // The bridge refuses the first vote, so the adapter waits again.
        answers.push(await turn.awaitPermission(PROMPT));
        answers.push(await turn.awaitPermission(PROMPT));
        turn.onEvent({ type: 'permission_resolved', requestId: 'perm-1' });
        return { status: 'completed', outputText: answers.join(',') };
      },
    });
    const decision = (optionId: string, decisionId?: string) => ({
      runId: 'run-1',
      attempt: 1,
      requestId: 'perm-1',
      optionId,
      ...(decisionId ? { decisionId } : {}),
    });
    // Kept (and resent) until the coordinator sees permission_resolved.
    coordinator.state.decisions = [decision('allow', firstId)];
    await withHost(coordinator, async () => {
      await vi.waitFor(() => expect(answers).toEqual(['allow']));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(answers).toEqual(['allow']);
      // The second poll asks only for a decision it has not used.
      expect(coordinator.decisionPolls.at(-1)!.awaiting[0]!.seen).toEqual([
        firstId ? `id:${firstId}` : 'option:allow',
      ]);
      // The person answers the re-armed request.
      coordinator.state.decisions = [decision('deny', secondId)];
      await vi.waitFor(() => expect(coordinator.results).toHaveLength(1));
      expect(answers).toEqual(['allow', 'deny']);
    });
  },
);

it('reports whether a connection is running', async () => {
  const coordinator = fakeCoordinator([]);
  await withHost(coordinator, async (workspaceCwd) => {
    const target = {
      serverUrl: 'http://127.0.0.1:18590',
      workspaceId: 'ws-test',
      workspaceCwd,
    };
    expect(isAgentHostConnectionRunning(target)).toBe(true);
    expect(
      isAgentHostConnectionRunning({ ...target, workspaceId: 'other' }),
    ).toBe(false);
    stopAgentHostConnection(target);
    expect(isAgentHostConnectionRunning(target)).toBe(false);
  });
});

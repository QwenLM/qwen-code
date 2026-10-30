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

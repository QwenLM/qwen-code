/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { createDaemonStatusProvider } from './daemonStatusProvider.js';
import {
  createHttpAcpBridge,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  InvalidSessionScopeError,
  MAX_WORKSPACE_PATH_LENGTH,
  RestoreInProgressError,
  SessionNotFoundError,
  WorkspaceInitConflictError,
  WorkspaceMismatchError,
  type AcpChannel,
  type BridgeOptions,
  type ChannelFactory,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import { createInMemoryChannel } from './inMemoryChannel.js';
import type { BridgeEvent } from './eventBus.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';

// Workspace fixtures must round-trip through `path.resolve` so the
// expected values match what the bridge canonicalizes internally on
// every platform — a literal `/work/a` resolves to `D:\work\a` on
// Windows and the assertion drifts. Same for the FakeAgent's
// `sess:<cwd>` synthetic id, since the cwd it sees is the post-resolve
// value the bridge passes through `connection.newSession`.
const WS_A = path.resolve(path.sep, 'work', 'a');
const WS_B = path.resolve(path.sep, 'work', 'b');
const SESS_A = `sess:${WS_A}`;

/**
 * Convenience wrapper: `createHttpAcpBridge` now requires `boundWorkspace`
 * (per #3803 §02 — 1 daemon = 1 workspace). Tests that only ever talk to
 * `WS_A` would otherwise repeat `boundWorkspace: WS_A` everywhere; this
 * helper defaults it. Tests that need a different bind path (e.g. the
 * mismatch test) pass `boundWorkspace` explicitly.
 *
 * #4175 PR 22b/2: also defaults `statusProvider` to the production daemon
 * impl so existing env / preflight tests (which exercise the bridge's
 * delegation path) keep seeing populated cells. Tests that want to
 * exercise the no-provider idle fallback can override with
 * `{ statusProvider: undefined }`.
 */
function makeBridge(opts: Partial<BridgeOptions> = {}): HttpAcpBridge {
  return createHttpAcpBridge({
    boundWorkspace: WS_A,
    statusProvider: createDaemonStatusProvider(),
    ...opts,
  });
}

interface FakeAgentOpts {
  /** What the fake agent returns from `newSession`. */
  sessionIdPrefix?: string;
  /** Inject a per-call delay before responding to `initialize`. */
  initializeDelayMs?: number;
  /** Force `initialize` to throw. */
  initializeThrows?: Error;
  /**
   * Custom prompt handler. Default returns `end_turn` synchronously. Useful
   * for test cases that want to observe prompt ordering.
   */
  promptImpl?: (
    p: PromptRequest,
    self: FakeAgent,
  ) => Promise<PromptResponse> | PromptResponse;
  /**
   * Custom `newSession` handler. Default returns a synthesized id (see
   * `newSession` below). Used by tests that need to exercise the
   * doSpawn newSession-failure path (e.g. throwing to cover the
   * `isDying`-mark-then-kill cleanup).
   */
  newSessionImpl?: (
    p: NewSessionRequest,
    self: FakeAgent,
  ) => Promise<NewSessionResponse> | NewSessionResponse;
  loadSessionImpl?: (
    p: LoadSessionRequest,
    self: FakeAgent,
  ) => Promise<LoadSessionResponse> | LoadSessionResponse;
  resumeSessionImpl?: (
    p: ResumeSessionRequest,
    self: FakeAgent,
  ) => Promise<ResumeSessionResponse> | ResumeSessionResponse;
  extMethodImpl?: (
    method: string,
    params: Record<string, unknown>,
    self: FakeAgent,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

class FakeAgent implements Agent {
  newSessionCalls: NewSessionRequest[] = [];
  loadSessionCalls: LoadSessionRequest[] = [];
  resumeSessionCalls: ResumeSessionRequest[] = [];
  promptCalls: PromptRequest[] = [];
  cancelCalls: CancelNotification[] = [];
  extMethodCalls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  constructor(private readonly opts: FakeAgentOpts = {}) {}

  async initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    if (this.opts.initializeThrows) throw this.opts.initializeThrows;
    if (this.opts.initializeDelayMs) {
      await new Promise((r) => setTimeout(r, this.opts.initializeDelayMs));
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'fake-agent', version: '0' },
      authMethods: [],
      agentCapabilities: {},
    };
  }

  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(p);
    if (this.opts.newSessionImpl) {
      return this.opts.newSessionImpl(p, this);
    }
    const prefix = this.opts.sessionIdPrefix ?? 'sess';
    // Stage 1.5 multi-session: one FakeAgent can host multiple
    // sessions (same as the real ACP agent), so each newSession call
    // returns a fresh id. Suffix by call-count so tests that issue
    // multiple newSession on the same channel get distinct ids.
    const count = this.newSessionCalls.length;
    const suffix = count === 1 ? '' : `#${count}`;
    return { sessionId: `${prefix}:${p.cwd}${suffix}` };
  }

  async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.loadSessionCalls.push(p);
    if (this.opts.loadSessionImpl) {
      return this.opts.loadSessionImpl(p, this);
    }
    return {};
  }
  async unstable_resumeSession(
    p: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    this.resumeSessionCalls.push(p);
    if (this.opts.resumeSessionImpl) {
      return this.opts.resumeSessionImpl(p, this);
    }
    return {};
  }
  async authenticate(_p: AuthenticateRequest): Promise<AuthenticateResponse> {
    throw new Error('not implemented in test fake');
  }
  async prompt(p: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(p);
    if (this.opts.promptImpl) {
      return this.opts.promptImpl(p, this);
    }
    return { stopReason: 'end_turn' };
  }
  async cancel(p: CancelNotification): Promise<void> {
    this.cancelCalls.push(p);
  }
  async setSessionMode(
    _p: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    throw new Error('not implemented in test fake');
  }
  async setSessionConfigOption(
    _p: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    throw new Error('not implemented in test fake');
  }
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.extMethodCalls.push({ method, params });
    if (this.opts.extMethodImpl) {
      return this.opts.extMethodImpl(method, params, this);
    }
    return {};
  }
}

interface ChannelHandle {
  channel: AcpChannel;
  agent: FakeAgent;
  killed: boolean;
  /**
   * Resolve `channel.exited` without going through `kill()`. Optionally
   * supply exit info so the bridge's `session_died` event carries the
   * same `exitCode` / `signalCode` it would in a real crash (BX9_P).
   */
  crash: (info?: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }) => void;
}

/**
 * Create a paired in-memory NDJSON channel: bridge sees `clientChannel`,
 * fake agent sees `agentStream`. Each `TransformStream` carries one
 * direction.
 *
 * Not migrated to `createInMemoryChannel()` (used by the other 10 sites
 * in this file): `kill()` below needs the underlying `ab` / `ba`
 * writables to simulate child-process termination, which the bare
 * helper deliberately does not expose. See `inMemoryChannel.ts` JSDoc
 * for the rationale.
 */
function makeChannel(opts: FakeAgentOpts = {}): ChannelHandle {
  const ab = new TransformStream<Uint8Array, Uint8Array>();
  const ba = new TransformStream<Uint8Array, Uint8Array>();
  const clientStream = ndJsonStream(ab.writable, ba.readable);
  const agentStream = ndJsonStream(ba.writable, ab.readable);
  let resolveExited:
    | ((info?: {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      }) => void)
    | undefined;
  const exited = new Promise<
    { exitCode: number | null; signalCode: NodeJS.Signals | null } | undefined
  >((res) => {
    resolveExited = res;
  });
  const handle: ChannelHandle = {
    channel: undefined as unknown as AcpChannel,
    agent: new FakeAgent(opts),
    killed: false,
    /** Test hook: simulate an unexpected child crash. */
    crash: (info?: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }) => resolveExited!(info),
  };
  // Spin up the fake agent on the agent side.
  new AgentSideConnection(() => handle.agent, agentStream);
  handle.channel = {
    stream: clientStream,
    exited,
    kill: async () => {
      handle.killed = true;
      try {
        await ab.writable.close();
      } catch {
        /* ignore */
      }
      try {
        await ba.writable.close();
      } catch {
        /* ignore */
      }
      resolveExited!();
    },
    killSync: () => {
      // Test fake: just mark killed; the async streams will close
      // naturally on test cleanup. Mirrors the real spawn factory's
      // SIGKILL semantics (fire-and-forget).
      handle.killed = true;
      resolveExited!();
    },
  };
  return handle;
}

describe('createHttpAcpBridge', () => {
  it('accepts a valid BridgeOptions.eventRingSize at construction time', () => {
    // Smoke: positive finite integers are accepted; the underlying
    // EventBus ring-size threading is exercised end-to-end in
    // `eventBus.test.ts` ("default ring size is 8000 (#3803 §02
    // target)"). The bridge layer only contributes validation +
    // pass-through.
    expect(() => makeBridge({ eventRingSize: 1 })).not.toThrow();
    expect(() => makeBridge({ eventRingSize: 8000 })).not.toThrow();
    expect(() => makeBridge({ eventRingSize: 100_000 })).not.toThrow();
  });

  it('rejects an invalid eventRingSize at construction time', () => {
    expect(() => makeBridge({ eventRingSize: 0 })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() => makeBridge({ eventRingSize: -1 })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() => makeBridge({ eventRingSize: 1.5 })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() => makeBridge({ eventRingSize: Number.NaN })).toThrow(
      /Invalid eventRingSize/,
    );
    expect(() =>
      makeBridge({ eventRingSize: Number.POSITIVE_INFINITY }),
    ).toThrow(/Invalid eventRingSize/);
    // Upper-bound typo defense (1M cap). `80_000_000` here mimics the
    // common shell typo `--event-ring-size 80000000` vs `8000000`.
    expect(() => makeBridge({ eventRingSize: 80_000_000 })).toThrow(
      /Invalid eventRingSize/,
    );
  });

  it('forwards childEnvOverrides to the channelFactory at spawn time (#4247 R6 line 216)', async () => {
    // Round 6 (wenshao R5 line 216): pre-fix `runQwenServe` set
    // `process.env` globally to pass the MCP budget config to the
    // ACP child. With concurrent embedded daemons, the last
    // `runQwenServe` to set the var would silently win for all
    // other daemons' subsequent spawns (because
    // `defaultSpawnChannelFactory` snapshots `process.env` AT
    // SPAWN TIME, not at runQwenServe time). The fix routes the
    // env through `BridgeOptions.childEnvOverrides` closed over
    // inside each bridge — so each bridge's spawn factory sees
    // ITS own overrides, regardless of what other daemons did.
    const seenEnvs: Array<Record<string, string | undefined> | undefined> = [];
    const factory: ChannelFactory = async (_cwd, env) => {
      // Snapshot the override map so later iterations don't
      // accidentally mutate the recorded value.
      seenEnvs.push(env ? { ...env } : env);
      return makeChannel().channel;
    };
    const bridge1 = makeBridge({
      channelFactory: factory,
      childEnvOverrides: {
        QWEN_SERVE_MCP_CLIENT_BUDGET: '5',
        QWEN_SERVE_MCP_BUDGET_MODE: 'enforce',
      },
    });
    const bridge2 = makeBridge({
      channelFactory: factory,
      childEnvOverrides: {
        QWEN_SERVE_MCP_CLIENT_BUDGET: '20',
        QWEN_SERVE_MCP_BUDGET_MODE: 'warn',
      },
    });
    await bridge1.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge2.spawnOrAttach({ workspaceCwd: WS_A });
    expect(seenEnvs).toHaveLength(2);
    expect(seenEnvs[0]).toEqual({
      QWEN_SERVE_MCP_CLIENT_BUDGET: '5',
      QWEN_SERVE_MCP_BUDGET_MODE: 'enforce',
    });
    expect(seenEnvs[1]).toEqual({
      QWEN_SERVE_MCP_CLIENT_BUDGET: '20',
      QWEN_SERVE_MCP_BUDGET_MODE: 'warn',
    });
    await bridge1.shutdown();
    await bridge2.shutdown();
  });

  it('spawns a session and returns the agent-assigned id', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(session.sessionId).toBe(SESS_A);
    expect(session.workspaceCwd).toBe(WS_A);
    expect(session.attached).toBe(false);
    expect(session.clientId).toMatch(/^client_/);
    expect(bridge.sessionCount).toBe(1);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.agent.newSessionCalls[0]?.cwd).toBe(WS_A);

    await bridge.shutdown();
    expect(handles[0]?.killed).toBe(true);
  });

  it('reuses the existing session under sessionScope:single', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(true);
    expect(first.clientId).toMatch(/^client_/);
    expect(second.clientId).toMatch(/^client_/);
    expect(second.clientId).not.toBe(first.clientId);
    expect(handles).toHaveLength(1); // only one child spawned
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('does not spawn a channel for idle workspace status snapshots', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      },
    });

    await expect(bridge.getWorkspaceMcpStatus()).resolves.toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: false,
      servers: [],
    });
    await expect(bridge.getWorkspaceSkillsStatus()).resolves.toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: false,
      skills: [],
    });
    await expect(bridge.getWorkspaceProvidersStatus()).resolves.toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: false,
      providers: [],
    });
    expect(handles).toHaveLength(0);
  });

  it('requests workspace status through the existing ACP channel', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/workspace/mcp') {
              return {
                v: 1,
                workspaceCwd: WS_A,
                initialized: true,
                servers: [],
              };
            }
            if (method === 'qwen/status/workspace/skills') {
              return {
                v: 1,
                workspaceCwd: WS_A,
                initialized: true,
                skills: [],
              };
            }
            return {
              v: 1,
              workspaceCwd: WS_A,
              initialized: true,
              providers: [],
            };
          },
        });
        handles.push(h);
        return h.channel;
      },
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await expect(bridge.getWorkspaceMcpStatus()).resolves.toMatchObject({
      initialized: true,
    });
    await expect(bridge.getWorkspaceSkillsStatus()).resolves.toMatchObject({
      initialized: true,
    });
    await expect(bridge.getWorkspaceProvidersStatus()).resolves.toMatchObject({
      initialized: true,
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]?.agent.extMethodCalls.map((c) => c.method)).toEqual([
      'qwen/status/workspace/mcp',
      'qwen/status/workspace/skills',
      'qwen/status/workspace/providers',
    ]);
    expect(handles[0]?.agent.extMethodCalls.map((c) => c.params)).toEqual([
      { cwd: WS_A },
      { cwd: WS_A },
      { cwd: WS_A },
    ]);

    await bridge.shutdown();
  });

  it('answers /workspace/env from process state without consulting ACP, idle or live', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      },
    });

    // Idle path — daemon answers env from `process.*`; no ACP child spawn.
    const idle = await bridge.getWorkspaceEnvStatus();
    expect(idle).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });
    expect(idle.cells.length).toBeGreaterThan(0);
    expect(handles).toHaveLength(0);

    // Live path — bridge still answers locally; the ACP child sees no
    // ext-method invocation for env.
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const live = await bridge.getWorkspaceEnvStatus();
    expect(live.acpChannelLive).toBe(true);
    expect(handles).toHaveLength(1);
    expect(
      handles[0]?.agent.extMethodCalls.some((c) =>
        c.method.includes('/workspace/env'),
      ),
    ).toBe(false);

    await bridge.shutdown();
  });

  it('returns idle env envelope when statusProvider is omitted (Mode A fallback)', async () => {
    // PR 22b/2 fold-in: covers the no-provider branch in
    // `getWorkspaceEnvStatus`. Production `runQwenServe` and
    // `createServeApp` both wire `createDaemonStatusProvider()`, but
    // direct embeds (Mode A in-process consumers, future) may omit it.
    // The bridge must still answer the route — falling back to the
    // shared `createIdleEnvStatus` helper rather than throwing.
    const bridge = makeBridge({ statusProvider: undefined });

    const idle = await bridge.getWorkspaceEnvStatus();
    expect(idle).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
      cells: [],
    });

    await bridge.shutdown();
  });

  it('returns empty daemon preflight cells when statusProvider is omitted (Mode A fallback)', async () => {
    // PR 22b/2 fold-in: covers the no-provider branch in
    // `getWorkspacePreflightStatus`. ACP-side cells still render
    // (idle `not_started` placeholders here since no channel is up);
    // only the daemon-host half is empty.
    const bridge = makeBridge({ statusProvider: undefined });

    const status = await bridge.getWorkspacePreflightStatus();
    expect(status).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });

    // No daemon cells; only ACP-side `not_started` placeholders.
    const daemonCells = status.cells.filter((c) => c.locality === 'daemon');
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(daemonCells).toHaveLength(0);
    expect(acpCells.length).toBeGreaterThan(0);
    expect(acpCells.every((c) => c.status === 'not_started')).toBe(true);

    await bridge.shutdown();
  });

  it('falls back to idle env envelope when statusProvider.getEnvStatus throws', async () => {
    // PR 22b/2 wenshao [Critical] fold-in: a custom provider that
    // throws would otherwise propagate past the bridge into the route
    // handler as a 500. The catch-and-log preserves the
    // pre-injection invariant that `/workspace/env` always answers,
    // even when the daemon-host helper is sick.
    const throwingProvider = {
      async getEnvStatus(): Promise<never> {
        throw new Error('boom — env collector crashed');
      },
      async getDaemonPreflightCells(): Promise<never[]> {
        return [];
      },
    };
    const bridge = makeBridge({ statusProvider: throwingProvider });

    const env = await bridge.getWorkspaceEnvStatus();
    expect(env).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
      cells: [],
    });

    await bridge.shutdown();
  });

  it('falls back to empty daemon cells when statusProvider.getDaemonPreflightCells throws', async () => {
    // PR 22b/2 wenshao [Critical] fold-in: parallel to env — a
    // throwing preflight provider must NOT take down the route, so
    // the ACP-side cells still render even when the daemon-side
    // collector is sick.
    const throwingProvider = {
      async getEnvStatus(): Promise<never> {
        throw new Error('unused');
      },
      async getDaemonPreflightCells(): Promise<never[]> {
        throw new Error('boom — preflight collector crashed');
      },
    };
    const bridge = makeBridge({ statusProvider: throwingProvider });

    const status = await bridge.getWorkspacePreflightStatus();
    expect(status).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });
    const daemonCells = status.cells.filter((c) => c.locality === 'daemon');
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(daemonCells).toHaveLength(0);
    expect(acpCells.length).toBeGreaterThan(0);

    await bridge.shutdown();
  });

  it('returns daemon preflight cells with not_started ACP cells when idle', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      },
    });

    const status = await bridge.getWorkspacePreflightStatus();
    expect(status).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });

    // Daemon-level cells are always populated.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds).toEqual(
      expect.arrayContaining([
        'node_version',
        'cli_entry',
        'workspace_dir',
        'ripgrep',
        'git',
        'npm',
      ]),
    );

    // ACP cells fall back to `not_started` placeholders without spawning.
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(acpCells.map((c) => c.kind)).toEqual([
      'auth',
      'mcp_discovery',
      'skills',
      'providers',
      'tool_registry',
      'egress',
    ]);
    for (const cell of acpCells) {
      expect(cell.status).toBe('not_started');
    }

    expect(handles).toHaveLength(0);
  });

  it('merges daemon cells with live ACP-side preflight cells when a channel is up', async () => {
    const handles: ChannelHandle[] = [];
    const acpCells = [
      { kind: 'auth', status: 'ok', locality: 'acp' },
      { kind: 'mcp_discovery', status: 'ok', locality: 'acp' },
      { kind: 'skills', status: 'ok', locality: 'acp' },
      { kind: 'providers', status: 'ok', locality: 'acp' },
      { kind: 'tool_registry', status: 'ok', locality: 'acp' },
      { kind: 'egress', status: 'not_started', locality: 'acp' },
    ];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/workspace/preflight') {
              return { cells: acpCells };
            }
            return { cells: [] };
          },
        });
        handles.push(h);
        return h.channel;
      },
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const status = await bridge.getWorkspacePreflightStatus();
    expect(status.acpChannelLive).toBe(true);
    // Daemon cells precede ACP cells in the merged response.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds).toEqual(
      expect.arrayContaining([
        'node_version',
        'cli_entry',
        'workspace_dir',
        'ripgrep',
        'git',
        'npm',
      ]),
    );
    const liveAcpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(liveAcpCells.map((c) => [c.kind, c.status])).toEqual([
      ['auth', 'ok'],
      ['mcp_discovery', 'ok'],
      ['skills', 'ok'],
      ['providers', 'ok'],
      ['tool_registry', 'ok'],
      ['egress', 'not_started'],
    ]);
    expect(status.errors).toBeUndefined();

    await bridge.shutdown();
  });

  it('falls back to idle ACP cells + envelope error when extMethod throws mid-preflight', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: () => {
            throw new Error('agent channel closed mid-request');
          },
        });
        handles.push(h);
        return h.channel;
      },
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const status = await bridge.getWorkspacePreflightStatus();
    // Daemon cells must still render — that's the route's resilience contract.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds.length).toBeGreaterThan(0);
    // ACP cells fall back to `not_started` placeholders since the extMethod
    // call rejected.
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(acpCells.length).toBe(6);
    for (const cell of acpCells) {
      expect(cell.status).toBe('not_started');
    }
    // The envelope's `errors` array carries the bridge-side failure
    // describing which surface failed without sinking the whole route.
    // `errorKind` is best-effort via `mapDomainErrorToErrorKind`; here the
    // ACP SDK wraps the inner throw as a generic JSON-RPC "Internal
    // error" which doesn't match any of the helper's recognition rules
    // (the typed `BridgeChannelClosedError` follow-up will close that
    // gap), so we only assert the structural shape, not the tag.
    expect(status.errors).toBeDefined();
    expect(status.errors![0]).toMatchObject({
      kind: 'preflight',
      status: 'error',
    });
    expect(status.errors![0].error).toBeTruthy();

    await bridge.shutdown();
  });

  it('requests session status through the existing ACP channel', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: (method, params) => {
            if (method === 'qwen/status/session/context') {
              return {
                v: 1,
                sessionId: params['sessionId'],
                workspaceCwd: WS_A,
                state: {},
              };
            }
            return {
              v: 1,
              sessionId: params['sessionId'],
              availableCommands: [],
              availableSkills: [],
            };
          },
        });
        handles.push(h);
        return h.channel;
      },
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    await expect(
      bridge.getSessionContextStatus(session.sessionId),
    ).resolves.toMatchObject({
      sessionId: session.sessionId,
      state: {},
    });
    await expect(
      bridge.getSessionSupportedCommandsStatus(session.sessionId),
    ).resolves.toMatchObject({
      sessionId: session.sessionId,
      availableCommands: [],
      availableSkills: [],
    });
    expect(handles[0]?.agent.extMethodCalls.map((c) => c.method)).toEqual([
      'qwen/status/session/context',
      'qwen/status/session/supported_commands',
    ]);

    await bridge.shutdown();
  });

  it('rejects session status requests for unknown sessions', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });

    await expect(
      bridge.getSessionContextStatus('missing'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      bridge.getSessionSupportedCommandsStatus('missing'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('reuses an echoed daemon-issued client id on attach', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      clientId: first.clientId,
    });

    expect(second.attached).toBe(true);
    expect(second.clientId).toBe(first.clientId);

    await bridge.shutdown();
    expect(handles[0]?.killed).toBe(true);
  });

  it('detachClient unregisters only the detached client id', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    await bridge.detachClient(second.sessionId, second.clientId);

    await expect(
      bridge.sendPrompt(
        first.sessionId,
        {
          sessionId: first.sessionId,
          prompt: [{ type: 'text', text: 'still valid' }],
        },
        undefined,
        { clientId: first.clientId },
      ),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    await expect(
      bridge.sendPrompt(
        second.sessionId,
        {
          sessionId: second.sessionId,
          prompt: [{ type: 'text', text: 'detached' }],
        },
        undefined,
        { clientId: second.clientId },
      ),
    ).rejects.toBeInstanceOf(InvalidClientIdError);

    await bridge.shutdown();
  });

  it('detachClient preserves an echoed client id owned by an earlier attach', async () => {
    const bridge = makeBridge({
      channelFactory: async () => makeChannel().channel,
    });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      clientId: first.clientId,
    });
    expect(second.clientId).toBe(first.clientId);

    await bridge.detachClient(second.sessionId, second.clientId);

    await expect(
      bridge.sendPrompt(
        first.sessionId,
        {
          sessionId: first.sessionId,
          prompt: [{ type: 'text', text: 'still valid' }],
        },
        undefined,
        { clientId: first.clientId },
      ),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });

    await bridge.shutdown();
  });

  describe('recordHeartbeat', () => {
    it('updates the per-session timestamp for an anonymous heartbeat', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Anonymous heartbeats (no `X-Qwen-Client-Id`) bump only the session
      // watermark — every identified-client lookup must stay empty so a
      // future revocation policy doesn't see ghost timestamps.
      const before = Date.now();
      const result = bridge.recordHeartbeat(session.sessionId);
      const after = Date.now();

      expect(result.sessionId).toBe(session.sessionId);
      expect(result.clientId).toBeUndefined();
      expect(result.lastSeenAt).toBeGreaterThanOrEqual(before);
      expect(result.lastSeenAt).toBeLessThanOrEqual(after);

      const state = bridge.getHeartbeatState(session.sessionId);
      expect(state?.sessionLastSeenAt).toBe(result.lastSeenAt);
      expect(state?.clientLastSeenAt.size).toBe(0);

      await bridge.shutdown();
    });

    it('records per-client timestamps when a trusted client id is supplied', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = bridge.recordHeartbeat(session.sessionId, {
        clientId: session.clientId,
      });

      expect(result.clientId).toBe(session.clientId);
      const state = bridge.getHeartbeatState(session.sessionId);
      expect(state?.sessionLastSeenAt).toBe(result.lastSeenAt);
      expect(state?.clientLastSeenAt.get(session.clientId!)).toBe(
        result.lastSeenAt,
      );

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError on unknown sessions', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      // No `session/spawnOrAttach` first — the bridge must reject before
      // touching any timestamp store.
      expect(() => bridge.recordHeartbeat('missing')).toThrow(
        SessionNotFoundError,
      );
      expect(bridge.getHeartbeatState('missing')).toBeUndefined();
      await bridge.shutdown();
    });

    it('rejects an unknown client id without bumping any timestamp', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Pre-validation guarantees an attacker holding a valid bearer
      // token can't mask client absence by spamming heartbeats with
      // forged ids — `sessionLastSeenAt` must stay undefined here.
      expect(() =>
        bridge.recordHeartbeat(session.sessionId, { clientId: 'forged' }),
      ).toThrow(InvalidClientIdError);

      const state = bridge.getHeartbeatState(session.sessionId);
      expect(state?.sessionLastSeenAt).toBeUndefined();
      expect(state?.clientLastSeenAt.size).toBe(0);

      await bridge.shutdown();
    });

    it('drops per-client last-seen on detach but preserves the session watermark', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      bridge.recordHeartbeat(session.sessionId, { clientId: session.clientId });

      const before = bridge.getHeartbeatState(session.sessionId);
      expect(before?.clientLastSeenAt.get(session.clientId!)).toBeDefined();

      await bridge.detachClient(session.sessionId, session.clientId);

      const after = bridge.getHeartbeatState(session.sessionId);
      // session watermark stays — diagnostics still see "this session
      // was alive at T"; per-client entry is gone since the client
      // ref-count hit zero.
      expect(after?.sessionLastSeenAt).toBe(before?.sessionLastSeenAt);
      expect(after?.clientLastSeenAt.size).toBe(0);

      await bridge.shutdown();
    });

    it('returns a snapshot map that callers cannot use to mutate live state', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      bridge.recordHeartbeat(session.sessionId, { clientId: session.clientId });

      const snapshot = bridge.getHeartbeatState(session.sessionId);
      // Mutating the returned map must NOT leak into the bridge — the
      // accessor exists so future PR 12 read-only routes can serialize
      // a snapshot without coupling to internal storage.
      (snapshot!.clientLastSeenAt as Map<string, number>).set('attacker', 0);

      const fresh = bridge.getHeartbeatState(session.sessionId);
      expect(fresh?.clientLastSeenAt.has('attacker')).toBe(false);

      await bridge.shutdown();
    });
  });

  it('loads an existing ACP session and registers it for daemon routes', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: () => ({ configOptions: [] }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const loaded = await bridge.loadSession({
      sessionId: 'persisted-1',
      workspaceCwd: WS_A,
    });

    expect(loaded).toEqual({
      sessionId: 'persisted-1',
      workspaceCwd: WS_A,
      attached: false,
      clientId: expect.stringMatching(/^client_/),
      createdAt: expect.any(String),
      state: { configOptions: [] },
    });
    expect(handles[0]?.agent.loadSessionCalls).toEqual([
      { sessionId: 'persisted-1', cwd: WS_A, mcpServers: [] },
    ]);
    expect(bridge.sessionCount).toBe(1);

    await expect(
      bridge.sendPrompt('persisted-1', {
        sessionId: 'ignored',
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(handles[0]?.agent.promptCalls[0]?.sessionId).toBe('persisted-1');

    await bridge.shutdown();
  });

  it('buffers load replay events until the restored session is registered', async () => {
    let capturedConn: AgentSideConnection | undefined;
    const factory: ChannelFactory = async () => {
      const { clientStream, agentStream } = createInMemoryChannel();
      const fakeAgent = new FakeAgent({
        loadSessionImpl: async (p) => {
          await capturedConn!.sessionUpdate({
            sessionId: p.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed' },
            },
          });
          return {};
        },
      });
      capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
      return {
        stream: clientStream,
        exited: new Promise<
          | { exitCode: number | null; signalCode: NodeJS.Signals | null }
          | undefined
        >(() => {}),
        kill: async () => {},
        killSync: () => {},
      };
    };
    const bridge = makeBridge({ channelFactory: factory });

    const loaded = await bridge.loadSession({
      sessionId: 'persisted-history',
      workspaceCwd: WS_A,
    });
    const iterator = bridge
      .subscribeEvents(loaded.sessionId, { lastEventId: 0 })
      [Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for replay event')),
          500,
        );
      }),
    ]);
    if (timer) clearTimeout(timer);

    expect(next.value.type).toBe('session_update');
    expect(next.value.data).toMatchObject({
      sessionId: 'persisted-history',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'replayed' },
      },
    });

    await iterator.return?.();
    await bridge.shutdown();
  });

  it('resumes an existing ACP session without calling session/load', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        resumeSessionImpl: () => ({ modes: null }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const resumed = await bridge.resumeSession({
      sessionId: 'persisted-2',
      workspaceCwd: WS_A,
    });

    expect(resumed).toEqual({
      sessionId: 'persisted-2',
      workspaceCwd: WS_A,
      attached: false,
      clientId: expect.stringMatching(/^client_/),
      createdAt: expect.any(String),
      state: { modes: null },
    });
    expect(handles[0]?.agent.loadSessionCalls).toHaveLength(0);
    expect(handles[0]?.agent.resumeSessionCalls).toEqual([
      { sessionId: 'persisted-2', cwd: WS_A, mcpServers: [] },
    ]);

    await bridge.shutdown();
  });

  it('attaches to an already live session and returns the cached restore state', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        // `_meta` is the permissive escape hatch on the ACP response
        // schema — any record-shaped payload survives the wire. The
        // assertions only need the bridge to forward it intact.
        loadSessionImpl: () => ({ _meta: { tag: 'restored-foo' } }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const loaded = await bridge.loadSession({
      sessionId: 'persisted-3',
      workspaceCwd: WS_A,
    });
    const attached = await bridge.resumeSession({
      sessionId: 'persisted-3',
      workspaceCwd: WS_A,
    });

    expect(loaded.attached).toBe(false);
    expect(loaded.state).toEqual({ _meta: { tag: 'restored-foo' } });
    // Late attachers must observe the SAME restore state the original
    // caller saw — `entry.restoreState` is cached at load time.
    expect(attached).toEqual({
      sessionId: 'persisted-3',
      workspaceCwd: WS_A,
      attached: true,
      clientId: expect.stringMatching(/^client_/),
      createdAt: expect.any(String),
      state: { _meta: { tag: 'restored-foo' } },
    });
    expect(attached.clientId).not.toBe(loaded.clientId);
    expect(handles[0]?.agent.loadSessionCalls).toHaveLength(1);
    expect(handles[0]?.agent.resumeSessionCalls).toHaveLength(0);

    await bridge.shutdown();
  });

  it('propagates the original ACP state to coalesced restore waiters', async () => {
    let releaseLoad: ((value: LoadSessionResponse) => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = resolve;
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const first = bridge.loadSession({
      sessionId: 'coalesce-state',
      workspaceCwd: WS_A,
    });
    // Wait for the first call to register inFlight before issuing
    // the second.
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();
    const second = bridge.loadSession({
      sessionId: 'coalesce-state',
      workspaceCwd: WS_A,
    });

    releaseLoad!({ _meta: { tag: 'restored-baz' } });
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.attached).toBe(false);
    expect(r1.state).toEqual({ _meta: { tag: 'restored-baz' } });
    expect(r2.attached).toBe(true);
    // Coalesced waiter sees the same state, not `{}`.
    expect(r2.state).toEqual({ _meta: { tag: 'restored-baz' } });

    await bridge.shutdown();
  });

  it('survives spawn-owner disconnect kill while a coalesced restore is mid-flight', async () => {
    let releaseLoad: ((value: LoadSessionResponse) => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = resolve;
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const first = bridge.loadSession({
      sessionId: 'race-target',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    // Second caller coalesces synchronously and reserves the attach.
    const second = bridge.loadSession({
      sessionId: 'race-target',
      workspaceCwd: WS_A,
    });

    releaseLoad!({});
    const r1 = await first;
    expect(r1.attached).toBe(false);

    // First caller "disconnected" — simulate by issuing the same
    // disconnect-cleanup the route handler would. The
    // `requireZeroAttaches` guard MUST see B's reserved attach and
    // skip the kill, otherwise B observes a 404'd sessionId on its
    // next call.
    await bridge.killSession(r1.sessionId, { requireZeroAttaches: true });

    // The session must still be alive for B.
    expect(bridge.sessionCount).toBe(1);
    const r2 = await second;
    expect(r2.attached).toBe(true);
    expect(r2.sessionId).toBe('race-target');

    await bridge.shutdown();
  });

  it('does not kill the channel when the last live session leaves while a restore is pending', async () => {
    let releaseLoad: ((value: LoadSessionResponse) => void) | undefined;
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = resolve;
          }),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    // Spawn a regular session first, then kick off a slow restore on
    // the same channel.
    const spawned = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const restore = bridge.loadSession({
      sessionId: 'pending-restore',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    // Kill the only registered session; the channel must NOT die
    // because pendingRestoreIds is non-empty.
    await bridge.killSession(spawned.sessionId);
    expect(handles[0]?.killed).toBe(false);

    // Let the restore finish — it joins the channel as the new
    // sole session.
    releaseLoad!({});
    const restored = await restore;
    expect(restored.sessionId).toBe('pending-restore');
    expect(bridge.sessionCount).toBe(1);
    expect(handles[0]?.killed).toBe(false);

    await bridge.shutdown();
  });

  it('does not promote a restored session into the omitted-id attach default', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: () => ({}),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    await bridge.loadSession({
      sessionId: 'persisted-explicit',
      workspaceCwd: WS_A,
    });
    // A subsequent omitted-id `POST /session` (single scope) MUST
    // create a fresh session rather than silently attaching to the
    // explicitly restored one.
    const spawned = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(spawned.sessionId).not.toBe('persisted-explicit');
    expect(spawned.attached).toBe(false);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('maps an ACP missing persisted session to SessionNotFoundError', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: (p) => {
          throw RequestError.resourceNotFound(`session:${p.sessionId}`);
        },
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    await expect(
      bridge.loadSession({
        sessionId: 'missing-persisted',
        workspaceCwd: WS_A,
      }),
    ).rejects.toMatchObject({
      name: 'SessionNotFoundError',
      sessionId: 'missing-persisted',
    });
    expect(bridge.sessionCount).toBe(0);
    expect(handles[0]?.killed).toBe(false);

    await bridge.shutdown();
  });

  // The `isAcpSessionResourceNotFound` `message`-fallback path can't
  // be exercised through the FakeAgent end-to-end: the ACP SDK
  // normalizes non-RequestError throws to `-32603 Internal error`,
  // so a fake-agent thrown plain Object with `code: -32002` arrives
  // at the bridge as -32603 with the original message buried under
  // `data.details`. The fallback covers ACP variants that emit the
  // URI in `message` directly (without `data.uri`); the primary
  // `data.uri` path is covered by the test above. The exact-match
  // tightening (vs. substring) is exercised by inspection.

  it('rejects load while a resume for the same session is in flight', async () => {
    let releaseResume: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        resumeSessionImpl: () =>
          new Promise<ResumeSessionResponse>((resolve) => {
            releaseResume = () => resolve({});
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const resume = bridge.resumeSession({
      sessionId: 'persisted-race',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseResume; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseResume).toBeDefined();

    await expect(
      bridge.loadSession({
        sessionId: 'persisted-race',
        workspaceCwd: WS_A,
      }),
    ).rejects.toBeInstanceOf(RestoreInProgressError);

    releaseResume?.();
    await resume;
    await bridge.shutdown();
  });

  it('rejects resume while a load for the same session is in flight (mirror of load-on-resume)', async () => {
    let releaseLoad: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = () => resolve({});
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const load = bridge.loadSession({
      sessionId: 'persisted-mirror',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    // Resume coalescing onto load would silently subscribe the
    // resume client to history-replay frames it explicitly opted
    // out of; it must throw instead.
    await expect(
      bridge.resumeSession({
        sessionId: 'persisted-mirror',
        workspaceCwd: WS_A,
      }),
    ).rejects.toBeInstanceOf(RestoreInProgressError);

    releaseLoad?.();
    await load;
    await bridge.shutdown();
  });

  it('does not kill a shared channel when one of multiple pending restores fails', async () => {
    let releaseGood: (() => void) | undefined;
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        loadSessionImpl: (p) => {
          if (p.sessionId === 'bad-restore') {
            throw RequestError.resourceNotFound(`session:${p.sessionId}`);
          }
          return new Promise<LoadSessionResponse>((resolve) => {
            releaseGood = () => resolve({});
          });
        },
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const good = bridge.loadSession({
      sessionId: 'good-restore',
      workspaceCwd: WS_A,
    });
    for (
      let i = 0;
      i < 50 && handles[0]?.agent.loadSessionCalls.length !== 1;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(handles[0]?.agent.loadSessionCalls[0]?.sessionId).toBe(
      'good-restore',
    );

    await expect(
      bridge.loadSession({
        sessionId: 'bad-restore',
        workspaceCwd: WS_A,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(handles[0]?.killed).toBe(false);

    releaseGood?.();
    await expect(good).resolves.toMatchObject({
      sessionId: 'good-restore',
      attached: false,
    });

    await bridge.shutdown();
  });

  it('does not surface an unhandledRejection when the channel exits after a successful restore', async () => {
    // Regression for the dangling-rejection bug: `transportClosed`
    // is a fresh `.then(throw)` promise per restore. If `withTimeout`
    // wins the race, `transportClosed` stays pending and a later
    // channel exit fires the inner `throw` with no observer attached
    // — Node 22 logs `unhandledRejection`, and
    // `--unhandled-rejections=throw` deployments crash the daemon.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ loadSessionImpl: () => ({}) });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const restored = await bridge.loadSession({
        sessionId: 'persisted-leak',
        workspaceCwd: WS_A,
      });
      expect(restored.attached).toBe(false);
      // Now resolve `channel.exited` AFTER the restore promise has
      // already settled. `transportClosed` was the race-loser, so
      // its `.then(throw)` fires now. With the `.catch(() => {})`
      // suppression in place, no `unhandledRejection` is emitted;
      // without it, the test would observe one.
      handles[0]!.crash({ exitCode: null, signalCode: null });
      // Give the rejection a tick to surface if it were unhandled.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await bridge.shutdown();
    }
  });

  it('shutdown awaits in-flight restores before resolving', async () => {
    // `shutdown()` adds `inFlightRestoreAwaits` to the wait list so
    // shutting the daemon down doesn't orphan a half-completed
    // restore. Verify by racing the restore-settled signal against
    // the shutdown-resolved signal: if shutdown is awaiting the
    // restore, the restore MUST settle first (or simultaneously
    // — `Promise.race` ties go to the earlier-registered handler,
    // which is the restore here).
    let releaseLoad: (() => void) | undefined;
    const factory: ChannelFactory = async () =>
      makeChannel({
        loadSessionImpl: () =>
          new Promise<LoadSessionResponse>((resolve) => {
            releaseLoad = () => resolve({});
          }),
      }).channel;
    const bridge = makeBridge({ channelFactory: factory });

    const restore = bridge.loadSession({
      sessionId: 'persisted-shutdown',
      workspaceCwd: WS_A,
    });
    for (let i = 0; i < 50 && !releaseLoad; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseLoad).toBeDefined();

    const restoreFirst = restore
      .catch(() => undefined)
      .then(() => 'restore' as const);
    const shutdownFirst = bridge.shutdown().then(() => 'shutdown' as const);
    const winner = await Promise.race([restoreFirst, shutdownFirst]);
    expect(winner).toBe('restore');
    // Both must have settled cleanly by the end.
    await Promise.all([restoreFirst, shutdownFirst]);
  });

  it('rejects cross-workspace requests with WorkspaceMismatchError (#3803 §02)', async () => {
    // Per #3803 §02 (1 daemon = 1 workspace), `spawnOrAttach` calls
    // whose canonical `workspaceCwd` doesn't match `boundWorkspace`
    // throw `WorkspaceMismatchError`. The server route translates
    // this to a 400 with `code: 'workspace_mismatch'` so clients can
    // route to (or spawn) a daemon for the other workspace.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(a.sessionId).toBe(SESS_A);

    // Cross-workspace POST throws before touching the channel.
    // Single `.catch` capture — assert instance + carried fields off
    // the same caught value rather than firing the rejection twice.
    const err = await bridge
      .spawnOrAttach({ workspaceCwd: WS_B })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceMismatchError);
    expect((err as WorkspaceMismatchError).bound).toBe(WS_A);
    expect((err as WorkspaceMismatchError).requested).toBe(WS_B);

    // Only the original WS_A spawn succeeded — no channel spawned for WS_B.
    expect(handles).toHaveLength(1);
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('WorkspaceMismatchError truncates oversized `requested` to MAX_WORKSPACE_PATH_LENGTH (defense-in-depth)', () => {
    // The route-level cap in `server.ts` rejects oversized `cwd`
    // bodies before reaching the bridge, but `WorkspaceMismatchError`
    // can be constructed directly by other callers (tests, embeds,
    // future entry points) or by passing pre-validated paths that
    // somehow grew. The constructor interpolates `requested` into
    // `.message` twice + downstream code echoes it on stderr +
    // `res.json` — without truncation a 10 MB string amplifies
    // ~6× per request. The truncation here is the cross-caller
    // belt-and-suspenders defense.
    const oversized = '/' + 'a'.repeat(MAX_WORKSPACE_PATH_LENGTH * 2);
    const err = new WorkspaceMismatchError('/work/bound', oversized);
    expect(err.requested.length).toBeLessThanOrEqual(
      MAX_WORKSPACE_PATH_LENGTH + 32, // truncation marker overhead
    );
    expect(err.requested.endsWith('…[truncated]')).toBe(true);
    // `.message` interpolates `requested` twice; both go through the
    // truncated form, so the message is bounded too.
    expect(err.message.length).toBeLessThan(
      MAX_WORKSPACE_PATH_LENGTH * 2 + 1024,
    );
    // Bound is operator-controlled — not truncated.
    expect(err.bound).toBe('/work/bound');
  });

  it('WorkspaceMismatchError passes through `requested` shorter than MAX_WORKSPACE_PATH_LENGTH untouched', () => {
    // Common case: legitimate `requested` paths (PATH_MAX is 4096 on
    // Linux, 1024 on macOS) should not be modified.
    const normal = '/work/different';
    const err = new WorkspaceMismatchError('/work/bound', normal);
    expect(err.requested).toBe(normal);
    expect(err.requested.endsWith('…[truncated]')).toBe(false);
  });

  it('creates fresh session per call under sessionScope:thread (Stage 1.5 multi-session: shares channel)', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Distinct sessions, both freshly created (neither is an attach).
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(false);
    // Stage 1.5 multi-session: the two thread-scope calls SHARE the
    // workspace's `qwen --acp` child. Only one `channelFactory` call.
    // Each `newSession()` call to the agent produces a distinct id.
    expect(handles).toHaveLength(1);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('per-request sessionScope:thread overrides daemon-wide single (#4175 PR 5)', async () => {
    // The daemon-wide default is `'single'` (the production default), so
    // a second `spawnOrAttach` against the same workspace WITHOUT a
    // per-request override would normally reuse the first session.
    // With `sessionScope: 'thread'` on the request, the bridge must
    // create a distinct session — proving the per-request override
    // wins over the construction-time default.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'single',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(false);
    expect(handles).toHaveLength(1); // shared channel, distinct sessions
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('per-request sessionScope:single overrides daemon-wide thread (#4175 PR 5)', async () => {
    // Symmetric coverage: a daemon launched with `--sessionScope thread`
    // (uncommon but supported) must still honor `'single'` on the
    // request. The second call must reuse the first session.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const first = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    const second = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(true);
    expect(handles).toHaveLength(1);
    expect(bridge.sessionCount).toBe(1);

    await bridge.shutdown();
  });

  it('thread-scope first call does NOT pollute the single-scope attach slot (#4175 PR 5 mixed-scope leak)', async () => {
    // Regression for the leak the code-reviewer flagged: pre-fix, a
    // thread-scope spawn ALSO claimed the empty `defaultEntry` slot,
    // so a subsequent omitted-scope call (`effectiveScope = 'single'`
    // under the daemon default) would attach to what the first caller
    // was told was an isolated session. The fix gates the
    // `defaultEntry` stamp on `effectiveScope === 'single'` inside
    // `doSpawn`. This test exercises the exact mixed sequence and
    // asserts the omitted call gets a FRESH session.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'single', // daemon-wide default, the production shape
      channelFactory: factory,
    });

    const isolated = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'thread',
    });
    const shared = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    expect(isolated.sessionId).not.toBe(shared.sessionId);
    expect(isolated.attached).toBe(false);
    expect(shared.attached).toBe(false); // fresh, NOT attached to `isolated`
    expect(bridge.sessionCount).toBe(2);

    // A second omitted-scope call MUST attach to `shared` (the first
    // single-scope session), proving the slot is correctly populated
    // by the second call rather than by the thread-scope first call.
    const reattach = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(reattach.sessionId).toBe(shared.sessionId);
    expect(reattach.attached).toBe(true);

    await bridge.shutdown();
  });

  it('symmetric mixed-scope leak: single-first does NOT trap a later thread call into the single slot', async () => {
    // Mirror of the daemon-default-`'single'` + thread-first leak
    // regression: under daemon-default-`'thread'` an explicit `'single'`
    // first call legitimately claims the attach slot, and a SECOND
    // omitted-scope call (`effectiveScope = 'thread'` under the daemon
    // default) must then create a fresh session, NOT attach to the
    // single-scope first session. Confirms `effectiveScope` is what
    // gates attach-reuse, not just the daemon-wide default.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    const single = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    const omitted = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    expect(single.attached).toBe(false);
    expect(omitted.attached).toBe(false); // thread under daemon default
    expect(omitted.sessionId).not.toBe(single.sessionId);
    expect(bridge.sessionCount).toBe(2);

    // A second explicit `'single'` MUST attach to `single`, proving
    // the slot stayed correctly populated by the first call.
    const reattachSingle = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
      sessionScope: 'single',
    });
    expect(reattachSingle.sessionId).toBe(single.sessionId);
    expect(reattachSingle.attached).toBe(true);

    await bridge.shutdown();
  });

  it("concurrent mixed-scope spawns don't collide on the in-flight tracker (#4175 PR 5)", async () => {
    // The in-flight coalescing key is `workspaceKey` for `'single'` and
    // `${workspaceKey}#${randomUUID()}` for `'thread'`. A simultaneous
    // single+thread pair against the same workspace must not collide:
    // the `'single'` caller's `inFlightSpawns.get(workspaceKey)` must
    // not match the `'thread'` caller's tracker, and vice versa.
    //
    // Slow `initialize` so both calls reach `inFlightSpawns` before
    // either's spawn resolves — exercises the actual race window. The
    // shared workspace channel is created once (Stage 1.5
    // multi-session); the slow init also serializes the second
    // `ensureChannel` waiter under the same mutex, but the
    // `inFlightSpawns` tracker key differs by scope so the two
    // resolutions stay isolated.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        sessionIdPrefix: `s${handles.length}`,
        initializeDelayMs: 30,
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'single', // production default
      channelFactory: factory,
    });

    // Fire both calls before either's spawn has resolved.
    const [singleSess, threadSess] = await Promise.all([
      bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'single',
      }),
      bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      }),
    ]);

    // Distinct sessions — the thread caller did NOT attach to the
    // in-flight single spawn (or vice versa).
    expect(singleSess.sessionId).not.toBe(threadSess.sessionId);
    expect(singleSess.attached).toBe(false);
    expect(threadSess.attached).toBe(false);
    expect(bridge.sessionCount).toBe(2);

    await bridge.shutdown();
  });

  it('rejects an invalid per-request sessionScope with InvalidSessionScopeError', async () => {
    // Defense-in-depth: the route-layer validates strings, but a direct
    // bridge caller (test, embed, future entry point) could pass a
    // non-enum value. Throw a typed `InvalidSessionScopeError` so the
    // route's `sendBridgeError` translator returns the same 400
    // `code: 'invalid_session_scope'` it would have if the route had
    // caught the bad value first — keeping both layers in agreement
    // on the wire shape.
    const bridge = makeBridge();
    const err = await bridge
      .spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'bogus' as unknown as 'single',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSessionScopeError);
    expect((err as InvalidSessionScopeError).sessionScope).toBe('bogus');
    expect((err as InvalidSessionScopeError).message).toMatch(
      /Invalid sessionScope/,
    );
  });

  it('rejects relative workspace paths', async () => {
    const bridge = makeBridge({
      channelFactory: async () => {
        throw new Error('factory should not be called');
      },
    });
    await expect(
      bridge.spawnOrAttach({ workspaceCwd: 'relative/path' }),
    ).rejects.toThrow(/absolute path/);
  });

  it('canonicalizes the workspace key (single-scope reuses normalized paths)', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel();
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const aNoisy = await bridge.spawnOrAttach({ workspaceCwd: '/work/./a' });

    expect(a.sessionId).toBe(aNoisy.sessionId);
    expect(aNoisy.attached).toBe(true);
    expect(handles).toHaveLength(1);

    await bridge.shutdown();
  });

  it('kills the spawned channel and rejects when initialize fails', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({
        initializeThrows: new Error('handshake refused'),
      });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });

    // ACP SDK rewrites unhandled exceptions to a JSON-RPC Internal error
    // object (code -32603); the original message text is intentionally not
    // forwarded. Assert on rejection + resource cleanup.
    const err = await bridge.spawnOrAttach({ workspaceCwd: WS_A }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('times out a stuck initialize', async () => {
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ initializeDelayMs: 5_000 });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      channelFactory: factory,
      initializeTimeoutMs: 50,
    });

    await expect(bridge.spawnOrAttach({ workspaceCwd: WS_A })).rejects.toThrow(
      /initialize timed out/,
    );
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('shutdown kills the live channel and its multiplexed sessions', async () => {
    // Stage 1.5 multi-session under single-workspace mode (#3803 §02):
    // a daemon hosts one channel with N sessions multiplexed on it.
    // Shutdown kills that one channel and tears down every multiplexed
    // session.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: 's' });
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({
      sessionScope: 'thread',
      channelFactory: factory,
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(bridge.sessionCount).toBe(2);
    expect(handles).toHaveLength(1); // one channel multiplexing two sessions

    await bridge.shutdown();
    expect(handles[0]?.killed).toBe(true);
    expect(bridge.sessionCount).toBe(0);
  });

  it('killAllSync force-kills the live channel mid-shutdown (BkUyD)', async () => {
    // tanzhenxin BkUyD regression: pre-fix, `shutdown()` cleared the
    // live-channel reference BEFORE awaiting the child's SIGTERM
    // grace. A mid-drain double-Ctrl+C invoked `killAllSync`, found
    // nothing to force-kill, and `process.exit(1)` orphaned the
    // child. Under #3803 §02 the bridge has at most one channel, but
    // the invariant is the same: `channelInfo` MUST stay set until
    // `channel.exited` fires (OS-level reap), not be eagerly cleared
    // by `shutdown()`.
    const killSyncInvoked: string[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: 's' });
      const realKillSync = h.channel.killSync;
      h.channel = {
        ...h.channel,
        kill: () =>
          // Never resolve — simulates a stuck SIGTERM grace window.
          new Promise(() => {}),
        killSync: () => {
          killSyncInvoked.push('called');
          realKillSync();
        },
      };
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Kick off shutdown — its `channel.kill()` will hang on the
    // never-resolving Promise above, so the entry maps clear but
    // the channel-kill await never finishes. This is the mid-drain
    // state.
    const shutdownPromise = bridge.shutdown();
    // Yield twice so shutdown's sync prefix runs (clear maps,
    // publish session_died, start awaits).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Operator double-Ctrl+C arrives now.
    bridge.killAllSync();

    // The channel's killSync fired. Pre-fix this would have been an
    // empty array because `channelInfo` was cleared in shutdown's
    // sync prefix.
    expect(killSyncInvoked).toHaveLength(1);

    // Cleanup: the never-resolving kill keeps shutdownPromise
    // pending forever. Don't await it (would hang the test). The
    // test runner GCs it when this `it` returns.
    void shutdownPromise;
  });

  it('killAllSync force-kills the channel during the initialize handshake (tanzhenxin cold-spawn-window)', async () => {
    // tanzhenxin cold-spawn-window finding: the agent child exists
    // from the moment `channelFactory(boundWorkspace)` returns, but
    // pre-fix `aliveChannels.add(info)` ran only AFTER the
    // `initialize` handshake completed (up to `initTimeoutMs`,
    // default 10s). A double-Ctrl+C in that handshake window played
    // out as: first SIGINT entered `shutdown()` and awaited the
    // in-flight spawn; second SIGINT called `killAllSync()` against
    // an empty `aliveChannels` (the channel hadn't been added yet)
    // and `process.exit(1)` orphaned the child. The fix moves the
    // add + the `channel.exited` handler registration BEFORE the
    // `initialize` await; this test pins that the channel is
    // reachable via `killAllSync` during the handshake.
    const killSyncCalls: string[] = [];
    const factory: ChannelFactory = async () => {
      // Bespoke agent whose `initialize` never resolves — that's the
      // handshake-hanging window the finding is about. A real agent
      // can spend up to `initTimeoutMs` ms here before the bridge's
      // `withTimeout` aborts it.
      const ab = new TransformStream<Uint8Array, Uint8Array>();
      const ba = new TransformStream<Uint8Array, Uint8Array>();
      const clientStream = ndJsonStream(ab.writable, ba.readable);
      const agentStream = ndJsonStream(ba.writable, ab.readable);
      let resolveExited:
        | ((
            info?:
              | {
                  exitCode: number | null;
                  signalCode: NodeJS.Signals | null;
                }
              | undefined,
          ) => void)
        | undefined;
      const exited = new Promise<
        | { exitCode: number | null; signalCode: NodeJS.Signals | null }
        | undefined
      >((r) => {
        resolveExited = r;
      });
      const stuckAgent: Agent = {
        async initialize() {
          // Hang forever — the bridge's `withTimeout` would normally
          // bound this, but the test asserts behavior DURING the
          // handshake, so we let it sit until killAllSync resolves
          // `exited` and tears the channel down externally.
          return new Promise<InitializeResponse>(() => {});
        },
        async newSession() {
          throw new Error('newSession should not be reached');
        },
        async loadSession() {
          throw new Error('loadSession should not be reached');
        },
        async authenticate() {
          throw new Error('authenticate should not be reached');
        },
        async prompt() {
          throw new Error('prompt should not be reached');
        },
        async cancel() {
          /* no-op */
        },
        async setSessionMode() {
          throw new Error('setSessionMode should not be reached');
        },
        async setSessionConfigOption() {
          throw new Error('setSessionConfigOption should not be reached');
        },
      };
      new AgentSideConnection(() => stuckAgent, agentStream);
      return {
        stream: clientStream,
        exited,
        kill: async () => {
          resolveExited!(undefined);
        },
        killSync: () => {
          killSyncCalls.push('called');
          resolveExited!(undefined);
        },
      };
    };
    const bridge = makeBridge({
      channelFactory: factory,
      // Bump initializeTimeoutMs so it doesn't race with the
      // killAllSync we fire below. We're NOT testing the timeout
      // path — we're testing the cold-spawn window before it.
      initializeTimeoutMs: 30_000,
    });

    // Kick off a spawn — `initialize` hangs forever in this fake,
    // so the spawn promise never resolves naturally. Don't await
    // (would block the test); `.catch` keeps the rejection from
    // being unhandled when killAllSync eventually tears things down.
    const spawnPromise = bridge
      .spawnOrAttach({ workspaceCwd: WS_A })
      .catch(() => undefined);

    // Yield enough microtasks for `channelFactory` to return AND the
    // bridge's `info` creation + `aliveChannels.add(info)` + the
    // `channel.exited` handler registration to all run BEFORE the
    // bridge enters `await initialize`. Pre-fix the alive-set add
    // sat AFTER initialize, so any number of yields here would still
    // find an empty set when killAllSync fires below.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // Operator double-Ctrl+C arrives during the handshake window.
    bridge.killAllSync();

    // Post-fix expectation: channel was added to `aliveChannels`
    // BEFORE the `initialize` await, so killAllSync iterates a set
    // containing it and fires killSync. Pre-fix this array would
    // have been empty — and `process.exit(1)` after this would have
    // orphaned the agent child.
    expect(killSyncCalls).toEqual(['called']);

    // Cleanup: spawnPromise resolves on its own once killSync's
    // `resolveExited` propagates through the bridge's
    // `channel.exited` handler and the IIFE's catch reaps the half-
    // initialized channel.
    void spawnPromise;
  });

  it('killSession marks the channel dying so concurrent spawnOrAttach gets a fresh channel', async () => {
    // After the last session is killed, `channel.kill()` runs through
    // its SIGTERM grace window before SIGKILL — up to 10s in the real
    // factory. During that window a concurrent `spawnOrAttach` MUST
    // get a FRESH channel, never the dying one. Pre-fix: `channelInfo`
    // stayed set with no `isDying` flag, so `ensureChannel` returned
    // the dying channel and `newSession()` either succeeded onto a
    // transport about to close (landing a sessionId that 404s on the
    // next request when `channel.exited` fires) or hung until the
    // newSession timeout. Fix: `killSession` sets `isDying = true`
    // synchronously before `await ci.channel.kill()`; `ensureChannel`
    // skips dying channels and spawns a fresh one.
    const handles: ChannelHandle[] = [];
    const factory: ChannelFactory = async () => {
      const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
      // Make kill() hang forever so the SIGTERM grace window stays
      // open for the test (simulates a slow-to-exit child).
      h.channel = { ...h.channel, kill: () => new Promise(() => {}) };
      handles.push(h);
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(handles).toHaveLength(1);

    // Kick off killSession (the only session leaving triggers the
    // channel teardown). The kill() Promise never resolves, so the
    // method's await hangs — we fire-and-forget.
    const killPromise = bridge.killSession(first.sessionId);
    // Yield once so killSession's sync prefix runs (it marks
    // `isDying = true` synchronously before `await ci.channel.kill()`).
    await new Promise((r) => setImmediate(r));

    // A new spawn MUST get a FRESH channel, not reuse the dying one.
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(handles).toHaveLength(2);
    expect(second.sessionId).not.toBe(first.sessionId);
    // The second session is on the fresh channel (handles[1]), not
    // multiplexed onto the dying one (handles[0]).
    expect(handles[1]?.agent.newSessionCalls).toHaveLength(1);

    // Cleanup: both channels' kill() never resolves (factory above
    // overrides it). Don't await killSession or shutdown — same
    // pattern as the BkUyD test above. The test runner GCs the
    // dangling promises when this `it` returns.
    void killPromise;
  });

  it('doSpawn newSession-failure marks the empty channel dying so the next spawn gets a fresh one', async () => {
    // Parallel to "killSession marks the channel dying" above, but
    // covers the OTHER `isDying = true` site: `doSpawn`'s
    // `connection.newSession()` rejection path. When the channel's
    // first/only `newSession` fails (auth, bad config, agent crash
    // during init), the bridge marks the empty channel dying and
    // kicks off `channel.kill()`. The kill awaits a SIGTERM grace,
    // and during that window the next `spawnOrAttach` retry MUST
    // get a FRESH channel — not reuse the one whose newSession just
    // failed (which would re-issue newSession to a transport about
    // to close, almost certainly hanging or failing identically).
    // Pre-fix the equivalent code eagerly cleared `channelInfo` so
    // the BkUyD invariant was violated; the round-2 fix uses
    // `isDying` + `aliveChannels` instead.
    let factoryCount = 0;
    const killSyncCalls: string[] = [];
    const factory: ChannelFactory = async () => {
      const tag = `c${factoryCount++}`;
      // First channel's newSession rejects; subsequent channels succeed.
      const firstChannel = factoryCount === 1;
      const h = makeChannel({
        sessionIdPrefix: tag,
        newSessionImpl: firstChannel
          ? () => {
              throw new Error('agent refused newSession (test)');
            }
          : undefined,
      });
      const realKillSync = h.channel.killSync;
      h.channel = {
        ...h.channel,
        // Hang kill() so the SIGTERM grace stays open for the
        // duration of the test. We don't await spawnOrAttach's
        // rejection (which would block on the kill) — instead we
        // catch it via .catch() and yield enough cycles for the
        // sync prefix (`isDying = true`) to settle.
        kill: () => new Promise(() => {}),
        killSync: () => {
          killSyncCalls.push(tag);
          realKillSync();
        },
      };
      return h.channel;
    };
    // Thread scope so calls don't coalesce via `inFlightSpawns` —
    // the second spawn must not wait on the first one's hanging
    // doSpawn. Without thread scope the single-scope coalescing
    // would make `spawnOrAttach` call 2 await call 1's in-flight
    // promise (still pending on the never-resolving kill).
    const bridge = makeBridge({
      channelFactory: factory,
      sessionScope: 'thread',
    });

    // First spawn: newSession on c0 fails. `doSpawn`'s catch runs
    // `ci.isDying = true` synchronously, then `await ci.channel.kill()`
    // (hangs in this test). The original error never propagates
    // because the kill never resolves — so we DON'T await the
    // rejection. Capture it for cleanup.
    let firstErr: unknown;
    const firstAttempt = bridge
      .spawnOrAttach({ workspaceCwd: WS_A })
      .catch((err) => {
        firstErr = err;
      });

    // Yield enough times for `ensureChannel`'s spawn to complete,
    // newSession to reject, and doSpawn's catch sync prefix
    // (`ci.isDying = true`) to run before the kill-await hangs.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(factoryCount).toBe(1);

    // Second attempt: `ensureChannel` finds c0 with `isDying: true`,
    // skips it, spawns a fresh c1. Pre-fix the equivalent code
    // (eagerly clearing `channelInfo`) made this work via a
    // different mechanism that violated BkUyD; the current fix uses
    // `isDying` + `aliveChannels` for both correctness AND BkUyD.
    const second = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(factoryCount).toBe(2);
    expect(second.attached).toBe(false);

    // Both channels live in `aliveChannels` (c0 is dying but its
    // `channel.exited` hasn't fired; c1 is freshly attached).
    // `killAllSync` MUST find both.
    bridge.killAllSync();
    expect(killSyncCalls.sort()).toEqual(['c0', 'c1']);

    // Cleanup: firstAttempt is pending forever (kill never resolves).
    // Touch firstErr to satisfy linters about the variable.
    void firstAttempt;
    void firstErr;
  });

  it('killAllSync force-kills BOTH the dying channel AND the fresh attach-target (BkUyD overwrite race)', async () => {
    // The killSession → spawnOrAttach race opens a window where two
    // channels are simultaneously "alive" from the daemon's
    // perspective: the dying one (sessionIds.size === 0, in
    // SIGTERM grace) and the fresh one (just spawned to serve the new
    // request). Pre-fix `killAllSync()` iterated only `channelInfo`
    // (the fresh one), missing the dying channel and orphaning its
    // child when `process.exit(1)` fired before its SIGTERM
    // escalation timer. Fix: separate `aliveChannels: Set<ChannelInfo>`
    // that `killAllSync` iterates, only cleared by each channel's
    // `channel.exited` (the OS-reap signal).
    const killSyncCalls: string[] = [];
    let factoryCount = 0;
    const factory: ChannelFactory = async () => {
      const tag = `c${factoryCount++}`;
      const h = makeChannel({ sessionIdPrefix: tag });
      const realKillSync = h.channel.killSync;
      h.channel = {
        ...h.channel,
        // kill() hangs forever so the dying channel stays in
        // SIGTERM grace for the duration of the test.
        kill: () => new Promise(() => {}),
        killSync: () => {
          killSyncCalls.push(tag);
          realKillSync();
        },
      };
      return h.channel;
    };
    const bridge = makeBridge({ channelFactory: factory });
    const first = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Trigger the overwrite race: kill the only session → channel
    // marked dying, kill awaits a never-resolving Promise; then
    // spawn a new session → fresh channel, `channelInfo` reassigned.
    const killPromise = bridge.killSession(first.sessionId);
    await new Promise((r) => setImmediate(r));
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });

    // Both channels are alive from the OS's perspective. A
    // double-Ctrl+C arrives.
    bridge.killAllSync();

    // BOTH channels received killSync. Pre-fix only `c1` (the fresh
    // one in `channelInfo`) would have fired — `c0` was dying in
    // unreachable state and would have orphaned its child.
    expect(killSyncCalls.sort()).toEqual(['c0', 'c1']);

    // Cleanup: dangling never-resolving promises GC'd by the runner.
    void killPromise;
  });

  describe('sendPrompt', () => {
    it('forwards a prompt and returns the agent response', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          promptImpl: () => ({ stopReason: 'max_tokens' }),
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const result = await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(result).toEqual({ stopReason: 'max_tokens' });
      expect(handles[0]?.agent.promptCalls).toHaveLength(1);

      await bridge.shutdown();
    });

    it('overrides a stale sessionId in the body with the routing id', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await bridge.sendPrompt(session.sessionId, {
        // Body claims a different sessionId — bridge must not honor it.
        sessionId: 'spoofed',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(handles[0]?.agent.promptCalls[0]?.sessionId).toBe(
        session.sessionId,
      );

      await bridge.shutdown();
    });

    it('FIFO-serializes concurrent prompts on the same session', async () => {
      const order: string[] = [];
      let resolveFirst: (() => void) | undefined;
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          promptImpl: async (p) => {
            const tag =
              (p.prompt[0] as { text?: string } | undefined)?.text ?? '?';
            order.push(`start:${tag}`);
            if (tag === 'first') {
              await new Promise<void>((res) => {
                resolveFirst = res;
              });
            }
            order.push(`end:${tag}`);
            return { stopReason: 'end_turn' };
          },
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const p1 = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'first' }],
      });
      const p2 = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      });

      // Give the event loop a chance to run the agent's start handler.
      await new Promise((r) => setTimeout(r, 10));
      // The second prompt MUST NOT have started before the first ended.
      expect(order).toEqual(['start:first']);

      resolveFirst!();
      await Promise.all([p1, p2]);
      expect(order).toEqual([
        'start:first',
        'end:first',
        'start:second',
        'end:second',
      ]);

      await bridge.shutdown();
    });

    it('a failed prompt does not poison the queue for subsequent prompts', async () => {
      let promptCount = 0;
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({
          promptImpl: async () => {
            promptCount += 1;
            if (promptCount === 1) {
              throw new Error('first prompt boom');
            }
            return { stopReason: 'end_turn' };
          },
        });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const failed = await bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'a' }],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(failed).not.toBeNull();

      const ok = await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'b' }],
      });
      expect(ok).toEqual({ stopReason: 'end_turn' });

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(
        bridge.sendPrompt('unknown', {
          sessionId: 'unknown',
          prompt: [{ type: 'text', text: 'x' }],
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('cancelSession', () => {
    it('forwards a cancel notification with the routing id', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      await bridge.cancelSession(session.sessionId);
      // Cancel is a notification — let it propagate before observing.
      await new Promise((r) => setTimeout(r, 10));
      expect(handles[0]?.agent.cancelCalls).toHaveLength(1);
      expect(handles[0]?.agent.cancelCalls[0]?.sessionId).toBe(
        session.sessionId,
      );

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(bridge.cancelSession('unknown')).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });
  });

  describe('permission flow', () => {
    /** Spin up a bridge with a hand-driven channel; returns the bridge,
     *  session, and a function the test uses to call `requestPermission`
     *  from the agent side. */
    async function setupForPermission() {
      let capturedConn: AgentSideConnection | undefined;
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        // The agent side gets an AgentSideConnection; that exposes a
        // ClientSideConnection-equivalent on its `agent` callback. We need
        // to drive `requestPermission` from the agent direction — for that
        // the agent calls back through its `connection` instance.
        const conn = new AgentSideConnection(() => fakeAgent, agentStream);
        // Save the connection — agent code uses `conn.requestPermission(...)`
        // which sends the JSON-RPC request to the bridge's BridgeClient.
        capturedConn = conn;
        const handle = { killed: false };
        handles.push(handle);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {
            handle.killed = true;
          },
          killSync: () => {
            handle.killed = true;
          },
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, conn: capturedConn!, handles };
    }

    it('publishes a permission_request event with a generated requestId and awaits a vote', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      // Fire requestPermission from the agent side.
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });

      // Read the permission_request event off the bus.
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.done).toBe(false);
      const evt = next.value!;
      expect(evt.type).toBe('permission_request');
      const payload = evt.data as {
        requestId: string;
        sessionId: string;
        options: Array<{ optionId: string }>;
      };
      expect(typeof payload.requestId).toBe('string');
      expect(payload.requestId.length).toBeGreaterThan(0);
      expect(payload.sessionId).toBe(session.sessionId);
      expect(payload.options.map((o) => o.optionId)).toEqual(['allow', 'deny']);
      expect(bridge.pendingPermissionCount).toBe(1);

      // Vote.
      const accepted = bridge.respondToPermission(payload.requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      expect(accepted).toBe(true);

      // The agent's promise resolves.
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.outcome).toBe('selected');
      expect(response.outcome.optionId).toBe('allow');
      expect(bridge.pendingPermissionCount).toBe(0);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('rejects votes whose optionId was not in the agent-offered set (BkwQI)', async () => {
      // BkwQI: bridge.respondToPermission validates the voter's
      // `optionId` against the original `options` the agent sent.
      // A client with the bearer can't forge a hidden outcome (e.g.
      // `ProceedAlways*` when the prompt's `hideAlwaysAllow` policy
      // suppressed it). Throws `InvalidPermissionOptionError`.
      const { bridge, session, conn } = await setupForPermission();
      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      const payload = next.value!.data as { requestId: string };

      // Forged optionId — NOT in the agent-offered set.
      expect(() =>
        bridge.respondToPermission(payload.requestId, {
          outcome: { outcome: 'selected', optionId: 'ProceedAlwaysProject' },
        }),
      ).toThrow(InvalidPermissionOptionError);

      // The pending permission is still alive — a valid vote can
      // still resolve it. (Throw didn't consume the pending entry.)
      expect(bridge.pendingPermissionCount).toBe(1);
      bridge.respondToPermission(payload.requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.optionId).toBe('allow');

      // Cancelled outcomes don't need an optionId, and aren't checked.
      // (Already covered by `cancelSession resolves outstanding
      // permissions as cancelled` below — call out the contract here.)

      subAbort.abort();
      await bridge.shutdown();
    });

    it('first-responder wins: a second vote returns false', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const evt = (await it.next()).value!;
      const requestId = (evt.data as { requestId: string }).requestId;

      const first = bridge.respondToPermission(requestId, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      const second = bridge.respondToPermission(requestId, {
        outcome: { outcome: 'cancelled' },
      });
      expect(first).toBe(true);
      expect(second).toBe(false);

      await respPromise; // resolved by the first vote
      subAbort.abort();
      await bridge.shutdown();
    });

    it('publishes a permission_resolved event when a vote lands', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      bridge.respondToPermission(
        requestId,
        {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        { clientId: session.clientId },
      );

      const resolvedEvt = (await it.next()).value!;
      expect(resolvedEvt.type).toBe('permission_resolved');
      expect(resolvedEvt.originatorClientId).toBe(session.clientId);
      expect(resolvedEvt.data).toMatchObject({
        requestId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      subAbort.abort();
      await bridge.shutdown();
    });

    it('publishes permission_already_resolved when a scoped vote loses the race', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      const accepted = bridge.respondToSessionPermission(
        session.sessionId,
        requestId,
        {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        { clientId: session.clientId },
      );
      expect(accepted).toBe(true);
      const resolvedEvt = (await it.next()).value!;
      expect(resolvedEvt.type).toBe('permission_resolved');

      const second = bridge.respondToSessionPermission(
        session.sessionId,
        requestId,
        { outcome: { outcome: 'cancelled' } },
        { clientId: session.clientId },
      );
      expect(second).toBe(false);
      const alreadyEvt = (await it.next()).value!;
      expect(alreadyEvt.type).toBe('permission_already_resolved');
      expect(alreadyEvt.originatorClientId).toBeUndefined();
      expect(alreadyEvt.data).toMatchObject({
        requestId,
        sessionId: session.sessionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      subAbort.abort();
      await bridge.shutdown();
    });

    it('session-scoped permission votes cannot resolve another session request', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      const wrongSession = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const accepted = bridge.respondToSessionPermission(
        wrongSession.sessionId,
        requestId,
        { outcome: { outcome: 'selected', optionId: 'allow' } },
        { clientId: wrongSession.clientId },
      );
      expect(accepted).toBe(false);
      expect(bridge.pendingPermissionCount).toBe(1);
      expect(
        bridge.respondToSessionPermission(
          wrongSession.sessionId,
          requestId,
          { outcome: { outcome: 'cancelled' } },
          { clientId: 'client-not-issued' },
        ),
      ).toBe(false);
      expect(bridge.pendingPermissionCount).toBe(1);

      bridge.respondToPermission(requestId, {
        outcome: { outcome: 'cancelled' },
      });
      expect(bridge.pendingPermissionCount).toBe(0);
      subAbort.abort();
      await bridge.shutdown();
    });

    it('session-scoped duplicate votes do not validate clients against another session', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      expect(
        bridge.respondToSessionPermission(
          session.sessionId,
          requestId,
          {
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
          { clientId: session.clientId },
        ),
      ).toBe(true);

      const wrongSession = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(
        bridge.respondToSessionPermission(
          wrongSession.sessionId,
          requestId,
          { outcome: { outcome: 'cancelled' } },
          { clientId: 'client-not-issued' },
        ),
      ).toBe(false);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('respondToSessionPermission throws SessionNotFoundError for unknown sessions', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });

      expect(() =>
        bridge.respondToSessionPermission('missing-session', 'req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).toThrow(SessionNotFoundError);

      await bridge.shutdown();
    });

    it('rejects scoped votes whose optionId was not in the agent-offered set', async () => {
      const { bridge, session, conn } = await setupForPermission();
      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      const payload = next.value!.data as { requestId: string };

      expect(() =>
        bridge.respondToSessionPermission(
          session.sessionId,
          payload.requestId,
          {
            outcome: {
              outcome: 'selected',
              optionId: 'ProceedAlwaysProject',
            },
          },
          { clientId: session.clientId },
        ),
      ).toThrow(InvalidPermissionOptionError);

      expect(bridge.pendingPermissionCount).toBe(1);
      bridge.respondToSessionPermission(
        session.sessionId,
        payload.requestId,
        {
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
        { clientId: session.clientId },
      );
      const response = (await respPromise) as {
        outcome: { outcome: string; optionId?: string };
      };
      expect(response.outcome.optionId).toBe('allow');

      subAbort.abort();
      await bridge.shutdown();
    });

    it('rejects permission votes with unregistered client ids', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });
      void (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      const reqEvt = (await it.next()).value!;
      const requestId = (reqEvt.data as { requestId: string }).requestId;
      expect(() =>
        bridge.respondToPermission(
          requestId,
          {
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
          { clientId: 'client-not-issued' },
        ),
      ).toThrow(InvalidClientIdError);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('respondToPermission returns false for unknown requestId', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const accepted = bridge.respondToPermission('does-not-exist', {
        outcome: { outcome: 'cancelled' },
      });
      expect(accepted).toBe(false);
      await bridge.shutdown();
    });

    it('rejects unknown permission votes with unregistered client ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => makeChannel().channel,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      expect(() =>
        bridge.respondToPermission(
          'does-not-exist',
          {
            outcome: { outcome: 'cancelled' },
          },
          { clientId: 'client-not-issued' },
        ),
      ).toThrow(InvalidClientIdError);
      expect(
        bridge.respondToPermission(
          'does-not-exist',
          {
            outcome: { outcome: 'cancelled' },
          },
          { clientId: session.clientId },
        ),
      ).toBe(false);

      await bridge.shutdown();
    });

    it('cancelSession resolves outstanding permissions as cancelled', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      // Drain the permission_request event off the bus before cancelling
      // (resolving via cancel publishes a permission_resolved event;
      // ensure the consumer's queue isn't already full of unread frames).
      const it = iter[Symbol.asyncIterator]();
      await it.next();
      expect(bridge.pendingPermissionCount).toBe(1);

      await bridge.cancelSession(session.sessionId);

      const response = (await respPromise) as {
        outcome: { outcome: string };
      };
      expect(response.outcome.outcome).toBe('cancelled');
      expect(bridge.pendingPermissionCount).toBe(0);

      subAbort.abort();
      await bridge.shutdown();
    });

    it('shutdown resolves outstanding permissions as cancelled', async () => {
      const { bridge, session, conn } = await setupForPermission();

      const subAbort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: subAbort.signal,
      });

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'x' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });

      const it = iter[Symbol.asyncIterator]();
      await it.next();
      expect(bridge.pendingPermissionCount).toBe(1);

      await bridge.shutdown();

      const response = (await respPromise) as {
        outcome: { outcome: string };
      };
      expect(response.outcome.outcome).toBe('cancelled');
      expect(bridge.pendingPermissionCount).toBe(0);

      subAbort.abort();
    });

    it('sendPrompt abort resolves pending permissions as cancelled (A-UsU)', async () => {
      // Regression test for the bug fix where `sendPrompt`'s
      // `onAbort` handler was missing the `cancelPendingForSession`
      // call. Without it, an HTTP client disconnecting mid-permission
      // would leave the agent stuck waiting on a vote that no SSE
      // subscriber would ever cast.
      //
      // FakeAgent's `prompt()` here issues a permission request and
      // then awaits a never-resolving promise, so the agent IS the
      // thing pending on the permission. When the test aborts the
      // sendPrompt, `cancelPendingForSession` resolves the
      // permission, which in turn lets the agent's prompt() throw
      // (it sees the cancelled outcome). Both sides settle.
      let conn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          promptImpl: async (p): Promise<PromptResponse> => {
            // Issue the permission request from inside prompt() so
            // it's correlated with the in-flight prompt the bridge
            // is awaiting.
            await (
              conn as unknown as {
                requestPermission(q: unknown): Promise<unknown>;
              }
            ).requestPermission({
              sessionId: p.sessionId,
              toolCall: { toolCallId: 'tc-1', title: 'x' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              ],
            });
            return { stopReason: 'cancelled' };
          },
        });
        conn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // Kick off sendPrompt — agent will issue a permission request
      // that no SSE subscriber will vote on.
      const promptAbort = new AbortController();
      const promptResult = bridge
        .sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'x' }],
          },
          promptAbort.signal,
        )
        .catch(() => undefined);

      // Wait until the permission has been registered.
      for (let i = 0; i < 50 && bridge.pendingPermissionCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(bridge.pendingPermissionCount).toBe(1);

      // Abort the prompt — the bug being regressed: the abort
      // handler must call `cancelPendingForSession` so the pending
      // permission resolves as cancelled (otherwise the agent's
      // `requestPermission` blocks forever).
      promptAbort.abort();

      // Wait for the permission to resolve as cancelled. With the
      // bug present this would hang until the test timeout.
      for (let i = 0; i < 50 && bridge.pendingPermissionCount > 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(bridge.pendingPermissionCount).toBe(0);

      await bridge.shutdown();
      await promptResult;
    });
  });

  describe('modelServiceId honored at session create', () => {
    /** Build a channel that records `unstable_setSessionModel` calls. */
    function setup(opts: { setModelImpl?: () => Promise<unknown> } = {}) {
      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { sessionId: string; modelId: string }) => {
                setModelCalls.push({
                  sessionId: req.sessionId,
                  modelId: req.modelId,
                });
                if (opts.setModelImpl) await opts.setModelImpl();
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      return { bridge, setModelCalls };
    }

    it('applies modelServiceId via unstable_setSessionModel after newSession', async () => {
      const { bridge, setModelCalls } = setup();
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'qwen3-coder',
      });
      expect(session.attached).toBe(false);
      expect(setModelCalls).toHaveLength(1);
      expect(setModelCalls[0]?.sessionId).toBe(session.sessionId);
      expect(setModelCalls[0]?.modelId).toBe('qwen3-coder');
      await bridge.shutdown();
    });

    it('does NOT call setSessionModel when modelServiceId is omitted', async () => {
      const { bridge, setModelCalls } = setup();
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(setModelCalls).toHaveLength(0);
      await bridge.shutdown();
    });

    it('keeps the session alive on model-switch failure and publishes model_switch_failed', async () => {
      // Contract (per #3889 review A05Ym): when the agent rejects the
      // requested model at create-session time, the session is still
      // operational on the agent's default model. The caller gets a
      // sessionId they can retry the model switch against (via
      // POST /session/:id/model) and observe via the SSE stream.
      // Tearing the session down would force the caller into a 500
      // with no way to recover.
      const { bridge } = setup({
        setModelImpl: async () => {
          throw new Error('unknown model');
        },
      });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'definitely-not-a-real-model',
      });
      expect(session.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);
      // The model_switch_failed event must be on the bus for any
      // subscriber that subscribes with `lastEventId: 0` (replay).
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const it = iter[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value?.type).toBe('model_switch_failed');
      expect(first.value?.data).toMatchObject({
        sessionId: session.sessionId,
        requestedModelId: 'definitely-not-a-real-model',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('attaches to the existing session on retry after a model-switch failure', async () => {
      // Per the same A05Ym contract: a follow-up `spawnOrAttach` for
      // the same workspace finds the existing session (rather than
      // re-spawning a fresh one), and a retry of the model switch
      // through `POST /session/:id/model` is the documented recovery
      // path. We exercise just the attach side here.
      const { bridge } = setup({
        setModelImpl: async () => {
          throw new Error('first attempt rejected');
        },
      });

      const first = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'try-1',
      });
      expect(first.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);

      // Second attach (no modelServiceId so we don't re-trigger the
      // failing setModel) reuses the same session.
      const second = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
      });
      expect(second.attached).toBe(true);
      expect(second.sessionId).toBe(first.sessionId);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
    });
  });

  describe('channel exit cleanup (child-crash recovery)', () => {
    it('removes the SessionEntry when the channel terminates unexpectedly', async () => {
      const handles: ChannelHandle[] = [];
      let n = 0;
      const factory: ChannelFactory = async () => {
        // Distinct sessionIdPrefix per spawn so the post-crash retry gets
        // a different sessionId than the dead session — verifies the
        // bridge spawned a NEW child rather than reusing.
        const h = makeChannel({ sessionIdPrefix: `gen${n++}` });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });

      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(1);

      // Subscribe so we can observe the session_died event.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Simulate a child crash (channel.exited resolves but we never called
      // kill() — entry is still in byId / defaultEntry at the moment of crash).
      handles[0]?.crash();

      // Drain the bus — first frame is `session_died`.
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.done).toBe(false);
      expect(next.value?.type).toBe('session_died');

      // After the crash handler runs, the entry should be gone.
      // (await one microtask in case the handler is still resolving.)
      await Promise.resolve();
      expect(bridge.sessionCount).toBe(0);

      // A subsequent spawnOrAttach for the same workspace must NOT reuse
      // the dead session; it spawns fresh (attached: false) with a new id.
      const fresh = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(fresh.attached).toBe(false);
      expect(fresh.sessionId).not.toBe(session.sessionId);
      expect(handles).toHaveLength(2);

      abort.abort();
      await bridge.shutdown();
    });

    it('exit fired on planned shutdown does NOT trigger the unexpected-cleanup path', async () => {
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      // No subscribers; planned shutdown removes the entry first, THEN
      // calls channel.kill() which resolves channel.exited. The cleanup
      // .then() handler runs but sees byId.get(sessionId) === undefined
      // (already removed), so it no-ops and doesn't double-publish.
      await bridge.shutdown();

      // Re-subscribing throws SessionNotFoundError (not a stale state).
      expect(() => bridge.subscribeEvents(session.sessionId)).toThrow();
      expect(bridge.sessionCount).toBe(0);
    });
  });

  describe('model-change FIFO + failure recovery', () => {
    it('publishes model_switch_failed and surfaces the error when the agent rejects', async () => {
      let attempts = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async () => {
                attempts += 1;
                if (attempts > 1) throw new Error('agent denied');
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'first',
      });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Second attach with a NEW model — agent rejects. Per #3889
      // review A-UsJ the attach path now SWALLOWS the model-switch
      // failure (matches the create-session path's existing
      // behavior): the session is fully operational on its current
      // model, and returning an error without the sessionId would
      // deny the caller any way to recover. The visible signal is
      // the `model_switch_failed` SSE event (asserted below).
      const attached = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'rejected',
      });
      expect(attached.attached).toBe(true);
      expect(attached.sessionId).toBe(session.sessionId);

      // Crucially: the session is still alive (we didn't tear it down
      // because it's a SHARED session). Other clients keep working.
      expect(bridge.sessionCount).toBe(1);

      // And cross-client observability: a model_switch_failed event
      // surfaced on the bus so attached clients learn the agent denied
      // the model change. (We subscribed AFTER the first spawn, so the
      // initial `model_switched` from spawn-time isn't in this iter
      // unless we'd passed lastEventId=0; the failed switch is the only
      // event we expect to observe live.)
      const it = iter[Symbol.asyncIterator]();
      const failed = await it.next();
      expect(failed.value?.type).toBe('model_switch_failed');
      expect(
        (failed.value?.data as { requestedModelId?: string })?.requestedModelId,
      ).toBe('rejected');

      abort.abort();
      await bridge.shutdown();
    });

    it('serializes concurrent model-change calls (FIFO)', async () => {
      const callOrder: string[] = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { modelId: string }) => {
                callOrder.push(`enter:${req.modelId}`);
                // Simulate an agent that takes time to apply.
                await new Promise((r) => setTimeout(r, 30));
                callOrder.push(`exit:${req.modelId}`);
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      // First call spawns the session AND applies model "A".
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'A',
      });

      // Two concurrent attaches with different models. Without the FIFO
      // they'd interleave (enter:B, enter:C, exit:B, exit:C).
      await Promise.all([
        bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          modelServiceId: 'B',
        }),
        bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          modelServiceId: 'C',
        }),
      ]);

      // Strict sequencing: each `setSessionModel` exits before the next
      // one enters.
      const noEnter = callOrder.findIndex(
        (s, i) =>
          s.startsWith('enter:') &&
          i > 0 &&
          callOrder[i - 1]!.startsWith('enter:'),
      );
      expect(noEnter).toBe(-1);
      await bridge.shutdown();
    });
  });

  describe('attach honors modelServiceId on existing session', () => {
    /** Channel + agent factory that records every set-model call. */
    function setupRecording() {
      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { sessionId: string; modelId: string }) => {
                setModelCalls.push({
                  sessionId: req.sessionId,
                  modelId: req.modelId,
                });
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      return { factory, setModelCalls };
    }

    it('applies modelServiceId on attach via unstable_setSessionModel', async () => {
      const { factory, setModelCalls } = setupRecording();
      const bridge = makeBridge({ channelFactory: factory });

      // First call spawns; second call attaches with a DIFFERENT model.
      const first = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'model-A',
      });
      const second = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'model-B',
      });

      expect(second.attached).toBe(true);
      expect(second.sessionId).toBe(first.sessionId);
      // Two set-model calls: one at create time, one at attach time.
      expect(setModelCalls.map((c) => c.modelId)).toEqual([
        'model-A',
        'model-B',
      ]);

      await bridge.shutdown();
    });

    it('attach without modelServiceId does NOT issue setSessionModel', async () => {
      const { factory, setModelCalls } = setupRecording();
      const bridge = makeBridge({ channelFactory: factory });

      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        modelServiceId: 'model-A',
      });
      // Plain attach — no model preference passed.
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      expect(setModelCalls).toEqual([
        { sessionId: expect.any(String), modelId: 'model-A' },
      ]);

      await bridge.shutdown();
    });
  });

  describe('sendPrompt fail-fast on transport close', () => {
    it('rejects in-flight prompt when channel.exited fires', async () => {
      // Build a channel whose `prompt()` never resolves naturally;
      // exposing the `crash()` hook lets us trigger channel.exited.
      let resolveExited: (() => void) | undefined;
      const exited = new Promise<
        | { exitCode: number | null; signalCode: NodeJS.Signals | null }
        | undefined
      >((r) => {
        resolveExited = () => r(undefined);
      });
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        // Fake agent's prompt() never replies — we want the bridge's
        // race-against-exited to be the only resolution path.
        const stuckAgent: Agent = {
          async initialize() {
            return {
              protocolVersion: PROTOCOL_VERSION,
              agentInfo: { name: 'stuck', version: '0' },
              authMethods: [],
              agentCapabilities: {},
            };
          },
          async newSession(p) {
            return { sessionId: `stuck:${p.cwd}` };
          },
          async loadSession() {
            throw new Error('not impl');
          },
          async authenticate() {
            throw new Error('not impl');
          },
          async prompt() {
            return new Promise(() => {}); // hang forever
          },
          async cancel() {},
          async setSessionMode() {
            throw new Error('not impl');
          },
          async setSessionConfigOption() {
            throw new Error('not impl');
          },
        };
        new AgentSideConnection(() => stuckAgent, agentStream);
        return {
          stream: clientStream,
          exited,
          kill: async () => resolveExited!(),
          killSync: () => resolveExited!(),
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const promptResult = bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });

      // Trigger transport close mid-flight.
      setTimeout(() => resolveExited!(), 50);

      await expect(promptResult).rejects.toThrow(/channel closed/i);
      await bridge.shutdown();
    });
  });

  describe('opts validation', () => {
    it('rejects an invalid sessionScope', () => {
      expect(() =>
        makeBridge({
          sessionScope: 'bogus' as unknown as 'single',
        }),
      ).toThrow(/Invalid sessionScope/);
    });

    it('rejects a non-positive initializeTimeoutMs', () => {
      expect(() => makeBridge({ initializeTimeoutMs: 0 })).toThrow(
        /initializeTimeoutMs/,
      );
      expect(() => makeBridge({ initializeTimeoutMs: -1 })).toThrow(
        /initializeTimeoutMs/,
      );
    });

    it('rejects NaN maxSessions (BRApy: silent fail-OPEN guard)', () => {
      // A typo / parse error in CLI / config that yields NaN must
      // NOT silently disable the daemon's resource cap. We fail
      // boot loud instead of serving unbounded.
      expect(() => makeBridge({ maxSessions: NaN })).toThrow(
        /maxSessions: NaN/,
      );
      expect(() => makeBridge({ maxSessions: -5 })).toThrow(/maxSessions: -5/);
      // Explicit zero or Infinity remain valid "unlimited" sentinels.
      expect(() => makeBridge({ maxSessions: 0 })).not.toThrow();
      expect(() => makeBridge({ maxSessions: Infinity })).not.toThrow();
    });
  });

  describe('concurrent spawn coalescing (single scope)', () => {
    it('two parallel calls for the same workspace spawn ONE channel', async () => {
      let spawnCount = 0;
      const factory: ChannelFactory = async () => {
        spawnCount += 1;
        // Tiny delay so the second call's check arrives before the first
        // resolves — this is the race window without coalescing.
        await new Promise((r) => setTimeout(r, 10));
        return makeChannel().channel;
      };
      const bridge = makeBridge({ channelFactory: factory });

      const [a, b] = await Promise.all([
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ]);

      expect(spawnCount).toBe(1);
      expect(a.sessionId).toBe(b.sessionId);
      // Exactly one of the two callers reports `attached: false` (the spawn
      // owner); the other reports `attached: true`.
      expect([a.attached, b.attached].sort()).toEqual([false, true]);
      expect(bridge.sessionCount).toBe(1);

      await bridge.shutdown();
    });

    it('clears the in-flight slot on rejection so the next call can retry', async () => {
      let attempt = 0;
      const factory: ChannelFactory = async () => {
        attempt += 1;
        if (attempt === 1) {
          // First spawn fails the initialize handshake.
          const h = makeChannel({
            initializeThrows: new Error('boom'),
          });
          return h.channel;
        }
        return makeChannel().channel;
      };
      const bridge = makeBridge({ channelFactory: factory });

      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toBeTruthy();

      // The retry must NOT see the rejected promise still parked in
      // inFlightSpawns — that would poison every future call.
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(session.sessionId).toBe(SESS_A);
      expect(session.attached).toBe(false);
      expect(attempt).toBe(2);

      await bridge.shutdown();
    });
  });

  describe('BridgeClient file proxy (Stage 1: same-host trust)', () => {
    /** Spawn an agent that drives readTextFile/writeTextFile from the agent
     *  side, exercising the BridgeClient proxy. */
    async function setupForFs() {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        capturedConn = new AgentSideConnection(
          () => new FakeAgent(),
          agentStream,
        );
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, conn: capturedConn! };
    }

    it('writeTextFile writes to local fs', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-write-${randomBytes(8).toString('hex')}.txt`,
      );
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: tmp,
          content: 'hello bridge',
        });
        const content = await fsp.readFile(tmp, 'utf8');
        expect(content).toBe('hello bridge');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });

    it('writeTextFile leaves no .tmp turd in the target directory (BSA0D)', async () => {
      // Verify the atomic write-then-rename pattern doesn't leak the
      // intermediate temp file. After a successful write, only the
      // target should exist in the directory.
      const { bridge, conn } = await setupForFs();
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-bridge-atomic-'),
      );
      const tmp = path.join(dir, 'target.txt');
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: tmp,
          content: 'atomic',
        });
        const entries = await fsp.readdir(dir);
        // Only the target should remain — no `target.txt.<pid>.<ts>.tmp`.
        expect(entries).toEqual(['target.txt']);
        expect(await fsp.readFile(tmp, 'utf8')).toBe('atomic');
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile rejects files past the size cap (BSA0E)', async () => {
      // Cap is 100 MiB; create a 1 KiB sentinel and monkey-patch the
      // path's stat-reported size to exceed the cap by re-pointing
      // readTextFile at /dev/zero (which fs.stat reports as size 0
      // on Linux), so we can't easily simulate a 100MB file in unit
      // tests. Instead, confirm the cap path is reachable via
      // direct invocation by stubbing fs.stat through a sparse file.
      //
      // Sparse file: `truncate -s 200M` creates a 200 MiB hole that
      // costs zero blocks. fs.stat reports size=200MiB; fs.readFile
      // would balloon RSS but we throw before that.
      const { bridge, conn } = await setupForFs();
      const sparse = path.join(
        os.tmpdir(),
        `qwen-bridge-sparse-${randomBytes(8).toString('hex')}.bin`,
      );
      const fh = await fsp.open(sparse, 'w');
      try {
        await fh.truncate(200 * 1024 * 1024); // 200 MiB hole
        await fh.close();
        // Error message is wrapped by the JSON-RPC layer; assert via
        // the structured envelope's data.details rather than the
        // outer "Internal error" string.
        await expect(
          (
            conn as unknown as {
              readTextFile(p: {
                path: string;
                sessionId: string;
              }): Promise<unknown>;
            }
          ).readTextFile({ sessionId: 'unused', path: sparse }),
        ).rejects.toMatchObject({
          data: {
            details: expect.stringMatching(/exceeds the.*byte daemon cap/),
          },
        });
      } finally {
        await fsp.rm(sparse, { force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile rejects non-regular files even when size=0 (BX8YO)', async () => {
      // Char devices / FIFOs / procfs entries report size=0 but
      // produce unbounded data on read. Use a FIFO as the portable
      // probe (chrdev / procfs not always available).
      //
      // Hard-skip on Windows: the platform doesn't have FIFOs at the
      // OS level. Git-Bash and similar shells ship a `mkfifo` binary
      // that succeeds-with-degeneration (creates a regular file or
      // silently does nothing), which then makes the test assert
      // against the wrong error shape and look like a regression.
      // The bridge's `!stats.isFile()` check itself is platform-
      // agnostic; Linux + macOS coverage is sufficient.
      if (process.platform === 'win32') return;
      const { bridge, conn } = await setupForFs();
      const fifoPath = path.join(
        os.tmpdir(),
        `qwen-bridge-fifo-${randomBytes(8).toString('hex')}`,
      );
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('mkfifo', [fifoPath]);
      } catch {
        // Skip if mkfifo not on PATH for some reason.
        await bridge.shutdown();
        return;
      }
      try {
        await expect(
          (
            conn as unknown as {
              readTextFile(p: {
                path: string;
                sessionId: string;
              }): Promise<unknown>;
            }
          ).readTextFile({ sessionId: 'unused', path: fifoPath }),
        ).rejects.toMatchObject({
          data: { details: expect.stringMatching(/not a regular file/) },
        });
      } finally {
        await fsp.rm(fifoPath, { force: true });
        await bridge.shutdown();
      }
    });

    it('writeTextFile preserves symlinks (BX8Yw)', async () => {
      // Pre-fix: rename replaced the symlink with a regular file,
      // leaving the original target unchanged. Verify the target's
      // content is what was written and the symlink is preserved.
      const { bridge, conn } = await setupForFs();
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-bridge-symlink-'),
      );
      const target = path.join(dir, 'target.txt');
      const link = path.join(dir, 'link.txt');
      await fsp.writeFile(target, 'original target', 'utf8');
      await fsp.symlink(target, link);
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: link,
          content: 'updated through symlink',
        });
        // Target got the new content.
        expect(await fsp.readFile(target, 'utf8')).toBe(
          'updated through symlink',
        );
        // Link is still a symlink, not a regular file.
        const linkStat = await fsp.lstat(link);
        expect(linkStat.isSymbolicLink()).toBe(true);
        // Reading through the link still goes to the target.
        expect(await fsp.readFile(link, 'utf8')).toBe(
          'updated through symlink',
        );
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await bridge.shutdown();
      }
    });

    it('writeTextFile preserves dangling symlinks (BfFvO)', async () => {
      // Symlink whose target doesn't exist yet — `fs.realpath` throws
      // ENOENT. Pre-fix: the catch silently fell back to writing to
      // params.path (the symlink), and rename replaced the symlink
      // with a regular file (the original BX8Yw bug, masked for
      // dangling targets). Fix uses `fs.readlink` to disambiguate.
      if (process.platform === 'win32') return; // symlinks need admin on Windows
      const { bridge, conn } = await setupForFs();
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-bridge-dangling-'),
      );
      const target = path.join(dir, 'target.txt'); // not created yet
      const link = path.join(dir, 'link.txt');
      await fsp.symlink(target, link);
      try {
        await (
          conn as unknown as {
            writeTextFile(p: {
              path: string;
              content: string;
              sessionId: string;
            }): Promise<unknown>;
          }
        ).writeTextFile({
          sessionId: 'unused',
          path: link,
          content: 'created through dangling symlink',
        });
        // Target now exists with the content.
        expect(await fsp.readFile(target, 'utf8')).toBe(
          'created through dangling symlink',
        );
        // Link is STILL a symlink (not replaced by a regular file).
        const linkStat = await fsp.lstat(link);
        expect(linkStat.isSymbolicLink()).toBe(true);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile returns full content by default', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-read-${randomBytes(8).toString('hex')}.txt`,
      );
      await fsp.writeFile(
        tmp,
        'line one\nline two\nline three\nline four',
        'utf8',
      );
      try {
        const result = (await (
          conn as unknown as {
            readTextFile(p: {
              path: string;
              sessionId: string;
            }): Promise<{ content: string }>;
          }
        ).readTextFile({ sessionId: 'unused', path: tmp })) as {
          content: string;
        };
        expect(result.content).toContain('line one');
        expect(result.content).toContain('line four');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });

    it('readTextFile slices via line/limit (ACP 1-based line)', async () => {
      const { bridge, conn } = await setupForFs();
      const tmp = path.join(
        os.tmpdir(),
        `qwen-bridge-slice-${randomBytes(8).toString('hex')}.txt`,
      );
      await fsp.writeFile(tmp, 'a\nb\nc\nd\ne', 'utf8');
      try {
        // line:1, limit:2 means "first two lines" per ACP spec (1-based).
        const first = (await (
          conn as unknown as {
            readTextFile(p: {
              path: string;
              sessionId: string;
              line?: number;
              limit?: number;
            }): Promise<{ content: string }>;
          }
        ).readTextFile({
          sessionId: 'unused',
          path: tmp,
          line: 1,
          limit: 2,
        })) as { content: string };
        expect(first.content).toBe('a\nb');

        // line:3, limit:2 → lines 3 and 4.
        const middle = (await (
          conn as unknown as {
            readTextFile(p: {
              path: string;
              sessionId: string;
              line?: number;
              limit?: number;
            }): Promise<{ content: string }>;
          }
        ).readTextFile({
          sessionId: 'unused',
          path: tmp,
          line: 3,
          limit: 2,
        })) as { content: string };
        expect(middle.content).toBe('c\nd');
      } finally {
        await fsp.rm(tmp, { force: true });
        await bridge.shutdown();
      }
    });
  });

  describe('listWorkspaceSessions', () => {
    it('returns sessions matching the bound workspace cwd', async () => {
      let n = 0;
      const factory: ChannelFactory = async () => {
        // Distinct sessionIdPrefix per spawn so two thread-scope sessions
        // in the same workspace get distinct ids (the FakeAgent encodes the
        // cwd into the id otherwise → collision).
        const h = makeChannel({ sessionIdPrefix: `s${n++}` });
        return h.channel;
      };
      const bridge = makeBridge({
        sessionScope: 'thread',
        channelFactory: factory,
      });

      const a1 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const a2 = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const aList = bridge.listWorkspaceSessions(WS_A);
      expect(aList).toHaveLength(2);
      expect(aList.map((s) => s.sessionId).sort()).toEqual(
        [a1.sessionId, a2.sessionId].sort(),
      );
      // Querying a different workspace returns an empty list (the
      // bridge only hosts `boundWorkspace` per #3803 §02; a UI asking
      // for sessions in some other path is correct to see "none").
      const bList = bridge.listWorkspaceSessions(WS_B);
      expect(bList).toEqual([]);
      const idleList = bridge.listWorkspaceSessions('/work/c');
      expect(idleList).toEqual([]);

      await bridge.shutdown();
    });

    it('canonicalizes the lookup path', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const list = bridge.listWorkspaceSessions('/work/./a');
      expect(list).toHaveLength(1);
      expect(list[0]?.workspaceCwd).toBe(WS_A);

      await bridge.shutdown();
    });

    it('returns empty for relative paths instead of throwing', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      expect(bridge.listWorkspaceSessions('relative/path')).toEqual([]);
    });
  });

  describe('setSessionModel', () => {
    /** Set up a channel where the agent records setSessionModel calls. */
    async function setup() {
      const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        // Augment the agent with the unstable model setter via a proxy so we
        // don't need to extend the FakeAgent class with optional methods.
        const augmented = new Proxy(fakeAgent, {
          get(target, prop) {
            if (prop === 'unstable_setSessionModel') {
              return async (req: { sessionId: string; modelId: string }) => {
                setModelCalls.push({
                  sessionId: req.sessionId,
                  modelId: req.modelId,
                });
                return {};
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any)[prop];
          },
        });
        new AgentSideConnection(() => augmented as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      return { bridge, session, setModelCalls };
    }

    it('forwards modelId to the agent and overrides body sessionId', async () => {
      const { bridge, session, setModelCalls } = await setup();
      const response = await bridge.setSessionModel(session.sessionId, {
        sessionId: 'spoofed',
        modelId: 'qwen3-coder',
      });
      expect(response).toEqual({});
      expect(setModelCalls[0]?.sessionId).toBe(session.sessionId);
      expect(setModelCalls[0]?.modelId).toBe('qwen3-coder');
      await bridge.shutdown();
    });

    it('publishes a model_switched event on success', async () => {
      const { bridge, session } = await setup();
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      await bridge.setSessionModel(session.sessionId, {
        sessionId: session.sessionId,
        modelId: 'qwen3-coder',
      });
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.value?.type).toBe('model_switched');
      expect(next.value?.data).toEqual({
        sessionId: session.sessionId,
        modelId: 'qwen3-coder',
      });
      abort.abort();
      await bridge.shutdown();
    });

    it('stamps model events with the trusted originator client id', async () => {
      const { bridge, session } = await setup();
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });
      await bridge.setSessionModel(
        session.sessionId,
        {
          sessionId: session.sessionId,
          modelId: 'qwen3-coder',
        },
        { clientId: session.clientId },
      );
      const it = iter[Symbol.asyncIterator]();
      const next = await it.next();
      expect(next.value?.type).toBe('model_switched');
      expect(next.value?.originatorClientId).toBe(session.clientId);
      abort.abort();
      await bridge.shutdown();
    });

    it('rejects unregistered client ids on session-scoped requests', async () => {
      const { bridge, session } = await setup();
      await expect(
        bridge.sendPrompt(
          session.sessionId,
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
          },
          undefined,
          { clientId: 'client-not-issued' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      await expect(
        bridge.cancelSession(session.sessionId, undefined, {
          clientId: 'client-not-issued',
        }),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      await expect(
        bridge.setSessionModel(
          session.sessionId,
          {
            sessionId: session.sessionId,
            modelId: 'qwen3-coder',
          },
          { clientId: 'client-not-issued' },
        ),
      ).rejects.toBeInstanceOf(InvalidClientIdError);
      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session ids', async () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      await expect(
        bridge.setSessionModel('unknown', {
          sessionId: 'unknown',
          modelId: 'qwen3-coder',
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('setSessionApprovalMode (#4175 Wave 4 PR 17)', () => {
    /**
     * #4282 fold-in 4 (qwen-latest C1). Build a channel factory whose
     * extMethod handler answers `qwen/control/session/approval_mode`
     * with the expected `{previous, current}` shape. Tracks invocations
     * so the guard-ordering tests can assert that the ACP call did NOT
     * happen when the persist contract was already violated upfront.
     */
    function approvalModeFactoryWithCallTracker(): {
      factory: ChannelFactory;
      getCalls: () => Array<{ method: string }>;
    } {
      const calls: Array<{ method: string }> = [];
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const agent = new FakeAgent({
          extMethodImpl: (method, params) => {
            calls.push({ method });
            if (method === 'qwen/control/session/approval_mode') {
              return Promise.resolve({
                previous: 'default',
                current: (params as { mode: string }).mode,
              });
            }
            return Promise.resolve({});
          },
        });
        new AgentSideConnection(() => agent as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      return { factory, getCalls: () => calls };
    }

    it('throws BEFORE the ACP roundtrip when persist:true but no callback wired', async () => {
      // The previous post-ACP placement of the persist guard meant a
      // missing callback produced a 500 *after* the ACP child had
      // already applied the mode change — observable to other in-flight
      // requests but invisible to the caller. Pre-call ordering closes
      // that window; assert by checking the ACP `extMethod` was never
      // invoked when the guard fires.
      const { factory, getCalls } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.setSessionApprovalMode(
          session.sessionId,
          ApprovalMode.YOLO,
          { persist: true },
          undefined,
        ),
      ).rejects.toThrow(/persistApprovalMode/);
      expect(
        getCalls().some(
          (c) => c.method === 'qwen/control/session/approval_mode',
        ),
      ).toBe(false);
      await bridge.shutdown();
    });

    it('persist:false bypasses the guard regardless of callback wiring', async () => {
      // Symmetric coverage for the guard: when `persist` is omitted /
      // false, the missing callback is irrelevant and the ACP call must
      // proceed normally. Without this check, a future regression that
      // moves the guard could over-restrict the no-persist path.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const res = await bridge.setSessionApprovalMode(
        session.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
        undefined,
      );
      expect(res.persisted).toBe(false);
      expect(res.mode).toBe('yolo');
      await bridge.shutdown();
    });

    it('broadcasts approval_mode_changed to peer sessions when persisted (#4282 fold-in 4 S2)', async () => {
      // When `persist:true` succeeds the change becomes the workspace
      // default, so a peer session needs to know its next ACP child
      // will spawn into a different mode. The session-scoped publish
      // remains the authoritative signal for the requester; the
      // workspace broadcast is the informational mirror for peers.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({
        channelFactory: factory,
        persistApprovalMode: async () => {},
      });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const aborts = [new AbortController(), new AbortController()];
      const itA = bridge
        .subscribeEvents(a.sessionId, { signal: aborts[0]!.signal })
        [Symbol.asyncIterator]();
      const itB = bridge
        .subscribeEvents(b.sessionId, { signal: aborts[1]!.signal })
        [Symbol.asyncIterator]();
      await bridge.setSessionApprovalMode(
        a.sessionId,
        ApprovalMode.YOLO,
        { persist: true },
        undefined,
      );
      // Session A receives both the session-scoped event and the
      // workspace-scoped mirror; collect two events.
      const aFirst = await itA.next();
      const aSecond = await itA.next();
      const aTypes = [aFirst.value?.type, aSecond.value?.type];
      expect(aTypes.filter((t) => t === 'approval_mode_changed').length).toBe(
        2,
      );
      // Session B receives only the workspace-scoped mirror.
      const bFirst = await itB.next();
      expect(bFirst.value?.type).toBe('approval_mode_changed');
      expect(bFirst.value?.data).toMatchObject({
        sessionId: a.sessionId,
        previous: 'default',
        next: 'yolo',
        persisted: true,
      });
      aborts.forEach((a) => a.abort());
      await bridge.shutdown();
    });

    it('does NOT broadcast to peers when persisted is false', async () => {
      // Symmetric coverage: ephemeral changes affect only the
      // requesting session and must not surface on peer SSE buses, or
      // peer UIs would react to a workspace-wide change that didn't
      // happen.
      const { factory } = approvalModeFactoryWithCallTracker();
      const bridge = makeBridge({ channelFactory: factory });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const aborts = [new AbortController(), new AbortController()];
      const itA = bridge
        .subscribeEvents(a.sessionId, { signal: aborts[0]!.signal })
        [Symbol.asyncIterator]();
      const itB = bridge
        .subscribeEvents(b.sessionId, { signal: aborts[1]!.signal })
        [Symbol.asyncIterator]();
      await bridge.setSessionApprovalMode(
        a.sessionId,
        ApprovalMode.YOLO,
        { persist: false },
        undefined,
      );
      const aFirst = await itA.next();
      expect(aFirst.value?.type).toBe('approval_mode_changed');
      // Race the peer subscriber against a 50ms timer. Without a
      // timeout the test would hang because no event is expected.
      const timed = await Promise.race([
        itB.next().then((v) => ({ kind: 'event' as const, v })),
        new Promise((r) => setTimeout(r, 50)).then(() => ({
          kind: 'timeout' as const,
        })),
      ]);
      expect(timed.kind).toBe('timeout');
      aborts.forEach((a) => a.abort());
      await bridge.shutdown();
    });
  });

  describe('setWorkspaceToolEnabled (#4175 Wave 4 PR 17)', () => {
    it('throws when no persistDisabledTools callback is wired', async () => {
      const bridge = makeBridge();
      await expect(
        bridge.setWorkspaceToolEnabled('Bash', false, undefined),
      ).rejects.toThrow(/persistDisabledTools/);
    });

    it('invokes the persist callback with the workspace + name + enabled flag', async () => {
      const calls: Array<{
        workspace: string;
        toolName: string;
        enabled: boolean;
      }> = [];
      const bridge = makeBridge({
        persistDisabledTools: async (workspace, toolName, enabled) => {
          calls.push({ workspace, toolName, enabled });
        },
      });
      const result = await bridge.setWorkspaceToolEnabled(
        'Bash',
        false,
        undefined,
      );
      expect(result).toEqual({ toolName: 'Bash', enabled: false });
      expect(calls).toEqual([
        { workspace: WS_A, toolName: 'Bash', enabled: false },
      ]);
    });

    it('does NOT spawn an ACP child even when called repeatedly', async () => {
      let factoryCalls = 0;
      const bridge = makeBridge({
        channelFactory: async () => {
          factoryCalls += 1;
          throw new Error('channel factory should not be invoked');
        },
        persistDisabledTools: async () => {},
      });
      await bridge.setWorkspaceToolEnabled('Bash', false, undefined);
      await bridge.setWorkspaceToolEnabled('Read', true, undefined);
      expect(factoryCalls).toBe(0);
    });

    it('fan-outs tool_toggled events to every live session bus', async () => {
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        new AgentSideConnection(() => new FakeAgent() as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({
        channelFactory: factory,
        persistDisabledTools: async () => {},
      });
      // Two thread-scope sessions on the same workspace, so both
      // entries live in the byId map and both should observe the
      // workspace-scoped fan-out.
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const aborts = [new AbortController(), new AbortController()];
      const itA = bridge
        .subscribeEvents(a.sessionId, { signal: aborts[0]!.signal })
        [Symbol.asyncIterator]();
      const itB = bridge
        .subscribeEvents(b.sessionId, { signal: aborts[1]!.signal })
        [Symbol.asyncIterator]();
      await bridge.setWorkspaceToolEnabled('Bash', false, undefined);
      const [evA, evB] = await Promise.all([itA.next(), itB.next()]);
      expect(evA.value?.type).toBe('tool_toggled');
      expect(evB.value?.type).toBe('tool_toggled');
      expect(evA.value?.data).toEqual({ toolName: 'Bash', enabled: false });
      expect(evB.value?.data).toEqual({ toolName: 'Bash', enabled: false });
      aborts.forEach((a) => a.abort());
      await bridge.shutdown();
    });

    it('stamps tool_toggled with the originator clientId when supplied', async () => {
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        new AgentSideConnection(() => new FakeAgent() as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({
        channelFactory: factory,
        persistDisabledTools: async () => {},
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      await bridge.setWorkspaceToolEnabled('Bash', false, session.clientId);
      const next = await it.next();
      expect(next.value?.originatorClientId).toBe(session.clientId);
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('initWorkspace (#4175 Wave 4 PR 17)', () => {
    /**
     * Per-test workspace temp dir so the bridge's writeFile lands on a
     * real path the tests can stat. Cleaned up by `afterEach`.
     */
    let tmpWs: string;

    beforeEach(async () => {
      tmpWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-init-workspace-'));
    });

    afterEach(async () => {
      await fsp.rm(tmpWs, { recursive: true, force: true });
    });

    it('creates an empty QWEN.md on a fresh workspace', async () => {
      const bridge = createHttpAcpBridge({ boundWorkspace: tmpWs });
      const res = await bridge.initWorkspace({}, undefined);
      expect(res.action).toBe('created');
      expect(res.path).toBe(path.join(tmpWs, 'QWEN.md'));
      const written = await fsp.readFile(res.path, 'utf8');
      expect(written).toBe('');
    });

    it('treats whitespace-only file as a noop without force (no 409, no write)', async () => {
      // #4282 fold-in 1 (wenshao H4): whitespace-only existing file is
      // a no-op rather than a silent overwrite. Original whitespace
      // content is preserved; the response surface signals `'noop'`
      // so the SSE event accurately reflects "no on-disk change."
      const target = path.join(tmpWs, 'QWEN.md');
      const original = '   \n\t\n';
      await fsp.writeFile(target, original, 'utf8');
      const bridge = createHttpAcpBridge({ boundWorkspace: tmpWs });
      const res = await bridge.initWorkspace({}, undefined);
      expect(res.action).toBe('noop');
      const onDisk = await fsp.readFile(target, 'utf8');
      expect(onDisk).toBe(original);
    });

    it('throws WorkspaceInitConflictError when content exists and force is omitted', async () => {
      const target = path.join(tmpWs, 'QWEN.md');
      const original = '# Project notes\n\nimportant stuff';
      await fsp.writeFile(target, original, 'utf8');
      const bridge = createHttpAcpBridge({ boundWorkspace: tmpWs });
      const err = await bridge.initWorkspace({}, undefined).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceInitConflictError);
      expect((err as WorkspaceInitConflictError).path).toBe(target);
      expect((err as WorkspaceInitConflictError).existingSize).toBe(
        Buffer.byteLength(original, 'utf8'),
      );
      // Original content must be preserved on conflict.
      expect(await fsp.readFile(target, 'utf8')).toBe(original);
    });

    it('overwrites with action:overwrote when force is true', async () => {
      const target = path.join(tmpWs, 'QWEN.md');
      await fsp.writeFile(target, '# Old', 'utf8');
      const bridge = createHttpAcpBridge({ boundWorkspace: tmpWs });
      const res = await bridge.initWorkspace({ force: true }, undefined);
      expect(res.action).toBe('overwrote');
      expect(await fsp.readFile(target, 'utf8')).toBe('');
    });

    it('does NOT spawn an ACP child', async () => {
      let factoryCalls = 0;
      const bridge = createHttpAcpBridge({
        boundWorkspace: tmpWs,
        channelFactory: async () => {
          factoryCalls += 1;
          throw new Error('channel factory should not be invoked');
        },
      });
      await bridge.initWorkspace({}, undefined);
      expect(factoryCalls).toBe(0);
    });

    it('fan-outs workspace_initialized to live session buses', async () => {
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        new AgentSideConnection(() => new FakeAgent() as Agent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = createHttpAcpBridge({
        boundWorkspace: tmpWs,
        channelFactory: factory,
      });
      const session = await bridge.spawnOrAttach({ workspaceCwd: tmpWs });
      const abort = new AbortController();
      const it = bridge
        .subscribeEvents(session.sessionId, { signal: abort.signal })
        [Symbol.asyncIterator]();
      const res = await bridge.initWorkspace({}, session.clientId);
      const next = await it.next();
      expect(next.value?.type).toBe('workspace_initialized');
      expect(next.value?.data).toEqual({
        path: res.path,
        action: 'created',
      });
      expect(next.value?.originatorClientId).toBe(session.clientId);
      abort.abort();
      await bridge.shutdown();
    });
  });

  describe('subscribeEvents', () => {
    it('throws SessionNotFoundError for unknown session ids', () => {
      const bridge = makeBridge({
        channelFactory: async () => {
          throw new Error('factory should not be called');
        },
      });
      expect(() => bridge.subscribeEvents('unknown')).toThrow(
        SessionNotFoundError,
      );
    });

    it('publishes session_update events to subscribers when the agent sends them', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        // Build a channel pair where we capture the agent-side connection
        // so we can drive sessionUpdate notifications from the test.
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Send a sessionUpdate from the agent side (fire-and-forget).
      void capturedConn!.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      });

      const collected: Array<{ id?: number; type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('session_update');
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('shutdown closes live event subscriptions', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      const drain = (async () => {
        const events: unknown[] = [];
        for await (const e of iter) {
          events.push(e);
        }
        return events;
      })();

      // Give the subscriber a tick to register.
      await new Promise((r) => setTimeout(r, 10));
      await bridge.shutdown();

      // Subscriber must unwind to completion. Per #3889 review A05Ys
      // the bus now publishes a terminal `session_died` event before
      // closing on shutdown, so SSE subscribers can distinguish
      // daemon shutdown from a transient network error.
      const events = (await drain) as Array<{ type: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('session_died');
    });
  });

  // PR 14b: ext-notification handler for child→bridge MCP budget events.
  // Translates `qwen/notify/session/mcp-budget-event` into session-scoped
  // SSE frames (`mcp_budget_warning` / `mcp_child_refused_batch`).
  describe('extNotification — MCP budget events (PR 14b)', () => {
    it('publishes mcp_budget_warning when the child fires the warning event', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: session.sessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );

      const collected: Array<{ id?: number; type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('mcp_budget_warning');
      // PR 14b drops the routing fields (`v`, `sessionId`, `kind`)
      // from `data` since the SSE envelope already encodes them.
      expect(collected[0]?.data).toEqual({
        liveCount: 4,
        reservedCount: 4,
        budget: 4,
        thresholdRatio: 0.75,
        mode: 'warn',
      });
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('publishes mcp_child_refused_batch when the child fires the refused-batch event', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: session.sessionId,
          kind: 'refused_batch',
          refusedServers: [
            { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
          ],
          budget: 1,
          liveCount: 1,
          reservedCount: 1,
          mode: 'enforce',
        },
      );

      const collected: Array<{ type: string; data: unknown }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type, data: e.data });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('mcp_child_refused_batch');
      expect(collected[0]?.data).toEqual({
        refusedServers: [
          { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
        ],
        budget: 1,
        liveCount: 1,
        reservedCount: 1,
        mode: 'enforce',
      });

      abort.abort();
      await bridge.shutdown();
    });

    it('drops unknown extNotification methods, kinds, and missing sessionIds silently', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const abort = new AbortController();
      const iter = bridge.subscribeEvents(session.sessionId, {
        signal: abort.signal,
      });

      // Unknown method — drop.
      void capturedConn!.extNotification('qwen/notify/session/unknown-event', {
        sessionId: session.sessionId,
        kind: 'budget_warning',
      });
      // Missing sessionId — drop.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        { kind: 'budget_warning' },
      );
      // Unknown kind — drop.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        { sessionId: session.sessionId, kind: 'mystery_kind' },
      );
      // Resolvable sessionId but session id doesn't exist — drop.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          sessionId: 'nonexistent',
          kind: 'budget_warning',
          liveCount: 1,
          reservedCount: 1,
          budget: 1,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );
      // Real event — must arrive AFTER all drops above.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: session.sessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );

      const collected: Array<{ type: string }> = [];
      for await (const e of iter) {
        collected.push({ type: e.type });
        if (collected.length === 1) break;
      }
      // Exactly one event got through. Codex review fix #1 changed
      // the "unknown sessionId" path from drop to buffer — the
      // `nonexistent` frame above is now sitting in the early-event
      // buffer (it never registers, so it'll TTL out). All other
      // drops (unknown method, missing sessionId, unknown kind)
      // remain hard-drops.
      expect(collected).toEqual([{ type: 'mcp_budget_warning' }]);

      abort.abort();
      await bridge.shutdown();
    });

    it('buffers events for a not-yet-registered sessionId, drains them on registration (codex fix #1)', async () => {
      // Codex review round 1, finding #1: budget events fired during
      // a session's startup window (between `connection.newSession`
      // dispatching and `byId.set`) reach `BridgeClient.extNotification`
      // with a valid sessionId but no matching entry. Pre-fix those
      // were dropped silently; post-fix they're buffered and replayed
      // via `drainEarlyEvents` so SSE subscribers see them as the
      // FIRST frames of the new session.
      //
      // This test exercises the buffer + drain mechanism directly,
      // pre-buffering for a sessionId that doesn't yet exist, then
      // creating that session via newSessionImpl-controlled id and
      // verifying the drain replayed the frame onto the new EventBus.
      // (Forcing the actual production race window is timing-flaky;
      // the mechanism is the invariant we care about.)
      let capturedConn: AgentSideConnection | undefined;
      // Use sessionScope: 'thread' + a deterministic id-prefix so
      // `spawnOrAttach` returns an id we can pre-target.
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({ sessionIdPrefix: 'pre-buffer' });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
      });

      // Boot ANY session first to get the channel + BridgeClient
      // alive (factory + AgentSideConnection are constructed lazily
      // on first spawn). After this, subsequent spawns share the
      // channel and BridgeClient.
      const seed = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Pre-buffer for the NEXT thread-scope session id. FakeAgent
      // names them `<prefix>:<cwd>#<n>`; the seed was call 1
      // (suffix ''), the next will be call 2 (suffix '#2').
      const futureSessionId = `pre-buffer:${WS_A}#2`;
      expect(seed.sessionId).not.toBe(futureSessionId);

      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId: futureSessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );

      // Give the bridge's reader loop a tick to dispatch the
      // notification onto BridgeClient.extNotification — it goes
      // through `bufferEarlyEvent` because `futureSessionId` isn't
      // in `byId` yet.
      await new Promise((r) => setTimeout(r, 50));

      // Now create the future session. `createSessionEntry`'s new
      // `drainEarlyEvents` call replays the buffered frame onto the
      // freshly-constructed EventBus.
      const target = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(target.sessionId).toBe(futureSessionId);

      // Subscribe with `lastEventId: 0` so the replay-ring drain
      // path runs (live-only subscriptions skip the ring per
      // `eventBus.ts` semantics). Production SSE clients reconnecting
      // with `Last-Event-ID: 0` get this same behavior.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(target.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const collected: Array<{ id?: number; type: string }> = [];
      for await (const e of iter) {
        collected.push({ id: e.id, type: e.type });
        if (collected.length === 1) break;
      }
      expect(collected[0]?.type).toBe('mcp_budget_warning');
      // Drained frame went through `events.publish`, so it gets an
      // `id` — PR 14b events are session-scoped + replayable.
      expect(collected[0]?.id).toBe(1);

      abort.abort();
      await bridge.shutdown();
    });

    it('tombstones closed sessionIds so late notifications cannot leak into a future load of the same id (codex round 5 fix)', async () => {
      // Codex round 5 finding: pre-fix, after a session was killed
      // / closed, a late `extNotification` from its dying child for
      // the same id would land in `earlyEvents`. If the SAME
      // sessionId came back via `session/load`/`session/resume`
      // within the 60s TTL, `drainEarlyEvents` would replay stale
      // prior-session telemetry onto the NEW subscriber.
      //
      // Fix: every `byId.delete(sid)` site now calls
      // `BridgeClient.markSessionClosed(sid)`, which tombstones the
      // id (rejecting future `bufferEarlyEvent` calls for it) and
      // purges any frames already buffered for it.
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent({
          loadSessionImpl: () => ({ configOptions: [] }),
        });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });

      // 1) Spawn session A — id = SESS_A.
      const sess = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const sessionId = sess.sessionId;
      expect(sessionId).toBe(SESS_A);

      // 2) Close session A — calls byId.delete + markSessionClosed.
      await bridge.closeSession(sessionId);

      // 3) Simulate a LATE notification from the (now-defunct)
      // child for the closed sessionId. Pre-fix this would land in
      // `earlyEvents`. Post-fix the tombstone rejects it.
      void capturedConn!.extNotification(
        'qwen/notify/session/mcp-budget-event',
        {
          v: 1,
          sessionId,
          kind: 'budget_warning',
          liveCount: 4,
          reservedCount: 4,
          budget: 4,
          thresholdRatio: 0.75,
          mode: 'warn',
        },
      );
      // Give the bridge's read loop time to dispatch the notification.
      await new Promise((r) => setTimeout(r, 50));

      // 4) Re-load the SAME persisted sessionId via session/load.
      // createSessionEntry runs drainEarlyEvents — pre-fix the stale
      // frame would be replayed onto the new session's bus.
      const loaded = await bridge.loadSession({
        sessionId,
        workspaceCwd: WS_A,
      });
      expect(loaded.sessionId).toBe(sessionId);

      // 5) Subscribe with lastEventId: 0 to drain the replay ring.
      // Post-fix, no `mcp_budget_warning` should be in the ring
      // (the late notification was dropped at buffer time, not
      // drained on registration).
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(loaded.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const collected: Array<{ type: string }> = [];
      const drainPromise = (async () => {
        for await (const e of iter) {
          collected.push({ type: e.type });
        }
      })();
      // Give the iterator a tick to pull replay frames.
      await new Promise((r) => setTimeout(r, 50));
      abort.abort();
      await drainPromise;

      // No mcp_budget_warning leaked through.
      expect(collected.filter((e) => e.type === 'mcp_budget_warning')).toEqual(
        [],
      );

      await bridge.shutdown();
    });

    it('purges buffered guardrail events when restore fails so retry-success does not replay stale frames (codex round 7 fix)', async () => {
      // Codex round 7 finding: round-6 added `markRestoreInFlight`
      // so `bufferEarlyEvent` accepts frames for tombstoned ids
      // during a restore. If the restore FAILS, pre-fix
      // `clearRestoreInFlight` only released the allow-list and
      // left buffered frames in `earlyEvents[id]`. A subsequent
      // successful retry (`session/load` of the same id within
      // 60s) would `drainEarlyEvents` those stale frames into the
      // new session.
      //
      // Fix: failure path now calls `markSessionClosed` which both
      // re-tombstones the id AND purges `earlyEvents[id]`.
      let capturedConn: AgentSideConnection | undefined;
      let loadAttempt = 0;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        // First load attempt fails; second attempt succeeds. The
        // child's notification fires DURING the failing first
        // attempt — pre-fix it would survive the failure.
        const fakeAgent = new FakeAgent({
          loadSessionImpl: async (req, agent) => {
            loadAttempt += 1;
            if (loadAttempt === 1) {
              // Buffer a guardrail event for this restore window
              // BEFORE failing, simulating the round-6-allow-list
              // behavior.
              void agent;
              void capturedConn!.extNotification(
                'qwen/notify/session/mcp-budget-event',
                {
                  v: 1,
                  sessionId: req.sessionId,
                  kind: 'budget_warning',
                  liveCount: 4,
                  reservedCount: 4,
                  budget: 4,
                  thresholdRatio: 0.75,
                  mode: 'warn',
                },
              );
              // Tiny yield so the bridge dispatches the notification
              // before we throw.
              await new Promise((r) => setTimeout(r, 5));
              throw new Error('simulated transient load failure');
            }
            return { configOptions: [] };
          },
        });
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | { exitCode: number | null; signalCode: NodeJS.Signals | null }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });

      // Pre-tombstone: spawn + close session with the id we'll later load.
      const sess = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const sessionId = sess.sessionId;
      await bridge.closeSession(sessionId);

      // First load — fails after the child queues a guardrail event.
      // ACP wraps the agent throw as a JSON-RPC "Internal error";
      // the original message lives in `data.details` but the assertion
      // only needs to verify the load rejected.
      await expect(
        bridge.loadSession({ sessionId, workspaceCwd: WS_A }),
      ).rejects.toThrow();

      // Retry — succeeds. Pre-fix this would replay the queued
      // guardrail event onto the new session's bus.
      const loaded = await bridge.loadSession({
        sessionId,
        workspaceCwd: WS_A,
      });
      expect(loaded.sessionId).toBe(sessionId);

      // Verify no stale guardrail event leaked.
      const abort = new AbortController();
      const iter = bridge.subscribeEvents(loaded.sessionId, {
        signal: abort.signal,
        lastEventId: 0,
      });
      const collected: Array<{ type: string }> = [];
      const drainPromise = (async () => {
        for await (const e of iter) {
          collected.push({ type: e.type });
        }
      })();
      await new Promise((r) => setTimeout(r, 50));
      abort.abort();
      await drainPromise;
      expect(collected.filter((e) => e.type === 'mcp_budget_warning')).toEqual(
        [],
      );

      await bridge.shutdown();
    });
  });

  describe('maxSessions cap (chiga0 Rec 3)', () => {
    it('refuses NEW spawns past the cap with SessionLimitExceededError', async () => {
      let n = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({ sessionIdPrefix: `s${n++}` }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 2,
        // `thread` so each call is a fresh session, not an attach.
        sessionScope: 'thread',
      });

      // First two spawns succeed.
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(2);

      // Third hits the cap.
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A }),
      ).rejects.toMatchObject({
        name: 'SessionLimitExceededError',
        limit: 2,
      });
      // Cap rejection must NOT register a new session.
      expect(bridge.sessionCount).toBe(2);

      await bridge.shutdown();
    });

    it('per-request thread overrides cannot bypass the cap (#4175 PR 5 amplification guard)', async () => {
      // The cap exists to bound child-process / RSS / MCP amplification
      // — the new `'thread'` per-request override is exactly the kind of
      // request a single-scope daemon could be hammered with by a
      // multi-window client. A future refactor that gated the cap on
      // `defaultSessionScope` (instead of `effectiveScope`) would
      // silently let `'thread'` overrides bypass the limit. Pin the
      // contract here.
      let n = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({ sessionIdPrefix: `s${n++}` }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 2,
        sessionScope: 'single', // production default
      });

      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(bridge.sessionCount).toBe(2);

      await expect(
        bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          sessionScope: 'thread',
        }),
      ).rejects.toMatchObject({
        name: 'SessionLimitExceededError',
        limit: 2,
      });
      expect(bridge.sessionCount).toBe(2);

      await bridge.shutdown();
    });

    it('attach to an existing session under single scope is NOT counted toward the cap', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 1,
        sessionScope: 'single',
      });

      // First call spawns.
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);

      // Second call to the SAME workspace attaches — cap doesn't apply.
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      expect(b.sessionId).toBe(a.sessionId);
      expect(bridge.sessionCount).toBe(1);

      // A cross-workspace request rejects with WorkspaceMismatchError
      // (#3803 §02) — the bridge is bound to one workspace.
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_B }),
      ).rejects.toBeInstanceOf(WorkspaceMismatchError);

      await bridge.shutdown();
    });

    it('killSession({requireZeroAttaches:true}) skips reap when another client attached (BQ9tV)', async () => {
      // Race: client A spawned (attached:false), then disconnected.
      // Before A's disconnect-reaper runs, client B POSTs /session
      // for the same workspace and gets attached:true. Without the
      // race guard, A's reaper would tear down B's session.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      // Simulate client B's attach in the race window.
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      // Client A's disconnect-reaper fires now.
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      // Session must SURVIVE — client B is still using it.
      const c = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(c.attached).toBe(true);
      expect(c.sessionId).toBe(a.sessionId);
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
    });

    it('in-flight coalescing race: B attaches via inFlight before A reaps (BRSCi)', async () => {
      // The harder coalescing path: A and B BOTH await the same
      // doSpawn. When the spawn resolves, B's continuation must bump
      // attachCount BEFORE A's route-handler-equivalent calls
      // killSession. Slow-spawn factory → kick off both calls in
      // parallel → confirm B's session survives A's reap.
      let resolveSpawn: (() => void) | undefined;
      const slowFactory: ChannelFactory = async () => {
        await new Promise<void>((r) => {
          resolveSpawn = r;
        });
        return makeChannel().channel;
      };
      const bridge = makeBridge({
        channelFactory: slowFactory,
        sessionScope: 'single',
      });
      const aPromise = bridge.spawnOrAttach({ workspaceCwd: WS_A });
      // Wait a tick so A's spawnOrAttach reaches `await doSpawn`.
      await new Promise((r) => setTimeout(r, 5));
      // Now B comes in and finds A's promise in inFlightSpawns.
      const bPromise = bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await new Promise((r) => setTimeout(r, 5));
      // Release the spawn — both A and B's awaits now resolve.
      resolveSpawn!();
      const [a, b] = await Promise.all([aPromise, bPromise]);
      expect(a.attached).toBe(false);
      expect(b.attached).toBe(true);
      expect(b.sessionId).toBe(a.sessionId);
      // Client A's disconnect-reaper fires AFTER B has bumped
      // attachCount (which the in-flight branch now does pre-await).
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      // Session must survive — B was the late attacher.
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
    });

    it('detachClient does NOT reap when spawn owner is still alive (BkwQP)', async () => {
      // BkwQP refinement: the BX (tanzhenxin issue 2) detach-reap path
      // was eager and killed live sessions. Scenario: A spawns
      // (attached: false, hasn't opened SSE yet); B attaches
      // (attachCount: 1); B disconnects → detachClient. detachClient
      // must NOT kill A's still-valid session. Reap is only safe
      // when the spawn owner ALSO indicated they want it (via the
      // killSession-bail tombstone).
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      expect(bridge.sessionCount).toBe(1);
      // B disconnects — but A is alive. detachClient must NOT reap.
      await bridge.detachClient(b.sessionId);
      // Session survives — A would have 404'd on every subsequent
      // request otherwise.
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
    });

    it('detachClient completes deferred reap when spawn owner ALSO disconnected (BkwQP+tanzhenxin issue 2)', async () => {
      // Scenario: A spawns + disconnects (spawn-owner reap bails
      // because B already bumped attachCount); B attaches +
      // disconnects (detachClient decrements). With the tombstone
      // set during the spawn-owner bail, B's detach now completes
      // the deferred reap.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      expect(bridge.sessionCount).toBe(1);
      // A's disconnect-reaper fires: requireZeroAttaches:true bails
      // (attachCount===1 from B) but sets `spawnOwnerWantedKill`.
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      expect(bridge.sessionCount).toBe(1); // bailed, no reap
      // B disconnects: detachClient decrements attachCount→0 AND
      // sees the tombstone → completes the deferred reap.
      await bridge.detachClient(b.sessionId);
      expect(bridge.sessionCount).toBe(0);
      await bridge.shutdown();
    });

    it('detachClient does NOT reap when an SSE subscriber is live (tanzhenxin issue 2)', async () => {
      // Counterpart: when client C is actively subscribed, detach
      // from a transient B must NOT reap C's session.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(b.attached).toBe(true);
      // C opens an SSE subscription (counts as "live consumer").
      const sub = bridge.subscribeEvents(a.sessionId);
      const sublooper = (async () => {
        for await (const _ev of sub) {
          /* drain */
        }
      })();
      // Yield so the iterator's start-up runs and the subscriber
      // registers on the EventBus.
      await new Promise((r) => setImmediate(r));
      // B disconnects → detach. Session must survive.
      await bridge.detachClient(b.sessionId);
      expect(bridge.sessionCount).toBe(1);
      await bridge.shutdown();
      await sublooper.catch(() => {});
    });

    it('killSession({requireZeroAttaches:true}) DOES reap when no other client attached (BQ9tV)', async () => {
      // Counterpart to the above: when the spawn-owner truly was
      // alone, the reaper must still reap. This pins the guard's
      // negative path so a future change can't accidentally make
      // it always-skip.
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'single',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(a.attached).toBe(false);
      expect(bridge.sessionCount).toBe(1);
      // No second attach. Reaper fires.
      await bridge.killSession(a.sessionId, { requireZeroAttaches: true });
      expect(bridge.sessionCount).toBe(0);
      await bridge.shutdown();
    });

    it('maxSessions: 0 disables the cap', async () => {
      // Distinct sessionIdPrefix per spawn so each call gets a unique
      // sessionId (otherwise they'd collide in `byId` and only the
      // last would remain — making `sessionCount` stay at 1).
      let n = 0;
      const factory: ChannelFactory = async () =>
        makeChannel({ sessionIdPrefix: `s${n++}` }).channel;
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 0,
        sessionScope: 'thread',
      });
      // 5 spawns is far past the would-be default of 20 isn't, but
      // it's enough to confirm the cap is disabled (with default of
      // 20 a thread-scope flood could go 5 deep without hitting it
      // anyway, so we use a smaller test value with 0/disabled
      // explicit so a regression that re-enabled some default cap
      // would still surface).
      for (let i = 0; i < 5; i++) {
        await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      }
      expect(bridge.sessionCount).toBe(5);
      await bridge.shutdown();
    });

    it('Stage 1.5 multi-session: N sessions on same workspace share ONE channel', async () => {
      // The headline of the Stage 1.5 refactor — multiple thread-scope
      // sessions on one workspace pay for one `qwen --acp` child, not
      // N children. LaZzyMan + tanzhenxin pushed for this; the agent
      // already supports it via `acpAgent.ts:194 sessions:
      // Map<string, Session>`.
      let factoryCalls = 0;
      const factory: ChannelFactory = async () => {
        factoryCalls++;
        return makeChannel({ sessionIdPrefix: `s${factoryCalls}` }).channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        maxSessions: 0,
        sessionScope: 'thread',
      });
      // Spin up 5 sessions on the same workspace.
      const sessions = await Promise.all(
        Array.from({ length: 5 }, () =>
          bridge.spawnOrAttach({ workspaceCwd: WS_A }),
        ),
      );
      // 5 distinct sessions...
      expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(5);
      expect(bridge.sessionCount).toBe(5);
      // ...but only ONE channelFactory call (= one child process).
      expect(factoryCalls).toBe(1);
      await bridge.shutdown();
    });

    it('Stage 1.5: killSession on one of N sessions does NOT kill the shared channel', async () => {
      // Counterpart guarantee: tearing down one session must not take
      // its siblings with it. The channel stays alive while
      // `channelInfo.sessionIds.size > 0`.
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const c = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(handles).toHaveLength(1);
      // Kill one — the other two stay.
      await bridge.killSession(b.sessionId);
      expect(bridge.sessionCount).toBe(2);
      expect(handles[0]?.killed).toBe(false);
      // Kill the second — last one alive.
      await bridge.killSession(a.sessionId);
      expect(bridge.sessionCount).toBe(1);
      expect(handles[0]?.killed).toBe(false);
      // Kill the last — NOW the channel is killed.
      await bridge.killSession(c.sessionId);
      expect(bridge.sessionCount).toBe(0);
      expect(handles[0]?.killed).toBe(true);
      await bridge.shutdown();
    });

    it('Stage 1.5: channel.exited tears down ALL multiplexed sessions', async () => {
      // When the shared child dies (crash, kill, network gone), all
      // sessions on it die together — they're truly co-fated. Each
      // session's bus gets its own `session_died` event so each SSE
      // subscriber learns the bad news on their own stream.
      const handles: ChannelHandle[] = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel({ sessionIdPrefix: `s${handles.length}` });
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({
        channelFactory: factory,
        sessionScope: 'thread',
      });
      const a = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const b = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const c = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(3);

      // Subscribe so we can observe each session_died.
      const eventsByA: BridgeEvent[] = [];
      const eventsByB: BridgeEvent[] = [];
      const eventsByC: BridgeEvent[] = [];
      const drainA = (async () => {
        for await (const ev of bridge.subscribeEvents(a.sessionId))
          eventsByA.push(ev);
      })();
      const drainB = (async () => {
        for await (const ev of bridge.subscribeEvents(b.sessionId))
          eventsByB.push(ev);
      })();
      const drainC = (async () => {
        for await (const ev of bridge.subscribeEvents(c.sessionId))
          eventsByC.push(ev);
      })();
      // Let the subscriptions register before crashing.
      await new Promise((r) => setImmediate(r));

      // Simulate channel-level crash (child exited).
      handles[0]?.crash();
      await Promise.all([drainA, drainB, drainC]);

      expect(eventsByA[eventsByA.length - 1]?.type).toBe('session_died');
      expect(eventsByB[eventsByB.length - 1]?.type).toBe('session_died');
      expect(eventsByC[eventsByC.length - 1]?.type).toBe('session_died');
      expect(bridge.sessionCount).toBe(0);

      await bridge.shutdown();
    });
  });

  describe('closeSession', () => {
    it('publishes session_closed and removes session from maps', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.sessionCount).toBe(1);

      const events: BridgeEvent[] = [];
      const drain = (async () => {
        for await (const ev of bridge.subscribeEvents(session.sessionId))
          events.push(ev);
      })();
      await new Promise((r) => setImmediate(r));

      await bridge.closeSession(session.sessionId);
      await drain;

      expect(bridge.sessionCount).toBe(0);
      const closedEvent = events.find((e) => e.type === 'session_closed');
      expect(closedEvent).toBeDefined();
      expect((closedEvent?.data as { reason: string }).reason).toBe(
        'client_close',
      );

      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session', async () => {
      const bridge = makeBridge();
      await expect(bridge.closeSession('nonexistent')).rejects.toThrow(
        SessionNotFoundError,
      );
      await bridge.shutdown();
    });

    it('resolves pending permissions as cancelled', async () => {
      let capturedConn: AgentSideConnection | undefined;
      const factory: ChannelFactory = async () => {
        const { clientStream, agentStream } = createInMemoryChannel();
        const fakeAgent = new FakeAgent();
        capturedConn = new AgentSideConnection(() => fakeAgent, agentStream);
        return {
          stream: clientStream,
          exited: new Promise<
            | {
                exitCode: number | null;
                signalCode: NodeJS.Signals | null;
              }
            | undefined
          >(() => {}),
          kill: async () => {},
          killSync: () => {},
        };
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const conn = capturedConn!;

      const events: BridgeEvent[] = [];
      const drain = (async () => {
        for await (const ev of bridge.subscribeEvents(session.sessionId))
          events.push(ev);
      })();
      await new Promise((r) => setImmediate(r));

      const respPromise = (
        conn as unknown as {
          requestPermission(p: unknown): Promise<unknown>;
        }
      ).requestPermission({
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'rm -rf /' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });

      await new Promise((r) => setImmediate(r));
      expect(bridge.pendingPermissionCount).toBe(1);

      await bridge.closeSession(session.sessionId);
      await drain;

      const result = (await respPromise) as {
        outcome: { outcome: string };
      };
      expect(result.outcome.outcome).toBe('cancelled');
      expect(bridge.pendingPermissionCount).toBe(0);
      const resolvedIndex = events.findIndex(
        (e) => e.type === 'permission_resolved',
      );
      const closedIndex = events.findIndex((e) => e.type === 'session_closed');
      expect(resolvedIndex).toBeGreaterThanOrEqual(0);
      expect(closedIndex).toBeGreaterThan(resolvedIndex);
      expect(events[resolvedIndex]?.data).toMatchObject({
        outcome: { outcome: 'cancelled' },
      });

      await bridge.shutdown();
    });
  });

  describe('updateSessionMetadata', () => {
    it('publishes session_metadata_updated event', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const events: BridgeEvent[] = [];
      const sub = bridge.subscribeEvents(session.sessionId);
      const drain = (async () => {
        for await (const ev of sub) events.push(ev);
      })();
      await new Promise((r) => setImmediate(r));

      bridge.updateSessionMetadata(session.sessionId, {
        displayName: 'Test Session',
      });

      await new Promise((r) => setImmediate(r));
      const metaEvent = events.find(
        (e) => e.type === 'session_metadata_updated',
      );
      expect(metaEvent).toBeDefined();
      expect((metaEvent?.data as { displayName: string }).displayName).toBe(
        'Test Session',
      );

      await bridge.closeSession(session.sessionId);
      await drain;
      await bridge.shutdown();
    });

    it('rejects displayName values with control characters', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      expect(() =>
        bridge.updateSessionMetadata(session.sessionId, {
          displayName: 'bad\nname',
        }),
      ).toThrow(InvalidSessionMetadataError);

      await bridge.closeSession(session.sessionId);
      await bridge.shutdown();
    });

    it('throws SessionNotFoundError for unknown session', () => {
      const bridge = makeBridge();
      expect(() =>
        bridge.updateSessionMetadata('nonexistent', {
          displayName: 'test',
        }),
      ).toThrow(SessionNotFoundError);
    });
  });

  describe('enriched listWorkspaceSessions', () => {
    it('includes createdAt and metadata fields', async () => {
      const handles: Array<{ killed: boolean }> = [];
      const factory: ChannelFactory = async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      };
      const bridge = makeBridge({ channelFactory: factory });
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });

      const sessions = bridge.listWorkspaceSessions(WS_A);
      expect(sessions).toHaveLength(1);
      const s = sessions[0]!;
      expect(s.createdAt).toBeDefined();
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.clientCount).toBe('number');
      expect(typeof s.hasActivePrompt).toBe('boolean');
      expect(s.hasActivePrompt).toBe(false);

      await bridge.shutdown();
    });
  });

  describe('publishWorkspaceEvent + knownClientIds (issue #4175 PR 16)', () => {
    it('fans out a workspace event onto every active session bus', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      const aFrames: BridgeEvent[] = [];
      const bFrames: BridgeEvent[] = [];
      const collect = async (
        sessionId: string,
        target: BridgeEvent[],
        signal: AbortSignal,
      ) => {
        for await (const frame of bridge.subscribeEvents(sessionId, {
          signal,
        })) {
          target.push(frame);
        }
      };
      const ctrl = new AbortController();
      const tasks = Promise.all([
        collect(a.sessionId, aFrames, ctrl.signal),
        collect(b.sessionId, bFrames, ctrl.signal),
      ]);
      // Yield once so the subscribe handlers register.
      await new Promise((resolve) => setImmediate(resolve));

      bridge.publishWorkspaceEvent({
        type: 'memory_changed',
        data: {
          scope: 'workspace',
          filePath: '/work/QWEN.md',
          mode: 'append',
          bytesWritten: 5,
        },
      });

      // Yield so the bus's async push reaches both subscribers.
      await new Promise((resolve) => setImmediate(resolve));

      expect(aFrames.some((f) => f.type === 'memory_changed')).toBe(true);
      expect(bFrames.some((f) => f.type === 'memory_changed')).toBe(true);

      ctrl.abort();
      await tasks.catch(() => {});
      await bridge.shutdown();
    });

    it('returns an empty knownClientIds set when no clients are attached', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const ids = bridge.knownClientIds();
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(0);
      await bridge.shutdown();
    });

    it('aggregates clientIds across sessions in knownClientIds()', async () => {
      const factory: ChannelFactory = async () => makeChannel().channel;
      const bridge = makeBridge({ channelFactory: factory });
      const a = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      const b = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });

      const ids = bridge.knownClientIds();
      expect(ids.size).toBe(2);
      expect(ids.has(a.clientId!)).toBe(true);
      expect(ids.has(b.clientId!)).toBe(true);

      // Snapshot semantics: mutating the returned Set must not
      // affect future calls. The interface returns
      // `ReadonlySet<string>` so cast through `Set<string>` to attempt
      // a mutation; the live registry must stay intact.
      (ids as Set<string>).delete(a.clientId!);
      const fresh = bridge.knownClientIds();
      expect(fresh.size).toBe(2);

      await bridge.shutdown();
    });
  });
});

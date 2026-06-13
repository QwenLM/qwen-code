/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  InvalidClientIdError,
  PromptQueueFullError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
} from '@qwen-code/acp-bridge/bridgeErrors';
import { SessionService } from '@qwen-code/qwen-code-core';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { mountAcpHttp } from './index.js';

const stdioMocks = vi.hoisted(() => ({
  writeStderrLine: vi.fn(),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: stdioMocks.writeStderrLine,
}));

/**
 * End-to-end transport test: boots a real Express server with the ACP
 * Streamable-HTTP transport mounted over a *fake* bridge, then drives it
 * with a real HTTP client (global fetch + manual SSE parsing). This is
 * the automated form of the design doc's local verification plan — it
 * exercises the actual wire protocol (200/202 conventions, both SSE
 * streams, JSON-RPC framing) without needing a model.
 */

interface PushIterable {
  iterable: AsyncIterable<BridgeEvent>;
  push: (e: Omit<BridgeEvent, 'v'>) => void;
  end: () => void;
}

function pushQueue(signal?: AbortSignal): PushIterable {
  const buf: BridgeEvent[] = [];
  let resolveNext: (() => void) | undefined;
  let done = false;
  let nextId = 1;
  const wake = () => {
    resolveNext?.();
    resolveNext = undefined;
  };
  signal?.addEventListener('abort', () => {
    done = true;
    wake();
  });
  const iterable: AsyncIterable<BridgeEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buf.length) yield buf.shift()!;
        if (done) return;
        await new Promise<void>((r) => (resolveNext = r));
      }
    },
  };
  return {
    iterable,
    push: (e) => {
      buf.push({ v: 1, id: nextId++, ...e } as BridgeEvent);
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
  };
}

// A controllable fake bridge: tests register what `sendPrompt` should do.
class FakeBridge {
  queues = new Map<string, PushIterable>();
  promptBehavior:
    | ((
        sessionId: string,
        q: PushIterable,
        signal?: AbortSignal,
      ) => Promise<unknown>)
    | undefined;
  lastSetModel: unknown;
  lastSpawnScope: string | undefined;
  closeShouldThrow = false;
  closeError: Error | undefined;
  killed: string[] = [];
  cancelled: string[] = [];
  /** When set, spawnOrAttach/loadSession await it (to simulate a slow bridge). */
  gate: Promise<void> | undefined;
  /** `attached` value loadSession returns (false = spawned-from-disk). */
  loadAttached = true;
  spawnClientId: string | undefined = 'client-1';

  closedSessions: string[] = [];

  async spawnOrAttach(req: { sessionScope?: string }) {
    this.lastSpawnScope = req?.sessionScope;
    if (this.gate) await this.gate;
    return {
      sessionId: 'sess-1',
      workspaceCwd: '/ws',
      attached: false,
      clientId: this.spawnClientId,
    };
  }
  async killSession(sessionId: string) {
    this.killed.push(sessionId);
  }

  loadShouldThrow = false;

  async loadSession(req: { sessionId: string }) {
    if (this.loadShouldThrow) throw new Error('load failed');
    if (this.gate) await this.gate;
    return {
      sessionId: req.sessionId,
      workspaceCwd: '/ws',
      attached: this.loadAttached,
      clientId: 'client-load',
      state: { replayed: true },
    };
  }

  async resumeSession(req: { sessionId: string }) {
    return {
      sessionId: req.sessionId,
      workspaceCwd: '/ws',
      attached: true,
      clientId: 'client-resume',
      state: { resumed: true },
    };
  }

  subscribeThrows = false;

  subscribeEvents(sessionId: string, opts?: { signal?: AbortSignal }) {
    if (this.subscribeThrows) throw new Error('subscribe failed');
    const q = pushQueue(opts?.signal);
    this.queues.set(sessionId, q);
    return q.iterable;
  }

  sendPrompt(sessionId: string, _req: unknown, signal?: AbortSignal) {
    const q = this.queues.get(sessionId);
    if (this.promptBehavior && q) {
      return Promise.resolve(this.promptBehavior(sessionId, q, signal));
    }
    return Promise.resolve({ stopReason: 'end_turn' });
  }

  respondToSessionPermission() {
    return true;
  }

  async setSessionModel(_s: string, req: unknown) {
    this.lastSetModel = req;
    return { modelServiceId: 'qwen-max' };
  }

  lastApprovalMode: string | undefined;
  async setSessionApprovalMode(_s: string, mode: string) {
    this.lastApprovalMode = mode;
    return { sessionId: 'sess-1', mode, previous: 'default', persisted: false };
  }

  // Session config options live in the child's session context state.
  async getSessionContextStatus(sessionId: string) {
    return {
      v: 1,
      sessionId,
      workspaceCwd: '/ws',
      state: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'qwen-max',
            options: [],
          },
        ],
      },
    };
  }
  async getSessionSupportedCommandsStatus(sessionId: string) {
    return { v: 1, sessionId, availableCommands: [], availableSkills: [] };
  }
  updateSessionMetadata(_s: string, metadata: unknown) {
    return metadata;
  }

  recordHeartbeat() {
    return { sessionId: 'sess-1', lastSeenAt: Date.now() };
  }

  listWorkspaceSessions() {
    return [];
  }

  detached: Array<{ sessionId: string; clientId?: string }> = [];

  async cancelSession(sessionId: string) {
    this.cancelled.push(sessionId);
  }
  closeGate: Promise<void> | undefined;
  async closeSession(sessionId: string) {
    this.closedSessions.push(sessionId);
    if (this.closeGate) await this.closeGate;
    if (this.closeError) throw this.closeError;
    if (this.closeShouldThrow) throw new Error('bridge close failed');
  }
  async detachClient(sessionId: string, clientId?: string) {
    this.detached.push({ sessionId, clientId });
  }
  async preheat() {}

  // Wave 1+2 stubs
  async generateSessionRecap(sessionId: string) {
    return { sessionId, recap: 'test recap' };
  }
  async generateSessionBtw(sessionId: string, question: string) {
    return { sessionId, answer: `re: ${question}` };
  }
  shellCalls: Array<{
    sessionId: string;
    command: string;
    signal?: AbortSignal;
    context?: unknown;
  }> = [];
  shellError: unknown;
  async executeShellCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    context?: unknown,
  ) {
    this.shellCalls.push({
      sessionId,
      command,
      ...(signal !== undefined ? { signal } : {}),
      ...(context !== undefined ? { context } : {}),
    });
    if (this.shellError !== undefined) throw this.shellError;
    return { exitCode: 0, output: `$ ${command}`, aborted: false };
  }
  async getSessionContextUsageStatus(sessionId: string) {
    return { sessionId, used: 100, total: 1000 };
  }
  async getSessionTasksStatus(sessionId: string) {
    return { sessionId, tasks: [] };
  }
  async getWorkspaceToolsStatus() {
    return { v: 1, tools: [] };
  }
  async getWorkspaceMcpToolsStatus(serverName: string) {
    return { v: 1, serverName, tools: [] };
  }
  async addRuntimeMcpServer(name: string) {
    return {
      name,
      transport: 'stdio',
      replaced: false,
      shadowedSettings: false,
      toolCount: 0,
      originatorClientId: 'c',
    };
  }
  async removeRuntimeMcpServer(name: string) {
    return {
      name,
      removed: true,
      wasShadowingSettings: false,
      originatorClientId: 'c',
    };
  }
  publishWorkspaceEvent() {}
  knownClientIds() {
    return new Set<string>();
  }
}

// A minimal fake workspace service for dispatch tests.
const fakeWorkspace = {
  async getWorkspaceMcpStatus() {
    return { ok: true, v: 1, workspaceCwd: '/ws' };
  },
  async getWorkspaceSkillsStatus() {
    return { ok: true };
  },
  async getWorkspaceProvidersStatus() {
    return { ok: true };
  },
  async getWorkspaceEnvStatus() {
    return { ok: true };
  },
  async getWorkspacePreflightStatus() {
    return { ok: true };
  },
  async setWorkspaceToolEnabled(
    _ctx: unknown,
    toolName: string,
    enabled: boolean,
  ) {
    return { toolName, enabled };
  },
  async initWorkspace() {
    return { path: '/ws/QWEN.md', action: 'created' as const };
  },
  async restartMcpServer() {
    return { ok: true };
  },
  async reload() {
    return {
      env: { updatedKeys: [], removedKeys: [] },
      changedKeys: [],
      childReloaded: false,
    };
  },
} as unknown as DaemonWorkspaceService;

// ── SSE client helper ────────────────────────────────────────────────
async function* readSse(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) yield JSON.parse(dataLine.slice('data: '.length));
    }
  }
}

/** Read the next N data frames from an SSE response, then abort. */
async function takeFrames(
  res: Response,
  n: number,
  timeoutMs = 2000,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for await (const f of readSse(res, ac.signal)) {
      out.push(f);
      if (out.length >= n) break;
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return out;
}

function frameReader(res: Response) {
  const ac = new AbortController();
  const iterator = readSse(res, ac.signal)[Symbol.asyncIterator]();
  return {
    async next(timeoutMs = 2000): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error('Timed out waiting for SSE frame'));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([iterator.next(), timeout]);
        if (result.done) throw new Error('SSE stream ended');
        return result.value;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close(): void {
      ac.abort();
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('ACP Streamable HTTP transport (over the wire)', () => {
  let server: Server;
  let base: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    stdioMocks.writeStderrLine.mockClear();
    bridge = new FakeBridge();
    const app = express();
    app.use(express.json());
    mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
      boundWorkspace: '/ws',
      workspace: fakeWorkspace,
      enabled: true,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    // Force-close any long-lived SSE sockets a test left open so
    // `server.close()` doesn't hang on them.
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function restartServer(opts: {
    sessionShellCommandEnabled?: boolean;
    nextBridge?: FakeBridge;
  }): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    bridge = opts.nextBridge ?? new FakeBridge();
    const app = express();
    app.use(express.json());
    mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
      boundWorkspace: '/ws',
      workspace: fakeWorkspace,
      enabled: true,
      sessionShellCommandEnabled: opts.sessionShellCommandEnabled,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  }

  async function initializeRaw(): Promise<{
    connId: string;
    body: Record<string, unknown>;
  }> {
    const res = await fetch(`${base}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    const connId = res.headers.get('acp-connection-id');
    expect(connId).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    return { connId: connId!, body };
  }

  async function initialize(): Promise<string> {
    const { connId, body } = await initializeRaw();
    const result = body['result'] as { protocolVersion: number };
    expect(result.protocolVersion).toBe(1);
    return connId;
  }

  function post(connId: string, msg: unknown) {
    return fetch(`${base}/acp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'acp-connection-id': connId,
      },
      body: JSON.stringify(msg),
    });
  }

  function openStream(connId: string, sessionId?: string) {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'acp-connection-id': connId,
    };
    if (sessionId) headers['acp-session-id'] = sessionId;
    return fetch(`${base}/acp`, { headers });
  }

  // Establish ownership of the fake bridge's session ('sess-1') so the
  // ownership-gated session stream + per-session POSTs are allowed.
  async function newSession(connId: string, id = 99): Promise<void> {
    await post(connId, {
      jsonrpc: '2.0',
      id,
      method: 'session/new',
      params: {},
    });
    await new Promise((r) => setTimeout(r, 30)); // let handle() register ownership
  }

  it('initialize → 200 + Acp-Connection-Id; unknown conn → 404', async () => {
    await initialize();
    const bad = await post('nope', {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
    });
    expect(bad.status).toBe(404);
  });

  it('initialize omits _qwen/session/shell by default', async () => {
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).not.toContain(
      '_qwen/session/shell',
    );
  });

  it('initialize advertises _qwen/session/shell when enabled', async () => {
    await restartServer({ sessionShellCommandEnabled: true });
    const { body } = await initializeRaw();
    const result = body['result'] as {
      agentCapabilities: {
        _meta: { qwen: { methods: string[] } };
      };
    };
    expect(result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/session/shell',
    );
  });

  it('session/new reply rides the connection-scoped stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    // Give the SSE handshake a tick before POSTing.
    await new Promise((r) => setTimeout(r, 50));
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/ws' },
    });
    expect(ack.status).toBe(202);
    const [frame] = (await got) as Array<{
      id: number;
      result: { sessionId: string };
    }>;
    expect(frame.id).toBe(2);
    expect(frame.result.sessionId).toBe('sess-1');
  });

  it('prompt streams session/update then the final result', async () => {
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'session_update',
        data: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    const ack = await post(connId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(ack.status).toBe(202);
    const frames = (await got) as Array<Record<string, unknown>>;
    expect(frames[0]['method']).toBe('session/update');
    expect(
      (frames[1] as { id: number; result: { stopReason: string } }).id,
    ).toBe(5);
    expect(
      (frames[1] as { result: { stopReason: string } }).result.stopReason,
    ).toBe('end_turn');
  });

  it('permission request round-trips agent→client→agent', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      resolvedWith = resp;
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-1',
          sessionId: 'sess-1',
          toolCall: { name: 'shell' },
          options: [{ optionId: 'allow', name: 'Allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const reader = frameReader(sessStream);
    try {
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'rm' }],
        },
      });
      const reqFrame = (await reader.next()) as {
        id: number;
        method: string;
        params: { _meta: Record<string, { requestId: string }> };
      };
      expect(reqFrame.method).toBe('session/request_permission');
      expect(reqFrame.params._meta['qwen'].requestId).toBe('perm-1');
      // Client answers with a JSON-RPC response echoing the issued id.
      await post(connId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await waitUntil(() => resolvedWith !== undefined);
      expect(resolvedWith).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    } finally {
      reader.close();
    }
  });

  it('standard session/set_config_option (model) routes to the bridge', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 9,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'model', value: 'qwen-max' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { configOptions: unknown };
    }>;
    expect(frame.id).toBe(9);
    expect(bridge.lastSetModel).toMatchObject({ modelId: 'qwen-max' });
  });

  it('session/set_config_option (mode) routes to setSessionApprovalMode', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 10,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'mode', value: 'yolo' },
    });
    await got;
    expect(bridge.lastApprovalMode).toBe('yolo');
  });

  it('_qwen/workspace/mcp introspection reaches the bridge', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 12,
      method: '_qwen/workspace/mcp',
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { ok: boolean };
    }>;
    expect(frame.id).toBe(12);
    expect(frame.result.ok).toBe(true);
  });

  it('unknown method → JSON-RPC method-not-found on conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, { jsonrpc: '2.0', id: 11, method: 'bogus/method' });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32601);
  });

  it('session stream for an unowned session → 403', async () => {
    const connId = await initialize();
    // No session/new → connection does not own 'sess-1'.
    const res = await openStream(connId, 'sess-1');
    expect(res.status).toBe(403);
  });

  it('prompt for an unowned session → INVALID_PARAMS on conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 13,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('Acp-Session-Id header that disagrees with params.sessionId → INVALID_PARAMS', async () => {
    // Cross-check fires before ownership, so no session/new needed (and
    // skipping it keeps a buffered session/new reply off the conn stream).
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${base}/acp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'acp-connection-id': connId,
        'acp-session-id': 'sess-1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'session/prompt',
        params: { sessionId: 'OTHER', prompt: [{ type: 'text', text: 'x' }] },
      }),
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('session/load owns the session + replies state on the conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'session/load',
      params: { sessionId: 'loaded-1' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { replayed: boolean };
    }>;
    expect(frame.id).toBe(20);
    expect(frame.result.replayed).toBe(true);
    // Ownership was granted, so the session stream is now allowed.
    const sess = await openStream(connId, 'loaded-1');
    expect(sess.status).toBe(200);
    await sess.body?.cancel(); // release the long-lived SSE socket
  });

  it('session/resume owns the session + replies state', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 21,
      method: 'session/resume',
      params: { sessionId: 'resumed-1' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      result: { resumed: boolean };
    }>;
    expect(frame.id).toBe(21);
    expect(frame.result.resumed).toBe(true);
  });

  it('session/close reaches the bridge + replies on the conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    // 2 frames: the session/new reply (establishes ownership), then close.
    const got = takeFrames(connStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 99,
      method: 'session/new',
      params: {},
    });
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 22,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    const frames = (await got) as Array<{ id: number }>;
    expect(frames.map((f) => f.id)).toContain(22);
    expect(bridge.closedSessions).toContain('sess-1');
  });

  it('initialize clamps protocolVersion to [1, 1]', async () => {
    for (const [requested, expected] of [
      [0, 1],
      [-3, 1],
      [99, 1],
      ['bad', 1],
    ] as Array<[unknown, number]>) {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: requested },
        }),
      });
      const body = (await res.json()) as {
        result: { protocolVersion: number };
      };
      expect(body.result.protocolVersion).toBe(expected);
    }
  });

  it('session/load failure routes the error to the connection stream', async () => {
    bridge.loadShouldThrow = true;
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 30,
      method: 'session/load',
      params: { sessionId: 'x' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.id).toBe(30);
    expect(frame.error.code).toBe(-32603);
  });

  it('connection teardown detaches the session client from the bridge', async () => {
    const connId = await initialize();
    await newSession(connId);
    await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.detached.some((d) => d.sessionId === 'sess-1')).toBe(true);
  });

  it('malformed permission response still releases the bridge (cancel fallback)', async () => {
    const votes: Array<{ outcome?: { outcome?: string } }> = [];
    // Emulate the real bridge: throw on a vote with no `outcome`.
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      const r = resp as { outcome?: { outcome?: string } };
      if (!r?.outcome?.outcome) throw new Error('invalid permission response');
      votes.push(r);
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-x',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 40));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 50,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: string }>;
    // Client answers with a malformed result (no outcome) → bridge throws →
    // fallback must still cancel so the mediator is released.
    await post(connId, { jsonrpc: '2.0', id: reqFrame.id, result: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(votes).toContainEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('a second concurrent prompt aborts the first', async () => {
    let firstSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, _q, signal) => {
      if (!firstSignal) {
        firstSignal = signal;
        await new Promise<void>((r) =>
          signal?.addEventListener('abort', () => r(), { once: true }),
        );
        return { stopReason: 'cancelled' };
      }
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const drain = takeFrames(sessStream, 2); // both prompt results
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 60,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'a' }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 61,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'b' }] },
    });
    await drain;
    expect(firstSignal?.aborted).toBe(true);
  });

  it('subscribeEvents throwing closes the session stream promptly (no zombie)', async () => {
    bridge.subscribeThrows = true;
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    // The guarantee is that the server CLOSES the stream (not a zombie that
    // heartbeats forever). A safety abort at 3s distinguishes "server closed"
    // (loop ends fast) from "zombie" (only our timeout ends it).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const start = Date.now();
    try {
      for await (const _f of readSse(sessStream, ac.signal)) {
        // drain
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    // Server-initiated close arrives well under the 3s safety timeout.
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('concurrent session/close calls the bridge exactly once (no TOCTOU double-close)', async () => {
    const connId = await initialize();
    await newSession(connId);
    await Promise.all([
      post(connId, {
        jsonrpc: '2.0',
        id: 70,
        method: 'session/close',
        params: { sessionId: 'sess-1' },
      }),
      post(connId, {
        jsonrpc: '2.0',
        id: 71,
        method: 'session/close',
        params: { sessionId: 'sess-1' },
      }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.closedSessions.filter((s) => s === 'sess-1')).toHaveLength(1);
  });

  it('clean iterator end closes the session stream (no zombie)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 50));
    // Subprocess ends cleanly → bridge event iterator returns done.
    bridge.queues.get('sess-1')?.end();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const start = Date.now();
    try {
      for await (const _f of readSse(sessStream, ac.signal)) {
        // drain
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('session-stream reconnect does NOT abort the in-flight prompt', async () => {
    let promptSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, q, signal) => {
      promptSignal = signal;
      q.push({
        type: 'session_update',
        data: { sessionId: 'sess-1', update: {} },
      });
      await new Promise((r) => setTimeout(r, 200));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const s1 = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 40));
    await post(connId, {
      jsonrpc: '2.0',
      id: 80,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 40));
    // Reconnect: install the NEW stream and let it attach FIRST, then drop the
    // old one. This deterministically exercises the invariant under test —
    // the old (now-stale) stream's close must NOT abort the prompt because a
    // newer stream is already the session's current one (install-before-close
    // + identity-guarded onClose). (Attaching s2 before dropping s1 avoids a
    // test-only race between s1.close and s2.attach under full-suite load.)
    const s2 = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 40));
    await s1.body?.cancel();
    await new Promise((r) => setTimeout(r, 40));
    // The prompt must survive the reconnect.
    expect(promptSignal?.aborted).toBe(false);
    await s2.body?.cancel();
  });

  it('prompt response is delivered even if the session closes mid-flight', async () => {
    // Prompt resolves only after we close the session — exercises the
    // binding-gone fallback (reply must ride the connection stream).
    let release: () => void = () => {};
    bridge.promptBehavior = async (_s, _q) => {
      await new Promise<void>((r) => (release = r));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const sessStream = await openStream(connId, 'sess-1');
    // conn stream carries: buffered session/new reply (id 99), the close
    // ack (id 91), AND the fallback prompt reply (id 90).
    const connFrames = takeFrames(connStream, 3);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 90,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    // Close the session while the prompt is still in flight, then let it resolve.
    await post(connId, {
      jsonrpc: '2.0',
      id: 91,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 30));
    release();
    const frames = (await connFrames) as Array<{ id: number }>;
    // The prompt's id-90 response must appear (on the conn stream, since the
    // session binding is gone) — not silently dropped.
    expect(frames.map((f) => f.id)).toContain(90);
    await sessStream.body?.cancel();
  });

  it('session/set_config_option rejects empty value (INVALID_PARAMS)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 41,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'model', value: '' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('session/set_config_option rejects an invalid mode value', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 42,
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'mode', value: 'bogus-mode' },
    });
    const [frame] = (await got) as Array<{
      id: number;
      error: { code: number };
    }>;
    expect(frame.error.code).toBe(-32602);
    expect(bridge.lastApprovalMode).toBeUndefined();
  });

  it('session/new always uses thread scope (ACP standard compliance)', async () => {
    // ACP standard: session/new MUST create a new isolated session.
    // sessionScope param is ignored; bridge always gets 'thread'.
    const connId = await initialize();
    await post(connId, {
      jsonrpc: '2.0',
      id: 43,
      method: 'session/new',
      params: { sessionScope: 'single' }, // ignored
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.lastSpawnScope).toBe('thread');

    // Even 'bogus' is ignored (not rejected) — param is simply not read
    const c2 = await initialize();
    await post(c2, {
      jsonrpc: '2.0',
      id: 44,
      method: 'session/new',
      params: { sessionScope: 'bogus' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.lastSpawnScope).toBe('thread');
  });

  it('session/prompt with empty prompt → INVALID_PARAMS', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 45,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [] },
    });
    const [frame] = (await got) as Array<{ error: { code: number } }>;
    expect(frame.error.code).toBe(-32602);
  });

  it('session/prompt queue cap error includes stable JSON-RPC data', async () => {
    bridge.promptBehavior = () => {
      throw new PromptQueueFullError(5, 5, 'sess-1');
    };
    const connId = await initialize();
    await newSession(connId);
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 46,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });

    const [frame] = (await got) as Array<{
      error: { code: number; data: Record<string, unknown> };
    }>;
    expect(frame.error.code).toBe(-32603);
    expect(frame.error.data).toMatchObject({
      errorKind: 'prompt_queue_full',
      sessionId: 'sess-1',
      limit: 5,
      pendingCount: 5,
    });
  });

  it('session/close runs local cleanup even if the bridge close throws', async () => {
    bridge.closeShouldThrow = true;
    const connId = await initialize();
    await newSession(connId); // creates + owns sess-1
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 46,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.closedSessions).toContain('sess-1'); // bridge was called (then threw)
    // Local teardown ran in `finally` despite the throw → session unowned now.
    const after = await openStream(connId, 'sess-1');
    expect(after.status).toBe(403);
  });

  it('connection cap → 503 on initialize', async () => {
    const app2 = express();
    app2.use(express.json());
    mountAcpHttp(app2, bridge as unknown as HttpAcpBridge, {
      boundWorkspace: '/ws',
      workspace: fakeWorkspace,
      enabled: true,
      maxConnections: 1,
    });
    const srv = app2.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/acp`;
    const init = (n: number) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'initialize' }),
      });
    const r1 = await init(1);
    expect(r1.status).toBe(200);
    const r2 = await init(2);
    expect(r2.status).toBe(503);
    expect(r2.headers.get('retry-after')).toBe('5');
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('session/cancel aborts the in-flight prompt and calls the bridge', async () => {
    let promptSignal: AbortSignal | undefined;
    bridge.promptBehavior = async (_s, _q, signal) => {
      promptSignal = signal;
      await new Promise((r) => setTimeout(r, 300));
      return { stopReason: 'cancelled' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 40));
    await post(connId, {
      jsonrpc: '2.0',
      id: 50,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 40));
    await post(connId, {
      jsonrpc: '2.0',
      id: 51,
      method: 'session/cancel',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(promptSignal?.aborted).toBe(true);
    expect(bridge.cancelled).toContain('sess-1');
    await sess.body?.cancel();
  });

  it('session/new rejects bad cwd (non-string + relative) → INVALID_PARAMS', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 60,
      method: 'session/new',
      params: { cwd: 123 },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 61,
      method: 'session/new',
      params: { cwd: 'rel/path' },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number };
    }>;
    for (const f of frames) expect(f.error?.code).toBe(-32602);
  });

  it('session/new orphan: DELETE before spawn resolves → bridge.killSession', async () => {
    let release: () => void = () => {};
    bridge.gate = new Promise<void>((r) => (release = r));
    const connId = await initialize();
    await post(connId, {
      jsonrpc: '2.0',
      id: 70,
      method: 'session/new',
      params: {},
    });
    await new Promise((r) => setTimeout(r, 30)); // spawnOrAttach now awaiting the gate
    await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    release(); // spawn resolves AFTER destroy
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.killed).toContain('sess-1');
  });

  it('session/load orphan (attached:false) → killSession, not detach', async () => {
    let release: () => void = () => {};
    bridge.gate = new Promise<void>((r) => (release = r));
    bridge.loadAttached = false; // restore SPAWNED from disk → must be killed
    const connId = await initialize();
    await post(connId, {
      jsonrpc: '2.0',
      id: 80,
      method: 'session/load',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 30));
    await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.killed).toContain('sess-1');
    expect(bridge.detached.some((d) => d.sessionId === 'sess-1')).toBe(false);
  });

  it('_qwen/* introspection methods reach the bridge (conn-routed)', async () => {
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    // 4 frames: buffered session/new reply (id 99) + the 3 below.
    const got = takeFrames(connStream, 4);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 200,
      method: '_qwen/session/context',
      params: { sessionId: 'sess-1' },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 201,
      method: '_qwen/session/heartbeat',
      params: { sessionId: 'sess-1' },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 202,
      method: '_qwen/workspace/skills',
    });
    const ids = ((await got) as Array<{ id?: number }>).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([200, 201, 202]));
  });

  it('_qwen/workspace/set_tool_enabled + restart_mcp_server validate name', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 3);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 210,
      method: '_qwen/workspace/set_tool_enabled',
      params: { toolName: '', enabled: true },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 211,
      method: '_qwen/workspace/restart_mcp_server',
      params: { serverName: '' },
    });
    await post(connId, {
      jsonrpc: '2.0',
      id: 212,
      method: '_qwen/workspace/set_tool_enabled',
      params: { toolName: 'shell', enabled: false },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number };
      result?: unknown;
    }>;
    const byId = Object.fromEntries(frames.map((f) => [f.id, f]));
    expect(byId[210].error?.code).toBe(-32602);
    expect(byId[211].error?.code).toBe(-32602);
    expect(byId[212].result).toBeDefined();
  });

  it('translateEvent: stream_error + client_evicted → _qwen/notify with kind', async () => {
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    const got = takeFrames(sess, 2);
    await new Promise((r) => setTimeout(r, 50));
    const q = bridge.queues.get('sess-1');
    q?.push({ type: 'stream_error', data: { error: 'boom' } });
    q?.push({ type: 'client_evicted', data: { reason: 'slow' } });
    const frames = (await got) as Array<{
      method: string;
      params: { kind: string };
    }>;
    expect(frames.every((f) => f.method === '_qwen/notify')).toBe(true);
    const kinds = frames.map((f) => f.params.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['stream_error', 'client_evicted']),
    );
    // (takeFrames already locked + aborted `sess`; afterEach force-closes.)
  });

  it('session/load while a session/close is in-flight → rejected (TOCTOU guard)', async () => {
    let releaseClose: () => void = () => {};
    bridge.closeGate = new Promise<void>((r) => (releaseClose = r));
    const connId = await initialize();
    await newSession(connId);
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 2); // session/new reply + load reject
    await new Promise((r) => setTimeout(r, 50));
    // close is now in flight (awaiting closeGate) → sess-1 is "closing".
    void post(connId, {
      jsonrpc: '2.0',
      id: 300,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, {
      jsonrpc: '2.0',
      id: 301,
      method: 'session/load',
      params: { sessionId: 'sess-1' },
    });
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; message: string };
    }>;
    const loadReply = frames.find((f) => f.id === 301);
    // Transient server-side race → INTERNAL_ERROR (-32603), not INVALID_PARAMS.
    expect(loadReply?.error?.code).toBe(-32603); // "being closed; retry"
    expect(loadReply?.error?.message).toContain('being closed');
    releaseClose();
  });

  it('session/load while close races DURING loadSession → post-await reject + rollback', async () => {
    // Distinct from the pre-await guard above: here the pre-await
    // `closingSessions` check passes, then a `session/close` for the same id
    // starts WHILE `loadSession` is awaiting. The post-await re-check
    // (dispatch.ts) must detect `closeRaced`, roll back the just-restored
    // attach (detachClient, since loadAttached=true), and reply INTERNAL_ERROR.
    let releaseLoad: () => void = () => {};
    let releaseClose: () => void = () => {};
    const connId = await initialize();
    await newSession(connId); // own sess-1 so session/close passes requireOwned
    // Arm the gates only AFTER ownership is established — otherwise newSession's
    // own spawnOrAttach would block on bridge.gate and never grant ownership.
    bridge.gate = new Promise<void>((r) => (releaseLoad = r));
    bridge.closeGate = new Promise<void>((r) => (releaseClose = r));
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 2); // buffered session/new reply + load reject
    await new Promise((r) => setTimeout(r, 50));
    // Load goes in-flight (awaits bridge.gate); pre-await closingSessions empty.
    void post(connId, {
      jsonrpc: '2.0',
      id: 340,
      method: 'session/load',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    // Close starts DURING the load → marks sess-1 closing (awaits closeGate).
    void post(connId, {
      jsonrpc: '2.0',
      id: 341,
      method: 'session/close',
      params: { sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    releaseLoad(); // loadSession resolves → post-await sees closeRaced
    const frames = (await got) as Array<{
      id: number;
      error?: { code: number; message: string };
    }>;
    const loadReply = frames.find((f) => f.id === 340);
    expect(loadReply?.error?.code).toBe(-32603);
    expect(loadReply?.error?.message).toContain('closed during load');
    // attached:true → rollback is a detach, NOT a kill.
    expect(bridge.detached.some((d) => d.sessionId === 'sess-1')).toBe(true);
    expect(bridge.killed).not.toContain('sess-1');
    releaseClose();
  });

  it('double-failure permission vote → pending retained + retried on teardown', async () => {
    // Core R14 invariant: when BOTH the vote and the immediate cancel throw a
    // non-"not found" error, resolveClientResponse must RETAIN the pending
    // entry so connection teardown's abandonPendingForSession can retry the
    // cancel (otherwise the bridge mediator is stuck forever). Retention is
    // observable as a SECOND cancel attempt during teardown.
    const calls: unknown[] = [];
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      calls.push(resp);
      throw new Error('mediator unavailable'); // vote AND every cancel fail
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-d',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 100));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    const reader = frameReader(sess);
    try {
      await new Promise((r) => setTimeout(r, 50));
      await post(connId, {
        jsonrpc: '2.0',
        id: 350,
        method: 'session/prompt',
        params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
      });
      const reqFrame = (await reader.next()) as { id: string };
      // Vote → respondToSessionPermission throws → immediate cancel ALSO throws.
      await post(connId, {
        jsonrpc: '2.0',
        id: reqFrame.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      await waitUntil(
        () =>
          calls.filter((c) => JSON.stringify(c).includes('cancelled')).length >=
          1,
      );
      // Teardown retries the cancel. This only happens if the entry was
      // retained after the immediate cancel failed.
      await fetch(`${base}/acp`, {
        method: 'DELETE',
        headers: { 'acp-connection-id': connId },
      });
      await waitUntil(() => {
        const cancels = calls.filter((c) =>
          JSON.stringify(c).includes('cancelled'),
        );
        return cancels.length >= 2 && calls.length >= 3;
      });
      const cancels = calls.filter((c) =>
        JSON.stringify(c).includes('cancelled'),
      );
      // 1 vote + ≥2 cancels (immediate fail + teardown retry). If the entry
      // were dropped unconditionally after the failed immediate cancel, there
      // would be exactly ONE cancel — so ≥2 is the retention invariant.
      expect(cancels.length).toBeGreaterThanOrEqual(2);
      expect(calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      reader.close();
    }
  });

  it('client error response to a permission request → cancellation', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((
      _s: string,
      _r: string,
      resp: unknown,
    ) => {
      resolvedWith = resp;
      return true;
    }) as never;
    bridge.promptBehavior = async (_s, q) => {
      q.push({
        type: 'permission_request',
        data: {
          requestId: 'perm-e',
          sessionId: 'sess-1',
          toolCall: {},
          options: [{ optionId: 'allow' }],
        },
      });
      await new Promise((r) => setTimeout(r, 40));
      return { stopReason: 'end_turn' };
    };
    const connId = await initialize();
    await newSession(connId);
    const sess = await openStream(connId, 'sess-1');
    const got = takeFrames(sess, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 310,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: string }>;
    // Client answers with a JSON-RPC ERROR (not result) → treated as cancel.
    await post(connId, {
      jsonrpc: '2.0',
      id: reqFrame.id,
      error: { code: -32000, message: 'user declined' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolvedWith).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('DELETE without a connection id → 400', async () => {
    const res = await fetch(`${base}/acp`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('DELETE tears the connection down (subsequent POST 404)', async () => {
    const connId = await initialize();
    const del = await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    expect(del.status).toBe(202);
    const after = await post(connId, {
      jsonrpc: '2.0',
      id: 12,
      method: 'session/new',
    });
    expect(after.status).toBe(404);
  });

  // ── Wave 1+2: new _qwen/* method tests ──────────────────────────

  describe('protocol compliance', () => {
    it('POST non-JSON Content-Type → 415', async () => {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      });
      expect(res.status).toBe(415);
    });

    it('POST batch JSON-RPC array → 501', async () => {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'foo' }]),
      });
      expect(res.status).toBe(501);
    });

    it('GET without text/event-stream Accept → 406', async () => {
      const connId = await initialize();
      const res = await fetch(`${base}/acp`, {
        headers: {
          accept: 'application/json',
          'acp-connection-id': connId,
        },
      });
      expect(res.status).toBe(406);
    });

    it('POST missing Acp-Connection-Id → 400', async () => {
      const res = await fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'session/list',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('session extension methods', () => {
    it('_qwen/session/recap returns recap', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 50,
        method: '_qwen/session/recap',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { sessionId: 'sess-1', recap: 'test recap' },
      });
    });

    it('_qwen/session/btw validates question length', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 51,
        method: '_qwen/session/btw',
        params: { sessionId: 'sess-1', question: '' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/session/btw returns answer', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 52,
        method: '_qwen/session/btw',
        params: { sessionId: 'sess-1', question: 'what?' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { answer: 're: what?' },
      });
    });

    it('_qwen/session/shell returns stable disabled error by default', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 53,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: '' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'session_shell_disabled' },
        },
      });
      expect(bridge.shellCalls).toHaveLength(0);
      expect(
        stdioMocks.writeStderrLine.mock.calls.some(([line]) =>
          line.includes('/acp session/shell session='),
        ),
      ).toBe(false);
      expect(
        stdioMocks.writeStderrLine.mock.calls.some(([line]) =>
          line.includes('/acp dispatch error'),
        ),
      ).toBe(false);
    });

    it('_qwen/session/shell rejects unowned session when enabled', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 54,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
      expect(bridge.shellCalls).toHaveLength(0);
      expect(
        stdioMocks.writeStderrLine.mock.calls.some(([line]) =>
          line.includes('/acp session/shell session='),
        ),
      ).toBe(false);
    });

    it('_qwen/session/shell requires an owned bridge-stamped clientId when enabled', async () => {
      const nextBridge = new FakeBridge();
      nextBridge.spawnClientId = undefined;
      await restartServer({
        sessionShellCommandEnabled: true,
        nextBridge,
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 55,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'client_id_required' },
        },
      });
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('_qwen/session/shell rejects empty command when enabled', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 56,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: '' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ error: { code: -32602 } });
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('_qwen/session/shell returns result', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      const connId = await initialize();
      const streamRes = openStream(connId);
      const command = 'ls\nFAKE\r\x1b[31m';
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 57,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { exitCode: 0, output: `$ ${command}` },
      });
      const shellLog = stdioMocks.writeStderrLine.mock.calls
        .map(([line]) => line)
        .find((line) => line.includes('session/shell'));
      expect(shellLog).toContain('cmd=ls FAKE  [31m');
      expect(shellLog).not.toContain('\n');
      expect(shellLog).not.toContain('\r');
      expect(shellLog).not.toContain('\x1b');
      expect(bridge.shellCalls).toEqual([
        {
          sessionId: 'sess-1',
          command,
          signal: expect.any(AbortSignal),
          context: { clientId: 'client-1', fromLoopback: true },
        },
      ]);
      expect(bridge.shellCalls[0]?.signal?.aborted).toBe(false);
    });

    it('_qwen/session/shell maps bridge shell policy errors to RPC errorKind', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = new SessionShellDisabledError();
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 58,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const disabledFrames = await takeFrames(await streamRes, 2);
      expect(disabledFrames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'session_shell_disabled' },
        },
      });

      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = new SessionShellClientRequiredError();
      const connId2 = await initialize();
      const streamRes2 = openStream(connId2);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId2, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId2, {
        jsonrpc: '2.0',
        id: 59,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const clientRequiredFrames = await takeFrames(await streamRes2, 2);
      expect(clientRequiredFrames[1]).toMatchObject({
        error: {
          code: -32602,
          data: { errorKind: 'client_id_required' },
        },
      });
    });

    it('_qwen/session/shell preserves InvalidClientIdError invalid params mapping', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = new InvalidClientIdError('sess-1', 'client-2');
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 60,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/session/shell does not map arbitrary error names as shell policy errors', async () => {
      await restartServer({ sessionShellCommandEnabled: true });
      bridge.shellError = Object.assign(new Error('fake policy'), {
        name: 'SessionShellDisabledError',
      });
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 61,
        method: '_qwen/session/shell',
        params: { sessionId: 'sess-1', command: 'pwd' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        error: {
          code: -32603,
          data: { errorKind: 'internal' },
        },
      });
    });

    it('_qwen/session/detach succeeds', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 55,
        method: '_qwen/session/detach',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({ result: { ok: true } });
      expect(bridge.detached.length).toBeGreaterThan(0);
    });

    it('_qwen/session/context_usage returns usage', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 56,
        method: '_qwen/session/context_usage',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { sessionId: 'sess-1', used: 100 },
      });
    });

    it('_qwen/session/tasks returns tasks', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: {},
      });
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 57,
        method: '_qwen/session/tasks',
        params: { sessionId: 'sess-1' },
      });
      const frames = await takeFrames(await streamRes, 2);
      expect(frames[1]).toMatchObject({
        result: { sessionId: 'sess-1', tasks: [] },
      });
    });

    it('session methods reject unowned session', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 58,
        method: '_qwen/session/recap',
        params: { sessionId: 'unknown-session' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });
  });

  describe('workspace methods', () => {
    it('_qwen/workspace/tools returns tools', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 60,
        method: '_qwen/workspace/tools',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ result: { v: 1, tools: [] } });
    });

    it('_qwen/workspace/mcp/tools rejects missing serverName', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 61,
        method: '_qwen/workspace/mcp/tools',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/mcp/tools returns tools', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 62,
        method: '_qwen/workspace/mcp/tools',
        params: { serverName: 'fs' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { serverName: 'fs', tools: [] },
      });
    });

    it('_qwen/workspace/mcp/servers/add rejects missing name', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 63,
        method: '_qwen/workspace/mcp/servers/add',
        params: { config: {} },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/mcp/servers/remove rejects missing name', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 64,
        method: '_qwen/workspace/mcp/servers/remove',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/sessions/delete rejects non-array', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 65,
        method: '_qwen/sessions/delete',
        params: { sessionIds: 'not-array' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/sessions/delete rejects >100 ids', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      const ids = Array.from({ length: 101 }, (_, i) => `s${i}`);
      await post(connId, {
        jsonrpc: '2.0',
        id: 66,
        method: '_qwen/sessions/delete',
        params: { sessionIds: ids },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/sessions/delete sanitizes stderr close errors', async () => {
      const lineSep = '\u2028';
      const bidiOverride = '\u202e';
      bridge.closeError = new Error(
        `close\nFAILED\r\x1b[31m${lineSep}${bidiOverride}`,
      );
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 67,
        method: '_qwen/sessions/delete',
        params: { sessionIds: [`sess${lineSep}FAKE\r\x1b[31m`] },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { removed: [], notFound: [] },
      });
      const deleteLog = stdioMocks.writeStderrLine.mock.calls
        .map(([line]) => line)
        .find((line) => line.includes('sessions/delete'));
      expect(deleteLog).toContain(
        'closeSession(sess FAK) failed: close FAILED  [31m',
      );
      expect(deleteLog).not.toContain('\n');
      expect(deleteLog).not.toContain('\r');
      expect(deleteLog).not.toContain('\x1b');
      expect(deleteLog).not.toContain(lineSep);
      expect(deleteLog).not.toContain(bidiOverride);
    });

    it('_qwen/sessions/delete sanitizes stderr remove errors', async () => {
      const lineSep = '\u2028';
      const bidiOverride = '\u202e';
      const sessionId = `sess${lineSep}FAKE\r\x1b[31m`;
      const removeError = `remove\nFAILED\r\x1b[31m${lineSep}${bidiOverride}`;
      const removeSessionsSpy = vi
        .spyOn(SessionService.prototype, 'removeSessions')
        .mockResolvedValueOnce({
          removed: [],
          notFound: [],
          errors: [
            {
              sessionId,
              error: removeError as unknown as Error,
            },
          ],
        });

      try {
        const connId = await initialize();
        const streamRes = openStream(connId);
        await new Promise((r) => setTimeout(r, 30));
        await post(connId, {
          jsonrpc: '2.0',
          id: 68,
          method: '_qwen/sessions/delete',
          params: { sessionIds: [sessionId] },
        });
        const frames = await takeFrames(await streamRes, 1);
        expect(frames[0]).toMatchObject({
          result: {
            removed: [],
            notFound: [],
            errors: [{ sessionId, error: removeError }],
          },
        });
        expect(removeSessionsSpy).toHaveBeenCalledWith([sessionId]);

        const deleteLog = stdioMocks.writeStderrLine.mock.calls
          .map(([line]) => line)
          .find((line) => line.includes('sessions/delete'));
        expect(deleteLog).toContain(
          'removeSessions(sess FAK) failed: remove FAILED  [31m',
        );
        expect(deleteLog).not.toContain('\n');
        expect(deleteLog).not.toContain('\r');
        expect(deleteLog).not.toContain('\x1b');
        expect(deleteLog).not.toContain(lineSep);
        expect(deleteLog).not.toContain(bidiOverride);
      } finally {
        removeSessionsSpy.mockRestore();
      }
    });
  });

  describe('auth methods', () => {
    it('_qwen/workspace/auth/status returns empty when no registry', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 70,
        method: '_qwen/workspace/auth/status',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({
        result: { pendingDeviceFlows: [] },
      });
    });

    it('_qwen/workspace/auth/device_flow/start rejects without registry', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 71,
        method: '_qwen/workspace/auth/device_flow/start',
        params: { providerId: 'test' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32603 } });
    });
  });

  describe('memory methods', () => {
    it('_qwen/workspace/memory/write rejects non-string content', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 80,
        method: '_qwen/workspace/memory/write',
        params: { content: 123 },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/memory/write rejects invalid scope', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 81,
        method: '_qwen/workspace/memory/write',
        params: { content: 'hi', scope: 'invalid' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/workspace/memory/write rejects invalid mode', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 82,
        method: '_qwen/workspace/memory/write',
        params: { content: 'hi', mode: 'invalid' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });
  });

  describe('file methods', () => {
    it('_qwen/file/read rejects without fsFactory (503-equivalent)', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 90,
        method: '_qwen/file/read',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32603 } });
    });

    it('_qwen/file/read rejects missing path', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 91,
        method: '_qwen/file/read',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/write rejects missing content', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 92,
        method: '_qwen/file/write',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/edit rejects missing oldText/newText', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 93,
        method: '_qwen/file/edit',
        params: { path: 'test.txt' },
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });

    it('_qwen/file/glob rejects missing pattern', async () => {
      const connId = await initialize();
      const streamRes = openStream(connId);
      await new Promise((r) => setTimeout(r, 30));
      await post(connId, {
        jsonrpc: '2.0',
        id: 94,
        method: '_qwen/file/glob',
        params: {},
      });
      const frames = await takeFrames(await streamRes, 1);
      expect(frames[0]).toMatchObject({ error: { code: -32602 } });
    });
  });
});

// ── WebSocket transport security tests ────────────────────────────────
describe('ACP WebSocket transport security', () => {
  let server: Server;
  let port: number;
  let bridge: FakeBridge;

  function startServer(
    opts: {
      token?: string;
      checkRate?: (key: string, tier: string) => boolean;
    } = {},
  ) {
    return new Promise<void>((resolve) => {
      bridge = new FakeBridge();
      const app = express();
      app.use(express.json());
      const handle = mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
        boundWorkspace: '/ws',
        workspace: fakeWorkspace,
        enabled: true,
        token: opts.token,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        checkRate: opts.checkRate as any,
      });
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        handle?.attachServer(server);
        resolve();
      });
    });
  }

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((r) => server?.close(() => r()) ?? r());
  });

  function wsConnect(
    opts: { headers?: Record<string, string> } = {},
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
        headers: opts.headers,
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function wsConnectRaw(
    host: string,
    origin?: string,
  ): Promise<{ code: number }> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      if (origin) headers['Origin'] = origin;
      const ws = new WebSocket(`ws://${host}:${port}/acp`, {
        headers,
        handshakeTimeout: 2000,
      });
      ws.once('open', () => {
        ws.close();
        resolve({ code: 101 });
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode ?? 0 });
      });
      ws.once('error', () => resolve({ code: 0 }));
    });
  }

  function sendRpc(ws: WebSocket, msg: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify(msg));
    });
  }

  // ── Host allowlist ──────────────────────────────────────────────────
  it('accepts WS upgrade with loopback Host header', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', undefined);
    // The Host header will be 127.0.0.1:PORT which is in the allowlist
    expect(result.code).toBe(101);
  });

  // ── CSWSH origin check ─────────────────────────────────────────────
  it('rejects WS upgrade with cross-origin Origin header', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', 'https://evil.com');
    expect(result.code).toBe(403);
  });

  it('allows WS upgrade with loopback Origin header', async () => {
    await startServer();
    const result = await wsConnectRaw('127.0.0.1', 'http://localhost:3000');
    expect(result.code).toBe(101);
  });

  // ── Bearer token auth ──────────────────────────────────────────────
  it('rejects WS upgrade without token when token is configured', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await wsConnectRaw('127.0.0.1');
    expect(result.code).toBe(401);
  });

  it('rejects WS upgrade with wrong token', async () => {
    await startServer({ token: 'secret-token-123' });
    const result = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
        headers: { Authorization: 'Bearer wrong-token' },
        handshakeTimeout: 2000,
      });
      ws.once('open', () => {
        ws.close();
        resolve({ code: 101 });
      });
      ws.once('unexpected-response', (_req, res) =>
        resolve({ code: res.statusCode ?? 0 }),
      );
      ws.once('error', () => resolve({ code: 0 }));
    });
    expect(result.code).toBe(401);
  });

  it('allows WS upgrade with correct token', async () => {
    await startServer({ token: 'secret-token-123' });
    const ws = await wsConnect({
      headers: { Authorization: 'Bearer secret-token-123' },
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // ── maxPayload ─────────────────────────────────────────────────────
  it('closes WS on oversized frame (>10MB)', async () => {
    await startServer();
    const ws = await wsConnect();
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => {});
    });
    try {
      ws.send('x'.repeat(10 * 1024 * 1024 + 1));
    } catch {
      // ws may throw synchronously for oversized payloads
    }
    const code = await closed;
    expect(code).toBe(1009); // 1009 = message too big
  });

  // ── Initialize timeout ─────────────────────────────────────────────
  it('requires initialize as first message', async () => {
    await startServer();
    const ws = await wsConnect();
    const reply = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {},
    });
    expect(reply).toMatchObject({ error: { code: -32600 } });
    ws.close();
  });

  // ── Message serialization ──────────────────────────────────────────
  it('serializes concurrent WS messages (no race)', async () => {
    await startServer();
    const ws = await wsConnect();
    // Initialize first
    const initReply = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(initReply).toMatchObject({ result: { protocolVersion: 1 } });
    // Send two messages rapidly — both should succeed without race
    const replies: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        replies.push(JSON.parse(data.toString()));
        if (replies.length >= 2) resolve();
      });
    });
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {},
      }),
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/list',
        params: {},
      }),
    );
    await done;
    const ids = replies.map((r) => (r as { id: number }).id).sort();
    expect(ids).toEqual([2, 3]);
    ws.close();
  });

  // ── Rate limiter ───────────────────────────────────────────────────
  it('enforces rate limits on WS messages', async () => {
    let callCount = 0;
    await startServer({
      checkRate: () => {
        callCount++;
        return callCount <= 2;
      },
    });
    const ws = await wsConnect();
    await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    // First two post-init messages should pass
    const r1 = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/list',
      params: {},
    });
    expect(r1).toMatchObject({ id: 2 });
    const r2 = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/list',
      params: {},
    });
    expect(r2).toMatchObject({ id: 3 });
    // Third should be rate-limited
    const r3 = await sendRpc(ws, {
      jsonrpc: '2.0',
      id: 4,
      method: 'session/list',
      params: {},
    });
    expect(r3).toMatchObject({ error: { message: 'Rate limit exceeded' } });
    ws.close();
  });
});

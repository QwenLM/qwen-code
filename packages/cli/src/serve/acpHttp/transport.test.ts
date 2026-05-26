/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import { mountAcpHttp } from './index.js';

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
  killed: string[] = [];

  closedSessions: string[] = [];

  async spawnOrAttach(req: { sessionScope?: string }) {
    this.lastSpawnScope = req?.sessionScope;
    return {
      sessionId: 'sess-1',
      workspaceCwd: '/ws',
      attached: false,
      clientId: 'client-1',
    };
  }
  async killSession(sessionId: string) {
    this.killed.push(sessionId);
  }

  loadShouldThrow = false;

  async loadSession(req: { sessionId: string }) {
    if (this.loadShouldThrow) throw new Error('load failed');
    return {
      sessionId: req.sessionId,
      workspaceCwd: '/ws',
      attached: true,
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

  async sendPrompt(sessionId: string, _req: unknown, signal?: AbortSignal) {
    const q = this.queues.get(sessionId);
    if (this.promptBehavior && q) return this.promptBehavior(sessionId, q, signal);
    return { stopReason: 'end_turn' };
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
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'qwen-max', options: [] },
        ],
      },
    };
  }
  async getSessionSupportedCommandsStatus(sessionId: string) {
    return { v: 1, sessionId, availableCommands: [], availableSkills: [] };
  }
  async getWorkspaceMcpStatus() {
    return { ok: true, v: 1, workspaceCwd: '/ws' };
  }
  async getWorkspaceSkillsStatus() {
    return { ok: true };
  }
  async getWorkspaceProvidersStatus() {
    return { ok: true };
  }
  async getWorkspaceEnvStatus() {
    return { ok: true };
  }
  async getWorkspacePreflightStatus() {
    return { ok: true };
  }
  updateSessionMetadata(_s: string, metadata: unknown) {
    return metadata;
  }
  async setWorkspaceToolEnabled(toolName: string, enabled: boolean) {
    return { toolName, enabled };
  }
  async initWorkspace() {
    return { path: '/ws/QWEN.md', action: 'created' as const };
  }
  async restartMcpServer() {
    return { ok: true };
  }

  recordHeartbeat() {
    return { sessionId: 'sess-1', lastSeenAt: Date.now() };
  }

  listWorkspaceSessions() {
    return [];
  }

  detached: Array<{ sessionId: string; clientId?: string }> = [];

  async cancelSession() {}
  async closeSession(sessionId: string) {
    this.closedSessions.push(sessionId);
    if (this.closeShouldThrow) throw new Error('bridge close failed');
  }
  async detachClient(sessionId: string, clientId?: string) {
    this.detached.push({ sessionId, clientId });
  }
}

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
      const dataLine = frame
        .split('\n')
        .find((l) => l.startsWith('data: '));
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

describe('ACP Streamable HTTP transport (over the wire)', () => {
  let server: Server;
  let base: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    bridge = new FakeBridge();
    const app = express();
    app.use(express.json());
    mountAcpHttp(app, bridge as unknown as HttpAcpBridge, {
      boundWorkspace: '/ws',
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

  async function initialize(): Promise<string> {
    const res = await fetch(`${base}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    const connId = res.headers.get('acp-connection-id');
    expect(connId).toBeTruthy();
    const body = (await res.json()) as { result: { protocolVersion: number } };
    expect(body.result.protocolVersion).toBe(1);
    return connId!;
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
    await post(connId, { jsonrpc: '2.0', id, method: 'session/new', params: {} });
    await new Promise((r) => setTimeout(r, 30)); // let handle() register ownership
  }

  it('initialize → 200 + Acp-Connection-Id; unknown conn → 400', async () => {
    await initialize();
    const bad = await post('nope', { jsonrpc: '2.0', id: 2, method: 'session/new' });
    expect(bad.status).toBe(400);
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
    const [frame] = (await got) as Array<{ id: number; result: { sessionId: string } }>;
    expect(frame.id).toBe(2);
    expect(frame.result.sessionId).toBe('sess-1');
  });

  it('prompt streams session/update then the final result', async () => {
    bridge.promptBehavior = async (_s, q) => {
      q.push({ type: 'session_update', data: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk' } } });
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
    expect((frames[1] as { id: number; result: { stopReason: string } }).id).toBe(5);
    expect((frames[1] as { result: { stopReason: string } }).result.stopReason).toBe('end_turn');
  });

  it('permission request round-trips agent→client→agent', async () => {
    let resolvedWith: unknown;
    bridge.respondToSessionPermission = ((_s: string, _r: string, resp: unknown) => {
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
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: number; method: string; params: { _meta: Record<string, { requestId: string }> } }>;
    expect(reqFrame.method).toBe('session/request_permission');
    expect(reqFrame.params._meta['qwen'].requestId).toBe('perm-1');
    // Client answers with a JSON-RPC response echoing the issued id.
    await post(connId, {
      jsonrpc: '2.0',
      id: reqFrame.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolvedWith).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
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
    const [frame] = (await got) as Array<{ id: number; result: { configOptions: unknown } }>;
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
    await post(connId, { jsonrpc: '2.0', id: 12, method: '_qwen/workspace/mcp' });
    const [frame] = (await got) as Array<{ id: number; result: { ok: boolean } }>;
    expect(frame.id).toBe(12);
    expect(frame.result.ok).toBe(true);
  });

  it('unknown method → JSON-RPC method-not-found on conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, { jsonrpc: '2.0', id: 11, method: 'bogus/method' });
    const [frame] = (await got) as Array<{ id: number; error: { code: number } }>;
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
    const [frame] = (await got) as Array<{ id: number; error: { code: number } }>;
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
    const [frame] = (await got) as Array<{ id: number; error: { code: number } }>;
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
    const [frame] = (await got) as Array<{ id: number; result: { replayed: boolean } }>;
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
    const [frame] = (await got) as Array<{ id: number; result: { resumed: boolean } }>;
    expect(frame.id).toBe(21);
    expect(frame.result.resumed).toBe(true);
  });

  it('session/close reaches the bridge + replies on the conn stream', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    // 2 frames: the session/new reply (establishes ownership), then close.
    const got = takeFrames(connStream, 2);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, { jsonrpc: '2.0', id: 99, method: 'session/new', params: {} });
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
      const body = (await res.json()) as { result: { protocolVersion: number } };
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
    const [frame] = (await got) as Array<{ id: number; error: { code: number } }>;
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
    bridge.respondToSessionPermission = ((_s: string, _r: string, resp: unknown) => {
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
      post(connId, { jsonrpc: '2.0', id: 70, method: 'session/close', params: { sessionId: 'sess-1' } }),
      post(connId, { jsonrpc: '2.0', id: 71, method: 'session/close', params: { sessionId: 'sess-1' } }),
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
      q.push({ type: 'session_update', data: { sessionId: 'sess-1', update: {} } });
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
    // Client reconnects the session stream (drop s1, open s2).
    await s1.body?.cancel();
    const s2 = await openStream(connId, 'sess-1');
    await new Promise((r) => setTimeout(r, 60));
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
    await post(connId, { jsonrpc: '2.0', id: 91, method: 'session/close', params: { sessionId: 'sess-1' } });
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
    const [frame] = (await got) as Array<{ id: number; error: { code: number } }>;
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
    const [frame] = (await got) as Array<{ id: number; error: { code: number } }>;
    expect(frame.error.code).toBe(-32602);
    expect(bridge.lastApprovalMode).toBeUndefined();
  });

  it('session/new forwards sessionScope; rejects invalid scope', async () => {
    const connId = await initialize();
    const connStream = await openStream(connId);
    const got = takeFrames(connStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    // invalid scope → error on conn stream
    await post(connId, {
      jsonrpc: '2.0',
      id: 43,
      method: 'session/new',
      params: { sessionScope: 'bogus' },
    });
    const [bad] = (await got) as Array<{ error: { code: number } }>;
    expect(bad.error.code).toBe(-32602);
    // valid scope → forwarded to bridge
    const c2 = await initialize();
    await post(c2, {
      jsonrpc: '2.0',
      id: 44,
      method: 'session/new',
      params: { sessionScope: 'thread' },
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

  it('session/close runs local cleanup even if the bridge close throws', async () => {
    bridge.closeShouldThrow = true;
    const connId = await initialize();
    await newSession(connId); // creates + owns sess-1
    await new Promise((r) => setTimeout(r, 30));
    await post(connId, { jsonrpc: '2.0', id: 46, method: 'session/close', params: { sessionId: 'sess-1' } });
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

  it('DELETE without a connection id → 400', async () => {
    const res = await fetch(`${base}/acp`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('DELETE tears the connection down (subsequent POST 400)', async () => {
    const connId = await initialize();
    const del = await fetch(`${base}/acp`, {
      method: 'DELETE',
      headers: { 'acp-connection-id': connId },
    });
    expect(del.status).toBe(202);
    const after = await post(connId, { jsonrpc: '2.0', id: 12, method: 'session/new' });
    expect(after.status).toBe(400);
  });
});

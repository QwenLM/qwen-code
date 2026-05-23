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
    | ((sessionId: string, q: PushIterable) => Promise<unknown>)
    | undefined;
  lastSetModel: unknown;

  async spawnOrAttach() {
    return { sessionId: 'sess-1', workspaceCwd: '/ws', attached: false };
  }

  subscribeEvents(sessionId: string, opts?: { signal?: AbortSignal }) {
    const q = pushQueue(opts?.signal);
    this.queues.set(sessionId, q);
    return q.iterable;
  }

  async sendPrompt(sessionId: string) {
    const q = this.queues.get(sessionId);
    if (this.promptBehavior && q) return this.promptBehavior(sessionId, q);
    return { stopReason: 'end_turn' };
  }

  respondToSessionPermission() {
    return true;
  }

  async setSessionModel(_s: string, req: unknown) {
    this.lastSetModel = req;
    return { modelServiceId: 'qwen-max' };
  }

  recordHeartbeat() {
    return { sessionId: 'sess-1', lastSeenAt: Date.now() };
  }

  listWorkspaceSessions() {
    return [];
  }

  async cancelSession() {}
  async closeSession() {}
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
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
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
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'rm' }] },
    });
    const [reqFrame] = (await got) as Array<{ id: number; method: string; params: { _meta: { qwen: { requestId: string } } } }>;
    expect(reqFrame.method).toBe('session/request_permission');
    expect(reqFrame.params._meta.qwen.requestId).toBe('perm-1');
    // Client answers with a JSON-RPC response echoing the issued id.
    await post(connId, {
      jsonrpc: '2.0',
      id: reqFrame.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolvedWith).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('_qwen/session/set_model extension reaches the bridge', async () => {
    const connId = await initialize();
    const sessStream = await openStream(connId, 'sess-1');
    const got = takeFrames(sessStream, 1);
    await new Promise((r) => setTimeout(r, 50));
    await post(connId, {
      jsonrpc: '2.0',
      id: 9,
      method: '_qwen/session/set_model',
      params: { sessionId: 'sess-1', modelServiceId: 'qwen-max' },
    });
    const [frame] = (await got) as Array<{ id: number; result: unknown }>;
    expect(frame.id).toBe(9);
    expect(bridge.lastSetModel).toMatchObject({ modelServiceId: 'qwen-max' });
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

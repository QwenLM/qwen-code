import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedClientFilesBridge } from './managed-client-files-bridge.js';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp-server.js';

interface Peer {
  server: Server;
  baseUrl: string;
  registered: Array<Record<string, unknown>>;
  unregistered: Array<Record<string, unknown>>;
  responses: Array<Record<string, unknown>>;
  /** How many times the SSE downlink was opened. */
  streamOpens: number;
  /** Resolves once the browser posts its first response. */
  firstResponse: Promise<Record<string, unknown>>;
  /** Push one JSON-RPC request down the SSE downlink. */
  push(requestId: string, payload: JsonRpcRequest): void;
}

interface PeerOptions {
  /** A binding left active by an earlier load, before register runs. */
  initialGeneration?: number;
  /** The generation register creates (defaults to 1). */
  registerGeneration?: number;
  /** Answer the stream route with this status instead of opening SSE. */
  streamStatus?: number;
  /** End the SSE response cleanly right after opening it (idle timeout). */
  endStream?: boolean;
}

function startPeer(opts: PeerOptions = {}): Promise<Peer> {
  const registered: Array<Record<string, unknown>> = [];
  const unregistered: Array<Record<string, unknown>> = [];
  const responses: Array<Record<string, unknown>> = [];
  const peerState = { streamOpens: 0 };
  let resolveFirst: (value: Record<string, unknown>) => void;
  const firstResponse = new Promise<Record<string, unknown>>((resolve) => {
    resolveFirst = resolve;
  });
  let streamRes: import('node:http').ServerResponse | undefined;
  // Like the real control plane: register creates the binding, then blocks
  // on the Harness discovery that the browser drain must answer.
  let binding: { generation: number; state: string } | undefined =
    opts.initialGeneration !== undefined
      ? { generation: opts.initialGeneration, state: 'active' }
      : undefined;
  const registerGeneration = opts.registerGeneration ?? 1;
  let resolveRegister: (() => void) | undefined;
  const registerDone = new Promise<void>((resolve) => {
    resolveRegister = resolve;
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const path = req.url ?? '';
      if (path.endsWith('/client-files/register')) {
        registered.push(parsed);
        binding = { generation: registerGeneration, state: 'active' };
        if (opts.streamStatus === undefined) await registerDone;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ generation: registerGeneration, toolCount: 1 }),
        );
        return;
      }
      if (path.endsWith('/client-files/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(binding ? JSON.stringify(binding) : '');
        return;
      }
      if (path.endsWith('/client-files/unregister')) {
        unregistered.push(parsed);
        if (binding) binding.state = 'closed';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ registered: false }));
        return;
      }
      if (path.endsWith('/client-files/requests/stream')) {
        peerState.streamOpens += 1;
        if (opts.streamStatus !== undefined) {
          res.writeHead(opts.streamStatus, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ code: 'client_files_generation_conflict' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        });
        res.write(': open\n\n');
        streamRes = res;
        // End only the first downlink cleanly; a reopen stays open so the
        // reconnect can be observed and exercised.
        if (opts.endStream && peerState.streamOpens === 1) res.end();
        return;
      }
      if (path.endsWith('/client-files/responses')) {
        responses.push(parsed);
        resolveFirst(parsed);
        resolveRegister?.();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ settled: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/api/agent/web-shell/v1`,
        registered,
        unregistered,
        responses,
        get streamOpens() {
          return peerState.streamOpens;
        },
        firstResponse,
        push(requestId, payload) {
          streamRes?.write(
            `event: request\ndata: ${JSON.stringify({
              requestId,
              payloadJson: JSON.stringify(payload),
            })}\n\n`,
          );
        },
      });
    });
  });
}

describe('ManagedClientFilesBridge', () => {
  const peers: Peer[] = [];
  const bridges: ManagedClientFilesBridge[] = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.disconnect()));
    await Promise.all(
      peers.splice(0).map(
        (peer) =>
          new Promise<void>((resolve) => {
            peer.server.close(() => resolve());
            peer.server.closeAllConnections();
          }),
      ),
    );
  });

  async function peer(opts: PeerOptions = {}) {
    const created = await startPeer(opts);
    peers.push(created);
    return created;
  }

  function bridge(
    peer: Peer,
    server: {
      handle: (m: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>;
    },
  ) {
    const created = new ManagedClientFilesBridge({
      baseUrl: peer.baseUrl,
      sessionId: 'session-1',
      server,
      fetch: (url, init) => fetch(url, init),
    });
    bridges.push(created);
    return created;
  }

  it('registers, answers a downlink request, and posts the response', async () => {
    const p = await peer();
    const handled: JsonRpcRequest[] = [];
    const b = bridge(p, {
      async handle(message) {
        handled.push(message);
        return {
          jsonrpc: '2.0',
          id: message.id ?? null,
          result: { tools: [] },
        };
      },
    });
    void b.connect();
    await vi.waitFor(() => expect(p.registered.length).toBe(1));
    p.push('7', { jsonrpc: '2.0', id: '7', method: 'tools/list' });
    const response = await p.firstResponse;
    expect(response.rpcRequestId).toBe('7');
    expect(response.generation).toBe(1);
    expect(JSON.parse(response.responseJson as string)).toMatchObject({
      id: '7',
      result: { tools: [] },
    });
    expect(handled[0].method).toBe('tools/list');
    await vi.waitFor(() =>
      expect(b.getState()).toMatchObject({ phase: 'connected', generation: 1 }),
    );
  });

  it('reports a notification as offline without a response payload', async () => {
    const p = await peer();
    const b = bridge(p, {
      async handle() {
        return undefined;
      },
    });
    void b.connect();
    await vi.waitFor(() => expect(p.registered.length).toBe(1));
    p.push('n-1', { jsonrpc: '2.0', method: 'notifications/initialized' });
    const response = await p.firstResponse;
    expect(response.rpcRequestId).toBe('n-1');
    expect(response.errorCode).toBe('client_files_offline');
    expect(response.responseJson).toBeUndefined();
  });

  it('disconnect unregisters and stops the bridge', async () => {
    const p = await peer();
    const b = bridge(p, {
      async handle() {
        return undefined;
      },
    });
    void b.connect();
    await vi.waitFor(() => expect(p.registered.length).toBe(1));
    await b.disconnect();
    expect(p.unregistered.length).toBe(1);
    expect(b.getState().phase).toBe('stopped');
  });

  it('surfaces a register refusal as a failed state', async () => {
    const p = await peer();
    p.server.removeAllListeners('request');
    p.server.on('request', (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'client_files_disabled' }));
    });
    const b = bridge(p, {
      async handle() {
        return undefined;
      },
    });
    await b.connect();
    expect(b.getState()).toMatchObject({ phase: 'failed' });
  });

  it('adopts the generation register creates, not a stale active binding', async () => {
    const p = await peer({ initialGeneration: 1, registerGeneration: 2 });
    const b = bridge(p, {
      async handle(message) {
        return {
          jsonrpc: '2.0',
          id: message.id ?? null,
          result: { tools: [] },
        };
      },
    });
    void b.connect();
    await vi.waitFor(() => expect(p.registered.length).toBe(1));
    p.push('7', { jsonrpc: '2.0', id: '7', method: 'tools/list' });
    const response = await p.firstResponse;
    expect(response.generation).toBe(2);
    await vi.waitFor(() =>
      expect(b.getState()).toMatchObject({ phase: 'connected', generation: 2 }),
    );
  });

  it('reopens the downlink after a clean end while the binding is active', async () => {
    const p = await peer({ endStream: true });
    const b = bridge(p, {
      async handle(message) {
        return {
          jsonrpc: '2.0',
          id: message.id ?? null,
          result: { tools: [] },
        };
      },
    });
    void b.connect();
    await vi.waitFor(() => expect(p.streamOpens).toBeGreaterThanOrEqual(2));
    p.push('7', { jsonrpc: '2.0', id: '7', method: 'tools/list' });
    const response = await p.firstResponse;
    expect(response.rpcRequestId).toBe('7');
    await vi.waitFor(() =>
      expect(b.getState()).toMatchObject({ phase: 'connected', generation: 1 }),
    );
  });

  it('handles a fast stream refusal without an unhandled rejection', async () => {
    const p = await peer({ streamStatus: 409 });
    const b = bridge(p, {
      async handle() {
        return undefined;
      },
    });
    await b.connect();
    expect(b.getState()).toMatchObject({ phase: 'failed' });
  });
});

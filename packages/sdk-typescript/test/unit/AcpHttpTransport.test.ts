/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { AcpHttpTransport } from '../../src/daemon/AcpHttpTransport.js';
import { DaemonTransportClosedError } from '../../src/daemon/DaemonTransport.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal | null;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/**
 * Build a mock fetch that handles the initialize handshake and
 * subsequent requests. Returns calls for inspection.
 */
function initAwareFetch(opts?: {
  initResult?: unknown;
  connectionIdHeader?: string;
  capabilitiesResult?: unknown;
  subsequentReply?: (req: CapturedRequest) => Response;
}): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let initDone = false;
  let capsDone = false;

  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        } else if (
          typeof init.headers === 'object' &&
          !Array.isArray(init.headers)
        ) {
          for (const [k, v] of Object.entries(init.headers)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = {
        url,
        method,
        headers,
        body,
        signal: init?.signal ?? null,
      };
      calls.push(captured);

      // Handle ACP initialize
      if (url.endsWith('/acp') && method === 'POST' && !initDone) {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.method === 'initialize') {
          initDone = true;
          const extraHeaders: Record<string, string> = {};
          if (opts?.connectionIdHeader) {
            extraHeaders['acp-connection-id'] = opts.connectionIdHeader;
          }
          return jsonResponse(
            200,
            {
              jsonrpc: '2.0',
              id: parsed.id,
              result: opts?.initResult ?? { v: 1 },
            },
            extraHeaders,
          );
        }
      }

      // Handle GET /capabilities (called after init)
      if (url.endsWith('/capabilities') && method === 'GET' && !capsDone) {
        capsDone = true;
        if (opts?.capabilitiesResult) {
          return jsonResponse(200, opts.capabilitiesResult);
        }
        return jsonResponse(200, { v: 1, transports: ['rest'] });
      }

      // Subsequent requests
      if (opts?.subsequentReply) {
        return opts.subsequentReply(captured);
      }

      // Default: parse body as JSON-RPC and return a success
      if (body) {
        const parsed = JSON.parse(body);
        return jsonResponse(200, {
          jsonrpc: '2.0',
          id: parsed.id,
          result: { ok: true },
        });
      }

      return jsonResponse(200, { ok: true });
    },
  ) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpHttpTransport', () => {
  // ---- Static properties ------------------------------------------------

  describe('static properties', () => {
    it('type is "acp-http"', () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);
      expect(transport.type).toBe('acp-http');
      transport.dispose();
    });

    it('supportsReplay is true', () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);
      expect(transport.supportsReplay).toBe(true);
      transport.dispose();
    });

    it('connected is false before initialization', () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);
      expect(transport.connected).toBe(false);
      transport.dispose();
    });
  });

  // ---- Initialize handshake ---------------------------------------------

  describe('initialize handshake', () => {
    it('sends initialize JSON-RPC request to /acp on first fetch', async () => {
      const { fetch, calls } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      // Trigger init by calling fetch for capabilities
      await transport.fetch('http://d/capabilities', { method: 'GET' });

      // First call should be POST /acp with initialize
      const initCall = calls.find(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      expect(initCall).toBeDefined();
      const initBody = JSON.parse(initCall!.body!);
      expect(initBody.method).toBe('initialize');
      expect(initBody.jsonrpc).toBe('2.0');
      expect(initBody.params.clientInfo).toBeDefined();

      transport.dispose();
    });

    it('connected is true after initialization', async () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      await transport.fetch('http://d/capabilities', { method: 'GET' });
      expect(transport.connected).toBe(true);

      transport.dispose();
    });

    it('sets Authorization header when token provided', async () => {
      const { fetch, calls } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', 'my-token', fetch);

      await transport.fetch('http://d/capabilities', { method: 'GET' });

      const initCall = calls.find(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      expect(initCall!.headers['authorization']).toBe('Bearer my-token');

      transport.dispose();
    });
  });

  // ---- ConnectionId extraction ------------------------------------------

  describe('connectionId extraction', () => {
    it('extracts connectionId from response header', async () => {
      const { fetch, calls } = initAwareFetch({
        connectionIdHeader: 'conn-hdr-123',
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      // Trigger init
      await transport.fetch('http://d/capabilities', { method: 'GET' });

      // Make a subsequent request that should include the connection id
      await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({ model: 'test' }),
      });

      // Find the POST /acp call after init
      const postCalls = calls.filter(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      // The second POST /acp call (after init) should have the header
      const lastPost = postCalls[postCalls.length - 1];
      expect(lastPost.headers['acp-connection-id']).toBe('conn-hdr-123');

      transport.dispose();
    });

    it('extracts connectionId from JSON body fallback', async () => {
      const { fetch, calls } = initAwareFetch({
        initResult: {
          v: 1,
          _meta: { qwen: { connectionId: 'conn-body-456' } },
        },
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      await transport.fetch('http://d/capabilities', { method: 'GET' });

      // Make a subsequent request
      await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const postCalls = calls.filter(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      const lastPost = postCalls[postCalls.length - 1];
      expect(lastPost.headers['acp-connection-id']).toBe('conn-body-456');

      transport.dispose();
    });

    it('extracts connectionId from agentCapabilities path', async () => {
      const { fetch, calls } = initAwareFetch({
        initResult: {
          agentCapabilities: {
            _meta: { qwen: { connectionId: 'conn-agent-789' } },
          },
        },
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      await transport.fetch('http://d/capabilities', { method: 'GET' });

      await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const postCalls = calls.filter(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      const lastPost = postCalls[postCalls.length - 1];
      expect(lastPost.headers['acp-connection-id']).toBe('conn-agent-789');

      transport.dispose();
    });

    it('header takes precedence over body connectionId', async () => {
      const { fetch, calls } = initAwareFetch({
        connectionIdHeader: 'from-header',
        initResult: {
          _meta: { qwen: { connectionId: 'from-body' } },
        },
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      await transport.fetch('http://d/capabilities', { method: 'GET' });
      await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const postCalls = calls.filter(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      const lastPost = postCalls[postCalls.length - 1];
      expect(lastPost.headers['acp-connection-id']).toBe('from-header');

      transport.dispose();
    });
  });

  // ---- URL→JSON-RPC mapping ---------------------------------------------

  describe('URL→JSON-RPC mapping', () => {
    it('GET /capabilities returns cached init result', async () => {
      const { fetch } = initAwareFetch({
        capabilitiesResult: { v: 2, transports: ['acp-ws'] },
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/capabilities', {
        method: 'GET',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.v).toBe(2);

      transport.dispose();
    });

    it('POST /session sends session/new JSON-RPC', async () => {
      const { fetch, calls } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({ model: 'test' }),
      });

      // Find the POST /acp call that carries session/new
      const postCalls = calls.filter(
        (c) => c.url.endsWith('/acp') && c.method === 'POST',
      );
      const sessionNewCall = postCalls.find((c) => {
        if (!c.body) return false;
        const parsed = JSON.parse(c.body);
        return parsed.method === 'session/new';
      });
      expect(sessionNewCall).toBeDefined();
      const parsed = JSON.parse(sessionNewCall!.body!);
      expect(parsed.params.model).toBe('test');

      transport.dispose();
    });

    it('returns 404 for unknown routes', async () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/totally-unknown', {
        method: 'GET',
      });
      expect(res.status).toBe(404);

      transport.dispose();
    });

    it('POST /session/:id/cancel sends notification and returns 204', async () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/session/s1/cancel', {
        method: 'POST',
      });
      expect(res.status).toBe(204);

      transport.dispose();
    });
  });

  // ---- Error handling ---------------------------------------------------

  describe('error handling', () => {
    it('maps JSON-RPC error to HTTP error status', async () => {
      const { fetch } = initAwareFetch({
        subsequentReply: () =>
          jsonResponse(200, {
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32601, message: 'Method not found' },
          }),
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);

      transport.dispose();
    });

    it('preserves HTTP status from error data.httpStatus', async () => {
      const { fetch } = initAwareFetch({
        subsequentReply: () =>
          jsonResponse(200, {
            jsonrpc: '2.0',
            id: 2,
            error: {
              code: -401,
              message: 'HTTP 401: Unauthorized',
              data: { httpStatus: 401 },
            },
          }),
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);

      transport.dispose();
    });
  });

  // ---- Abort signal forwarding ------------------------------------------

  describe('abort signal forwarding', () => {
    it('forwards abort signal to underlying fetch', async () => {
      let capturedSignal: AbortSignal | null = null;
      const { fetch } = initAwareFetch({
        subsequentReply: (req) => {
          capturedSignal = req.signal ?? null;
          return jsonResponse(200, {
            jsonrpc: '2.0',
            id: 2,
            result: { ok: true },
          });
        },
      });
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      const ctrl = new AbortController();
      await transport.fetch('http://d/session', {
        method: 'POST',
        body: JSON.stringify({}),
        signal: ctrl.signal,
      });

      expect(capturedSignal).not.toBeNull();

      transport.dispose();
    });
  });

  // ---- Initialize retry -------------------------------------------------

  describe('initialize retry on failure', () => {
    it('retries initialize after failure', async () => {
      let initAttempt = 0;
      const calls: CapturedRequest[] = [];
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          const method = init?.method ?? 'GET';
          const headers: Record<string, string> = {};
          if (init?.headers) {
            if (
              typeof init.headers === 'object' &&
              !Array.isArray(init.headers) &&
              !(init.headers instanceof Headers)
            ) {
              for (const [k, v] of Object.entries(init.headers)) {
                headers[k.toLowerCase()] = v;
              }
            }
          }
          const body = typeof init?.body === 'string' ? init.body : null;
          calls.push({ url, method, headers, body });

          if (url.endsWith('/acp') && method === 'POST') {
            const parsed = body ? JSON.parse(body) : {};
            if (parsed.method === 'initialize') {
              initAttempt++;
              if (initAttempt === 1) {
                // First attempt fails
                return jsonResponse(500, { error: 'server error' });
              }
              // Second attempt succeeds
              return jsonResponse(200, {
                jsonrpc: '2.0',
                id: parsed.id,
                result: { v: 1 },
              });
            }
            return jsonResponse(200, {
              jsonrpc: '2.0',
              id: parsed.id,
              result: { ok: true },
            });
          }

          if (url.endsWith('/capabilities')) {
            return jsonResponse(200, { v: 1 });
          }

          return jsonResponse(200, {});
        },
      ) as unknown as typeof globalThis.fetch;

      const transport = new AcpHttpTransport('http://d', undefined, fetchImpl);

      // First attempt should fail
      await expect(
        transport.fetch('http://d/capabilities', { method: 'GET' }),
      ).rejects.toThrow();

      // Second attempt should succeed (initPromise was reset)
      const res = await transport.fetch('http://d/capabilities', {
        method: 'GET',
      });
      expect(res.status).toBe(200);
      expect(initAttempt).toBe(2);

      transport.dispose();
    });
  });

  // ---- dispose() --------------------------------------------------------

  describe('dispose()', () => {
    it('fetch throws after dispose', async () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);
      transport.dispose();

      await expect(
        transport.fetch('http://d/capabilities', { method: 'GET' }),
      ).rejects.toThrow(DaemonTransportClosedError);
    });

    it('is idempotent', () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);
      transport.dispose();
      expect(() => transport.dispose()).not.toThrow();
    });

    it('connected is false after dispose', async () => {
      const { fetch } = initAwareFetch();
      const transport = new AcpHttpTransport('http://d', undefined, fetch);

      // Initialize first
      await transport.fetch('http://d/capabilities', { method: 'GET' });
      expect(transport.connected).toBe(true);

      transport.dispose();
      expect(transport.connected).toBe(false);
    });
  });
});

// A streamed text/event-stream Response that emits the given raw SSE frames
// then closes, so subscribeEvents' read loop ends and the generator returns.
function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AcpHttpTransport — subscribeEvents (session-scoped /acp stream)', () => {
  // One SSE frame: optional `id:` (bus cursor) + a `data:` JSON-RPC payload.
  function frame(id: number | undefined, msg: unknown): string {
    const idLine = id !== undefined ? `id: ${id}\n` : '';
    return `${idLine}data: ${JSON.stringify(msg)}\n\n`;
  }

  function sessionStreamFetch(frames: string[]) {
    return initAwareFetch({
      connectionIdHeader: 'conn-1',
      subsequentReply: (req) =>
        req.method === 'GET' && req.headers['acp-session-id']
          ? sseResponse(frames)
          : jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true } }),
    });
  }

  async function collect(
    t: AcpHttpTransport,
    sessionId: string,
  ): Promise<Array<{ id?: number; type: string; data: unknown }>> {
    const out: Array<{ id?: number; type: string; data: unknown }> = [];
    for await (const e of t.subscribeEvents(sessionId)) {
      out.push(e as { id?: number; type: string; data: unknown });
    }
    return out;
  }

  it('opens GET /acp with Acp-Session-Id + Acp-Connection-Id (not REST /session/:id/events)', async () => {
    const { fetch, calls } = sessionStreamFetch([]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    await collect(t, 'sess-1');

    const getCall = calls.find(
      (c) => c.method === 'GET' && c.url.endsWith('/acp'),
    );
    expect(getCall).toBeDefined();
    expect(getCall?.headers['acp-session-id']).toBe('sess-1');
    expect(getCall?.headers['acp-connection-id']).toBe('conn-1');
    // Must NOT use the REST session-events endpoint.
    expect(calls.some((c) => c.url.includes('/session/'))).toBe(false);
  });

  it('yields a session/update notification as a DaemonEvent stamped with the bus id from the `id:` line', async () => {
    const { fetch } = sessionStreamFetch([
      frame(42, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', text: 'hi' },
        },
      }),
    ]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    const events = await collect(t, 'sess-1');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_message_chunk');
    expect(events[0].id).toBe(42); // real bus cursor, not the synthetic id
  });

  it('RESOLVES the matching pending request from a JSON-RPC response frame WITHOUT yielding it as an event — the W2 no-hang dispatch', async () => {
    // A response frame (id, no method) must dispatch to pending-RESOLUTION (the
    // core W2 fix — a `session/prompt` reply routed onto the session stream by
    // the daemon's `replySession` settles its promise instead of hanging), not
    // merely be swallowed. The following notification proves the stream keeps
    // flowing past it.
    const { fetch } = sessionStreamFetch([
      frame(undefined, {
        jsonrpc: '2.0',
        id: 999,
        result: { stopReason: 'end_turn' },
      }),
      frame(7, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_thought_chunk', text: 't' },
        },
      }),
    ]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);

    // Register a pending request with the response's id so we can assert the
    // frame RESOLVES it (and clears the entry), not just that it isn't yielded.
    const pending = (
      t as unknown as {
        pending: Map<
          number,
          { resolve: (r: unknown) => void; reject: (e: Error) => void }
        >;
      }
    ).pending;
    let resolved: unknown;
    pending.set(999, {
      resolve: (r) => {
        resolved = r;
      },
      reject: () => {},
    });

    const events = await collect(t, 'sess-1');

    expect(resolved).toMatchObject({
      id: 999,
      result: { stopReason: 'end_turn' },
    });
    expect(pending.has(999)).toBe(false); // deleted on resolve
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent_thought_chunk');
  });

  it('resets the bus cursor when a later id: line in the same frame is invalid, rather than keeping the stale earlier one (MselW)', async () => {
    // A proxy-mangled trailing `id:` must not let a wrong cursor ride the event.
    const raw =
      `id: 5\n` +
      `id: notanumber\n` +
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', text: 'x' },
        },
      })}\n\n`;
    const { fetch } = sessionStreamFetch([raw]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    const events = await collect(t, 'sess-1');

    expect(events).toHaveLength(1);
    // The valid `5` was overridden+reset by the invalid second `id:` line.
    expect(events[0].id).toBeUndefined();
  });

  it('yields a _qwen/notify envelope tagged with `kind` (as the daemon sends it) as a DaemonEvent, not silently dropped (M2bvl)', async () => {
    // The daemon's translateEvent stamps session-stream notifies under `kind`
    // (state_resync_required / replay_complete / stream_error). Reading only
    // `type` would drop them — starving the SDK of the resume signals.
    const { fetch } = sessionStreamFetch([
      frame(11, {
        jsonrpc: '2.0',
        method: '_qwen/notify',
        params: {
          kind: 'state_resync_required',
          data: { reason: 'ring_evicted' },
        },
      }),
    ]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    const events = await collect(t, 'sess-1');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('state_resync_required');
    expect(events[0].id).toBe(11);
  });

  it('rejects in-flight session-scoped pendings when the subscription stream closes (M2iHz) — a session/prompt caller does not hang', async () => {
    const { fetch } = sessionStreamFetch([]); // stream closes with no frames
    const t = new AcpHttpTransport('http://d', undefined, fetch);

    const pending = (
      t as unknown as {
        pending: Map<
          number,
          {
            resolve: (r: unknown) => void;
            reject: (e: Error) => void;
            sessionId?: string;
          }
        >;
      }
    ).pending;
    const sessionReject = vi.fn();
    const connReject = vi.fn();
    pending.set(42, {
      resolve: () => {},
      reject: sessionReject,
      sessionId: 'sess-1',
    });
    // A connection-scoped pending must survive — different scope, different route.
    pending.set(43, {
      resolve: () => {},
      reject: connReject,
      sessionId: undefined,
    });

    // Drain the (empty) session stream to its close; the inner finally sweeps.
    await collect(t, 'sess-1');

    expect(sessionReject).toHaveBeenCalledTimes(1);
    expect(pending.has(42)).toBe(false);
    expect(connReject).not.toHaveBeenCalled();
    expect(pending.has(43)).toBe(true);
    t.dispose();
  });

  it('aborts an existing background reply pump when a consumer subscription starts, without rejecting its in-flight pending (M3BYa)', async () => {
    // The session stream is single-reader: a consumer GET makes the daemon
    // detach an earlier no-iter reply pump. Aborting that pump up front means
    // its teardown sweep is skipped, so it can't spuriously reject the prompt
    // the consumer is taking over delivery of.
    const { fetch } = sessionStreamFetch([]); // consumer stream opens then closes
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    const internals = t as unknown as {
      sessionReplyPumps: Map<string, { abort: AbortController; refs: number }>;
      pending: Map<
        number,
        {
          resolve: (r: unknown) => void;
          reject: (e: Error) => void;
          sessionId?: string;
        }
      >;
    };
    // Simulate a reply pump started earlier by a no-iter session/prompt, plus its
    // in-flight session-scoped pending.
    const pumpAbort = new AbortController();
    internals.sessionReplyPumps.set('sess-1', { abort: pumpAbort, refs: 1 });
    const reject = vi.fn();
    internals.pending.set(7, {
      resolve: () => {},
      reject,
      sessionId: 'sess-1',
    });

    // A consumer subscribes to the same session (and drains the empty stream).
    await collect(t, 'sess-1');

    expect(pumpAbort.signal.aborted).toBe(true); // pump torn down up front
    expect(reject).not.toHaveBeenCalled(); // its pending NOT spuriously rejected
    expect(internals.pending.has(7)).toBe(true);
    t.dispose();
  });

  it('surfaces a session/request_permission request as a permission_request event', async () => {
    const { fetch } = sessionStreamFetch([
      frame(9, {
        jsonrpc: '2.0',
        id: 5,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { name: 'write_file' },
          options: [{ optionId: 'allow' }],
          _meta: { qwen: { requestId: 'req-1' } },
        },
      }),
    ]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    const events = await collect(t, 'sess-1');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_request');
    expect((events[0].data as { requestId: string }).requestId).toBe('req-1');
    expect(events[0].id).toBe(9);
  });

  it('writes the Last-Event-ID header on the outbound GET when resuming', async () => {
    // The entire resume value proposition depends on this cursor reaching the
    // wire; without this assertion a regression would silently degrade to
    // live-only with no test failing.
    const { fetch, calls } = sessionStreamFetch([]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    for await (const _e of t.subscribeEvents('sess-1', { lastEventId: 42 })) {
      // drain (empty stream)
    }

    const getCall = calls.find(
      (c) => c.method === 'GET' && c.url.endsWith('/acp'),
    );
    expect(getCall).toBeDefined();
    expect(getCall?.headers['last-event-id']).toBe('42');
  });

  it('omits the Last-Event-ID header on a first (non-resume) connect', async () => {
    const { fetch, calls } = sessionStreamFetch([]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    await collect(t, 'sess-1');

    const getCall = calls.find(
      (c) => c.method === 'GET' && c.url.endsWith('/acp'),
    );
    expect(getCall?.headers['last-event-id']).toBeUndefined();
  });

  it('does not raise an unhandled rejection when the signal is already aborted at entry', async () => {
    // The mock fetch ignores the signal, so the read loop is reached with
    // `signal.aborted === true`: the loop never enters and `Promise.race`
    // never consumes the abort rejection. The no-op `.catch` on abortPromise
    // keeps that from surfacing as an unhandled rejection (which vitest would
    // fail the run on).
    const { fetch } = sessionStreamFetch([
      frame(1, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', text: 'x' },
        },
      }),
    ]);
    const t = new AcpHttpTransport('http://d', undefined, fetch);
    const ctrl = new AbortController();
    ctrl.abort();

    const out: unknown[] = [];
    for await (const e of t.subscribeEvents('sess-1', {
      signal: ctrl.signal,
    })) {
      out.push(e);
    }
    expect(out).toEqual([]); // aborted at entry → no frames consumed
    // Give any stray rejection a tick to surface before the test ends.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('AcpHttpTransport — session-reply pump (no-subscriber session RPC)', () => {
  it('resolves a session/prompt whose reply rides the session stream WITHOUT the caller iterating subscribeEvents', async () => {
    // wenshao MsOpi: the daemon answers POST /session/:id/prompt with 202 and
    // routes the final JSON-RPC result onto the SESSION stream. A DaemonClient
    // that never opens subscribeEvents would hang. The transport now opens a
    // background reply pump for session-reply methods, so fetch() resolves.
    let promptId: number | undefined;
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method ?? 'GET';
        const headers: Record<string, string> = {};
        if (init?.headers && typeof init.headers === 'object') {
          for (const [k, v] of Object.entries(
            init.headers as Record<string, string>,
          )) {
            headers[k.toLowerCase()] = v;
          }
        }
        const body = typeof init?.body === 'string' ? init.body : null;

        if (url.endsWith('/acp') && method === 'POST') {
          const parsed = body ? JSON.parse(body) : {};
          if (parsed.method === 'initialize') {
            return jsonResponse(
              200,
              { jsonrpc: '2.0', id: parsed.id, result: { v: 1 } },
              { 'acp-connection-id': 'conn-1' },
            );
          }
          if (parsed.method === 'session/prompt') {
            promptId = parsed.id as number;
            return new Response(null, { status: 202 });
          }
          return jsonResponse(200, {
            jsonrpc: '2.0',
            id: parsed.id,
            result: { ok: true },
          });
        }

        // Background session-reply pump: GET /acp + Acp-Session-Id → serve the
        // prompt's JSON-RPC result (id captured from the POST above).
        if (
          url.endsWith('/acp') &&
          method === 'GET' &&
          headers['acp-session-id']
        ) {
          return sseResponse([
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: promptId,
              result: { stopReason: 'end_turn' },
            })}\n\n`,
          ]);
        }
        // Connection-scoped stream (no Acp-Session-Id) → nothing to deliver.
        if (url.endsWith('/acp') && method === 'GET') {
          return sseResponse([]);
        }
        return jsonResponse(200, {});
      },
    ) as unknown as typeof globalThis.fetch;

    const t = new AcpHttpTransport('http://d', undefined, fetchImpl);
    const res = await t.fetch('http://d/session/sess-1/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt: [{ type: 'text', text: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopReason: 'end_turn' });
    t.dispose();
  });

  it('a connection-stream failure rejects only CONNECTION-scoped pendings, never a session-scoped reply the session stream will deliver (MselM)', async () => {
    // The two stream pumps share one `pending` map. A connection-stream error
    // must sweep only its own scope — rejecting a session-scoped `session/prompt`
    // here would spuriously fail a request the session stream is about to
    // resolve (the non-deterministic cross-stream race MselM reports).
    const fetchImpl = vi.fn(async () => {
      // Any GET /acp (the conn stream pump) fails → triggers the catch sweep.
      throw new Error('conn stream boom');
    }) as unknown as typeof globalThis.fetch;
    const t = new AcpHttpTransport('http://d', undefined, fetchImpl);

    const pending = (
      t as unknown as {
        pending: Map<
          number,
          {
            resolve: (r: unknown) => void;
            reject: (e: Error) => void;
            sessionId?: string;
          }
        >;
      }
    ).pending;
    const sessionReject = vi.fn();
    const connReject = vi.fn();
    pending.set(1, {
      resolve: () => {},
      reject: sessionReject,
      sessionId: 'sess-1',
    });
    pending.set(2, {
      resolve: () => {},
      reject: connReject,
      sessionId: undefined,
    });

    // Open the connection stream; its pump rejects → the catch runs the sweep.
    (t as unknown as { openConnStream: () => void }).openConnStream();
    // Let the rejected pump's microtasks settle.
    await new Promise((r) => setTimeout(r, 0));

    // Connection-scoped pending swept; session-scoped one preserved.
    expect(connReject).toHaveBeenCalledTimes(1);
    expect(pending.has(2)).toBe(false);
    expect(sessionReject).not.toHaveBeenCalled();
    expect(pending.has(1)).toBe(true);
    t.dispose();
  });
});

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

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error-surface tests for non-JSON-RPC HTTP 200 responses (e.g. a gateway
 * auth rejection served as `200 + application/json + {"code":401,...}`).
 *
 * The SDK parses such bodies with JSONRPCMessageSchema and rejects with an
 * opaque Zod `invalid_union` dump that carries no `input`. The compatibility
 * fetch captures the rejected body at the transport boundary so the surfaced
 * error can name the actual response. These tests drive the REAL SDK client
 * and transport against a local HTTP server — no SDK mocks — so the Zod
 * failure path is exercised exactly as it is in production.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../config/config.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  _resetNonJsonRpcCapturesForTest,
  connectToMcpServer,
  createStreamableHttpCompatibilityFetch,
  improveMcpNonJsonRpcError,
  removeMCPServerStatus,
} from './mcp-client.js';

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));
vi.mock('../mcp/oauth-token-storage.js', () => ({
  MCPOAuthTokenStorage: vi.fn().mockImplementation(() => ({
    getCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

const AUTH_200_BODY = JSON.stringify({
  code: 401,
  msg: 'token expired or incorrect',
  success: false,
});

type ServerMode = 'auth200' | 'jsonrpc-ok' | 'jsonrpc-error' | 'oauth401';

describe('non-JSON-RPC 200 response error surface', () => {
  let mode: ServerMode = 'auth200';
  let server: http.Server;
  let url: string;
  const serverName = 'zai-gateway-mock';

  beforeEach(async () => {
    _resetNonJsonRpcCapturesForTest();
    mode = 'auth200';
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'HEAD') {
          // OAuth probe (probeMcpServerForOAuth) — anything but 401.
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (mode === 'auth200') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(AUTH_200_BODY);
          return;
        }
        if (mode === 'oauth401') {
          res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer realm="mock"',
          });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        let msg: { id?: number | string; method?: string };
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (msg.method && msg.id === undefined) {
          // notifications (e.g. notifications/initialized)
          res.writeHead(202);
          res.end();
          return;
        }
        if (mode === 'jsonrpc-error') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: 'Method not found' },
            }),
          );
          return;
        }
        // jsonrpc-ok: a spec-legal initialize result.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'mock-server', version: '0.0.1' },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    _resetNonJsonRpcCapturesForTest();
    removeMCPServerStatus(serverName);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function config(): MCPServerConfig {
    return { httpUrl: url };
  }

  function transport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(url), {
      fetch: createStreamableHttpCompatibilityFetch(
        serverName,
        fetch,
        config(),
      ),
    });
  }

  it("surfaces the gateway's body instead of the Zod issue array", async () => {
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // The raw SDK failure is the opaque Zod dump (issues, no input).
    expect(Array.isArray((caught as { issues?: unknown }).issues)).toBe(true);

    const surfaced = improveMcpNonJsonRpcError(serverName, caught, config());
    expect(surfaced).toBeInstanceOf(Error);
    const message = (surfaced as Error).message;
    expect(message).toContain('non-JSON-RPC response');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('application/json');
    expect(message).toContain('token expired or incorrect');
    expect(message).not.toContain('invalid_union');
    expect((surfaced as Error).cause).toBe(caught);
  });

  it('connectToMcpServer reports the captured body in its connection error', async () => {
    const workspaceContext = {
      getDirectories: () => [],
      onDirectoriesChanged: () => () => {},
    } as unknown as WorkspaceContext;
    await expect(
      connectToMcpServer(serverName, config(), false, workspaceContext),
    ).rejects.toThrow(/token expired or incorrect/);
  });

  it('leaves successful connections and unrelated errors untouched', async () => {
    mode = 'jsonrpc-ok';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    await client.connect(transport(), { timeout: 10_000 });
    await client.close();

    const unrelated = new Error('some other failure');
    expect(improveMcpNonJsonRpcError(serverName, unrelated, config())).toBe(
      unrelated,
    );
  });

  it('does not capture a valid JSON-RPC error response', async () => {
    mode = 'jsonrpc-error';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // A JSON-RPC error body has `jsonrpc` — it must not be captured or
    // rewritten; the SDK's own error naming stands.
    expect(improveMcpNonJsonRpcError(serverName, caught, config())).toBe(
      caught,
    );
  });

  it('clears a stale capture at the start of the next POST', async () => {
    const compat = createStreamableHttpCompatibilityFetch(
      serverName,
      fetch,
      config(),
    );
    const postInit: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    };
    // First POST: gateway rejection -> capture set.
    await compat(url, postInit);
    const zodLike = Object.assign(new Error('parse failed'), {
      issues: [{ code: 'invalid_union' }],
    });
    expect(improveMcpNonJsonRpcError(serverName, zodLike, config())).not.toBe(
      zodLike,
    );
    // Second POST: valid JSON-RPC -> capture cleared, no misattribution.
    mode = 'jsonrpc-ok';
    await compat(url, postInit);
    expect(improveMcpNonJsonRpcError(serverName, zodLike, config())).toBe(
      zodLike,
    );
  });

  it('keeps the OAuth 401 path unchanged and uncaptured', async () => {
    mode = 'oauth401';
    const compat = createStreamableHttpCompatibilityFetch(
      serverName,
      fetch,
      config(),
    );
    const response = await compat(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(response.status).toBe(401);
    const zodLike = Object.assign(new Error('parse failed'), {
      issues: [{ code: 'invalid_union' }],
    });
    expect(improveMcpNonJsonRpcError(serverName, zodLike, config())).toBe(
      zodLike,
    );
  });

  it('finds the Zod failure through a wrapped cause chain', async () => {
    const compat = createStreamableHttpCompatibilityFetch(
      serverName,
      fetch,
      config(),
    );
    await compat(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const zodLike = Object.assign(new Error('parse failed'), {
      issues: [{ code: 'invalid_union' }],
    });
    const wrapped = new Error('outer', {
      cause: new Error('middle', { cause: zodLike }),
    });
    const surfaced = improveMcpNonJsonRpcError(serverName, wrapped, config());
    expect(surfaced).toBeInstanceOf(Error);
    expect((surfaced as Error).message).toContain('token expired or incorrect');
    expect((surfaced as Error).cause).toBe(wrapped);
  });
});

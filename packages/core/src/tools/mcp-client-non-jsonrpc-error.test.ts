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
 * fetch inspects the rejected body at the transport boundary so the surfaced
 * error can include a safe machine code without exposing the body. These tests drive the REAL SDK client
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
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  _resetNonJsonRpcCapturesForTest,
  connectToMcpServer,
  createStreamableHttpCompatibilityFetch,
  getMCPServerLastError,
  improveMcpNonJsonRpcError,
  McpClient,
  removeMCPServerStatus,
} from './mcp-client.js';

const { debugErrorMock } = vi.hoisted(() => ({ debugErrorMock: vi.fn() }));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: debugErrorMock,
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

// A gateway reporting an upstream connection failure as 200 + application/json.
// The body mentions ECONNREFUSED, but the failure is server-side, not a
// client-side network error — the captured body must survive classification.
const UPSTREAM_200_BODY = JSON.stringify({
  code: 502,
  msg: 'upstream connect ECONNREFUSED 10.1.2.3:8080',
});

const TEST_MARKER = 'TEST-MARKER';
const SECRET_200_BODY = JSON.stringify({
  code: 401,
  msg: 'auth failed',
  diagnostic: `Authorization: Bearer ${TEST_MARKER}`,
});
const SECRET_CODE_200_BODY = JSON.stringify({
  code: TEST_MARKER,
  msg: 'auth failed',
});

type ServerMode =
  | 'auth200'
  | 'secret200'
  | 'secretCode200'
  | 'econnrefused200'
  | 'bigBody513'
  | 'bigBody4k'
  | 'bigBody12k'
  | 'arrayBody'
  | 'scalarBody'
  | 'status201'
  | 'status202'
  | 'status206'
  | 'jsonrpc-ok'
  | 'jsonrpc-error'
  | 'oauth401';

describe('non-JSON-RPC 200 response error surface', () => {
  let mode: ServerMode = 'auth200';
  let server: http.Server;
  let url: string;
  const serverName = 'zai-gateway-mock';

  beforeEach(async () => {
    _resetNonJsonRpcCapturesForTest();
    debugErrorMock.mockClear();
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
        if (mode === 'secret200') {
          res.writeHead(200, {
            'content-type': `application/json; diagnostic="${TEST_MARKER}"`,
          });
          res.end(SECRET_200_BODY);
          return;
        }
        if (mode === 'secretCode200') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(SECRET_CODE_200_BODY);
          return;
        }
        if (mode === 'econnrefused200') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(UPSTREAM_200_BODY);
          return;
        }
        if (
          mode === 'bigBody513' ||
          mode === 'bigBody4k' ||
          mode === 'bigBody12k'
        ) {
          // F2: a gateway body with a trace id and a nested error wrapper. The
          // padding is inert filler, never a credential, and the assertion is on
          // which message the user sees, never on this text.
          const padding =
            mode === 'bigBody513' ? 600 : mode === 'bigBody4k' ? 4_000 : 12_000;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 502,
              msg: 'token expired or incorrect',
              success: false,
              trace: 'x'.repeat(padding),
            }),
          );
          return;
        }
        if (mode === 'arrayBody') {
          // F3: an error envelope wrapped in an array, with no jsonrpc key anywhere.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify([
              { code: 401, msg: 'token expired or incorrect' },
              { code: 401, msg: 'token expired or incorrect' },
            ]),
          );
          return;
        }
        if (mode === 'scalarBody') {
          // F4: a JSON scalar body.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify('token expired or incorrect'));
          return;
        }
        if (
          mode === 'status201' ||
          mode === 'status202' ||
          mode === 'status206'
        ) {
          // F5: the capture gate is 2xx, not exactly 200.
          const status =
            mode === 'status201' ? 201 : mode === 'status202' ? 202 : 206;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ code: 503, msg: 'unavailable', success: false }),
          );
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

  it('surfaces safe gateway metadata instead of the Zod issue array or raw body', async () => {
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
    expect(message).toContain('code=401');
    expect(message).not.toContain('token expired or incorrect');
    expect(message).not.toContain('invalid_union');
    expect((surfaced as Error).cause).toBe(caught);
  });

  it('connectToMcpServer reports the captured response code in its connection error', async () => {
    const workspaceContext = {
      getDirectories: () => [],
      onDirectoriesChanged: () => () => {},
    } as unknown as WorkspaceContext;
    await expect(
      connectToMcpServer(serverName, config(), false, workspaceContext),
    ).rejects.toThrow(/code=401/);
  });

  it('never exposes upstream secrets in errors, status, or debug logs', async () => {
    mode = 'secret200';
    const workspaceContext = {
      getDirectories: () => [],
      onDirectoriesChanged: () => () => {},
    } as unknown as WorkspaceContext;
    const client = new McpClient(
      serverName,
      config(),
      {} as ToolRegistry,
      {} as PromptRegistry,
      workspaceContext,
      false,
    );
    let caught: unknown;
    try {
      await client.connect();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('code=401');
    expect((caught as Error).message).not.toContain(TEST_MARKER);

    const lastError = getMCPServerLastError(serverName);
    expect(lastError).toContain('code=401');
    expect(lastError).not.toContain(TEST_MARKER);

    expect(debugErrorMock).toHaveBeenCalled();
    const debugOutput = debugErrorMock.mock.calls.flat().join('\n');
    expect(debugOutput).toContain('code=401');
    expect(debugOutput).not.toContain(TEST_MARKER);
  });

  it('rejects a nonnumeric code as untrusted text rather than a machine code', async () => {
    mode = 'secretCode200';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    const surfaced = improveMcpNonJsonRpcError(serverName, caught, config());
    const message = (surfaced as Error).message;
    expect(message).toContain('HTTP 200');
    expect(message).not.toContain('code=');
    expect(message).not.toContain(TEST_MARKER);
  });

  it('keeps safe gateway metadata when the body mentions ECONNREFUSED', async () => {
    // Witness for the network-classification bug: the gateway answered HTTP 200
    // with a body naming an upstream ECONNREFUSED. The safe metadata keeps
    // code=502 but drops that server-controlled text, and classification must
    // read the ORIGINAL error instead of any improved diagnostic.
    mode = 'econnrefused200';
    const workspaceContext = {
      getDirectories: () => [],
      onDirectoriesChanged: () => () => {},
    } as unknown as WorkspaceContext;
    let caught: unknown;
    try {
      await connectToMcpServer(serverName, config(), false, workspaceContext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('code=502');
    expect(message).not.toContain(
      'upstream connect ECONNREFUSED 10.1.2.3:8080',
    );
    expect(message).not.toContain('server may be down');
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
    expect((surfaced as Error).message).toContain('code=401');
    expect((surfaced as Error).cause).toBe(wrapped);
  });

  it('F2: a 513-byte body still surfaces safe metadata, never the dump', async () => {
    mode = 'bigBody513';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    const message = (
      improveMcpNonJsonRpcError(serverName, caught, config()) as Error
    ).message;
    expect(message).toContain('non-JSON-RPC response');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('application/json');
    expect(message).toContain('code=502');
    expect(message).not.toContain('invalid_union');
    expect(message).not.toContain('token expired or incorrect');
  });

  it('F2: a 4 KiB nested error body keeps its safe response code', async () => {
    mode = 'bigBody4k';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    const message = (
      improveMcpNonJsonRpcError(serverName, caught, config()) as Error
    ).message;
    expect(message).toContain('HTTP 200');
    expect(message).toContain('code=502');
    expect(message).not.toContain('invalid_union');
  });

  it('F2: a body past the classification bound is labelled truncated, not dropped', async () => {
    mode = 'bigBody12k';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    const message = (
      improveMcpNonJsonRpcError(serverName, caught, config()) as Error
    ).message;
    expect(message).toContain('non-JSON-RPC response');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('body truncated');
    expect(message).not.toContain('invalid_union');
    expect(message).not.toContain('x'.repeat(600));
  });

  it('F3: an array body with no jsonrpc key is captured with its item count', async () => {
    mode = 'arrayBody';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    const message = (
      improveMcpNonJsonRpcError(serverName, caught, config()) as Error
    ).message;
    expect(message).toContain('non-JSON-RPC response');
    expect(message).toContain('items=2');
    expect(message).not.toContain('invalid_union');
    expect(message).not.toContain('token expired or incorrect');
  });

  it('F4: a scalar body is captured with status and media type', async () => {
    mode = 'scalarBody';
    const client = new Client({ name: 'error-surface-test', version: '0.0.1' });
    let caught: unknown;
    try {
      await client.connect(transport(), { timeout: 10_000 });
    } catch (error) {
      caught = error;
    }
    const message = (
      improveMcpNonJsonRpcError(serverName, caught, config()) as Error
    ).message;
    expect(message).toContain('non-JSON-RPC response');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('application/json');
    expect(message).not.toContain('invalid_union');
    expect(message).not.toContain('token expired or incorrect');
  });

  for (const [label, status] of [
    ['201', 201],
    ['206', 206],
    // 202 is deliberately absent: the SDK's transport never completes an
    // initialize handshake on 202 (it waits for a body that 202 does not carry),
    // so there is no parse failure for the capture to improve. The gate is 2xx,
    // proven here by two non-200 statuses.
  ] as const) {
    it(`F5: a ${label} response with a JSON error body is captured too`, async () => {
      mode = `status${label}`;
      const client = new Client({
        name: 'error-surface-test',
        version: '0.0.1',
      });
      let caught: unknown;
      try {
        await client.connect(transport(), { timeout: 10_000 });
      } catch (error) {
        caught = error;
      }
      const message = (
        improveMcpNonJsonRpcError(serverName, caught, config()) as Error
      ).message;
      expect(message).toContain(`HTTP ${status}`);
      expect(message).toContain('code=503');
      expect(message).not.toContain('invalid_union');
    });
  }

  it('F1: the recorded lastError for an improved failure contains no invalid_union', async () => {
    const workspaceContext = {
      getDirectories: () => [],
      onDirectoriesChanged: () => () => {},
    } as unknown as WorkspaceContext;
    const client = new McpClient(
      serverName,
      config(),
      {} as ToolRegistry,
      {} as PromptRegistry,
      workspaceContext,
      false,
    );
    try {
      await client.connect();
    } catch {
      // expected: the gateway rejection, improved by this PR
    }
    const lastError = getMCPServerLastError(serverName);
    expect(lastError).toBeDefined();
    expect(lastError).toContain('non-JSON-RPC response');
    expect(lastError).not.toContain('invalid_union');
  });
});

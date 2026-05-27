/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the qwen-serve-bridge MCP server.
 *
 * Tests cover: server creation, tool registration, handler routing,
 * session state management, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { createServeBridgeMcpServer } from '../../src/daemon-mcp/serve-bridge/createServeBridgeMcpServer.js';
import {
  resolveSessionId,
  handler,
  daemonFetch,
  authHeaders,
} from '../../src/daemon-mcp/serve-bridge/types.js';
import type {
  BridgeState,
  SessionEventStream,
} from '../../src/daemon-mcp/serve-bridge/types.js';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

// --- Helpers ---

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
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
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = { url, method, headers, body };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function makeMockState(opts?: {
  token?: string;
  defaultSessionId?: string;
  fetchReply?: (req: CapturedRequest) => Response | Promise<Response>;
}): { state: BridgeState; calls: CapturedRequest[] } {
  const token = opts?.token ?? 'test-token';
  const reply = opts?.fetchReply ?? (() => jsonResponse(200, { status: 'ok' }));
  const { fetch, calls } = recordingFetch(reply);

  const state: BridgeState = {
    client: new DaemonClient({
      baseUrl: 'http://127.0.0.1:4170',
      token,
      fetch,
    }),
    daemonUrl: 'http://127.0.0.1:4170',
    token,
    defaultSessionId: opts?.defaultSessionId,
    workspaceCwd: '/tmp/test-workspace',
    eventStreams: new Map(),
    allowGlobalScope: false,
  };

  return { state, calls };
}

// --- Tests ---

describe('serve-bridge', () => {
  describe('createServeBridgeMcpServer', () => {
    it('should create a server with name qwen-serve-bridge', () => {
      recordingFetch(() => jsonResponse(200, {}));
      const server = createServeBridgeMcpServer({
        daemonUrl: 'http://127.0.0.1:4170',
        token: 'test',
      });

      expect(server).toBeDefined();
      expect(server.name).toBe('qwen-serve-bridge');
      expect(server.instance).toBeDefined();
    });

    it('should strip trailing slashes from daemonUrl', () => {
      const server = createServeBridgeMcpServer({
        daemonUrl: 'http://127.0.0.1:4170///',
        token: 'test',
      });
      expect(server).toBeDefined();
    });
  });

  describe('resolveSessionId', () => {
    it('should return explicit session_id when provided', () => {
      const { state } = makeMockState({ defaultSessionId: 'default-123' });
      expect(resolveSessionId(state, 'explicit-456')).toBe('explicit-456');
    });

    it('should return defaultSessionId when no explicit id', () => {
      const { state } = makeMockState({ defaultSessionId: 'default-123' });
      expect(resolveSessionId(state)).toBe('default-123');
    });

    it('should throw when no session available', () => {
      const { state } = makeMockState({ defaultSessionId: undefined });
      expect(() => resolveSessionId(state)).toThrow(
        'No session active. Call session_create first',
      );
    });
  });

  describe('authHeaders', () => {
    it('should return Authorization header when token exists', () => {
      const { state } = makeMockState({ token: 'my-token' });
      const headers = authHeaders(state);
      expect(headers['Authorization']).toBe('Bearer my-token');
    });

    it('should return empty object when no token', () => {
      const { state } = makeMockState({ token: undefined });
      state.token = undefined;
      const headers = authHeaders(state);
      expect(headers).toEqual({});
    });
  });

  describe('handler', () => {
    it('should pass args through and return result', async () => {
      const fn = vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const wrapped = handler(fn);
      const result = await wrapped({ foo: 'bar' }, {});
      expect(fn).toHaveBeenCalledWith({ foo: 'bar' });
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('should catch errors and return isError response', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('something broke'));
      const wrapped = handler(fn);
      const result = await wrapped({}, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'something broke' }],
        isError: true,
      });
    });

    it('should handle non-Error throws', async () => {
      const fn = vi.fn().mockRejectedValue('string error');
      const wrapped = handler(fn);
      const result = await wrapped({}, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: 'string error' }],
        isError: true,
      });
    });
  });

  describe('daemonFetch', () => {
    it('should call the correct URL with auth headers', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const { state } = makeMockState({ token: 'abc' });
        const result = await daemonFetch(state, '/health');
        expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:4170/health', {
          headers: { Authorization: 'Bearer abc' },
        });
        expect(result).toEqual({ ok: true });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should append query parameters', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const { state } = makeMockState({ token: 'abc' });
        await daemonFetch(state, '/stat', { path: 'test.txt' });
        const calledUrl = mockFetch.mock.calls[0][0];
        expect(calledUrl).toContain('/stat');
        expect(calledUrl).toContain('path=test.txt');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should throw on non-OK response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response('Not Found', { status: 404 }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const { state } = makeMockState({ token: 'abc' });
        await expect(
          daemonFetch(state, '/stat', { path: 'x' }),
        ).rejects.toThrow('404');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('tool handlers', () => {
    describe('health', () => {
      it('should call GET /health and return result', async () => {
        const { state } = makeMockState({
          fetchReply: () => jsonResponse(200, { status: 'ok' }),
        });

        // Import tools dynamically to test with mock state
        const { infrastructureTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/infrastructure.js'
        );
        const tools = infrastructureTools(state);
        const healthTool = tools.find(
          (t: { name: string }) => t.name === 'health',
        );

        expect(healthTool).toBeDefined();
        expect(healthTool.name).toBe('health');
        expect(healthTool.description).toContain('daemon');
      });
    });

    describe('session_create', () => {
      it('should set defaultSessionId after successful creation', async () => {
        const { state } = makeMockState({
          fetchReply: (req) => {
            if (req.url.endsWith('/session') && req.method === 'POST') {
              return jsonResponse(200, {
                sessionId: 'new-session-id',
                workspaceCwd: '/tmp',
                attached: false,
              });
            }
            return jsonResponse(404, {});
          },
        });

        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const tools = sessionTools(state);
        const createTool = tools.find(
          (t: { name: string }) => t.name === 'session_create',
        );
        expect(createTool).toBeDefined();

        // Call the handler
        const result = await createTool.handler({ workspace_cwd: '/tmp' }, {});
        expect(result.content[0].text).toContain('new-session-id');
        expect(state.defaultSessionId).toBe('new-session-id');
      });
    });

    describe('session_close', () => {
      it('should clear defaultSessionId when closing the default session', async () => {
        const { state } = makeMockState({
          defaultSessionId: 'sess-to-close',
          fetchReply: () => new Response(null, { status: 204 }),
        });

        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const tools = sessionTools(state);
        const closeTool = tools.find(
          (t: { name: string }) => t.name === 'session_close',
        );

        await closeTool.handler({ session_id: 'sess-to-close' }, {});
        expect(state.defaultSessionId).toBeUndefined();
      });

      it('should not clear defaultSessionId when closing a different session', async () => {
        const { state } = makeMockState({
          defaultSessionId: 'keep-this',
          fetchReply: () => new Response(null, { status: 204 }),
        });

        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const tools = sessionTools(state);
        const closeTool = tools.find(
          (t: { name: string }) => t.name === 'session_close',
        );

        await closeTool.handler({ session_id: 'other-session' }, {});
        expect(state.defaultSessionId).toBe('keep-this');
      });
    });

    describe('workspace read tools', () => {
      it('should register all 10 read tools', async () => {
        const { state } = makeMockState();
        const { workspaceReadTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/workspaceRead.js'
        );
        const tools = workspaceReadTools(state);
        expect(tools).toHaveLength(10);

        const names = tools.map((t: { name: string }) => t.name);
        expect(names).toContain('file_read');
        expect(names).toContain('file_read_bytes');
        expect(names).toContain('file_stat');
        expect(names).toContain('dir_list');
        expect(names).toContain('glob');
        expect(names).toContain('workspace_mcp_status');
        expect(names).toContain('workspace_skills');
        expect(names).toContain('workspace_providers');
        expect(names).toContain('workspace_env');
        expect(names).toContain('workspace_preflight');
      });
    });

    describe('workspace write tools', () => {
      it('should register all 9 write tools', async () => {
        const { state } = makeMockState();
        const { workspaceWriteTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
        );
        const tools = workspaceWriteTools(state);
        expect(tools).toHaveLength(9);

        const names = tools.map((t: { name: string }) => t.name);
        expect(names).toContain('file_write');
        expect(names).toContain('file_edit');
        expect(names).toContain('workspace_init');
        expect(names).toContain('workspace_memory_read');
        expect(names).toContain('workspace_memory_write');
        expect(names).toContain('workspace_agents_manage');
      });
    });

    describe('agent tools', () => {
      it('should register all 2 agent tools', async () => {
        const { state } = makeMockState();
        const { agentTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/agent.js'
        );
        const tools = agentTools(state);
        expect(tools).toHaveLength(2);

        const names = tools.map((t: { name: string }) => t.name);
        expect(names).toContain('prompt');
        expect(names).toContain('prompt_cancel');
      });
    });

    describe('allTools', () => {
      it('should aggregate to exactly 31 tools', async () => {
        const { state } = makeMockState();
        const { allTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/index.js'
        );
        const tools = allTools(state);
        expect(tools).toHaveLength(31);

        // Verify no duplicate names
        const names = tools.map((t: { name: string }) => t.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(31);
      });
    });
  });

  describe('prompt tool with persistent SSE', () => {
    it('should collect response text via the persistent event stream', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.includes('/prompt')) {
            // Simulate: prompt returns stopReason, but before that the
            // persistent SSE stream will have populated the collector.
            // We simulate this by filling the collector just before the
            // prompt response resolves.
            const stream = state.eventStreams.get('test-session')!;
            const collector = stream.activeCollector!;
            collector.texts.push('hello');
            collector.texts.push(' world');
            collector.resolve();
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          return jsonResponse(404, {});
        },
      });

      // Set up a fake persistent event stream (normally created by session_create)
      const fakeStream: SessionEventStream = {
        sessionId: 'test-session',
        abortCtrl: new AbortController(),
        activeCollector: null,
        lastActivityMs: Date.now(),
      };
      state.eventStreams.set('test-session', fakeStream);

      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const tools = agentTools(state);
      const promptTool = tools.find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const result = await promptTool.handler({ prompt: 'test' }, {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.stop_reason).toBe('end_turn');
      expect(parsed.session_id).toBe('test-session');
      expect(parsed.response).toBe('hello world');
      // Collector should be cleared after prompt completes
      expect(fakeStream.activeCollector).toBeNull();
    });

    it('should throw if no SSE stream exists for the session', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'no-stream-session',
      });

      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const tools = agentTools(state);
      const promptTool = tools.find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const result = await promptTool.handler({ prompt: 'test' }, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No SSE stream');
    });
  });
});

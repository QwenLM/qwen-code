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
} from '../../src/daemon-mcp/serve-bridge/helpers.js';
import type { BridgeState } from '../../src/daemon-mcp/serve-bridge/types.js';
import {
  createBinding,
  disposeBindings,
  replaceBinding,
  startSessionCleanup,
} from '../../src/daemon-mcp/serve-bridge/bindings.js';
import { createPromptCollector } from '../../src/daemon-mcp/serve-bridge/sse.js';
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
  signal: AbortSignal | null;
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
      const captured: CapturedRequest = {
        url,
        method,
        headers,
        body,
        signal: init?.signal ?? null,
      };
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
      invocationIngress: 'external_mcp',
    }),
    daemonUrl: 'http://127.0.0.1:4170',
    token,
    defaultSessionId: opts?.defaultSessionId,
    workspaceCwd: '/tmp/test-workspace',
    bindings: new Map(),
    sessionLocks: new Map(),
    pendingLifecycles: new Set(),
    pendingReleases: new Set(),
    disposed: false,
    allowGlobalScope: false,
  };

  vi.spyOn(state.client, 'subscribeEvents').mockImplementation(
    async function* (_sessionId, subscribeOpts) {
      await new Promise<void>((resolve) => {
        if (subscribeOpts.signal?.aborted) {
          resolve();
        } else {
          subscribeOpts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }
      });
      yield* [];
    },
  );

  return { state, calls };
}

function bindSession(state: BridgeState, sessionId: string, clientId?: string) {
  const binding = createBinding(sessionId, clientId);
  state.bindings.set(sessionId, binding);
  return binding;
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
      expect(server.dispose).toBeTypeOf('function');
    });

    it('should strip trailing slashes from daemonUrl', () => {
      const server = createServeBridgeMcpServer({
        daemonUrl: 'http://127.0.0.1:4170///',
        token: 'test',
      });
      expect(server).toBeDefined();
    });

    it('should return one idempotent dispose promise', async () => {
      const server = createServeBridgeMcpServer({
        daemonUrl: 'http://127.0.0.1:4170',
        token: 'test',
      });

      const first = server.dispose();
      expect(server.dispose()).toBe(first);
      await first;
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

  describe('handler', () => {
    it('should pass args through and return result', async () => {
      const fn = vi
        .fn()
        .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const wrapped = handler(fn);
      const result = await wrapped({ foo: 'bar' }, {});
      expect(fn).toHaveBeenCalledWith({ foo: 'bar' }, { signal: undefined });
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

      it('should retain bindings for multiple created sessions', async () => {
        let createCount = 0;
        const { state, calls } = makeMockState({
          fetchReply: (req) => {
            if (req.url.endsWith('/session') && req.method === 'POST') {
              createCount++;
              return jsonResponse(200, {
                sessionId: createCount === 1 ? 'session-a' : 'session-b',
                clientId: createCount === 1 ? 'client-a' : 'client-b',
                workspaceCwd: '/tmp',
                attached: false,
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const createTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_create',
        );

        await createTool.handler({}, {});
        await createTool.handler({}, {});

        expect(state.defaultSessionId).toBe('session-b');
        expect([...state.bindings.keys()]).toEqual(['session-a', 'session-b']);
        expect(state.bindings.get('session-a')?.clientId).toBe('client-a');
        expect(state.bindings.get('session-b')?.clientId).toBe('client-b');
        expect(calls.some((call) => call.url.endsWith('/detach'))).toBe(false);
      });

      it('should discard a create acquisition when its session has an active prompt', async () => {
        const { state, calls } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) => {
            if (req.url.endsWith('/session') && req.method === 'POST') {
              return jsonResponse(200, {
                sessionId: 'session-a',
                clientId: 'client-new',
                workspaceCwd: '/tmp',
                attached: true,
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        const existing = bindSession(state, 'session-a', 'client-old');
        existing.stream.activeCollector = createPromptCollector();
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const createTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_create',
        );

        const result = await createTool.handler({}, {});

        expect(result.isError).toBe(true);
        expect(state.bindings.get('session-a')).toBe(existing);
        expect(state.defaultSessionId).toBe('session-a');
        const detachCalls = calls.filter((call) =>
          call.url.endsWith('/session/session-a/detach'),
        );
        expect(detachCalls).toHaveLength(1);
        expect(detachCalls[0]?.headers['x-qwen-client-id']).toBe('client-new');
      });

      it('should keep disposal pending until an in-flight create is released', async () => {
        let resolveCreate!: (response: Response) => void;
        const { state, calls } = makeMockState({
          fetchReply: (req) => {
            if (req.url.endsWith('/session') && req.method === 'POST') {
              return new Promise<Response>((resolve) => {
                resolveCreate = resolve;
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const createTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_create',
        );

        const creating = createTool.handler({}, {});
        await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'));
        let disposed = false;
        const disposing = disposeBindings(state).finally(() => {
          disposed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(disposed).toBe(false);

        resolveCreate(
          jsonResponse(200, {
            sessionId: 'session-a',
            clientId: 'client-new',
            workspaceCwd: '/tmp',
            attached: false,
          }),
        );
        const result = await creating;
        await disposing;

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('shutting down');
        expect(state.bindings.size).toBe(0);
        const detachCalls = calls.filter((call) =>
          call.url.endsWith('/detach'),
        );
        expect(detachCalls).toHaveLength(1);
        expect(detachCalls[0]?.headers['x-qwen-client-id']).toBe('client-new');
      });

      it('should reject a create started after disposal without acquiring a session', async () => {
        const { state, calls } = makeMockState({
          fetchReply: () =>
            jsonResponse(200, {
              sessionId: 'unexpected',
              clientId: 'unexpected-client',
              workspaceCwd: '/tmp',
              attached: false,
            }),
        });
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const createTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_create',
        );
        await disposeBindings(state);

        const result = await createTool.handler({}, {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('shutting down');
        expect(calls).toHaveLength(0);
      });
    });

    describe('session_resume', () => {
      it('should serialize replacements and detach every prior acquisition', async () => {
        let resolveFirst!: (response: Response) => void;
        let resumeCount = 0;
        const { state, calls } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) => {
            if (req.url.endsWith('/resume')) {
              resumeCount++;
              if (resumeCount === 1) {
                return new Promise<Response>((resolve) => {
                  resolveFirst = resolve;
                });
              }
              return jsonResponse(200, {
                sessionId: 'session-a',
                clientId: 'client-old',
                workspaceCwd: '/tmp',
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        await replaceBinding(state, createBinding('session-a', 'client-old'));
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const resumeTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_resume',
        );

        const first = resumeTool.handler({ session_id: 'session-a' }, {});
        const second = resumeTool.handler({ session_id: 'session-a' }, {});
        await vi.waitFor(() => expect(resumeCount).toBe(1));
        resolveFirst(
          jsonResponse(200, {
            sessionId: 'session-a',
            clientId: 'client-old',
            workspaceCwd: '/tmp',
          }),
        );
        await first;
        await second;

        const resumeCalls = calls.filter((call) =>
          call.url.endsWith('/resume'),
        );
        expect(resumeCalls).toHaveLength(2);
        expect(resumeCalls[0]?.headers['x-qwen-client-id']).toBe('client-old');
        expect(resumeCalls[1]?.headers['x-qwen-client-id']).toBe('client-old');
        const detachIds = calls
          .filter((call) => call.url.endsWith('/detach'))
          .map((call) => call.headers['x-qwen-client-id']);
        expect(detachIds).toEqual(['client-old', 'client-old']);
        expect(state.bindings.get('session-a')?.clientId).toBe('client-old');
        expect(state.defaultSessionId).toBe('session-a');
      });
    });

    describe('session_close', () => {
      it('should clear defaultSessionId when closing the default session', async () => {
        const { state } = makeMockState({
          defaultSessionId: 'sess-to-close',
          fetchReply: () => new Response(null, { status: 204 }),
        });
        state.bindings.set(
          'sess-to-close',
          createBinding('sess-to-close', 'client-close'),
        );

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
          fetchReply: () => jsonResponse(404, { code: 'not_found' }),
        });
        state.bindings.set(
          'other-session',
          createBinding('other-session', 'client-other'),
        );

        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const tools = sessionTools(state);
        const closeTool = tools.find(
          (t: { name: string }) => t.name === 'session_close',
        );

        await closeTool.handler({ session_id: 'other-session' }, {});
        expect(state.defaultSessionId).toBe('keep-this');
        expect(state.bindings.has('other-session')).toBe(false);
      });

      it('should not detach when the SSE stream ends during close', async () => {
        let resolveClose!: (response: Response) => void;
        let endStream!: () => void;
        const { state, calls } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) => {
            if (req.method === 'DELETE') {
              return new Promise<Response>((resolve) => {
                resolveClose = resolve;
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        vi.spyOn(state.client, 'subscribeEvents').mockImplementation(
          async function* () {
            await new Promise<void>((resolve) => {
              endStream = resolve;
            });
            yield* [];
          },
        );
        await replaceBinding(state, createBinding('session-a', 'client-old'));
        await vi.waitFor(() => expect(endStream).toBeTypeOf('function'));
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const closeTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_close',
        );

        const pending = closeTool.handler({ session_id: 'session-a' }, {});
        await vi.waitFor(() => expect(resolveClose).toBeTypeOf('function'));
        endStream();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        resolveClose(new Response(null, { status: 204 }));
        await pending;

        expect(
          calls.filter((call) => call.url.endsWith('/detach')),
        ).toHaveLength(0);
      });

      it('should invalidate the current binding on invalid_client_id', async () => {
        const { state, calls } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) =>
            req.method === 'DELETE'
              ? jsonResponse(400, { code: 'invalid_client_id' })
              : new Response(null, { status: 204 }),
        });
        const binding = bindSession(state, 'session-a', 'client-old');
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const closeTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_close',
        );

        const result = await closeTool.handler({ session_id: 'session-a' }, {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Call session_resume');
        expect(state.bindings.has('session-a')).toBe(false);
        expect(binding.stream.abortCtrl.signal.aborted).toBe(true);
        expect(
          calls.filter((call) => call.url.endsWith('/detach')),
        ).toHaveLength(0);
      });

      it('should preserve the binding on a transient close failure', async () => {
        const { state } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) =>
            req.method === 'DELETE'
              ? jsonResponse(500, { code: 'internal_error' })
              : new Response(null, { status: 204 }),
        });
        const binding = bindSession(state, 'session-a', 'client-old');
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const closeTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_close',
        );

        const result = await closeTool.handler({ session_id: 'session-a' }, {});

        expect(result.isError).toBe(true);
        expect(state.bindings.get('session-a')).toBe(binding);
        expect(binding.stream.abortCtrl.signal.aborted).toBe(false);
      });

      it('should preserve a newer binding on a stale close rejection', async () => {
        let resolveClose!: (response: Response) => void;
        const { state } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) => {
            if (req.method === 'DELETE') {
              return new Promise<Response>((resolve) => {
                resolveClose = resolve;
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        bindSession(state, 'session-a', 'client-old');
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const closeTool = sessionTools(state).find(
          (t: { name: string }) => t.name === 'session_close',
        );

        const pending = closeTool.handler({ session_id: 'session-a' }, {});
        await vi.waitFor(() => expect(resolveClose).toBeTypeOf('function'));
        const newer = createBinding('session-a', 'client-new');
        state.bindings.set('session-a', newer);
        resolveClose(jsonResponse(400, { code: 'invalid_client_id' }));
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Retry the request');
        expect(state.bindings.get('session-a')).toBe(newer);
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
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.includes('/prompt')) {
            // Simulate: prompt returns stopReason, but before that the
            // persistent SSE stream will have populated the collector.
            // We simulate this by filling the collector just before the
            // prompt response resolves.
            const stream = state.bindings.get('test-session')!.stream;
            const collector = stream.activeCollector!;
            collector.texts.push('hello');
            collector.texts.push(' world');
            collector.resolve();
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          return jsonResponse(404, {});
        },
      });

      const binding = createBinding('test-session', 'client-test');
      const fakeStream = binding.stream;
      state.bindings.set('test-session', binding);

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
      expect(
        calls.find((call) => call.url.endsWith('/prompt'))?.headers[
          'x-qwen-client-id'
        ],
      ).toBe('client-test');
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
      expect(result.content[0].text).toContain('No active binding');
    });

    it('should reject concurrent prompts on the same session', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: () => jsonResponse(200, { stopReason: 'end' }),
      });

      const { createPromptCollector } = await import(
        '../../src/daemon-mcp/serve-bridge/sse.js'
      );
      const binding = createBinding('test-session', 'client-test');
      const fakeStream = binding.stream;
      fakeStream.activeCollector = createPromptCollector();
      state.bindings.set('test-session', binding);

      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const tools = agentTools(state);
      const promptTool = tools.find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const result = await promptTool.handler({ prompt: 'test' }, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('already in progress');
    });

    it('prompt_cancel should resolve active collector', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: () => jsonResponse(200, {}),
      });

      const { createPromptCollector } = await import(
        '../../src/daemon-mcp/serve-bridge/sse.js'
      );
      const collector = createPromptCollector();
      const binding = createBinding('test-session', 'client-test');
      const fakeStream = binding.stream;
      fakeStream.activeCollector = collector;
      state.bindings.set('test-session', binding);

      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const tools = agentTools(state);
      const cancelTool = tools.find(
        (t: { name: string }) => t.name === 'prompt_cancel',
      );

      await cancelTool.handler({}, {});
      expect(collector.resolved).toBe(true);
      expect(collector.interrupted).toBe(true);
    });

    it('should keep legacy anonymous bindings usable', async () => {
      const { state, calls } = makeMockState({
        defaultSessionId: 'legacy-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            const collector =
              state.bindings.get('legacy-session')!.stream.activeCollector!;
            collector.resolve();
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'legacy-session');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const result = await promptTool.handler({ prompt: 'test' }, {});

      expect(result.isError).toBeUndefined();
      expect(
        calls.find((call) => call.url.endsWith('/prompt'))?.headers[
          'x-qwen-client-id'
        ],
      ).toBeUndefined();
    });

    it('should preserve a completed response when abort arrives after collection', async () => {
      const controller = new AbortController();
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            const collector =
              state.bindings.get('test-session')!.stream.activeCollector!;
            collector.texts.push('completed response');
            collector.resolve();
            controller.abort();
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'test-session', 'client-test');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const result = await promptTool.handler(
        { prompt: 'test' },
        { signal: controller.signal },
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        stop_reason: 'end_turn',
        response: 'completed response',
      });
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        1,
      );
    });

    it('should not cancel an unadmitted legacy prompt after abort', async () => {
      const controller = new AbortController();
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            return new Promise<Response>((_resolve, reject) => {
              req.signal?.addEventListener(
                'abort',
                () => reject(req.signal?.reason),
                { once: true },
              );
            });
          }
          if (req.url.endsWith('/cancel')) {
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'test-session', 'client-test');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const pending = promptTool.handler(
        { prompt: 'test' },
        { signal: controller.signal },
      );
      await vi.waitFor(() =>
        expect(calls.some((call) => call.url.endsWith('/prompt'))).toBe(true),
      );
      controller.abort();
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('aborted');
      expect(state.bindings.has('test-session')).toBe(true);
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        0,
      );
    });

    it('should wait for active prompt cancellation before detaching on disposal', async () => {
      let resolveCancel!: (response: Response) => void;
      const controller = new AbortController();
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          if (req.url.endsWith('/cancel')) {
            return new Promise<Response>((resolve) => {
              resolveCancel = resolve;
            });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'test-session', 'client-test');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const prompting = promptTool.handler(
        { prompt: 'test' },
        { signal: controller.signal },
      );
      await vi.waitFor(() =>
        expect(
          state.bindings.get('test-session')?.stream.activeCollector,
        ).not.toBeNull(),
      );
      controller.abort();
      await vi.waitFor(() => expect(resolveCancel).toBeTypeOf('function'));

      let disposalSettled = false;
      const disposing = disposeBindings(state).finally(() => {
        disposalSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const detachedBeforeCancel = calls.some((call) =>
        call.url.endsWith('/detach'),
      );
      const settledBeforeCancel = disposalSettled;

      resolveCancel(new Response(null, { status: 204 }));
      await Promise.all([prompting, disposing]);

      expect(detachedBeforeCancel).toBe(false);
      expect(settledBeforeCancel).toBe(false);
      expect(calls.filter((call) => call.url.endsWith('/detach'))).toHaveLength(
        1,
      );
    });

    it('should invalidate the current binding when abort cancellation is rejected', async () => {
      const controller = new AbortController();
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            return jsonResponse(202, {
              promptId: 'prompt-accepted',
              lastEventId: 0,
            });
          }
          if (req.url.endsWith('/cancel')) {
            return jsonResponse(400, { code: 'invalid_client_id' });
          }
          return new Response(null, { status: 204 });
        },
      });
      const binding = bindSession(state, 'test-session', 'client-stale');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      const pending = promptTool.handler(
        { prompt: 'test' },
        { signal: controller.signal },
      );
      await vi.waitFor(() =>
        expect(state.client.subscribeEvents).toHaveBeenCalled(),
      );
      controller.abort();
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('session_resume');
      expect(state.bindings.has('test-session')).toBe(false);
      expect(binding.stream.abortCtrl.signal.aborted).toBe(true);
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        1,
      );
    });

    it('should cancel an aborted settled prompt exactly once with its captured binding', async () => {
      const controller = new AbortController();
      let resolveCancel!: (response: Response) => void;
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          if (req.url.endsWith('/cancel')) {
            return new Promise<Response>((resolve) => {
              resolveCancel = resolve;
            });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'test-session', 'client-test');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      let settled = false;
      const pending = promptTool
        .handler(
          { prompt: 'test' },
          { signal: controller.signal, _meta: { forged: true } },
        )
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() =>
        expect(calls.some((call) => call.url.endsWith('/prompt'))).toBe(true),
      );
      controller.abort();
      await vi.waitFor(() => expect(resolveCancel).toBeTypeOf('function'));
      expect(settled).toBe(false);
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        1,
      );

      resolveCancel(new Response(null, { status: 204 }));
      const result = await pending;

      expect(result.isError).toBe(true);
      const cancelCalls = calls.filter((call) => call.url.endsWith('/cancel'));
      expect(cancelCalls).toHaveLength(1);
      expect(cancelCalls[0]?.headers['x-qwen-client-id']).toBe('client-test');
    });

    it('should preserve 202 SSE abort after a transient cancellation failure', async () => {
      const controller = new AbortController();
      let promptCount = 0;
      let rejectCancel!: (reason?: unknown) => void;
      const { state, calls } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/prompt')) {
            promptCount++;
            if (promptCount === 1) {
              return jsonResponse(202, {
                promptId: 'prompt-1',
                lastEventId: 0,
              });
            }
            const collector =
              state.bindings.get('test-session')!.stream.activeCollector!;
            collector.texts.push('second response');
            collector.resolve();
            return jsonResponse(200, { stopReason: 'end_turn' });
          }
          if (req.url.endsWith('/cancel')) {
            return new Promise<Response>((_resolve, reject) => {
              rejectCancel = reject;
            });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'test-session', 'client-test');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const promptTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt',
      );

      let settled = false;
      const first = promptTool
        .handler({ prompt: 'first' }, { signal: controller.signal })
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() =>
        expect(
          calls.filter((call) => call.url.endsWith('/prompt')),
        ).toHaveLength(1),
      );
      controller.abort();
      await vi.waitFor(() => expect(rejectCancel).toBeTypeOf('function'));

      expect(settled).toBe(false);
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        1,
      );
      rejectCancel(new Error('cancel network failed'));
      const firstResult = await first;
      expect(firstResult.isError).toBe(true);
      expect(firstResult.content[0].text).toContain('aborted');

      const secondResult = await promptTool.handler({ prompt: 'second' }, {});

      expect(secondResult.isError).toBeUndefined();
      expect(JSON.parse(secondResult.content[0].text).response).toBe(
        'second response',
      );
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        1,
      );
    });

    it('should use the captured binding for timeout cancellation', async () => {
      vi.useFakeTimers();
      try {
        const { state, calls } = makeMockState({
          defaultSessionId: 'test-session',
          fetchReply: (req) => {
            if (req.url.endsWith('/prompt')) {
              return jsonResponse(200, { stopReason: 'end_turn' });
            }
            if (req.url.endsWith('/cancel')) {
              return jsonResponse(400, { code: 'invalid_client_id' });
            }
            return new Response(null, { status: 204 });
          },
        });
        bindSession(state, 'test-session', 'client-test');
        const { agentTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/agent.js'
        );
        const promptTool = agentTools(state).find(
          (t: { name: string }) => t.name === 'prompt',
        );

        const pending = promptTool.handler({ prompt: 'test' }, {});
        await vi.advanceTimersByTimeAsync(30000);
        const result = await pending;

        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.stop_reason).toBe('timeout');
        expect(parsed.warning).toContain('session_resume');
        expect(parsed.warning).toContain('test-session');
        const cancelCalls = calls.filter((call) =>
          call.url.endsWith('/cancel'),
        );
        expect(cancelCalls).toHaveLength(1);
        expect(cancelCalls[0]?.headers['x-qwen-client-id']).toBe('client-test');
        expect(state.bindings.has('test-session')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should preserve a newer binding when stale timeout cancellation is rejected', async () => {
      vi.useFakeTimers();
      try {
        let resolveCancel!: (response: Response) => void;
        const { state, calls } = makeMockState({
          defaultSessionId: 'test-session',
          fetchReply: (req) => {
            if (req.url.endsWith('/prompt')) {
              return jsonResponse(200, { stopReason: 'end_turn' });
            }
            if (req.url.endsWith('/cancel')) {
              return new Promise<Response>((resolve) => {
                resolveCancel = resolve;
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        bindSession(state, 'test-session', 'client-stale');
        const { agentTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/agent.js'
        );
        const promptTool = agentTools(state).find(
          (t: { name: string }) => t.name === 'prompt',
        );

        const pending = promptTool.handler({ prompt: 'test' }, {});
        await vi.advanceTimersByTimeAsync(30000);
        expect(resolveCancel).toBeTypeOf('function');
        const newer = createBinding('test-session', 'client-new');
        state.bindings.set('test-session', newer);
        resolveCancel(jsonResponse(400, { code: 'invalid_client_id' }));
        const result = await pending;

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.stop_reason).toBe('timeout');
        expect(parsed.warning).not.toContain('session_resume');
        expect(state.bindings.get('test-session')).toBe(newer);
        const cancelCalls = calls.filter((call) =>
          call.url.endsWith('/cancel'),
        );
        expect(cancelCalls).toHaveLength(1);
        expect(cancelCalls[0]?.headers['x-qwen-client-id']).toBe(
          'client-stale',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('should invalidate the current binding on explicit cancel rejection', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) =>
          req.url.endsWith('/cancel')
            ? jsonResponse(400, { code: 'invalid_client_id' })
            : new Response(null, { status: 204 }),
      });
      const current = bindSession(state, 'test-session', 'client-old');
      current.stream.activeCollector = createPromptCollector();
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const cancelTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt_cancel',
      );

      const currentResult = await cancelTool.handler({}, {});
      expect(currentResult.isError).toBe(true);
      expect(currentResult.content[0].text).toContain('Call session_resume');
      expect(current.stream.activeCollector?.resolved).toBe(true);
      expect(state.bindings.has('test-session')).toBe(false);
    });

    it('should preserve a newer binding on a stale cancel rejection', async () => {
      let resolveCancel!: (response: Response) => void;
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: (req) => {
          if (req.url.endsWith('/cancel')) {
            return new Promise<Response>((resolve) => {
              resolveCancel = resolve;
            });
          }
          return new Response(null, { status: 204 });
        },
      });
      const old = bindSession(state, 'test-session', 'client-stale');
      const { agentTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/agent.js'
      );
      const cancelTool = agentTools(state).find(
        (t: { name: string }) => t.name === 'prompt_cancel',
      );

      const pending = cancelTool.handler({}, {});
      await vi.waitFor(() => expect(resolveCancel).toBeTypeOf('function'));
      const newer = createBinding('test-session', 'client-new');
      state.bindings.set('test-session', newer);
      resolveCancel(jsonResponse(400, { code: 'invalid_client_id' }));
      const staleResult = await pending;

      expect(staleResult.isError).toBe(true);
      expect(staleResult.content[0].text).toContain('Retry the request');
      expect(state.bindings.get('test-session')).toBe(newer);
      expect(old).not.toBe(newer);
    });
  });

  describe('binding cleanup', () => {
    it.each([
      {
        toolName: 'session_load',
        request: { session_id: 'session-a' },
        matches: (req: CapturedRequest) => req.url.endsWith('/load'),
        response: () =>
          jsonResponse(200, {
            sessionId: 'session-a',
            clientId: 'client-new',
            workspaceCwd: '/tmp',
          }),
        expectedDetachIds: ['client-new', 'client-old'],
      },
      {
        toolName: 'session_resume',
        request: { session_id: 'session-a' },
        matches: (req: CapturedRequest) => req.url.endsWith('/resume'),
        response: () =>
          jsonResponse(200, {
            sessionId: 'session-a',
            clientId: 'client-new',
            workspaceCwd: '/tmp',
          }),
        expectedDetachIds: ['client-new', 'client-old'],
      },
      {
        toolName: 'session_close',
        request: { session_id: 'session-a' },
        matches: (req: CapturedRequest) => req.method === 'DELETE',
        response: () => new Response(null, { status: 204 }),
        expectedDetachIds: [],
      },
    ])(
      'should drain a pending $toolName before disposal releases bindings',
      async ({ toolName, request, matches, response, expectedDetachIds }) => {
        let resolveOperation!: (response: Response) => void;
        const { state, calls } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: (req) => {
            if (matches(req)) {
              return new Promise<Response>((resolve) => {
                resolveOperation = resolve;
              });
            }
            return new Response(null, { status: 204 });
          },
        });
        bindSession(state, 'session-a', 'client-old');
        const { sessionTools } = await import(
          '../../src/daemon-mcp/serve-bridge/tools/session.js'
        );
        const lifecycleTool = sessionTools(state).find(
          (tool: { name: string }) => tool.name === toolName,
        );

        const operation = lifecycleTool.handler(request, {});
        await vi.waitFor(() => expect(resolveOperation).toBeTypeOf('function'));
        let disposed = false;
        const disposing = disposeBindings(state).finally(() => {
          disposed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(disposed).toBe(false);

        resolveOperation(response());
        await operation;
        await disposing;

        const detachIds = calls
          .filter((call) => call.url.endsWith('/detach'))
          .map((call) => call.headers['x-qwen-client-id']);
        expect(detachIds).toEqual(expectedDetachIds);
        expect(new Set(detachIds).size).toBe(detachIds.length);
        expect(state.bindings.size).toBe(0);
      },
    );

    it('should skip active prompts during idle cleanup, then detach once idle', async () => {
      vi.useFakeTimers();
      try {
        const { state, calls } = makeMockState({
          defaultSessionId: 'session-a',
          fetchReply: () => new Response(null, { status: 204 }),
        });
        const binding = bindSession(state, 'session-a', 'client-a');
        binding.stream.lastActivityMs = 0;
        binding.stream.activeCollector = createPromptCollector();
        const stopCleanup = startSessionCleanup(state);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(state.bindings.get('session-a')).toBe(binding);
        expect(
          calls.filter((call) => call.url.endsWith('/detach')),
        ).toHaveLength(0);

        binding.stream.activeCollector = null;
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(state.bindings.has('session-a')).toBe(false);
        expect(
          calls.filter((call) => call.url.endsWith('/detach')),
        ).toHaveLength(1);
        stopCleanup();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should await an in-flight detach across repeated disposal', async () => {
      let resolveDetach!: (response: Response) => void;
      const { state, calls } = makeMockState({
        defaultSessionId: 'session-a',
        fetchReply: (req) => {
          if (req.url.endsWith('/detach')) {
            return new Promise<Response>((resolve) => {
              resolveDetach = resolve;
            });
          }
          return new Response(null, { status: 204 });
        },
      });
      bindSession(state, 'session-a', 'client-a');

      const first = disposeBindings(state);
      const second = disposeBindings(state);
      await vi.waitFor(() => expect(resolveDetach).toBeTypeOf('function'));
      expect(calls.filter((call) => call.url.endsWith('/detach'))).toHaveLength(
        1,
      );
      expect(state.pendingReleases.size).toBe(1);
      resolveDetach(new Response(null, { status: 204 }));
      await Promise.all([first, second]);

      expect(state.pendingReleases.size).toBe(0);
    });

    it('should dispose a legacy anonymous binding without a detach request', async () => {
      const { state, calls } = makeMockState();
      bindSession(state, 'legacy-session');

      await disposeBindings(state);

      expect(state.bindings.size).toBe(0);
      expect(calls.some((call) => call.url.endsWith('/detach'))).toBe(false);
    });
  });

  describe('safety guards', () => {
    it('should reject global scope in workspace_memory_write', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const memWriteTool = tools.find(
        (t: { name: string }) => t.name === 'workspace_memory_write',
      );

      const result = await memWriteTool.handler(
        { scope: 'global', content: 'test', mode: 'append' },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Global scope is disabled');
    });

    it('should reject global scope in workspace_agents_manage', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const agentsTool = tools.find(
        (t: { name: string }) => t.name === 'workspace_agents_manage',
      );

      const result = await agentsTool.handler(
        {
          action: 'create',
          scope: 'global',
          name: 'x',
          description: 'x',
          system_prompt: 'x',
        },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Global scope is disabled');
    });

    it('should reject yolo approval mode without allowGlobalScope', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const approvalTool = tools.find(
        (t: { name: string }) => t.name === 'session_set_approval_mode',
      );

      const result = await approvalTool.handler(
        { mode: 'yolo', session_id: 'test-session' },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('restricted for security');
    });

    it('should reject auto-edit approval mode without allowGlobalScope', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const approvalTool = tools.find(
        (t: { name: string }) => t.name === 'session_set_approval_mode',
      );

      const result = await approvalTool.handler(
        { mode: 'auto-edit', session_id: 'test-session' },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('restricted for security');
    });

    it('should reject persistent approval mode change without allowGlobalScope', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const approvalTool = tools.find(
        (t: { name: string }) => t.name === 'session_set_approval_mode',
      );

      const result = await approvalTool.handler(
        { mode: 'default', persist: true, session_id: 'test-session' },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('restricted for security');
    });

    it('should allow read-only agents_manage actions with global scope', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: () => jsonResponse(200, []),
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const agentsTool = tools.find(
        (t: { name: string }) => t.name === 'workspace_agents_manage',
      );

      // list with scope=global should NOT be blocked (read-only)
      const result = await agentsTool.handler(
        { action: 'list', scope: 'global' },
        {},
      );
      expect(result.isError).toBeUndefined();
    });

    it('should reject file_write replace mode without expected_hash', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const writeFileTool = tools.find(
        (t: { name: string }) => t.name === 'file_write',
      );

      const result = await writeFileTool.handler(
        { path: 'test.txt', content: 'hello', mode: 'replace' },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('expected_hash is required');
    });

    it('should reject workspace_tool_toggle without allowGlobalScope', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = false;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const toggleTool = tools.find(
        (t: { name: string }) => t.name === 'workspace_tool_toggle',
      );

      const result = await toggleTool.handler(
        { tool_name: 'file_read', enabled: false },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('restricted for security');
    });

    it('should allow workspace_tool_toggle with allowGlobalScope', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
        fetchReply: () => jsonResponse(200, { ok: true }),
      });
      state.allowGlobalScope = true;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const toggleTool = tools.find(
        (t: { name: string }) => t.name === 'workspace_tool_toggle',
      );

      const result = await toggleTool.handler(
        { tool_name: 'file_read', enabled: false },
        {},
      );
      expect(result.isError).toBeUndefined();
    });

    it('should reject agents_manage update with no fields', async () => {
      const { state } = makeMockState({
        defaultSessionId: 'test-session',
      });
      state.allowGlobalScope = true;

      const { workspaceWriteTools } = await import(
        '../../src/daemon-mcp/serve-bridge/tools/workspaceWrite.js'
      );
      const tools = workspaceWriteTools(state);
      const agentsTool = tools.find(
        (t: { name: string }) => t.name === 'workspace_agents_manage',
      );

      const result = await agentsTool.handler(
        { action: 'update', agent_type: 'test-agent' },
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'At least one field to update must be provided',
      );
    });
  });
});

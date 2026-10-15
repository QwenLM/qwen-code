/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  Client as McpClient,
  type Client,
} from '@modelcontextprotocol/sdk/client/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { SdkControlClientTransport, Storage } from '@qwen-code/qwen-code-core';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { mountAcpHttp } from './index.js';
import type {
  ClientMcpServerProvider,
  ClientMcpServerScope,
} from './client-mcp-ws.js';
import { ClientMcpWsConnection } from './client-mcp-ws.js';
import { WorkspaceRememberTaskLane } from '../workspace-remember.js';
import { SessionArchiveCoordinator } from '../server/session-archive.js';
import { createRequestedSessionIdAdmission } from '../session-id-admission.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

/**
 * Serve-layer WS round-trip test for the reverse tool channel (issue #5626,
 * Phase 2). Boots the real acp-http WS over a fake bridge, connects a headless
 * `ws` client (standing in for the Chrome extension), and:
 *
 *   1. initializes the ACP connection,
 *   2. sends `mcp_register { server }`,
 *   3. responds to the daemon's MCP handshake (`initialize`, `tools/list`,
 *      `tools/call`) over `mcp_message` frames with a canned catalog + result,
 *
 * then asserts the daemon (a) registers the runtime server and (b) can list
 * and call the client-hosted tool — i.e. the `mcp_message` round-trip works
 * end-to-end over a real WS WITHOUT any LLM.
 *
 * The injected `ClientMcpServerProvider` stands in for the agent's live
 * `McpClientManager.addRuntimeMcpServer` SDK path (which is validated against a
 * real `McpClient` in `core/src/tools/client-mcp-registrar.test.ts`). Here the
 * provider drives a real `@modelcontextprotocol/sdk` `Client` over the same
 * `SdkControlClientTransport` the manager would construct — so the
 * register → discover → call sequence flows through the genuine reverse
 * channel.
 */

const fakeBridge = {
  async detachClient() {},
} as unknown as HttpAcpBridge;

const fakeWorkspace = {} as unknown as DaemonWorkspaceService;

/**
 * A provider that, on `registerClientMcpServer`, connects a real MCP `Client`
 * over `SdkControlClientTransport` (wired to the supplied `sendSdkMcpMessage`)
 * and discovers the client-hosted catalog. Exposes the connected client so the
 * test can `tools/list` + `tools/call` through the reverse channel.
 */
class AgentSideProvider implements ClientMcpServerProvider {
  readonly clients = new Map<string, Client>();
  /** Scope each server was registered / unregistered with (frame plumbing). */
  readonly registerScopes = new Map<string, ClientMcpServerScope | undefined>();
  readonly unregisterScopes = new Map<
    string,
    ClientMcpServerScope | undefined
  >();
  lastToolList: Awaited<ReturnType<Client['listTools']>> | undefined;

  async registerClientMcpServer(
    serverName: string,
    sendSdkMcpMessage: (
      serverName: string,
      message: JSONRPCMessage,
    ) => Promise<JSONRPCMessage>,
    scope?: ClientMcpServerScope,
  ): Promise<{ toolCount: number }> {
    this.registerScopes.set(serverName, scope);
    const transport = new SdkControlClientTransport({
      serverName,
      sendMcpMessage: sendSdkMcpMessage,
    });
    const client = new McpClient({ name: 'agent', version: '0.0.1' });
    // connect() runs the MCP `initialize` handshake over the reverse channel.
    await client.connect(transport);
    // Discover the catalog so toolCount mirrors the manager's behavior.
    const tools = await client.listTools();
    this.lastToolList = tools;
    this.clients.set(serverName, client);
    return { toolCount: tools.tools.length };
  }

  async unregisterClientMcpServer(
    serverName: string,
    scope?: ClientMcpServerScope,
  ): Promise<void> {
    this.unregisterScopes.set(serverName, scope);
    const client = this.clients.get(serverName);
    if (client) {
      this.clients.delete(serverName);
      await client.close();
    }
  }
}

/**
 * A canned MCP server that the test's WS client uses to answer the daemon's
 * `mcp_message` frames. Hand-rolled JSON-RPC (no SDK Server needed on the test
 * side) so the wire is fully explicit.
 */
function answerHandshakeFrame(frame: {
  id: string;
  server: string;
  payload: { id?: number | string; method?: string; params?: unknown };
}): { id: string; server: string; payload: JSONRPCMessage } | undefined {
  const { payload } = frame;
  // Notifications (no id) need no reply.
  if (payload.id === undefined || payload.id === null) return undefined;

  let result: unknown;
  switch (payload.method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: frame.server, version: '0.0.1' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'chrome_read_page',
            description: 'Read the current page text',
            inputSchema: {
              type: 'object',
              properties: { selector: { type: 'string' } },
            },
          },
        ],
      };
      break;
    case 'tools/call':
      result = {
        content: [{ type: 'text', text: 'page-text-from-browser' }],
      };
      break;
    default:
      // Unknown method → JSON-RPC method-not-found.
      return {
        id: frame.id,
        server: frame.server,
        payload: {
          jsonrpc: '2.0',
          id: payload.id,
          error: {
            code: -32601,
            message: `method not found: ${payload.method}`,
          },
        } as JSONRPCMessage,
      };
  }
  return {
    id: frame.id,
    server: frame.server,
    payload: {
      jsonrpc: '2.0',
      id: payload.id,
      result,
    } as JSONRPCMessage,
  };
}

describe('client_mcp_over_ws reverse channel (serve layer)', () => {
  let server: Server;
  let port: number;
  let provider: AgentSideProvider;

  function startServer(
    opts: { clientMcpOverWs?: boolean; withProvider?: boolean } = {},
  ): Promise<void> {
    provider = new AgentSideProvider();
    return new Promise<void>((resolve) => {
      const app = express();
      app.use(express.json());
      const archiveCoordinator = new SessionArchiveCoordinator();
      const handle = mountAcpHttp(app, fakeBridge, {
        boundWorkspace: '/ws',
        workspace: fakeWorkspace,
        enabled: true,
        workspaceRememberLane: new WorkspaceRememberTaskLane(fakeBridge),
        clientMcpOverWs: opts.clientMcpOverWs ?? true,
        ...(opts.withProvider === false ? {} : { clientMcpProvider: provider }),
        archiveCoordinator,
        requestedSessionIdAdmission: createRequestedSessionIdAdmission({
          archiveCoordinator,
          getBridges: () => [fakeBridge],
          getPersistenceTargets: () => [
            {
              workspaceCwd: '/ws',
              runtimeBaseDir: Storage.getRuntimeBaseDir(),
            },
          ],
        }),
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

  function wsConnect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  /** Initialize the ACP connection and resolve once the init reply lands. */
  function initialize(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      ws.once('message', () => resolve());
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        }),
      );
    });
  }

  it('round-trips register → tools/list → tools/call over the WS', async () => {
    await startServer({ clientMcpOverWs: true });
    const ws = await wsConnect();
    await initialize(ws);

    // The client (extension side) answers the daemon's MCP handshake frames
    // and collects the daemon's ack frames.
    const acks: Array<Record<string, unknown>> = [];
    const registered = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'mcp_message') {
          // Daemon → client MCP request: answer it.
          const reply = answerHandshakeFrame(
            msg as unknown as {
              id: string;
              server: string;
              payload: { id?: number | string; method?: string };
            },
          );
          if (reply) {
            ws.send(JSON.stringify({ type: 'mcp_message', ...reply }));
          }
        } else if (msg['type'] === 'mcp_registered') {
          acks.push(msg);
          resolve(msg);
        } else if (msg['type'] === 'mcp_error') {
          acks.push(msg);
          resolve(msg);
        }
      });
    });

    ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));

    const ack = await registered;
    // (a) daemon registered the runtime server, with the discovered catalog.
    expect(ack['type']).toBe('mcp_registered');
    expect(ack['server']).toBe('chrome-tools');
    expect(ack['toolCount']).toBe(1);

    // (b) the agent's MCP client can list + call the client-hosted tool — all
    // through the WS-carried mcp_message round-trip.
    const agent = provider.clients.get('chrome-tools')!;
    expect(provider.lastToolList?.tools.map((t) => t.name)).toContain(
      'chrome_read_page',
    );
    const result = await agent.callTool({
      name: 'chrome_read_page',
      arguments: { selector: '#main' },
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'page-text-from-browser' },
    ]);

    ws.close();
  });

  it('rejects mcp_register with not_wired when no provider is injected', async () => {
    await startServer({ clientMcpOverWs: true, withProvider: false });
    const ws = await wsConnect();
    await initialize(ws);

    const errReply = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'mcp_error' || msg['type'] === 'mcp_registered') {
          resolve(msg);
        }
      });
    });
    ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));
    const reply = await errReply;
    expect(reply['type']).toBe('mcp_error');
    expect(reply['code']).toBe('not_wired');
    ws.close();
  });

  it('ignores client-MCP frames when the feature is disabled', async () => {
    await startServer({ clientMcpOverWs: false });
    const ws = await wsConnect();
    await initialize(ws);

    // With the feature off, the frame is not a valid JSON-RPC envelope, so the
    // server replies with a JSON-RPC parse/validation error rather than an
    // mcp_* ack.
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
      ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));
    });
    expect(reply['type']).toBeUndefined();
    expect(reply['error']).toBeDefined();
    ws.close();
  });

  it('rejects mcp_register before initialize', async () => {
    await startServer({ clientMcpOverWs: true });
    const ws = await wsConnect();
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
      ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));
    });
    expect(reply['type']).toBe('mcp_error');
    expect(reply['code']).toBe('not_initialized');
    ws.close();
  });

  it('tears down the client-hosted server on WS close', async () => {
    await startServer({ clientMcpOverWs: true });
    const ws = await wsConnect();
    await initialize(ws);

    const registered = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'mcp_message') {
          const reply = answerHandshakeFrame(
            msg as unknown as {
              id: string;
              server: string;
              payload: { id?: number | string; method?: string };
            },
          );
          if (reply) ws.send(JSON.stringify({ type: 'mcp_message', ...reply }));
        } else if (msg['type'] === 'mcp_registered') {
          resolve();
        }
      });
    });
    ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));
    await registered;
    expect(provider.clients.has('chrome-tools')).toBe(true);

    ws.close();
    // Wait for the close handler to run the teardown.
    await vi.waitFor(() => {
      expect(provider.clients.has('chrome-tools')).toBe(false);
    });
  });

  it('binds a session-scoped registration and passes the scope through', async () => {
    await startServer({ clientMcpOverWs: true });
    const ws = await wsConnect();
    await initialize(ws);

    const registered = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'mcp_message') {
          const reply = answerHandshakeFrame(
            msg as unknown as {
              id: string;
              server: string;
              payload: { id?: number | string; method?: string };
            },
          );
          if (reply) ws.send(JSON.stringify({ type: 'mcp_message', ...reply }));
        } else if (
          msg['type'] === 'mcp_registered' ||
          msg['type'] === 'mcp_error'
        ) {
          resolve(msg);
        }
      });
    });
    ws.send(
      JSON.stringify({
        type: 'mcp_register',
        server: 'local-files',
        sessionId: 'session-1',
      }),
    );

    const ack = await registered;
    expect(ack['type']).toBe('mcp_registered');
    expect(provider.registerScopes.get('local-files')).toEqual({
      sessionId: 'session-1',
    });
    ws.close();
  });

  it('rejects a malformed sessionId without touching the provider', async () => {
    await startServer({ clientMcpOverWs: true });
    const ws = await wsConnect();
    await initialize(ws);

    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
      ws.send(
        JSON.stringify({
          type: 'mcp_register',
          server: 'local-files',
          sessionId: '',
        }),
      );
    });
    expect(reply['type']).toBe('mcp_error');
    expect(reply['code']).toBe('invalid_session_id');
    expect(provider.registerScopes.size).toBe(0);
    ws.close();
  });

  it('tears a session-scoped server down with the scope it was registered with', async () => {
    await startServer({ clientMcpOverWs: true });
    const ws = await wsConnect();
    await initialize(ws);

    const registered = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'mcp_message') {
          const reply = answerHandshakeFrame(
            msg as unknown as {
              id: string;
              server: string;
              payload: { id?: number | string; method?: string };
            },
          );
          if (reply) ws.send(JSON.stringify({ type: 'mcp_message', ...reply }));
        } else if (msg['type'] === 'mcp_registered') {
          resolve();
        }
      });
    });
    ws.send(
      JSON.stringify({
        type: 'mcp_register',
        server: 'local-files',
        sessionId: 'session-1',
      }),
    );
    await registered;

    ws.close();
    // The dispose path must carry the remembered scope: removing a
    // session-scoped server without its session id would miss the session's
    // copy and leave the child holding a dead transport.
    await vi.waitFor(() => {
      expect(provider.unregisterScopes.get('local-files')).toEqual({
        sessionId: 'session-1',
      });
    });
  });
});

describe('client_mcp_over_ws connection-level register rollback', () => {
  function makeConnection(provider: ClientMcpServerProvider) {
    const frames: Array<Record<string, unknown>> = [];
    const conn = new ClientMcpWsConnection(
      ((frame: unknown) => {
        frames.push(frame as Record<string, unknown>);
      }) as never,
      provider,
    );
    return { conn, frames };
  }

  function controllableProvider() {
    let addCalls = 0;
    let failFirst: ((err: Error) => void) | undefined;
    let resolveFirst: ((value: { toolCount: number }) => void) | undefined;
    const unregisterCalls: Array<[string, ClientMcpServerScope | undefined]> =
      [];
    const provider: ClientMcpServerProvider = {
      registerClientMcpServer: async (_name, _send, _scope) => {
        addCalls += 1;
        if (addCalls === 1) {
          return new Promise<{ toolCount: number }>((resolve, reject) => {
            failFirst = reject;
            resolveFirst = resolve;
          });
        }
        return { toolCount: 1 };
      },
      unregisterClientMcpServer: async (name, scope) => {
        unregisterCalls.push([name, scope]);
      },
    };
    return {
      provider,
      unregisterCalls,
      failFirstAdd: () => failFirst!(new Error('late failure')),
      resolveFirstAdd: () => resolveFirst!({ toolCount: 1 }),
    };
  }

  it('a stale late-failing register cannot undo a newer register', async () => {
    const { provider, unregisterCalls, failFirstAdd } = controllableProvider();
    const { conn } = makeConnection(provider);

    const first = conn.handleFrame({
      type: 'mcp_register',
      server: 'lf',
      sessionId: 'S',
    });
    await Promise.resolve();
    // Reconnect shape: unregister, then register again while add #1 is still
    // in flight.
    await conn.handleFrame({ type: 'mcp_unregister', server: 'lf' });
    const second = await conn.handleFrame({
      type: 'mcp_register',
      server: 'lf',
      sessionId: 'S',
    });
    expect(second).toMatchObject({ kind: 'registered' });

    // The stale attempt finally fails: its rollback must not touch the
    // survivor's registrar advertisement or scope entry. The only provider
    // teardown so far is the explicit unregister frame above.
    failFirstAdd();
    expect(await first).toMatchObject({
      kind: 'error',
      code: 'register_failed',
    });
    expect(conn.registeredServers()).toContain('lf');
    expect(unregisterCalls).toEqual([['lf', { sessionId: 'S' }]]);
  });

  it('reports closed when dispose lands while the add is in flight', async () => {
    const { provider, unregisterCalls, resolveFirstAdd } =
      controllableProvider();
    const { conn } = makeConnection(provider);
    const first = conn.handleFrame({
      type: 'mcp_register',
      server: 'lf',
      sessionId: 'S',
    });
    await Promise.resolve();
    await conn.dispose();
    resolveFirstAdd();
    expect(await first).toMatchObject({ kind: 'error', code: 'closed' });
    // dispose's teardown plus the disposed-branch rollback both reach the
    // provider with the session scope.
    expect(unregisterCalls).toEqual([
      ['lf', { sessionId: 'S' }],
      ['lf', { sessionId: 'S' }],
    ]);
  });

  it('unregister tears down with the scope the register used', async () => {
    const unregisterCalls: Array<[string, ClientMcpServerScope | undefined]> =
      [];
    const provider: ClientMcpServerProvider = {
      registerClientMcpServer: async () => ({ toolCount: 1 }),
      unregisterClientMcpServer: async (name, scope) => {
        unregisterCalls.push([name, scope]);
      },
    };
    const { conn } = makeConnection(provider);
    await conn.handleFrame({
      type: 'mcp_register',
      server: 'lf',
      sessionId: 'S',
    });
    await conn.handleFrame({ type: 'mcp_unregister', server: 'lf' });
    expect(unregisterCalls).toEqual([['lf', { sessionId: 'S' }]]);
    expect(conn.registeredServers()).toEqual([]);
  });
});

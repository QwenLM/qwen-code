/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectToMcpServer } from './connector/connectMcpServer.js';
import { HttpMcpConnector } from './connector/httpConnector.js';
import { SdkHostedMcpConnector } from './connector/sdkHostedConnector.js';
import { createSdkMcpServerConfig } from './mcpServerConfig.js';
import { discoverTools } from './tools/mcp-tool.js';
import { McpClientContext } from './mcpClientContext.js';

const closePeers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closePeers.splice(0).reverse()) await close();
});

const definitions = [
  {
    name: 'answer',
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: { answer: true, forbidden: false },
    },
  },
  { name: 'healthy', inputSchema: { type: 'object' } },
];

function context(diagnostics = vi.fn()): {
  ctx: McpClientContext;
  diagnostics: ReturnType<typeof vi.fn>;
} {
  const ctx = new McpClientContext({
    sanitizationConfig: {
      enableEnvironmentVariableRedaction: true,
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
    },
    isTrustedFolder: () => true,
    emitDiagnostic: diagnostics,
  });
  return { ctx, diagnostics };
}

function protocolPeer() {
  const state = {
    tools: definitions as unknown[],
    output: { answer: 'schema-compatible' } as Record<string, unknown>,
  };
  const reply = async (message: JSONRPCMessage): Promise<JSONRPCMessage> => {
    if (!('method' in message) || !('id' in message)) {
      return {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'debug', data: 'initialized' },
      };
    }
    let result: Record<string, unknown> = {};
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'boolean-schema-peer', version: '1' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: state.tools };
    } else if (message.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: 'schema-compatible' }],
        structuredContent: state.output,
      };
    }
    return { jsonrpc: '2.0', id: message.id, result };
  };
  return { state, reply };
}

async function verifyCalls(
  client: Client,
  state: ReturnType<typeof protocolPeer>['state'],
) {
  await expect(
    client.callTool({ name: 'answer', arguments: { input: 'test' } }),
  ).resolves.toMatchObject({
    structuredContent: { answer: 'schema-compatible' },
  });
  state.output = { answer: 'ok', forbidden: 'must reject' };
  await expect(
    client.callTool({ name: 'answer', arguments: {} }),
  ).rejects.toThrow('Structured content does not match');
}

describe('MCP schema compatibility entry points', () => {
  it('discovers and validates tools through the ordinary HTTP MCP connection', async () => {
    const { state, reply } = protocolPeer();
    const http = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as JSONRPCMessage;
      if (!('id' in message)) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(await reply(message)));
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    closePeers.push(async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = http.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP address');
    const config = { httpUrl: `http://127.0.0.1:${address.port}/mcp` };
    const { ctx, diagnostics } = context();
    const client = await connectToMcpServer({
      clientVersion: 'test',
      serverName: 'schema-http',
      serverConfig: config,
      debugMode: false,
      cliConfig: ctx,
      connector: new HttpMcpConnector(),
    });
    closePeers.push(() => client.close());
    const tools = await discoverTools(
      'schema-http',
      config,
      client,
      {
        callMcpTool: (params, options) =>
          client.callTool(params, undefined, options),
      },
      ctx,
    );
    expect(tools.map((tool) => tool.serverToolName)).toEqual([
      'answer',
      'healthy',
    ]);
    expect(diagnostics).not.toHaveBeenCalled();
    await verifyCalls(client, state);
  });

  it('bounds a transport handshake that never completes', async () => {
    // A server that accepts the SSE request but never sends the `endpoint`
    // event parks the SDK inside transport.start(). The connect timeout must
    // bound that wait instead of leaving it to the underlying fetch timeout.
    const http = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    closePeers.push(async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = http.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP address');
    const { ctx } = context();
    const startedAt = Date.now();

    await expect(
      connectToMcpServer({
        clientVersion: 'test',
        serverName: 'silent-sse',
        serverConfig: {
          type: 'sse',
          url: `http://127.0.0.1:${address.port}/sse`,
        },
        debugMode: false,
        cliConfig: ctx,
        connector: new HttpMcpConnector(),
        timeoutMs: 200,
      }),
    ).rejects.toThrow('did not finish connecting within 200ms');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('discovers and validates tools through the SDK-hosted control bridge', async () => {
    const { state, reply } = protocolPeer();
    const { ctx, diagnostics } = context();
    const send = vi.fn(async (_name: string, message: JSONRPCMessage) =>
      reply(message),
    );
    const config = createSdkMcpServerConfig();
    const client = await connectToMcpServer({
      clientVersion: 'test',
      serverName: 'schema-sdk',
      serverConfig: config,
      debugMode: false,
      cliConfig: ctx,
      connector: new SdkHostedMcpConnector(send),
    });
    closePeers.push(() => client.close());
    const tools = await discoverTools(
      'schema-sdk',
      config,
      client,
      {
        callMcpTool: (params, options) =>
          client.callTool(params, undefined, options),
      },
      ctx,
    );
    expect(tools.map((tool) => tool.serverToolName)).toEqual([
      'answer',
      'healthy',
    ]);
    expect(diagnostics).not.toHaveBeenCalled();
    await verifyCalls(client, state);
    expect(send).toHaveBeenCalledWith(
      'schema-sdk',
      expect.objectContaining({ method: 'tools/list' }),
    );
  });
});

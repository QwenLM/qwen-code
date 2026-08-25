/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { Config, MCPServerConfig } from '../config/config.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  getMcpAppResourceUri,
  isMcpToolVisibleToModel,
  connectToMcpServer,
  createMcpClient,
  discoverTools,
  invokeMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  MCP_DEFAULT_TIMEOUT_MSEC,
  MCP_VERSION_NEGOTIATION_FALLBACK_HEADROOM_MS,
  MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS,
  mcpVersionNegotiationFor,
} from './mcp-client.js';
import {
  discoveryTimeoutFor,
  runWithTimeout,
} from './mcp-discovery-timeout.js';
import {
  SdkControlClientTransport,
  type SendMcpMessageCallback,
} from './sdk-control-client-transport.js';

type RequestMessage = JSONRPCRequest;

function response(
  request: RequestMessage,
  result: Record<string, unknown>,
): JSONRPCMessage {
  return { jsonrpc: '2.0', id: request.id, result } as JSONRPCMessage;
}

function workspaceContext(): WorkspaceContext {
  return {
    getDirectories: vi.fn().mockReturnValue([]),
    onDirectoriesChanged: vi.fn().mockReturnValue(vi.fn()),
  } as unknown as WorkspaceContext;
}

async function connectNegotiatingControl(
  serverName: string,
  sendMcpMessage: SendMcpMessageCallback,
) {
  const client = createMcpClient('qwen-code-mcp-client', {
    command: 'test-control',
    versionNegotiation: 'auto',
  } as MCPServerConfig);
  await client.connect(
    new SdkControlClientTransport({ serverName, sendMcpMessage }),
  );
  return client;
}

describe('configured MCP SDK v2 negotiation', () => {
  it('bounds the auto-negotiation probe below the inherited request timeout', () => {
    expect(MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS).toBeLessThan(
      MCP_DEFAULT_TIMEOUT_MSEC,
    );
  });

  it('keeps defaults, non-stdio, and explicit legacy configs on legacy', () => {
    expect(
      mcpVersionNegotiationFor({
        httpUrl: 'https://example.com/mcp',
      } as MCPServerConfig),
    ).toEqual({ mode: 'legacy' });
    expect(
      mcpVersionNegotiationFor({ type: 'sdk' } as MCPServerConfig),
    ).toEqual({ mode: 'legacy' });
    expect(
      mcpVersionNegotiationFor({
        command: 'node',
        versionNegotiation: 'legacy',
      } as MCPServerConfig),
    ).toEqual({ mode: 'legacy' });
    expect(
      mcpVersionNegotiationFor({ command: 'node' } as MCPServerConfig),
    ).toEqual({ mode: 'legacy' });
    expect(
      mcpVersionNegotiationFor({
        command: 'node',
        versionNegotiation: 'auto',
      } as MCPServerConfig),
    ).toEqual({
      mode: 'auto',
      probe: { timeoutMs: MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS },
    });
    expect(
      mcpVersionNegotiationFor({
        command: 'node',
        versionNegotiation: 'auto',
        discoveryTimeoutMs: 2_000,
      } as MCPServerConfig),
    ).toEqual({ mode: 'legacy' });
    expect(
      mcpVersionNegotiationFor({
        command: 'node',
        versionNegotiation: 'auto',
        discoveryTimeoutMs: 8_000,
      } as MCPServerConfig),
    ).toEqual({
      mode: 'auto',
      probe: {
        timeoutMs: 8_000 - MCP_VERSION_NEGOTIATION_FALLBACK_HEADROOM_MS,
      },
    });
  });

  it('preserves the default discovery budget for legacy initialization', async () => {
    const config = {
      command: process.execPath,
      args: [
        '--input-type=module',
        '--eval',
        `
          import readline from 'node:readline';
          const lines = readline.createInterface({ input: process.stdin });
          lines.on('line', (line) => {
            const request = JSON.parse(line);
            if (request.method !== 'initialize') return;
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  protocolVersion: '2025-06-18',
                  capabilities: {},
                  serverInfo: { name: 'slow-legacy', version: '1.0.0' },
                },
              }) + '\\n');
            }, 5100);
          });
        `,
      ],
      discoveryTimeoutMs: 8_000,
    } as MCPServerConfig;

    const client = await runWithTimeout(
      connectToMcpServer('slow-legacy', config, false, workspaceContext()),
      discoveryTimeoutFor(config),
      'slow legacy negotiation',
    );

    try {
      expect(client.getProtocolEra()).toBe('legacy');
    } finally {
      await client.close();
    }
  });

  it('connects to a modern-only server and reuses cache-hinted tool lists', async () => {
    const requests: RequestMessage[] = [];
    const send = vi.fn(async (_serverName: string, message: JSONRPCMessage) => {
      const request = message as RequestMessage;
      requests.push(request);

      switch (request.method) {
        case 'server/discover':
          return response(request, {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {}, prompts: {}, resources: {} },
            ttlMs: 60_000,
            cacheScope: 'private',
          });
        case 'tools/list':
          return response(request, {
            resultType: 'complete',
            tools: [
              {
                name: 'echo',
                description: 'Echo input',
                inputSchema: { type: 'object' },
                _meta: { ui: { resourceUri: 'ui://demo/dashboard' } },
              },
            ],
            ttlMs: 60_000,
            cacheScope: 'private',
          });
        case 'tools/call':
          return response(request, {
            resultType: 'complete',
            content: [{ type: 'text', text: 'ok' }],
          });
        case 'prompts/list':
          return response(request, {
            resultType: 'complete',
            prompts: [{ name: 'modern-prompt' }],
            ttlMs: 60_000,
            cacheScope: 'private',
          });
        case 'prompts/get':
          return response(request, {
            resultType: 'complete',
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: 'modern-prompt-result' },
              },
            ],
          });
        case 'resources/list':
          return response(request, {
            resultType: 'complete',
            resources: [{ uri: 'file:///modern.txt', name: 'modern.txt' }],
            ttlMs: 60_000,
            cacheScope: 'private',
          });
        default:
          throw new Error(`Unexpected modern MCP method: ${request.method}`);
      }
    });

    const client = await connectNegotiatingControl('modern-only', send);

    try {
      expect(client.getProtocolEra()).toBe('modern');
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'echo' }],
      });
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'echo' }],
      });
      const [discoveredTool] = await discoverTools(
        'modern-only',
        { type: 'sdk' } as MCPServerConfig,
        client,
        {} as Config,
        { applyConfigFilters: false },
      );
      expect(discoveredTool?.appResourceUri).toBe('ui://demo/dashboard');
      await expect(
        client.callTool({ name: 'echo', arguments: { text: 'hello' } }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'ok' }],
      });
      await expect(listMcpPrompts('modern-only', client)).resolves.toHaveLength(
        1,
      );
      await expect(listMcpPrompts('modern-only', client)).resolves.toHaveLength(
        1,
      );
      await expect(
        invokeMcpPrompt('modern-only', client, 'modern-prompt', {}),
      ).resolves.toMatchObject({
        messages: [{ content: { text: 'modern-prompt-result' } }],
      });
      await expect(
        listMcpResources('modern-only', client),
      ).resolves.toHaveLength(1);
      await expect(
        listMcpResources('modern-only', client),
      ).resolves.toHaveLength(1);

      expect(requests.map((request) => request.method)).toEqual([
        'server/discover',
        'tools/list',
        'tools/call',
        'prompts/list',
        'prompts/get',
        'resources/list',
      ]);
      expect(requests.some((request) => request.method === 'initialize')).toBe(
        false,
      );
      for (const request of requests) {
        expect(request.params?._meta).toMatchObject({
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: expect.objectContaining({
            name: 'qwen-code-mcp-client',
          }),
          [CLIENT_CAPABILITIES_META_KEY]: expect.any(Object),
        });
      }
      expect(
        requests[0]?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY],
      ).toMatchObject({
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  it('lists every page of a modern tools/list instead of dropping the catalog', async () => {
    const pageCount = 65;
    const send = vi.fn(async (_serverName: string, message: JSONRPCMessage) => {
      const request = message as RequestMessage;
      switch (request.method) {
        case 'server/discover':
          return response(request, {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
          });
        case 'tools/list': {
          const cursor = Number(
            (request.params as { cursor?: string } | undefined)?.cursor ?? '0',
          );
          return response(request, {
            resultType: 'complete',
            tools: [
              {
                name: `tool-${cursor}`,
                inputSchema: { type: 'object' },
              },
            ],
            ttlMs: 60_000,
            cacheScope: 'private',
            ...(cursor + 1 < pageCount
              ? { nextCursor: String(cursor + 1) }
              : {}),
          });
        }
        default:
          throw new Error(`Unexpected modern MCP method: ${request.method}`);
      }
    });

    const client = await connectNegotiatingControl('paged', send);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        Array.from({ length: pageCount }, (_, index) => `tool-${index}`),
      );
      const tools = await discoverTools(
        'paged',
        { type: 'sdk' } as MCPServerConfig,
        client,
        {} as Config,
        { applyConfigFilters: false },
      );
      expect(tools.map((tool) => tool.serverToolName)).toEqual(
        Array.from({ length: pageCount }, (_, index) => `tool-${index}`),
      );
    } finally {
      await client.close();
    }
  });

  it('connects remote HTTP with the legacy initialize handshake', async () => {
    const http = await import('node:http');
    const methods: string[] = [];
    const server = http.createServer((request, responseStream) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        if (!body) {
          responseStream.writeHead(405);
          responseStream.end();
          return;
        }
        const message = JSON.parse(body) as JSONRPCMessage;
        if (!('method' in message) || typeof message.method !== 'string') {
          responseStream.writeHead(400);
          responseStream.end();
          return;
        }
        methods.push(message.method);
        if (message.method === 'server/discover') {
          responseStream.writeHead(500);
          responseStream.end();
          return;
        }
        if (!('id' in message)) {
          responseStream.writeHead(202);
          responseStream.end();
          return;
        }

        let result: Record<string, unknown>;
        switch (message.method) {
          case 'initialize':
            result = {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'http-legacy', version: '1.0.0' },
            };
            break;
          case 'tools/list':
            result = {
              tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
            };
            break;
          case 'tools/call':
            result = {
              content: [{ type: 'text', text: 'ok' }],
            };
            break;
          default:
            responseStream.writeHead(500);
            responseStream.end();
            return;
        }

        responseStream.writeHead(200, { 'Content-Type': 'application/json' });
        responseStream.end(
          JSON.stringify(response(message as RequestMessage, result)),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port');
    }

    let client: Awaited<ReturnType<typeof connectToMcpServer>> | undefined;
    try {
      client = await connectToMcpServer(
        'remote-http',
        {
          httpUrl: `http://127.0.0.1:${address.port}/mcp`,
        } as MCPServerConfig,
        false,
        workspaceContext(),
      );
      expect(client.getProtocolEra()).toBe('legacy');
      await client.listTools();
      await client.callTool({ name: 'echo' });
      expect(methods).not.toContain('server/discover');
      expect(methods[0]).toBe('initialize');
      expect(methods).toEqual(
        expect.arrayContaining(['initialize', 'tools/list', 'tools/call']),
      );
    } finally {
      await client?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('falls back to the legacy initialize flow', async () => {
    const requests: RequestMessage[] = [];
    const send = vi.fn(async (_serverName: string, message: JSONRPCMessage) => {
      if (!('id' in message)) {
        return {
          jsonrpc: '2.0',
          id: 0,
          result: {},
        } as JSONRPCMessage;
      }

      const request = message as RequestMessage;
      requests.push(request);
      switch (request.method) {
        case 'server/discover':
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          } as JSONRPCMessage;
        case 'initialize':
          return response(request, {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'legacy-server', version: '1.0.0' },
          });
        case 'tools/list':
          return response(request, {
            tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          });
        case 'tools/call':
          return response(request, {
            content: [{ type: 'text', text: 'legacy-ok' }],
          });
        case 'prompts/list':
          return response(request, {
            prompts: [{ name: 'legacy-prompt' }],
          });
        case 'prompts/get':
          return response(request, {
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: 'legacy-prompt-result' },
              },
            ],
          });
        case 'resources/list':
          return response(request, {
            resources: [{ uri: 'file:///legacy.txt', name: 'legacy.txt' }],
          });
        default:
          throw new Error(`Unexpected legacy MCP method: ${request.method}`);
      }
    });

    const client = await connectNegotiatingControl('legacy', send);

    try {
      expect(client.getProtocolEra()).toBe('legacy');
      await expect(client.listTools()).resolves.toEqual({ tools: [] });
      const tools = await discoverTools(
        'legacy',
        { type: 'sdk' } as MCPServerConfig,
        client,
        {} as Config,
        { applyConfigFilters: false },
      );
      expect(tools.map((tool) => tool.serverToolName)).toEqual(['echo']);
      await expect(client.callTool({ name: 'echo' })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'legacy-ok' }],
      });
      await expect(listMcpPrompts('legacy', client)).resolves.toMatchObject([
        { name: 'legacy-prompt', serverName: 'legacy' },
      ]);
      await expect(
        invokeMcpPrompt('legacy', client, 'legacy-prompt', {}),
      ).resolves.toMatchObject({
        messages: [{ content: { text: 'legacy-prompt-result' } }],
      });
      await expect(listMcpResources('legacy', client)).resolves.toMatchObject([
        { uri: 'file:///legacy.txt', serverName: 'legacy' },
      ]);
      expect(requests.map((request) => request.method)).toEqual([
        'server/discover',
        'initialize',
        'tools/list',
        'tools/call',
        'prompts/list',
        'prompts/get',
        'resources/list',
      ]);
      expect(
        requests.find((request) => request.method === 'tools/list')?.params
          ?._meta,
      ).toBeUndefined();
      expect(
        requests.find((request) => request.method === 'initialize')?.params?.[
          'capabilities'
        ],
      ).toMatchObject({
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  it('connects SDK control-plane servers without probing them', async () => {
    const methods: string[] = [];
    const send = vi.fn(async (_serverName: string, message: JSONRPCMessage) => {
      if (!('method' in message)) {
        throw new Error('Unexpected MCP response');
      }
      methods.push(message.method);
      if (!('id' in message)) {
        return { jsonrpc: '2.0', id: 0, result: {} } as JSONRPCMessage;
      }
      if (message.method !== 'initialize') {
        throw new Error(`Unexpected SDK MCP method: ${message.method}`);
      }
      return response(message, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'sdk-legacy', version: '1.0.0' },
      });
    });

    const client = await connectToMcpServer(
      'sdk-legacy',
      { type: 'sdk' } as MCPServerConfig,
      false,
      workspaceContext(),
      send,
    );

    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(methods).toEqual(['initialize', 'notifications/initialized']);
    } finally {
      await client.close();
    }
  });

  it('accepts nested and legacy MCP Apps tool metadata', () => {
    expect(
      getMcpAppResourceUri({
        _meta: { ui: { resourceUri: 'ui://demo/dashboard' } },
      }),
    ).toBe('ui://demo/dashboard');
    expect(
      getMcpAppResourceUri({
        _meta: { 'ui/resourceUri': 'ui://demo/legacy' },
      }),
    ).toBe('ui://demo/legacy');
    expect(
      getMcpAppResourceUri({
        _meta: { ui: { resourceUri: 'https://example.com/app' } },
      }),
    ).toBeUndefined();
  });

  it('hides MCP App tools whose visibility does not include model', () => {
    expect(isMcpToolVisibleToModel({})).toBe(true);
    expect(
      isMcpToolVisibleToModel({
        _meta: { ui: { resourceUri: 'ui://demo/dashboard' } },
      }),
    ).toBe(true);
    expect(
      isMcpToolVisibleToModel({
        _meta: { ui: { visibility: ['model', 'app'] } },
      }),
    ).toBe(true);
    expect(
      isMcpToolVisibleToModel({
        _meta: { ui: { visibility: ['app'] } },
      }),
    ).toBe(false);
    expect(
      isMcpToolVisibleToModel({
        _meta: { ui: { visibility: null } },
      }),
    ).toBe(true);
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpClientContext } from '../mcpClientContext.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { McpConnector } from '../connector/types.js';
import { mcpServerKey } from '../server-key.js';
import { discoverPrompts } from './mcp-prompt.js';
import { discoverResources } from './mcp-resource.js';

const mocks = vi.hoisted(() => ({ connectToMcpServer: vi.fn() }));

vi.mock('../connector/connectMcpServer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, connectToMcpServer: mocks.connectToMcpServer };
});

const { McpClient } = await import('../client/mcpClient.js');

const endpointError = Object.assign(
  new Error('MCP error 0: Invalid endpoint: oss-cn-shenzhen.aliyuncs.com'),
  { code: 0 },
);

function createContext(): McpClientContext {
  return {
    sanitizationConfig: {
      enableEnvironmentVariableRedaction: false,
      allowedEnvironmentVariables: [],
      blockedEnvironmentVariables: [],
    },
    emitMcpDiagnostic: vi.fn(),
    isTrustedFolder: () => true,
  } as unknown as McpClientContext;
}

function createSdkClient(overrides: {
  listPrompts?: () => Promise<unknown>;
  request?: () => Promise<unknown>;
}): Client {
  return {
    getServerCapabilities: () => ({ tools: {}, prompts: {}, resources: {} }),
    setNotificationHandler: vi.fn(),
    getInstructions: () => undefined,
    listTools: vi.fn(async () => ({
      tools: [
        {
          name: 'list_buckets',
          description: 'List buckets',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })),
    listPrompts: overrides.listPrompts ?? vi.fn(async () => ({ prompts: [] })),
    request: overrides.request ?? vi.fn(async () => ({ resources: [] })),
    close: vi.fn(async () => {}),
    onclose: undefined,
    onerror: undefined,
  } as unknown as Client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MCP discovery failure isolation', () => {
  it('reports a resources/list failure and returns no resources', async () => {
    const context = createContext();
    const client = createSdkClient({
      request: vi.fn(async () => {
        throw endpointError;
      }),
    });

    await expect(discoverResources('ocs', client, context)).resolves.toEqual([]);
    expect(context.emitMcpDiagnostic).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Error discovering resources from ocs'),
      endpointError,
      'ocs',
    );
  });

  it('reports a prompts/list failure and returns no prompts', async () => {
    const context = createContext();
    const client = createSdkClient({
      listPrompts: vi.fn(async () => {
        throw endpointError;
      }),
    });

    await expect(discoverPrompts('ocs', client, context)).resolves.toEqual([]);
    expect(context.emitMcpDiagnostic).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Error discovering prompts from ocs'),
      endpointError,
      'ocs',
    );
  });

  it.each([
    [
      'resources/list',
      {
        request: async () => {
          throw endpointError;
        },
      },
    ],
    [
      'prompts/list',
      {
        listPrompts: async () => {
          throw endpointError;
        },
      },
    ],
  ])('keeps discovered tools when %s fails', async (_method, overrides) => {
    mocks.connectToMcpServer.mockResolvedValue(createSdkClient(overrides));
    const client = new McpClient({
      serverKey: mcpServerKey('sdk', 'ocs'),
      serverName: 'ocs',
      serverConfig: { command: 'uvx', args: ['ocs-mcp'] } as MCPServerConfig,
      clientVersion: '1.0.0',
      debugMode: false,
      hostContext: createContext(),
      listener: () => {},
    });
    const connector: McpConnector = {
      connect: vi.fn(async () => ({ transport: {} as never })),
    };
    await client.connect(connector);

    await expect(client.discover()).resolves.toBeUndefined();
    expect(
      client.getDiscoveredTools().map((tool) => tool.serverToolName),
    ).toEqual(['list_buckets']);
  });
});

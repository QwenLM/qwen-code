/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpClientContext } from '../mcpClientContext.js';
import type { McpElicitationHandler } from '../elicitation.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { McpConnector } from '../connector/types.js';
import { mcpServerKey } from '../server-key.js';
import { McpClient } from './mcpClient.js';
import { mcpServerRequiresOAuth } from '../oauthState.js';
import type { McpClientEvent } from './types.js';

const mocks = vi.hoisted(() => ({
  connectToMcpServer: vi.fn(),
  discoverTools: vi.fn(),
  discoverPrompts: vi.fn(),
  discoverResources: vi.fn(),
  invokeMcpPrompt: vi.fn(),
}));

vi.mock('../connector/connectMcpServer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    connectToMcpServer: mocks.connectToMcpServer,
  };
});

vi.mock('../tools/mcp-tool.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverTools: mocks.discoverTools };
});

vi.mock('../tools/mcp-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    discoverPrompts: mocks.discoverPrompts,
    invokeMcpPrompt: mocks.invokeMcpPrompt,
  };
});

vi.mock('../tools/mcp-resource.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverResources: mocks.discoverResources };
});

// Imported after the mock so MCPServerStatus is the real enum (spread above).
const { MCPServerStatus } = await import('./mcpClient.js');

interface FakeClient {
  client: Client;
  handlers: Map<unknown, (n: unknown) => Promise<void>>;
  callTool: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  notification: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createFakeClient(
  capabilities: Record<string, unknown> = {
    tools: {},
    prompts: {},
    resources: {},
  },
): FakeClient {
  const handlers = new Map<unknown, (n: unknown) => Promise<void>>();
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const request = vi.fn(async () => ({ contents: [{ uri: 'u', text: 'body' }] }));
  const notification = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const client = {
    getServerCapabilities: () => capabilities,
    setNotificationHandler: (schema: unknown, handler: (n: unknown) => Promise<void>) => {
      handlers.set(schema, handler);
    },
    getInstructions: () => 'server-instructions',
    callTool,
    request,
    notification,
    close,
    onclose: undefined,
    onerror: undefined,
  } as unknown as Client;
  return { client, handlers, callTool, request, notification, close };
}

const serverConfig = { command: 'node', args: ['server.js'] } as MCPServerConfig;

function createHostContext(): McpClientContext {
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

const connector: McpConnector = {
  connect: vi.fn(async () => ({ transport: {} as never })),
};

function createClient(overrides: {
  listener?: (e: McpClientEvent) => void | Promise<void>;
  callMetadataProvider?: (c: McpClient) => Record<string, unknown> | undefined;
  elicitationHandler?: McpElicitationHandler;
  serverConfig?: MCPServerConfig;
} = {}) {
  const events: McpClientEvent[] = [];
  const listener =
    overrides.listener ??
    ((e: McpClientEvent) => {
      events.push(e);
    });
  const client = new McpClient({
    serverKey: mcpServerKey('sdk', 'test-server'),
    serverName: 'test-server',
    serverConfig: overrides.serverConfig ?? serverConfig,
    clientVersion: '1.0.0',
    debugMode: false,
    hostContext: createHostContext(),
    listener,
    elicitationHandler: overrides.elicitationHandler,
    callMetadataProvider: overrides.callMetadataProvider,
  });
  return { client, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.discoverTools.mockResolvedValue([]);
  mocks.discoverPrompts.mockResolvedValue([]);
  mocks.discoverResources.mockResolvedValue([]);
});

describe('McpClient connect lifecycle', () => {
  it('shares one in-flight connect across concurrent callers', async () => {
    const fake = createFakeClient();
    let release!: () => void;
    mocks.connectToMcpServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(fake.client);
        }),
    );
    const { client } = createClient();

    const first = client.connect(connector);
    const second = client.connect(connector);
    await vi.waitFor(() =>
      expect(mocks.connectToMcpServer).toHaveBeenCalledOnce(),
    );
    release();
    await Promise.all([first, second]);

    expect(mocks.connectToMcpServer).toHaveBeenCalledOnce();
    expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);
  });

  it('parks in AUTH_REQUIRED when an auth attempt fails without a typed error', async () => {
    mocks.connectToMcpServer.mockRejectedValueOnce(
      new Error('Failed to handle automatic OAuth'),
    );
    mcpServerRequiresOAuth.set('test-server', true);
    const { client } = createClient();

    await client.connect(connector);

    expect(client.getStatus()).toBe(MCPServerStatus.AUTH_REQUIRED);
    mcpServerRequiresOAuth.delete('test-server');
  });

  it('connects through the supplied connector and reports status transitions', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client, events } = createClient();

    await client.connect(connector);

    expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);
    expect(client.isConnected()).toBe(true);
    expect(mocks.connectToMcpServer).toHaveBeenCalledOnce();
    const options = mocks.connectToMcpServer.mock.calls[0][0];
    expect(options.connector).toBe(connector);
    expect(events.map((e) => e.type)).toContain('status');
    expect(events.some((e) => e.type === 'status' && e.status === MCPServerStatus.CONNECTING)).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.status === MCPServerStatus.CONNECTED)).toBe(true);
  });

  it('lets the connector contribute handshake extensions', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const extendedConnector: McpConnector = {
      ...connector,
      clientExtensions: () => ['ext-a'],
    };
    const { client } = createClient();

    await client.connect(extendedConnector);

    const options = mocks.connectToMcpServer.mock.calls[0][0];
    expect(
      options.connector.clientExtensions?.({
        serverName: 'test-server',
        config: serverConfig,
      }),
    ).toEqual(['ext-a']);
  });

  it('passes the session elicitation handler through to the connection', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client: withoutHandler } = createClient();
    await withoutHandler.connect(connector);
    expect(
      mocks.connectToMcpServer.mock.calls[0][0].elicitationHandler,
    ).toBeUndefined();

    vi.clearAllMocks();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const handler: McpElicitationHandler = {
      request: async () => ({ action: 'cancel' }),
    };
    const { client: withHandler } = createClient({
      elicitationHandler: handler,
    });
    await withHandler.connect(connector);
    expect(mocks.connectToMcpServer.mock.calls[0][0].elicitationHandler).toBe(
      handler,
    );
  });

  it('refuses to connect twice', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);

    await expect(client.connect(connector)).rejects.toThrow(/disconnected/);
  });

  it('returns to DISCONNECTED and clears the client when connect fails', async () => {
    mocks.connectToMcpServer.mockRejectedValue(new Error('handshake failed'));
    const { client, events } = createClient();

    await expect(client.connect(connector)).rejects.toThrow('handshake failed');
    expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
    expect(events.some((e) => e.type === 'status' && e.status === MCPServerStatus.DISCONNECTED && e.reason === 'connect_failed')).toBe(true);
  });

  it('disconnect closes the client and marks an intentional disconnect', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);

    await client.disconnect();

    expect(fake.close).toHaveBeenCalledOnce();
    expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
    expect(client.isConnected()).toBe(false);
  });

  it('drops to DISCONNECTED when the transport closes underneath it', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client, events } = createClient();
    await client.connect(connector);

    // The client wrapped onclose; fire it as the SDK would on a socket drop.
    (fake.client as unknown as { onclose?: () => void }).onclose?.();

    expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
    expect(events.some((e) => e.type === 'status' && e.status === MCPServerStatus.DISCONNECTED && e.reason === 'network')).toBe(true);
  });

  it('coalesces concurrent network recovery and refreshes the catalog once', async () => {
    const initial = createFakeClient();
    const recovered = createFakeClient();
    let resolveRecovery: ((client: Client) => void) | undefined;
    const recovery = new Promise<Client>((resolve) => {
      resolveRecovery = resolve;
    });
    mocks.connectToMcpServer
      .mockResolvedValueOnce(initial.client)
      .mockReturnValueOnce(recovery);
    const { client } = createClient({
      serverConfig: { type: 'http', url: 'https://example.test/mcp' },
    });
    await client.connect(connector);
    (initial.client as unknown as { onclose?: () => void }).onclose?.();

    const first = client.ensureConnected();
    const second = client.ensureConnected();
    resolveRecovery?.(recovered.client);
    await Promise.all([first, second]);

    expect(mocks.connectToMcpServer).toHaveBeenCalledTimes(2);
    expect(mocks.discoverTools).toHaveBeenCalledOnce();
    expect(mocks.discoverPrompts).toHaveBeenCalledOnce();
    expect(mocks.discoverResources).toHaveBeenCalledOnce();
  });

  it('does not lazily recover a dropped stdio connection', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);
    (fake.client as unknown as { onclose?: () => void }).onclose?.();

    await expect(client.ensureConnected()).rejects.toThrow(/not connected/);
  });
});

describe('McpClient discovery and cache', () => {
  it('discover() populates and caches all three catalogs', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const tool = { name: 'mcp__test-server__t' } as never;
    const prompt = { name: 'p', originalName: 'p', serverName: 'test-server' } as never;
    const resource = { uri: 'r://x' } as never;
    mocks.discoverTools.mockResolvedValue([tool]);
    mocks.discoverPrompts.mockResolvedValue([prompt]);
    mocks.discoverResources.mockResolvedValue([resource]);
    const { client } = createClient();
    await client.connect(connector);

    await client.discover();

    expect(client.getDiscoveredTools()).toEqual([tool]);
    expect(client.getDiscoveredPrompts()).toEqual([prompt]);
    expect(client.getDiscoveredResources()).toEqual([resource]);
  });

  it('getPrompt caches by name+args and invalidates on prompt list change', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    mocks.invokeMcpPrompt.mockResolvedValue({ messages: [] });
    const { client } = createClient();
    await client.connect(connector);

    await client.getPrompt('p', { a: '1' });
    await client.getPrompt('p', { a: '1' });
    expect(mocks.invokeMcpPrompt).toHaveBeenCalledOnce();

    await client.getPrompt('p', { a: '2' });
    expect(mocks.invokeMcpPrompt).toHaveBeenCalledTimes(2);
  });

  it('getResource caches by uri', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);

    await client.getResource('r://x');
    await client.getResource('r://x');
    expect(fake.request).toHaveBeenCalledOnce();
  });
});

describe('McpClient tool calls', () => {
  it('merges contributed _meta over caller-supplied keys', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient({
      callMetadataProvider: () => ({ 'qwen/session': { token: 'sec' }, keep: 1 }),
    });
    await client.connect(connector);

    await client.callMcpTool({
      name: 't',
      arguments: { x: 1 },
      _meta: { 'qwen/session': { token: 'spoofed' }, other: 2 },
    });

    const sent = fake.callTool.mock.calls[0][0];
    expect(sent._meta['qwen/session']).toEqual({ token: 'sec' });
    expect(sent._meta.other).toBe(2);
    expect(sent._meta.keep).toBe(1);
  });

  it('rejects a tool call when not connected', async () => {
    const { client } = createClient();
    await expect(client.callMcpTool({ name: 't' })).rejects.toThrow(/not connected/);
  });
});

describe('McpClient change refresh', () => {
  it('re-discovers tools and notifies on tools/list_changed', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client, events } = createClient();
    await client.connect(connector);
    mocks.discoverTools.mockResolvedValue([{ name: 't2' } as never]);

    const handler = fake.handlers.get(ToolListChangedNotificationSchema);
    expect(handler).toBeDefined();
    await handler!({});

    expect(client.getDiscoveredTools()).toEqual([{ name: 't2' }]);
    expect(events.some((e) => e.type === 'tools')).toBe(true);
  });

  it('re-discovers prompts and clears the prompt cache on prompts/list_changed', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    mocks.invokeMcpPrompt.mockResolvedValue({ messages: [] });
    const { client } = createClient();
    await client.connect(connector);
    await client.getPrompt('p');
    expect(mocks.invokeMcpPrompt).toHaveBeenCalledOnce();

    await fake.handlers.get(PromptListChangedNotificationSchema)!({});
    await client.getPrompt('p');
    // Cache was cleared by the refresh, so the prompt is fetched again.
    expect(mocks.invokeMcpPrompt).toHaveBeenCalledTimes(2);
  });

  it('re-discovers resources on resources/list_changed', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client, events } = createClient();
    await client.connect(connector);
    mocks.discoverResources.mockResolvedValue([{ uri: 'r://new' } as never]);

    await fake.handlers.get(ResourceListChangedNotificationSchema)!({});

    expect(client.getDiscoveredResources()).toEqual([{ uri: 'r://new' }]);
    expect(events.some((e) => e.type === 'resources')).toBe(true);
  });

  it('routes progress through the connector reporter', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const handleProgress = vi.fn();
    const progressConnector: McpConnector = {
      ...connector,
      progressReporter: {
        registerProgressToken: vi.fn(),
        unregisterProgressToken: vi.fn(),
        handleProgress,
      },
    };
    const { client } = createClient();

    await client.connect(progressConnector);
    await client.discoverTools();

    expect(mocks.discoverTools.mock.calls[0][5].progressReporter).toBe(
      progressConnector.progressReporter,
    );
    const notification = {
      params: { progressToken: 'p', progress: 1 },
    };
    await fake.handlers.get(ProgressNotificationSchema)!(notification);
    expect(handleProgress).toHaveBeenCalledWith(notification);
  });
});

describe('McpClient notifications and extensions', () => {
  it('sends a protocol notification on the live connection', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);

    await client.sendNotification('qwen/session-state-changed', { state: 'anonymous' });

    expect(fake.notification).toHaveBeenCalledOnce();
    expect(fake.notification.mock.calls[0][0]).toMatchObject({
      method: 'qwen/session-state-changed',
    });
  });

  it('refuses to send a notification when not connected', async () => {
    const { client } = createClient();
    await expect(client.sendNotification('m', {})).rejects.toThrow(/not connected/);
  });

  it('reports extension support from server capabilities', async () => {
    const fake = createFakeClient({
      tools: {},
      extensions: { 'qwen/session-state-v1': {} },
    });
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);

    expect(client.supportsExtension('qwen/session-state-v1')).toBe(true);
    expect(client.supportsExtension('other')).toBe(false);
  });

  it('exposes server instructions and identity', async () => {
    const fake = createFakeClient();
    mocks.connectToMcpServer.mockResolvedValue(fake.client);
    const { client } = createClient();
    await client.connect(connector);

    expect(client.getInstructions()).toBe('server-instructions');
    expect(client.getServerName()).toBe('test-server');
    expect(client.getServerKey()).toEqual(mcpServerKey('sdk', 'test-server'));
    expect(client.getServerConfig()).toBe(serverConfig);
  });
});

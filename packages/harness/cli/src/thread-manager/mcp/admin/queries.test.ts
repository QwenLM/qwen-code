/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MCPServerStatus,
  mcpServerKeyId,
  pluginMcpRegistrations,
  Storage,
  type McpManager,
  type McpServerKey,
  type McpServerRegistration,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { userMcpServerKey } from '../../../mcp/framework.js';
import type { DaemonMcpContext } from './context.js';
import {
  callMcpServerTool,
  getMcpServerInfo,
  getMcpServerTools,
  listMcpServerResources,
  listMcpServers,
  readMcpServerResource,
  reconnectMcpServer,
} from './queries.js';
import { pluginMcpServerId } from './serverIds.js';
import { mcpConfigVersion } from './userSettings.js';

interface FakeClient {
  status: MCPServerStatus;
  lastError?: unknown;
  tools?: unknown[];
  discoveryError?: unknown;
  initializeResult?: Record<string, unknown>;
  callTool?: ReturnType<typeof vi.fn>;
  listResourcesPage?: ReturnType<typeof vi.fn>;
  readResource?: ReturnType<typeof vi.fn>;
}

interface FakePluginServer extends FakeClient {
  pluginId: string;
  pluginName: string;
  name: string;
  config?: Record<string, unknown>;
  /** Plugin directory; installs of one plugin differ here. */
  path?: string;
}

/** The registration a plugin server gets, built as production builds it. */
function pluginRegistration(plugin: FakePluginServer): McpServerRegistration {
  const path = plugin.path ?? '/p';
  const [registration] = pluginMcpRegistrations(
    {
      id: plugin.pluginId,
      name: plugin.pluginName,
      path,
      mcpServers: { [plugin.name]: { command: 'node', ...plugin.config } },
    },
    path,
  );
  return registration;
}

function setup(options: {
  raw: Record<string, unknown>;
  /** Resolved (env-expanded) entries; defaults to `raw`. */
  resolved?: Record<string, unknown>;
  clients?: Record<string, FakeClient>;
  /** User-level plugin servers the daemon gave the pool. */
  plugins?: FakePluginServer[];
  /** Plugin servers only some session loaded: in the pool, not the daemon's. */
  sessionPlugins?: FakePluginServer[];
  rejected?: boolean;
  withCredentials?: string[];
  noManager?: boolean;
}) {
  const settings = {
    isUserSettingsLoadRejected: () => options.rejected === true,
    user: {
      originalSettings: { mcpServers: options.raw },
      settings: { mcpServers: options.resolved ?? options.raw },
    },
  } as unknown as LoadedSettings;
  const reconnect = vi.fn(async (_key: McpServerKey, _auth?: boolean) => {});
  const fakeClient = (key: McpServerKey, fake: FakeClient, config: object) => ({
    getServerKey: () => key,
    getServerName: () => key.name,
    getServerConfig: () => config,
    getStatus: () => fake.status,
    isConnected: () => fake.status === MCPServerStatus.CONNECTED,
    getInitializeResult: () => fake.initializeResult,
    getServerInfo: () => {
      const raw = fake.initializeResult;
      if (!raw) return undefined;
      return {
        source: 'initialize',
        capabilities:
          (raw['capabilities'] as Record<string, unknown> | undefined) ?? {},
        raw,
      };
    },
    getLastConnectError: () => fake.lastError,
    getDiscoveredTools: () => fake.tools ?? [],
    getToolDiscoveryError: () => fake.discoveryError,
    callMcpTool: fake.callTool ?? vi.fn(async () => ({ content: [] })),
    listResourcesPage:
      fake.listResourcesPage ?? vi.fn(async () => ({ resources: [] })),
    readResource: fake.readResource ?? vi.fn(async () => ({ contents: [] })),
  });
  const pooled = new Map<string, ReturnType<typeof fakeClient>>();
  for (const [name, fake] of Object.entries(options.clients ?? {})) {
    const key = userMcpServerKey(name);
    pooled.set(mcpServerKeyId(key), fakeClient(key, fake, {}));
  }
  const userRegistrations: McpServerRegistration[] = [];
  for (const plugin of [
    ...(options.plugins ?? []),
    ...(options.sessionPlugins ?? []),
  ]) {
    const registration = pluginRegistration(plugin);
    pooled.set(
      mcpServerKeyId(registration.key),
      fakeClient(registration.key, plugin, registration.config),
    );
    if (options.plugins?.includes(plugin)) userRegistrations.push(registration);
  }
  const manager = {
    getClient: (key: McpServerKey) => pooled.get(mcpServerKeyId(key)),
    getClients: () => [...pooled.values()],
    reconnect,
  } as unknown as McpManager;
  const context: DaemonMcpContext = {
    getMcpManager: () => (options.noManager ? undefined : manager),
    readUserSettings: () => settings,
    hasCredentials: async (name) =>
      options.withCredentials?.includes(name) ?? false,
    deleteCredentials: async () => false,
    deleteCredentialsIfToken: async () => {},
    userRegistrations: () => userRegistrations,
    syncPool: async () => {},
  };
  return { context, reconnect };
}

describe('listMcpServers', () => {
  it('lists user servers with live status and stable ids', async () => {
    const { context } = setup({
      raw: {
        github: { url: 'https://example.com/mcp', type: 'http' },
        local: { command: 'node', args: ['server.js'] },
        off: { command: 'node', disabled: true },
        cold: { url: 'https://example.com/sse', type: 'sse' },
      },
      clients: {
        github: {
          status: MCPServerStatus.AUTH_REQUIRED,
          lastError: new Error('401 Unauthorized'),
        },
        local: { status: MCPServerStatus.CONNECTED },
        off: { status: MCPServerStatus.CONNECTED },
      },
      withCredentials: ['github'],
    });

    const list = await listMcpServers(context);

    expect(list.configPath).toBe(Storage.getGlobalSettingsPath());
    expect(list.invalidEntries).toEqual([]);
    expect(
      list.servers.map(
        ({ serverId, transport, enabled, status, error, hasCredentials }) => ({
          serverId,
          transport,
          enabled,
          status,
          error,
          hasCredentials,
        }),
      ),
    ).toEqual([
      {
        serverId: 'user:github',
        transport: 'http',
        enabled: true,
        status: 'auth_required',
        error: '401 Unauthorized',
        hasCredentials: true,
      },
      {
        serverId: 'user:local',
        transport: 'stdio',
        enabled: true,
        status: 'connected',
        error: undefined,
        hasCredentials: false,
      },
      // A disabled server reports `disabled` even if the pool still holds it.
      {
        serverId: 'user:off',
        transport: 'stdio',
        enabled: false,
        status: 'disabled',
        error: undefined,
        hasCredentials: false,
      },
      // Not pooled yet (e.g. added while hot reload is off).
      {
        serverId: 'user:cold',
        transport: 'sse',
        enabled: true,
        status: 'disconnected',
        error: undefined,
        hasCredentials: false,
      },
    ]);
  });

  it('returns secret values as written so the host can edit them', async () => {
    const { context } = setup({
      raw: {
        github: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer secret-token' },
          env: { API_KEY: 'secret-key' },
          oauth: { enabled: true, clientId: 'cid', clientSecret: 'shh' },
        },
      },
    });

    const [server] = (await listMcpServers(context)).servers;

    expect(server.config).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' },
      env: { API_KEY: 'secret-key' },
      oauth: { enabled: true, clientId: 'cid', clientSecret: 'shh' },
    });
  });

  it('shows raw values, not env-expanded ones', async () => {
    const { context } = setup({
      raw: { github: { url: 'https://example.com/${TENANT}' } },
      resolved: { github: { url: 'https://example.com/acme' } },
    });

    const [server] = (await listMcpServers(context)).servers;

    expect(server.config['url']).toBe('https://example.com/${TENANT}');
  });

  it('reports entries the settings validation dropped, with what to fix', async () => {
    const { context } = setup({
      raw: {
        good: { command: 'node' },
        bad: { command: 'node', env: { K: 'v' }, timeout: 'oops' },
        text: 'not an object',
      },
      resolved: { good: { command: 'node' } },
    });

    const list = await listMcpServers(context);

    expect(list.servers.map((s) => s.configKey)).toEqual(['good']);
    expect(list.invalidEntries).toEqual([
      {
        configKey: 'bad',
        message: expect.any(String),
        config: { command: 'node', env: { K: 'v' }, timeout: 'oops' },
        issues: [expect.stringContaining('timeout')],
      },
      {
        configKey: 'text',
        message: expect.any(String),
        issues: ['config must be an object.'],
      },
    ]);
  });

  it('versions the mcpServers content independent of key order', () => {
    const a = mcpConfigVersion({ x: { command: 'a', args: ['1'] }, y: {} });
    const b = mcpConfigVersion({ y: {}, x: { args: ['1'], command: 'a' } });
    const c = mcpConfigVersion({ x: { command: 'a', args: ['2'] }, y: {} });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(mcpConfigVersion(undefined)).toBe(mcpConfigVersion({}));
  });

  it('fails clearly when the user settings file cannot be read', async () => {
    const { context } = setup({ raw: {}, rejected: true });

    await expect(listMcpServers(context)).rejects.toMatchObject({
      code: 'SETTINGS_UNREADABLE',
    });
  });

  it('lists plugin servers from the pool after user servers, read-only and without config', async () => {
    const { context } = setup({
      raw: { github: { url: 'https://example.com/mcp' } },
      plugins: [
        {
          pluginId: 'linear@market',
          pluginName: 'linear',
          name: 'linear',
          status: MCPServerStatus.AUTH_REQUIRED,
          lastError: new Error('401'),
          config: {
            url: 'https://mcp.linear.app/sse?token=secret',
            type: 'sse',
          },
        },
      ],
      withCredentials: ['linear'],
    });

    const list = await listMcpServers(context);

    expect(list.servers.map((s) => s.serverId)).toEqual([
      'user:github',
      'plugin:linear%40market:linear',
    ]);
    expect(list.servers[0]).toMatchObject({
      source: 'user',
      writable: true,
      authMethod: 'oauth',
    });
    expect(list.servers[1]).toEqual({
      serverId: 'plugin:linear%40market:linear',
      configKey: 'linear',
      source: 'plugin',
      pluginId: 'linear@market',
      pluginName: 'linear',
      writable: false,
      transport: 'sse',
      authMethod: 'oauth',
      config: {},
      enabled: true,
      status: 'auth_required',
      error: '401',
      hasCredentials: true,
    });
    expect(JSON.stringify(list)).not.toMatch(/secret/);
  });

  it("lists only the daemon's own plugin servers, not ones a session loaded", async () => {
    const linear = {
      pluginId: 'linear@market',
      pluginName: 'linear',
      name: 'linear',
      status: MCPServerStatus.CONNECTED,
      tools: [{ serverToolName: 'user_tool' }],
    };
    const { context } = setup({
      raw: {},
      plugins: [linear],
      sessionPlugins: [
        // The same plugin installed in a project: another directory, so
        // another pool key, and the user-level target is untouched.
        {
          ...linear,
          path: '/repo/.qoder/plugins/linear',
          tools: [{ serverToolName: 'project_tool' }],
        },
        // A plugin only a project session loaded.
        {
          ...linear,
          pluginId: 'only@project',
          pluginName: 'only',
          name: 'only',
        },
      ],
    });

    const list = await listMcpServers(context);

    expect(list.servers.map((s) => s.serverId)).toEqual([
      'plugin:linear%40market:linear',
    ]);
    expect(
      getMcpServerTools(context, 'plugin:linear%40market:linear').tools,
    ).toEqual([{ serverToolName: 'user_tool' }]);
    expect(() =>
      getMcpServerTools(context, 'plugin:only%40project:only'),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('builds plugin ids whose name may contain a colon', () => {
    expect(pluginMcpServerId('a:b@c', 'x:y')).toBe('plugin:a%3Ab%40c:x:y');
  });
});

describe('getMcpServerTools', () => {
  it('reports a failed discovery instead of an empty list', () => {
    const { context } = setup({
      raw: { local: { command: 'node' } },
      clients: {
        local: {
          status: MCPServerStatus.CONNECTED,
          discoveryError: new Error('second page failed'),
        },
      },
    });

    expect(() => getMcpServerTools(context, 'user:local')).toThrow(
      expect.objectContaining({
        code: 'DISCOVERY_FAILED',
        message: expect.stringContaining('second page failed'),
      }),
    );
  });

  it('returns the tools of a connected server', () => {
    const tool = { serverToolName: 'ping' };
    const { context } = setup({
      raw: { local: { command: 'node' } },
      clients: { local: { status: MCPServerStatus.CONNECTED, tools: [tool] } },
    });

    expect(getMcpServerTools(context, 'user:local')).toEqual({
      serverId: 'user:local',
      tools: [tool],
    });
  });

  it.each([
    ['an unknown id', 'user:missing', 'NOT_FOUND'],
    ['an id without the user prefix', 'local', 'NOT_FOUND'],
    ['a disabled server', 'user:off', 'DISABLED'],
    ['a server that is not connected', 'user:cold', 'NOT_CONNECTED'],
  ])('rejects %s', (_label, serverId, code) => {
    const { context } = setup({
      raw: {
        local: { command: 'node' },
        off: { command: 'node', disabled: true },
        cold: { command: 'node' },
      },
      clients: {
        local: { status: MCPServerStatus.CONNECTED },
        cold: { status: MCPServerStatus.DISCONNECTED },
      },
    });

    expect(() => getMcpServerTools(context, serverId)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('returns the tools of a plugin server', () => {
    const tool = { serverToolName: 'issues' };
    const { context } = setup({
      raw: {},
      plugins: [
        {
          pluginId: 'a:b@c',
          pluginName: 'ab',
          name: 'x:y',
          status: MCPServerStatus.CONNECTED,
          tools: [tool],
        },
      ],
    });

    expect(getMcpServerTools(context, 'plugin:a%3Ab%40c:x:y').tools).toEqual([
      tool,
    ]);
  });

  it.each([
    ['a plugin server no session uses', 'plugin:other%40x:linear'],
    ['a plugin id without a name', 'plugin:linear%40market'],
    ['a malformed plugin id', 'plugin:%E0%A4%A:linear'],
  ])('rejects %s as NOT_FOUND', (_label, serverId) => {
    const { context } = setup({
      raw: {},
      plugins: [
        {
          pluginId: 'linear@market',
          pluginName: 'linear',
          name: 'linear',
          status: MCPServerStatus.CONNECTED,
        },
      ],
    });

    expect(() => getMcpServerTools(context, serverId)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

describe('getMcpServerInfo', () => {
  it('returns the raw initialize result of a connected server', () => {
    const raw = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'local', title: 'Local' },
    };
    const { context } = setup({
      raw: { local: { command: 'node' } },
      clients: {
        local: { status: MCPServerStatus.CONNECTED, initializeResult: raw },
      },
    });

    expect(getMcpServerInfo(context, 'user:local')).toEqual({
      serverId: 'user:local',
      info: {
        source: 'initialize',
        capabilities: { tools: {} },
        raw,
      },
    });
  });

  it('returns null while the server is not connected', () => {
    const { context } = setup({
      raw: { local: { command: 'node' } },
      clients: { local: { status: MCPServerStatus.DISCONNECTED } },
    });

    expect(getMcpServerInfo(context, 'user:local')).toEqual({
      serverId: 'user:local',
      info: null,
    });
  });
});

describe('callMcpServerTool', () => {
  it('calls a discovered tool by raw or qualified name', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const { context } = setup({
      raw: { local: { command: 'node' } },
      clients: {
        local: {
          status: MCPServerStatus.CONNECTED,
          tools: [{ serverToolName: 'show', name: 'mcp__local__show' }],
          callTool,
        },
      },
    });

    const result = await callMcpServerTool(context, 'user:local', 'show', {
      id: 1,
    });

    expect(callTool).toHaveBeenCalledWith({
      name: 'show',
      arguments: { id: 1 },
    });
    expect(result).toEqual({
      serverId: 'user:local',
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
  });

  it('rejects an unknown tool, a model-only tool or disconnected server', async () => {
    const { context } = setup({
      raw: { local: { command: 'node' }, cold: { command: 'node' } },
      clients: {
        local: {
          status: MCPServerStatus.CONNECTED,
          tools: [
            {
              serverToolName: 'model_only',
              _meta: { ui: { visibility: ['model'] } },
            },
          ],
        },
        cold: { status: MCPServerStatus.DISCONNECTED },
      },
    });

    await expect(
      callMcpServerTool(context, 'user:local', 'missing', {}),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    await expect(
      callMcpServerTool(context, 'user:local', 'model_only', {}),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    await expect(
      callMcpServerTool(context, 'user:cold', 'show', {}),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

describe('daemon-level MCP resources', () => {
  it('lists one page and reads one resource through the pool', async () => {
    const listResourcesPage = vi.fn(async () => ({
      resources: [{ uri: 'docs://a', name: 'a' }],
      nextCursor: 'page-2',
    }));
    const readResource = vi.fn(async () => ({
      contents: [{ uri: 'docs://a', text: 'body' }],
    }));
    const { context } = setup({
      raw: { local: { command: 'node' } },
      clients: {
        local: {
          status: MCPServerStatus.CONNECTED,
          listResourcesPage,
          readResource,
        },
      },
    });

    await expect(
      listMcpServerResources(context, 'user:local', 'page-1'),
    ).resolves.toEqual({
      serverId: 'user:local',
      result: {
        resources: [{ uri: 'docs://a', name: 'a' }],
        nextCursor: 'page-2',
      },
    });
    expect(listResourcesPage).toHaveBeenCalledWith('page-1');

    await expect(
      readMcpServerResource(context, 'user:local', 'docs://a'),
    ).resolves.toEqual({
      serverId: 'user:local',
      result: { contents: [{ uri: 'docs://a', text: 'body' }] },
    });
    expect(readResource).toHaveBeenCalledWith('docs://a');
  });

  it('rejects resources when the server is not connected', async () => {
    const { context } = setup({
      raw: { cold: { command: 'node' } },
      clients: { cold: { status: MCPServerStatus.DISCONNECTED } },
    });

    await expect(
      listMcpServerResources(context, 'user:cold'),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(
      readMcpServerResource(context, 'user:cold', 'docs://a'),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

describe('reconnectMcpServer', () => {
  it('reconnects through the pool without interactive authorization', async () => {
    const { context, reconnect } = setup({
      raw: { local: { command: 'node' } },
      clients: { local: { status: MCPServerStatus.CONNECTED } },
    });

    const server = await reconnectMcpServer(context, 'user:local');

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect.mock.calls[0][0].name).toBe('local');
    expect(reconnect.mock.calls[0][1]).toBe(false);
    expect(server).toMatchObject({
      serverId: 'user:local',
      status: 'connected',
    });
  });

  it.each([
    [
      'a disabled server',
      { off: { command: 'node', disabled: true } },
      'user:off',
      'DISABLED',
    ],
    [
      'a server with no pooled connection',
      { cold: { command: 'node' } },
      'user:cold',
      'NOT_CONNECTED',
    ],
  ])('rejects %s', async (_label, raw, serverId, code) => {
    const { context, reconnect } = setup({ raw });

    await expect(reconnectMcpServer(context, serverId)).rejects.toMatchObject({
      code,
    });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reconnects a plugin server through its pool key', async () => {
    const { context, reconnect } = setup({
      raw: {},
      plugins: [
        {
          pluginId: 'linear@market',
          pluginName: 'linear',
          name: 'linear',
          status: MCPServerStatus.CONNECTED,
        },
      ],
    });

    const server = await reconnectMcpServer(
      context,
      'plugin:linear%40market:linear',
    );

    expect(reconnect.mock.calls[0][0]).toEqual(
      pluginRegistration({
        pluginId: 'linear@market',
        pluginName: 'linear',
        name: 'linear',
        status: MCPServerStatus.CONNECTED,
      }).key,
    );
    expect(server).toMatchObject({ source: 'plugin', status: 'connected' });
  });

  it('fails clearly when MCP is not running', async () => {
    const { context } = setup({
      raw: { local: { command: 'node' } },
      noManager: true,
    });

    await expect(
      reconnectMcpServer(context, 'user:local'),
    ).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' });
  });
});

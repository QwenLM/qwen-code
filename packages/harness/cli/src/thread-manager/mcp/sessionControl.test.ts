/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Config,
  type MCPServerConfig,
  type OAuthToken,
  ENV_FORCE_ENCRYPTED_FILE_STORAGE,
  MCPServerStatus,
  mcpServerRequiresOAuth,
  MCPOAuthTokenStorage,
  Storage,
} from '@qwen-code/core';
import {
  createMcpControlModule,
  reloadSessionMcpServers,
} from './sessionControl.js';

function controlFor(
  servers: Record<string, unknown> | undefined,
  managerServers: Record<string, unknown> | null = servers ?? null,
) {
  const config = {
    getMcpClientManager: () =>
      managerServers === null
        ? undefined
        : {
            getMcpServers: () => managerServers,
            getServerInfo: (name: string) =>
              name === 'srv'
                ? {
                    source: 'initialize',
                    raw: { capabilities: { tools: {} } },
                  }
                : null,
            getServerTools: (name: string) =>
              name === 'srv'
                ? {
                    serverName: name,
                    tools: [
                      {
                        qualifiedName: 'mcp__srv__search',
                        definition: { name: 'search', title: 'Search' },
                      },
                    ],
                  }
                : null,
            restartServer: vi.fn(),
            storeAuthorizationToken: async (
              name: string,
              token: OAuthToken,
              serverConfig?: MCPServerConfig,
            ) => {
              if (serverConfig && Reflect.get(serverConfig, 'hostEndpoint') !== undefined) return 'host-owned';
              if (!serverConfig) return 'host-owned';
              const storage = MCPOAuthTokenStorage.forServer(
                name,
                serverConfig,
              );
              const existing = await storage.getCredentials(name);
              await storage.saveToken(
                name,
                token,
                serverConfig.oauth?.clientId ?? existing?.clientId,
                serverConfig.oauth?.tokenUrl ?? existing?.tokenUrl,
                serverConfig.httpUrl ?? serverConfig.url,
                serverConfig.oauth?.resource ?? existing?.resource,
              );
              return 'stored';
            },
            clearAuthorization: async (
              name: string,
              serverConfig?: MCPServerConfig,
            ) => {
              if (serverConfig && Reflect.get(serverConfig, 'hostEndpoint') !== undefined) return 'host-owned';
              if (serverConfig) {
                await MCPOAuthTokenStorage.forServer(
                  name,
                  serverConfig,
                ).deleteCredentials(name);
              } else {
                await MCPOAuthTokenStorage.deleteCredentialsByServerName(name);
              }
              return 'cleared';
            },
          },
    getMcpServers: () => servers,
    getSessionId: () => 'test-session',
  } as unknown as Config;
  return createMcpControlModule({
    config,
    runLogger: { log: () => {}, warn: () => {} },
  });
}

describe('managed MCP controls', () => {
  const visible = { userVisible: true, userCanDisable: true };
  function fixture(policy = visible) {
    const disabled = new Set<string>();
    const manager = {
      getMcpServers: vi.fn(() => ({
        enterprise_a: { command: 'docs' },
        ordinary: { command: 'ordinary' },
      })),
      getClientByName: vi.fn((_name: string) => ({
        getStatus: () => MCPServerStatus.CONNECTED,
      })),
      getLastError: vi.fn(),
      isServerEnabled: vi.fn((name: string) => !disabled.has(name)),
      canUseMcpServer: vi.fn((name: string) => !disabled.has(name)),
      getServerStatus: vi.fn(() => MCPServerStatus.CONNECTED),
      getMcpServerDenyMessage: vi.fn((): string | undefined => undefined),
      hasSdkClient: vi.fn(() => false),
      enableMcpServer: vi.fn(async (name: string) => {
        disabled.delete(name);
      }),
      disableMcpServer: vi.fn(async (name: string) => {
        if (!policy.userCanDisable) throw new Error('Required by organization');
        disabled.add(name);
      }),
      restart: vi.fn(async () => {}),
    };
    const setDynamicMcpServers = vi.fn();
    const config = {
      getMcpClientManager: () => manager,
      getManagedMcpServer: (name: string) =>
        name === 'enterprise_a' ? policy : undefined,
      getDynamicMcpServers: () => ({ keep: { command: 'keep' } }),
      setDynamicMcpServers,
      getSessionId: () => 'test-session',
      getToolRegistry: () => ({
        getToolsByServer: () => [{ name: 'echo', description: 'Shared tool' }],
      }),
    } as unknown as Config;
    return {
      manager,
      setDynamicMcpServers,
      control: createMcpControlModule({
        config,
        runLogger: { log: () => {}, warn: () => {} },
      }),
    };
  }

  it('routes enterprise session toggle to its session manager without replacing persistent sources', async () => {
    const { control, manager, setDynamicMcpServers } = fixture();
    expect(
      await control.handle('mcp_toggle', {
        serverName: 'enterprise_a',
        enabled: false,
      }),
    ).toEqual({ ok: true });
    expect(manager.disableMcpServer).toHaveBeenCalledExactlyOnceWith(
      'enterprise_a',
    );
    expect(
      await control.handle('mcp_toggle', {
        serverName: 'enterprise_a',
        enabled: true,
      }),
    ).toEqual({ ok: true });
    expect(manager.enableMcpServer).toHaveBeenCalledExactlyOnceWith(
      'enterprise_a',
    );
    expect(setDynamicMcpServers).not.toHaveBeenCalled();
  });

  it('projects disabled session state even while a shared client remains connected', async () => {
    const a = fixture();
    const b = fixture();
    await a.control.handle('mcp_toggle', {
      serverName: 'enterprise_a',
      enabled: false,
    });
    expect(a.manager.getClientByName('enterprise_a')?.getStatus()).toBe(
      MCPServerStatus.CONNECTED,
    );
    expect(await a.control.handle('mcp_status', {})).toMatchObject({
      response: {
        servers: expect.arrayContaining([
          expect.objectContaining({
            name: 'enterprise_a',
            status: 'disabled',
            tools: [],
          }),
        ]),
      },
    });
    expect(await b.control.handle('mcp_status', {})).toMatchObject({
      response: {
        servers: expect.arrayContaining([
          expect.objectContaining({
            name: 'enterprise_a',
            status: 'connected',
          }),
        ]),
      },
    });
    await a.control.handle('mcp_toggle', {
      serverName: 'enterprise_a',
      enabled: true,
    });
    expect(await a.control.handle('mcp_status', {})).toMatchObject({
      response: {
        servers: expect.arrayContaining([
          expect.objectContaining({
            name: 'enterprise_a',
            status: 'connected',
          }),
        ]),
      },
    });
  });

  it.each(['disabled', 'blocked'] as const)(
    'does not let OAuth overwrite %s status',
    async (status) => {
      const { control, manager } = fixture();
      manager.isServerEnabled.mockReturnValue(status !== 'disabled');
      manager.canUseMcpServer.mockReturnValue(false);
      manager.getMcpServerDenyMessage.mockReturnValue(
        status === 'blocked' ? 'Excluded by settings' : undefined,
      );
      mcpServerRequiresOAuth.set('enterprise_a', true);
      try {
        expect(await control.handle('mcp_status', {})).toMatchObject({
          response: {
            servers: expect.arrayContaining([
              expect.objectContaining({
                name: 'enterprise_a',
                status,
                tools: [],
              }),
            ]),
          },
        });
      } finally {
        mcpServerRequiresOAuth.delete('enterprise_a');
      }
    },
  );

  it('keeps admitted SDK-hosted servers connected without a pooled client', async () => {
    const { control, manager } = fixture();
    manager.getMcpServers.mockReturnValue({
      enterprise_a: { type: 'sdk' },
    } as never);
    manager.hasSdkClient.mockReturnValue(true);
    manager.getServerStatus.mockReturnValue(MCPServerStatus.DISCONNECTED);
    expect(await control.handle('mcp_status', {})).toMatchObject({
      response: {
        servers: expect.arrayContaining([
          expect.objectContaining({ status: 'connected' }),
        ]),
      },
    });
    manager.canUseMcpServer.mockReturnValue(false);
    expect(await control.handle('mcp_status', {})).toMatchObject({
      response: {
        servers: expect.arrayContaining([
          expect.objectContaining({ status: 'disconnected', tools: [] }),
        ]),
      },
    });
  });

  it('returns the existing error shape when enterprise disable is locked', async () => {
    const { control } = fixture({ ...visible, userCanDisable: false });
    expect(
      await control.handle('mcp_toggle', {
        serverName: 'enterprise_a',
        enabled: false,
      }),
    ).toEqual({ ok: false, error: 'Required by organization' });
  });

  it('omits hidden enterprise status and refuses its toggle without mutating state', async () => {
    const { control, manager } = fixture({ ...visible, userVisible: false });
    const status = await control.handle('mcp_status', {});
    expect(status).toMatchObject({
      ok: true,
      response: { servers: [{ name: 'ordinary' }] },
    });
    expect(
      await control.handle('mcp_toggle', {
        serverName: 'enterprise_a',
        enabled: false,
      }),
    ).toMatchObject({ ok: false });
    expect(manager.disableMcpServer).not.toHaveBeenCalled();
  });

  it('rejects an entire reserved dynamic replacement before mutating or restarting', async () => {
    const { control, manager, setDynamicMcpServers } = fixture();
    expect(
      await control.handle('mcp_set_servers', {
        servers: {
          ordinary: { command: 'new' },
          enterprise_forged: { command: 'fake' },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(setDynamicMcpServers).not.toHaveBeenCalled();
    expect(manager.restart).not.toHaveBeenCalled();
  });
});

describe('mcp_inject_token', () => {
  it('refuses a server without config instead of guessing its identity', async () => {
    const control = controlFor({});

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'ghost',
        token: { accessToken: 'token' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'unknown MCP server "ghost"',
    });
  });
});

describe('mcp_inject_token storage', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mcp-inject-'));
    vi.stubEnv(ENV_FORCE_ENCRYPTED_FILE_STORAGE, 'false');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(directory);
    vi.spyOn(Storage, 'getMcpOAuthTokensPath').mockReturnValue(
      join(directory, 'tokens.json'),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists the identity URL and configured OAuth fields', async () => {
    const config = {
      url: 'https://mcp.example.com/mcp',
      oauth: {
        enabled: true,
        clientId: 'client',
        tokenUrl: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp/',
      },
    };
    const control = controlFor({ svc: config });

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'svc',
        token: { accessToken: 'A', refreshToken: 'R' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(
      await MCPOAuthTokenStorage.forServer('svc', config).getCredentials('svc'),
    ).toMatchObject({
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      mcpServerUrl: 'https://mcp.example.com/mcp',
      resource: 'https://mcp.example.com/mcp/',
      token: { accessToken: 'A', refreshToken: 'R' },
    });
  });

  it('keeps fields known from an earlier sign-in', async () => {
    const config = {
      url: 'https://mcp.example.com/mcp',
      oauth: { enabled: true },
    };
    await MCPOAuthTokenStorage.forServer('svc', config).saveToken(
      'svc',
      { accessToken: 'old', refreshToken: 'R0', tokenType: 'Bearer' },
      'client',
      'https://auth.example.com/token',
      'https://mcp.example.com/mcp',
      'https://mcp.example.com/mcp/',
    );
    const control = controlFor({ svc: config });

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'svc',
        token: { accessToken: 'new', refreshToken: 'R1' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(
      await MCPOAuthTokenStorage.forServer('svc', config).getCredentials('svc'),
    ).toMatchObject({
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      resource: 'https://mcp.example.com/mcp/',
      token: { accessToken: 'new', refreshToken: 'R1' },
    });
  });

  it('still stores the identity URL without OAuth config', async () => {
    const config = { url: 'https://mcp.example.com/mcp' };
    const control = controlFor({ svc: config });

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'svc',
        token: { accessToken: 'A' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(
      await MCPOAuthTokenStorage.forServer('svc', config).getCredentials('svc'),
    ).toMatchObject({ mcpServerUrl: 'https://mcp.example.com/mcp' });
  });
});

const serverA: MCPServerConfig = { url: 'https://a.example.com/mcp' };
const serverB: MCPServerConfig = { url: 'https://b.example.com/mcp' };
const pluginServer: MCPServerConfig = {
  ...serverA,
  plugin: { id: 'review@market', name: 'review', path: '/plugin' },
};

describe('mcp_clear_auth', () => {
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mcp-clear-auth-'));
    vi.stubEnv(ENV_FORCE_ENCRYPTED_FILE_STORAGE, 'false');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(directory);
    vi.spyOn(Storage, 'getMcpOAuthTokensPath').mockReturnValue(
      join(directory, 'tokens.json'),
    );
    for (const [config, accessToken] of [
      [serverA, 'token-a'],
      [serverB, 'token-b'],
      [pluginServer, 'plugin-token'],
    ] as const) {
      await MCPOAuthTokenStorage.forServer('svc', config).saveToken('svc', {
        accessToken,
        tokenType: 'Bearer',
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  async function remainingTokens(): Promise<string[]> {
    const credentials = await new MCPOAuthTokenStorage().getAllCredentials();
    return [...credentials.values()]
      .map(({ token }) => token.accessToken)
      .sort();
  }

  it.each([
    ['manager missing', null],
    ['manager catalogue empty', {}],
  ] as const)('clears only the configured identity when %s', async (_name, managerServers) => {
    const control = controlFor({ svc: serverA }, managerServers);

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token', 'token-b']);
  });

  it('prefers the manager entry over the Config entry', async () => {
    const control = controlFor({ svc: serverB }, { svc: serverA });

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token', 'token-b']);
  });

  it('rejects brokered-server cleanup when the manager handles it', async () => {
    const control = controlFor(
      { svc: { hostEndpoint: 'https://mcp.example.com/test' } },
      {},
    );

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({
      ok: false,
      error:
        'MCP authorization for this server is owned by the host; local OAuth credentials cannot be cleared.',
    });

    expect(await remainingTokens()).toEqual([
      'plugin-token',
      'token-a',
      'token-b',
    ]);
  });

  it('clears local credentials when no manager can own the authorization', async () => {
    const control = controlFor(
      { svc: { hostEndpoint: 'https://mcp.example.com/test' } },
      null,
    );

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual([
      'plugin-token',
      'token-a',
      'token-b',
    ]);
  });

  it('retains name-wide cleanup for a genuinely unknown server', async () => {
    const control = controlFor({});

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token']);
  });

  it.each([
    ['manager missing', null],
    ['manager catalogue empty', {}],
  ] as const)('handles undefined Config servers when %s', async (_name, managerServers) => {
    const control = controlFor(undefined, managerServers);

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token']);
  });

  it('reports storage failure without deleting credentials', async () => {
    const control = controlFor({ svc: serverA }, {});
    vi.spyOn(MCPOAuthTokenStorage, 'forServer').mockReturnValue({
      deleteCredentials: vi.fn().mockRejectedValue(new Error('lock lost')),
    } as unknown as MCPOAuthTokenStorage);

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({
      ok: false,
      error: 'Failed to delete credentials: lock lost',
    });

    expect(await remainingTokens()).toEqual([
      'plugin-token',
      'token-a',
      'token-b',
    ]);
  });
});

const disk = vi.hoisted(() => ({
  next: {} as Record<string, unknown>,
  pending: {} as Record<string, unknown>,
  error: undefined as Error | undefined,
}));
const plugins = vi.hoisted(() => ({ refresh: vi.fn(async () => ({})) }));

vi.mock('../../config/config.js', () => ({
  refreshMcpServersFromDisk: (config: { servers: unknown }) => {
    if (disk.error) throw disk.error;
    config.servers = disk.next;
    return { approved: disk.next, pending: disk.pending };
  },
}));
vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshActivePlugins: plugins.refresh,
}));

function setup(initial: Record<string, MCPServerConfig>) {
  const sessionMcp = {
    reloadMcpServers: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
  };
  const config = {
    servers: initial,
    getMcpServers() {
      return this.servers;
    },
    getMcpClientManager: () => sessionMcp,
    reloadManagedMcpServers: vi.fn(async (options?: { beforeReload?: () => Promise<void>; serverNames?: string[] }) => {
      await options?.beforeReload?.();
      await sessionMcp.reloadMcpServers();
      return options?.serverNames;
    }),
    getSessionArtifactProjectRoot: () => '/work/project',
    getSessionId: () => 's1',
  };
  const module = createMcpControlModule({
    config: config as unknown as Config,
    runLogger: { log: () => {}, warn: () => {} },
  });
  return { module, sessionMcp, config };
}

describe('mcp_reload', () => {
  beforeEach(() => {
    disk.pending = {};
    disk.error = undefined;
    plugins.refresh.mockClear();
  });

  it('reports the diff and reloads without reconnecting everything', async () => {
    const { module, sessionMcp, config } = setup({
      keep: { command: 'a' },
      edit: { url: 'https://old', scope: 'user' },
      gone: { command: 'b' },
    });
    disk.next = {
      keep: { command: 'a' },
      // A different `scope` alone is not a change.
      edit: { url: 'https://new', scope: 'project' },
      fresh: { command: 'c' },
    };
    disk.pending = { unapproved: { command: 'x' } };

    const result = await module.handle('mcp_reload', {});

    expect(result).toEqual({
      ok: true,
      response: {
        added: ['fresh'],
        removed: ['gone'],
        changed: ['edit'],
        pending: ['unapproved'],
      },
    });
    expect(config.reloadManagedMcpServers).toHaveBeenCalledTimes(1);
    expect(sessionMcp.reloadMcpServers).toHaveBeenCalledTimes(1);
    expect(sessionMcp.restart).not.toHaveBeenCalled();
    expect(plugins.refresh).not.toHaveBeenCalled();
  });

  it('a scope-only difference is not reported as changed', async () => {
    const { module } = setup({ a: { command: 'a', scope: 'user' } });
    disk.next = { a: { command: 'a', scope: 'project' } };

    const result = await module.handle('mcp_reload', {});

    expect(result).toMatchObject({ ok: true, response: { changed: [] } });
  });

  it('reloads the session plugins when asked, before re-registering', async () => {
    const { module, sessionMcp } = setup({});
    disk.next = {};
    const order: string[] = [];
    plugins.refresh.mockImplementationOnce(async () => {
      order.push('plugins');
      return {};
    });
    sessionMcp.reloadMcpServers.mockImplementationOnce(async () => {
      order.push('mcp');
    });

    await module.handle('mcp_reload', { plugins: true });

    expect(plugins.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'reload-command', emitToFeed: false }),
    );
    expect(order).toEqual(['plugins', 'mcp']);
  });

  it('returns an error result when the reload fails', async () => {
    const { module, sessionMcp } = setup({});
    disk.error = new Error('settings.json is not valid JSON');

    const result = await module.handle('mcp_reload', {});

    expect(result).toEqual({
      ok: false,
      error: 'Failed to reload MCP servers: settings.json is not valid JSON',
    });
    expect(sessionMcp.reloadMcpServers).not.toHaveBeenCalled();
  });

  it('works from the Config alone, before a control module exists', async () => {
    const { sessionMcp, config } = setup({});
    disk.next = { fresh: { command: 'c' } };

    const result = await reloadSessionMcpServers(config as unknown as Config);

    expect(result).toMatchObject({ ok: true, response: { added: ['fresh'] } });
    expect(sessionMcp.reloadMcpServers).toHaveBeenCalledTimes(1);
  });
});

describe('mcp_status', () => {
  it('lists app-only tools with their _meta', async () => {
    const tool = {
      name: 'mcp__srv__show',
      description: 'show it',
      isReadOnly: true,
      _meta: { ui: { visibility: ['app'], resourceUri: 'ui://x/view' } },
    };
    const manager = {
      isServerEnabled: () => true,
      canUseMcpServer: () => true,
      getServerStatus: () => MCPServerStatus.CONNECTED,
      getMcpServers: () => ({ srv: { url: 'https://mcp.example.com/mcp' } }),
      getClientByName: () => ({
        getStatus: () => MCPServerStatus.CONNECTED,
        getLastError: () => undefined,
      }),
      getAllDiscoveredMcpTools: () => [
        {
          serverName: 'srv',
          qualifiedName: 'mcp__srv__show',
          toolName: 'show',
          description: 'show it',
          inputSchema: {},
          tool,
          alwaysLoad: false,
          source: 'client',
        },
      ],
      getAuthorizationState: () => 'polling',
      getAuthorizationOutcome: () => undefined,
    };
    const config = {
      getMcpClientManager: () => manager,
      getManagedMcpServer: () => undefined,
      getToolRegistry: () => undefined,
    } as unknown as Config;
    const control = createMcpControlModule({
      config,
      runLogger: { log: () => {}, warn: () => {} },
    });

    const result = await control.handle('mcp_status', {});

    expect(result).toMatchObject({
      ok: true,
      response: {
        servers: [
          {
            name: 'srv',
            authState: 'polling',
            tools: [
              {
                name: 'mcp__srv__show',
                _meta: {
                  ui: { visibility: ['app'], resourceUri: 'ui://x/view' },
                },
              },
            ],
          },
        ],
      },
    });
  });
});

describe('mcp_get_server_info / mcp_get_server_tools', () => {
  it('returns the raw initialize result for a known server', async () => {
    const control = controlFor({ srv: { command: 'node' } });

    await expect(
      control.handle('mcp_get_server_info', { serverName: 'srv' }),
    ).resolves.toEqual({
      ok: true,
      response: {
        serverName: 'srv',
        info: { source: 'initialize', raw: { capabilities: { tools: {} } } },
      },
    });
  });

  it('returns full tool definitions including the raw entry', async () => {
    const control = controlFor({ srv: { command: 'node' } });

    await expect(
      control.handle('mcp_get_server_tools', { serverName: 'srv' }),
    ).resolves.toEqual({
      ok: true,
      response: {
        serverName: 'srv',
        tools: [
          {
            qualifiedName: 'mcp__srv__search',
            definition: { name: 'search', title: 'Search' },
          },
        ],
      },
    });
  });

  it('reports an unknown server instead of an empty catalog', async () => {
    const control = controlFor({ srv: { command: 'node' } });

    await expect(
      control.handle('mcp_get_server_tools', { serverName: 'ghost' }),
    ).resolves.toEqual({
      ok: false,
      error: 'Unknown MCP server "ghost"',
    });
  });

  it('requires a serverName', async () => {
    const control = controlFor({ srv: { command: 'node' } });

    await expect(control.handle('mcp_get_server_info', {})).resolves.toEqual({
      ok: false,
      error: '`serverName` is required',
    });
  });
});

describe('mcp_read_resource / mcp_call_tool', () => {
  function appTools() {
    const tools = [
      {
        serverName: 'srv',
        toolName: 'show',
        qualifiedName: 'mcp__srv__show',
        description: 'show it',
        inputSchema: {},
        alwaysLoad: false,
        source: 'client',
        tool: {
          name: 'mcp__srv__show',
          description: 'show it',
          _meta: { ui: { visibility: ['app'] } },
        },
      },
      {
        serverName: 'srv',
        toolName: 'model_only',
        qualifiedName: 'mcp__srv__model_only',
        description: 'model only',
        inputSchema: {},
        alwaysLoad: false,
        source: 'client',
        tool: {
          name: 'mcp__srv__model_only',
          description: 'model only',
          _meta: { ui: { visibility: ['model'] } },
        },
      },
    ];
    const readResource = vi.fn(async () => ({
      contents: [{ uri: 'ui://x', text: '<html/>' }],
    }));
    const listResources = vi.fn(async () => ({
      resources: [{ uri: 'report://monthly', name: 'monthly' }],
      nextCursor: 'page-2',
    }));
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const manager = {
      isServerEnabled: () => true,
      canUseMcpServer: () => true,
      getServerStatus: () => MCPServerStatus.CONNECTED,
      getMcpServers: () => ({ srv: { url: 'https://mcp.example.com/mcp' } }),
      getClientByName: () => ({
        getStatus: () => MCPServerStatus.CONNECTED,
        getLastError: () => undefined,
      }),
      getAllDiscoveredMcpTools: () => tools,
      readResource,
      listResources,
      callTool,
    };
    const control = createMcpControlModule({
      config: {
        getMcpClientManager: () => manager,
        getManagedMcpServer: () => undefined,
      getToolRegistry: () => undefined,
      } as unknown as Config,
      runLogger: { log: () => {}, warn: () => {} },
    });
    return { control, readResource, listResources, callTool };
  }

  it('lists one page of resources and passes the cursor through', async () => {
    const { control, listResources } = appTools();

    const result = await control.handle('mcp_list_resources', {
      serverName: 'srv',
      cursor: 'page-2',
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        resources: [{ uri: 'report://monthly', name: 'monthly' }],
        nextCursor: 'page-2',
      },
    });
    expect(listResources).toHaveBeenCalledWith('srv', 'page-2');
  });

  it('reads a resource through the session connection', async () => {
    const { control, readResource } = appTools();

    const result = await control.handle('mcp_read_resource', {
      serverName: 'srv',
      uri: 'ui://x',
    });

    expect(result).toMatchObject({
      ok: true,
      response: { contents: [{ uri: 'ui://x' }] },
    });
    expect(readResource).toHaveBeenCalledWith('srv', 'ui://x');
  });

  it('calls an app-visible tool and refuses a model-only one', async () => {
    const { control, callTool } = appTools();

    const ok = await control.handle('mcp_call_tool', {
      serverName: 'srv',
      toolName: 'show',
      arguments: { a: 1 },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledWith('srv', {
      name: 'show',
      arguments: { a: 1 },
    });

    const refused = await control.handle('mcp_call_tool', {
      serverName: 'srv',
      toolName: 'model_only',
    });
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available to apps'),
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('forwards the request abort signal to the MCP call', async () => {
    const { control, callTool } = appTools();
    const controller = new AbortController();

    await control.handle(
      'mcp_call_tool',
      { serverName: 'srv', toolName: 'show', arguments: { a: 1 } },
      { signal: controller.signal },
    );

    expect(callTool).toHaveBeenCalledWith(
      'srv',
      { name: 'show', arguments: { a: 1 } },
      { signal: controller.signal },
    );
  });
});

describe('mcp_cancel_authorization', () => {
  function controlWith(cancelAuthorization: () => boolean) {
    const manager = {
      isServerEnabled: () => true,
      canUseMcpServer: () => true,
      getServerStatus: () => MCPServerStatus.CONNECTED,
      getMcpServers: () => ({ srv: { url: 'https://mcp.example.com/mcp' } }),
      getClientByName: () => ({
        getStatus: () => MCPServerStatus.CONNECTED,
        getLastError: () => undefined,
      }),
      getAuthorizationState: () => 'polling',
      getAuthorizationOutcome: () => ({
        state: 'failed',
        failure: { kind: 'provider_denied', userMessage: 'denied' },
        canRetryAuthorization: true,
      }),
      cancelAuthorization: vi.fn(cancelAuthorization),
    };
    const config = {
      getMcpClientManager: () => manager,
      getManagedMcpServer: () => undefined,
      getToolRegistry: () => undefined,
    } as unknown as Config;
    return {
      control: createMcpControlModule({
        config,
        runLogger: { log: () => {}, warn: () => {} },
      }),
      manager,
    };
  }

  it('cancels a session authorization in progress', async () => {
    const { control, manager } = controlWith(() => true);

    const result = await control.handle('mcp_cancel_authorization', {
      serverName: 'srv',
    });

    expect(result).toEqual({ ok: true, response: { cancelled: true } });
    expect(manager.cancelAuthorization).toHaveBeenCalledWith('srv');
  });

  it('reports nothing in progress without failing', async () => {
    const { control } = controlWith(() => false);

    const result = await control.handle('mcp_cancel_authorization', {
      serverName: 'srv',
    });

    expect(result).toEqual({
      ok: true,
      response: { cancelled: false, reason: 'not_in_progress' },
    });
  });

  it('exposes the failed authorization result on status', async () => {
    const { control } = controlWith(() => false);

    const result = await control.handle('mcp_status', {});
    const server = (
      result as unknown as {
        response: { servers: Array<Record<string, unknown>> };
      }
    ).response.servers[0];

    expect(server).toMatchObject({
      authState: 'polling',
      authFailure: { kind: 'provider_denied', message: 'denied' },
      canRetryAuthorization: true,
    });
  });
});

describe('mcp_authenticate with explicit endpoints (F-24)', () => {
  it('delegates the host-driven auth start to the session manager', async () => {
    const authenticateWithHost = vi.fn(async () => ({
      requiresUserAction: true,
      authUrl: 'https://auth.example.com/authorize',
    }));
    const config = {
      getMcpClientManager: () => ({ authenticateWithHost }),
      isServerEnabled: () => true,
      canUseMcpServer: () => true,
      getServerStatus: () => MCPServerStatus.CONNECTED,
      getMcpServers: () => ({ srv: { url: 'https://mcp.example.com/mcp' } }),
      getManagedMcpServer: () => undefined,
      getToolRegistry: () => undefined,
    } as unknown as Config;
    const control = createMcpControlModule({
      config,
      runLogger: { log: () => {}, warn: () => {} },
    });

    const result = await control.handle('mcp_authenticate', {
      serverName: 'srv',
    });
    expect(result).toMatchObject({
      ok: true,
      response: {
        requiresUserAction: true,
        authUrl: 'https://auth.example.com/authorize',
      },
    });
    expect(authenticateWithHost).toHaveBeenCalledWith('srv', {
      redirectUri: undefined,
    });
  });
});

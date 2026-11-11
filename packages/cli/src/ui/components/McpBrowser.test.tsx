/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { userSettingsPath, mcpStatusByName } = vi.hoisted(() => ({
  userSettingsPath: '/mock/qwen-verification-run/user-home/.abc/settings.json',
  mcpStatusByName: new Map<string, string>(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getUserConfigDisplayPath: () => userSettingsPath,
  };
});

import {
  CoreEvent,
  MCPServerStatus,
  DiscoveredMCPTool,
  ToolRegistry,
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  McpAuthorizationPreparationError,
  coreEvents,
  makeFakeConfig,
  mcpServerRequiresOAuth,
} from '@qwen-code/core';
import { renderWithProviders, mockSettings } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { McpBrowser } from './McpBrowser.js';
import * as localSettings from '../../config/localSettings.js';
import {
  clearMcpAuthSession,
  getMcpAuthSession,
  setPreservedDetailServer,
  startMcpAuth,
} from './mcpAuthSession.js';

describe('McpBrowser', () => {
  const lifecycleListeners = new Set<(name: string) => void>();
  const onServerAuthorizationInvalidated = (
    listener: (name: string) => void,
  ) => {
    lifecycleListeners.add(listener);
    return () => {
      lifecycleListeners.delete(listener);
    };
  };
  const invalidateAuthorization = (name: string) => {
    for (const listener of lifecycleListeners) listener(name);
  };
  const authorizationManager = <T extends object>(manager: T) => ({
    getAllDiscoveredMcpTools: () => [],
    prepareMcpAuthorization: async () => {
      throw new McpAuthorizationPreparationError('unsupported');
    },
    getMcpServerPresentation: (config: { hostEndpoint?: string }) =>
      config.hostEndpoint === undefined
        ? undefined
        : {
            connectionLabel: 'Hosted MCP Server',
            detailFields: [{ label: 'Host URL', value: config.hostEndpoint }],
          },
    ...manager,
  });
  afterEach(() => {
    setPreservedDetailServer(null);
    lifecycleListeners.clear();
  });

  it.each([false, true])(
    'browses and refreshes discovered tools with a partially populated model registry: %s',
    async (partiallyPopulated) => {
      const config = makeFakeConfig({
        excludeTools: ['mcp__playwright__hidden'],
      });
      const name = 'playwright';
      const createEntry = (
        serverName: string,
        toolName: string,
        source: 'client' | 'auth' = 'client',
      ) => {
        const tool = new DiscoveredMCPTool(
          {} as never,
          serverName,
          toolName,
          `${toolName} description`,
          { type: 'object', properties: {} },
        );
        return {
          qualifiedName: tool.name,
          serverName,
          toolName,
          description: tool.description,
          inputSchema: tool.parameterSchema,
          tool,
          alwaysLoad: false,
          source,
        };
      };
      let entries = [
        createEntry(name, 'browser_navigate'),
        createEntry(name, 'browser_snapshot'),
        createEntry(name, 'hidden'),
        createEntry('other-server', 'other_tool'),
        createEntry(name, 'authenticate', 'auth'),
      ];
      entries.push(entries[0]);
      vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
        authorizationManager({
          getMcpServers: () => ({ [name]: { command: 'npx', scope: 'local' } }),
          getServerStatus: () => MCPServerStatus.CONNECTED,
          getMcpServerConfigurationError: () => undefined,
          getClientByName: () => undefined,
          isMcpServerBlockedByHostPolicy: () => false,
          getMcpServerDenyMessage: () => undefined,
          getAllDiscoveredMcpTools: () => entries,
        }) as never,
      );
      // Lazy loading can leave the model registry empty or partially populated.
      const registry = new ToolRegistry(config, true);
      if (partiallyPopulated) registry.registerTool(entries[0].tool);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      expect(registry.getAllTools()).toHaveLength(partiallyPopulated ? 1 : 0);
      const { stdin, lastFrame, waitUntilReady, unmount } =
        await renderWithProviders(
          <McpBrowser
            config={config}
            settings={mockSettings}
            onExit={vi.fn()}
          />,
          { config, width: 100 },
        );
      try {
        await waitUntilReady();
        expect(lastFrame()).toContain('ready · 2 tools');
        await act(async () => {
          stdin.write('\u001b[B');
        });
        await act(async () => {
          stdin.write('\r');
        });
        await waitUntilReady();
        expect(lastFrame()).toContain('Status: ready · 2 tools');
        await act(async () => {
          stdin.write('\u001b[B');
        });
        await act(async () => {
          stdin.write('\r');
        });
        await waitUntilReady();
        expect(lastFrame()).toContain('browser_navigate');
        expect(lastFrame()).toContain('browser_snapshot');
        expect(lastFrame()).not.toContain('other_tool');
        expect(lastFrame()).not.toContain('authenticate');
        expect(lastFrame()).not.toContain('hidden');

        entries = [createEntry(name, 'browser_click')];
        await act(async () => {
          coreEvents.emit(CoreEvent.McpClientUpdate, {
            sessionId: config.getSessionId(),
            clients: new Map(),
          });
        });
        await waitFor(() => {
          expect(lastFrame()).toContain('1 tool');
          expect(lastFrame()).toContain('browser_click');
          expect(lastFrame()).not.toContain('browser_navigate');
        });
      } finally {
        unmount();
      }
    },
  );

  it('shows and toggles the original project MCP source from a worktree', async () => {
    const config = makeFakeConfig();
    vi.spyOn(config, 'getSessionArtifactProjectRoot').mockReturnValue(
      '/original',
    );
    vi.spyOn(config, 'getWorkingDir').mockReturnValue('/worktree');
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue({
      getMcpServers: () => ({ 'project-server': { command: 'server' } }),
      getAllDiscoveredMcpTools: () => [],
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => undefined,
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
      restart: vi.fn(async () => undefined),
      getMcpServerPresentation: () => undefined,
    } as never);
    const scopes = vi
      .spyOn(localSettings, 'findMcpServerScopes')
      .mockImplementation((_name, cwd) =>
        cwd === '/original' ? ['project'] : [],
      );
    const paths = vi
      .spyOn(localSettings, 'getProjectSourcePaths')
      .mockReturnValue(['/original/.mcp.json']);
    const disable = vi
      .spyOn(localSettings, 'persistentDisableMcpServer')
      .mockResolvedValue(undefined);
    setPreservedDetailServer('project-server');
    const { stdin, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config, width: 100 },
      );
    try {
      await waitUntilReady();
      expect(lastFrame()).toContain('/original/.mcp.json');
      expect(scopes).toHaveBeenCalledWith(
        'project-server',
        '/original',
        mockSettings,
        undefined,
      );
      expect(paths).toHaveBeenCalledWith(
        'project-server',
        '/original',
        mockSettings,
        undefined,
      );
      await act(async () => {
        stdin.write('\r');
      });
      await waitUntilReady();
      expect(disable).toHaveBeenCalledWith(
        'project-server',
        '/original',
        mockSettings,
        undefined,
      );
    } finally {
      unmount();
      scopes.mockRestore();
      paths.mockRestore();
      disable.mockRestore();
    }
  });

  it.each([80, 40])(
    'clears a cancelled auth session after runtime recovery at width %i',
    async (width) => {
      const name = 'auth-recovery';
      const config = makeFakeConfig();
      const serverConfig = {
        type: 'http' as const,
        scope: 'dynamic' as const,
        hostEndpoint: 'https://mcp.example.com/mcp',
      };
      let clientStatus = MCPServerStatus.DISCONNECTED;
      const manager = {
        onServerAuthorizationInvalidated,
        getMcpServers: () => ({ [name]: serverConfig }),
        getServerStatus: (name: string) =>
          mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
        getMcpServerConfigurationError: () => undefined,
        getClientByName: () => ({
          getStatus: () => clientStatus,
          getServerConfig: () => serverConfig,
        }),
        isMcpServerBlockedByHostPolicy: () => false,
        getMcpServerDenyMessage: () => undefined,
        prepareMcpAuthorization: vi.fn(async () => ({ kind: 'action' })),
        authorizeMcpServer: vi.fn(async () => ({ state: 'cancelled' })),
      };
      vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
        authorizationManager(manager) as never,
      );
      mcpStatusByName.set(name, MCPServerStatus.DISCONNECTED);
      mcpServerRequiresOAuth.set(name, true);
      await startMcpAuth(name, serverConfig, config);
      expect(getMcpAuthSession(name).state).toBe('error');
      setPreservedDetailServer(name);
      const { stdin, lastFrame, unmount, waitUntilReady } =
        await renderWithProviders(
          <McpBrowser
            config={config}
            settings={mockSettings}
            onExit={vi.fn()}
          />,
          { config, width },
        );
      try {
        await waitUntilReady();
        await waitFor(() => expect(lastFrame()).toContain('Failed'));

        // The lifecycle boundary clears state BEFORE reconnection succeeds.
        await act(async () => {
          invalidateAuthorization(name);
        });
        expect(getMcpAuthSession(name).state).toBe('idle');
        // Enable/reload recovers the client without starting another UI auth task.
        clientStatus = MCPServerStatus.CONNECTED;
        mcpStatusByName.set(name, MCPServerStatus.CONNECTED);
        mcpServerRequiresOAuth.delete(name);
        await act(async () => {
          coreEvents.emit(CoreEvent.McpClientUpdate, {
            sessionId: 'test-session',
            clients: new Map(),
          });
        });
        await waitFor(() => {
          expect(lastFrame()).toContain('Status: ready');
          expect(lastFrame()).toContain('✓ Authenticated');
          expect(lastFrame()).not.toContain('Failed');
          expect(lastFrame()).not.toContain('Authentication failed');
          expect(lastFrame()).not.toContain('Enter authenticate');
          expect(getMcpAuthSession(name).state).toBe('idle');
        });
        expect(lastFrame().replace(/[ \t]+$/gm, '')).toMatchSnapshot(
          'recovered authentication',
        );
        await act(async () => {
          stdin.write('\u001b[B');
        });
        await waitFor(() =>
          expect(lastFrame().replace(/\s/g, '')).toContain('❯Authenticate'),
        );
        await act(async () => {
          stdin.write('\r');
        });
        await waitUntilReady();
        expect(manager.prepareMcpAuthorization).toHaveBeenCalledOnce();
        expect(manager.authorizeMcpServer).toHaveBeenCalledOnce();
      } finally {
        unmount();
        clearMcpAuthSession(name);
        mcpStatusByName.delete(name);
        mcpServerRequiresOAuth.delete(name);
      }
    },
  );

  it.each([
    {
      label: 'disconnected live client despite cached ready',
      connected: false,
      needsAuth: false,
    },
    {
      label: 'connected transport still requiring authorization',
      connected: true,
      needsAuth: true,
    },
  ])('preserves retry for $label', async ({ connected, needsAuth }) => {
    const name = 'auth-not-recovered';
    const config = makeFakeConfig();
    const serverConfig = {
      timeout: 30000,
      hostEndpoint: 'https://mcp.example.com/mcp',
    };
    const manager = {
      onServerAuthorizationInvalidated,
      getMcpServers: () => ({ [name]: serverConfig }),
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => ({
        getStatus: () =>
          connected ? MCPServerStatus.CONNECTED : MCPServerStatus.DISCONNECTED,
        getServerConfig: () => serverConfig,
      }),
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
      prepareMcpAuthorization: vi.fn(async () => ({ kind: 'action' })),
      authorizeMcpServer: vi.fn(async () => ({ state: 'cancelled' })),
    };
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    mcpStatusByName.set(name, MCPServerStatus.CONNECTED);
    if (needsAuth) mcpServerRequiresOAuth.set(name, true);
    await startMcpAuth(name, serverConfig, config);
    setPreservedDetailServer(name);
    const { stdin, lastFrame, unmount, waitUntilReady } =
      await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config },
      );
    try {
      await waitUntilReady();
      expect(lastFrame()).toContain('Failed');
      expect(lastFrame()).toContain('Enter authenticate');
      expect(getMcpAuthSession(name).state).toBe('error');
      await act(async () => {
        stdin.write('\u001b[B');
      });
      await waitFor(() =>
        expect(lastFrame().replace(/\s/g, '')).toContain('❯Authenticate'),
      );
      await act(async () => {
        stdin.write('\r');
      });
      await waitFor(() =>
        expect(manager.authorizeMcpServer).toHaveBeenCalledTimes(2),
      );
    } finally {
      unmount();
      clearMcpAuthSession(name);
      mcpStatusByName.delete(name);
      mcpServerRequiresOAuth.delete(name);
    }
  });

  it('preserves an active session but discards its late cancellation after recovery', async () => {
    const name = 'late-auth-cancellation';
    const config = makeFakeConfig();
    const serverConfig = {
      timeout: 30000,
      hostEndpoint: 'https://mcp.example.com/mcp',
    };
    let cancel!: () => void;
    const outcome = new Promise<{ state: 'cancelled' }>((resolve) => {
      cancel = () => resolve({ state: 'cancelled' });
    });
    const manager = {
      onServerAuthorizationInvalidated,
      getMcpServers: () => ({ [name]: serverConfig }),
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => ({
        getStatus: () => MCPServerStatus.CONNECTED,
        getServerConfig: () => serverConfig,
      }),
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
      prepareMcpAuthorization: vi.fn(async () => ({ kind: 'action' })),
      authorizeMcpServer: vi.fn(() => outcome),
    };
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    mcpStatusByName.set(name, MCPServerStatus.CONNECTED);
    const task = startMcpAuth(name, serverConfig, config);
    setPreservedDetailServer(name);
    const { stdin, lastFrame, unmount, waitUntilReady } =
      await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config },
      );
    try {
      await waitUntilReady();
      expect(lastFrame()).toContain(
        'Authenticating… (waiting for browser callback)',
      );
      expect(getMcpAuthSession(name).state).toBe('running');
      await act(async () => {
        stdin.write('\u001b[B');
      });
      await waitFor(() =>
        expect(lastFrame().replace(/\s/g, '')).toContain('❯Authenticate'),
      );
      await act(async () => {
        stdin.write('\r');
      });
      expect(manager.authorizeMcpServer).toHaveBeenCalledOnce();
      await act(async () => {
        invalidateAuthorization(name);
        expect(getMcpAuthSession(name).state).toBe('idle');
        cancel();
        await task;
      });
      await waitFor(() => {
        expect(lastFrame()).toContain('✓ Authenticated');
        expect(lastFrame()).not.toContain('Authentication failed');
        expect(getMcpAuthSession(name).state).toBe('idle');
      });
    } finally {
      cancel();
      await act(async () => {
        await task;
      });
      unmount();
      clearMcpAuthSession(name);
      mcpStatusByName.delete(name);
    }
  });

  it('keeps expired ordinary OAuth credentials visible and allows Enter while connected', async () => {
    const name = 'expired-direct-oauth';
    const config = makeFakeConfig();
    const serverConfig = {
      type: 'http' as const,
      url: 'https://provider.example/mcp',
      oauth: { enabled: true },
    };
    const manager = {
      onServerAuthorizationInvalidated,
      getMcpServers: () => ({ [name]: serverConfig }),
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => ({
        getStatus: () => MCPServerStatus.CONNECTED,
        getServerConfig: () => serverConfig,
      }),
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
    };
    const credentials = vi
      .spyOn(MCPOAuthTokenStorage.prototype, 'getCredentials')
      .mockResolvedValue({
        token: { accessToken: 'test', expiresAt: Date.now() - 60_000 },
      } as never);
    const authenticate = vi
      .spyOn(MCPOAuthProvider.prototype, 'authenticate')
      .mockRejectedValue(new Error('Authentication stopped by test'));
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    mcpStatusByName.set(name, MCPServerStatus.CONNECTED);
    setPreservedDetailServer(name);
    const { stdin, lastFrame, unmount, waitUntilReady } =
      await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config, width: 80 },
      );
    try {
      await waitUntilReady();
      await waitFor(() =>
        expect(lastFrame().replace(/\s/g, '')).toContain('Tokenexpired'),
      );
      expect(lastFrame()).toContain('Enter authenticate');
      expect(lastFrame()).not.toContain('✓ Authenticated');
      expect(lastFrame().replace(/[ \t]+$/gm, '')).toMatchSnapshot(
        'expired direct OAuth',
      );
      await act(async () => {
        stdin.write('\u001b[B');
      });
      await waitFor(() =>
        expect(lastFrame().replace(/\s/g, '')).toContain('❯Authenticate'),
      );
      await act(async () => {
        stdin.write('\r');
      });
      await waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    } finally {
      unmount();
      clearMcpAuthSession(name);
      mcpStatusByName.delete(name);
      credentials.mockRestore();
      authenticate.mockRestore();
    }
  });

  it.each([80, 40])(
    'shows the effective connection and updates on reload at width %i',
    async (width) => {
      const config = makeFakeConfig();
      let managed = true;
      let hasClient = false;
      let clientStatus = MCPServerStatus.CONNECTED;
      const client = {
        getStatus: () => clientStatus,
        getServerConfig: () => ({
          type: 'http',
          url: 'https://example.com/mcp',
          ...(managed ? { hostEndpoint: 'https://gateway.example/mcp' } : {}),
        }),
      };
      const manager = {
        getMcpServers: () => ({
          'connection-demo': {
            type: 'http',
            url: 'https://example.com/mcp',
            // Deliberately differs from the live client to catch config-based guesses.
            ...(!managed
              ? { hostEndpoint: 'https://gateway.example/mcp' }
              : {}),
          },
        }),
        getServerStatus: (name: string) =>
          mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
        getMcpServerConfigurationError: () => undefined,
        getClientByName: (name: string) =>
          name === 'connection-demo' && hasClient ? client : undefined,
        isMcpServerBlockedByHostPolicy: () => false,
        getMcpServerDenyMessage: () => undefined,
      };
      mcpStatusByName.set('connection-demo', 'connected');
      vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
        authorizationManager(manager) as never,
      );
      const { stdin, lastFrame, waitUntilReady, unmount } =
        await renderWithProviders(
          <McpBrowser
            config={config}
            settings={mockSettings}
            onExit={vi.fn()}
          />,
          { config, width },
        );
      const refresh = async () => {
        await act(async () => {
          coreEvents.emit(CoreEvent.McpClientUpdate, {
            sessionId: 'test-session',
            clients: new Map(),
          });
          await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await waitUntilReady();
      };
      try {
        await waitUntilReady();
        for (let i = 0; i < 4; i++) {
          await act(async () => {
            stdin.write('\t');
          });
          await waitUntilReady();
        }
        await act(async () => {
          stdin.write('\r');
        });
        await waitUntilReady();
        expect(lastFrame()).toContain('Type');
        expect(lastFrame()).not.toContain('Connection');
        expect(lastFrame()).not.toContain('Host URL');

        hasClient = true;
        await refresh();
        expect(lastFrame().replace(/\s/g, '')).toContain(
          'ConnectionHostedMCPServer',
        );
        expect(lastFrame()).toMatchSnapshot('gateway connection');

        managed = false;
        await refresh();
        expect(lastFrame().replace(/\s/g, '')).toContain(
          'ConnectionDirectMCPServer',
        );
        expect(lastFrame()).not.toContain('Marketplace');
        expect(lastFrame().replace(/\s/g, '')).toContain(
          'HostURLhttps://gateway.example/mcp',
        );
        expect(lastFrame()).toMatchSnapshot('direct connection');

        // A stale global status must not override the live client's state.
        for (const status of [
          MCPServerStatus.CONNECTING,
          MCPServerStatus.DISCONNECTED,
        ]) {
          clientStatus = status;
          await refresh();
          expect(lastFrame()).not.toContain('Connection');
        }
        mcpStatusByName.set('connection-demo', 'disconnected');
        mcpServerRequiresOAuth.set('connection-demo', true);
        await refresh();
        expect(lastFrame()).toContain('needs authentication');
        expect(lastFrame()).not.toContain('Connection');
        expect(lastFrame().replace(/\s/g, '')).toContain(
          'HostURLhttps://gateway.example/mcp',
        );
        expect(lastFrame()).toMatchSnapshot('awaiting authentication');
      } finally {
        mcpStatusByName.delete('connection-demo');
        mcpServerRequiresOAuth.delete('connection-demo');
        unmount();
      }
    },
  );

  it('marks each scope that contains servers needing authentication', async () => {
    const config = makeFakeConfig();
    const manager = {
      getMcpServers: () => ({
        'needs-login': {
          url: 'https://example.com/mcp',
          plugin: { name: 'auth-plugin' },
        },
        ready: {
          url: 'https://example.com/ready',
          plugin: { name: 'auth-plugin' },
        },
      }),
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => undefined,
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
    };
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    mcpStatusByName.set('needs-login', 'disconnected');
    mcpStatusByName.set('ready', 'connected');
    mcpServerRequiresOAuth.set('needs-login', true);

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
      { config, width: 100 },
    );

    try {
      await waitUntilReady();
      expect(lastFrame()).toContain('Plugin (2) !');
    } finally {
      mcpServerRequiresOAuth.delete('needs-login');
      mcpStatusByName.delete('needs-login');
      mcpStatusByName.delete('ready');
      unmount();
    }
  });

  it('shows needs authentication for an auth_required server in the list', async () => {
    const config = makeFakeConfig();
    const manager = {
      getMcpServers: () => ({
        'needs-login': {
          type: 'http',
          url: 'https://example.com/mcp',
          scope: 'local',
        },
      }),
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => undefined,
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
    };
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    mcpStatusByName.set('needs-login', MCPServerStatus.AUTH_REQUIRED);
    mcpServerRequiresOAuth.set('needs-login', true);

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
      { config, width: 100 },
    );

    try {
      await waitUntilReady();
      expect(lastFrame()).toContain('needs authentication');
      expect(lastFrame()).not.toContain('disconnected');
      expect(lastFrame()).toContain('Local (1) !');
    } finally {
      mcpServerRequiresOAuth.delete('needs-login');
      mcpStatusByName.delete('needs-login');
      unmount();
    }
  });

  it('uses the effective config scope instead of shadowed file membership', async () => {
    const config = makeFakeConfig();
    const manager = {
      getMcpServers: () => ({
        'flag-shadow': {
          url: 'https://example.com/flag',
          scope: 'flag',
        },
        'project-only': {
          url: 'https://example.com/project',
          scope: 'project',
        },
      }),
      getServerStatus: () => MCPServerStatus.CONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => undefined,
      isMcpServerBlockedByHostPolicy: () => false,
      getMcpServerDenyMessage: () => undefined,
    };
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    const scopesSpy = vi
      .spyOn(localSettings, 'findMcpServerScopes')
      .mockReturnValue(['project']);
    const projectPathsSpy = vi
      .spyOn(localSettings, 'getProjectSourcePaths')
      .mockReturnValue(['/project/.mcp.json']);

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
      { config, width: 100 },
    );

    try {
      await waitUntilReady();
      expect(lastFrame()).toContain('Flag (1)');
      expect(lastFrame()).toContain('Project (1)');
    } finally {
      scopesSpy.mockRestore();
      projectPathsSpy.mockRestore();
      unmount();
    }
  });

  it('compacts a long user settings destination in the create row', async () => {
    const config = makeFakeConfig();
    const { stdin, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config, width: 80 },
      );

    await act(async () => {
      stdin.write('\t');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\t');
    });
    await waitUntilReady();

    const frame = lastFrame().replace(/\s/g, '');
    expect(frame).toContain('Searchuserservers');
    expect(frame).toContain('/mock/.../user-home/.abc/settings.json');
    unmount();
  });

  it.each([120, 60])(
    'shows address failures and recovery details at width %s',
    async (width) => {
      const scopes = vi
        .spyOn(localSettings, 'findMcpServerScopes')
        .mockReturnValue([]);
      const config = makeFakeConfig();
      let failed = true;
      const manager = {
        getMcpServers: () => ({
          Linear: {
            hostEndpoint: 'https://test-openapi.vpc.example.com.cn/mcp/linear',
          },
          Context7: { hostEndpoint: 'https://mcp.example.cn/mcp/context7' },
          qca: { command: 'qca' },
        }),
        getClientByName: () => undefined,
        getServerStatus: (name: string) =>
          mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
        getMcpServerConfigurationError: (name: string) =>
          failed && name !== 'qca'
            ? {
                message: 'internal diagnostic',
                configuredAddress:
                  name === 'Linear'
                    ? 'https://test-openapi.vpc.example.com.cn'
                    : 'https://mcp.example.cn',
                expectedAddress: 'https://demo-openapi.vpc.example.com.cn',
              }
            : undefined,
        isMcpServerBlockedByHostPolicy: (name: string) => name === 'qca',
        getMcpServerDenyMessage: () => undefined,
      };
      vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
        authorizationManager(manager) as never,
      );
      const rendered = await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config, width },
      );
      const { stdin, lastFrame, waitUntilReady, unmount } = rendered;
      await waitUntilReady();
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          stdin.write('\t');
        });
        await waitUntilReady();
      }
      expect(lastFrame()).toContain('Failed');
      expect(lastFrame()).toContain('Linear');
      expect(lastFrame()).toContain('Context7');
      await expect(rendered).toMatchSvgSnapshot({
        name: `failed-server-list-${width}`,
      });

      await act(async () => {
        stdin.write('\r');
      });
      await waitUntilReady();
      const text = lastFrame().replace(/\s/g, '');
      expect(text).toContain('Status:Failed');
      expect(text).toContain('MCPserveraddress');
      if (width === 120) {
        expect(text).toContain(
          'MCPserveraddresshttps://test-openapi.vpc.example.com.cndoesnotbelongtothecurrentenvironment.',
        );
      }
      expect(text).not.toContain('/mcpreload');
      const lines = lastFrame().split('\n');
      const errorLine = lines.findIndex((line) =>
        line.includes('MCP server address'),
      );
      expect(lines[errorLine + 1].trim()).toBe('');
      expect(lastFrame()).not.toContain('internal diagnostic');
      await expect(rendered).toMatchSvgSnapshot({
        name: `address-failure-details-${width}`,
      });

      failed = false;
      await act(async () => {
        coreEvents.emit(CoreEvent.McpClientUpdate, {
          sessionId: 'test-session',
          clients: new Map(),
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
      });
      await waitUntilReady();
      expect(lastFrame()).not.toContain('Status: Failed');
      expect(lastFrame()).not.toContain('MCP server address');
      unmount();
      scopes.mockRestore();
    },
  );

  it('renders host policy blocks as policy state instead of connection failure', async () => {
    const config = makeFakeConfig();
    let enterpriseBlocked = true;
    const manager = {
      getMcpServers: () => ({
        'enterprise-blocked': { command: 'node', args: ['server.js'] },
      }),
      getServerStatus: (name: string) =>
        mcpStatusByName.get(name) ?? MCPServerStatus.DISCONNECTED,
      getMcpServerConfigurationError: () => undefined,
      getClientByName: () => undefined,
      isMcpServerBlockedByHostPolicy: (name: string) =>
        name === 'enterprise-blocked' && enterpriseBlocked,
      getMcpServerDenyMessage: (name: string) =>
        name === 'enterprise-blocked' && enterpriseBlocked
          ? 'This MCP server has been disabled by enterprise policy. Contact your administrator.'
          : undefined,
    };
    vi.spyOn(config, 'getMcpClientManager').mockReturnValue(
      authorizationManager(manager) as never,
    );
    mcpStatusByName.set('enterprise-blocked', 'disconnected');

    const { stdin, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(
        <McpBrowser config={config} settings={mockSettings} onExit={vi.fn()} />,
        { config, width: 100 },
      );

    await waitUntilReady();
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        stdin.write('\t');
      });
      await waitUntilReady();
    }
    expect(lastFrame()).toContain('blocked by policy');
    expect(lastFrame()).not.toContain('○ disconnected');

    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('Status: blocked by policy');
    expect(lastFrame()).toContain(
      'This MCP server has been disabled by enterprise policy.',
    );
    expect(lastFrame()).toContain('Enabled');
    expect(lastFrame()).toContain('Yes');

    enterpriseBlocked = false;
    await act(async () => {
      coreEvents.emit(CoreEvent.McpClientUpdate, {
        sessionId: 'test-session',
        clients: new Map(),
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Status: disconnected');
    expect(lastFrame()).not.toContain(
      'This MCP server has been disabled by enterprise policy.',
    );

    mcpStatusByName.delete('enterprise-blocked');
    unmount();
  });
});

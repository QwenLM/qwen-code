/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClientManager } from './mcp-client-manager.js';
import { McpClient } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Config } from '../config/config.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';

vi.mock('./mcp-client.js', async () => {
  const originalModule = await vi.importActual('./mcp-client.js');
  return {
    ...originalModule,
    McpClient: vi.fn(),
    // Return the input servers unchanged (identity function)
    populateMcpServerCommand: vi.fn((servers) => servers),
  };
});

describe('McpClientManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should discover tools from all servers', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    await manager.discoverAllMcpTools(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();
  });

  it('should not discover tools if folder is not trusted', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => false,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    await manager.discoverAllMcpTools(mockConfig);
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('does not connect project-scoped servers pending approval', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        project: {
          command: 'node',
          pendingApproval: true,
          source: 'project',
        },
      }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverAllMcpTools(mockConfig);

    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('should disconnect all clients when stop is called', async () => {
    // Track disconnect calls across all instances
    const disconnectCalls: string[] = [];
    vi.mocked(McpClient).mockImplementation(
      (name: string) =>
        ({
          connect: vi.fn(),
          discover: vi.fn(),
          disconnect: vi.fn().mockImplementation(() => {
            disconnectCalls.push(name);
            return Promise.resolve();
          }),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {}, 'another-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    // First connect to create the clients
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
      isMcpServerDisabled: () => false,
    } as unknown as Config);

    // Clear the disconnect calls from initial stop() in discoverAllMcpTools
    disconnectCalls.length = 0;

    // Then stop
    await manager.stop();
    expect(disconnectCalls).toHaveLength(2);
    expect(disconnectCalls).toContain('test-server');
    expect(disconnectCalls).toContain('another-server');
  });

  it('should be idempotent - stop can be called multiple times safely', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
      isMcpServerDisabled: () => false,
    } as unknown as Config);

    // Call stop multiple times - should not throw
    await manager.stop();
    await manager.stop();
    await manager.stop();
  });

  it('should discover tools for a single server and track the client for stop', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();

    await manager.stop();
    expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
  });

  it('should replace an existing client when re-discovering a server', async () => {
    const firstClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    const secondClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };

    vi.mocked(McpClient)
      .mockReturnValueOnce(firstClient as unknown as McpClient)
      .mockReturnValueOnce(secondClient as unknown as McpClient);

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    expect(firstClient.disconnect).toHaveBeenCalledOnce();
    expect(secondClient.connect).toHaveBeenCalledOnce();
    expect(secondClient.discover).toHaveBeenCalledOnce();

    await manager.stop();
    expect(secondClient.disconnect).toHaveBeenCalledOnce();
  });

  it('should coalesce concurrent discovery for the same server', async () => {
    let resolveDisconnect!: () => void;
    const disconnectPromise = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    const firstClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(() => disconnectPromise),
      getStatus: vi.fn(),
    };
    const replacementClients: Array<{
      connect: ReturnType<typeof vi.fn>;
      discover: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      getStatus: ReturnType<typeof vi.fn>;
    }> = [];

    vi.mocked(McpClient).mockImplementation(() => {
      if (vi.mocked(McpClient).mock.calls.length === 1) {
        return firstClient as unknown as McpClient;
      }

      const replacementClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        discover: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn(),
      };
      replacementClients.push(replacementClient);
      return replacementClient as unknown as McpClient;
    });

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    const firstRediscovery = manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    await Promise.resolve();

    const secondRediscovery = manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    const disconnectCallsBeforeResolve =
      firstClient.disconnect.mock.calls.length;

    resolveDisconnect();
    await Promise.all([firstRediscovery, secondRediscovery]);

    expect(disconnectCallsBeforeResolve).toBe(1);
    expect(vi.mocked(McpClient)).toHaveBeenCalledTimes(2);
    expect(replacementClients).toHaveLength(1);
    expect(replacementClients[0].connect).toHaveBeenCalledOnce();
    expect(replacementClients[0].discover).toHaveBeenCalledOnce();

    // Verify map was cleaned up: a third call should do real work,
    // not get coalesced into a stale promise.
    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    expect(vi.mocked(McpClient)).toHaveBeenCalledTimes(3);
    expect(replacementClients).toHaveLength(2);
    expect(replacementClients[1].connect).toHaveBeenCalledOnce();
    expect(replacementClients[1].discover).toHaveBeenCalledOnce();
  });

  it('should restore health checks after failed server rediscovery', async () => {
    vi.useFakeTimers();

    const firstClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    const failedClient = {
      connect: vi.fn().mockRejectedValue(new Error('transient failure')),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient)
      .mockReturnValueOnce(firstClient as unknown as McpClient)
      .mockReturnValueOnce(failedClient as unknown as McpClient);

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(
      mockConfig,
      {} as ToolRegistry,
      undefined,
      undefined,
      {
        autoReconnect: true,
        checkIntervalMs: 10,
        maxConsecutiveFailures: 1,
        reconnectDelayMs: 10,
      },
    );

    try {
      await manager.discoverMcpToolsForServer(
        'test-server',
        {} as unknown as Config,
      );
      expect(
        (
          manager as unknown as {
            healthCheckTimers: Map<string, NodeJS.Timeout>;
          }
        ).healthCheckTimers.has('test-server'),
      ).toBe(true);

      await manager.discoverMcpToolsForServer(
        'test-server',
        {} as unknown as Config,
      );

      expect(failedClient.connect).toHaveBeenCalledOnce();
      expect(
        (
          manager as unknown as {
            healthCheckTimers: Map<string, NodeJS.Timeout>;
          }
        ).healthCheckTimers.has('test-server'),
      ).toBe(true);
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it('should clear in-flight discovery tracking when stopping', async () => {
    let resolveConnect!: () => void;
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const mockedMcpClient = {
      connect: vi.fn(() => connectPromise),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    const discovery = manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    await Promise.resolve();

    expect(
      (
        manager as unknown as {
          serverDiscoveryPromises: Map<string, Promise<void>>;
        }
      ).serverDiscoveryPromises.has('test-server'),
    ).toBe(true);

    await manager.stop();

    expect(
      (
        manager as unknown as {
          serverDiscoveryPromises: Map<string, Promise<void>>;
        }
      ).serverDiscoveryPromises.has('test-server'),
    ).toBe(false);

    resolveConnect();
    await discovery;
  });

  it('should no-op when discovering an unknown server', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer('unknown-server', {
      isTrustedFolder: () => true,
    } as unknown as Config);

    expect(vi.mocked(McpClient)).not.toHaveBeenCalled();
  });

  it('discoverAllMcpToolsIncremental enforces a per-server discoveryTimeoutMs', async () => {
    // A stdio server whose `connect` hangs forever. The 50ms per-server
    // timeout should fire and surface as a swallowed error, leaving the
    // manager in COMPLETED state instead of stuck.
    let neverResolve!: () => void;
    const hung = new Promise<void>((resolve) => {
      neverResolve = resolve;
    });
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(hung),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        broken: { command: 'node', args: [], discoveryTimeoutMs: 50 },
      }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry);

    const t0 = Date.now();
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    // Generous upper bound — the 50ms timeout should fire well within 2s
    // even on a heavily-loaded CI runner.
    expect(elapsed).toBeLessThan(2000);
    // discoveryAllMcpToolsIncremental must always settle the state, even
    // when every server times out. Otherwise the cli's deferred-finalize
    // path would hang forever.
    expect(manager.getDiscoveryState()).toBe(
      (await import('./mcp-client.js')).MCPDiscoveryState.COMPLETED,
    );

    // Cleanup the stuck connect so test doesn't leak a pending promise.
    neverResolve();
  });

  it('discoverAllMcpToolsIncremental skips servers flagged as disabled', async () => {
    // PR-A regression guard: the new incremental path used to iterate
    // `Object.entries(servers)` without consulting `isMcpServerDisabled`,
    // so a server the user had explicitly disabled (e.g. via
    // `mcpServers.foo.disabled: true`) would still get connected and its
    // tools registered. Mirrors the existing protection in
    // `discoverAllMcpTools`.
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        enabled: { command: 'node', args: [] },
        disabled: { command: 'node', args: [] },
      }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: (name: string) => name === 'disabled',
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // Only the enabled server should have driven a discover; the disabled
    // one is skipped before any connect attempt.
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.discover).toHaveBeenCalledTimes(1);
  });

  it('discoverAllMcpToolsIncremental tears down enabled→disabled transitions', async () => {
    // Mid-session, the user disables a previously-connected server (e.g.
    // via `/mcp disable foo` or by editing settings). The incremental
    // path must tear down the existing client, drop its registered tools,
    // stop its health check, and remove its global status — otherwise
    // the Footer pill keeps counting it, its tools stay live in the
    // ToolRegistry, and the health-check loop keeps probing a server
    // the user has told us to ignore.
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const removeMcpToolsByServer = vi.fn();
    const toolRegistryStub = {
      removeMcpToolsByServer,
    } as unknown as ToolRegistry;

    let disabled = false;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ foo: { command: 'node', args: [] } }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: (name: string) => name === 'foo' && disabled,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, toolRegistryStub);

    // First pass: server enabled, gets connected.
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Now disable mid-session and re-run incremental discovery.
    disabled = true;
    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // The previously-connected client must be disconnected and its tools
    // dropped from the registry.
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('foo');
    // And no fresh connect was attempted (the disabled branch fires
    // before serversToUpdate is populated).
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
  });

  it('discoverAllMcpToolsIncremental records `failed` outcome for swallowed connect errors', async () => {
    // `discoverMcpToolsForServerInternal` catches connect/discover errors
    // without re-throwing (best-effort semantics — one broken server
    // shouldn't bring down the others). Before this fix, the try block in
    // `discoverAllMcpToolsIncremental` therefore resolved even for failed
    // servers, and we'd record `mcp_server_ready:<name>` with
    // `outcome: 'ready'`. Now we consult the actual server status (set
    // to DISCONNECTED by McpClient.connect's catch) and emit `failed`
    // instead — otherwise the startup profile claims success for every
    // auth error / crashed server.
    const events: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
    const startupEventSink = await import('../utils/startupEventSink.js');
    startupEventSink.setStartupEventSink((name, attrs) => {
      events.push({ name, attrs });
    });

    const mockedMcpClient = {
      connect: vi.fn().mockRejectedValue(new Error('auth failed')),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'broken-auth': { command: 'node', args: [] } }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // Cleanup the global sink so it doesn't leak into other tests.
    startupEventSink.setStartupEventSink(null);

    const readyEvents = events.filter(
      (e) => e.name === 'mcp_server_ready:broken-auth',
    );
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0].attrs?.['outcome']).toBe('failed');
    // And no `mcp_first_tool_registered` was emitted — that metric is
    // user-facing ("first MCP server became usable") so a failed server
    // must not pollute it.
    const firstToolEvents = events.filter(
      (e) => e.name === 'mcp_first_tool_registered',
    );
    expect(firstToolEvents).toHaveLength(0);
  });

  it('discoveryTimeoutMs is clamped to a minimum and maximum', async () => {
    // A 0 or negative override would cause the timeout to fire on the
    // very next macrotask, racing the connect() handshake. Combined with
    // the lack of disconnect-on-timeout this used to be a silent tool
    // registration vector. The clamp puts the floor at 100ms.
    const calls: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      cb: () => void,
      ms?: number,
    ) => {
      if (typeof ms === 'number') calls.push(ms);
      return realSetTimeout(cb, ms ?? 0);
    }) as unknown as typeof setTimeout);

    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        zero: { command: 'node', args: [], discoveryTimeoutMs: 0 },
        negative: { command: 'node', args: [], discoveryTimeoutMs: -5 },
        huge: { command: 'node', args: [], discoveryTimeoutMs: 10_000_000 },
      }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry);
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    spy.mockRestore();

    // Among the values setTimeout was called with, look only at the ones
    // our discoveryTimeoutFor would have produced: 100 (clamped floor)
    // and 300_000 (clamped ceiling). Other timers (test infra, vitest)
    // may be in `calls` but never both 100 AND 300000 by coincidence.
    expect(calls).toContain(100);
    expect(calls).toContain(300_000);
    expect(calls).not.toContain(0);
    expect(calls).not.toContain(-5);
    expect(calls).not.toContain(10_000_000);
  });

  it('discoveryTimeoutFor treats websocket (tcp) transport as remote', async () => {
    // The remote-vs-stdio classification gates the 5s vs 30s default
    // timeout. `tcp` is the WebSocket transport field on MCPServerConfig
    // — without it, hung WS handshakes would block `waitForMcpReady()`
    // for 30s instead of 5s.
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(new Promise<void>(() => {})),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const calls: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      cb: () => void,
      ms?: number,
    ) => {
      if (typeof ms === 'number') calls.push(ms);
      // Fire immediately to settle quickly without waiting 5s/30s.
      return realSetTimeout(cb, 1);
    }) as unknown as typeof setTimeout);

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ wsServer: { tcp: 'ws://example.test' } }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry);
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    spy.mockRestore();

    expect(calls).toContain(5_000);
    expect(calls).not.toContain(30_000);
  });

  it('runWithDiscoveryTimeout disconnects the client AND drops registered tools on timeout', async () => {
    // Before this fix, the inner `discoverMcpToolsForServer` kept running
    // after the timeout rejected the outer promise. If `client.discover()`
    // eventually succeeded it would register the late-arriving server's
    // tools into the live toolRegistry (a remote-exploitable silent
    // registration).
    //
    // Disconnecting the client on timeout aborts the handshake, but a
    // fire-and-forget `void disconnect()` doesn't help when `discover()`
    // already pumped tools into the registry synchronously — the
    // transport close lands a tick later. We therefore (a) await the
    // disconnect and (b) call `removeMcpToolsByServer()` to drop any
    // tools that slipped through the race window.
    let resolveConnect!: () => void;
    const hungConnect = new Promise<void>((res) => {
      resolveConnect = res;
    });
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(hungConnect),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        slow: { command: 'node', args: [], discoveryTimeoutMs: 100 },
      }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const removeMcpToolsByServer = vi.fn();
    const manager = new McpClientManager(mockConfig, {
      removeMcpToolsByServer,
    } as unknown as ToolRegistry);

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // The timeout must have triggered the disconnect — that's what
    // aborts the connect() handshake so no tools land.
    expect(mockedMcpClient.disconnect).toHaveBeenCalled();
    // And any tools that registered during the disconnect race window
    // must have been removed from the registry.
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('slow');

    // Cleanup the hung promise to avoid leaking it across tests.
    resolveConnect();
  });

  it('runWithDiscoveryTimeout drops the client + stops health-check so the auto-reconnect loop cannot resurrect an intentionally timed-out server', async () => {
    // Round-7 regression: before this fix, the timeout handler removed
    // tools but left the client in `this.clients` and didn't stop its
    // health-check timer. `discoverMcpToolsForServerInternal`'s `finally`
    // block would then `startHealthCheck`, which (with `autoReconnect`)
    // detects `status !== CONNECTED`, increments the failure counter for
    // ~maxConsecutiveFailures intervals, and calls `reconnectServer()` →
    // `discoverMcpToolsForServer()` directly — bypassing
    // `runWithDiscoveryTimeout` entirely. The intentionally slow server
    // would silently come back.
    let resolveConnect!: () => void;
    const hungConnect = new Promise<void>((res) => {
      resolveConnect = res;
    });
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(hungConnect),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        slow: { command: 'node', args: [], discoveryTimeoutMs: 100 },
      }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry);

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // The client entry must be gone — otherwise `performHealthCheck`
    // would observe it (and the disconnected status) every checkInterval.
    expect(
      (manager as unknown as { clients: Map<string, unknown> }).clients.has(
        'slow',
      ),
    ).toBe(false);
    // And no health-check timer must remain for this server.
    expect(
      (
        manager as unknown as {
          healthCheckTimers: Map<string, NodeJS.Timeout>;
        }
      ).healthCheckTimers.has('slow'),
    ).toBe(false);

    // Cleanup the hung promise to avoid leaking it across tests.
    resolveConnect();
  });

  it('discoverAllMcpToolsIncremental emits the trailing mcp-client-update after COMPLETED', async () => {
    // Without the trailing emit, the cli's deferred-finalize subscriber
    // (which polls discoveryState on each `mcp-client-update`) would never
    // observe the terminal state. Regression-protect the emit ordering.
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mcpClientModule = await import('./mcp-client.js');
    const { MCPDiscoveryState } = mcpClientModule;
    const observedStatesAtEmit: Array<
      (typeof mcpClientModule.MCPDiscoveryState)[keyof typeof mcpClientModule.MCPDiscoveryState]
    > = [];
    const events = {
      emit: vi.fn((eventName: string) => {
        if (eventName === 'mcp-client-update') {
          observedStatesAtEmit.push(manager.getDiscoveryState());
        }
        return true;
      }),
    } as unknown as import('node:events').EventEmitter;

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: { command: 'node', args: [] } }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(
      mockConfig,
      {} as ToolRegistry,
      events,
    );

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // Must include at least one COMPLETED-state emit at the tail.
    expect(observedStatesAtEmit.at(-1)).toBe(MCPDiscoveryState.COMPLETED);
    // And must have started with an IN_PROGRESS emit (so progress UI shows
    // the transition even when there are no servers to update).
    expect(observedStatesAtEmit[0]).toBe(MCPDiscoveryState.IN_PROGRESS);
  });
});

// Issue #4175 PR 14: MCP client guardrails (counter + slot reservation +
// budget enforcement). Kept in its own describe so the existing test
// suite stays untouched and a future revert of PR 14 drops a single
// contiguous block.
describe('McpClientManager — PR 14 guardrails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    delete process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  });

  /**
   * Mock factory: returns a fresh stub McpClient whose `getStatus()`
   * returns CONNECTED after `connect()` resolves. Mirrors the
   * `discoverAllMcpTools` happy path — counter sees the client as
   * live only when `getStatus === CONNECTED`, so without flipping
   * the mock status the accounting would always read zero.
   */
  function makeConnectedMcpClientMock() {
    // Real McpClient.getStatus is sync — start CONNECTED so accounting
    // sees it as live immediately after construction. `connect()` is a
    // no-op (we don't simulate handshake state machinery in unit
    // tests; the accounting cares only about the final status).
    const state = { status: undefined as unknown };
    return {
      connect: vi.fn().mockImplementation(async () => {
        const { MCPServerStatus } = await import('./mcp-client.js');
        state.status = MCPServerStatus.CONNECTED;
      }),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => state.status),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
  }

  function configWithServers(
    servers: Record<string, unknown>,
    overrides: Partial<Config> = {},
  ): Config {
    return {
      isTrustedFolder: () => true,
      getMcpServers: () => servers,
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
      ...overrides,
    } as unknown as Config;
  }

  it('getMcpClientAccounting returns zero on an empty manager', async () => {
    const { McpClientManager: MgrCtor } = await import(
      './mcp-client-manager.js'
    );
    const config = configWithServers({});
    const manager = new MgrCtor(config, {} as ToolRegistry);
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(0);
    expect(accounting.subprocessCount).toBe(0);
    expect(accounting.reservedSlots).toEqual([]);
    expect(accounting.refusedServerNames).toEqual([]);
    expect(accounting.byTransport).toEqual({
      stdio: 0,
      sse: 0,
      http: 0,
      websocket: 0,
      sdk: 0,
      unknown: 0,
    });
  });

  it('mcpTransportOf maps each transport family correctly', async () => {
    const { mcpTransportOf } = await import('./mcp-client-manager.js');
    const cfg = (overrides: Record<string, unknown>) =>
      overrides as unknown as import('../config/config.js').MCPServerConfig;
    expect(mcpTransportOf(cfg({ command: 'node' }))).toBe('stdio');
    expect(mcpTransportOf(cfg({ httpUrl: 'http://x' }))).toBe('http');
    expect(mcpTransportOf(cfg({ url: 'http://x' }))).toBe('sse');
    expect(mcpTransportOf(cfg({ tcp: 'ws://x' }))).toBe('websocket');
    expect(mcpTransportOf(cfg({}))).toBe('unknown');
    // SDK detection short-circuits: even with a placeholder command,
    // an SDK-marked server reports `sdk` (not `stdio`).
    expect(mcpTransportOf(cfg({ type: 'sdk', command: 'node' }))).toBe('sdk');
  });

  it('enforce mode refuses connects past the budget', async () => {
    const created: Array<ReturnType<typeof makeConnectedMcpClientMock>> = [];
    vi.mocked(McpClient).mockImplementation(() => {
      const m = makeConnectedMcpClientMock();
      created.push(m);
      return m as unknown as McpClient;
    });
    // 4 stdio servers, budget 2. enforce mode refuses 2.
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 2, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(created).toHaveLength(2); // only 2 McpClient instances created
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(2);
    expect(accounting.byTransport.stdio).toBe(2);
    expect(accounting.subprocessCount).toBe(2);
    expect(accounting.reservedSlots.sort()).toEqual(['a', 'b']);
    expect(accounting.refusedServerNames.sort()).toEqual(['c', 'd']);
  });

  it('warn mode never refuses but tracks oversized reservations', async () => {
    const created: Array<ReturnType<typeof makeConnectedMcpClientMock>> = [];
    vi.mocked(McpClient).mockImplementation(() => {
      const m = makeConnectedMcpClientMock();
      created.push(m);
      return m as unknown as McpClient;
    });
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 2, budgetMode: 'warn' },
    );
    await manager.discoverAllMcpTools(config);
    // warn mode: all 3 connect; reservedSlots grows past budget; no refusals.
    expect(created).toHaveLength(3);
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(3);
    expect(accounting.reservedSlots.sort()).toEqual(['a', 'b', 'c']);
    expect(accounting.refusedServerNames).toEqual([]);
  });

  it('off mode does not reserve any slot', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { budgetMode: 'off' },
    );
    await manager.discoverAllMcpTools(config);
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(2);
    // `off` skips reservation altogether — operators see live count via
    // `total`, but reservedSlots stays empty.
    expect(accounting.reservedSlots).toEqual([]);
    expect(accounting.refusedServerNames).toEqual([]);
  });

  it('refusal is deterministic by config-declaration order', async () => {
    const created: string[] = [];
    vi.mocked(McpClient).mockImplementation((name: string) => {
      created.push(name);
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    // Insertion order: zulu, alpha, mike. Budget 2 → zulu+alpha survive.
    const config = configWithServers({
      zulu: { command: 'node' },
      alpha: { command: 'node' },
      mike: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 2, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(created).toEqual(['zulu', 'alpha']);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([
      'mike',
    ]);
  });

  it('discoverAllMcpTools resets lastRefusedServerNames each pass', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);

    // Second pass: stop()→clear→re-run. The reset happens at the start
    // of discoverAllMcpTools (see also stop() clearing reservedSlots).
    await manager.discoverAllMcpTools(config);
    // Same outcome (still budget 1, still 2 servers), but the array
    // is fresh — not appended to.
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);
  });

  it('readResource throws BudgetExhaustedError in enforce mode when full', async () => {
    const { BudgetExhaustedError } = await import('./mcp-client-manager.js');
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    // `a` was reserved; `b` was refused. A `readResource('b', ...)` would
    // lazy-spawn — must throw rather than silently exceed the cap.
    await expect(manager.readResource('b', 'file:///x')).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });

  it('disconnectServer releases the slot for re-use', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual(['a']);
    await manager.disconnectServer('a');
    // Slot released — accounting shows the configured set shrank.
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
  });

  it('env var fallback resolves budget + mode when constructor omits opts', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '7';
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'enforce';
    const config = configWithServers({});
    const manager = new McpClientManager(config, {} as ToolRegistry);
    expect(manager.getMcpClientBudget()).toBe(7);
    expect(manager.getMcpBudgetMode()).toBe('enforce');
  });

  it('env var fallback defaults mode to warn when only budget is set', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '5';
    // No mode env var. Resolved mode is `warn` (the safe default).
    const config = configWithServers({});
    const manager = new McpClientManager(config, {} as ToolRegistry);
    expect(manager.getMcpClientBudget()).toBe(5);
    expect(manager.getMcpBudgetMode()).toBe('warn');
  });

  it('env var fallback rejects non-positive budgets silently', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '-3';
    const config = configWithServers({});
    const manager = new McpClientManager(config, {} as ToolRegistry);
    // Invalid values fall through to `undefined` budget + `off` mode —
    // no enforcement, no boot-time crash. Validation lives in the CLI
    // flag handler (`packages/cli/src/commands/serve.ts`).
    expect(manager.getMcpClientBudget()).toBeUndefined();
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  it('disabled servers do not consume a budget slot', async () => {
    const created: string[] = [];
    vi.mocked(McpClient).mockImplementation((name: string) => {
      created.push(name);
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    // `b` is disabled — must not even attempt to reserve. With budget=2,
    // `a` and `c` should both succeed (b is invisible to the gate, so it
    // doesn't consume a slot; the cap is enough for the remaining two).
    const config = configWithServers(
      {
        a: { command: 'node' },
        b: { command: 'node' },
        c: { command: 'node' },
      },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'b') as Config['isMcpServerDisabled'],
      },
    );
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 2, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(created.sort()).toEqual(['a', 'c']);
    expect(manager.getMcpClientAccounting().reservedSlots.sort()).toEqual([
      'a',
      'c',
    ]);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([]);
  });

  // PR 14 fix (review #4247): regression tests for the four bypass /
  // ordering / staleness bugs the Codex + Copilot reviews caught.
  it('single-server rediscovery respects the budget gate (review #1)', async () => {
    const created: string[] = [];
    vi.mocked(McpClient).mockImplementation((name: string) => {
      created.push(name);
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    // `b` was refused at startup. A manual `/mcp reconnect b` (which goes
    // through `discoverMcpToolsForServer` → `...Internal`) would have
    // pre-fix bypassed the gate and exceeded the cap. Now it must stay
    // refused.
    expect(created).toEqual(['a']);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);
    await manager.discoverMcpToolsForServer('b', config);
    expect(created).toEqual(['a']); // no new McpClient created
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual(['a']);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);
  });

  it('disconnectServer-then-disable drops refusal tag (review #4)', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);
    // Operator action: explicit disconnect of `b` should drop it from
    // the refusal log so a snapshot doesn't keep tagging the now-
    // operator-disabled server with `budget_exhausted`.
    await manager.disconnectServer('b');
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([]);
  });

  it('incremental discovery frees removed slots BEFORE reserving new ones (review #5)', async () => {
    let inflight = 0;
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    inflight = 0;
    const mcpServers: Record<string, { command: string }> = {
      a: { command: 'node' },
      b: { command: 'node' },
    };
    const config = {
      isTrustedFolder: () => true,
      getMcpServers: () => mcpServers,
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(
      config,
      {
        removeMcpToolsByServer: () => undefined,
      } as unknown as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 2, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpToolsIncremental(config);
    expect(manager.getMcpClientAccounting().reservedSlots.sort()).toEqual([
      'a',
      'b',
    ]);

    // Swap b → c (still budget=2). Pre-fix order: `c` refused because
    // `b`'s slot was only freed after the new-server loop. Post-fix:
    // `b` removed first → reservedSlots={a} → `c` reserved.
    delete mcpServers['b'];
    mcpServers['c'] = { command: 'node' };
    await manager.discoverAllMcpToolsIncremental(config);
    expect(manager.getMcpClientAccounting().reservedSlots.sort()).toEqual([
      'a',
      'c',
    ]);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([]);
    void inflight;
  });

  it('buildBudgetCells deferred to acpAgent — manager off-mode returns no budget bookkeeping (review #2)', async () => {
    // Sibling check: when `mode === 'off'` the manager doesn't reserve
    // anything and the snapshot has empty `reservedSlots` + zero
    // `refusedServerNames`. The empty-`budgets[]` assertion lives in
    // the serve route test (`server.test.ts`) because the cell is
    // built by `acpAgent.buildBudgetCells`. This test just pins the
    // manager-side invariant: off-mode is pure observability.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { budgetMode: 'off' },
    );
    await manager.discoverAllMcpTools(config);
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(2);
    expect(accounting.reservedSlots).toEqual([]);
    expect(accounting.refusedServerNames).toEqual([]);
  });

  // Round 2 review fixes (PR #4247 wenshao Critical 2, Critical 3, Suggestion 4).
  it('connect() failure releases the reserved slot in discoverAllMcpTools (wenshao C2)', async () => {
    // Failing client: getStatus stays DISCONNECTED; connect() throws.
    // Pre-fix the slot stayed reserved → permanent leak under enforce
    // → second server couldn't claim a freed slot until full restart.
    let firstCall = true;
    vi.mocked(McpClient).mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return {
          connect: vi.fn().mockRejectedValue(new Error('boom')),
          discover: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn(),
        } as unknown as McpClient;
      }
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers({
      a: { command: 'node' }, // will fail
      b: { command: 'node' }, // would be refused pre-fix
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    // `a` failed → slot freed → `b` ought to fit (budget=1, current=0
    // after `a` released). But discoverAllMcpTools walks all servers
    // concurrently — `b` may have been refused at the time of its
    // synchronous reserve check (before `a` released). What we MUST
    // assert is the post-conditions: `a` released its slot, `a` not
    // in clients map. `b` may be either reserved or refused depending
    // on the schedule, but the slot leak itself is gone.
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.reservedSlots).not.toContain('a');
    // No leaked client entry either:
    expect(
      (manager as unknown as { clients: Map<string, unknown> }).clients.has(
        'a',
      ),
    ).toBe(false);
  });

  it('connect() failure in readResource releases the slot AND re-throws (wenshao C3)', async () => {
    let getResourceCalled = false;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          // Stays disconnected → readResource code path forces a
          // `client.connect()` before `client.readResource(...)`.
          connect: vi.fn().mockRejectedValue(new Error('lazy connect boom')),
          discover: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn(),
          readResource: vi.fn().mockImplementation(() => {
            getResourceCalled = true;
            return Promise.resolve({});
          }),
        }) as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    // No discovery yet → `a` not in clients → lazy spawn path.
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      'lazy connect boom',
    );
    // Slot must NOT leak — pre-fix one failed readResource permanently
    // burned a budget slot.
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
    expect(
      (manager as unknown as { clients: Map<string, unknown> }).clients.has(
        'a',
      ),
    ).toBe(false);
    // And the readResource ext-method was never reached (we threw at connect).
    expect(getResourceCalled).toBe(false);
  });

  it('readBudgetFromEnv downgrades enforce-without-budget to off (wenshao S4)', async () => {
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'enforce';
    // No QWEN_SERVE_MCP_CLIENT_BUDGET — silently fail-open pre-fix:
    // `tryReserveSlot` returns 'reserved' when `clientBudget === undefined`,
    // so an "enforce" daemon would let unlimited servers through.
    const config = configWithServers({});
    const manager = new McpClientManager(config, {} as ToolRegistry);
    expect(manager.getMcpClientBudget()).toBeUndefined();
    // Downgraded — not 'enforce' — because enforce requires a budget.
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  // Round 3 review fixes (PR #4247 wenshao second pass).
  it('readResource rejects disabled servers before checking budget (wenshao R3 #5)', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    // Pre-fix the lazy spawn path bypassed `isMcpServerDisabled`,
    // so a disabled server could be resurrected by a resource read.
    const config = configWithServers(
      {
        a: { command: 'node' },
      },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'a') as Config['isMcpServerDisabled'],
      },
    );
    const manager = new McpClientManager(config, {} as ToolRegistry);
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is disabled/,
    );
  });

  it('readResource disabled gate fires BEFORE budget gate (wenshao R3 #5 precedence)', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    // Set up a budget-exhausted scenario + disable the target. The
    // disabled error must win over the budget error (matches the
    // per-server cell precedence: disabled wins).
    const config = configWithServers(
      {
        a: { command: 'node' },
        b: { command: 'node' },
      },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'b') as Config['isMcpServerDisabled'],
      },
    );
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    // Even though `b` would be budget-refused if not disabled, the
    // disabled gate must trip first.
    await expect(manager.readResource('b', 'file:///x')).rejects.toThrow(
      /'b' is disabled/,
    );
  });

  it('exports MCP_BUDGET_WARN_FRACTION constant (wenshao R3 #7)', async () => {
    const { MCP_BUDGET_WARN_FRACTION } = await import(
      './mcp-client-manager.js'
    );
    // Pinned to 0.75 to match PR 10's slow_client_warning hysteresis
    // primer (eventBus.ts WARN_THRESHOLD_RATIO). PR 14b will introduce
    // the matching reset fraction (0.375) to complete the dual-threshold
    // pair; this test is a tripwire against accidental fraction drift.
    expect(MCP_BUDGET_WARN_FRACTION).toBe(0.75);
  });

  // Round 4 review fixes (PR #4247 wenshao R3-R4 zombie leak in internal path).
  it('discoverMcpToolsForServer fresh-reserve connect-failure releases slot (wenshao R4 C2)', async () => {
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockRejectedValue(new Error('boom')),
          discover: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ x: { command: 'node' } });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    // Server `x` not previously reserved; this call freshly reserves
    // then connect() throws. Pre-fix the slot leaked permanently
    // under enforce mode, blocking any later server in `clients.size=1`.
    await manager.discoverMcpToolsForServer('x', config);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
    expect(
      (manager as unknown as { clients: Map<string, unknown> }).clients.has(
        'x',
      ),
    ).toBe(false);
  });

  // R8 #4 (line 1221): the `freshReservations` Set distinguishes
  // fresh-reservation timeouts (release) from `'already_held'`
  // reconnect timeouts (keep slot). Verified by code inspection +
  // the R5 release-on-fresh test below; a dedicated already_held
  // timeout test requires either driving the health-monitor flow
  // end-to-end (which needs autoReconnect timer interleaving with
  // fake timers — interferes with the sibling R5 test in the same
  // file) or piercing the private `runWithDiscoveryTimeout`
  // helper. The invariant is small enough that the fresh-release
  // test below is sufficient regression coverage; an integration
  // test in a separate file can add the already_held variant
  // without the timer interleave problem.
  it('runWithDiscoveryTimeout timeout handler releases the budget slot (wenshao R5 line 956)', async () => {
    vi.useFakeTimers();
    // McpClient.connect never resolves → timeout fires.
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn(() => new Promise(() => {})),
          discover: vi.fn(),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ a: { command: 'node' } });
    const manager = new McpClientManager(
      config,
      { removeMcpToolsByServer: () => undefined } as unknown as ToolRegistry,
      undefined,
      undefined,
      {
        autoReconnect: false,
        checkIntervalMs: 100,
        maxConsecutiveFailures: 1,
        reconnectDelayMs: 100,
      },
      { clientBudget: 2, budgetMode: 'enforce' },
    );
    const discoveryPromise = manager.discoverAllMcpToolsIncremental(config);
    // Advance past the stdio default discovery timeout (30s).
    await vi.advanceTimersByTimeAsync(31_000);
    await discoveryPromise;
    // Pre-fix the timeout cleaned up clients but not reservedSlots,
    // permanently consuming a budget slot.
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
    vi.useRealTimers();
  });

  it('incremental discovery still refuses past the cap after R6 pre-reservation removal (wenshao R6 line 956)', async () => {
    // Round 6 removed the duplicate pre-reservation in
    // discoverAllMcpToolsIncremental — refusal now happens INSIDE
    // discoverMcpToolsForServerInternal's tryReserveSlot. Verify
    // the observable refusal behavior is unchanged from the outside.
    const created: string[] = [];
    vi.mocked(McpClient).mockImplementation((name: string) => {
      created.push(name);
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers({
      first: { command: 'node' },
      second: { command: 'node' },
      third: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      { removeMcpToolsByServer: () => undefined } as unknown as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 2, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpToolsIncremental(config);
    // First two declared servers fit; third refused. Refusal-order
    // determinism preserved (config-declaration order) — the inner
    // tryReserveSlot is called in the same serversToUpdate iteration
    // order as the outer walk produced.
    expect(created).toEqual(['first', 'second']);
    expect(manager.getMcpClientAccounting().reservedSlots.sort()).toEqual([
      'first',
      'second',
    ]);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([
      'third',
    ]);
  });

  it('readResource late re-reserve clears stale refused entry (wenshao R5 line 1268)', async () => {
    // First: discoverAllMcpTools refuses `b` (budget=1, both a+b configured).
    // Then: disconnect `a` freeing the slot; readResource('b') succeeds and
    // must drop `b` from lastRefusedServerNames (pre-fix the snapshot kept
    // reporting `b` as `disabledReason: 'budget'` even after it connected).
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);
    // Free a slot.
    await manager.disconnectServer('a');
    // Lazy spawn b — should now succeed (slot available).
    await manager.readResource('b', 'file:///x');
    // Stale refusal entry must be cleared.
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([]);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual(['b']);
  });

  it('discoverMcpToolsForServer clears stale refused entry on success (wenshao R7 #1 line 612)', async () => {
    // Critical: a previously-refused server that connects successfully
    // (e.g. via /mcp reconnect after another server frees a slot)
    // would leave a stale entry in lastRefusedServerNames, so the
    // snapshot reported `disabledReason: 'budget'` for a CONNECTED
    // server until the next discovery pass cleared the per-pass log.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual(['b']);
    // Free a slot.
    await manager.disconnectServer('a');
    // Manual /mcp reconnect path exercises discoverMcpToolsForServer.
    await manager.discoverMcpToolsForServer('b', config);
    // The successful late connect must clear the stale refusal entry.
    expect(manager.getMcpClientAccounting().refusedServerNames).toEqual([]);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual(['b']);
  });

  it('discoverMcpToolsForServerInternal rejects disabled servers (wenshao R7 #2 line 528)', async () => {
    // Reachable from /mcp reconnect, OAuth re-discovery, and health
    // monitor reconnect. Pre-fix none of these paths checked the
    // disabled flag, so a disabled server could be resurrected.
    let createdCount = 0;
    vi.mocked(McpClient).mockImplementation(() => {
      createdCount += 1;
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'a') as Config['isMcpServerDisabled'],
      },
    );
    const manager = new McpClientManager(config, {} as ToolRegistry);
    await manager.discoverMcpToolsForServer('a', config);
    expect(createdCount).toBe(0);
  });

  it('discoverMcpToolsForServerInternal disconnects on discover() failure (wenshao R7 #3 line 634)', async () => {
    // Pre-fix: `connect()` succeeds + `discover()` throws → catch
    // deletes the client from the map without calling
    // `disconnect()`, leaking the stdio child.
    let disconnectCalls = 0;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          discover: vi.fn().mockRejectedValue(new Error('discover failed')),
          disconnect: vi.fn().mockImplementation(() => {
            disconnectCalls += 1;
            return Promise.resolve();
          }),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ x: { command: 'node' } });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverMcpToolsForServer('x', config);
    // Slot released on weReservedSlot+catch path AND the transport
    // was closed before dropping the client reference.
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
    expect(disconnectCalls).toBeGreaterThanOrEqual(1);
  });

  it('readBudgetFromEnv emits stderr warning on invalid budget value (wenshao R7 #6 line 191)', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = 'abc';
    try {
      const config = configWithServers({});
      const manager = new McpClientManager(config, {} as ToolRegistry);
      expect(manager.getMcpClientBudget()).toBeUndefined();
      // Operator-visible breadcrumb landed on stderr.
      const calls = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some(
          (s) =>
            s.includes('ignoring invalid QWEN_SERVE_MCP_CLIENT_BUDGET') &&
            s.includes("'abc'"),
        ),
      ).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('readResource rejects existing-but-now-disabled servers (wenshao R7 #5 line 1342)', async () => {
    // Pre-fix: a server connected pre-disable and then operator-
    // disabled mid-session via settings reload would still serve
    // resource reads via its existing CONNECTED client until the
    // next incremental discovery pass called removeServer.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    let disabled = false;
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'a' && disabled) as Config['isMcpServerDisabled'],
      },
    );
    const manager = new McpClientManager(config, {} as ToolRegistry);
    // First connect while NOT disabled.
    await manager.discoverAllMcpTools(config);
    // Now operator disables 'a' mid-session.
    disabled = true;
    // readResource on the EXISTING (still CONNECTED) client must
    // reject — pre-fix this would have proceeded to client.readResource.
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is disabled/,
    );
  });

  it('readResource lazy spawn disconnects on connect() failure (wenshao R9 #2 line 1534)', async () => {
    // Mirror of the discovery-side R7 #3 / R8 #1 fixes, but for
    // the readResource lazy-spawn path. Pre-fix: connect()
    // partially established transport then threw → catch deleted
    // client without disconnect() → stdio child / socket leaked.
    let disconnectCalls = 0;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi
            .fn()
            .mockRejectedValue(new Error('mid-handshake failure')),
          discover: vi.fn(),
          disconnect: vi.fn().mockImplementation(() => {
            disconnectCalls += 1;
            return Promise.resolve();
          }),
          getStatus: vi.fn(),
          readResource: vi.fn(),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ x: { command: 'node' } });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await expect(manager.readResource('x', 'file:///a')).rejects.toThrow(
      /mid-handshake failure/,
    );
    expect(disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
  });

  it('readBudgetFromEnv emits stderr breadcrumb on enforce-no-budget downgrade (wenshao R9 #7)', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'enforce';
    // No budget → downgrade fires
    try {
      const config = configWithServers({});
      const manager = new McpClientManager(config, {} as ToolRegistry);
      expect(manager.getMcpBudgetMode()).toBe('off');
      const calls = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some(
          (s) =>
            s.includes('QWEN_SERVE_MCP_BUDGET_MODE=enforce') &&
            s.includes('downgrading to off'),
        ),
      ).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('discoverAllMcpTools disconnects on discover() failure (wenshao R8 #1 line 532)', async () => {
    // Bulk-path mirror of R7 #3 (per-server path). Pre-fix:
    // connect() success + discover() throw → catch deleted client
    // without disconnect() → stdio child / WebSocket / HTTP socket
    // leaked for the rest of the daemon's lifetime (stop() can't
    // see the entry it just removed from this.clients).
    let disconnectCalls = 0;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          discover: vi.fn().mockRejectedValue(new Error('discover failed')),
          disconnect: vi.fn().mockImplementation(() => {
            disconnectCalls += 1;
            return Promise.resolve();
          }),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ a: { command: 'node' } });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    await manager.discoverAllMcpTools(config);
    // Transport closed before client reference dropped + slot released.
    expect(disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
  });

  it('readBudgetFromEnv downgrades warn-without-budget to off (wenshao R8 #2)', async () => {
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'warn';
    // No budget — pre-fix this passed through with mode='warn',
    // reaching emitBudgetTelemetry with clientBudget=undefined.
    const config = configWithServers({});
    const manager = new McpClientManager(config, {} as ToolRegistry);
    expect(manager.getMcpClientBudget()).toBeUndefined();
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  it('constructor downgrades enforce-without-budget when budgetConfig passed directly (wenshao R8 #5)', async () => {
    // Direct-budgetConfig path is test-/embedded-only — production
    // callers (CLI, runQwenServe, env-var fallback) all validate
    // upfront. Defense-in-depth: constructor mirrors the env-var
    // path's downgrade so a future caller that bypasses validation
    // can't silently fail-open.
    const config = configWithServers({});
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      // Invalid combination: enforce mode without a budget.
      { budgetMode: 'enforce' },
    );
    // Downgraded to off so tryReserveSlot doesn't masquerade as enforce.
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  it('discoverMcpToolsForServer reconnect-attempt connect-failure KEEPS slot (wenshao R4 C2 already_held)', async () => {
    // Distinguish from the previous test: same call signature, but
    // here the slot is already-held (from a prior successful connect
    // in discoverAllMcpTools). A failed reconnect must NOT release —
    // the operator's stable server that just hiccupped should keep
    // its capacity reservation for the health-monitor retry loop.
    let connectThrows = false;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockImplementation(async () => {
            if (connectThrows) throw new Error('reconnect boom');
          }),
          discover: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn(() =>
            connectThrows
              ? undefined
              : ((vi.mocked as unknown as { val: unknown }).val =
                  'CONNECTED' as unknown),
          ),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ a: { command: 'node' } });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { clientBudget: 1, budgetMode: 'enforce' },
    );
    // First pass: a connects successfully, slot reserved.
    await manager.discoverAllMcpTools(config);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual(['a']);
    // Now simulate health-monitor reconnect against a flaky server:
    // discoverMcpToolsForServer goes through tryReserveSlot →
    // 'already_held' (slot stays) → existing client.disconnect()
    // (slot stays) → new client.connect() throws → fix says
    // weReservedSlot=false here so slot NOT released.
    connectThrows = true;
    await manager.discoverMcpToolsForServer('a', config);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual(['a']);
  });
});

// Issue #4175 PR 14b: push events + hysteresis state machine. Kept in
// its own describe so a future revert of PR 14b drops a single
// contiguous block. Mirrors PR 14's testing style (mock `McpClient`,
// fluent `configWithServers` helper). Imports are dynamic to keep
// the spy on `McpClient` cleanly bound per test (vi.mocked module
// already mocked at file top).
describe('McpClientManager — PR 14b push events + hysteresis', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    delete process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  });

  function makeConnectedMcpClientMock() {
    const state = { status: undefined as unknown };
    return {
      connect: vi.fn().mockImplementation(async () => {
        const { MCPServerStatus } = await import('./mcp-client.js');
        state.status = MCPServerStatus.CONNECTED;
      }),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => state.status),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
  }

  function configWithServers(
    servers: Record<string, unknown>,
    overrides: Partial<Config> = {},
  ): Config {
    return {
      isTrustedFolder: () => true,
      getMcpServers: () => servers,
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}) as PromptRegistry,
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
      ...overrides,
    } as unknown as Config;
  }

  it('exports MCP_BUDGET_REARM_FRACTION = 0.375', async () => {
    const { MCP_BUDGET_REARM_FRACTION } = await import(
      './mcp-client-manager.js'
    );
    expect(MCP_BUDGET_REARM_FRACTION).toBe(0.375);
  });

  it('budget_warning fires once on first 75% upward crossing', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    // 4-server config, budget 4, ratio after pass = 4/4 = 1.0 ≥ 0.75
    // → exactly one warning fires.
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 4,
        budgetMode: 'warn',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    const warnings = events.filter(
      (e) => (e as { kind: string }).kind === 'budget_warning',
    );
    expect(warnings).toHaveLength(1);
    // PR 14b fix #4 (codex review round 1): hysteresis fires inline on
    // the upward crossing, so the payload reflects the moment ratio
    // first hits 0.75 — `reservedCount: 3` (3 of 4 reserved). Pre-fix
    // the test saw the post-stabilization `reservedCount: 4` because
    // the standalone end-of-pass `evaluateBudgetState` ran after every
    // reservation completed.
    expect(warnings[0]).toMatchObject({
      kind: 'budget_warning',
      reservedCount: 3,
      budget: 4,
      thresholdRatio: 0.75,
      mode: 'warn',
    });
  });

  it('budget_warning does NOT fire when ratio stays below 75%', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    // 2 of 4 → 0.5 < 0.75 → no fire.
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 4,
        budgetMode: 'warn',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toEqual([]);
  });

  it('budget_warning hysteresis re-arms only after dropping below 37.5%', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    // Budget 4. Pass 1: 4/4 = 1.0 fires. Pass 2 after disconnecting
    // 2 (-> 2/4=0.5, above 37.5%) does NOT re-arm. Pass 3 after
    // disconnecting one more (-> 1/4=0.25 below 37.5%) re-arms.
    // Re-arming alone doesn't fire — the next upward crossing fires.
    let servers: Record<string, unknown> = {
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    };
    const cfgGetter = () => servers;
    const config = configWithServers({}, {
      getMcpServers: cfgGetter,
    } as Partial<Config>);
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 4,
        budgetMode: 'warn',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(1);

    // Drop to 50% via disconnect: 2/4 = 0.5 — above 37.5%, NO re-arm
    // (warning stays disabled).
    await manager.disconnectServer('c');
    await manager.disconnectServer('d');
    // Force a state evaluation: a successful per-server reconnect path
    // is the cleanest in-band trigger; emulate one by re-discovering
    // 'a'. (`evaluateBudgetState` is private — we exercise it via the
    // public path instead.)
    await manager.discoverMcpToolsForServer('a', config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(1); // still 1 — not re-fired

    // Drop to 25% via disconnect — below 37.5% — should re-arm but
    // not fire yet (re-arming alone doesn't trigger an event).
    await manager.disconnectServer('b');
    await manager.discoverMcpToolsForServer('a', config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(1);

    // Now refill back to 4/4 — re-armed state plus upward crossing
    // fires the second warning.
    servers = {
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    };
    await manager.discoverAllMcpToolsIncremental(config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(2);
  });

  it('off mode never fires budget_warning', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { budgetMode: 'off', onBudgetEvent: (e) => events.push(e) },
    );
    await manager.discoverAllMcpTools(config);
    expect(events).toEqual([]);
  });

  it('refused_batch coalesces multi-refusal into one event per pass', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    // budget 1, 3 servers → a connects, b+c refused.
    const config = configWithServers({
      a: { command: 'node' },
      b: { httpUrl: 'http://b' },
      c: { url: 'http://c' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 1,
        budgetMode: 'enforce',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    const batches = events.filter(
      (e) => (e as { kind: string }).kind === 'refused_batch',
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      kind: 'refused_batch',
      budget: 1,
      mode: 'enforce',
      refusedServers: [
        { name: 'b', transport: 'http', reason: 'budget_exhausted' },
        { name: 'c', transport: 'sse', reason: 'budget_exhausted' },
      ],
    });
  });

  it('refused_batch does NOT fire when no servers are refused', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 5,
        budgetMode: 'enforce',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'refused_batch'),
    ).toEqual([]);
  });

  it('readResource refusal emits a length-1 refused_batch then throws', async () => {
    const { BudgetExhaustedError } = await import('./mcp-client-manager.js');
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 1,
        budgetMode: 'enforce',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    // First pass fills the budget with `a`. `b` is refused — that's
    // the bulk refusal (length-1 batch).
    await manager.discoverAllMcpTools(config);
    // Clear bulk events so the assertion below tracks only the
    // readResource path.
    events.length = 0;
    // Now lazy-spawn against b — slot full, throws + emits a
    // length-1 batch.
    await expect(manager.readResource('b', 'mcp://b/resource')).rejects.toThrow(
      BudgetExhaustedError,
    );
    const batches = events.filter(
      (e) => (e as { kind: string }).kind === 'refused_batch',
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      kind: 'refused_batch',
      mode: 'enforce',
      refusedServers: [
        { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
      ],
    });
  });

  it('off-mode constructor strips onBudgetEvent (defense in depth)', async () => {
    // Off-mode never runs the state machine; the constructor stashes
    // `undefined` for `onBudgetEvent` so even a stray internal call
    // can't fire. Verified externally by observing that no events
    // arrive.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      { budgetMode: 'off', onBudgetEvent: (e) => events.push(e) },
    );
    await manager.discoverAllMcpTools(config);
    // Force discovery refusal would be impossible in off mode (no
    // budget). Disconnect-then-rediscover also no-ops the state
    // machine. End-to-end no events.
    await manager.disconnectServer('a');
    await manager.discoverMcpToolsForServer('a', config);
    expect(events).toEqual([]);
  });

  it('refused_batch transports preserve the per-server family at refusal time', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    // Mixed transports refused; budget 1 admits the first only.
    const config = configWithServers({
      a: { command: 'node' }, // stdio (admitted)
      b: { httpUrl: 'http://b' }, // http (refused)
      c: { url: 'http://c' }, // sse (refused)
      d: { tcp: 'ws://d' }, // websocket (refused)
      e: { type: 'sdk', command: 'sdk' }, // sdk (refused)
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 1,
        budgetMode: 'enforce',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    const batches = events.filter(
      (e) => (e as { kind: string }).kind === 'refused_batch',
    ) as Array<{ refusedServers: Array<{ name: string; transport: string }> }>;
    expect(batches).toHaveLength(1);
    expect(
      batches[0].refusedServers.map((r) => `${r.name}:${r.transport}`),
    ).toEqual(['b:http', 'c:sse', 'd:websocket', 'e:sdk']);
  });

  it('warn mode never emits refused_batch (only enforce refuses)', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 1,
        budgetMode: 'warn',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    // warn mode: no refusals, but the warning may fire (3/1 ratio crosses 0.75).
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'refused_batch'),
    ).toEqual([]);
  });

  it('stop() re-arms the warning state machine for the next session', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 4,
        budgetMode: 'warn',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    // First crossing fired one warning.
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(1);
    // stop() resets state. Next discovery pass that crosses 75%
    // fires anew. discoverAllMcpTools internally calls stop() at
    // the top, so calling it again is sufficient.
    await manager.discoverAllMcpTools(config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(2);
  });

  it('discoverAllMcpToolsIncremental coalesces multi-server refusals into ONE batch (codex review fix #3)', async () => {
    // Codex review round 1, finding #3: pre-fix, when
    // `discoverAllMcpToolsIncremental` walked N new servers and the
    // budget was full, each per-server refusal called
    // `emitRefusedBatchIfAny` inline → N length-1 batch events
    // instead of 1 length-N batch. This test pins the documented
    // "one batch per pass" contract via the `bulkPassDepth` guard.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    // Budget 1, 4 servers — 1 admitted, 3 refused. Pre-fix this
    // produced 3 length-1 batches via `discoverMcpToolsForServer` →
    // `discoverMcpToolsForServerInternal`. Post-fix: 1 length-3 batch.
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 1,
        budgetMode: 'enforce',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpToolsIncremental(config);
    const batches = events.filter(
      (e) => (e as { kind: string }).kind === 'refused_batch',
    ) as Array<{ refusedServers: Array<{ name: string }> }>;
    // Strict invariant: ONE batch event, not N.
    expect(batches).toHaveLength(1);
    expect(batches[0].refusedServers.map((r) => r.name)).toEqual([
      'b',
      'c',
      'd',
    ]);
  });

  it('disconnectServer drives the hysteresis re-arm path (codex review fix #4)', async () => {
    // Codex review round 1, finding #4: pre-fix `disconnectServer` /
    // `removeServer` deleted from `reservedSlots` without invoking
    // `evaluateBudgetState`, so `warnArmed` stayed `false` after a
    // 75% fire even though the ratio dropped below 37.5%. This test
    // exercises the operator-driven release path: 4/4 → fire #1 →
    // disconnect 3 servers (1/4, below re-arm) → reconnect 3 → 4/4
    // → fire #2. Pre-fix: only one fire. Post-fix: two fires.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    const events: unknown[] = [];
    const config = configWithServers({
      a: { command: 'node' },
      b: { command: 'node' },
      c: { command: 'node' },
      d: { command: 'node' },
    });
    const manager = new McpClientManager(
      config,
      {} as ToolRegistry,
      undefined,
      undefined,
      undefined,
      {
        clientBudget: 4,
        budgetMode: 'warn',
        onBudgetEvent: (e) => events.push(e),
      },
    );
    await manager.discoverAllMcpTools(config);
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(1);
    // Drop to 1/4 via operator disconnects — each release crosses
    // through 0.75 → 0.5 → 0.25, the last one crossing 37.5% inline
    // re-arms `warnArmed` via `releaseSlotName`'s evaluate.
    await manager.disconnectServer('b');
    await manager.disconnectServer('c');
    await manager.disconnectServer('d');
    // Reconnect via direct discoverMcpToolsForServer (bypasses
    // discoverAllMcpTools' bulk-pass reset, exercises the re-armed
    // state through inline `tryReserveSlot` evaluate calls).
    await manager.discoverMcpToolsForServer('b', config);
    await manager.discoverMcpToolsForServer('c', config);
    // 3/4 = 0.75 — fire #2.
    expect(
      events.filter((e) => (e as { kind: string }).kind === 'budget_warning'),
    ).toHaveLength(2);
  });
});

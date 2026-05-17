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

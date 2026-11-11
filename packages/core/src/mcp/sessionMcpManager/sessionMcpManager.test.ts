/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GetPromptResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { MCPServerStatus } from '../client/mcpClient.js';
import { McpSettingsGate, type McpServerGate } from '../gate.js';
import { McpManager } from '../mcpManager.js';
import type { McpClient } from '../client/mcpClient.js';
import type { McpClientEvent } from '../client/types.js';
import { mcpServerKeyId, type McpServerKey } from '../server-key.js';
import { SessionMcpManager } from './sessionMcpManager.js';
import { MCPDiscoveryState, type McpSessionContext } from './types.js';
import type {
  McpElicitationHandler,
  McpElicitationHost,
} from '../elicitation.js';

function fakeTool(serverToolName: string, alwaysLoad = false): DiscoveredMCPTool {
  return {
    serverToolName,
    description: `${serverToolName} desc`,
    parameterSchema: { type: 'object', properties: {} },
    alwaysLoad,
    name: `mcp__srv__${serverToolName}`,
    exposureHints: { namespace: { kind: 'mcp', server: 'srv' }, pinned: alwaysLoad },
    getSchema: () => ({ name: `mcp__srv__${serverToolName}` }),
    isReadOnly: true,
    isDestructive: () => false,
    isOpenWorld: () => false,
  } as unknown as DiscoveredMCPTool;
}

interface FakeClient {
  tools: DiscoveredMCPTool[];
  prompts: unknown[];
  resources: Resource[];
  status: MCPServerStatus;
  description?: string;
  instructions?: string;
}

function createHarness(options: {
  eventEmitter?: EventEmitter;
  servers?: Record<string, MCPServerConfig>;
  allowed?: string[];
  excluded?: string[];
  lazy?: boolean;
  trusted?: boolean;
  waitForRegistration?: boolean;
  ready?: Promise<void>;
  gate?: McpServerGate;
  interactive?: boolean;
} = {}) {
  const clients = new Map<string, FakeClient>();
  const clientWrappers = new WeakMap<FakeClient, McpClient>();
  const registered: Array<{
    sessionId: string;
    keys: string[];
    registrations: Array<{
      key: McpServerKey;
      elicitationHandler?: McpElicitationHandler;
    }>;
  }> = [];
  let listener: ((key: McpServerKey, event: McpClientEvent) => void) | undefined;
  let resolveRegistration: (() => void) | undefined;
  const registrationPending = options.waitForRegistration
    ? new Promise<void>((resolve) => {
        resolveRegistration = resolve;
      })
    : undefined;

  const toolRegistry = {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
    getAllKnownTools: vi.fn(() => []),
    getKnownTool: vi.fn(() => undefined),
    removeMcpToolsByServer: vi.fn(),
    sortTools: vi.fn(),
    invalidateSchemaCache: vi.fn(),
  } as unknown as ToolRegistry;

  const context: McpSessionContext = {
    getSessionId: () => 'sess-1',
    getMcpServers: () => options.servers ?? {},
    getAllowedMcpServers: () => options.allowed ?? [],
    getBlockedMcpServers: () => options.excluded ?? [],
    getTargetDir: () => '/project',
    isTrustedFolder: () => options.trusted ?? true,
    isInteractive: () => options.interactive ?? false,
    getToolRegistry: () => toolRegistry,
    registerLazyMetaTools: vi.fn(),
    mcpToolListChange: vi.fn(),
  };

  const elicitationHost = {
    request: vi.fn(async () => ({ action: 'cancel' as const })),
    complete: vi.fn(),
    setElicitationBridge: vi.fn(),
  } as unknown as McpElicitationHost;

  const gate = options.gate ?? new McpSettingsGate();
  const mcpManager = {
    filterDuplicateStdioMcpServers:
      McpManager.prototype.filterDuplicateStdioMcpServers,
    ready: vi.fn(() => options.ready ?? Promise.resolve()),
    getPendingDiscovery: vi.fn(() => undefined),
    addListener: (l: typeof listener) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    addGatePolicyListener: vi.fn(() => () => {}),
    evaluateGate: (request: Parameters<McpSettingsGate['evaluate']>[0]) =>
      gate.evaluate(request),
    getClient: (key: McpServerKey) => {
      const fake = clients.get(mcpServerKeyId(key));
      if (!fake) return undefined;
      let wrapper = clientWrappers.get(fake);
      if (!wrapper) {
        wrapper = {
          getDiscoveredTools: () => fake.tools,
          getDiscoveredPrompts: () => fake.prompts,
          getDiscoveredResources: () => fake.resources,
          getStatus: () => fake.status,
          isConnected: () => fake.status === MCPServerStatus.CONNECTED,
          getServerConfig: () =>
            ({ description: fake.description }) as MCPServerConfig,
          getInstructions: () => fake.instructions,
          ensureConnected: vi.fn(async () => {}),
        } as unknown as McpClient;
        clientWrappers.set(fake, wrapper);
      }
      return wrapper;
    },
    getStatus: (key: McpServerKey) =>
      clients.get(mcpServerKeyId(key))?.status ?? MCPServerStatus.DISCONNECTED,
    reconnect: vi.fn(async () => {}),
    registerMcpServers: vi.fn(
      async (
        sessionId: string,
        regs: Array<{
          key: McpServerKey;
          elicitationHandler?: McpElicitationHandler;
        }>,
        _allowAuthentication?: boolean,
      ) => {
        registered.push({
          sessionId,
          keys: regs.map((r) => r.key.name),
          registrations: regs,
        });
        await registrationPending;
        return {
          serverCount: regs.length,
          newConnectionCount: regs.length,
          reusedConnectionCount: 0,
        };
      },
    ),
    unregisterMcpServers: vi.fn(async () => {}),
    unregisterSession: vi.fn(async () => {}),
    getPrompt: vi.fn(async () => ({ messages: [] }) as GetPromptResult),
    readResource: vi.fn(async () => ({ contents: [] }) as ReadResourceResult),
  } as unknown as McpManager;

  const manager = new SessionMcpManager(context, mcpManager, gate, {
    lazyMode: options.lazy ?? false,
    eventEmitter: options.eventEmitter,
    elicitationHost,
  });

  return {
    manager,
    context,
    elicitationHost,
    mcpManager,
    toolRegistry,
    clients,
    registered,
    resolveRegistration,
    emit: (key: McpServerKey, event: McpClientEvent) => listener?.(key, event),
  };
}

const stdio = (scope?: MCPServerConfig['scope']) =>
  ({ command: 'node', args: ['s.js'], scope }) as MCPServerConfig;

beforeEach(() => vi.clearAllMocks());

describe('SessionMcpManager registration and gate', () => {
  it('keeps all duplicate names visible and skips their connections across reloads', async () => {
    const servers: Record<string, MCPServerConfig> = {
      'dup-a': stdio('user'),
      'dup-b': stdio('user'),
      'dup-c': stdio('user'),
    };
    const h = createHarness({ servers });
    await h.manager.initialize();
    h.clients.set(mcpServerKeyId(h.manager.serverNameToServerKey('dup-a')!), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    await h.manager.reloadMcpServers();
    expect(Object.keys(h.manager.getMcpServers())).toEqual([
      'dup-a',
      'dup-b',
      'dup-c',
    ]);
    expect(h.registered.map((call) => call.keys)).toEqual([['dup-a']]);
    expect(h.manager.getClientByName('dup-b')).toBeUndefined();
    expect(h.manager.getServerStatus('dup-b')).toBe(
      MCPServerStatus.DISCONNECTED,
    );
    expect(h.manager.canUseMcpServer('dup-b')).toBe(false);

    delete servers['dup-a'];
    await h.manager.reloadMcpServers();
    expect(h.registered.at(-1)?.keys).toEqual(['dup-b']);

    servers['dup-c'] = { ...servers['dup-c'], env: { REGION: 'other' } };
    await h.manager.reloadMcpServers();
    expect(h.registered.at(-1)?.keys).toEqual(['dup-b', 'dup-c']);
    await h.manager.dispose();
  });

  it('chooses the first allowed duplicate after applying the session gate', async () => {
    const h = createHarness({
      servers: {
        a: stdio('project'),
        b: stdio('project'),
        c: stdio('project'),
      },
      excluded: ['a'],
    });
    await h.manager.initialize();
    expect(h.registered[0].keys).toEqual(['b']);
    expect(Object.keys(h.manager.getMcpServers())).toEqual(['a', 'b', 'c']);
    await h.manager.dispose();
  });

  it.each<{ label: string; servers: Record<string, MCPServerConfig> }>([
    { label: 'no servers', servers: {} },
    { label: 'configured servers', servers: { docs: stdio('project') } },
  ])('publishes completed discovery state on initialization and reload with $label', async ({ servers }) => {
    const eventEmitter = new EventEmitter();
    const h = createHarness({ servers, eventEmitter });
    const observedStates: MCPDiscoveryState[] = [];
    eventEmitter.on('mcp-client-update', () => {
      observedStates.push(h.manager.getDiscoveryState());
    });

    await h.manager.initialize();
    expect(observedStates).toEqual([MCPDiscoveryState.COMPLETED]);

    await h.manager.reloadMcpServers();
    expect(observedStates).toEqual([
      MCPDiscoveryState.COMPLETED,
      MCPDiscoveryState.COMPLETED,
    ]);
  });

  it('initializes, starts and stops its session gate', async () => {
    let policyChanged: (() => void) | undefined;
    const gate = {
      evaluate: vi.fn(() => ({ allowed: true as const })),
      initialize: vi.fn(async () => {}),
      start: vi.fn((listener: () => void) => {
        policyChanged = listener;
      }),
      stop: vi.fn(),
    };
    const h = createHarness({ gate, servers: { docs: stdio('project') } });

    await h.manager.initialize();
    expect(gate.initialize).toHaveBeenCalledOnce();
    expect(gate.start).toHaveBeenCalledOnce();

    const register = vi.mocked(h.mcpManager.registerMcpServers);
    const registrationCalls = register.mock.calls.length;
    policyChanged?.();
    await vi.waitFor(() =>
      expect(register.mock.calls.length).toBeGreaterThan(registrationCalls),
    );

    await h.manager.dispose();
    expect(gate.stop).toHaveBeenCalledOnce();
  });

  it('waits for the process pool before registering session servers', async () => {
    let finishReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      finishReady = resolve;
    });
    const h = createHarness({
      ready,
      servers: { docs: stdio('project') },
    });

    const initialization = h.manager.initialize();
    await Promise.resolve();
    expect(h.mcpManager.registerMcpServers).not.toHaveBeenCalled();

    finishReady?.();
    await initialization;
    expect(h.mcpManager.registerMcpServers).toHaveBeenCalledOnce();
  });

  it('disables interactive auth for non-interactive sessions', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });

    await h.manager.initialize();

    expect(h.mcpManager.registerMcpServers).toHaveBeenCalledWith(
      'sess-1',
      expect.any(Array),
      false,
    );
  });

  it('keeps interactive auth for interactive sessions', async () => {
    const h = createHarness({
      servers: { docs: stdio('project') },
      interactive: true,
    });

    await h.manager.initialize();

    expect(h.mcpManager.registerMcpServers).toHaveBeenCalledWith(
      'sess-1',
      expect.any(Array),
      true,
    );
  });

  it('does not start interactive auth when restarting a non-interactive server', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();

    await h.manager.restartServer('docs');

    expect(h.mcpManager.reconnect).toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
  });

  it('does not re-register an unchanged server on reload', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('docs')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    const register = vi.mocked(h.mcpManager.registerMcpServers);
    const callsBeforeReload = register.mock.calls.length;

    await h.manager.reloadMcpServers();

    expect(register).toHaveBeenCalledTimes(callsBeforeReload);
  });

  it('waits for injected SDK clients to finish connecting', async () => {
    const h = createHarness({
      waitForRegistration: true,
      servers: {},
    });
    await h.manager.initialize();
    let settled = false;
    const registration = h.manager
      .registerSdkMcpClients(['remote'], vi.fn())
      .then(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(settled).toBe(false);
    h.resolveRegistration?.();
    await registration;
    expect(settled).toBe(true);
  });

  it('registers active servers with the pool, deriving keys from scope', async () => {
    const h = createHarness({
      servers: { docs: stdio('project'), notes: stdio('user') },
    });
    await h.manager.initialize();

    expect(h.mcpManager.registerMcpServers).toHaveBeenCalledOnce();
    expect(h.registered[0].keys.sort()).toEqual(['docs', 'notes']);
    // project-scope roots at the cwd; user-scope key uses the global settings file source
    expect(h.manager.serverNameToServerKey('docs')?.source).toMatch(/^file:/);
    expect(h.manager.serverNameToServerKey('notes')?.source).toMatch(/^file:/);
    expect(h.manager.serverNameToServerKey('docs')).not.toEqual(
      h.manager.serverNameToServerKey('notes'),
    );
  });

  it('keys flag-injected servers by their config instead of the workspace', async () => {
    const flag = (url: string): MCPServerConfig =>
      ({ type: 'http', url, scope: 'flag' }) as MCPServerConfig;
    const first = createHarness({
      servers: {
        injected: flag('http://127.0.0.1:1/mcp/sessions/token-a/servers/srv'),
      },
    });
    const second = createHarness({
      servers: {
        injected: flag('http://127.0.0.1:1/mcp/sessions/token-b/servers/srv'),
      },
    });
    await first.manager.initialize();
    await second.manager.initialize();

    const firstKey = first.manager.serverNameToServerKey('injected');
    const secondKey = second.manager.serverNameToServerKey('injected');
    expect(firstKey?.source).toMatch(/^flag:/);
    expect(firstKey).not.toEqual(secondKey);
  });

  it('shares one pooled identity for identical flag injections', async () => {
    const servers = {
      injected: {
        type: 'http',
        url: 'http://127.0.0.1:1/mcp/sessions/token-a/servers/srv',
        scope: 'flag',
      } as MCPServerConfig,
    };
    const first = createHarness({ servers });
    const second = createHarness({ servers });
    await first.manager.initialize();
    await second.manager.initialize();

    expect(first.manager.serverNameToServerKey('injected')).toEqual(
      second.manager.serverNameToServerKey('injected'),
    );
  });

  it('excludelist blocks a server: not registered, not usable, deny message kept', async () => {
    const h = createHarness({
      servers: { docs: stdio('project'), bad: stdio('project') },
      excluded: ['bad'],
    });
    await h.manager.initialize();

    expect(h.registered[0].keys).toEqual(['docs']);
    expect(h.manager.canUseMcpServer('bad')).toBe(false);
    expect(h.manager.canUseMcpServer('docs')).toBe(true);
    expect(h.manager.getMcpServerDenyMessage('bad')).toMatch(/mcp.excluded/);
    expect(
      h.manager.listMcpServers().find((s) => s.name === 'bad')?.allowed,
    ).toBe(false);
  });

  it('does not start disk-configured servers in an untrusted session', async () => {
    const h = createHarness({
      trusted: false,
      servers: { project: stdio('project'), injected: stdio('dynamic') },
    });
    await h.manager.initialize();

    expect(h.registered[0].keys).toEqual(['injected']);
    expect(h.manager.canUseMcpServer('project')).toBe(false);
    expect(h.manager.canUseMcpServer('injected')).toBe(true);
  });

  it('does not assemble the tool registry before the pool reports servers', async () => {
    const h = createHarness({
      lazy: true,
      waitForRegistration: true,
      servers: { slow: stdio('project') },
    });
    let initialized = false;
    const initialization = h.manager.initialize().then(() => {
      initialized = true;
    });
    await Promise.resolve();

    expect(h.context.registerLazyMetaTools).not.toHaveBeenCalled();
    expect(initialized).toBe(false);

    h.resolveRegistration?.();
    await initialization;
  });

  it('reconnects every active server on restart', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('docs')!;

    await h.manager.restart();

    expect(h.mcpManager.reconnect).toHaveBeenCalledWith(key, false);
  });

  it('reconnects a server once when an approved copy and its configured entry share a name', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();
    const configuredKey = h.manager.serverNameToServerKey('docs')!;

    // Approval registers the same server as a session-owned copy on top of the
    // configured entry, so both keys are active until the next reload.
    await h.manager.maybeDiscoverMcpServer('docs', stdio('project'));
    expect(h.manager.serverNameToServerKey('docs')!.source).toBe(
      'session:sess-1',
    );

    await h.manager.restart();

    const reconnectCalls = vi.mocked(h.mcpManager.reconnect).mock.calls;
    expect(reconnectCalls).toHaveLength(1);
    expect(reconnectCalls[0]?.[0]).toEqual(configuredKey);
  });

  it('publishes and clears an auth pseudo-tool through the lazy catalog', async () => {
    const h = createHarness({
      lazy: true,
      servers: { docs: stdio('project') },
    });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('docs')!;

    h.emit(key, { type: 'status', status: MCPServerStatus.AUTH_REQUIRED });
    expect(
      h.manager
        .getLazyDiscoveredMcpTools()
        .map((entry) => [entry.serverName, entry.toolName]),
    ).toContainEqual(['docs', 'authenticate']);

    h.emit(key, { type: 'status', status: MCPServerStatus.CONNECTED });
    expect(h.manager.getLazyDiscoveredMcpTools()).toEqual([]);
  });

  it('disable/enable toggles a server out of and back into the active set', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();
    expect(h.manager.canUseMcpServer('docs')).toBe(true);

    await h.manager.disableMcpServer('docs');
    expect(h.manager.canUseMcpServer('docs')).toBe(false);
    expect(h.mcpManager.unregisterMcpServers).toHaveBeenCalled();

    await h.manager.enableMcpServer('docs');
    expect(h.manager.canUseMcpServer('docs')).toBe(true);
  });
});

describe('SessionMcpManager plugin servers', () => {
  it('keeps plugin ownership metadata when registering plugin servers', async () => {
    const h = createHarness();
    await h.manager.initialize();

    await h.manager.startPlugin({
      name: 'demo-plugin',
      path: '/plugins/demo',
      id: 'demo-plugin@flag',
      mcpServers: { 'plugin-srv': stdio() },
    });

    const view = h.manager
      .listMcpServers()
      .find((server) => server.name === 'plugin-srv');
    expect(view?.config.plugin).toEqual({
      name: 'demo-plugin',
      path: '/plugins/demo',
      id: 'demo-plugin@flag',
    });
  });

  it('does not re-register preserved plugin servers on reload', async () => {
    const h = createHarness();
    await h.manager.initialize();
    await h.manager.startPlugin({
      name: 'demo-plugin',
      path: '/plugins/demo',
      id: 'demo-plugin@flag',
      mcpServers: { 'plugin-srv': stdio() },
    });
    vi.mocked(h.mcpManager.registerMcpServers).mockClear();

    await h.manager.reloadMcpServers();

    expect(h.mcpManager.registerMcpServers).not.toHaveBeenCalled();
  });
});

describe('SessionMcpManager catalog publication', () => {
  it('aggregates tools from the pool for active servers', async () => {
    const h = createHarness({ servers: { srv: stdio('project') }, lazy: true });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [fakeTool('a'), fakeTool('b', true)],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });

    const all = h.manager.getAllDiscoveredMcpTools();
    expect(all.map((e) => e.toolName).sort()).toEqual(['a', 'b']);
    expect(h.manager.getLazyDiscoveredMcpTools().map((e) => e.toolName)).toEqual([
      'a',
    ]);
    expect(
      h.manager.getDiscoveredMcpToolByQualifiedName('mcp__srv__a')?.toolName,
    ).toBe('a');
  });

  it('reports active, still-connecting and discovered tool counts for startup diagnostics', async () => {
    const h = createHarness({
      servers: {
        fast: stdio('project'),
        slow: { ...stdio('project'), args: ['slow.js'] },
      },
    });
    expect(h.manager.getStartupSnapshot()).toEqual({
      active: 0,
      pending: 0,
      tools: 0,
    });
    await h.manager.initialize();
    const fast = h.manager.serverNameToServerKey('fast')!;
    const slow = h.manager.serverNameToServerKey('slow')!;
    h.clients.set(mcpServerKeyId(fast), {
      tools: [fakeTool('a'), fakeTool('b')],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    vi.mocked(h.mcpManager.getPendingDiscovery).mockImplementation((key) =>
      mcpServerKeyId(key) === mcpServerKeyId(slow) ? new Promise(() => {}) : undefined,
    );
    expect(h.manager.getStartupSnapshot()).toEqual({ active: 2, pending: 1, tools: 2 });
  });

  it('builds the lazy catalog snapshot from deferred tools and server metadata', async () => {
    const h = createHarness({
      lazy: true,
      servers: { srv: stdio('project') },
    });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [fakeTool('search'), fakeTool('pinned', true)],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
      description: 'Project docs',
      instructions: 'Use search first',
    });

    expect(h.manager.getLazyMcpServerSnapshot()).toEqual([
      {
        serverName: 'srv',
        toolNames: ['mcp__srv__search'],
        description: 'Project docs',
        instructions: 'Use search first',
      },
    ]);

    h.manager.setLazyMode(false);
    expect(h.manager.getLazyMcpServerSnapshot()).toEqual([]);
  });

  it('rejects a lazy invocation when the tool definition changed during recovery', async () => {
    const h = createHarness({
      lazy: true,
      servers: { srv: stdio('project') },
    });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    const client = {
      tools: [fakeTool('search')],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    };
    h.clients.set(mcpServerKeyId(key), client);
    const entry = h.manager.getLazyDiscoveredMcpToolByQualifiedName(
      'mcp__srv__search',
    )!;
    client.tools = [
      {
        ...fakeTool('search'),
        description: 'changed during reconnect',
      } as DiscoveredMCPTool,
    ];

    await expect(
      h.manager.prepareLazyMcpTool(entry, new AbortController().signal),
    ).rejects.toThrow(/changed during recovery/);
  });

  it('rejects a lazy invocation when a catalog refresh removes its tool', async () => {
    const h = createHarness({
      lazy: true,
      servers: { srv: stdio('project') },
    });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    const client = {
      tools: [fakeTool('search')],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    };
    h.clients.set(mcpServerKeyId(key), client);
    const entry = h.manager.getLazyDiscoveredMcpToolByQualifiedName(
      'mcp__srv__search',
    )!;
    client.tools = [];

    await expect(
      h.manager.prepareLazyMcpTool(entry, new AbortController().signal),
    ).rejects.toThrow(/no longer available/);
  });

  it('notifies the session when tools change without touching the registry', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [fakeTool('a')],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });

    h.emit(key, { type: 'tools', tools: [fakeTool('a')] });

    expect(h.context.mcpToolListChange).toHaveBeenCalled();
    expect(h.toolRegistry.registerTool).not.toHaveBeenCalled();
  });

  it('publishes prompts and resources on pool events', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    const prompt = { name: 'p', originalName: 'p', serverName: 'srv' };
    const resource = { uri: 'r://x' } as Resource;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [prompt],
      resources: [resource],
      status: MCPServerStatus.CONNECTED,
    });

    h.emit(key, { type: 'prompts', prompts: [prompt] as never });
    h.emit(key, { type: 'resources', resources: [resource] });

    expect(h.manager.getPromptsByServer('srv')).toEqual([prompt]);
    expect(h.manager.getResources()).toEqual([
      { ...resource, serverName: 'srv' },
    ]);
    expect(h.manager.findResourceByUri('srv:r://x')).toEqual({
      ...resource,
      serverName: 'srv',
    });
  });

  it('resolves lazy mode into the injected tool set', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [fakeTool('always', true), fakeTool('deferred', false)],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });

    expect(
      h.manager.getInjectedMcpTools().tools.map((entry) => entry.toolName),
    ).toEqual(['always', 'deferred']);

    h.manager.setLazyMode(true);

    expect(h.context.mcpToolListChange).toHaveBeenCalled();
    expect(h.manager.getInjectedMcpTools()).toMatchObject({
      includeMetaTools: true,
    });
    expect(
      h.manager.getInjectedMcpTools().tools.map((entry) => entry.toolName),
    ).toEqual(['always']);
  });

  it('passes elicitation handlers only for session-owned registrations', async () => {
    const h = createHarness({
      servers: { dyn: stdio('dynamic'), project: stdio('project') },
    });
    await h.manager.initialize();

    const registrations = h.registered[0].registrations;
    const byName = new Map(
      registrations.map((registration) => [
        registration.key.name,
        registration.elicitationHandler,
      ]),
    );
    const dynamicHandler = byName.get('dyn');
    expect(dynamicHandler).toBeDefined();
    expect(byName.get('project')).toBeUndefined();

    const params = {
      mode: 'form' as const,
      message: 'need input',
      requestedSchema: { type: 'object' as const, properties: {} },
    };
    await dynamicHandler!.request(params, undefined, undefined);
    expect(h.elicitationHost.request).toHaveBeenCalledWith(
      'dyn',
      params,
      undefined,
      undefined,
    );
    dynamicHandler!.complete?.('e-1');
    expect(h.elicitationHost.complete).toHaveBeenCalledWith('dyn', 'e-1');
  });

  it('ignores pool events for keys this session does not have active', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    (h.context.mcpToolListChange as ReturnType<typeof vi.fn>).mockClear();
    const other = { source: 'file:/elsewhere', name: 'srv' } as McpServerKey;
    h.emit(other, { type: 'tools', tools: [] });
    expect(h.context.mcpToolListChange).not.toHaveBeenCalled();
  });
});

describe('SessionMcpManager prompt/resource access and status', () => {
  it('routes getPrompt/readResource through the pool by resolved key', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    await h.manager.getPrompt('srv', 'p', { a: '1' });
    await h.manager.readResource('srv', 'r://x');
    expect(h.mcpManager.getPrompt).toHaveBeenCalledOnce();
    expect(h.mcpManager.readResource).toHaveBeenCalledOnce();
    await expect(h.manager.getPrompt('nope', 'p')).rejects.toThrow(
      /Unknown MCP server/,
    );
  });

  it('reports status from the pool for active servers', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    expect(h.manager.getServerStatus('srv')).toBe(MCPServerStatus.CONNECTED);
    expect(h.manager.getServerStatus('unknown')).toBe(
      MCPServerStatus.DISCONNECTED,
    );
  });

  it('unregisters everything on dispose', async () => {
    const h = createHarness({ servers: { srv: stdio('project') } });
    await h.manager.initialize();
    await h.manager.dispose();
    expect(h.mcpManager.unregisterSession).toHaveBeenCalledWith('sess-1');
  });
});


describe('SessionMcpManager CodeMode deferral', () => {
  async function setup(
    mode: 'on' | 'only' = 'on',
    settings: Record<string, unknown> = {},
  ) {
    const h = createHarness({ servers: { srv: stdio('project') }, lazy: true });
    h.context.getCodeModeExposure = () => mode;
    h.context.getSetting = () => settings;
    h.manager.syncLazyMode();
    await h.manager.initialize();
    const client: FakeClient = {
      tools: [fakeTool('a'), fakeTool('pinned', true)],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    };
    h.clients.set(
      mcpServerKeyId(h.manager.serverNameToServerKey('srv')!),
      client,
    );
    return { ...h, client };
  }

  it('declares small catalogs once, retains late servers as deferred, and decides again after reset', async () => {
    const h = await setup();
    expect(h.manager.peekLazyMode()).toBe(false);
    expect(h.manager.peekRegistrationMode()).toBe('deferred');
    expect(h.manager.getInjectedMcpTools().tools).toHaveLength(2);
    h.manager.settleMcpDeferral(200_000);
    expect(h.manager.peekAppliedRegistration().declaredMcpServers).toEqual(
      new Set(['srv']),
    );
    expect(h.manager.peekRegistrationMode()).toBe('eager');
    expect(h.toolRegistry.invalidateSchemaCache).toHaveBeenCalled();

    const late = {
      ...fakeTool('late'),
      name: 'mcp__late__late',
      exposureHints: { namespace: { kind: 'mcp' as const, server: 'late' } },
    } as DiscoveredMCPTool;
    h.context.getMcpServers = () => ({
      srv: stdio('project'),
      late: { ...stdio('project'), args: ['late.js'] },
    });
    await h.manager.reloadMcpServers();
    h.clients.set(mcpServerKeyId(h.manager.serverNameToServerKey('late')!), {
      tools: [late],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    h.manager.settleMcpDeferral(200_000);
    expect(h.manager.peekAppliedRegistration().declaredMcpServers).toEqual(
      new Set(['srv']),
    );
    expect(h.manager.peekRegistrationMode()).toBe('deferred');
    h.manager.resetMcpDeferral();
    h.manager.settleMcpDeferral(200_000);
    expect(h.manager.peekAppliedRegistration().declaredMcpServers).toEqual(
      new Set(['srv', 'late']),
    );
    h.manager.resetMcpDeferral();
    h.manager.settleMcpDeferral(1);
    expect(h.manager.peekAppliedRegistration().declaredMcpServers.size).toBe(0);
  });

  it.each([
    ['only', {}, 200_000],
    ['on', { mcpDeferThreshold: 0 }, 200_000],
    ['on', {}, 1],
  ] as const)(
    'keeps tools deferred for mode=%s settings=%j window=%s',
    async (mode, settings, window) => {
      const h = await setup(mode, settings);
      h.manager.settleMcpDeferral(window);
      expect(h.manager.peekAppliedRegistration().declaredMcpServers.size).toBe(
        0,
      );
    },
  );

  it('does not declare a partial catalog while another server is still being discovered', async () => {
    const h = await setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(h.mcpManager.registerMcpServers).mockImplementation(
      async (_session, servers) => {
        await pending;
        return {
          serverCount: servers.length,
          newConnectionCount: servers.length,
          reusedConnectionCount: 0,
        };
      },
    );
    h.context.getMcpServers = () => ({
      srv: stdio('project'),
      slow: { ...stdio('project'), args: ['slow.js'] },
    });
    const reload = h.manager.reloadMcpServers();
    h.manager.settleMcpDeferral(200_000);
    expect(h.manager.peekAppliedRegistration().declaredMcpServers.size).toBe(0);
    finish();
    await reload;
    h.manager.resetMcpDeferral();
    h.manager.settleMcpDeferral(200_000);
    expect(h.manager.peekAppliedRegistration().declaredMcpServers).toEqual(
      new Set(['srv']),
    );
  });
});

describe('SessionMcpManager discovery wait', () => {
  it('waits only for requested normalized server names, and settles failed discoveries', async () => {
    let finishDocs!: () => void;
    let failSlow!: (reason: Error) => void;
    const docs = new Promise<void>((resolve) => {
      finishDocs = resolve;
    });
    const slow = new Promise<void>((_resolve, reject) => {
      failSlow = reject;
    });
    const h = createHarness({
      servers: {
        'dev-docs': stdio('project'),
        slow: { ...stdio('project'), args: ['slow.js'] },
      },
      waitForRegistration: true,
    });
    vi.mocked(h.mcpManager.getPendingDiscovery).mockImplementation((key) =>
      key.name === 'dev-docs' ? docs : slow,
    );
    const initialization = h.manager.initialize();
    await vi.waitFor(() => expect(h.registered).toHaveLength(1));
    await h.manager.whenDiscovered(['other']);
    let done = false;
    const waiting = h.manager.whenDiscovered(['dev_docs']).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finishDocs();
    await waiting;
    expect(done).toBe(true);
    const all = h.manager.whenDiscovered();
    failSlow(new Error('failed to connect'));
    await all;
    h.resolveRegistration!();
    await initialization;
  });

  it('includes servers waiting for startup readiness', async () => {
    let ready!: () => void;
    const h = createHarness({
      servers: { srv: stdio('project') },
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      waitForRegistration: true,
    });
    const initialization = h.manager.initialize();
    let done = false;
    const waiting = h.manager.whenDiscovered(['srv']).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    ready();
    await vi.waitFor(() => expect(h.registered).toHaveLength(1));
    expect(done).toBe(false);
    h.resolveRegistration!();
    await initialization;
    await waiting;
    expect(done).toBe(true);
  });
});

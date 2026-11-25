/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '../../config/config.js';
import { DEFAULT_CONFIG_PARAMETERS } from '../../test-utils/config.js';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GetPromptResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { ManagedMcpResource } from '../../config/managedResources.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { MCPServerStatus } from '../client/mcpClient.js';
import { McpSettingsGate, type McpServerGate } from '../gate.js';
import { McpManager } from '../mcpManager.js';
import type { McpClient } from '../client/mcpClient.js';
import type { McpClientEvent } from '../client/types.js';
import { mcpServerKeyId, type McpServerKey } from '../server-key.js';
import {
  McpAuthorizationRequiredError,
  type McpAuthorizationCoordinator,
} from '../authorization.js';
import {
  MCPOAuthProvider,
  getMcpOAuthBrowserOpener,
} from '../connector/oauth/provider.js';
import { SessionMcpManager } from './sessionMcpManager.js';
import { MCPOAuthTokenStorage } from '../oauth-token-storage.js';
import { getLazyMcpReminderAttachments } from '../../attachments/generators/mcp-lazy-generator.js';
import { createAttachmentContext } from '../../attachments/get-attachments.js';
import type { AttachmentExternalContext } from '../../attachments/types.js';
import { MCPDiscoveryState, type McpSessionContext } from './types.js';
import type {
  McpElicitationHandler,
  McpElicitationHost,
} from '../elicitation.js';

function fakeTool(
  serverToolName: string,
  alwaysLoad = false,
): DiscoveredMCPTool {
  return {
    serverToolName,
    description: `${serverToolName} desc`,
    parameterSchema: { type: 'object', properties: {} },
    alwaysLoad,
    name: `mcp__srv__${serverToolName}`,
    exposureHints: {
      namespace: { kind: 'mcp', server: 'srv' },
      pinned: alwaysLoad,
    },
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
  authorizationError?: McpAuthorizationRequiredError;
  discoveryError?: unknown;
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
  cwd?: string;
  waitForRegistration?: boolean;
  coordinator?: McpAuthorizationCoordinator;
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
  let listener:
    | ((key: McpServerKey, event: McpClientEvent) => void)
    | undefined;
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
    getTargetDir: () => options.cwd ?? '/project',
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
          getAuthorizationRequiredError: () => fake.authorizationError,
          getToolDiscoveryError: () => fake.discoveryError,
          isConnected: () => fake.status === MCPServerStatus.CONNECTED,
          getServerConfig: () =>
            ({ description: fake.description }) as MCPServerConfig,
          getInstructions: () => fake.instructions,
          recoverConnection: vi.fn(async () => {}),
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
    ...(options.coordinator
      ? { createAuthorizationCoordinator: () => options.coordinator! }
      : {}),
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

describe('managed MCP generations and session ownership', () => {
  const resource = (
    overrides: Partial<ManagedMcpResource> = {},
  ): ManagedMcpResource => ({
    id: 'connector',
    name: 'enterprise_123',
    originalName: 'docs',
    displayName: 'Docs',
    sourceId: 'identity:connector',
    config: stdio(),
    userVisible: true,
    userCanDisable: true,
    disabled: false,
    ...overrides,
  });
  function managedHarness(initial = [resource()], cwd?: string) {
    let resources = initial;
    const h = createHarness({ cwd });
    h.context.getManagedMcpServer = (name) =>
      resources.find((entry) => entry.name === name);
    h.context.getManagedMcpServers = () => resources;
    h.context.getMcpServerPermissionAliases = (name) => [
      name,
      ...(resources.find((entry) => entry.name === name) ? ['docs'] : []),
    ];
    h.context.getMcpServers = () =>
      Object.fromEntries(resources.map((entry) => [entry.name, entry.config]));
    return {
      ...h,
      setResources: (next: ManagedMcpResource[]) => {
        resources = next;
      },
    };
  }
  it('reuses policy-only updates but separates identities, actual configs and roots', async () => {
    const h = managedHarness();
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('enterprise_123')!;
    expect(key.source).toMatch(/^managed:/);
    h.setResources([resource({ userVisible: false })]);
    await h.manager.reloadMcpServers();
    expect(h.manager.serverNameToServerKey('enterprise_123')).toEqual(key);
    h.setResources([resource({ config: { ...stdio(), args: ['new.js'] } })]);
    await h.manager.reloadMcpServers();
    expect(h.manager.serverNameToServerKey('enterprise_123')).not.toEqual(key);
    expect(h.mcpManager.unregisterMcpServers).toHaveBeenCalledWith('sess-1', [
      key,
    ]);
    h.setResources([resource({ sourceId: 'other-user:connector' })]);
    await h.manager.reloadMcpServers();
    expect(h.manager.serverNameToServerKey('enterprise_123')?.source).toContain(
      'other-user:connector',
    );
    const other = managedHarness([resource()], '/other-root');
    await other.manager.initialize();
    expect(other.manager.serverNameToServerKey('enterprise_123')).not.toEqual(
      key,
    );
  });
  it('never stdio-deduplicates different managed Connector identities', async () => {
    const h = managedHarness([
      resource(),
      resource({
        id: 'other',
        name: 'enterprise_456',
        sourceId: 'identity:other',
      }),
    ]);
    await h.manager.initialize();
    expect(h.registered[0]?.keys).toEqual(['enterprise_123', 'enterprise_456']);
  });
  it('isolates session disables and ignores them only while locked', async () => {
    const a = managedHarness();
    const b = managedHarness();
    await a.manager.initialize();
    await b.manager.initialize();
    await a.manager.disableMcpServer('enterprise_123');
    expect(a.manager.isServerEnabled('enterprise_123')).toBe(false);
    expect(b.manager.isServerEnabled('enterprise_123')).toBe(true);
    a.setResources([resource({ userCanDisable: false })]);
    await a.manager.reloadMcpServers();
    expect(a.manager.isServerEnabled('enterprise_123')).toBe(true);
    await expect(a.manager.disableMcpServer('enterprise_123')).rejects.toThrow(
      'organization',
    );
    a.setResources([resource({ disabled: true })]);
    await a.manager.enableMcpServer('enterprise_123');
    expect(a.manager.isServerEnabled('enterprise_123')).toBe(false);
    a.setResources([resource({ sourceId: 'other-user:connector' })]);
    await a.manager.reloadMcpServers();
    expect(a.manager.isServerEnabled('enterprise_123')).toBe(true);
  });
  it('archives shadowed plugin and SDK sources and restores their registrations on withdrawal', async () => {
    const h = managedHarness();
    await h.manager.initialize();
    const plugin = {
      id: 'plugin',
      name: 'Plugin',
      path: '/plugin',
      mcpServers: { docs: stdio() },
    };
    await h.manager.startPlugin(plugin);
    const send = vi.fn();
    await h.manager.registerSdkMcpClients(['sdk'], send);
    h.setResources([
      resource({ originalName: 'sdk' }),
      resource({
        name: 'enterprise_456',
        originalName: 'docs',
        sourceId: 'identity:other',
      }),
    ]);
    await h.manager.reloadMcpServers();
    expect(h.manager.serverNameToServerKey('docs')).toBeUndefined();
    expect(h.manager.serverNameToServerKey('sdk')).toBeUndefined();
    h.setResources([]);
    await h.manager.reloadMcpServers();
    expect(h.manager.serverNameToServerKey('docs')?.source).toMatch(
      /^plugin:plugin~/,
    );
    expect(h.registered.at(-1)?.registrations).toEqual(
      expect.arrayContaining([expect.objectContaining({ sdkBridge: send })]),
    );
  });
  it.each(['sdk', 'plugin'] as const)(
    'rechecks permissions before restoring a shadowed %s server',
    async (source) => {
      const h = managedHarness();
      await h.manager.initialize();
      if (source === 'sdk') {
        await h.manager.registerSdkMcpClients(['docs'], vi.fn());
      } else {
        await h.manager.startPlugin({
          id: 'plugin',
          name: 'Plugin',
          path: '/plugin',
          mcpServers: { docs: stdio() },
        });
      }
      h.context.getBlockedMcpServers = () => ['docs'];
      h.setResources([]);
      vi.mocked(h.mcpManager.registerMcpServers).mockClear();

      await h.manager.reloadMcpServers();

      expect(h.manager.canUseMcpServer('docs')).toBe(false);
      expect(h.manager.getMcpServerDenyMessage('docs')).toContain('mcp.excluded');
      expect(h.mcpManager.registerMcpServers).not.toHaveBeenCalled();
    },
  );

  it('rejects reserved SDK, plugin and ad-hoc names before registering anything', async () => {
    const h = managedHarness();
    await expect(
      h.manager.registerSdkMcpClients(['enterprise_123'], vi.fn()),
    ).rejects.toThrow('reserved');
    await expect(
      h.manager.startPlugin({
        id: 'p',
        name: 'Plugin',
        path: '/plugin',
        mcpServers: { ordinary: stdio(), enterprise_123: stdio() },
      }),
    ).rejects.toThrow('reserved');
    await expect(
      h.manager.maybeDiscoverMcpServer('enterprise_123', stdio()),
    ).rejects.toThrow('reserved');
    expect(h.registered).toEqual([]);
  });

  it('does not let a locked enterprise server bypass workspace trust', async () => {
    const h = managedHarness([resource({ userCanDisable: false })]);
    h.context.isTrustedFolder = () => false;
    await h.manager.initialize();
    expect(h.registered).toEqual([]);
    expect(h.manager.canUseMcpServer('enterprise_123')).toBe(false);

    h.context.isTrustedFolder = () => true;
    await h.manager.reloadMcpServers();
    expect(h.registered.at(-1)?.keys).toEqual(['enterprise_123']);
  });
});

describe('SessionMcpManager registration and gate', () => {
  it('reports a failed tool discovery as the server error', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('docs')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    await h.manager.reloadMcpServers();
    expect(h.manager.getLastError('docs')).toBeUndefined();

    const client = h.manager.getClientByName('docs')!;
    vi.spyOn(client, 'getToolDiscoveryError').mockReturnValue(
      new Error('MCP error -32001: Request timed out'),
    );
    expect(h.manager.getLastError('docs')).toContain('Request timed out');
    await h.manager.dispose();
  });

  it('marketplace metadata does not register an unchanged active server again', async () => {
    const config = stdio('project');
    const h = createHarness({ servers: { docs: config } });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('docs')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.CONNECTED,
    });
    config.marketplaceMetadata = {
      marketItemId: 'notion',
      displayName: 'Notion',
      version: '1',
    };
    h.context.getMcpServers = () => ({ docs: stdio('project') });
    await h.manager.reloadMcpServers();
    expect(h.registered).toHaveLength(1);
    h.context.getMcpServers = () => ({
      docs: { ...stdio('project'), args: ['changed.js'] },
    });
    await h.manager.reloadMcpServers();
    expect(h.registered).toHaveLength(2);
    await h.manager.dispose();
  });
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
  ])(
    'publishes completed discovery state on initialization and reload with $label',
    async ({ servers }) => {
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
    },
  );

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
  it('post plugin context retains the loaded version', async () => {
    const h = createHarness();
    await h.manager.initialize();
    await h.manager.startPlugin({
      name: 'demo',
      path: '/plugins/demo',
      id: 'demo@market',
      version: '1.2.3',
      mcpServers: { srv: stdio() },
    });
    expect(
      h.manager.listMcpServers().find((server) => server.name === 'srv')?.config
        .plugin,
    ).toMatchObject({ id: 'demo@market', name: 'demo', version: '1.2.3' });
  });
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
    expect(
      h.manager.getLazyDiscoveredMcpTools().map((e) => e.toolName),
    ).toEqual(['a']);
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
      mcpServerKeyId(key) === mcpServerKeyId(slow)
        ? new Promise(() => {})
        : undefined,
    );
    expect(h.manager.getStartupSnapshot()).toEqual({
      active: 2,
      pending: 1,
      tools: 2,
    });
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
    const entry =
      h.manager.getLazyDiscoveredMcpToolByQualifiedName('mcp__srv__search')!;
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
    const entry =
      h.manager.getLazyDiscoveredMcpToolByQualifiedName('mcp__srv__search')!;
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
  async function setup(settings: Record<string, unknown> = {}) {
    const h = createHarness({ servers: { srv: stdio('project') }, lazy: true });
    h.context.getCodeModeExposure = () => 'on';
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
    return h;
  }

  it.each([{}, { mcpDeferThreshold: 0 }, { mcpDeferThreshold: 100 }])(
    'discovers ordinary tools and keeps pinned tools declared with settings %j',
    async (settings) => {
      const h = await setup(settings);
      expect(h.manager.getDeclaredMcpToolNames()).toEqual(['mcp__srv__pinned']);
      expect(h.manager.getLazyMcpServerSnapshot()).toMatchObject([
        { serverName: 'srv', toolNames: ['mcp__srv__a'] },
      ]);
    },
  );

  it('announces tools on newly discovered servers as a catalog delta', async () => {
    const h = await setup();
    const ctx = createAttachmentContext('/test', 's');
    const ext: AttachmentExternalContext = {
      mcpClientManager: h.manager,
      toolRegistry: {
        hasToolEnabled: () => true,
        getCodeModeExposure: () => 'on',
      },
    };
    const [initial] = getLazyMcpReminderAttachments(ctx, ext);
    expect(initial.addedNames).toEqual(['mcp__srv__a']);

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
    const [delta] = getLazyMcpReminderAttachments(ctx, ext);
    expect(delta.addedNames).toEqual([late.name]);
    expect(delta.removedNames).toEqual([]);
    expect(h.manager.getDeclaredMcpToolNames()).toEqual(['mcp__srv__pinned']);
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

describe('SessionMcpManager brokered authorization', () => {
  function coordinator(overrides: Partial<McpAuthorizationCoordinator> = {}) {
    let state: 'polling' | undefined = 'polling';
    const fake = {
      canHandle: () => true,
      getAction: () => undefined,
      getState: () => state,
      authorize: vi.fn(async () => ({ state: 'completed' as const })),
      registerAction: vi.fn(),
      cancelServer: vi.fn(() => {
        state = undefined;
      }),
      cancelAll: vi.fn(),
      ...overrides,
    } as unknown as McpAuthorizationCoordinator;
    return { fake, setState: (next: 'polling' | undefined) => (state = next) };
  }

  it('cancels an active authorization and reports it as cancelled', () => {
    const { fake } = coordinator();
    const h = createHarness({ coordinator: fake });

    expect(h.manager.getAuthorizationState('srv')).toBe('polling');
    expect(h.manager.cancelAuthorization('srv')).toBe(true);
    expect(fake.cancelServer).toHaveBeenCalledWith('srv');
    expect(h.manager.getAuthorizationState('srv')).toBe('cancelled');
    expect(h.manager.cancelAuthorization('srv')).toBe(false);
  });

  it('adopts the current connection action before the status fan-out reaches this session', async () => {
    const action = {
      type: 'open_url' as const,
      serverId: 'user:apphub',
      connectionId: 'conn-1',
      authorizationRequestId: 'auth-1',
      url: new URL('https://auth.example.test/start'),
      expiresAtMs: Date.now() + 60_000,
    };
    let registered: typeof action | undefined;
    const { fake } = coordinator({
      getAction: () => registered,
      registerAction: vi.fn(
        (_name: string, next: typeof action) => {
          registered = next;
        },
      ) as never,
    });
    const h = createHarness({
      servers: { srv: { url: 'https://mcp.example.test/mcp' } },
      allowed: ['srv'],
      coordinator: fake,
    });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.AUTH_REQUIRED,
      authorizationError: new McpAuthorizationRequiredError(action),
    });

    await expect(h.manager.prepareMcpAuthorization('srv')).resolves.toEqual({
      kind: 'action',
      action,
    });
    expect(fake.registerAction).toHaveBeenCalledOnce();
    await h.manager.dispose();
  });

  it('replays a parked action when a session attaches to the pool', async () => {
    const action = {
      type: 'open_url' as const,
      serverId: 'user:apphub',
      connectionId: 'conn-1',
      authorizationRequestId: 'auth-1',
      url: new URL('https://auth.example.test/start'),
      expiresAtMs: Date.now() + 60_000,
    };
    const { fake } = coordinator();
    const h = createHarness({
      servers: { srv: { url: 'https://mcp.example.test/mcp' } },
      allowed: ['srv'],
      coordinator: fake,
    });
    await h.manager.initialize();
    const key = h.manager.serverNameToServerKey('srv')!;
    h.clients.set(mcpServerKeyId(key), {
      tools: [],
      prompts: [],
      resources: [],
      status: MCPServerStatus.AUTH_REQUIRED,
      authorizationError: new McpAuthorizationRequiredError(action),
    });
    h.context.getMcpServers = () => ({
      srv: { url: 'https://mcp.example.test/mcp?v=2' },
    });

    await h.manager.reloadMcpServers();

    expect(fake.registerAction).toHaveBeenCalledOnce();
    await h.manager.dispose();
  });

  it('keeps the last authorization outcome for status', async () => {
    const failure = {
      state: 'failed' as const,
      failure: { kind: 'provider_denied' as const, userMessage: 'denied' },
      canRetryAuthorization: true,
    };
    const { fake, setState } = coordinator();
    (fake as unknown as { authorize: unknown }).authorize = vi.fn(
      async () => {
        setState(undefined); // the task ends and the coordinator forgets it
        return failure;
      },
    );
    const h = createHarness({ coordinator: fake });

    await expect(
      h.manager.authorizeMcpServer('srv', {} as never),
    ).resolves.toEqual(failure);
    expect(h.manager.getAuthorizationOutcome('srv')).toEqual(failure);
    expect(h.manager.getAuthorizationState('srv')).toBe('failed');
  });
});

describe('SessionMcpManager host-driven authorization', () => {
  it('returns the auth URL when the provider reaches the opener', async () => {
    const h = createHarness({
      servers: {
        srv: {
          url: 'https://mcp.example.test/mcp',
          oauth: {
            enabled: true,
            clientId: 'client',
            authorizationUrl: 'https://auth.example.test/authorize',
            tokenUrl: 'https://auth.example.test/token',
          },
        } as MCPServerConfig,
      },
    });
    await h.manager.initialize();
    vi.spyOn(MCPOAuthProvider.prototype, 'authenticate').mockImplementation(
      () => {
        const opener = getMcpOAuthBrowserOpener();
        expect(opener).toBeTruthy();
        void Promise.resolve(
          opener?.('https://auth.example.test/authorize', {
            serverName: 'srv',
          } as never),
        ).catch(() => {});
        return new Promise(() => {});
      },
    );

    try {
      const start = await h.manager.authenticateWithHost('srv');
      expect(start).toEqual({
        requiresUserAction: true,
        authUrl: 'https://auth.example.test/authorize',
      });
    } finally {
      h.manager.cancelHostAuthorization('srv');
      vi.restoreAllMocks();
      await h.manager.dispose();
    }
  });
});

describe('session reload coordination', () => {
  it('keeps preparation behind an unfinished connection registration', async () => {
    const h = createHarness({ servers: { docs: stdio('project') }, waitForRegistration: true });
    const entered: string[] = [];
    const first = h.manager.reloadMcpServers({ prepare: async () => { entered.push('first'); return ['docs']; } });
    await vi.waitFor(() => expect(h.registered).toHaveLength(1));
    const second = h.manager.reloadMcpServers({ prepare: async () => { entered.push('second'); return ['docs']; } });
    await Promise.resolve();
    expect(entered).toEqual(['first']);
    h.resolveRegistration!();
    await Promise.all([first, second]);
    expect(entered).toEqual(['first', 'second']);
  });

  it('skips empty prepared targets without performing a full reload', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.reloadMcpServers({ prepare: async () => [] });
    expect(h.registered).toEqual([]);
  });

  it('stops obsolete registrations after awaiting removal and allows the next reload', async () => {
    const h = createHarness({ servers: { docs: stdio('project') } });
    await h.manager.initialize();
    let current = true;
    vi.mocked(h.mcpManager.unregisterMcpServers).mockImplementationOnce(async () => { current = false; });
    h.context.getMcpServers = () => ({ replacement: stdio('project') });
    const check = () => { if (!current) throw new Error('identity changed'); };
    const previous = h.registered.length;
    await expect(h.manager.reloadMcpServers({ assertCurrent: check })).rejects.toThrow('identity changed');
    expect(h.registered).toHaveLength(previous);
    current = true;
    await h.manager.reloadMcpServers({ assertCurrent: check });
    expect(h.registered.at(-1)?.keys).toEqual(['replacement']);
  });
});

it('a targeted refresh after account switch releases all old enterprise connections and restores ordinary names', async () => {
  const h = createHarness();
  const a: ManagedMcpResource = { id: 'a', name: 'enterprise_a', sourceId: 'org-user1-a', originalName: 'docs', displayName: 'Docs', config: { command: 'a' }, userVisible: true, userCanDisable: true, disabled: false };
  const b = { ...a, id: 'b', name: 'enterprise_b', sourceId: 'org-user1-b', originalName: 'search', config: { command: 'b' } };
  let generation = 'org-user1:1';
  let resources = [a, b];
  const config = new Config({ ...DEFAULT_CONFIG_PARAMETERS, managedResourcesProvider: {
    getIdentityGeneration: () => generation, readSkills: async () => [], readMcpServers: async () => resources,
    setSkillEnabled: async () => {}, setMcpServerEnabled: async () => {},
  }, mcpServers: { search: { command: 'ordinary-search' } } });
  // Bind the real Config and session manager; only transport registration uses the harness.
  Reflect.set(config, 'mcpClientManager', h.manager);
  h.context.getMcpServers = () => config.getMcpServers();
  h.context.getManagedMcpServer = (name) => config.getManagedMcpServer(name);
  h.context.getManagedMcpServers = () => config.getManagedMcpServers();
  h.context.getMcpServerPermissionAliases = (name) => config.getMcpServerPermissionAliases(name);
  try {
    await config.reloadManagedMcpServers();
    const oldA = h.manager.serverNameToServerKey(a.name)!;
    const oldB = h.manager.serverNameToServerKey(b.name)!;
    generation = 'org-user2:2';
    resources = [{ ...a, sourceId: 'org-user2-a' }];
    await config.reloadManagedMcpServers({ managedTargets: [resources[0]!] });
    expect(h.mcpManager.unregisterMcpServers).toHaveBeenCalledWith('sess-1', expect.arrayContaining([oldA, oldB]));
    expect(h.manager.serverNameToServerKey(b.name)).toBeUndefined();
    expect(h.manager.serverNameToServerKey(a.name)?.source).toContain('org-user2-a');
    expect(h.manager.serverNameToServerKey('search')).toBeDefined();
    expect(h.registered.at(-1)?.keys).toEqual(expect.arrayContaining([a.name, 'search']));
  } finally { await config.dispose(); }
});


describe('host OAuth invalidation', () => {
  const config = {
    url: 'https://mcp.example.test/mcp',
    oauth: { enabled: true },
  };

  it.each([false, true])(
    'clear invalidates a first authorization during exchange (withdrawn=%s)',
    async (withdrawn) => {
      const h = createHarness({ servers: { srv: config } });
      await h.manager.initialize();
      let finish!: () => void;
      let commit!: () => void;
      const remove = vi.fn(async () => {});
      const storage = vi
        .spyOn(MCPOAuthTokenStorage, 'forServer')
        .mockReturnValue({ deleteCredentials: remove } as never);
      const bare = vi
        .spyOn(MCPOAuthTokenStorage, 'deleteCredentialsByServerName')
        .mockResolvedValue(undefined);
      vi.spyOn(MCPOAuthProvider.prototype, 'authenticate').mockImplementation(
        async (_name, _config, _url, options) => {
          commit = options!.beforeTokenCommit!;
          await getMcpOAuthBrowserOpener()!(
            'https://auth.example.test/authorize',
            { serverName: 'srv', flowId: options!.flowId },
          );
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          commit();
          return { accessToken: 'late', tokenType: 'Bearer' };
        },
      );
      try {
        await h.manager.authenticateWithHost('srv');
        const callback = h.manager.submitHostAuthCallback(
          'srv',
          'https://local/callback',
        );
        const rejected = callback.catch((error) => error);
        await vi.waitFor(() => expect(finish).toBeDefined());
        if (withdrawn) {
          h.context.getMcpServers = () => ({});
          await h.manager.reloadMcpServers();
        }
        await h.manager.clearAuthorization('srv');
        expect(storage).toHaveBeenLastCalledWith('srv', config);
        expect(remove).toHaveBeenCalledOnce();
        expect(bare).not.toHaveBeenCalled();
        finish();
        expect(await rejected).toMatchObject({
          message: 'Authorization ended',
        });
        await h.manager.clearAuthorization('srv');
        expect(bare).not.toHaveBeenCalled();
      } finally {
        await h.manager.dispose();
        vi.restoreAllMocks();
      }
    },
  );

  it.each(['withdrawal', 'identity', 'policy'] as const)(
    'does not publish a URL after %s during discovery',
    async (reason) => {
      let allowed = true;
      const h = createHarness({
        servers: { srv: config },
        gate: {
          evaluate: () =>
            allowed
              ? { allowed: true }
              : { allowed: false, reason: 'enterprise' },
        },
      });
      let generation = 'a';
      h.context.getManagedMcpServer = () =>
        ({
          id: 'c',
          sourceId: 'org-user',
          name: 'srv',
          originalName: 'srv',
          config,
          userVisible: true,
          userCanDisable: true,
          disabled: false,
        }) as ManagedMcpResource;
      h.context.getManagedResourcesProvider = () =>
        ({ getIdentityGeneration: () => generation }) as never;
      await h.manager.initialize();
      let release!: () => void;
      vi.spyOn(MCPOAuthProvider.prototype, 'authenticate').mockImplementation(
        async (_name, _config, _url, options) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          await getMcpOAuthBrowserOpener()!('https://auth.example.test/stale', {
            serverName: 'srv',
            flowId: options!.flowId,
          });
          return { accessToken: 'unused', tokenType: 'Bearer' };
        },
      );
      try {
        const start = h.manager.authenticateWithHost('srv');
        const result = start.catch((error) => error);
        await vi.waitFor(() => expect(release).toBeDefined());
        if (reason === 'withdrawal') {
          h.context.getMcpServers = () => ({});
          h.context.getManagedMcpServer = () => undefined;
          await h.manager.reloadMcpServers();
        }
        if (reason === 'identity') generation = 'b';
        if (reason === 'policy') allowed = false;
        release();
        expect(await result).toMatchObject({ message: 'Authorization ended' });
      } finally {
        await h.manager.dispose();
        vi.restoreAllMocks();
      }
    },
  );
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as ClientLib from '@modelcontextprotocol/client';
import * as SdkClientStdioLib from '@modelcontextprotocol/client/stdio';
import * as GenAiLib from '@google/genai';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { MCPServerConfig, type Config } from '../config/config.js';
import type { PoolEntry, PooledConnection } from './mcp-pool-entry.js';
import { connectionIdOf, type McpTransportKind } from './mcp-pool-key.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { ResourceRegistry } from '../resources/resource-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { MCPServerStatus, updateMCPServerStatus } from './mcp-client.js';
import { WorkspaceMcpBudget } from './mcp-workspace-budget.js';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';
import {
  McpTransportPool,
  type McpTransportPoolOptions,
} from './mcp-transport-pool.js';
import { SessionMcpView } from './session-mcp-view.js';
import { ToolRegistry } from './tool-registry.js';

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return { ...actual, Client: vi.fn() };
});
vi.mock('@modelcontextprotocol/client/stdio');
vi.mock('@google/genai');

// F2 (#4175 follow-up — W134): mocked so per-test overrides can make
// `listDescendantPids` throw or return partial signaling. Defaults to
// empty descendants so existing tests behave unchanged.
vi.mock('./pid-descendants.js', () => ({
  listDescendantPids: vi.fn().mockResolvedValue([]),
  sigtermPids: vi.fn().mockReturnValue(0),
}));

// F2 (#4175 follow-up — W134): mocked so tests can assert debugLogger.warn
// got the silent-drop sweep observability payload (the production logger is
// session-gated, a no-op without an AsyncLocalStorage session). Singleton
// stub: the factory runs once and `() => stub` returns the same object on
// every `createDebugLogger(...)` call, so the module-load call in
// `mcp-pool-entry.ts` and the test's later retrieval share the same vi.fn
// instances. A per-call object would break that link.
vi.mock('../utils/debugLogger.js', () => {
  const stub = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { createDebugLogger: () => stub };
});

const cliConfig = { getMcpToolIdleTimeoutMs: () => 300000 } as Config;

function mkPoolOptions(
  overrides: Partial<McpTransportPoolOptions> = {},
): McpTransportPoolOptions {
  return {
    workspaceContext: {} as WorkspaceContext,
    debugMode: false,
    drainDelayMs: 1_000, // tight default for fast tests
    ...overrides,
  };
}
const mkPool = (overrides: Partial<McpTransportPoolOptions> = {}) =>
  new McpTransportPool(cliConfig, mkPoolOptions(overrides));
const pooled = (...kinds: McpTransportKind[]) =>
  new Set<McpTransportKind>(kinds);

/** Session registries; `spies` holds their six vi.fn methods. */
function mkSessionRegistries() {
  const spies = {
    registerTool: vi.fn(),
    removeMcpToolsByServer: vi.fn(),
    registerPrompt: vi.fn(),
    removePromptsByServer: vi.fn(),
    registerResource: vi.fn(),
    removeResourcesByServer: vi.fn(),
  };
  const { registerTool, removeMcpToolsByServer } = spies;
  const { registerPrompt, removePromptsByServer } = spies;
  const { registerResource, removeResourcesByServer } = spies;
  return {
    spies,
    tools: { registerTool, removeMcpToolsByServer } as unknown as ToolRegistry,
    prompts: {
      registerPrompt,
      removePromptsByServer,
    } as unknown as PromptRegistry,
    resources: {
      registerResource,
      removeResourcesByServer,
    } as unknown as ResourceRegistry,
  };
}
type Registries = ReturnType<typeof mkSessionRegistries>;
const clearSpies = (r: Registries) => {
  for (const spy of Object.values(r.spies)) spy.mockClear();
};

/**
 * Set up the MCP SDK mocks to simulate a successfully-connecting
 * stdio server with the given tool, prompt and resource names.
 * Returns the SDK client mock so tests can introspect connect calls.
 */
function mockMcpSuccess(
  opts: {
    toolNames?: string[];
    promptNames?: string[];
    resourceNames?: string[];
  } = {},
) {
  const tools = opts.toolNames ?? ['t1'];
  const prompts = opts.promptNames ?? [];
  const resources = opts.resourceNames ?? [];
  const mockedClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    registerCapabilities: vi.fn(),
    setRequestHandler: vi.fn(),
    getServerCapabilities: vi
      .fn()
      .mockReturnValue(prompts.length > 0 ? { prompts: {} } : {}),
    // Method-aware so `prompts/list` and `resources/list` each get a
    // correctly-shaped payload (discoverAndReturn issues both).
    request: vi.fn().mockImplementation((req: { method?: string }) => {
      if (req?.method === 'resources/list') {
        return Promise.resolve({
          resources: resources.map((uri) => ({ uri, name: uri })),
        });
      }
      return Promise.resolve({
        prompts: prompts.map((name) => ({ name, description: 'p' })),
      });
    }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    getInstructions: vi.fn(),
  };
  vi.mocked(ClientLib.Client).mockReturnValue(
    mockedClient as unknown as ClientLib.Client,
  );
  vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
    // Provide `close` so McpClient.disconnect()'s `await this.transport.close()`
    // doesn't throw, allowing the test to assert on the SDK Client's close.
    {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SdkClientStdioLib.StdioClientTransport,
  );
  vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
    tool: () =>
      Promise.resolve({
        functionDeclarations: tools.map((name) => ({
          name,
          parametersJsonSchema: { type: 'object' },
        })),
      }),
  } as unknown as GenAiLib.CallableTool);
  return mockedClient;
}
type McpMock = ReturnType<typeof mockMcpSuccess>;

/** Not async, so the caller keeps `pool.acquire`'s own microtask timing. */
const acquire = (
  pool: McpTransportPool,
  name: string,
  cfg: MCPServerConfig,
  sessionId: string,
  r: Registries = mkSessionRegistries(),
) => pool.acquire(name, cfg, sessionId, r.tools, r.prompts, r.resources);

/**
 * mockMcpSuccess, a pool, and session 's1' acquiring `node` as `name`.
 * `beforePool` runs after mockMcpSuccess installs the SDK mocks, so it can
 * override them.
 */
async function acquireOne(
  opts: {
    mcp?: Parameters<typeof mockMcpSuccess>[0];
    pool?: Partial<McpTransportPoolOptions>;
    name?: string;
    beforePool?: (mocked: McpMock) => void;
  } = {},
) {
  const mocked = mockMcpSuccess(opts.mcp);
  opts.beforePool?.(mocked);
  const pool = mkPool(opts.pool);
  const cfg = new MCPServerConfig('node');
  const r = mkSessionRegistries();
  const conn = await acquire(pool, opts.name ?? 'srv', cfg, 's1', r);
  return { mocked, pool, cfg, r, conn };
}

const argCfg = (arg: string) => new MCPServerConfig('node', [arg]);
const httpCfg = (url: string, authorization: string) =>
  new MCPServerConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    url,
    { Authorization: authorization },
  );
/** `node` config carrying per-session tool metadata. */
const metaCfg = (
  includeTools: string[],
  trusted: boolean,
  extra: Partial<MCPServerConfig> = {},
) =>
  ({
    command: 'node',
    includeTools,
    trust: trusted,
    alwaysLoadTools: trusted,
    ...extra,
  }) as MCPServerConfig;
const toolMeta = (serverToolName: string, trusted: boolean) => ({
  serverToolName,
  trust: trusted,
  alwaysLoad: trusted,
});
const enforceBudget = (clientBudget: number) =>
  new WorkspaceMcpBudget({ clientBudget, mode: 'enforce' });

const entriesOf = (pool: McpTransportPool) =>
  (pool as unknown as { entries: Map<string, PoolEntry> }).entries;
const entryOf = (pool: McpTransportPool, cfg: MCPServerConfig) =>
  entriesOf(pool).get(connectionIdOf('srv', cfg))!;
/**
 * Silent transport drop on 'srv': flip the entry's client and the global
 * status map to DISCONNECTED, which fires PoolEntry's statusChangeListener
 * (McpClient.onerror does the same in production).
 */
function silentDrop(entry: PoolEntry) {
  (entry as unknown as { client: { status: unknown } }).client.status =
    MCPServerStatus.DISCONNECTED;
  updateMCPServerStatus('srv', MCPServerStatus.DISCONNECTED);
}
/** Invoke the SDK client's `onerror`, assigned by McpClient.connect(). */
const sdkOnError = (mocked: McpMock, error: Error) =>
  (mocked as { onerror?: (e: Error) => void }).onerror?.(error);
/** Records the connection's 'failed' event. */
function captureFailed(conn: PooledConnection) {
  const seen: { event?: { lastError?: string } } = {};
  conn.on('event', (e) => {
    if (e.kind === 'failed') seen.event = e;
  });
  return seen;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('McpTransportPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('repairs only the calling App session pooled fingerprint without replay', async () => {
    vi.useRealTimers();
    function serverClient() {
      const client = mockMcpSuccess({
        toolNames: ['app-only'],
        resourceNames: ['ui://srv/app'],
      });
      client.listTools.mockResolvedValue({
        tools: [
          {
            name: 'app-only',
            inputSchema: { type: 'object' },
            _meta: { ui: { visibility: ['app'] } },
          },
        ],
      });
      const callTool = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Session not found'), { code: -32001 }),
        );
      Object.assign(client, { callTool });
      return { client, callTool };
    }
    const bootstrapClient = serverClient();
    const prompts = new PromptRegistry();
    const resources = new ResourceRegistry();
    const bootstrapConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: { command: 'node' } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => process.cwd(),
      getResourceRegistry: () => resources,
      getPromptRegistry: () => prompts,
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'bootstrap',
      isMcpServerDisabled: () => false,
      getMcpToolIdleTimeoutMs: () => 0,
      getDisabledTools: () => new Set<string>(),
      getMcpTransportPool: () => pool,
      getToolRegistry: () => bootstrapRegistry,
    } as unknown as Config;
    const pool = new McpTransportPool(
      bootstrapConfig,
      mkPoolOptions({ drainDelayMs: 0 }),
    );
    const bootstrapRegistry = new ToolRegistry(bootstrapConfig);
    const targetResources = new ResourceRegistry();
    let targetRegistry: ToolRegistry | undefined;
    try {
      const bootstrapManager = bootstrapRegistry.getMcpClientManager();
      await bootstrapManager.discoverAllMcpTools(bootstrapConfig);
      await bootstrapManager.discoverAllMcpTools(bootstrapConfig);
      expect(bootstrapClient.client.connect).toHaveBeenCalledOnce();
      expect(bootstrapRegistry.getMcpAppTool('srv', 'app-only')).toBeDefined();
      const targetClient = serverClient();
      const targetConfig = {
        ...bootstrapConfig,
        getSessionId: () => 'target',
        getToolInvocationGuard: () => vi.fn(),
        getMcpServers: () => ({
          srv: { command: 'node', args: ['different-fingerprint'] },
        }),
        getPromptRegistry: () => new PromptRegistry(),
        getResourceRegistry: () => targetResources,
        getToolRegistry: () => targetRegistry!,
      } as unknown as Config;
      targetRegistry = new ToolRegistry(targetConfig);
      await targetRegistry
        .getMcpClientManager()
        .discoverAllMcpTools(targetConfig);
      expect(pool.getSnapshot().byName['srv'].entryCount).toBe(2);
      const tool = targetRegistry.getMcpAppTool('srv', 'app-only');
      expect(tool).toBeDefined();
      const received = vi.fn();
      await expect(
        tool!
          .buildForApp({}, received, targetConfig)
          .execute(new AbortController().signal),
      ).rejects.toThrow('MCP App tool call failed.');
      expect(targetClient.callTool).toHaveBeenCalledOnce();
      expect(received).not.toHaveBeenCalled();
      expect(targetClient.client.connect).toHaveBeenCalledTimes(2);
      expect(bootstrapClient.client.connect).toHaveBeenCalledOnce();
      expect(bootstrapClient.client.close).not.toHaveBeenCalled();
      expect(bootstrapRegistry.getMcpAppTool('srv', 'app-only')).toBeDefined();
      expect(resources.getAllResources()).toHaveLength(1);
      expect(targetResources.getAllResources()).toHaveLength(1);
      const repaired = targetRegistry.getMcpAppTool('srv', 'app-only');
      expect(repaired).toBeDefined();
      targetClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'repaired' }],
      });
      await repaired!
        .buildForApp({}, received, targetConfig)
        .execute(new AbortController().signal);
      expect(targetClient.callTool).toHaveBeenCalledTimes(2);
      expect(received).toHaveBeenCalledOnce();
    } finally {
      await targetRegistry?.getMcpClientManager().stop();
      await bootstrapRegistry.getMcpClientManager().stop();
      await pool.drainAll({ timeoutMs: 1000 });
    }
  });

  describe('acquire / release lifecycle', () => {
    it('3 sessions acquiring same key share 1 entry (1 connect call)', async () => {
      const { mocked, pool, cfg, conn } = await acquireOne({
        mcp: { toolNames: ['greet'] },
      });
      const c2 = await acquire(pool, 'srv', cfg, 's2');
      const c3 = await acquire(pool, 'srv', cfg, 's3');

      expect(mocked.connect).toHaveBeenCalledTimes(1);
      expect(conn.id).toBe(c2.id);
      expect(c2.id).toBe(c3.id);
      // All three sessions appear in the pool snapshot for the entry.
      const snap = pool.getSnapshot();
      expect(snap.byName['srv'].entryCount).toBe(1);
      expect(snap.byName['srv'].entrySummary[0].refs).toBe(3);
    });

    it('refreshes one session metadata in place without mutating the shared snapshot', async () => {
      const mocked = mockMcpSuccess({
        toolNames: ['alpha', 'beta'],
        promptNames: ['alpha', 'beta'],
        resourceNames: ['file:///metadata'],
      });
      const pool = mkPool();
      const r = mkSessionRegistries();
      const cfg = metaCfg(['alpha'], false);
      const connection = await acquire(pool, 'srv', cfg, 's1', r);
      const s = r.spies;
      expect(s.registerTool).toHaveBeenCalledOnce();
      expect(s.registerTool.mock.calls[0][0]).toMatchObject(
        toolMeta('alpha', false),
      );
      expect(connection.toolsSnapshot).toHaveLength(2);
      expect(connection.toolsSnapshot.every((tool) => !tool.alwaysLoad)).toBe(
        true,
      );
      expect(s.registerPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'alpha' }),
      );
      expect(s.registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'file:///metadata' }),
      );

      clearSpies(r);
      connection.updateConfig(metaCfg(['beta'], true));

      expect(mocked.connect).toHaveBeenCalledOnce();
      expect(s.removeMcpToolsByServer).toHaveBeenCalledOnce();
      expect(s.registerTool).toHaveBeenCalledOnce();
      expect(s.registerTool.mock.calls[0][0]).toMatchObject(
        toolMeta('beta', true),
      );
      expect(s.removePromptsByServer).toHaveBeenCalledOnce();
      expect(s.registerPrompt).toHaveBeenCalledOnce();
      expect(s.registerPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'beta' }),
      );
      expect(s.removeResourcesByServer).toHaveBeenCalledOnce();
      expect(s.registerResource).toHaveBeenCalledOnce();
      expect(connection.toolsSnapshot.every((tool) => !tool.alwaysLoad)).toBe(
        true,
      );

      clearSpies(r);
      connection.updateConfig(
        metaCfg(['beta(args)', 'beta'], true, { excludeTools: [] }),
      );
      for (const spy of Object.values(s)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('projects different metadata for sessions sharing one transport', async () => {
      const mocked = mockMcpSuccess({ toolNames: ['alpha', 'beta'] });
      const pool = mkPool();
      const r1 = mkSessionRegistries();
      const r2 = mkSessionRegistries();
      const [cfg1, cfg2] = [metaCfg(['alpha'], false), metaCfg(['beta'], true)];
      const first = await acquire(pool, 'srv', cfg1, 's1', r1);
      const second = await acquire(pool, 'srv', cfg2, 's2', r2);

      expect(mocked.connect).toHaveBeenCalledOnce();
      expect(first.id).toBe(second.id);
      expect(r1.spies.registerTool).toHaveBeenCalledWith(
        expect.objectContaining(toolMeta('alpha', false)),
      );
      expect(r2.spies.registerTool).toHaveBeenCalledWith(
        expect.objectContaining(toolMeta('beta', true)),
      );
      expect(first.toolsSnapshot).toBe(second.toolsSnapshot);
      expect(first.toolsSnapshot.every((tool) => !tool.alwaysLoad)).toBe(true);
    });

    it('refreshes only the targeted session on a shared transport', async () => {
      mockMcpSuccess({ toolNames: ['alpha', 'beta'] });
      const pool = mkPool();
      const r1 = mkSessionRegistries();
      const r2 = mkSessionRegistries();
      const cfg = metaCfg(['alpha'], false);
      const first = await acquire(pool, 'srv', cfg, 's1', r1);
      await acquire(pool, 'srv', metaCfg(['beta'], false), 's2', r2);
      clearSpies(r1);
      clearSpies(r2);

      first.updateConfig(metaCfg(['beta'], true));

      // Session 1 reprojects with its new metadata.
      expect(r1.spies.registerTool).toHaveBeenCalledOnce();
      expect(r1.spies.registerTool).toHaveBeenCalledWith(
        expect.objectContaining(toolMeta('beta', true)),
      );

      // Session 2 must see zero registry traffic: a refresh for one
      // subscriber must not broadcast to siblings (tool loss + trust bleed).
      for (const spy of Object.values(r2.spies)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('rejects updateConfig on terminated entries and detached sessions', async () => {
      const { pool, cfg, conn } = await acquireOne();
      const entry = entryOf(pool, cfg);

      // Detached-session guard: no subscriber is attached under this id.
      expect(() => entry.updateSessionConfig('never-attached', cfg)).toThrow(
        /detached session/,
      );

      // Terminated-entry guard: a silent transport drop flips the active
      // entry to 'failed' (W120), after which refreshes must fail closed.
      silentDrop(entry);
      expect(entry.currentState).toBe('failed');
      expect(() => conn.updateConfig(cfg)).toThrow(/in state failed/);
    });

    it('refreshes unpooled metadata while keeping transport identity stable', async () => {
      const mocked = mockMcpSuccess({ toolNames: ['alpha', 'beta'] });
      const pool = mkPool({ pooledTransports: pooled() });
      const cfg = metaCfg(['alpha'], false);
      const r = mkSessionRegistries();
      const connection = await acquire(pool, 'srv', cfg, 's1', r);

      expect(connection.id).toBe('srv::unpooled-0');
      expect(connection.transportId).toBe(connectionIdOf('srv', cfg));
      const capturedTransportId = connection.transportId;
      const { registerTool, removeMcpToolsByServer } = r.spies;
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining(toolMeta('alpha', false)),
      );

      clearSpies(r);
      connection.updateConfig(metaCfg(['beta'], true));

      expect(mocked.connect).toHaveBeenCalledOnce();
      expect(removeMcpToolsByServer).toHaveBeenCalledOnce();
      expect(registerTool).toHaveBeenCalledOnce();
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining(toolMeta('beta', true)),
      );

      (cfg as { command?: string }).command = 'different-command';
      expect(connection.transportId).toBe(capturedTransportId);

      connection.release();
      expect(() =>
        connection.updateConfig({ command: 'node' } as MCPServerConfig),
      ).toThrow(/released MCP connection/);
    });

    it('resources discovered via the pool reach the session resource registry', async () => {
      const { r } = await acquireOne({
        mcp: { toolNames: ['t1'], resourceNames: ['file:///doc.txt'] },
      });

      // discoverAndReturn → markActive → attach replay → applyResources
      // registers the snapshot into THIS session's resource registry,
      // tagged with the originating serverName.
      expect(r.resources.registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'file:///doc.txt', serverName: 'srv' }),
      );
    });

    it('different env between two sessions creates 2 distinct entries (credential isolation)', async () => {
      const mocked = mockMcpSuccess();
      // Default pooledTransports excludes http (V21 C8 opt-in); enable
      // it so the credential-isolation invariant can be tested in pool
      // mode (otherwise both sessions take the unpooled bypass path,
      // which is trivially isolated by construction).
      const pool = mkPool({
        pooledTransports: pooled('stdio', 'websocket', 'http'),
      });
      const cfgA = httpCfg('https://api.x', 'tokenA');
      const cfgB = httpCfg('https://api.x', 'tokenB');
      const cA = await acquire(pool, 'srv', cfgA, 's1');
      const cB = await acquire(pool, 'srv', cfgB, 's2');
      expect(cA.id).not.toBe(cB.id);
      expect(mocked.connect).toHaveBeenCalledTimes(2);
      expect(pool.getSnapshot().byName['srv'].entryCount).toBe(2);
    });

    it('release brings refs to 0 → starts drain timer; new acquire within drain cancels', async () => {
      const { pool, cfg } = await acquireOne();
      pool.release(`srv::${'a'.repeat(16)}` as never, 'unknown'); // unknown id no-op
      pool.releaseSession('s1');
      // Drain timer started; reacquire within 1s cancels.
      await vi.advanceTimersByTimeAsync(500);
      const c2 = await acquire(pool, 'srv', cfg, 's2');
      expect(c2).toBeDefined();
      expect(pool.getSnapshot().byName['srv'].entrySummary[0].refs).toBe(1);
    });

    it('release brings refs to 0 + drain timer expires → entry closed', async () => {
      const { pool } = await acquireOne({ pool: { drainDelayMs: 100 } });
      pool.releaseSession('s1');
      await vi.advanceTimersByTimeAsync(150);
      // Entry removed via onClosed callback.
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });

    it('tracks unpooled entries so releaseSession closes them immediately', async () => {
      const { mocked, pool } = await acquireOne({
        pool: { pooledTransports: pooled() },
      });
      expect(pool.getSnapshot().byName['srv'].entryCount).toBe(1);

      pool.releaseSession('s1');
      expect(pool.getSnapshot().total).toBe(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(mocked.close).toHaveBeenCalledTimes(1);
    });

    it('applies session-level includeTools/excludeTools to unpooled tools (W81/W87)', async () => {
      mockMcpSuccess({ toolNames: ['allowed', 'denied'] });
      const pool = mkPool({ pooledTransports: pooled() });
      // MCPServerConfig positional: 9=trust, 11=includeTools, 12=excludeTools
      const cfg = new MCPServerConfig(
        'node',
        undefined, // args
        undefined, // env
        undefined, // cwd
        undefined, // url
        undefined, // httpUrl
        undefined, // headers
        undefined, // tcp
        undefined, // timeout
        true, // trust
        undefined, // description
        undefined, // includeTools
        ['denied'], // excludeTools
      );
      const r = mkSessionRegistries();
      await acquire(pool, 'srv', cfg, 's1', r);
      const { registerTool } = r.spies;
      // Pre-fix (legacy `discover()` + `attach(skipReplay: true)`) registered
      // BOTH tools, ignoring the session-level excludeTools and dropping
      // trust. The W81 fix routes through `discoverAndReturn` →
      // `markActive(snap)` → `attach` (no skipReplay), so `view.applyTools`
      // filters `denied` out and propagates cfg.trust to the registered tool.
      const registeredNames = registerTool.mock.calls.map(
        (args) => (args[0] as { name: string }).name,
      );
      expect(registeredNames).toEqual(['mcp__srv__allowed']);
      expect(registerTool).toHaveBeenCalledTimes(1);
      const registeredTool = registerTool.mock.calls[0]?.[0] as {
        trust?: boolean;
      };
      expect(registeredTool?.trust).toBe(true);
    });

    it('cancels in-flight unpooled acquire when releaseSession races the connect/discover window (W77)', async () => {
      // Hold the unpooled connect() inside the runWithTimeout window so
      // releaseSession fires before the entry turns active. Without the W77
      // fix the early sessionToEntries index is empty, releaseSession is a
      // no-op, and the post-await flow registers tools/prompts into a
      // session that has already been closed.
      const connectGate = deferred();
      const mocked = mockMcpSuccess();
      mocked.connect.mockImplementation(() => connectGate.promise);
      const pool = mkPool({ pooledTransports: pooled() });
      const r = mkSessionRegistries();
      const cfg = new MCPServerConfig('node');
      const acquirePromise = acquire(pool, 'srv', cfg, 's1', r);

      // Yield so `createUnpooledConnection` enters the await on connect.
      await Promise.resolve();
      await Promise.resolve();

      // Race: tear down the session while connect is still pending.
      // Pre-fix this returned silently (sessionToEntries empty). Post-fix
      // the early `indexAttach` lets releaseSession find the entry and fire
      // forceShutdown('manual'), which flips state to 'closed' synchronously.
      pool.releaseSession('s1');

      // Now let the connect resolve so the post-await flow runs.
      connectGate.resolve();

      await expect(acquirePromise).rejects.toThrow(
        /draining or unpooled.*was cancelled/,
      );

      // Entry is gone from both the forward and reverse indices.
      expect(pool.getSnapshot().total).toBe(0);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
      // The legacy unpooled discover() registers tools into the session
      // registry inside the await window, before cancellation is detectable,
      // so the W77 fix rolls them back via `view.teardown()` →
      // `removeMcpToolsByServer`; otherwise they would remain in the closed
      // session's registry.
      expect(r.spies.removeMcpToolsByServer).toHaveBeenCalledWith('srv');
    });
  });

  describe('pooled in-flight acquire (W90)', () => {
    it('transitions zombie entry to failed when transport silently drops, evicting from pool (W120)', async () => {
      // Pre-W120: McpClient.onerror / a silent transport drop writes
      // DISCONNECTED to the global serverStatuses; statusChangeListener
      // mirrored it into localStatus but state stayed 'active', so the pool
      // fast-path attached new sessions to the zombie entry, replayed stale
      // tools, and every tool call failed on the dead transport. Post-W120
      // the listener sets state='failed' synchronously when localStatus
      // flips to DISCONNECTED on an active entry (gated by
      // !restartInProgress so intentional restart-mid-disconnect doesn't
      // trip it), and emits 'failed'.
      const { pool, cfg, conn } = await acquireOne();
      const failed = captureFailed(conn);
      const entry = entryOf(pool, cfg);
      silentDrop(entry);

      expect(failed.event).toBeDefined();

      // W127: pre-W122 the entry stayed in `pool.entries` (the listener
      // didn't call `onClosed`) and the fast-path `attach()` rejected with
      // "Cannot attach to PoolEntry in state failed". W122 evicts it
      // synchronously via `onClosed`, and W125 adds a defense-in-depth
      // isTerminated() pre-check + try/catch fall-through, so a fresh
      // acquire for the same (name, cfg) misses the fast-path entirely and
      // spawns a new entry: the pool self-heals.
      const conn2 = await acquire(pool, 'srv', cfg, 's2');
      // entryIndex 1 confirms a NEW entry, not the zombie (entryIndex 0).
      expect(conn2.entryIndex).toBe(1);
      // pool.entries holds the fresh entry under the same id; the failed
      // one was evicted via the W122 onClosed call.
      expect(entryOf(pool, cfg)).not.toBe(entry);
    });

    it('catches silent transport drop during drain window (W131)', async () => {
      // Pre-W131 the W120 gate only fired on state 'active'. During the 30s
      // drain window (refs=0, state 'draining') a silent drop did NOT flip
      // state to 'failed'; a new acquire in that window hit the fast-path,
      // attach() accepted 'draining' (flipping to 'active') and replayed the
      // stale snapshot: the same zombie attach, shifted into drain. Post-W131
      // the gate covers 'active' || 'draining' and cancels the drain timer
      // in the same step.
      const { pool, cfg } = await acquireOne({ pool: { drainDelayMs: 1_000 } });
      // Detach: refs=0 → state='draining', drain timer running.
      pool.releaseSession('s1');

      const entry = entryOf(pool, cfg);
      // Re-acquire briefly just to get a PooledConnection handle for the
      // event subscription, then immediately release (back to 'draining').
      const failed = captureFailed(await acquire(pool, 'srv', cfg, 's-listen'));
      pool.releaseSession('s-listen');
      silentDrop(entry);

      expect(failed.event).toBeDefined();
      // W131 invariant: 'draining' → 'failed' (not left in 'draining' or
      // transitioned to 'closed').
      expect(entry.currentState).toBe('failed');

      // The listener also cancels the drain timer: advancing past the drain
      // window must leave the entry 'failed', not moved to 'closed' by a
      // stale forceShutdown('drain_timer'), which would silently happen if
      // `cancelDrainTimer()` in the wasDraining branch regressed, since
      // `forceShutdown` no-ops idempotently on `state === 'failed'`.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(entry.currentState).toBe('failed');
    });

    it('W125 else-if path: stale terminal entry evicted with budget released (R22 W125-followup A)', async () => {
      // Race: `forceShutdown` has run its sync part (state='closed' +
      // listener detach + emit + subscriber detach) but its async tail
      // (`await sweepAndDisconnect` → `updateGlobalStatus` → `onClosed`) is
      // pending, so pool.entries still holds the terminal entry and a
      // concurrent `pool.acquire` for the same id hits W125's else-if path.
      // Pre-R22 its bare `entries.delete(id)` leaked the budget slot for
      // good: the entry's own onClosed (firing once the sweep finished) saw
      // `entries.get(id) === undefined` and skipped the release. Post-R22
      // eviction routes through `evictEntry`, which releases the slot
      // inline, and `onClosed`'s identity check makes its later eviction a
      // safe no-op.
      const budget = enforceBudget(1);
      const { pool, cfg } = await acquireOne({ pool: { budget } });
      expect(budget.getReservedSlots()).toEqual(['srv']);
      const targetId = connectionIdOf('srv', cfg);
      const entries = entriesOf(pool);
      const oldEntry = entries.get(targetId)!;
      // Fire-and-forget: the sync part runs now, while
      // `await sweepAndDisconnect` and `onClosed` stay queued as microtasks.
      void oldEntry.forceShutdown('manual');
      expect(oldEntry.currentState).toBe('closed');
      // Critical precondition: pool.entries STILL has the terminal entry
      // (onClosed hasn't run). Without this the else-if path is unreachable.
      expect(entries.get(targetId)).toBe(oldEntry);

      // Concurrent acquire for the same fingerprint: existing &&
      // existing.isTerminated() → evictEntry → spawn → fresh entry.
      const conn2 = await acquire(pool, 'srv', cfg, 's2');
      // Fresh entry: different object, different entryIndex.
      const newEntry = entries.get(targetId)!;
      expect(newEntry).not.toBe(oldEntry);
      expect(conn2.entryIndex).toBe(1);
      // Released by evictEntry, re-reserved by the spawn: net 1 slot, not
      // the 0 (leak) of pre-R22 nor the 2 of a double-reserve regression.
      expect(budget.getReservedSlots()).toEqual(['srv']);

      // Drain the pending forceShutdown microtasks: the OLD entry's onClosed
      // hits `evictEntry`'s identity check (current === newEntry, not
      // oldEntry) and no-ops. The new entry must survive intact.
      await vi.runAllTimersAsync();
      expect(entries.get(targetId)).toBe(newEntry);
      expect(budget.getReservedSlots()).toEqual(['srv']);
    });

    it('PoolEntry.attach rejects on terminal-state entry (W90 contract — direct probe; W125 made the pool fast-path self-heal so we exercise the guard at the entry level)', async () => {
      // The W90 guard catches a `forceShutdown` landing on the spawned entry
      // between `spawnEntry.entries.set` and our post-await `attach`. That
      // production window is essentially zero microtasks (markActive →
      // return → inFlight resolution are all sync), so we test the GUARD
      // directly rather than reconstructing the race. Pre-W125 the contract
      // also surfaced through the pool fast-path ("Cannot attach to
      // PoolEntry in state closed" out of `pool.acquire`); W125 wraps that
      // call in try/catch + falls through to spawn, so a session-level
      // acquire NEVER sees it (see the W120 test above). `PoolEntry.attach`
      // still throws on `closed`/`failed`, which the W90 post-await guard's
      // `entry.isTerminated()` branch relies on, so probe it directly.
      const { pool, cfg } = await acquireOne();
      const entry = entryOf(pool, cfg);
      // forceShutdown sets state='closed' synchronously before any await:
      // the same precondition the W90 post-await guard depends on.
      void entry.forceShutdown('manual');
      expect(entry.isTerminated()).toBe(true);
      const view = new SessionMcpView(
        mkSessionRegistries().tools,
        mkSessionRegistries().prompts,
        mkSessionRegistries().resources,
        's2',
        'srv',
        cfg,
      );
      expect(() => entry.attach('s2', view)).toThrow(
        /Cannot attach to PoolEntry/,
      );
    });

    it("re-indexes after attach so concurrent releaseSession during await doesn't leak the ref (W111)", async () => {
      // Pre-W111: releaseSession during the in-flight `await` on the POOLED
      // path called `sessionToEntries.delete(sid)`. The state went to
      // 'draining' (not terminal) so the `isTerminated()` guard didn't
      // fire, attach succeeded and added the ref, BUT
      // `sessionToEntries[sid]` stayed empty, so later releaseSession calls
      // returned early and the ref leaked for the entry's lifetime.
      // Post-fix: re-index AFTER attach succeeds, so a SECOND
      // releaseSession(sid) finds the id again and drains the entry.
      const connectGate = deferred();
      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      mocked.connect.mockImplementationOnce(() => connectGate.promise);

      const pool = mkPool({ drainDelayMs: 100 });
      const cfg = new MCPServerConfig('node');
      const acquirePromise = acquire(pool, 'srv', cfg, 's1');
      // Yield so s1 enters await inFlight (after the W90 early index).
      await Promise.resolve();
      // Release during the await window. Pre-W111 this wiped
      // sessionToEntries['s1'] (pooled + non-terminal: drain timer, not
      // forceShutdown); the attach below then re-activated the entry and
      // added the ref WITHOUT restoring the reverse-index entry.
      pool.releaseSession('s1');
      connectGate.resolve();
      await acquirePromise;

      // Sanity: after release-race-then-attach the entry is active with
      // refs=1 (we re-attached).
      expect(pool.getSnapshot().byName['srv'].entrySummary[0].refs).toBe(1);

      // THE critical assertion: a SECOND releaseSession('s1') must drop the
      // ref (pre-W111 a no-op with an empty reverse index).
      pool.releaseSession('s1');
      expect(pool.getSnapshot().byName['srv'].entrySummary[0].refs).toBe(0);
      // Drain timer fires within the 100ms grace; entry tears down.
      await vi.advanceTimersByTimeAsync(150);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });

    it('rolls back early reverse-index insertion when spawnInFlight rejects', async () => {
      // Pre-W90 the in-flight branch indexed sessionToEntries only AFTER
      // attach succeeded. Post-fix it indexes BEFORE the await so a
      // concurrent releaseSession during the spawn window can find the
      // eventual entry; the failure path must indexDetach in the catch so a
      // stale id doesn't outlive a rejected spawn.
      const mocked = mockMcpSuccess();
      mocked.connect.mockRejectedValueOnce(new Error('boom-connect'));
      const pool = mkPool();
      const cfg = new MCPServerConfig('node');
      const first = acquire(pool, 'srv', cfg, 's1');
      // Yield so 's1' enters spawnInFlight; 's2' joins via in-flight.
      await Promise.resolve();
      const second = acquire(pool, 'srv', cfg, 's2');

      await expect(first).rejects.toThrow(/boom-connect/);
      await expect(second).rejects.toThrow(/boom-connect/);

      // Reverse index must be empty for both sessions: releasing either is
      // a no-op (no stale id pointing at the never-spawned entry).
      pool.releaseSession('s1');
      pool.releaseSession('s2');
      expect(pool.getSnapshot().total).toBe(0);

      // Sanity: a fresh acquire on the same name now succeeds via a
      // brand-new spawn (no leftover state).
      mocked.connect.mockResolvedValueOnce(undefined);
      const c = await acquire(pool, 'srv', cfg, 's3');
      expect(c).toBeDefined();
    });

    // F2 (#4175 follow-up — W133-a / W134 PR B): self-heal observability.
    // W133-a threads the upstream `McpClient.onerror` cause into the
    // silent-drop 'failed' event's `lastError`; W134 surfaces orphan-process
    // pressure to operators via a structured warn log when the silent-drop's
    // `sweepAndDisconnect` throws on pid discovery or partially signals
    // descendants.

    it('threads upstream onerror cause into failed event lastError (W133-a)', async () => {
      // Pre-fix the silent-drop 'failed' event's `lastError` carried only
      // the synthetic marker 'transport disconnected (silent transport
      // drop)', so operators triaging it had to grep daemon `--debug` logs
      // for the matching `MCP ERROR (...)` line. Post-fix McpClient.onerror
      // stores the error in `lastTransportError` and the W120 silent-drop
      // block reads it via `getLastTransportError()` to append `: <message>`.
      const { mocked, conn } = await acquireOne();
      const failed = captureFailed(conn);

      // Production path: the `onerror` arrow McpClient.connect() assigned
      // during acquire sets `this.lastTransportError = error` AND
      // `updateStatus(DISCONNECTED)` synchronously, so the error is in place
      // by the time the W120 listener fires.
      sdkOnError(mocked, new Error('EPIPE: connection lost'));

      expect(failed.event).toBeDefined();
      expect(failed.event?.lastError).toContain('EPIPE: connection lost');
      // Keep the literal pre-fix marker so operator log-grep tooling that
      // targets `silent transport drop` keeps matching.
      expect(failed.event?.lastError).toContain('silent transport drop');
    });

    it('falls back to synthetic-only marker when no upstream onerror was captured (W133-a fallback)', async () => {
      // Guards the narrow race where the W120 listener fires from an
      // external `updateMCPServerStatus(name, DISCONNECTED)` write that did
      // NOT come from McpClient.onerror (e.g. a sibling fingerprint's
      // `client.disconnect()` writing the shared map):
      // `getLastTransportError()` returns undefined and the caller falls
      // back to the synthetic-only string existing W120/W131 tests relied on.
      const { pool, cfg, conn } = await acquireOne();
      const failed = captureFailed(conn);

      // Bypass McpClient.onerror — write directly to the shared map.
      silentDrop(entryOf(pool, cfg));

      expect(failed.event).toBeDefined();
      // Synthetic-only string (no `: <message>` suffix).
      expect(failed.event?.lastError).toBe(
        'transport disconnected (silent transport drop)',
      );
    });

    const OBSERVABILITY = 'silent-drop sweep observability';
    const findObservability = (warn: Mock) =>
      warn.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes(OBSERVABILITY),
      );
    /**
     * Silent drop via the production onerror flow on an entry whose
     * transport has a pid; resolves to the observability warn message.
     * `configureSweep` sets the pid-descendants mocks.
     */
    const sweepWarn = async (configureSweep: () => void) => {
      // Singleton stub (see the vi.mock above): this is the warn vi.fn that
      // mcp-pool-entry.ts captured at module load. Clear earlier tests' calls.
      const warn = createDebugLogger('McpPool:Entry').warn as Mock;
      warn.mockClear();
      const { mocked } = await acquireOne({
        beforePool: () => {
          // The default transport mock has no `pid`; a numeric one passes
          // the helper's `t.pid > 0` guard so sweepAndDisconnect actually
          // invokes listDescendantPids.
          vi.mocked(SdkClientStdioLib.StdioClientTransport).mockReturnValue({
            close: vi.fn().mockResolvedValue(undefined),
            pid: 99999,
          } as unknown as SdkClientStdioLib.StdioClientTransport);
          configureSweep();
        },
      });
      sdkOnError(mocked, new Error('upstream EPIPE'));
      // sweepAndDisconnect runs asynchronously off the silent-drop chain;
      // wait for the chain's `.then(...)` (which decides on the warn).
      await vi.waitFor(() => {
        expect(findObservability(warn)).toBeDefined();
      });
      return findObservability(warn)![0] as string;
    };

    it('emits structured warn log when silent-drop sweep throws on pid discovery (W134)', async () => {
      // Pre-fix `void this.sweepAndDisconnect('silent_drop')` swallowed the
      // pid-sweep failure entirely: operators detecting orphan-process
      // pressure had no signal beyond tailing `--debug warn+` for the inner
      // sweep log line. Post-fix the silent-drop chain captures the
      // SweepResult and emits a structured outer warn when `pidSweepError`
      // is set. The sweep throws as when pgrep is blocked by a sandbox or a
      // similar enumeration failure.
      const message = await sweepWarn(() => {
        vi.mocked(listDescendantPids).mockRejectedValueOnce(
          new Error('pgrep blocked by sandbox'),
        );
      });

      // The payload carries the orphan-process-pressure hint and the
      // underlying pid-sweep error message.
      expect(message).toContain('orphan-process pressure');
      expect(message).toContain('pgrep blocked by sandbox');
      // F2 (#4175 follow-up — copilot review T2 on #4460): when the pid
      // sweep itself throws, the counts are genuinely unmeasured; an
      // explicit sentinel distinguishes "not measured" from "0 found".
      expect(message).toContain('descendantsFound=unknown');
      expect(message).toContain('descendantsSignaled=unknown');
    });

    it('emits structured warn log when silent-drop sweep partially signals descendants (W134 partial-signal)', async () => {
      // Pre-fix a partial signal (sigtermPids killed fewer than
      // listDescendantPids found: child exited mid-loop, EPERM on a child
      // the daemon doesn't own, etc.) had no operator-facing signal
      // (sweepAndDisconnect logged the success-with-partial path at
      // `debug`). Post-fix the silent-drop chain compares
      // descendantsSignaled with descendantsFound and emits the same outer
      // warn even though sweepAndDisconnect itself didn't throw.
      const message = await sweepWarn(() => {
        // Discovered 3 descendants; only signaled 1.
        vi.mocked(listDescendantPids).mockResolvedValueOnce([1001, 1002, 1003]);
        vi.mocked(sigtermPids).mockReturnValueOnce(1);
      });

      // descendantsFound=3 / descendantsSignaled=1; pidSweepError=none.
      expect(message).toContain('descendantsFound=3');
      expect(message).toContain('descendantsSignaled=1');
      expect(message).toContain('pidSweepError=none');
      expect(message).toContain('orphan-process pressure');
    });
  });

  describe('spawnInFlight dedupe', () => {
    it('5 concurrent acquires for same key → 1 spawn', async () => {
      const mocked = mockMcpSuccess();
      const pool = mkPool();
      const cfg = new MCPServerConfig('node');
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => acquire(pool, 'srv', cfg, `s${i}`)),
      );
      expect(mocked.connect).toHaveBeenCalledTimes(1);
      // All 5 handles share the same id.
      const ids = new Set(results.map((c) => c.id));
      expect(ids.size).toBe(1);
    });
  });

  /** One session 's1' holding srvA (`node`) and srvB (`node -v`). */
  const acquireTwoNames = async (pool: McpTransportPool) => {
    const r = mkSessionRegistries();
    await acquire(pool, 'srvA', new MCPServerConfig('node'), 's1', r);
    await acquire(pool, 'srvB', argCfg('-v'), 's1', r);
  };

  describe('releaseSession reverse index (V21-2)', () => {
    it('drops all entries the session holds in a single call', async () => {
      mockMcpSuccess();
      const pool = mkPool();
      await acquireTwoNames(pool);
      const beforeSnap = pool.getSnapshot();
      expect(beforeSnap.byName['srvA'].entrySummary[0].refs).toBe(1);
      expect(beforeSnap.byName['srvB'].entrySummary[0].refs).toBe(1);

      pool.releaseSession('s1');
      const afterSnap = pool.getSnapshot();
      expect(afterSnap.byName['srvA'].entrySummary[0].refs).toBe(0);
      expect(afterSnap.byName['srvB'].entrySummary[0].refs).toBe(0);
    });
  });

  describe('restartByName (§13)', () => {
    it('restart returns per-entry results when 1 entry matches', async () => {
      const { pool } = await acquireOne();
      const results = await pool.restartByName('srv');
      expect(results).toHaveLength(1);
      expect(results[0].restarted).toBe(true);
      expect(results[0].entryIndex).toBe(0);
    });

    it('re-arms drain timer when restarting an idle entry (W85/W106)', async () => {
      // Pre-W85/W106: doRestart cancels both drainTimer and maxIdleTimer at
      // the top and never re-armed them on success. Restarting
      // (/workspace/mcp/<srv>/restart) an entry with refs=0 (detached,
      // draining) moved it 'draining' → 'active' with both timers off, so
      // it sat active until the next acquire/restart/drainAll. Post-fix the
      // success path re-arms the drain timer because refs.size === 0.
      const { pool } = await acquireOne({ pool: { drainDelayMs: 100 } });
      // Detach: drain timer starts (refs=0).
      pool.releaseSession('s1');
      expect(pool.getSnapshot().byName['srv'].entryCount).toBe(1);

      const results = await pool.restartByName('srv');
      expect(results[0].restarted).toBe(true);

      // The re-armed drain timer should fire after the grace period
      // and close the entry — same lifecycle as a normal idle detach.
      await vi.advanceTimersByTimeAsync(150);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });

    it('restartByName with entryIndex filters to a single entry', async () => {
      mockMcpSuccess();
      const pool = mkPool({ pooledTransports: pooled('stdio', 'http') });
      await acquire(pool, 'srv', httpCfg('https://x', 'A'), 'sA');
      await acquire(pool, 'srv', httpCfg('https://x', 'B'), 'sB');

      const onlyOne = await pool.restartByName('srv', { entryIndex: 0 });
      expect(onlyOne).toHaveLength(1);
      expect(onlyOne[0].entryIndex).toBe(0);

      const all = await pool.restartByName('srv');
      expect(all).toHaveLength(2);
    });

    it('restartByName returns [] when no entries match', async () => {
      mockMcpSuccess();
      const results = await mkPool().restartByName('nonexistent');
      expect(results).toEqual([]);
    });

    it('restart fans out updated tool snapshot to attached subscribers (F2 commit 5 R3 / W40)', async () => {
      // Wenshao W40 review fold-in: the R3 fix (commit 5) added a
      // post-restart fan-out over `entry.subscribers` calling
      // `view.applyTools(this.toolsSnapshot)` / `view.applyPrompts(...)` so
      // attached sessions pick up the new snapshot. Nothing verified it; a
      // regression dropping the loop would leave sessions with stale
      // pre-restart tool registrations, exactly the bug R3 fixed. Count
      // `removeMcpToolsByServer` calls on the session registry
      // (SessionMcpView's `applyTools` removes existing tools, then
      // re-registers).
      const { pool, r } = await acquireOne({
        mcp: { toolNames: ['original'], resourceNames: ['res://r'] },
      });
      const { removeMcpToolsByServer, removeResourcesByServer } = r.spies;
      // Initial attach calls applyTools / applyResources once each → one
      // removeMcpToolsByServer + one removeResourcesByServer.
      const initialRemoveCalls = removeMcpToolsByServer.mock.calls.length;
      const initialResourceRemoveCalls =
        removeResourcesByServer.mock.calls.length;
      expect(initialRemoveCalls).toBeGreaterThanOrEqual(1);
      expect(initialResourceRemoveCalls).toBeGreaterThanOrEqual(1);
      const results = await pool.restartByName('srv');
      expect(results[0].restarted).toBe(true);
      // Post-restart fan-out → one more applyTools AND applyResources call,
      // so one more of each remove (R3 contract: subscribers get the new
      // snapshot via direct `view.applyTools` / `view.applyResources`, not
      // via event subscription).
      expect(removeMcpToolsByServer.mock.calls.length).toBeGreaterThan(
        initialRemoveCalls,
      );
      expect(removeResourcesByServer.mock.calls.length).toBeGreaterThan(
        initialResourceRemoveCalls,
      );
    });

    it('a transiently-empty resources/list on restart keeps the snapshot for new sessions', async () => {
      // Initial discovery exposes a resource.
      const { pool, cfg } = await acquireOne({
        mcp: { toolNames: ['t1'], resourceNames: ['res://keep'] },
      });

      // The restart's re-read returns NO resources (a transient resources/list
      // failure swallowed to []). The next spawned client uses this mock.
      mockMcpSuccess({ toolNames: ['t1'], resourceNames: [] });
      await pool.restartByName('srv');

      // A NEW session attaching after the restart must still receive the prior
      // resource: the entry's snapshot was preserved, not overwritten with [].
      const r2 = mkSessionRegistries();
      await acquire(pool, 'srv', cfg, 's2', r2);
      expect(r2.resources.registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'res://keep', serverName: 'srv' }),
      );
    });
  });

  describe('getSnapshot', () => {
    it('reports subprocessCount as live stdio+websocket entries', async () => {
      const { pool } = await acquireOne();
      const snap = pool.getSnapshot();
      expect(snap.subprocessCount).toBe(1);
      expect(snap.total).toBe(1);
    });
  });

  describe('drainAll (§17 shutdown)', () => {
    it('disconnects all entries; reports drained count', async () => {
      const mocked = mockMcpSuccess();
      const pool = mkPool();
      await acquireTwoNames(pool);
      const result = await pool.drainAll({ force: true });
      expect(result.drained).toBe(2);
      expect(result.errors).toEqual([]);
      // McpClient.disconnect() (the wrapper) calls the underlying SDK
      // Client.close() (not Client.disconnect() — the SDK has no such
      // method). Asserting on .close catches the real teardown path.
      expect(mocked.close).toHaveBeenCalledTimes(2);
      // Pool state cleared.
      expect(pool.getSnapshot().total).toBe(0);
    });

    it('drains unpooled entries tracked in the pool map', async () => {
      const { mocked, pool } = await acquireOne({
        pool: { pooledTransports: pooled() },
      });

      const result = await pool.drainAll({ force: true });

      expect(result.drained).toBe(1);
      expect(mocked.close).toHaveBeenCalledTimes(1);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });
  });

  describe('workspace budget integration (F2 commit 6)', () => {
    it('refuses acquire past cap under enforce mode and records the refusal', async () => {
      mockMcpSuccess();
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
        onEvent,
      });
      const pool = mkPool({ budget });
      const r = mkSessionRegistries();
      await acquire(pool, 'srvA', argCfg('-a'), 's1', r);
      await acquire(pool, 'srvB', argCfg('-b'), 's1', r);
      // Third name exceeds the cap → BudgetExhaustedError.
      await expect(
        acquire(pool, 'srvC', argCfg('-c'), 's1', r),
      ).rejects.toThrow(/budget exhausted/i);
      // Pool's spawn dedup is keyed by id, so the refusal records a
      // refusal entry on the budget controller.
      expect(budget.getRefusedServerNames()).toContain('srvC');
    });

    it('releases the slot when the only entry for a name closes', async () => {
      const budget = enforceBudget(1);
      const { conn } = await acquireOne({
        name: 'srvA',
        pool: { budget, drainDelayMs: 1 },
      });
      expect(budget.getReservedSlots()).toEqual(['srvA']);
      conn.release();
      // Drain timer (1ms) needs to fire to actually close the entry.
      await vi.advanceTimersByTimeAsync(50);
      expect(budget.getReservedSlots()).toEqual([]);
    });

    it('preserves slot when entry closes during a same-name in-flight spawn (R1 race fix)', async () => {
      // Wenshao R1 review fold-in: the close-callback's sibling check used
      // to inspect only `this.entries`. If entry A for 'srvA' closed while a
      // divergent-fingerprint entry B for the same 'srvA' was still in
      // `spawnInFlight` (not yet in `this.entries`), the close path released
      // the slot prematurely, letting a third name slip past the cap once B
      // finished. Fix: also check `spawnInFlight` keys for `${name}::*`.
      mockMcpSuccess();
      const budget = enforceBudget(1);
      const pool = mkPool({ budget });
      const r = mkSessionRegistries();
      // Entry A spawns and is in `entries`.
      const connA = await acquire(pool, 'srvA', argCfg('-a'), 's1', r);
      // Entry B for same name (different fingerprint): kick off the spawn
      // but DON'T await. Called synchronously, its tryReserve resolves to
      // 'already_held' because A's reservation took the slot.
      const acquireB = acquire(pool, 'srvA', argCfg('-b'), 's1', r);
      // Force-close A while B is still in flight.
      connA.release();
      await vi.advanceTimersByTimeAsync(50);
      // B's spawn finishes — should still be the only remaining
      // entry for 'srvA', slot still held.
      await acquireB;
      // Now a name-different acquire should be REFUSED (B holds the
      // sole slot for 'srvA' but cap is 1, so 'srvC' overflows).
      await expect(
        acquire(pool, 'srvC', argCfg('-c'), 's1', r),
      ).rejects.toThrow(/budget exhausted/i);
    });

    it("does NOT phantom-release when 'already_held' spawn fails (R24 T17)", async () => {
      // R24 T17: pre-fix the spawn-failure catch called
      // `budget.release(serverName)` whenever `!hasNameSibling(serverName)`,
      // whether or not THIS acquire reserved a new slot. When `tryReserve`
      // returned 'already_held' (sibling A held the slot) and the sibling was
      // evicted between this acquire's `tryReserve` and its catch, the catch
      // released a slot this acquire never reserved. Set.delete idempotency
      // masked the drift, but the contract was wrong: the catch must roll
      // back THIS acquire's reservation only. Post-fix it checks
      // `reservationResult === 'reserved'` before releasing.
      const budget = enforceBudget(2);
      // Connect: first call (A's spawn) resolves; second call (B's
      // spawn) throws so B hits the catch path.
      let connectCallCount = 0;
      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      mocked.connect = vi.fn().mockImplementation(() => {
        connectCallCount += 1;
        if (connectCallCount === 1) return Promise.resolve(undefined);
        return Promise.reject(new Error('B spawn boom'));
      });

      const pool = mkPool({ budget });
      // A: tryReserve → 'reserved', spawn succeeds.
      await acquire(pool, 'srvA', argCfg('-a'), 's1');
      expect(budget.getReservedSlots()).toEqual(['srvA']);

      // B: same name, different fingerprint → tryReserve →
      // 'already_held'. Spawn throws.
      const releaseSpy = vi.spyOn(budget, 'release');
      await expect(acquire(pool, 'srvA', argCfg('-b'), 's2')).rejects.toThrow(
        /B spawn boom/,
      );

      // Post-R24: B's catch must NOT call release because
      // `reservationResult === 'already_held'`. Pre-R24 release was
      // called (no-op via Set.delete idempotency, but the call
      // happened, indicating the wrong contract).
      expect(releaseSpy).not.toHaveBeenCalled();
      // A still holds the slot.
      expect(budget.getReservedSlots()).toEqual(['srvA']);
    });

    it('rolls back the slot reservation on spawn failure', async () => {
      // Mock connect to throw → entry never reaches `markActive`,
      // pool's `entries.delete(id)` runs in the catch block.
      const failingClient = {
        connect: vi.fn().mockRejectedValue(new Error('boom')),
        disconnect: vi.fn(),
        close: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        failingClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue({
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as SdkClientStdioLib.StdioClientTransport);
      const budget = enforceBudget(1);
      const pool = mkPool({ budget });
      await expect(
        acquire(pool, 'srvA', new MCPServerConfig('node'), 's1'),
      ).rejects.toThrow();
      // The slot was reserved pre-spawn, then released because spawn
      // failed and no other entry holds the name. A subsequent
      // acquire should succeed without hitting the cap.
      expect(budget.getReservedSlots()).toEqual([]);
    });
  });
});

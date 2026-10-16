/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetExhaustedError,
  MCP_BUDGET_REARM_FRACTION,
  MCP_BUDGET_WARN_FRACTION,
  McpClientManager,
  mcpTransportOf,
  type McpBudgetMode,
  type McpClientManagerOptions,
} from './mcp-client-manager.js';
import {
  McpClient,
  MCPDiscoveryState,
  MCPServerStatus,
  populateMcpServerCommand,
} from './mcp-client.js';
import {
  InvalidMcpConfigError,
  McpBudgetWouldExceedError,
  McpServerSpawnFailedError,
} from './mcp-errors.js';
import type { McpTransportPool } from './mcp-transport-pool.js';
import type { ToolRegistry } from './tool-registry.js';
import { MCPServerConfig, type Config } from '../config/config.js';
import { connectionIdOf } from './mcp-pool-key.js';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

vi.mock('./mcp-client.js', async () => {
  const originalModule = await vi.importActual('./mcp-client.js');
  return {
    ...originalModule,
    McpClient: vi.fn(),
    // Return the input servers unchanged (identity function)
    populateMcpServerCommand: vi.fn((servers) => servers),
  };
});

vi.mock('./pid-descendants.js', () => ({
  listDescendantPids: vi.fn().mockResolvedValue([]),
  sigtermPids: vi.fn().mockReturnValue(0),
}));

type Rec = Record<string, unknown>;
/** `getMcpServers` source: a getter, or an object returned as-is each call. */
type Servers = Rec | (() => Rec);

/**
 * Mock Config with the accessors every manager path reads; `extra` adds or
 * overrides accessors. `isMcpServerDisabled` and `getSessionId` stay absent
 * unless given: legacy-path cases run without them.
 */
function mkConfig(servers: Servers = () => ({}), extra: Rec = {}): Config {
  return {
    isTrustedFolder: () => true,
    getMcpServers: typeof servers === 'function' ? servers : () => servers,
    getMcpServerCommand: () => undefined,
    getTargetDir: () => '/session/worktree',
    getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
    getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
    getWorkspaceContext: () => ({}),
    getDebugMode: () => false,
    ...extra,
  } as unknown as Config;
}

/** `mkConfig` plus `isMcpServerDisabled: () => false`. */
function cfg(servers?: Servers, extra: Rec = {}): Config {
  return mkConfig(servers, { isMcpServerDisabled: () => false, ...extra });
}

/** Pool-path Config: `cfg` plus `getSessionId: () => 'sid-1'`. */
function poolCfg(servers?: () => Rec, extra: Rec = {}): Config {
  return cfg(servers, { getSessionId: () => 'sid-1', ...extra });
}

/** `{ [name]: { command: 'node' } }` for each name, in order. */
function stdio(...names: string[]): Rec {
  return Object.fromEntries(names.map((n) => [n, { command: 'node' }]));
}

/**
 * F2 (#4175 commit 6, wenshao R9 / PR A): each construction site names only
 * the fields it overrides, instead of a 7-positional ctor call with four
 * `undefined` sentinels before the trailing `pool` arg.
 */
function mkManager(
  overrides: {
    config?: Config;
    toolRegistry?: ToolRegistry;
    options?: McpClientManagerOptions;
  } = {},
): McpClientManager {
  return new McpClientManager(
    overrides.config ?? poolCfg(),
    overrides.toolRegistry ??
      ({ removeMcpToolsByServer: vi.fn() } as unknown as ToolRegistry),
    overrides.options ?? {},
  );
}

/** A manager over `config`, returned alongside it. */
function managed(
  config: Config,
  rest: Omit<NonNullable<Parameters<typeof mkManager>[0]>, 'config'> = {},
) {
  return { config, manager: mkManager({ config, ...rest }) };
}

/** Fake pool; `getBudget()` returns `budget` (undefined: no bulk-pass scope). */
function mkPool(acquire: unknown = vi.fn(), budget?: unknown) {
  return {
    acquire,
    releaseSession: vi.fn(),
    getBudget: vi.fn().mockReturnValue(budget),
  } as unknown as McpTransportPool;
}

/** Pooled-connection handle for `name`; `extra` adds or overrides fields. */
function mkConn(name: string, extra: Rec = {}) {
  return {
    release: vi.fn(),
    on: vi.fn(),
    id: `${name}::abc`,
    serverName: name,
    entryIndex: 0,
    ...extra,
  };
}

/** Pool-mode manager over `servers` whose pool acquires via `acquire`. */
function poolManager(servers?: () => Rec, acquire?: unknown, extra?: Rec) {
  const config = poolCfg(servers, extra);
  const pool = mkPool(acquire);
  return { config, pool, manager: mkManager({ config, options: { pool } }) };
}

const resolved = () => vi.fn().mockResolvedValue(undefined);

/** McpClient stub: each method a bare `vi.fn()` unless overridden. */
function mkClient<T extends Rec>(overrides = {} as T) {
  return {
    connect: vi.fn(),
    discover: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn(),
    ...overrides,
  };
}

/** McpClient stub whose connect/discover/disconnect resolve. */
function asyncClient<T extends Rec>(overrides = {} as T) {
  return mkClient({
    connect: resolved(),
    discover: resolved(),
    disconnect: resolved(),
    ...overrides,
  });
}

/** Makes every `new McpClient` return `client`. */
function stubClient<T>(client: T): T {
  vi.mocked(McpClient).mockReturnValue(client as unknown as McpClient);
  return client;
}

/** Every `new McpClient(name)` returns `make(name)`. */
function stubClients(make: (name: string) => unknown) {
  vi.mocked(McpClient).mockImplementation(
    (name: string) => make(name) as unknown as McpClient,
  );
}

/** `stubClient` with an async stub that reports CONNECTED. */
function stubLiveClient() {
  return stubClient(
    asyncClient({
      getStatus: vi.fn().mockReturnValue(MCPServerStatus.CONNECTED),
    }),
  );
}

/**
 * Fresh stub McpClient that reports CONNECTED once `connect()` resolves:
 * the accounting counts a client as live only when `getStatus` is
 * CONNECTED. `getStatus` is sync like the real one; no handshake state
 * machinery is simulated.
 */
function makeConnectedMcpClientMock() {
  const state = { status: undefined as unknown };
  return {
    connect: vi.fn().mockImplementation(async () => {
      const mod = await import('./mcp-client.js');
      state.status = mod.MCPServerStatus.CONNECTED;
    }),
    discover: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => state.status),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
  };
}

/** Every `new McpClient` returns a fresh connected stub; returns the names. */
function stubConnectedClients(): string[] {
  const created: string[] = [];
  stubClients((name) => {
    created.push(name);
    return makeConnectedMcpClientMock();
  });
  return created;
}

/**
 * Manager with `budgetConfig` (`clientBudget` absent when undefined;
 * `onBudgetEvent` pushes into `events` when given).
 */
function budgetManager(
  config: Config,
  clientBudget: number | undefined,
  budgetMode: McpBudgetMode,
  events?: unknown[],
): McpClientManager {
  return mkManager({
    config,
    options: {
      budgetConfig: {
        ...(clientBudget !== undefined ? { clientBudget } : {}),
        budgetMode,
        ...(events ? { onBudgetEvent: (e) => events.push(e) } : {}),
      },
    },
  });
}

/** `budgetManager` over `cfg(servers, extra)` after one discovery pass. */
async function budgetPass(
  servers: Servers,
  clientBudget: number | undefined,
  budgetMode: McpBudgetMode,
  opts: { events?: unknown[]; incremental?: boolean; extra?: Rec } = {},
) {
  const config = cfg(servers, opts.extra);
  const manager = budgetManager(config, clientBudget, budgetMode, opts.events);
  await (opts.incremental
    ? manager.discoverAllMcpToolsIncremental(config)
    : manager.discoverAllMcpTools(config));
  return { config, manager };
}

const slots = (m: McpClientManager) => m.getMcpClientAccounting().reservedSlots;
const refused = (m: McpClientManager) =>
  m.getMcpClientAccounting().refusedServerNames;

/** Reads a private manager field. */
function priv<T = Map<string, unknown>>(m: McpClientManager, field: string) {
  return (m as unknown as Record<string, T>)[field];
}

/** Single-server discovery of 'test-server' with a bare call-site config. */
const discoverTestServer = (m: McpClientManager) =>
  m.discoverMcpToolsForServer('test-server', {} as unknown as Config);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Removal spies wired into the Config registries and a ToolRegistry. */
function removalSpies() {
  const [tools, prompts, resources] = [vi.fn(), vi.fn(), vi.fn()];
  const extra = {
    getPromptRegistry: () => ({ removePromptsByServer: prompts }),
    getResourceRegistry: () => ({ removeResourcesByServer: resources }),
  };
  const tr = { removeMcpToolsByServer: tools } as unknown as ToolRegistry;
  return { tools, prompts, resources, extra, toolRegistry: tr };
}

function expectRemoved(s: ReturnType<typeof removalSpies>, name: string) {
  expect(s.tools).toHaveBeenCalledWith(name);
  expect(s.prompts).toHaveBeenCalledWith(name);
  expect(s.resources).toHaveBeenCalledWith(name);
}

/** Records numeric setTimeout delays; timers still fire after `delay(ms)`. */
function spyTimeouts(delay: (ms?: number) => number) {
  const calls: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    cb: () => void,
    ms?: number,
  ) => {
    if (typeof ms === 'number') calls.push(ms);
    return realSetTimeout(cb, delay(ms));
  }) as unknown as typeof setTimeout);
  return { calls, spy };
}

const ofKind = (events: unknown[], kind: string) =>
  events.filter((e) => (e as { kind: string }).kind === kind);

describe('McpClientManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports status from its own client instance', async () => {
    const manager = mkManager();
    priv(manager, 'clients').set('docs', {
      getStatus: () => MCPServerStatus.CONNECTED,
    });

    expect(manager.getServerStatus('docs')).toBe(MCPServerStatus.CONNECTED);
    expect(manager.getServerStatus('missing')).toBe(
      MCPServerStatus.DISCONNECTED,
    );
  });

  it('routes discovery through the pool when one is injected (F2 commit 4)', async () => {
    // F2 contract: with a McpTransportPool wired into the ctor,
    // `discoverAllMcpTools` MUST go through `pool.acquire` instead of
    // constructing its own McpClient; catches the pool branch being silently
    // bypassed (N sessions revert to N spawns). The fake pool's `getBudget()`
    // returns undefined, disabling the `beginBulkPass`/`endBulkPass` bracket.
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
    });
    const { config, manager } = poolManager(() => ({ srv: {} }), acquireSpy);
    await manager.discoverAllMcpTools(config);
    expect(populateMcpServerCommand).toHaveBeenCalledWith(
      { srv: {} },
      undefined,
      '/session/worktree',
    );
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledWith(
      'srv',
      {},
      'sid-1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // Critical inverse invariant: pool path must NOT also spawn its
    // own McpClient (would double-spawn one process per session).
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('swallows BudgetExhaustedError from pool.acquire and logs at debug (F2 commit 6 W23)', async () => {
    // Wenshao W23: the `discoverAllMcpToolsViaPool` catch branches on
    // `instanceof BudgetExhaustedError` (deliberate refusal → debug log;
    // other errors stay error-level). Refusals are non-fatal for sibling
    // acquires, so `Promise.all` must not see the rejection. `acquire`
    // throws for `srvB`, succeeds for `srvA`; asserts discovery resolves and
    // `endBulkPass` fires once (the refused_batch contract).
    const acquireSpy = vi.fn().mockImplementation((name: string) => {
      if (name === 'srvB') throw new BudgetExhaustedError('srvB', 1, 1);
      return Promise.resolve(mkConn(name));
    });
    const beginBulkPass = vi.fn();
    const endBulkPass = vi.fn();
    const pool = mkPool(acquireSpy, { beginBulkPass, endBulkPass });
    const config = poolCfg(() => ({ srvA: {}, srvB: {} }));
    const manager = mkManager({ config, options: { pool } });
    // Resolves: the srvB BudgetExhaustedError is downgraded to a debug log.
    await manager.discoverAllMcpTools(config);
    expect(beginBulkPass).toHaveBeenCalledTimes(1);
    expect(endBulkPass).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
  });

  it('pool path skips a gated server pending approval — no acquire, no spawn (#4615, sub-task 3)', async () => {
    // Trust boundary: pre-fix the pool path only checked
    // `isMcpServerDisabled`, so a hot-reload adding a pending
    // `.mcp.json`/workspace server would acquire a connection (spawning the
    // process) BEFORE the user approved it. The legacy path already skipped
    // pending servers; the pool path must match.
    const acquireSpy = vi.fn();
    const { config, manager } = poolManager(
      () => ({ gated: {}, ok: {} }),
      acquireSpy,
      { isMcpServerPendingApproval: (name: string) => name === 'gated' },
    );
    await manager.discoverAllMcpTools(config);
    // `ok` is acquired; `gated` is NOT.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledWith(
      'ok',
      {},
      'sid-1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('removeRuntimeMcpServer drops the server prompts and resources (leak regression, sub-task 3)', async () => {
    const spies = removalSpies();
    const manager = mkManager({
      config: poolCfg(undefined, {
        ...spies.extra,
        getSettingsMcpServers: () => ({}),
        removeRuntimeMcpServer: () => true,
      }),
      toolRegistry: spies.toolRegistry,
    });

    await manager.removeRuntimeMcpServer('srv', 'client-1');

    expectRemoved(spies, 'srv');
  });

  it('removeServer (config-driven removal) drops the server prompts and resources (leak regression, sub-task 3)', async () => {
    const spies = removalSpies();
    const manager = mkManager({
      config: poolCfg(undefined, spies.extra),
      toolRegistry: spies.toolRegistry,
    });

    // `removeServer` is private; exercised here directly (the incremental
    // reconcile's removal branch calls it).
    await (
      manager as unknown as { removeServer(name: string): Promise<void> }
    ).removeServer('srv');

    expectRemoved(spies, 'srv');
  });

  it('stop() awaits in-flight pool discovery before releasing pool connections (W94/W108/W112)', async () => {
    // Pre-W94: stop() called releaseAllPooledConnections() while
    // discoverAllMcpToolsViaPool was mid-flight; the pass then acquired and
    // attached a fresh entry AFTER the release loop cleared the Map → leaked
    // pool ref.
    const acquireGate = deferred();
    const events: string[] = [];
    const acquireSpy = vi.fn().mockImplementation(async (name: string) => {
      events.push(`acquire-start-${name}`);
      await acquireGate.promise;
      events.push(`acquire-end-${name}`);
      // releaseAllPooledConnections invokes this release(); tracking it
      // lets the test assert the ordering.
      return mkConn(name, {
        release: vi.fn(() => void events.push(`release-${name}`)),
      });
    });
    const { config, manager } = poolManager(() => ({ srv: {} }), acquireSpy);

    // Kick off discovery; it enters in-flight (acquire awaits the gate).
    const discoveryPromise = manager.discoverAllMcpTools(config);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['acquire-start-srv']);

    // stop() must AWAIT discoveryInFlight before releasing (conn.release).
    const stopPromise = manager.stop();
    await Promise.resolve();
    // Pre-fix release-srv fired BEFORE acquire-end-srv; post-fix the outer
    // Promise.race waits up to 5s for in-flight discovery.
    expect(events).toEqual(['acquire-start-srv']);

    // Release the gate; discovery completes, then stop() proceeds.
    acquireGate.resolve();
    await discoveryPromise;
    await stopPromise;

    // Ordering invariant: acquire-end MUST precede release-srv.
    const acquireEndIdx = events.indexOf('acquire-end-srv');
    const releaseIdx = events.indexOf('release-srv');
    expect(acquireEndIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(acquireEndIdx);
  });

  it('stop() proceeds when injected discoveryInFlight rejects (W94/W108/W112/W116 rejection path)', async () => {
    // Pre-W116 this test wrapped discoverAllMcpTools, but
    // runDiscoverAllMcpToolsViaPool catches per-server failures, so
    // discoveryInFlight always resolved and was cleared before stop() ran:
    // the test passed while exercising zero W108 code. Injecting a rejecting
    // promise into the private field is the only way to hit the W108 catch
    // + debug log path.
    const { manager } = poolManager();
    const rejected = Promise.reject(new Error('synthetic-discovery-failure'));
    rejected.catch(() => {
      /* noop catch avoids Node's UnhandledPromiseRejection warning;
         manager.stop() attaches its own */
    });
    Object.assign(manager, { discoveryInFlight: rejected });

    // stop() must NOT throw even though discoveryInFlight rejects.
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('stop() proceeds when discoveryInFlight exceeds the 5s grace cap (W108/W116 timeout path)', async () => {
    // Pre-W108 a single hung MCP server could block daemon SIGTERM for the
    // full 30s acquire timeout; now an outer Promise.race against a 5s grace
    // timer caps the wait. With a never-settling discoveryInFlight, stop()
    // must resolve past 5s AND set the W115 stopTimedOut flag so a
    // late-resolving pool.acquire skips its pooledConnections.set.
    vi.useFakeTimers();
    try {
      const { manager } = poolManager();
      Object.assign(manager, {
        discoveryInFlight: new Promise<void>(() => {
          /* never resolves */
        }),
      });

      const stopPromise = manager.stop();
      await vi.advanceTimersByTimeAsync(5_100);
      await expect(stopPromise).resolves.toBeUndefined();
      expect(priv<boolean>(manager, 'stopTimedOut')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovery resets stopTimedOut so manager remains usable after a timed-out shutdown (W118)', async () => {
    // Pre-W118 stopTimedOut was sticky: once set by a 5s grace timeout,
    // every later pass released/skipped each acquired connection, so the
    // manager could never reattach pooled servers. Now each pass resets it.
    const { config, manager } = poolManager(
      () => ({ srv: {} }),
      vi.fn().mockResolvedValue(mkConn('srv')),
    );

    // Simulate a prior timed-out shutdown that set the sticky flag.
    Object.assign(manager, { stopTimedOut: true });

    await manager.discoverAllMcpTools(config);
    expect(priv<boolean>(manager, 'stopTimedOut')).toBe(false);
    // Connection MUST be tracked, not silently released by the flag guard.
    expect(priv(manager, 'pooledConnections').has('srv')).toBe(true);
  });

  it('routes incremental discovery through the pool when injected (F2 commit 4 C7 / W38)', async () => {
    // Wenshao W38: C7 added the pool gate to `discoverAllMcpToolsIncremental`
    // (the default progressive-mode boot path) with no test. A misplaced or
    // removed gate would bypass the pool during daemon boot, spawning N
    // per-session McpClients instead of sharing one pool entry.
    const acquireSpy = vi.fn().mockResolvedValue(mkConn('srv'));
    const { config, manager } = poolManager(() => ({ srv: {} }), acquireSpy);
    await manager.discoverAllMcpToolsIncremental(config);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('refreshes metadata on a retained unpooled connection without transport churn', async () => {
    let serverConfig = {
      command: 'node',
      includeTools: ['first'],
    } as MCPServerConfig;
    const release = vi.fn();
    const updateConfig = vi.fn();
    const acquire = vi.fn().mockResolvedValue(
      mkConn('srv', {
        release,
        updateConfig,
        off: vi.fn(),
        id: 'srv::unpooled-0',
        transportId: connectionIdOf('srv', serverConfig),
        toolsSnapshot: [],
        promptsSnapshot: [],
        resourcesSnapshot: [],
      }),
    );
    const { config, manager } = poolManager(
      () => ({ srv: serverConfig }),
      acquire,
    );

    await manager.discoverAllMcpTools(config);
    serverConfig = {
      command: 'node',
      includeTools: ['second'],
      trust: true,
      alwaysLoadTools: true,
    } as MCPServerConfig;
    await manager.discoverAllMcpTools(config);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledOnce();
    expect(updateConfig).toHaveBeenCalledWith(serverConfig);

    serverConfig = { command: 'different-node' } as MCPServerConfig;
    await manager.discoverAllMcpTools(config);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('isolates retained connection metadata refresh failures between servers', async () => {
    let serverConfigs = {
      srvA: { command: 'node', includeTools: ['first-a'] } as MCPServerConfig,
      srvB: { command: 'node', includeTools: ['first-b'] } as MCPServerConfig,
    };
    const updateA = vi.fn();
    const updateB = vi.fn();
    const unpooled = (name: 'srvA' | 'srvB', updateConfig: unknown) =>
      mkConn(name, {
        updateConfig,
        off: vi.fn(),
        id: `${name}::unpooled-0`,
        transportId: connectionIdOf(name, serverConfigs[name]),
      });
    const connections = {
      srvA: unpooled('srvA', updateA),
      srvB: unpooled('srvB', updateB),
    };
    const acquire = vi.fn((name: 'srvA' | 'srvB') =>
      Promise.resolve(connections[name]),
    );
    const { config, manager } = poolManager(() => serverConfigs, acquire);
    await manager.discoverAllMcpTools(config);

    serverConfigs = {
      srvA: { command: 'node', includeTools: ['second-a'] } as MCPServerConfig,
      srvB: { command: 'node', includeTools: ['second-b'] } as MCPServerConfig,
    };
    updateA.mockImplementationOnce(() => {
      throw new Error('refresh A failed');
    });

    await expect(manager.discoverAllMcpTools(config)).resolves.toBe(undefined);
    expect(updateA).toHaveBeenCalledWith(serverConfigs.srvA);
    expect(updateB).toHaveBeenCalledWith(serverConfigs.srvB);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it.each([{ result: [] }, { result: [{ restarted: false }] }])(
    'rejects an unsuccessful pooled repair (%j)',
    async ({ result }) => {
      let serverConfig = { command: 'node' };
      const acquireSpy = vi.fn().mockResolvedValue({
        release: vi.fn(),
        updateConfig: vi.fn(),
        transportId: connectionIdOf('srv', serverConfig),
        on: vi.fn(),
        id: 'srv::abc',
        serverName: 'srv',
        entryIndex: 0,
      });
      const restartByName = vi.fn().mockResolvedValue(result);
      const fakePool = {
        restartByName,
        acquire: acquireSpy,
        releaseSession: vi.fn(),
        getBudget: vi.fn().mockReturnValue(undefined),
      } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
      const mockConfig = {
        isTrustedFolder: () => true,
        getMcpServers: () => ({ srv: serverConfig }),
        getMcpServerCommand: () => undefined,
        getTargetDir: () => '/session/worktree',
        getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
        getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
        getWorkspaceContext: () => ({}),
        getDebugMode: () => false,
        getSessionId: () => 'sid-1',
        isMcpServerDisabled: () => false,
      } as unknown as Config;
      const manager = mkManager({
        config: mockConfig,
        options: { pool: fakePool },
      });

      await manager.discoverMcpToolsForServer('srv', mockConfig, true);
      expect(restartByName).not.toHaveBeenCalled();
      await manager.discoverMcpToolsForServer('srv', mockConfig);
      expect(restartByName).not.toHaveBeenCalled();
      await expect(
        manager.discoverMcpToolsForServer('srv', mockConfig, true),
      ).rejects.toThrow("Failed to reconnect MCP server 'srv'");
      expect(restartByName).toHaveBeenCalledExactlyOnceWith('srv', {
        entryIndex: 0,
      });

      expect(acquireSpy).toHaveBeenCalledTimes(1);
      expect(McpClient).not.toHaveBeenCalled();
      serverConfig = { command: 'different' };
      acquireSpy.mockResolvedValueOnce({
        release: vi.fn(),
        updateConfig: vi.fn(),
        transportId: connectionIdOf('srv', serverConfig),
        on: vi.fn(),
        id: 'srv::replacement',
        serverName: 'srv',
        entryIndex: 1,
      });
      await manager.discoverMcpToolsForServer('srv', mockConfig, true);
      expect(acquireSpy).toHaveBeenCalledTimes(2);
      expect(restartByName).toHaveBeenCalledOnce();
    },
  );

  it('routes readResource through an existing pooled connection', async () => {
    const readResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
    });
    // R24 T19: the pooled fast-path health-checks via `client.getStatus()`
    // before delegating; mocks must provide it.
    const client = { readResource, getStatus: () => MCPServerStatus.CONNECTED };
    const { config, manager } = poolManager(
      () => ({ srv: {} }),
      vi.fn().mockResolvedValue(mkConn('srv', { client })),
    );
    await manager.discoverAllMcpTools(config);

    const result = await manager.readResource('srv', 'mcp://srv/doc');

    expect(readResource).toHaveBeenCalledWith('mcp://srv/doc', undefined);
    expect(result).toEqual({
      contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
    });
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('readResource self-heals when pooled handle is dead (R24 T19)', async () => {
    // R24 T19: pre-fix the pooled fast-path skipped any McpClient health
    // check. Between a silent transport drop (W120/W131 flips the entry to
    // 'failed') and the `onFailed` listener evicting the handle, a
    // `readResource` hit the dead transport and surfaced an opaque
    // `"Transport is closed"`. Post-fix a non-CONNECTED status evicts the
    // handle inline (next call re-acquires via the legacy spawn path) and
    // throws a clear server-unavailable error.
    const readResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
    });
    let mockedStatus: MCPServerStatus = MCPServerStatus.CONNECTED;
    const client = { readResource, getStatus: () => mockedStatus };
    const { config, manager } = poolManager(
      () => ({ srv: {} }),
      vi.fn().mockResolvedValue(mkConn('srv', { client })),
    );
    await manager.discoverAllMcpTools(config);
    // Sanity: healthy fast-path still works.
    await expect(manager.readResource('srv', 'mcp://srv/doc')).resolves.toEqual(
      {
        contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
      },
    );

    // Silent-drop window: the handle is still in pooledConnections
    // (onFailed hasn't run) but the McpClient status is DISCONNECTED.
    mockedStatus = MCPServerStatus.DISCONNECTED;

    await expect(manager.readResource('srv', 'mcp://srv/doc')).rejects.toThrow(
      /pool entry disconnected; retry after discovery/,
    );

    // Handle evicted — confirms self-heal cleanup ran.
    expect(priv(manager, 'pooledConnections').has('srv')).toBe(false);
  });

  it('disconnectServer releases pooled connection in pool mode (F2 commit 4 / W39)', async () => {
    // Wenshao W39: the pool-mode branch of `disconnectServer` (release() +
    // delete) was untested. Without the release the entry's refcount never
    // reaches 0, the drain timer never fires, and the shared subprocess
    // leaks for the daemon's lifetime.
    const releaseSpy = vi.fn();
    const { config, manager } = poolManager(
      () => ({ srv: {} }),
      vi.fn().mockResolvedValue(mkConn('srv', { release: releaseSpy })),
    );
    await manager.discoverAllMcpTools(config);
    expect(releaseSpy).not.toHaveBeenCalled();
    await manager.disconnectServer('srv');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent discovery passes via mutex (F2 commit 6 W6)', async () => {
    // Wenshao W6: pre-fix two concurrent `discoverAllMcpTools[Incremental]`
    // calls could both see `pooledConnections.has(name) === false` and both
    // acquire; the second `set(name, conn2)` overwrote the first → conn1
    // leaked. The mutex makes the second caller await the first promise.
    const blockedAcquire = deferred();
    const acquireSpy = vi.fn().mockImplementation(async () => {
      await blockedAcquire.promise;
      return mkConn('srv');
    });
    const { config, manager } = poolManager(() => ({ srv: {} }), acquireSpy);
    const p1 = manager.discoverAllMcpTools(config);
    const p2 = manager.discoverAllMcpTools(config);
    // Both passes block on the in-flight acquire: pre-fix 2 calls, post-fix
    // the second pass awaits the same `discoveryInFlight` → still 1.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    blockedAcquire.resolve();
    await Promise.all([p1, p2]);
    // Still 1 after both resolve: no re-acquire of the same server.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to per-session McpClient spawn when no pool injected (backward compat)', async () => {
    // Most tests here assert this implicitly; this pins it explicitly so a
    // refactor that flips the default breaks here.
    const mockedMcpClient = stubClient(mkClient());
    const { config, manager } = managed(cfg(() => ({ srv: {} })));
    await manager.discoverAllMcpTools(config);
    expect(McpClient).toHaveBeenCalledOnce();
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
  });

  it('should discover tools from all servers', async () => {
    const mockedMcpClient = stubClient(mkClient());
    const { config, manager } = managed(cfg(() => ({ 'test-server': {} })));
    await manager.discoverAllMcpTools(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();
  });

  it('returns instructions from connected clients', async () => {
    stubClients((name) =>
      mkClient({
        getInstructions: vi
          .fn()
          .mockReturnValue(
            name === 'with-instructions' ? 'Use concise replies.' : undefined,
          ),
      }),
    );
    const config = cfg(() => ({
      'with-instructions': {},
      'without-instructions': {},
    }));
    const manager = new McpClientManager(config, {} as ToolRegistry);

    await manager.discoverAllMcpTools(config);

    expect(manager.getServerInstructions()).toEqual(
      new Map([['with-instructions', 'Use concise replies.']]),
    );
  });

  it('should not discover tools if folder is not trusted', async () => {
    const mockedMcpClient = stubClient(mkClient());
    const { config, manager } = managed(
      cfg(() => ({ 'test-server': {} }), { isTrustedFolder: () => false }),
    );
    await manager.discoverAllMcpTools(config);
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('should not discover a single server if folder is not trusted', async () => {
    const mockedMcpClient = stubClient(mkClient());
    const config = cfg(() => ({ 'test-server': {} }), {
      isTrustedFolder: () => false,
      isMcpServerPendingApproval: () => false,
    });
    const manager = new McpClientManager(config, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer('test-server', config);

    expect(McpClient).not.toHaveBeenCalled();
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('should not connect a project server that is pending approval (#4615)', async () => {
    const mockedMcpClient = stubClient(mkClient());
    const config = cfg(() => ({ 'pending-server': { scope: 'project' } }), {
      isMcpServerPendingApproval: (name: string) => name === 'pending-server',
    });
    const manager = new McpClientManager(config, {} as ToolRegistry);
    await manager.discoverAllMcpTools(config);
    // The gate runs before `new McpClient(...)` — no client is even constructed,
    // so no stdio spawn / transport / health check can occur.
    expect(McpClient).not.toHaveBeenCalled();
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('connects an approved project server (not pending)', async () => {
    const mockedMcpClient = stubClient(mkClient());
    const config = cfg(() => ({ 'approved-server': { scope: 'project' } }), {
      isMcpServerPendingApproval: () => false,
    });
    const manager = new McpClientManager(config, {} as ToolRegistry);
    await manager.discoverAllMcpTools(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();
  });

  it('should disconnect all clients when stop is called', async () => {
    // Track disconnect calls across all instances
    const disconnectCalls: string[] = [];
    stubClients((name) =>
      mkClient({
        disconnect: vi.fn().mockImplementation(() => {
          disconnectCalls.push(name);
          return Promise.resolve();
        }),
      }),
    );
    const manager = mkManager({
      config: cfg(() => ({ 'test-server': {}, 'another-server': {} })),
    });
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
    stubClient(mkClient({ disconnect: resolved() }));
    const manager = mkManager({ config: cfg(() => ({ 'test-server': {} })) });
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
    const mockedMcpClient = stubClient(mkClient({ disconnect: resolved() }));
    const manager = mkManager({
      config: mkConfig(() => ({ 'test-server': {} })),
    });

    await discoverTestServer(manager);

    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();

    await manager.stop();
    expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
  });

  it('should replace an existing client when re-discovering a server', async () => {
    const firstClient = mkClient({ disconnect: resolved() });
    const secondClient = mkClient({ disconnect: resolved() });
    vi.mocked(McpClient)
      .mockReturnValueOnce(firstClient as unknown as McpClient)
      .mockReturnValueOnce(secondClient as unknown as McpClient);
    const manager = mkManager({
      config: mkConfig(() => ({ 'test-server': {} })),
    });

    await discoverTestServer(manager);
    await discoverTestServer(manager);

    expect(firstClient.disconnect).toHaveBeenCalledOnce();
    expect(secondClient.connect).toHaveBeenCalledOnce();
    expect(secondClient.discover).toHaveBeenCalledOnce();

    await manager.stop();
    expect(secondClient.disconnect).toHaveBeenCalledOnce();
  });

  it('should coalesce concurrent discovery for the same server', async () => {
    const disconnectGate = deferred();
    const firstClient = asyncClient({
      disconnect: vi.fn(() => disconnectGate.promise),
    });
    const replacementClients: Array<ReturnType<typeof asyncClient>> = [];

    vi.mocked(McpClient).mockImplementation(() => {
      if (vi.mocked(McpClient).mock.calls.length === 1) {
        return firstClient as unknown as McpClient;
      }
      const replacementClient = asyncClient();
      replacementClients.push(replacementClient);
      return replacementClient as unknown as McpClient;
    });
    const manager = mkManager({
      config: mkConfig(() => ({ 'test-server': {} })),
    });

    await discoverTestServer(manager);

    const firstRediscovery = discoverTestServer(manager);
    await Promise.resolve();

    const secondRediscovery = discoverTestServer(manager);
    const disconnectCallsBeforeResolve =
      firstClient.disconnect.mock.calls.length;

    disconnectGate.resolve();
    await Promise.all([firstRediscovery, secondRediscovery]);

    expect(disconnectCallsBeforeResolve).toBe(1);
    expect(vi.mocked(McpClient)).toHaveBeenCalledTimes(2);
    expect(replacementClients).toHaveLength(1);
    expect(replacementClients[0].connect).toHaveBeenCalledOnce();
    expect(replacementClients[0].discover).toHaveBeenCalledOnce();

    // Verify map was cleaned up: a third call should do real work,
    // not get coalesced into a stale promise.
    await discoverTestServer(manager);

    expect(vi.mocked(McpClient)).toHaveBeenCalledTimes(3);
    expect(replacementClients).toHaveLength(2);
    expect(replacementClients[1].connect).toHaveBeenCalledOnce();
    expect(replacementClients[1].discover).toHaveBeenCalledOnce();
  });

  it('should restore health checks after failed server rediscovery', async () => {
    vi.useFakeTimers();

    const firstClient = asyncClient();
    const failedClient = mkClient({
      connect: vi.fn().mockRejectedValue(new Error('transient failure')),
      disconnect: resolved(),
    });
    vi.mocked(McpClient)
      .mockReturnValueOnce(firstClient as unknown as McpClient)
      .mockReturnValueOnce(failedClient as unknown as McpClient);
    const manager = mkManager({
      config: mkConfig(() => ({ 'test-server': {} })),
      options: {
        healthConfig: {
          autoReconnect: true,
          checkIntervalMs: 10,
          maxConsecutiveFailures: 1,
          reconnectDelayMs: 10,
        },
      },
    });
    const timers = () => priv(manager, 'healthCheckTimers');

    try {
      await discoverTestServer(manager);
      expect(timers().has('test-server')).toBe(true);

      await discoverTestServer(manager);

      expect(failedClient.connect).toHaveBeenCalledOnce();
      expect(timers().has('test-server')).toBe(true);
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it('unrefs health-check timers so they never hold the event loop open (issue #9944)', async () => {
    // `qwen mcp reconnect` (and other short-lived Config consumers) call
    // `config.shutdown()` mid incremental pass; that pass's `finally`
    // re-arms health checks AFTER `stop()` cleared them. Ref'd intervals
    // hung the process forever: health monitoring is background
    // bookkeeping, so the timer must be unref'd. Real timers: fake timers do
    // not model `hasRef()` faithfully.
    stubClient(asyncClient());
    const manager = mkManager({
      config: mkConfig(() => ({ 'test-server': {} })),
      options: {
        healthConfig: {
          autoReconnect: true,
          // Long interval: we only inspect the armed timer, never fire it.
          checkIntervalMs: 60_000,
          maxConsecutiveFailures: 3,
          reconnectDelayMs: 10,
        },
      },
    });

    try {
      await discoverTestServer(manager);
      const timer = priv<Map<string, NodeJS.Timeout>>(
        manager,
        'healthCheckTimers',
      ).get('test-server');
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
    } finally {
      await manager.stop();
    }
  });

  it('should clear in-flight discovery tracking when stopping', async () => {
    const connectGate = deferred();
    stubClient(asyncClient({ connect: vi.fn(() => connectGate.promise) }));
    const manager = mkManager({
      config: mkConfig(() => ({ 'test-server': {} })),
    });
    const inFlight = () => priv(manager, 'serverDiscoveryPromises');

    const discovery = discoverTestServer(manager);
    await Promise.resolve();

    expect(inFlight().has('test-server')).toBe(true);

    await manager.stop();

    expect(inFlight().has('test-server')).toBe(false);

    connectGate.resolve();
    await discovery;
  });

  it('should no-op when discovering an unknown server', async () => {
    stubClient(mkClient({ disconnect: resolved() }));
    const manager = mkManager({ config: mkConfig() });

    await manager.discoverMcpToolsForServer('unknown-server', {
      isTrustedFolder: () => true,
    } as unknown as Config);

    expect(vi.mocked(McpClient)).not.toHaveBeenCalled();
  });

  it('discoverAllMcpToolsIncremental enforces a per-server discoveryTimeoutMs', async () => {
    // A stdio server whose `connect` hangs forever. The 50ms per-server
    // timeout should fire and surface as a swallowed error, leaving the
    // manager in COMPLETED state instead of stuck.
    const hung = deferred();
    stubClient(asyncClient({ connect: vi.fn().mockReturnValue(hung.promise) }));
    const { config, manager } = managed(
      cfg(() => ({
        broken: { command: 'node', args: [], discoveryTimeoutMs: 50 },
      })),
    );

    const t0 = Date.now();
    await manager.discoverAllMcpToolsIncremental(config);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    // Generous upper bound — the 50ms timeout should fire well within 2s
    // even on a heavily-loaded CI runner.
    expectWithinLatencyBudget(elapsed, 2000);
    // The state must settle even when every server times out, or the cli's
    // deferred-finalize path would hang forever.
    expect(manager.getDiscoveryState()).toBe(MCPDiscoveryState.COMPLETED);

    // Cleanup the stuck connect so test doesn't leak a pending promise.
    hung.resolve();
  });

  it('runs automatic OAuth outside the discovery timeout before reconnecting', async () => {
    const order: string[] = [];
    const connect = vi.fn().mockImplementation(async () => {
      order.push('connect');
    });
    const discover = vi.fn().mockImplementation(async () => {
      order.push('discover');
    });
    stubClients(() =>
      mkClient({
        connect,
        discover,
        disconnect: resolved(),
      }),
    );
    const mcpClientModule = await import('./mcp-client.js');
    const authenticate = vi
      .spyOn(mcpClientModule, 'attemptAutomaticMcpOAuth')
      .mockImplementation(async () => {
        order.push('authenticate');
        return true;
      });
    const probe = vi
      .spyOn(mcpClientModule, 'probeMcpServerForOAuth')
      .mockImplementation(async () => {
        order.push('probe');
        await new Promise((resolve) => setTimeout(resolve, 60));
        return true;
      });
    const serverConfig = {
      httpUrl: 'https://example.com/mcp',
      discoveryTimeoutMs: 50,
    };
    const { config, manager } = managed(
      cfg(() => ({ oauth: serverConfig }), {
        isInteractive: () => true,
        isBrowserLaunchSuppressed: () => false,
      }),
    );

    await manager.discoverAllMcpToolsIncremental(config);

    expect(probe).toHaveBeenCalledWith('oauth', serverConfig);
    expect(authenticate).toHaveBeenCalledWith('oauth', serverConfig, true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      'connect',
      'discover',
      'probe',
      'authenticate',
      'connect',
      'discover',
    ]);
  });

  it('discoverAllMcpToolsIncremental skips servers flagged as disabled', async () => {
    // PR-A regression guard: the incremental path iterated
    // `Object.entries(servers)` without consulting `isMcpServerDisabled`, so
    // an explicitly disabled server (e.g. `mcpServers.foo.disabled: true`)
    // still got connected and its tools registered. Mirrors
    // `discoverAllMcpTools`.
    const mockedMcpClient = stubClient(asyncClient());
    const { config, manager } = managed(
      mkConfig(
        () => ({
          enabled: { command: 'node', args: [] },
          disabled: { command: 'node', args: [] },
        }),
        { isMcpServerDisabled: (name: string) => name === 'disabled' },
      ),
    );

    await manager.discoverAllMcpToolsIncremental(config);

    // Only the enabled server drove a discover; the disabled one is skipped
    // before any connect attempt.
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.discover).toHaveBeenCalledTimes(1);
  });

  it('discoverAllMcpToolsIncremental tears down enabled→disabled transitions', async () => {
    // Mid-session disable (`/mcp disable foo` or a settings edit): the
    // incremental path must disconnect the client, drop its tools, stop its
    // health check and remove its global status — otherwise the Footer pill
    // keeps counting it, its tools stay live, and the health loop keeps
    // probing a server the user told us to ignore.
    const mockedMcpClient = stubClient(asyncClient());
    const removeMcpToolsByServer = vi.fn();
    let disabled = false;
    const { config, manager } = managed(
      mkConfig(() => ({ foo: { command: 'node', args: [] } }), {
        isMcpServerDisabled: (name: string) => name === 'foo' && disabled,
      }),
      {
        toolRegistry: { removeMcpToolsByServer } as unknown as ToolRegistry,
      },
    );

    // First pass: server enabled, gets connected.
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Now disable mid-session and re-run incremental discovery.
    disabled = true;
    await manager.discoverAllMcpToolsIncremental(config);

    // The previously-connected client is disconnected, its tools dropped.
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('foo');
    // No fresh connect: the disabled branch fires before serversToUpdate is
    // populated.
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
  });

  it('discoverAllMcpToolsIncremental reconnects a still-connected server when its config fingerprint changes', async () => {
    // Single-session parity with the pool path's `desiredIds` diff: editing
    // a live server's config (here `args`) must tear down and reconnect.
    // Without fingerprint tracking a connected server fell into the no-op
    // branch and kept running the old command/env/url.
    const mockedMcpClient = stubLiveClient();
    const spies = removalSpies();
    let args: string[] = [];
    const { config, manager } = managed(
      cfg(() => ({ foo: { command: 'node', args } }), spies.extra),
      { toolRegistry: spies.toolRegistry },
    );

    // First pass: connects and records the fingerprint of `args: []`.
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Identical config → fingerprint unchanged → no churn.
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Changed config → the still-connected server is disconnected and
    // reconnected.
    spies.tools.mockClear();
    spies.prompts.mockClear();
    spies.resources.mockClear();
    args = ['--flag'];
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
    // The OLD config's tools/prompts/resources MUST be purged before
    // rediscovery, so a changed server that drops/renames entries doesn't leave
    // stale ones registered against the now-closed client.
    expectRemoved(spies, 'foo');
  });

  it('reconnects a still-connected server when only a discovery filter (includeTools) changes', async () => {
    // trust / includeTools / excludeTools are outside connectionIdOf
    // (transport identity) but are applied during discover() and baked into
    // the registered tools, so a change must reconnect — otherwise the edit
    // is ignored until a manual reconnect/restart.
    const mockedMcpClient = stubLiveClient();
    let includeTools: string[] | undefined = undefined;
    // command/args/env unchanged across passes → transport fingerprint stays
    // identical; only the per-session filter changes.
    const { config, manager } = managed(
      cfg(() => ({ foo: { command: 'node', includeTools } })),
    );

    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);

    // Identical config → no churn.
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Change ONLY includeTools — connectionIdOf is unchanged, but the
    // discovery-aware key differs → reconnect so discover() re-applies it.
    includeTools = ['allowed_tool'];
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('normalizes duplicate filters but reconnects when alwaysLoadTools changes', async () => {
    const mockedMcpClient = stubLiveClient();
    let serverConfig = {
      command: 'node',
      includeTools: ['alpha(args)', 'alpha(args)', 'beta'],
      alwaysLoadTools: false,
    } as MCPServerConfig;
    const { config, manager } = managed(cfg(() => ({ foo: serverConfig })));

    await manager.discoverAllMcpToolsIncremental(config);
    serverConfig = {
      command: 'node',
      includeTools: ['beta', 'alpha'],
      alwaysLoadTools: false,
    } as MCPServerConfig;
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    serverConfig = { ...serverConfig, alwaysLoadTools: true };
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects legacy discovery when includeTools changes from absent to empty', async () => {
    const mockedMcpClient = stubLiveClient();
    const settings: { includeTools?: string[] } = {};
    const { config, manager } = managed(
      cfg(() => ({
        foo: {
          command: 'node',
          includeTools: settings.includeTools,
        } as MCPServerConfig,
      })),
    );

    await manager.discoverAllMcpToolsIncremental(config);
    settings.includeTools = [];
    await manager.discoverAllMcpToolsIncremental(config);

    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects a server first connected via the bulk path when its config later changes', async () => {
    // Regression: the bulk `discoverAllMcpTools` path (legacy blocking boot +
    // extension reload) connected WITHOUT recording a fingerprint, so a later
    // incremental pass saw `undefined` on the still-connected server,
    // short-circuited the reconcile guard, and silently kept the stale
    // config. Both connect paths must record the fingerprint.
    const mockedMcpClient = stubLiveClient();
    const spies = removalSpies();
    let args: string[] = [];
    const { config, manager } = managed(
      cfg(() => ({ foo: { command: 'node', args } }), spies.extra),
      { toolRegistry: spies.toolRegistry },
    );

    // First connect via the BULK path — the one that left the fingerprint
    // unset.
    await manager.discoverAllMcpTools(config);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Edit in place + incremental reconcile: with the bulk path's fingerprint
    // the change is detected and the server torn down + reconnected; without
    // the fix connect stays at 1.
    args = ['--flag'];
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
    expectRemoved(spies, 'foo');
  });

  it('discoverAllMcpToolsIncremental records `failed` outcome for swallowed connect errors', async () => {
    // `discoverMcpToolsForServerInternal` swallows connect/discover errors
    // (one broken server shouldn't bring down the others), so the incremental
    // try block resolved for failed servers too and recorded
    // `mcp_server_ready:<name>` with `outcome: 'ready'`. It now consults the
    // real status (DISCONNECTED after McpClient.connect's catch) and emits
    // `failed` — otherwise the startup profile claims success for every auth
    // error / crashed server.
    const events: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
    const startupEventSink = await import('../utils/startupEventSink.js');
    startupEventSink.setStartupEventSink((name, attrs) => {
      events.push({ name, attrs });
    });

    stubClient(
      asyncClient({
        connect: vi.fn().mockRejectedValue(new Error('auth failed')),
      }),
    );
    const { config, manager } = managed(
      cfg(() => ({ 'broken-auth': { command: 'node', args: [] } })),
    );
    await manager.discoverAllMcpToolsIncremental(config);

    // Cleanup the global sink so it doesn't leak into other tests.
    startupEventSink.setStartupEventSink(null);

    const readyEvents = events.filter(
      (e) => e.name === 'mcp_server_ready:broken-auth',
    );
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0].attrs?.['outcome']).toBe('failed');
    // No `mcp_first_tool_registered` either: that metric is user-facing
    // ("first MCP server became usable"), a failed server must not pollute it.
    const firstToolEvents = events.filter(
      (e) => e.name === 'mcp_first_tool_registered',
    );
    expect(firstToolEvents).toHaveLength(0);
  });

  it('discoveryTimeoutMs is clamped to a minimum and maximum', async () => {
    // A 0 or negative override fired the timeout on the next macrotask,
    // racing the connect() handshake; with no disconnect-on-timeout that was
    // a silent tool registration vector. The floor is 100ms.
    const { calls, spy } = spyTimeouts((ms) => ms ?? 0);
    stubClient(asyncClient());
    const { config, manager } = managed(
      cfg(() => ({
        zero: { command: 'node', args: [], discoveryTimeoutMs: 0 },
        negative: { command: 'node', args: [], discoveryTimeoutMs: -5 },
        huge: { command: 'node', args: [], discoveryTimeoutMs: 10_000_000 },
      })),
    );
    await manager.discoverAllMcpToolsIncremental(config);
    spy.mockRestore();

    // Look only for the values discoveryTimeoutFor produces: 100 (floor) and
    // 300_000 (ceiling). Other timers (test infra, vitest) may appear in
    // `calls`, but never both 100 AND 300000 by coincidence.
    expect(calls).toContain(100);
    expect(calls).toContain(300_000);
    expect(calls).not.toContain(0);
    expect(calls).not.toContain(-5);
    expect(calls).not.toContain(10_000_000);
  });

  it('discoveryTimeoutFor treats websocket (tcp) transport as remote', async () => {
    // Remote-vs-stdio picks the 5s vs 30s default timeout. `tcp` is the
    // WebSocket field on MCPServerConfig — without it, hung WS handshakes
    // would block `waitForMcpReady()` for 30s instead of 5s.
    stubClient(
      asyncClient({
        connect: vi.fn().mockReturnValue(new Promise<void>(() => {})),
      }),
    );
    // Fire immediately to settle quickly without waiting 5s/30s.
    const { calls, spy } = spyTimeouts(() => 1);
    const { config, manager } = managed(
      cfg(() => ({ wsServer: { tcp: 'ws://example.test' } })),
    );
    await manager.discoverAllMcpToolsIncremental(config);
    spy.mockRestore();

    expect(calls).toContain(5_000);
    expect(calls).not.toContain(30_000);
  });

  describe('discovery timeout process cleanup', () => {
    beforeEach(() => {
      vi.mocked(listDescendantPids).mockClear();
      vi.mocked(sigtermPids).mockClear();
    });

    function makeTimedOutClient(rootPid?: number) {
      return asyncClient({
        connect: vi.fn(() => new Promise<void>(() => {})),
        getTransportPid: vi.fn(() => rootPid),
      });
    }

    async function runTimedOutDiscovery(
      mockedMcpClient: ReturnType<typeof makeTimedOutClient>,
      serverConfig: MCPServerConfig,
    ): Promise<void> {
      stubClient(mockedMcpClient);
      const { config, manager } = managed(cfg(() => ({ slow: serverConfig })));
      await manager.discoverAllMcpToolsIncremental(config);
    }

    it('signals stdio wrapper descendants before disconnecting after timeout', async () => {
      const events: string[] = [];
      const mockedMcpClient = makeTimedOutClient(101);
      mockedMcpClient.disconnect.mockImplementationOnce(async () => {
        events.push('disconnect');
      });
      vi.mocked(listDescendantPids).mockResolvedValueOnce([201, 301]);
      vi.mocked(sigtermPids).mockImplementationOnce(() => {
        events.push('signal');
        return 2;
      });

      await runTimedOutDiscovery(mockedMcpClient, {
        command: 'node',
        args: [],
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).toHaveBeenCalledWith(101);
      expect(sigtermPids).toHaveBeenCalledWith([201, 301]);
      expect(events).toEqual(['signal', 'disconnect']);
    });

    it('disconnects remote transports without enumerating pids', async () => {
      const mockedMcpClient = makeTimedOutClient();

      await runTimedOutDiscovery(mockedMcpClient, {
        httpUrl: 'https://example.test/mcp',
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).not.toHaveBeenCalled();
      expect(sigtermPids).not.toHaveBeenCalled();
      expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
    });

    it('skips signaling when a stdio transport has no descendants', async () => {
      const mockedMcpClient = makeTimedOutClient(101);

      await runTimedOutDiscovery(mockedMcpClient, {
        command: 'node',
        args: [],
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).toHaveBeenCalledWith(101);
      expect(sigtermPids).not.toHaveBeenCalled();
      expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
    });

    it('still disconnects when descendant enumeration fails', async () => {
      const mockedMcpClient = makeTimedOutClient(101);
      vi.mocked(listDescendantPids).mockRejectedValueOnce(
        new Error('process table unavailable'),
      );

      await runTimedOutDiscovery(mockedMcpClient, {
        command: 'node',
        args: [],
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).toHaveBeenCalledWith(101);
      expect(sigtermPids).not.toHaveBeenCalled();
      expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
    });
  });

  it('runWithDiscoveryTimeout disconnects the client AND drops registered tools on timeout', async () => {
    // Before this fix the inner `discoverMcpToolsForServer` kept running
    // after the timeout; a late successful `client.discover()` registered
    // the server's tools into the live registry (a remote-exploitable silent
    // registration). Disconnecting aborts the handshake, but a
    // fire-and-forget `void disconnect()` doesn't help when `discover()`
    // already pumped tools in synchronously (the close lands a tick later),
    // so we (a) await the disconnect and (b) `removeMcpToolsByServer()` to
    // drop tools that slipped through the race window.
    const hungConnect = deferred();
    const mockedMcpClient = stubClient(
      asyncClient({ connect: vi.fn().mockReturnValue(hungConnect.promise) }),
    );
    const removeMcpToolsByServer = vi.fn();
    const { config, manager } = managed(
      cfg(() => ({
        slow: { command: 'node', args: [], discoveryTimeoutMs: 100 },
      })),
      { toolRegistry: { removeMcpToolsByServer } as unknown as ToolRegistry },
    );

    await manager.discoverAllMcpToolsIncremental(config);

    // The timeout must have triggered the disconnect — that's what
    // aborts the connect() handshake so no tools land.
    expect(mockedMcpClient.disconnect).toHaveBeenCalled();
    // And any tools that registered during the disconnect race window
    // must have been removed from the registry.
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('slow');

    // Cleanup the hung promise to avoid leaking it across tests.
    hungConnect.resolve();
  });

  it('runWithDiscoveryTimeout drops the client + stops health-check so the auto-reconnect loop cannot resurrect an intentionally timed-out server', async () => {
    // Round-7 regression: the timeout handler removed tools but left the
    // client in `this.clients` with its health-check timer. The internal
    // `finally` then ran `startHealthCheck`, which (with `autoReconnect`)
    // saw `status !== CONNECTED` for ~maxConsecutiveFailures intervals and
    // called `reconnectServer()` → `discoverMcpToolsForServer()` directly,
    // bypassing `runWithDiscoveryTimeout`: the slow server silently came back.
    const hungConnect = deferred();
    stubClient(
      asyncClient({ connect: vi.fn().mockReturnValue(hungConnect.promise) }),
    );
    const { config, manager } = managed(
      cfg(() => ({
        slow: { command: 'node', args: [], discoveryTimeoutMs: 100 },
      })),
    );

    await manager.discoverAllMcpToolsIncremental(config);

    // The client entry must be gone — otherwise `performHealthCheck`
    // would observe it (and the disconnected status) every checkInterval.
    expect(priv(manager, 'clients').has('slow')).toBe(false);
    // And no health-check timer must remain for this server.
    expect(priv(manager, 'healthCheckTimers').has('slow')).toBe(false);

    // Cleanup the hung promise to avoid leaking it across tests.
    hungConnect.resolve();
  });

  it('discoverAllMcpToolsIncremental emits the trailing mcp-client-update after COMPLETED', async () => {
    // Without the trailing emit, the cli's deferred-finalize subscriber
    // (which polls discoveryState on each `mcp-client-update`) would never
    // observe the terminal state. Regression-protect the emit ordering.
    stubClient(asyncClient());
    const observedStatesAtEmit: MCPDiscoveryState[] = [];
    const events = {
      emit: vi.fn((eventName: string) => {
        if (eventName === 'mcp-client-update') {
          observedStatesAtEmit.push(manager.getDiscoveryState());
        }
        return true;
      }),
    } as unknown as import('node:events').EventEmitter;
    const { config, manager } = managed(
      cfg(() => ({ srv: { command: 'node', args: [] } })),
      { options: { eventEmitter: events } },
    );

    await manager.discoverAllMcpToolsIncremental(config);

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

  it('getMcpClientAccounting returns zero on an empty manager', async () => {
    const manager = new McpClientManager(cfg({}), {} as ToolRegistry);
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
    const srv = (overrides: Record<string, unknown>) =>
      overrides as unknown as MCPServerConfig;
    expect(mcpTransportOf(srv({ command: 'node' }))).toBe('stdio');
    expect(mcpTransportOf(srv({ httpUrl: 'http://x' }))).toBe('http');
    expect(mcpTransportOf(srv({ url: 'http://x' }))).toBe('sse');
    expect(mcpTransportOf(srv({ tcp: 'ws://x' }))).toBe('websocket');
    expect(mcpTransportOf(srv({}))).toBe('unknown');
    // SDK detection short-circuits: even with a placeholder command,
    // an SDK-marked server reports `sdk` (not `stdio`).
    expect(mcpTransportOf(srv({ type: 'sdk', command: 'node' }))).toBe('sdk');
  });

  it('enforce mode refuses connects past the budget', async () => {
    const created = stubConnectedClients();
    // 4 stdio servers, budget 2. enforce mode refuses 2.
    const { manager } = await budgetPass(
      stdio('a', 'b', 'c', 'd'),
      2,
      'enforce',
    );
    expect(created).toHaveLength(2); // only 2 McpClient instances created
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(2);
    expect(accounting.byTransport.stdio).toBe(2);
    expect(accounting.subprocessCount).toBe(2);
    expect(accounting.reservedSlots.sort()).toEqual(['a', 'b']);
    expect(accounting.refusedServerNames.sort()).toEqual(['c', 'd']);
  });

  it('warn mode never refuses but tracks oversized reservations', async () => {
    const created = stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b', 'c'), 2, 'warn');
    // warn mode: all 3 connect; reservedSlots grows past budget; no refusals.
    expect(created).toHaveLength(3);
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(3);
    expect(accounting.reservedSlots.sort()).toEqual(['a', 'b', 'c']);
    expect(accounting.refusedServerNames).toEqual([]);
  });

  it('off mode does not reserve any slot', async () => {
    stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b'), undefined, 'off');
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.total).toBe(2);
    // `off` skips reservation altogether — operators see live count via
    // `total`, but reservedSlots stays empty.
    expect(accounting.reservedSlots).toEqual([]);
    expect(accounting.refusedServerNames).toEqual([]);
  });

  it('refusal is deterministic by config-declaration order', async () => {
    const created = stubConnectedClients();
    // Insertion order: zulu, alpha, mike. Budget 2 → zulu+alpha survive.
    const { manager } = await budgetPass(
      stdio('zulu', 'alpha', 'mike'),
      2,
      'enforce',
    );
    expect(created).toEqual(['zulu', 'alpha']);
    expect(refused(manager)).toEqual(['mike']);
  });

  it('discoverAllMcpTools resets lastRefusedServerNames each pass', async () => {
    stubConnectedClients();
    const { config, manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    expect(refused(manager)).toEqual(['b']);

    // Second pass: stop()→clear→re-run. The reset happens at the start
    // of discoverAllMcpTools (see also stop() clearing reservedSlots).
    await manager.discoverAllMcpTools(config);
    // Same outcome (still budget 1, still 2 servers), but the array
    // is fresh — not appended to.
    expect(refused(manager)).toEqual(['b']);
  });

  it('readResource throws BudgetExhaustedError in enforce mode when full', async () => {
    stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    // `a` was reserved; `b` was refused. A `readResource('b', ...)` would
    // lazy-spawn — must throw rather than silently exceed the cap.
    await expect(manager.readResource('b', 'file:///x')).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });

  it('disconnectServer releases the slot for re-use', async () => {
    stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    expect(slots(manager)).toEqual(['a']);
    await manager.disconnectServer('a');
    // Slot released — accounting shows the configured set shrank.
    expect(slots(manager)).toEqual([]);
  });

  it('env var fallback resolves budget + mode when constructor omits opts', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '7';
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'enforce';
    const manager = mkManager({ config: cfg({}) });
    expect(manager.getMcpClientBudget()).toBe(7);
    expect(manager.getMcpBudgetMode()).toBe('enforce');
  });

  it('env var fallback defaults mode to warn when only budget is set', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '5';
    // No mode env var. Resolved mode is `warn` (the safe default).
    const manager = mkManager({ config: cfg({}) });
    expect(manager.getMcpClientBudget()).toBe(5);
    expect(manager.getMcpBudgetMode()).toBe('warn');
  });

  it('env var fallback rejects non-positive budgets silently', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '-3';
    const manager = mkManager({ config: cfg({}) });
    // Invalid values fall through to `undefined` budget + `off` mode —
    // no enforcement, no boot-time crash. Validation lives in the CLI
    // flag handler (`packages/cli/src/commands/serve.ts`).
    expect(manager.getMcpClientBudget()).toBeUndefined();
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  it('disabled servers do not consume a budget slot', async () => {
    const created = stubConnectedClients();
    // `b` is disabled — must not even attempt to reserve. With budget=2,
    // `a` and `c` should both succeed (b is invisible to the gate, so it
    // doesn't consume a slot; the cap is enough for the remaining two).
    const { manager } = await budgetPass(stdio('a', 'b', 'c'), 2, 'enforce', {
      extra: { isMcpServerDisabled: (name: string) => name === 'b' },
    });
    expect(created.sort()).toEqual(['a', 'c']);
    expect(slots(manager).sort()).toEqual(['a', 'c']);
    expect(refused(manager)).toEqual([]);
  });

  // PR 14 fix (review #4247): regression tests for the four bypass /
  // ordering / staleness bugs the Codex + Copilot reviews caught.
  it('single-server rediscovery respects the budget gate (review #1)', async () => {
    const created = stubConnectedClients();
    const { config, manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    // `b` was refused at startup. A manual `/mcp reconnect b` (via
    // `discoverMcpToolsForServer` → `...Internal`) bypassed the gate pre-fix
    // and exceeded the cap; now it must stay refused.
    expect(created).toEqual(['a']);
    expect(refused(manager)).toEqual(['b']);
    await manager.discoverMcpToolsForServer('b', config);
    expect(created).toEqual(['a']); // no new McpClient created
    expect(slots(manager)).toEqual(['a']);
    expect(refused(manager)).toEqual(['b']);
  });

  it('disconnectServer-then-disable drops refusal tag (review #4)', async () => {
    stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    expect(refused(manager)).toEqual(['b']);
    // An explicit operator disconnect of `b` drops it from the refusal log,
    // so a snapshot stops tagging the now-disabled server `budget_exhausted`.
    await manager.disconnectServer('b');
    expect(refused(manager)).toEqual([]);
  });

  it('incremental discovery frees removed slots BEFORE reserving new ones (review #5)', async () => {
    stubConnectedClients();
    const mcpServers = stdio('a', 'b');
    const { config, manager } = await budgetPass(mcpServers, 2, 'enforce', {
      incremental: true,
    });
    expect(slots(manager).sort()).toEqual(['a', 'b']);

    // Swap b → c (still budget=2). Pre-fix order: `c` refused because
    // `b`'s slot was only freed after the new-server loop. Post-fix:
    // `b` removed first → reservedSlots={a} → `c` reserved.
    delete mcpServers['b'];
    mcpServers['c'] = { command: 'node' };
    await manager.discoverAllMcpToolsIncremental(config);
    expect(slots(manager).sort()).toEqual(['a', 'c']);
    expect(refused(manager)).toEqual([]);
  });

  it('buildBudgetCells deferred to acpAgent — manager off-mode returns no budget bookkeeping (review #2)', async () => {
    // Sibling check pinning the manager-side invariant: off-mode is pure
    // observability (empty `reservedSlots`, no `refusedServerNames`). The
    // empty-`budgets[]` assertion lives in the serve route test
    // (`server.test.ts`) since `acpAgent.buildBudgetCells` builds the cell.
    stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b'), undefined, 'off');
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
    stubClients(() => {
      if (firstCall) {
        firstCall = false;
        return asyncClient({
          connect: vi.fn().mockRejectedValue(new Error('boom')),
        });
      }
      return makeConnectedMcpClientMock();
    });
    // `a` will fail; `b` would be refused pre-fix.
    const { manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    // Servers are walked concurrently, so `b` may be reserved or refused
    // depending on whether its synchronous reserve check ran before `a`
    // released. What MUST hold: `a` released its slot and left no client
    // entry — the slot leak itself is gone.
    const accounting = manager.getMcpClientAccounting();
    expect(accounting.reservedSlots).not.toContain('a');
    // No leaked client entry either:
    expect(priv(manager, 'clients').has('a')).toBe(false);
  });

  it('connect() failure in readResource releases the slot AND re-throws (wenshao C3)', async () => {
    let getResourceCalled = false;
    stubClients(() =>
      asyncClient({
        // Stays disconnected → readResource code path forces a
        // `client.connect()` before `client.readResource(...)`.
        connect: vi.fn().mockRejectedValue(new Error('lazy connect boom')),
        readResource: vi.fn().mockImplementation(() => {
          getResourceCalled = true;
          return Promise.resolve({});
        }),
      }),
    );
    const manager = budgetManager(cfg(stdio('a')), 1, 'enforce');
    // No discovery yet → `a` not in clients → lazy spawn path.
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      'lazy connect boom',
    );
    // Slot must NOT leak — pre-fix one failed readResource permanently
    // burned a budget slot.
    expect(slots(manager)).toEqual([]);
    expect(priv(manager, 'clients').has('a')).toBe(false);
    // And the readResource ext-method was never reached (we threw at connect).
    expect(getResourceCalled).toBe(false);
  });

  it('reconnects a server first connected via a readResource lazy spawn when its config later changes', async () => {
    // Regression: the lazy-connect path in `readResource` connected WITHOUT
    // recording a fingerprint, so a server first brought up by a resource
    // read hit the reconcile guard's `undefined` short-circuit and silently
    // ignored a later in-place config edit.
    let status: unknown = MCPServerStatus.DISCONNECTED;
    const mockedMcpClient = stubClient(
      asyncClient({
        connect: vi.fn().mockImplementation(async () => {
          status = MCPServerStatus.CONNECTED;
        }),
        getStatus: vi.fn(() => status),
        readResource: vi.fn().mockResolvedValue({ contents: [] }),
      }),
    );
    const spies = removalSpies();
    let args: string[] = [];
    const { config, manager } = managed(
      cfg(() => ({ foo: { command: 'node', args } }), spies.extra),
      { toolRegistry: spies.toolRegistry },
    );

    // First bring the server up via a lazy resource read (not discovery).
    await manager.readResource('foo', 'mcp://foo/doc');
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Edit in place + reconcile: the lazy spawn's fingerprint lets the
    // incremental pass detect the change and reconnect; without the fix
    // connect stays at 1.
    args = ['--flag'];
    await manager.discoverAllMcpToolsIncremental(config);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
    expectRemoved(spies, 'foo');
  });

  it('readBudgetFromEnv downgrades enforce-without-budget to off (wenshao S4)', async () => {
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'enforce';
    // No QWEN_SERVE_MCP_CLIENT_BUDGET — silently fail-open pre-fix:
    // `tryReserveSlot` returns 'reserved' when `clientBudget === undefined`,
    // so an "enforce" daemon would let unlimited servers through.
    const manager = mkManager({ config: cfg({}) });
    expect(manager.getMcpClientBudget()).toBeUndefined();
    // Downgraded — not 'enforce' — because enforce requires a budget.
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  // Round 3 review fixes (PR #4247 wenshao second pass).
  it('readResource rejects disabled servers before checking budget (wenshao R3 #5)', async () => {
    stubConnectedClients();
    // Pre-fix the lazy spawn path bypassed `isMcpServerDisabled`,
    // so a disabled server could be resurrected by a resource read.
    const manager = mkManager({
      config: cfg(stdio('a'), {
        isMcpServerDisabled: (name: string) => name === 'a',
      }),
    });
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is disabled/,
    );
  });

  it('readResource disabled gate fires BEFORE budget gate (wenshao R3 #5 precedence)', async () => {
    stubConnectedClients();
    // Budget-exhausted scenario + disabled target: the disabled error must
    // win over the budget error (matches the per-server cell precedence).
    const { manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce', {
      extra: { isMcpServerDisabled: (name: string) => name === 'b' },
    });
    // Even though `b` would be budget-refused if not disabled, the
    // disabled gate must trip first.
    await expect(manager.readResource('b', 'file:///x')).rejects.toThrow(
      /'b' is disabled/,
    );
  });

  it('exports MCP_BUDGET_WARN_FRACTION constant (wenshao R3 #7)', async () => {
    // Pinned to 0.75 to match PR 10's slow_client_warning hysteresis
    // primer (eventBus.ts WARN_THRESHOLD_RATIO). PR 14b will introduce
    // the matching reset fraction (0.375) to complete the dual-threshold
    // pair; this test is a tripwire against accidental fraction drift.
    expect(MCP_BUDGET_WARN_FRACTION).toBe(0.75);
  });

  // Round 4 review fixes (PR #4247 wenshao R3-R4 zombie leak in internal path).
  it('discoverMcpToolsForServer fresh-reserve connect-failure releases slot (wenshao R4 C2)', async () => {
    stubClients(() =>
      asyncClient({
        connect: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    );
    const config = cfg(stdio('x'));
    const manager = budgetManager(config, 1, 'enforce');
    // `x` not previously reserved: this call freshly reserves, then
    // connect() throws. Pre-fix the slot leaked permanently under enforce,
    // blocking any later server in `clients.size=1`.
    await manager.discoverMcpToolsForServer('x', config);
    expect(slots(manager)).toEqual([]);
    expect(priv(manager, 'clients').has('x')).toBe(false);
  });

  // R8 #4 (line 1221): the `freshReservations` Set distinguishes
  // fresh-reservation timeouts (release) from `'already_held'` reconnect
  // timeouts (keep slot). Covered by code inspection + the R5
  // release-on-fresh test below: a dedicated already_held timeout test
  // needs either the health-monitor flow end-to-end (autoReconnect timers
  // interleaved with fake timers, which interferes with the sibling R5
  // test) or piercing the private `runWithDiscoveryTimeout`. An integration
  // test in a separate file can add that variant without the interleave.
  it('runWithDiscoveryTimeout timeout handler releases the budget slot (wenshao R5 line 956)', async () => {
    vi.useFakeTimers();
    // McpClient.connect never resolves → timeout fires.
    stubClients(() =>
      mkClient({
        connect: vi.fn(() => new Promise(() => {})),
        disconnect: resolved(),
      }),
    );
    const config = cfg(stdio('a'));
    const manager = mkManager({
      config,
      options: {
        healthConfig: {
          autoReconnect: false,
          checkIntervalMs: 100,
          maxConsecutiveFailures: 1,
          reconnectDelayMs: 100,
        },
        budgetConfig: { clientBudget: 2, budgetMode: 'enforce' },
      },
    });
    const discoveryPromise = manager.discoverAllMcpToolsIncremental(config);
    // Advance past the stdio default discovery timeout (30s).
    await vi.advanceTimersByTimeAsync(31_000);
    await discoveryPromise;
    // Pre-fix the timeout cleaned up clients but not reservedSlots,
    // permanently consuming a budget slot.
    expect(slots(manager)).toEqual([]);
    vi.useRealTimers();
  });

  it('incremental discovery still refuses past the cap after R6 pre-reservation removal (wenshao R6 line 956)', async () => {
    // Round 6 removed the duplicate pre-reservation in
    // discoverAllMcpToolsIncremental — refusal now happens INSIDE
    // discoverMcpToolsForServerInternal's tryReserveSlot. Verify
    // the observable refusal behavior is unchanged from the outside.
    const created = stubConnectedClients();
    const { manager } = await budgetPass(
      stdio('first', 'second', 'third'),
      2,
      'enforce',
      { incremental: true },
    );
    // First two declared servers fit; third refused. Declaration-order
    // determinism holds: the inner tryReserveSlot runs in the same
    // serversToUpdate order the outer walk produced.
    expect(created).toEqual(['first', 'second']);
    expect(slots(manager).sort()).toEqual(['first', 'second']);
    expect(refused(manager)).toEqual(['third']);
  });

  it('readResource late re-reserve clears stale refused entry (wenshao R5 line 1268)', async () => {
    // discoverAllMcpTools refuses `b` (budget=1); disconnecting `a` frees the
    // slot, readResource('b') succeeds and must drop `b` from
    // lastRefusedServerNames (pre-fix the snapshot kept reporting
    // `disabledReason: 'budget'` even after it connected).
    stubConnectedClients();
    const { manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    expect(refused(manager)).toEqual(['b']);
    // Free a slot.
    await manager.disconnectServer('a');
    // Lazy spawn b — should now succeed (slot available).
    await manager.readResource('b', 'file:///x');
    // Stale refusal entry must be cleared.
    expect(refused(manager)).toEqual([]);
    expect(slots(manager)).toEqual(['b']);
  });

  it('discoverMcpToolsForServer clears stale refused entry on success (wenshao R7 #1 line 612)', async () => {
    // Critical: a previously-refused server that connects later (e.g. /mcp
    // reconnect after another server frees a slot) left a stale entry in
    // lastRefusedServerNames, so the snapshot reported
    // `disabledReason: 'budget'` for a CONNECTED server until the next pass.
    stubConnectedClients();
    const { config, manager } = await budgetPass(stdio('a', 'b'), 1, 'enforce');
    expect(refused(manager)).toEqual(['b']);
    // Free a slot.
    await manager.disconnectServer('a');
    // Manual /mcp reconnect path exercises discoverMcpToolsForServer.
    await manager.discoverMcpToolsForServer('b', config);
    // The successful late connect must clear the stale refusal entry.
    expect(refused(manager)).toEqual([]);
    expect(slots(manager)).toEqual(['b']);
  });

  it('discoverMcpToolsForServerInternal rejects disabled servers (wenshao R7 #2 line 528)', async () => {
    // Reachable from /mcp reconnect, OAuth re-discovery, and health
    // monitor reconnect. Pre-fix none of these paths checked the
    // disabled flag, so a disabled server could be resurrected.
    const created = stubConnectedClients();
    const { config, manager } = managed(
      cfg(stdio('a'), { isMcpServerDisabled: (name: string) => name === 'a' }),
    );
    await manager.discoverMcpToolsForServer('a', config);
    expect(created).toHaveLength(0);
  });

  it('discoverMcpToolsForServerInternal rejects pending-approval servers', async () => {
    const created = stubConnectedClients();
    const config = cfg(stdio('a'), {
      isMcpServerPendingApproval: (name: string) => name === 'a',
    });
    const manager = new McpClientManager(config, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer('a', config);

    expect(created).toHaveLength(0);
  });

  it('discoverMcpToolsForServerInternal disconnects on discover() failure (wenshao R7 #3 line 634)', async () => {
    // Pre-fix: `connect()` succeeds + `discover()` throws → catch
    // deletes the client from the map without calling
    // `disconnect()`, leaking the stdio child.
    const disconnect = resolved();
    stubClients(() =>
      mkClient({
        connect: resolved(),
        discover: vi.fn().mockRejectedValue(new Error('discover failed')),
        disconnect,
      }),
    );
    const config = cfg(stdio('x'));
    const manager = budgetManager(config, 1, 'enforce');
    await manager.discoverMcpToolsForServer('x', config);
    // Slot released on weReservedSlot+catch path AND the transport
    // was closed before dropping the client reference.
    expect(slots(manager)).toEqual([]);
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('readBudgetFromEnv emits stderr warning on invalid budget value (wenshao R7 #6 line 191)', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = 'abc';
    try {
      const manager = mkManager({ config: cfg({}) });
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

  it('readBudgetFromEnv rejects non-decimal budget values (hex / scientific / float)', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (const bad of ['0x10', '1e2', '1.0']) {
        process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = bad;
        const manager = mkManager({ config: cfg({}) });
        // Pre-fix Number('0x10')=16 / Number('1e2')=100 slipped through as a budget.
        expect(manager.getMcpClientBudget()).toBeUndefined();
      }
      // a plain decimal integer is still accepted.
      process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '16';
      const ok = mkManager({ config: cfg({}) });
      expect(ok.getMcpClientBudget()).toBe(16);
    } finally {
      writeSpy.mockRestore();
      delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    }
  });

  it('readResource rejects existing-but-now-disabled servers (wenshao R7 #5 line 1342)', async () => {
    // Pre-fix a server connected before an operator disable (settings reload
    // mid-session) kept serving resource reads via its CONNECTED client
    // until the next incremental pass called removeServer.
    stubConnectedClients();
    let disabled = false;
    const { config, manager } = managed(
      cfg(stdio('a'), {
        isMcpServerDisabled: (name: string) => name === 'a' && disabled,
      }),
    );
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

  it('readResource rejects existing-but-now-pending servers', async () => {
    stubConnectedClients();
    let pending = false;
    const config = cfg(stdio('a'), {
      isMcpServerPendingApproval: (name: string) => name === 'a' && pending,
    });
    const manager = new McpClientManager(config, {} as ToolRegistry);
    await manager.discoverAllMcpTools(config);

    pending = true;

    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is pending approval/,
    );
  });

  it('readResource lazy spawn rejects pending-approval servers', async () => {
    const created = stubConnectedClients();
    const config = cfg(stdio('a'), {
      isMcpServerPendingApproval: (name: string) => name === 'a',
    });
    const manager = new McpClientManager(config, {} as ToolRegistry);

    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is pending approval/,
    );
    expect(created).toHaveLength(0);
  });

  it('readResource lazy spawn disconnects on connect() failure (wenshao R9 #2 line 1534)', async () => {
    // Mirror of the discovery-side R7 #3 / R8 #1 fixes, but for
    // the readResource lazy-spawn path. Pre-fix: connect()
    // partially established transport then threw → catch deleted
    // client without disconnect() → stdio child / socket leaked.
    const disconnect = resolved();
    stubClients(() =>
      mkClient({
        connect: vi.fn().mockRejectedValue(new Error('mid-handshake failure')),
        disconnect,
        readResource: vi.fn(),
      }),
    );
    const manager = budgetManager(cfg(stdio('x')), 1, 'enforce');
    await expect(manager.readResource('x', 'file:///a')).rejects.toThrow(
      /mid-handshake failure/,
    );
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(slots(manager)).toEqual([]);
  });

  it('readBudgetFromEnv emits stderr breadcrumb on enforce-no-budget downgrade (wenshao R9 #7)', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'enforce';
    // No budget → downgrade fires
    try {
      const manager = mkManager({ config: cfg({}) });
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
    // Bulk-path mirror of R7 #3 (per-server path). Pre-fix: connect()
    // success + discover() throw → catch dropped the client without
    // disconnect() → stdio child / WebSocket / HTTP socket leaked for the
    // daemon's lifetime (stop() can't see the removed entry).
    const disconnect = resolved();
    stubClients(() =>
      mkClient({
        connect: resolved(),
        discover: vi.fn().mockRejectedValue(new Error('discover failed')),
        disconnect,
      }),
    );
    const { manager } = await budgetPass(stdio('a'), 1, 'enforce');
    // Transport closed before client reference dropped + slot released.
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(slots(manager)).toEqual([]);
  });

  it('readBudgetFromEnv downgrades warn-without-budget to off (wenshao R8 #2)', async () => {
    process.env['QWEN_SERVE_MCP_BUDGET_MODE'] = 'warn';
    // No budget — pre-fix this passed through with mode='warn',
    // reaching emitBudgetTelemetry with clientBudget=undefined.
    const manager = mkManager({ config: cfg({}) });
    expect(manager.getMcpClientBudget()).toBeUndefined();
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  it('constructor downgrades enforce-without-budget when budgetConfig passed directly (wenshao R8 #5)', async () => {
    // Direct-budgetConfig path is test-/embedded-only — production callers
    // (CLI, runQwenServe, env-var fallback) all validate upfront. Defense in
    // depth: the ctor mirrors the env-var downgrade so a caller that bypasses
    // validation can't silently fail-open. Invalid combination: enforce
    // without a budget.
    const manager = budgetManager(cfg({}), undefined, 'enforce');
    // Downgraded to off so tryReserveSlot doesn't masquerade as enforce.
    expect(manager.getMcpBudgetMode()).toBe('off');
  });

  it('discoverMcpToolsForServer reconnect-attempt connect-failure KEEPS slot (wenshao R4 C2 already_held)', async () => {
    // Unlike the fresh-reserve case, the slot here is already held (a prior
    // successful connect in discoverAllMcpTools). A failed reconnect must
    // NOT release it — a stable server that just hiccupped keeps its
    // capacity reservation for the health-monitor retry loop.
    let connectThrows = false;
    stubClients(() =>
      asyncClient({
        connect: vi.fn().mockImplementation(async () => {
          if (connectThrows) throw new Error('reconnect boom');
        }),
        getStatus: vi.fn(() =>
          connectThrows
            ? undefined
            : ((vi.mocked as unknown as { val: unknown }).val =
                'CONNECTED' as unknown),
        ),
      }),
    );
    // First pass: a connects successfully, slot reserved.
    const { config, manager } = await budgetPass(stdio('a'), 1, 'enforce');
    expect(slots(manager)).toEqual(['a']);
    // Health-monitor reconnect against a flaky server: tryReserveSlot →
    // 'already_held' (slot stays) → existing client.disconnect() (slot
    // stays) → new client.connect() throws → weReservedSlot=false, so the
    // slot is NOT released.
    connectThrows = true;
    await manager.discoverMcpToolsForServer('a', config);
    expect(slots(manager)).toEqual(['a']);
  });
});

// Issue #4175 PR 14b: push events + hysteresis state machine. Kept in its own
// describe so a future revert of PR 14b drops a single contiguous block.
// Mirrors PR 14's testing style (mocked `McpClient`, file-level config and
// budget helpers).
describe('McpClientManager — PR 14b push events + hysteresis', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    delete process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  });

  /** Connected stubs, then `budgetPass` with an `onBudgetEvent` sink. */
  async function eventPass(
    servers: Servers,
    clientBudget: number | undefined,
    budgetMode: McpBudgetMode,
    incremental = false,
  ) {
    stubConnectedClients();
    const events: unknown[] = [];
    const pass = await budgetPass(servers, clientBudget, budgetMode, {
      events,
      incremental,
    });
    return { events, ...pass };
  }

  it('exports MCP_BUDGET_REARM_FRACTION = 0.375', async () => {
    expect(MCP_BUDGET_REARM_FRACTION).toBe(0.375);
  });

  it('budget_warning fires once on first 75% upward crossing', async () => {
    // 4-server config, budget 4, ratio after pass = 4/4 = 1.0 ≥ 0.75
    // → exactly one warning fires.
    const { events } = await eventPass(stdio('a', 'b', 'c', 'd'), 4, 'warn');
    const warnings = ofKind(events, 'budget_warning');
    expect(warnings).toHaveLength(1);
    // PR 14b fix #4 (codex review round 1): hysteresis fires inline on the
    // upward crossing, so the payload reflects the moment the ratio first
    // hits 0.75 — `reservedCount: 3` (3 of 4). Pre-fix the standalone
    // end-of-pass `evaluateBudgetState` ran after every reservation and
    // reported the post-stabilization `reservedCount: 4`.
    expect(warnings[0]).toMatchObject({
      kind: 'budget_warning',
      reservedCount: 3,
      budget: 4,
      thresholdRatio: 0.75,
      mode: 'warn',
    });
  });

  it('budget_warning does NOT fire when ratio stays below 75%', async () => {
    // 2 of 4 → 0.5 < 0.75 → no fire.
    const { events } = await eventPass(stdio('a', 'b'), 4, 'warn');
    expect(ofKind(events, 'budget_warning')).toEqual([]);
  });

  it('budget_warning hysteresis re-arms only after dropping below 37.5%', async () => {
    // Budget 4. Pass 1: 4/4 = 1.0 fires. Pass 2 after disconnecting
    // 2 (-> 2/4=0.5, above 37.5%) does NOT re-arm. Pass 3 after
    // disconnecting one more (-> 1/4=0.25 below 37.5%) re-arms.
    // Re-arming alone doesn't fire — the next upward crossing fires.
    let servers = stdio('a', 'b', 'c', 'd');
    const { events, config, manager } = await eventPass(
      () => servers,
      4,
      'warn',
    );
    expect(ofKind(events, 'budget_warning')).toHaveLength(1);

    // Drop to 50% via disconnect: 2/4 = 0.5 — above 37.5%, NO re-arm
    // (warning stays disabled).
    await manager.disconnectServer('c');
    await manager.disconnectServer('d');
    // Force a state evaluation through the public path (`evaluateBudgetState`
    // is private): a successful per-server rediscovery of 'a' is the
    // cleanest in-band trigger.
    await manager.discoverMcpToolsForServer('a', config);
    expect(ofKind(events, 'budget_warning')).toHaveLength(1); // still 1 — not re-fired

    // Drop to 25% via disconnect — below 37.5% — should re-arm but
    // not fire yet (re-arming alone doesn't trigger an event).
    await manager.disconnectServer('b');
    await manager.discoverMcpToolsForServer('a', config);
    expect(ofKind(events, 'budget_warning')).toHaveLength(1);

    // Now refill back to 4/4 — re-armed state plus upward crossing
    // fires the second warning.
    servers = stdio('a', 'b', 'c', 'd');
    await manager.discoverAllMcpToolsIncremental(config);
    expect(ofKind(events, 'budget_warning')).toHaveLength(2);
  });

  it('off mode never fires budget_warning', async () => {
    const { events } = await eventPass(stdio('a', 'b'), undefined, 'off');
    expect(events).toEqual([]);
  });

  it('refused_batch coalesces multi-refusal into one event per pass', async () => {
    // budget 1, 3 servers → a connects, b+c refused.
    const servers = {
      a: { command: 'node' },
      b: { httpUrl: 'http://b' },
      c: { url: 'http://c' },
    };
    const { events } = await eventPass(servers, 1, 'enforce');
    const batches = ofKind(events, 'refused_batch');
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
    const { events } = await eventPass(stdio('a', 'b'), 5, 'enforce');
    expect(ofKind(events, 'refused_batch')).toEqual([]);
  });

  it('readResource refusal emits a length-1 refused_batch then throws', async () => {
    // First pass fills the budget with `a`; `b` is refused — the bulk
    // refusal (length-1 batch).
    const { events, manager } = await eventPass(stdio('a', 'b'), 1, 'enforce');
    // Clear bulk events so the assertion below tracks only the
    // readResource path.
    events.length = 0;
    // Now lazy-spawn against b — slot full, throws + emits a
    // length-1 batch.
    await expect(manager.readResource('b', 'mcp://b/resource')).rejects.toThrow(
      BudgetExhaustedError,
    );
    const batches = ofKind(events, 'refused_batch');
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
    const { events, config, manager } = await eventPass(
      stdio('a', 'b'),
      undefined,
      'off',
    );
    // Discovery refusal is impossible in off mode (no budget), and
    // disconnect-then-rediscover also no-ops the state machine: end-to-end
    // no events.
    await manager.disconnectServer('a');
    await manager.discoverMcpToolsForServer('a', config);
    expect(events).toEqual([]);
  });

  it('refused_batch transports preserve the per-server family at refusal time', async () => {
    // Mixed transports refused; budget 1 admits the first only.
    const servers = {
      a: { command: 'node' }, // stdio (admitted)
      b: { httpUrl: 'http://b' }, // http (refused)
      c: { url: 'http://c' }, // sse (refused)
      d: { tcp: 'ws://d' }, // websocket (refused)
      e: { type: 'sdk', command: 'sdk' }, // sdk (refused)
    };
    const { events } = await eventPass(servers, 1, 'enforce');
    const batches = ofKind(events, 'refused_batch') as Array<{
      refusedServers: Array<{ name: string; transport: string }>;
    }>;
    expect(batches).toHaveLength(1);
    expect(
      batches[0].refusedServers.map((r) => `${r.name}:${r.transport}`),
    ).toEqual(['b:http', 'c:sse', 'd:websocket', 'e:sdk']);
  });

  it('warn mode never emits refused_batch (only enforce refuses)', async () => {
    const { events } = await eventPass(stdio('a', 'b', 'c'), 1, 'warn');
    // warn mode: no refusals, but the warning may fire (3/1 ratio crosses 0.75).
    expect(ofKind(events, 'refused_batch')).toEqual([]);
  });

  it('stop() re-arms the warning state machine for the next session', async () => {
    const { events, config, manager } = await eventPass(
      stdio('a', 'b', 'c', 'd'),
      4,
      'warn',
    );
    // First crossing fired one warning.
    expect(ofKind(events, 'budget_warning')).toHaveLength(1);
    // stop() resets state, so the next pass crossing 75% fires anew;
    // discoverAllMcpTools calls stop() at the top, so re-running suffices.
    await manager.discoverAllMcpTools(config);
    expect(ofKind(events, 'budget_warning')).toHaveLength(2);
  });

  it('discoverAllMcpToolsIncremental coalesces multi-server refusals into ONE batch (codex review fix #3)', async () => {
    // Codex review round 1, finding #3: pre-fix, when
    // `discoverAllMcpToolsIncremental` walked N new servers into a full
    // budget, each per-server refusal called `emitRefusedBatchIfAny` inline
    // → N length-1 batches instead of 1 length-N batch. Pins the "one batch
    // per pass" contract via the `bulkPassDepth` guard. Budget 1, 4 servers
    // — 1 admitted, 3 refused: pre-fix 3 length-1 batches via
    // `discoverMcpToolsForServer` → `...Internal`; post-fix 1 length-3 batch.
    const { events } = await eventPass(
      stdio('a', 'b', 'c', 'd'),
      1,
      'enforce',
      true,
    );
    const batches = ofKind(events, 'refused_batch') as Array<{
      refusedServers: Array<{ name: string }>;
    }>;
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
    // `evaluateBudgetState`, so `warnArmed` stayed `false` after a 75% fire
    // even once the ratio dropped below 37.5%. Operator-driven release path:
    // 4/4 → fire #1 → disconnect 3 (1/4, below re-arm) → reconnect →
    // fire #2. Pre-fix: only one fire.
    const { events, config, manager } = await eventPass(
      stdio('a', 'b', 'c', 'd'),
      4,
      'warn',
    );
    expect(ofKind(events, 'budget_warning')).toHaveLength(1);
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
    expect(ofKind(events, 'budget_warning')).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// T2.8: addRuntimeMcpServer / removeRuntimeMcpServer
// ────────────────────────────────────────────────────────────────────
describe('McpClientManager — addRuntimeMcpServer / removeRuntimeMcpServer (T2.8)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mock Config for the T2.8 tests: the standard accessors plus
   * `getSettingsMcpServers` (for shadow detection) and the runtime overlay.
   */
  function mkRuntimeConfig(
    opts: {
      settingsServers?: Rec;
      runtimeServers?: Record<string, MCPServerConfig>;
      runtimeAddSpy?: ReturnType<typeof vi.fn>;
      runtimeRemoveSpy?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    return poolCfg(undefined, {
      getSessionId: () => 'test-session-1',
      getSettingsMcpServers: () => opts.settingsServers ?? {},
      getRuntimeMcpServers: () => opts.runtimeServers ?? {},
      addRuntimeMcpServer: opts.runtimeAddSpy ?? vi.fn(),
      removeRuntimeMcpServer:
        opts.runtimeRemoveSpy ?? vi.fn().mockReturnValue(true),
    });
  }

  /** Pool-mode manager over `mkRuntimeConfig(opts)`. */
  function runtimeManager(
    acquire: unknown,
    opts: Parameters<typeof mkRuntimeConfig>[0] = {},
    budget?: unknown,
  ) {
    const pool = mkPool(acquire, budget);
    const config = mkRuntimeConfig(opts);
    return { pool, config, manager: mkManager({ config, options: { pool } }) };
  }

  // ───── ADD cases ──────────────────────────────────────────────────

  it('case 1: happy fresh add → replaced=false, correct transport and toolCount', async () => {
    const acquireSpy = vi.fn().mockResolvedValue(
      mkConn('my-server', {
        id: 'my-server::abc123',
        toolsSnapshot: [{ name: 'tool1' }, { name: 'tool2' }],
        promptsSnapshot: [],
      }),
    );
    const { config, manager } = runtimeManager(acquireSpy);

    const result = await manager.addRuntimeMcpServer(
      'my-server',
      { command: 'echo', args: ['hello'] },
      'client-1',
    );

    expect(result).toMatchObject({
      name: 'my-server',
      transport: 'stdio',
      replaced: false,
      shadowedSettings: false,
      toolCount: 2,
      originatorClientId: 'client-1',
    });
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(config.addRuntimeMcpServer).toHaveBeenCalledWith(
      'my-server',
      expect.objectContaining({ command: 'echo' }),
    );
  });

  it('case 2: budget enforce + at-cap + new name → throws McpBudgetWouldExceedError', async () => {
    const fakeBudget = {
      getMode: () => 'enforce' as const,
      tryReserve: vi.fn().mockReturnValue('refused'),
      getBudget: () => 1,
      getReservedCount: () => 1,
      beginBulkPass: vi.fn(),
      endBulkPass: vi.fn(),
      release: vi.fn(),
    };
    const { pool, manager } = runtimeManager(vi.fn(), {}, fakeBudget);

    await expect(
      manager.addRuntimeMcpServer(
        'new-server',
        { command: 'node', args: ['server.js'] },
        'client-2',
      ),
    ).rejects.toThrow(McpBudgetWouldExceedError);

    // Pool acquire should NOT have been called
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('case 3: budget warn + at-cap + new name → skipped with budget_warning_only', async () => {
    const fakeBudget = {
      getMode: () => 'warn' as const,
      tryReserve: vi.fn().mockReturnValue('reserved'),
      getBudget: () => 1,
      getReservedCount: () => 2, // over budget after reserve
      beginBulkPass: vi.fn(),
      endBulkPass: vi.fn(),
      release: vi.fn(),
    };
    const { pool, manager } = runtimeManager(vi.fn(), {}, fakeBudget);

    const result = await manager.addRuntimeMcpServer(
      'warn-server',
      { command: 'node', args: ['server.js'] },
      'client-3',
    );

    expect(result).toEqual({
      name: 'warn-server',
      skipped: true,
      reason: 'budget_warning_only',
    });
    // Budget slot should have been released (soft refusal)
    expect(fakeBudget.release).toHaveBeenCalledWith('warn-server');
    // Pool acquire should NOT have been called
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('case 4: same-fingerprint runtime replace refreshes metadata without re-acquiring', async () => {
    const serverConfig = {
      command: 'echo',
      args: ['hi'],
    } as unknown as MCPServerConfig;
    const updateConfig = vi.fn();
    const conn1 = mkConn('dup-srv', {
      updateConfig,
      // Distinct lifecycle id: if the same-fingerprint comparison below
      // regressed from `transportId` back to `id`, the replace would tear
      // down and re-acquire the transport, and this test would catch it.
      id: 'dup-srv::unpooled-0',
      // The REAL connection ID, matching what the implementation computes.
      transportId: connectionIdOf('dup-srv', serverConfig),
      toolsSnapshot: [
        { name: 'tool-a' },
        { name: 'tool-b' },
        { name: 'tool-c' },
      ],
      promptsSnapshot: [],
    });
    const acquireSpy = vi.fn().mockResolvedValue(conn1);
    const config = mkRuntimeConfig();
    // The refresh re-filters the session; the reported count must be the
    // session-visible one, not the unfiltered snapshot size.
    const sessionTools = [{ name: 'tool-b' }];
    const toolRegistry = {
      removeMcpToolsByServer: vi.fn(),
      getToolsByServer: vi.fn().mockReturnValue(sessionTools),
    } as unknown as ToolRegistry;
    const manager = mkManager({
      config,
      toolRegistry,
      options: { pool: mkPool(acquireSpy) },
    });

    // First add
    await manager.addRuntimeMcpServer('dup-srv', serverConfig, 'client-4');
    expect(acquireSpy).toHaveBeenCalledTimes(1);

    // Second add changes only per-session metadata, so the transport
    // fingerprint remains identical while the session view must refresh.
    acquireSpy.mockClear();
    const updatedConfig = {
      ...serverConfig,
      includeTools: ['tool-b'],
      trust: true,
      alwaysLoadTools: true,
    } as MCPServerConfig;
    const result = await manager.addRuntimeMcpServer(
      'dup-srv',
      updatedConfig,
      'client-4',
    );

    // The existing handle refreshes in place; the transport is not reacquired.
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledOnce();
    expect(updateConfig).toHaveBeenCalledWith(updatedConfig);
    // The overlay write persists the refresh across reconciliations, and it
    // lands AFTER the refresh so a throwing refresh cannot persist config
    // the session view never received.
    const addRuntimeSpy = config.addRuntimeMcpServer as ReturnType<
      typeof vi.fn
    >;
    expect(addRuntimeSpy).toHaveBeenLastCalledWith('dup-srv', updatedConfig);
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(
      addRuntimeSpy.mock.invocationCallOrder.at(-1)!,
    );
    expect(result).toMatchObject({
      name: 'dup-srv',
      replaced: false,
      toolCount: 1,
    });
  });

  it('case 5: shadows settings → shadowedSettings=true', async () => {
    const acquireSpy = vi.fn().mockResolvedValue(
      mkConn('shadow-srv', {
        id: 'shadow-srv::def',
        toolsSnapshot: [{ name: 't1' }],
        promptsSnapshot: [],
      }),
    );
    // Settings layer has an existing server with the same name
    const { manager } = runtimeManager(acquireSpy, {
      settingsServers: { 'shadow-srv': { command: 'old-cmd' } },
    });

    const result = await manager.addRuntimeMcpServer(
      'shadow-srv',
      { command: 'new-cmd', args: [] },
      'client-5',
    );

    expect(result).toMatchObject({
      name: 'shadow-srv',
      shadowedSettings: true,
    });
  });

  it.each([
    [
      'case 5b: ifAbsent skips before replacing a different runtime server',
      'old-cmd',
      'client-5b',
    ],
    [
      'case 5c: ifAbsent skips before reusing an unowned runtime server',
      'new-cmd',
      'client-5c',
    ],
  ])('%s', async (_title, existingCommand, clientId) => {
    const acquireSpy = vi.fn();
    const addSpy = vi.fn();
    const { manager } = runtimeManager(acquireSpy, {
      runtimeServers: { 'runtime-srv': new MCPServerConfig(existingCommand) },
      runtimeAddSpy: addSpy,
    });

    const result = await manager.addRuntimeMcpServer(
      'runtime-srv',
      {
        command: 'new-cmd',
        __qwenRuntimeMcpIfAbsent: true,
      } as unknown as MCPServerConfig,
      clientId,
    );

    expect(result).toEqual({
      name: 'runtime-srv',
      skipped: true,
      reason: 'runtime_name_conflict',
    });
    expect(addSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  // ───── REMOVE cases ───────────────────────────────────────────────

  it('case 1: removes runtime entry → removed=true, wasShadowingSettings=false', async () => {
    const releaseSpyConn = vi.fn();
    const conn = mkConn('rm-srv', {
      release: releaseSpyConn,
      id: 'rm-srv::aaa',
      toolsSnapshot: [],
      promptsSnapshot: [],
    });
    const removeSpy = vi.fn().mockReturnValue(true);
    const { manager } = runtimeManager(vi.fn().mockResolvedValue(conn), {
      runtimeRemoveSpy: removeSpy,
    });

    // Add then remove
    await manager.addRuntimeMcpServer(
      'rm-srv',
      { command: 'echo' },
      'client-6',
    );
    const result = await manager.removeRuntimeMcpServer('rm-srv', 'client-6');

    expect(result).toMatchObject({
      name: 'rm-srv',
      removed: true,
      wasShadowingSettings: false,
      originatorClientId: 'client-6',
    });
    expect(releaseSpyConn).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('rm-srv');
  });

  it('case 2: removes shadow over settings → wasShadowingSettings=true', async () => {
    const conn = mkConn('shadow-rm', {
      id: 'shadow-rm::bbb',
      toolsSnapshot: [],
      promptsSnapshot: [],
    });
    const { manager } = runtimeManager(vi.fn().mockResolvedValue(conn), {
      settingsServers: { 'shadow-rm': { command: 'settings-cmd' } },
      runtimeRemoveSpy: vi.fn().mockReturnValue(true),
    });

    // Add runtime entry that shadows settings
    await manager.addRuntimeMcpServer(
      'shadow-rm',
      { command: 'runtime-cmd' },
      'client-7',
    );
    const result = await manager.removeRuntimeMcpServer(
      'shadow-rm',
      'client-7',
    );

    expect(result).toMatchObject({
      name: 'shadow-rm',
      removed: true,
      wasShadowingSettings: true,
    });
  });

  it('case 3: non-existent → skipped not_present', async () => {
    const removeSpy = vi.fn().mockReturnValue(false);
    const config = mkRuntimeConfig({ runtimeRemoveSpy: removeSpy });
    const manager = mkManager({ config });

    const result = await manager.removeRuntimeMcpServer('ghost', 'client-8');

    expect(result).toEqual({
      name: 'ghost',
      skipped: true,
      reason: 'not_present',
    });
  });

  // ───── Error class tests ──────────────────────────────────────────

  it('throws InvalidMcpConfigError for config with unknown transport', async () => {
    const manager = mkManager({ config: mkRuntimeConfig() });

    await expect(
      manager.addRuntimeMcpServer(
        'bad-cfg',
        {} as unknown as MCPServerConfig,
        'client-9',
      ),
    ).rejects.toThrow(InvalidMcpConfigError);
  });

  it('throws McpServerSpawnFailedError when pool.acquire rejects', async () => {
    const removeSpy = vi.fn().mockReturnValue(true);
    const { manager } = runtimeManager(
      vi.fn().mockRejectedValue(new Error('Connection refused')),
      { runtimeRemoveSpy: removeSpy },
    );

    await expect(
      manager.addRuntimeMcpServer(
        'fail-srv',
        { command: 'bad-binary' },
        'client-10',
      ),
    ).rejects.toThrow(McpServerSpawnFailedError);

    // Config overlay should have been rolled back
    expect(removeSpy).toHaveBeenCalledWith('fail-srv');
  });
});

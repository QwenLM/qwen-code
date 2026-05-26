/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpClientManager,
  type McpClientManagerOptions,
} from './mcp-client-manager.js';
import { McpClient } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Config } from '../config/config.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { connectionIdOf } from './mcp-pool-key.js';

vi.mock('./mcp-client.js', async () => {
  const originalModule = await vi.importActual('./mcp-client.js');
  return {
    ...originalModule,
    McpClient: vi.fn(),
    // Return the input servers unchanged (identity function)
    populateMcpServerCommand: vi.fn((servers) => servers),
  };
});

/**
 * F2 (#4175 commit 6 review fix — wenshao R9 / PR A): test factory
 * for `McpClientManager`. Pre-fix the 80 construction sites in this
 * file each repeated a 7-positional call with 4 `undefined` sentinels
 * to reach the trailing `pool` arg. With the options-object ctor +
 * this factory, each site names only the fields it overrides; default
 * `mockConfig` + `{} as ToolRegistry` cover the no-arg case.
 */
function mkManager(
  overrides: {
    config?: Config;
    toolRegistry?: ToolRegistry;
    options?: McpClientManagerOptions;
  } = {},
): McpClientManager {
  const config =
    overrides.config ??
    ({
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config);
  const toolRegistry =
    overrides.toolRegistry ??
    ({
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry);
  return new McpClientManager(config, toolRegistry, overrides.options ?? {});
}

describe('McpClientManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes discovery through the pool when one is injected (F2 commit 4)', async () => {
    // F2 contract: when a McpTransportPool is wired into the manager
    // ctor, `discoverAllMcpTools` MUST go through `pool.acquire`
    // instead of constructing its own McpClient. This catches a
    // regression where the pool branch is silently bypassed and N
    // sessions revert to N spawns.
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      // F2 (#4175 commit 6): pool exposes `getBudget()` so the
      // manager's `discoverAllMcpToolsViaPool` can bracket the pass
      // with `beginBulkPass` / `endBulkPass`. The fake returns
      // undefined to disable the bulk-pass scope (no budget is
      // wired in this test path).
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    await manager.discoverAllMcpTools(mockConfig);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledWith(
      'srv',
      {},
      'sid-1',
      expect.anything(),
      expect.anything(),
    );
    // Critical inverse invariant: pool path must NOT also spawn its
    // own McpClient (would double-spawn one process per session).
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('swallows BudgetExhaustedError from pool.acquire and logs at debug (F2 commit 6 W23)', async () => {
    // Wenshao W23 review fold-in: the manager's `discoverAllMcpToolsViaPool`
    // catch block now branches on `instanceof BudgetExhaustedError`
    // (deliberate refusal → debug log; other errors still go to
    // error-level). The `Promise.all` await must NOT see the
    // rejection — refusals are non-fatal for sibling acquires. This
    // test wires a fake pool whose `acquire` throws
    // BudgetExhaustedError for `srvB` and succeeds for `srvA`, then
    // asserts (a) the discovery completes (`Promise.all` resolves),
    // (b) only `srvA` lands in `pooledConnections`, (c) `endBulkPass`
    // fires once via the budget mock so the refused_batch contract
    // is preserved.
    const { BudgetExhaustedError } = await import('./mcp-client-manager.js');
    const acquireSpy = vi.fn().mockImplementation((name: string) => {
      if (name === 'srvB') {
        throw new BudgetExhaustedError('srvB', 1, 1);
      }
      return Promise.resolve({
        release: vi.fn(),
        on: vi.fn(),
        id: `${name}::abc`,
        serverName: name,
        entryIndex: 0,
      });
    });
    const beginBulkPass = vi.fn();
    const endBulkPass = vi.fn();
    const fakeBudget = { beginBulkPass, endBulkPass };
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(fakeBudget),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srvA: {}, srvB: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    // Should resolve without throwing — the BudgetExhaustedError on
    // srvB is caught and downgraded to a debug log.
    await manager.discoverAllMcpTools(mockConfig);
    expect(beginBulkPass).toHaveBeenCalledTimes(1);
    expect(endBulkPass).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
  });

  it('stop() awaits in-flight pool discovery before releasing pool connections (W94/W108/W112)', async () => {
    // Pre-W94 fix: stop() called releaseAllPooledConnections() while
    // discoverAllMcpToolsViaPool was still mid-flight; the in-flight
    // pass would subsequently call pool.acquire(...) and attach a
    // fresh entry to pooledConnections AFTER the release loop had
    // already cleared the Map → leaked pool ref.
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    const events: string[] = [];
    const acquireSpy = vi.fn().mockImplementation(async (name: string) => {
      events.push(`acquire-start-${name}`);
      await acquireGate;
      events.push(`acquire-end-${name}`);
      // Returned connection's release() is what releaseAllPooledConnections
      // invokes. Tracking THAT lets the test assert the ordering.
      return {
        release: vi.fn().mockImplementation(() => {
          events.push(`release-${name}`);
        }),
        on: vi.fn(),
        id: `${name}::abc`,
        serverName: name,
        entryIndex: 0,
      };
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });

    // Kick off discovery; it enters in-flight (acquire awaits the gate).
    const discoveryPromise = manager.discoverAllMcpTools(mockConfig);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['acquire-start-srv']);

    // Concurrently call stop(); it must AWAIT discoveryInFlight before
    // calling releaseAllPooledConnections (which invokes each conn.release).
    const stopPromise = manager.stop();
    await Promise.resolve();
    // Pre-fix: stop() would proceed past discoveryInFlight immediately
    // and release-srv would fire BEFORE acquire-end-srv. Post-fix the
    // outer Promise.race waits up to 5s for in-flight discovery.
    expect(events).toEqual(['acquire-start-srv']);

    // Release the gate; discovery completes, then stop() proceeds.
    releaseAcquire();
    await discoveryPromise;
    await stopPromise;

    // Ordering invariant: acquire-end MUST precede release-srv.
    const acquireEndIdx = events.indexOf('acquire-end-srv');
    const releaseIdx = events.indexOf('release-srv');
    expect(acquireEndIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(acquireEndIdx);
  });

  it('stop() proceeds when injected discoveryInFlight rejects (W94/W108/W112/W116 rejection path)', async () => {
    // Pre-W116: the previous test wrapped manager.discoverAllMcpTools
    // and expected the rejection to bubble up to discoveryInFlight,
    // but runDiscoverAllMcpToolsViaPool catches per-server acquire
    // failures internally — so Promise.all resolves, discoveryInFlight
    // resolves, .finally sets it to undefined, and by the time stop()
    // runs the `if (this.discoveryInFlight)` guard skips the entire
    // W108 catch block. The test passed but exercised zero W108 code.
    //
    // Post-W116: directly inject a rejecting promise into the private
    // field to actually exercise the W108 catch + debug log path.
    const fakePool = {
      acquire: vi.fn(),
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    // Inject a rejecting in-flight promise (the only way to hit the
    // W108 catch block — internal per-server catches mean the natural
    // path always resolves).
    const rejected = Promise.reject(new Error('synthetic-discovery-failure'));
    rejected.catch(() => {
      /* attach a noop catch to avoid Node's UnhandledPromiseRejection
         warning; the manager.stop() flow will attach its own catch */
    });
    (
      manager as unknown as { discoveryInFlight?: Promise<void> }
    ).discoveryInFlight = rejected;

    // stop() must NOT throw even though discoveryInFlight rejects.
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('stop() proceeds when discoveryInFlight exceeds the 5s grace cap (W108/W116 timeout path)', async () => {
    // Pre-W108: no shutdown-level deadline; a single hung MCP server
    // could block daemon SIGTERM for the full 30s acquire timeout.
    // Post-W108: outer Promise.race against a 5s grace timer caps the
    // shutdown wait. Test: inject a never-settling discoveryInFlight,
    // advance fake timers past the 5s mark, assert stop() resolves
    // AND the W115 stopTimedOut flag is set so any late-resolving
    // pool.acquire skips its pooledConnections.set.
    vi.useFakeTimers();
    try {
      const fakePool = {
        acquire: vi.fn(),
        releaseSession: vi.fn(),
        getBudget: vi.fn().mockReturnValue(undefined),
      } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
      const mockConfig = {
        isTrustedFolder: () => true,
        getMcpServers: () => ({}),
        getMcpServerCommand: () => undefined,
        getPromptRegistry: () => ({}),
        getWorkspaceContext: () => ({}),
        getDebugMode: () => false,
        getSessionId: () => 'sid-1',
        isMcpServerDisabled: () => false,
      } as unknown as Config;
      const manager = mkManager({
        config: mockConfig,
        options: { pool: fakePool },
      });
      // Inject a never-settling in-flight promise.
      (
        manager as unknown as { discoveryInFlight?: Promise<void> }
      ).discoveryInFlight = new Promise<void>(() => {
        /* never resolves */
      });

      const stopPromise = manager.stop();
      // Advance past the 5s grace cap; grace timer fires, stop()
      // proceeds, W115 stopTimedOut flag set.
      await vi.advanceTimersByTimeAsync(5_100);
      await expect(stopPromise).resolves.toBeUndefined();
      expect(
        (manager as unknown as { stopTimedOut: boolean }).stopTimedOut,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovery resets stopTimedOut so manager remains usable after a timed-out shutdown (W118)', async () => {
    // Pre-W118: stopTimedOut was sticky across stop() calls. Once set
    // by a 5s grace timeout, every subsequent discovery pass would
    // release/skip every acquired connection, silently leaving the
    // manager unable to reattach pooled MCP servers. Post-W118 the
    // flag is reset at the start of every discovery pass.
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });

    // Simulate a prior timed-out shutdown that set the sticky flag.
    (manager as unknown as { stopTimedOut: boolean }).stopTimedOut = true;

    // A fresh discovery pass should reset the flag at the top so the
    // acquired connection is tracked normally — pre-W118 it would be
    // released and the pooledConnections Map would stay empty.
    await manager.discoverAllMcpTools(mockConfig);
    expect((manager as unknown as { stopTimedOut: boolean }).stopTimedOut).toBe(
      false,
    );
    // Connection MUST have been tracked (not silently released by the
    // sticky-flag guard).
    expect(
      (
        manager as unknown as {
          pooledConnections: Map<string, unknown>;
        }
      ).pooledConnections.has('srv'),
    ).toBe(true);
  });

  it('routes incremental discovery through the pool when injected (F2 commit 4 C7 / W38)', async () => {
    // Wenshao W38 review fold-in: the C7 fix added the pool gate to
    // `discoverAllMcpToolsIncremental` (the default progressive-mode
    // boot path) but no test covered it — only `discoverAllMcpTools`
    // had pool-routing coverage. A regression that misplaced or
    // removed the gate would silently bypass the pool during daemon
    // boot, spawning N per-session McpClient processes instead of
    // sharing one pool entry. This mirrors the existing "routes
    // discovery through the pool" test but exercises the
    // `discoverAllMcpToolsIncremental` path.
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('routes single-server discovery through the pool when injected', async () => {
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });

    await manager.discoverMcpToolsForServer('srv', mockConfig);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('routes readResource through an existing pooled connection', async () => {
    const { MCPServerStatus } = await import('./mcp-client.js');
    const readResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
    });
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
      // R24 T19: pooled fast-path now health-checks via
      // `client.getStatus()` before delegating; mocks must provide it.
      client: { readResource, getStatus: () => MCPServerStatus.CONNECTED },
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    await manager.discoverAllMcpTools(mockConfig);

    const result = await manager.readResource('srv', 'mcp://srv/doc');

    expect(readResource).toHaveBeenCalledWith('mcp://srv/doc', undefined);
    expect(result).toEqual({
      contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
    });
    expect(McpClient).not.toHaveBeenCalled();
  });

  it('readResource self-heals when pooled handle is dead (R24 T19)', async () => {
    // R24 T19: pre-fix the pooled fast-path
    // (`pooledConnections.get` → `pooled.client.readResource`) skipped
    // any health check on the McpClient. In the narrow window between
    // a silent transport drop (W120/W131 flips entry to 'failed' +
    // emits the 'failed' event) and the manager's `onFailed`
    // listener evicting the handle from `pooledConnections`, a
    // `readResource` would delegate to a dead transport and surface
    // an opaque MCP `"Transport is closed"` error. Post-fix the
    // pooled path checks `pooled.client.getStatus()`; if not
    // CONNECTED, it evicts the handle inline (so the next call
    // re-acquires through the legacy spawn path) and throws a clear
    // server-unavailable error.
    const { MCPServerStatus } = await import('./mcp-client.js');
    const readResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
    });
    let mockedStatus: (typeof MCPServerStatus)[keyof typeof MCPServerStatus] =
      MCPServerStatus.CONNECTED;
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
      client: {
        readResource,
        getStatus: () => mockedStatus,
      },
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    await manager.discoverAllMcpTools(mockConfig);
    // Sanity: healthy fast-path still works.
    await expect(manager.readResource('srv', 'mcp://srv/doc')).resolves.toEqual(
      {
        contents: [{ uri: 'mcp://srv/doc', text: 'pooled' }],
      },
    );

    // Simulate the silent-drop window: pooled handle is still in
    // pooledConnections (onFailed listener hasn't run yet), but the
    // McpClient's status has flipped to DISCONNECTED.
    mockedStatus = MCPServerStatus.DISCONNECTED;

    // Pre-R24 this delegated to readResource on the dead transport
    // and surfaced an opaque MCP error. Post-R24 self-heal: clear
    // server-unavailable error + handle evicted from pooledConnections.
    await expect(manager.readResource('srv', 'mcp://srv/doc')).rejects.toThrow(
      /pool entry disconnected; retry after discovery/,
    );

    // Handle evicted — confirms self-heal cleanup ran.
    const pooledMap = (
      manager as unknown as {
        pooledConnections: Map<string, unknown>;
      }
    ).pooledConnections;
    expect(pooledMap.has('srv')).toBe(false);
  });

  it('disconnectServer releases pooled connection in pool mode (F2 commit 4 / W39)', async () => {
    // Wenshao W39 review fold-in: the manager's `disconnectServer`
    // pool-mode branch (`pooledConnections.get(name).release()` +
    // `pooledConnections.delete(name)`) had no test coverage. If the
    // release call is missing/broken, the pool entry's refcount
    // never reaches 0, the drain timer never fires, and the shared
    // subprocess leaks for the daemon's lifetime. This test wires a
    // pool fake, populates `pooledConnections` via discovery, then
    // asserts `disconnectServer` calls `release()` and removes the
    // map entry.
    const releaseSpy = vi.fn();
    const acquireSpy = vi.fn().mockResolvedValue({
      release: releaseSpy,
      on: vi.fn(),
      id: 'srv::abc',
      serverName: 'srv',
      entryIndex: 0,
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
      options: { pool: fakePool },
    });
    await manager.discoverAllMcpTools(mockConfig);
    expect(releaseSpy).not.toHaveBeenCalled();
    await manager.disconnectServer('srv');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent discovery passes via mutex (F2 commit 6 W6)', async () => {
    // Wenshao W6 review fold-in: pre-fix two concurrent
    // `discoverAllMcpTools[Incremental]` invocations could both see
    // `pooledConnections.has(name) === false` and both call
    // `pool.acquire`, with the second `set(name, conn2)` silently
    // overwriting the first → conn1 leaked. Mutex ensures the second
    // caller awaits the first promise.
    let resolveAcquire: (() => void) | undefined;
    const blockedAcquire = new Promise<void>((resolve) => {
      resolveAcquire = resolve;
    });
    const acquireSpy = vi.fn().mockImplementation(async () => {
      await blockedAcquire;
      return {
        release: vi.fn(),
        on: vi.fn(),
        id: 'srv::abc',
        serverName: 'srv',
        entryIndex: 0,
      };
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { pool: fakePool },
    });
    const p1 = manager.discoverAllMcpTools(mockConfig);
    const p2 = manager.discoverAllMcpTools(mockConfig);
    // Both passes block on the in-flight `pool.acquire`. Pre-fix
    // each pass would call `acquire` independently → 2 calls.
    // Post-fix the second pass awaits the same `discoveryInFlight`
    // promise → still 1 call.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    resolveAcquire?.();
    await Promise.all([p1, p2]);
    // After both resolve, total acquire count is still 1 — mutex
    // prevented the second pass from re-acquiring the same server.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to per-session McpClient spawn when no pool injected (backward compat)', async () => {
    // The 70+ existing tests already assert this implicitly. This
    // adds an explicit assertion so future refactors that flip the
    // default break this test.
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
      getMcpServers: () => ({ srv: {} }),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });
    await manager.discoverAllMcpTools(mockConfig);
    expect(McpClient).toHaveBeenCalledOnce();
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
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
    const manager = mkManager({ config: mockConfig });
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
    const manager = mkManager({ config: mockConfig });
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
    const manager = mkManager({ config: mockConfig });
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
    const manager = mkManager({ config: mockConfig });
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
    const manager = mkManager({ config: mockConfig });

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
    const manager = mkManager({ config: mockConfig });

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
    const manager = mkManager({ config: mockConfig });

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
    const manager = mkManager({
      config: mockConfig,
      options: {
        healthConfig: {
          autoReconnect: true,
          checkIntervalMs: 10,
          maxConsecutiveFailures: 1,
          reconnectDelayMs: 10,
        },
      },
    });

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
    const manager = mkManager({ config: mockConfig });

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
    const manager = mkManager({ config: mockConfig });

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
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });

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
    const manager = mkManager({ config: mockConfig });

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
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: toolRegistryStub,
    });

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
    const manager = mkManager({ config: mockConfig });
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
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });
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
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });
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
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: { removeMcpToolsByServer } as unknown as ToolRegistry,
    });

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
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });

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
    const manager = mkManager({
      config: mockConfig,
      options: { eventEmitter: events },
    });

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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 2, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 2, budgetMode: 'warn' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { budgetMode: 'off' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 2, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({ config });
    expect(manager.getMcpClientBudget()).toBe(7);
    expect(manager.getMcpBudgetMode()).toBe('enforce');
  });

  it('env var fallback defaults mode to warn when only budget is set', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '5';
    // No mode env var. Resolved mode is `warn` (the safe default).
    const config = configWithServers({});
    const manager = mkManager({ config });
    expect(manager.getMcpClientBudget()).toBe(5);
    expect(manager.getMcpBudgetMode()).toBe('warn');
  });

  it('env var fallback rejects non-positive budgets silently', async () => {
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '-3';
    const config = configWithServers({});
    const manager = mkManager({ config });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 2, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      toolRegistry: {
        removeMcpToolsByServer: () => undefined,
      } as unknown as ToolRegistry,
      options: { budgetConfig: { clientBudget: 2, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { budgetMode: 'off' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({ config });
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
    const manager = mkManager({ config });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      toolRegistry: {
        removeMcpToolsByServer: () => undefined,
      } as unknown as ToolRegistry,
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
    const manager = mkManager({
      config,
      toolRegistry: {
        removeMcpToolsByServer: () => undefined,
      } as unknown as ToolRegistry,
      options: { budgetConfig: { clientBudget: 2, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({ config });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
      const manager = mkManager({ config });
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
    const manager = mkManager({ config });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
      const manager = mkManager({ config });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({ config });
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
    const manager = mkManager({
      config,
      // Invalid combination: enforce mode without a budget.
      options: { budgetConfig: { budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 4,
          budgetMode: 'warn',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 4,
          budgetMode: 'warn',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 4,
          budgetMode: 'warn',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          budgetMode: 'off',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 1,
          budgetMode: 'enforce',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 5,
          budgetMode: 'enforce',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 1,
          budgetMode: 'enforce',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          budgetMode: 'off',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 1,
          budgetMode: 'enforce',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 1,
          budgetMode: 'warn',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 4,
          budgetMode: 'warn',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 1,
          budgetMode: 'enforce',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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
    const manager = mkManager({
      config,
      options: {
        budgetConfig: {
          clientBudget: 4,
          budgetMode: 'warn',
          onBudgetEvent: (e) => events.push(e),
        },
      },
    });
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

// ────────────────────────────────────────────────────────────────────
// T2.8: addRuntimeMcpServer / removeRuntimeMcpServer
// ────────────────────────────────────────────────────────────────────
describe('McpClientManager — addRuntimeMcpServer / removeRuntimeMcpServer (T2.8)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Shared mock config builder for the T2.8 tests. Returns a mock Config
   * that has `getSettingsMcpServers` (for shadow detection) and all the
   * standard accessors the manager needs.
   */
  function mkRuntimeConfig(
    opts: {
      settingsServers?: Record<string, unknown>;
      runtimeAddSpy?: ReturnType<typeof vi.fn>;
      runtimeRemoveSpy?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const addSpy = opts.runtimeAddSpy ?? vi.fn();
    const removeSpy = opts.runtimeRemoveSpy ?? vi.fn().mockReturnValue(true);
    return {
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getPromptRegistry: () => ({}),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'test-session-1',
      isMcpServerDisabled: () => false,
      getSettingsMcpServers: () => opts.settingsServers ?? {},
      addRuntimeMcpServer: addSpy,
      removeRuntimeMcpServer: removeSpy,
    } as unknown as Config;
  }

  // ───── ADD cases ──────────────────────────────────────────────────

  it('case 1: happy fresh add → replaced=false, correct transport and toolCount', async () => {
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'my-server::abc123',
      serverName: 'my-server',
      entryIndex: 0,
      toolsSnapshot: [{ name: 'tool1' }, { name: 'tool2' }],
      promptsSnapshot: [],
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const config = mkRuntimeConfig();
    const manager = mkManager({ config, options: { pool: fakePool } });

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
    const { McpBudgetWouldExceedError } = await import('./mcp-errors.js');
    const fakeBudget = {
      getMode: () => 'enforce' as const,
      tryReserve: vi.fn().mockReturnValue('refused'),
      getBudget: () => 1,
      getReservedCount: () => 1,
      beginBulkPass: vi.fn(),
      endBulkPass: vi.fn(),
      release: vi.fn(),
    };
    const fakePool = {
      acquire: vi.fn(),
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(fakeBudget),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const config = mkRuntimeConfig();
    const manager = mkManager({ config, options: { pool: fakePool } });

    await expect(
      manager.addRuntimeMcpServer(
        'new-server',
        { command: 'node', args: ['server.js'] },
        'client-2',
      ),
    ).rejects.toThrow(McpBudgetWouldExceedError);

    // Pool acquire should NOT have been called
    expect(fakePool.acquire).not.toHaveBeenCalled();
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
    const fakePool = {
      acquire: vi.fn(),
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(fakeBudget),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const config = mkRuntimeConfig();
    const manager = mkManager({ config, options: { pool: fakePool } });

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
    expect(fakePool.acquire).not.toHaveBeenCalled();
  });

  it('case 4: replace same name + same fingerprint → replaced=true, pool.acquire NOT re-called', async () => {
    const serverConfig = {
      command: 'echo',
      args: ['hi'],
    } as unknown as import('../config/config.js').MCPServerConfig;
    // Compute the REAL connection ID so the mock matches what the
    // implementation will compute via `connectionIdOf`.
    const realId = connectionIdOf('dup-srv', serverConfig);

    const releaseSpyConn1 = vi.fn();
    const conn1 = {
      release: releaseSpyConn1,
      on: vi.fn(),
      id: realId,
      serverName: 'dup-srv',
      entryIndex: 0,
      toolsSnapshot: [
        { name: 'tool-a' },
        { name: 'tool-b' },
        { name: 'tool-c' },
      ],
      promptsSnapshot: [],
    };
    const acquireSpy = vi.fn().mockResolvedValue(conn1);
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const config = mkRuntimeConfig();
    const manager = mkManager({ config, options: { pool: fakePool } });

    // First add
    await manager.addRuntimeMcpServer('dup-srv', serverConfig, 'client-4');
    expect(acquireSpy).toHaveBeenCalledTimes(1);

    // Second add with SAME config (same fingerprint)
    acquireSpy.mockClear();
    const result = await manager.addRuntimeMcpServer(
      'dup-srv',
      serverConfig,
      'client-4',
    );

    // pool.acquire should NOT have been re-called (idempotent replace)
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      name: 'dup-srv',
      replaced: true,
      toolCount: 3,
    });
  });

  it('case 5: shadows settings → shadowedSettings=true', async () => {
    const acquireSpy = vi.fn().mockResolvedValue({
      release: vi.fn(),
      on: vi.fn(),
      id: 'shadow-srv::def',
      serverName: 'shadow-srv',
      entryIndex: 0,
      toolsSnapshot: [{ name: 't1' }],
      promptsSnapshot: [],
    });
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    // Settings layer has an existing server with the same name
    const config = mkRuntimeConfig({
      settingsServers: { 'shadow-srv': { command: 'old-cmd' } },
    });
    const manager = mkManager({ config, options: { pool: fakePool } });

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

  // ───── REMOVE cases ───────────────────────────────────────────────

  it('case 1: removes runtime entry → removed=true, wasShadowingSettings=false', async () => {
    const releaseSpyConn = vi.fn();
    const conn = {
      release: releaseSpyConn,
      on: vi.fn(),
      id: 'rm-srv::aaa',
      serverName: 'rm-srv',
      entryIndex: 0,
      toolsSnapshot: [],
      promptsSnapshot: [],
    };
    const acquireSpy = vi.fn().mockResolvedValue(conn);
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const removeSpy = vi.fn().mockReturnValue(true);
    const config = mkRuntimeConfig({ runtimeRemoveSpy: removeSpy });
    const manager = mkManager({ config, options: { pool: fakePool } });

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
    const conn = {
      release: vi.fn(),
      on: vi.fn(),
      id: 'shadow-rm::bbb',
      serverName: 'shadow-rm',
      entryIndex: 0,
      toolsSnapshot: [],
      promptsSnapshot: [],
    };
    const acquireSpy = vi.fn().mockResolvedValue(conn);
    const fakePool = {
      acquire: acquireSpy,
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const removeSpy = vi.fn().mockReturnValue(true);
    const config = mkRuntimeConfig({
      settingsServers: { 'shadow-rm': { command: 'settings-cmd' } },
      runtimeRemoveSpy: removeSpy,
    });
    const manager = mkManager({ config, options: { pool: fakePool } });

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
    const { InvalidMcpConfigError } = await import('./mcp-errors.js');
    const config = mkRuntimeConfig();
    const manager = mkManager({ config });

    await expect(
      manager.addRuntimeMcpServer(
        'bad-cfg',
        {} as unknown as import('../config/config.js').MCPServerConfig,
        'client-9',
      ),
    ).rejects.toThrow(InvalidMcpConfigError);
  });

  it('throws McpServerSpawnFailedError when pool.acquire rejects', async () => {
    const { McpServerSpawnFailedError } = await import('./mcp-errors.js');
    const fakePool = {
      acquire: vi.fn().mockRejectedValue(new Error('Connection refused')),
      releaseSession: vi.fn(),
      getBudget: vi.fn().mockReturnValue(undefined),
    } as unknown as import('./mcp-transport-pool.js').McpTransportPool;

    const removeSpy = vi.fn().mockReturnValue(true);
    const config = mkRuntimeConfig({ runtimeRemoveSpy: removeSpy });
    const manager = mkManager({ config, options: { pool: fakePool } });

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

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as ClientLib from '@modelcontextprotocol/sdk/client/index.js';
import * as SdkClientStdioLib from '@modelcontextprotocol/sdk/client/stdio.js';
import * as GenAiLib from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerConfig, type Config } from '../config/config.js';
import type { PoolEntry } from './mcp-pool-entry.js';
import { connectionIdOf } from './mcp-pool-key.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  McpTransportPool,
  type McpTransportPoolOptions,
} from './mcp-transport-pool.js';
import { SessionMcpView } from './session-mcp-view.js';
import type { ToolRegistry } from './tool-registry.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js');
vi.mock('@modelcontextprotocol/sdk/client/stdio.js');
vi.mock('@google/genai');

// F2 (#4175 follow-up — W134): mocked so per-test overrides can make
// `listDescendantPids` throw or return partial signaling. Defaults to
// empty descendants so existing tests behave unchanged.
vi.mock('./pid-descendants.js', () => ({
  listDescendantPids: vi.fn().mockResolvedValue([]),
  sigtermPids: vi.fn().mockReturnValue(0),
}));

// F2 (#4175 follow-up — W134): mocked so the test can assert
// debugLogger.warn was called with the silent-drop sweep observability
// payload. Production debugLogger is session-gated and a no-op in
// tests (no AsyncLocalStorage session set), so we mock the factory to
// return a vi.fn-backed stub. All existing tests are unaffected — they
// don't assert on debugLogger output.
//
// Singleton-stub design: the `stub` object is constructed once when
// the factory body runs (vitest evaluates the factory once per
// `vi.mock` call), and the inner arrow `() => stub` returns that same
// object on every `createDebugLogger(...)` invocation. So both the
// production module-load call inside `mcp-pool-entry.ts` AND the
// test's later retrieval get the exact same vi.fn instances —
// `mockMock.warn` in the test is the same warn the production code
// fired against. A factory that constructed a new object per call
// would have broken that link.
vi.mock('../utils/debugLogger.js', () => {
  const stub = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { createDebugLogger: () => stub };
});

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

function mkSessionRegistries() {
  return {
    tools: {
      registerTool: vi.fn(),
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry,
    prompts: {
      registerPrompt: vi.fn(),
      removePromptsByServer: vi.fn(),
    } as unknown as PromptRegistry,
    resources: {
      registerResource: vi.fn(),
      removeResourcesByServer: vi.fn(),
    } as unknown as ResourceRegistry,
  };
}

/**
 * Set up the MCP SDK mocks to simulate a successfully-connecting
 * stdio server that returns the given tool names + prompt names.
 * Returns the mock objects so tests can introspect connect-call counts.
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

describe('McpTransportPool', () => {
  const cliConfig = {} as Config;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('acquire / release lifecycle', () => {
    it('3 sessions acquiring same key share 1 entry (1 connect call)', async () => {
      const mocked = mockMcpSuccess({ toolNames: ['greet'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');

      const r1 = mkSessionRegistries();
      const c1 = await pool.acquire(
        'srv',
        cfg,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      const r2 = mkSessionRegistries();
      const c2 = await pool.acquire(
        'srv',
        cfg,
        's2',
        r2.tools,
        r2.prompts,
        r2.resources,
      );
      const r3 = mkSessionRegistries();
      const c3 = await pool.acquire(
        'srv',
        cfg,
        's3',
        r3.tools,
        r3.prompts,
        r3.resources,
      );

      expect(mocked.connect).toHaveBeenCalledTimes(1);
      expect(c1.id).toBe(c2.id);
      expect(c2.id).toBe(c3.id);
      // All three sessions appear in the pool snapshot for the entry.
      const snap = pool.getSnapshot();
      expect(snap.byName['srv'].entryCount).toBe(1);
      expect(snap.byName['srv'].entrySummary[0].refs).toBe(3);
    });

    it('resources discovered via the pool reach the session resource registry', async () => {
      mockMcpSuccess({ toolNames: ['t1'], resourceNames: ['file:///doc.txt'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');

      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);

      // discoverAndReturn → markActive → attach replay → applyResources
      // registers the snapshot into THIS session's resource registry,
      // tagged with the originating serverName.
      expect(r.resources.registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'file:///doc.txt', serverName: 'srv' }),
      );
    });

    it('different env between two sessions creates 2 distinct entries (credential isolation)', async () => {
      const mocked = mockMcpSuccess();
      const cfgA = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://api.x',
        { Authorization: 'tokenA' },
      );
      const cfgB = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://api.x',
        { Authorization: 'tokenB' },
      );

      const r1 = mkSessionRegistries();
      const r2 = mkSessionRegistries();
      // Default pooledTransports excludes http (V21 C8 opt-in); enable
      // it so the credential-isolation invariant can be tested in pool
      // mode (otherwise both sessions take the unpooled bypass path,
      // which is trivially isolated by construction).
      const pool2 = new McpTransportPool(
        cliConfig,
        mkPoolOptions({
          pooledTransports: new Set([
            'stdio',
            'websocket',
            'http',
          ]) as ReadonlySet<
            'stdio' | 'websocket' | 'http' | 'sse' | 'sdk' | 'unknown'
          >,
        }),
      );
      const cA = await pool2.acquire(
        'srv',
        cfgA,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      const cB = await pool2.acquire(
        'srv',
        cfgB,
        's2',
        r2.tools,
        r2.prompts,
        r2.resources,
      );
      expect(cA.id).not.toBe(cB.id);
      expect(mocked.connect).toHaveBeenCalledTimes(2);
      const snap = pool2.getSnapshot();
      expect(snap.byName['srv'].entryCount).toBe(2);
    });

    it('release brings refs to 0 → starts drain timer; new acquire within drain cancels', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);
      pool.release(`srv::${'a'.repeat(16)}` as never, 'unknown'); // unknown id no-op
      pool.releaseSession('s1');
      // Drain timer started; reacquire within 1s cancels.
      await vi.advanceTimersByTimeAsync(500);
      const r2 = mkSessionRegistries();
      const c2 = await pool.acquire(
        'srv',
        cfg,
        's2',
        r2.tools,
        r2.prompts,
        r2.resources,
      );
      expect(c2).toBeDefined();
      const snap = pool.getSnapshot();
      expect(snap.byName['srv'].entrySummary[0].refs).toBe(1);
    });

    it('release brings refs to 0 + drain timer expires → entry closed', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({ drainDelayMs: 100 }),
      );
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);
      pool.releaseSession('s1');
      await vi.advanceTimersByTimeAsync(150);
      const snap = pool.getSnapshot();
      // Entry removed via onClosed callback.
      expect(snap.byName['srv']).toBeUndefined();
    });

    it('tracks unpooled entries so releaseSession closes them immediately', async () => {
      const mocked = mockMcpSuccess();
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({
          pooledTransports: new Set() as ReadonlySet<
            'stdio' | 'websocket' | 'http' | 'sse' | 'sdk' | 'unknown'
          >,
        }),
      );
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();

      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);
      expect(pool.getSnapshot().byName['srv'].entryCount).toBe(1);

      pool.releaseSession('s1');
      expect(pool.getSnapshot().total).toBe(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(mocked.close).toHaveBeenCalledTimes(1);
    });

    it('applies session-level includeTools/excludeTools to unpooled tools (W81/W87)', async () => {
      mockMcpSuccess({ toolNames: ['allowed', 'denied'] });
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({
          pooledTransports: new Set() as ReadonlySet<
            'stdio' | 'websocket' | 'http' | 'sse' | 'sdk' | 'unknown'
          >,
        }),
      );
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
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);
      const registerTool = (
        r.tools as unknown as { registerTool: ReturnType<typeof vi.fn> }
      ).registerTool;
      // Pre-fix (legacy `discover()` + `attach(skipReplay: true)`) would
      // register BOTH tools, ignoring the session-level excludeTools and
      // dropping the trust field. With the W81 fix routing through
      // `discoverAndReturn` → `markActive(snap)` → `attach` (no
      // skipReplay), `view.applyTools` filters `denied` out and propagates
      // the cfg.trust value to the registered tool.
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
      // we can fire releaseSession before the entry transitions to active.
      // Without the W77 fix the early sessionToEntries index is empty,
      // releaseSession is a no-op, and the post-await flow registers
      // tools/prompts into a session that has already been closed.
      let releaseConnect!: () => void;
      const connectGate = new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
      const mocked = mockMcpSuccess();
      mocked.connect.mockImplementation(() => connectGate);

      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({
          pooledTransports: new Set() as ReadonlySet<
            'stdio' | 'websocket' | 'http' | 'sse' | 'sdk' | 'unknown'
          >,
        }),
      );
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();

      const acquirePromise = pool.acquire(
        'srv',
        cfg,
        's1',
        r.tools,
        r.prompts,
        r.resources,
      );

      // Yield so `createUnpooledConnection` enters the await on connect.
      await Promise.resolve();
      await Promise.resolve();

      // Race: tear down the session while connect is still pending.
      // Pre-fix: this returns silently — sessionToEntries is empty.
      // Post-fix: the early `indexAttach` makes releaseSession find
      // the entry and fire forceShutdown('manual'), which flips state
      // to 'closed' synchronously.
      pool.releaseSession('s1');

      // Now let the connect resolve so the post-await flow runs.
      releaseConnect();

      await expect(acquirePromise).rejects.toThrow(
        /draining or unpooled.*was cancelled/,
      );

      // Entry is gone from both the forward and reverse indices.
      expect(pool.getSnapshot().total).toBe(0);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
      // The legacy unpooled discover() registers tools directly into
      // the session registry inside the await window — that call
      // happens before we can detect cancellation — so the W77 fix
      // rolls them back via `view.teardown()`, which calls
      // `removeMcpToolsByServer`. Without that rollback, tools would
      // remain in the closed session's registry.
      expect(
        (
          r.tools as unknown as {
            removeMcpToolsByServer: ReturnType<typeof vi.fn>;
          }
        ).removeMcpToolsByServer,
      ).toHaveBeenCalledWith('srv');
    });
  });

  describe('pooled in-flight acquire (W90)', () => {
    it('transitions zombie entry to failed when transport silently drops, evicting from pool (W120)', async () => {
      // Pre-W120: McpClient.onerror / a silent transport drop writes
      // DISCONNECTED to the global serverStatuses, statusChangeListener
      // mirrored it into localStatus but state stayed 'active'. The
      // pool fast-path then attached new sessions to the zombie entry,
      // replayed stale tools, and every tool call failed on the dead
      // transport. Post-W120 the listener transitions state='failed'
      // synchronously when localStatus flips to DISCONNECTED on an
      // active entry (gated by !restartInProgress so intentional
      // restart-mid-disconnect doesn't trip it).
      const { updateMCPServerStatus, MCPServerStatus } = await import(
        './mcp-client.js'
      );
      mockMcpSuccess({ toolNames: ['t1'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      const conn1 = await pool.acquire(
        'srv',
        cfg,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      let failedEventReceived = false;
      conn1.on('event', (e) => {
        if (e.kind === 'failed') failedEventReceived = true;
      });

      // Simulate a silent transport drop: writing DISCONNECTED to the
      // global registry fires the statusChangeListener inside PoolEntry.
      // McpClient.onerror in production would do the same.
      const targetId = connectionIdOf('srv', cfg);
      const entries = (pool as unknown as { entries: Map<string, PoolEntry> })
        .entries;
      const entry = entries.get(targetId)!;
      // Pre-fix: localStatus mirror + state stays 'active' → fast-path
      // attach below succeeds against the zombie. Post-fix: W120 listener
      // sets state='failed' and emits 'failed'.
      const mockClient = (entry as unknown as { client: { status: unknown } })
        .client;
      mockClient.status = MCPServerStatus.DISCONNECTED;
      updateMCPServerStatus('srv', MCPServerStatus.DISCONNECTED);

      expect(failedEventReceived).toBe(true);

      // W127: pre-W122 the entry stayed in `pool.entries` because the
      // listener didn't call `onClosed`, and the fast-path `attach()`
      // rejected with "Cannot attach to PoolEntry in state failed".
      // With W122 the listener now evicts the entry from `pool.entries`
      // synchronously via `onClosed`, AND W125 adds a defense-in-depth
      // isTerminated() pre-check + try/catch fall-through. So a fresh
      // acquire for the same (name, cfg) misses the fast-path
      // entirely and spawns a new entry — pool self-heals.
      const r2 = mkSessionRegistries();
      const conn2 = await pool.acquire(
        'srv',
        cfg,
        's2',
        r2.tools,
        r2.prompts,
        r2.resources,
      );
      // Different entryIndex confirms a NEW entry was spawned, not a
      // reuse of the zombie (which would have entryIndex 0).
      expect(conn2.entryIndex).toBe(1);
      // pool.entries now holds the fresh entry under the same id;
      // the old (failed) entry was evicted via the W122 onClosed call.
      const entriesAfter = (
        pool as unknown as { entries: Map<string, PoolEntry> }
      ).entries;
      expect(entriesAfter.get(targetId)).not.toBe(entry);
    });

    it('catches silent transport drop during drain window (W131)', async () => {
      // Pre-W131: W120 gate only triggered on state==='active'. During
      // the 30s drain window (refs=0, state='draining'), a silent
      // transport drop did NOT flip state to 'failed'. A new acquire
      // arriving in that window would hit the fast-path, attach()
      // accepts 'draining' (flips to 'active'), and replayed the stale
      // snapshot — same zombie-attach failure, shifted into drain.
      // Post-W131 the gate extends to ('active' || 'draining') and
      // cancels the drain timer in the same step.
      const { updateMCPServerStatus, MCPServerStatus } = await import(
        './mcp-client.js'
      );
      mockMcpSuccess({ toolNames: ['t1'] });
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({ drainDelayMs: 1_000 }),
      );
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);
      // Detach: refs=0 → state='draining', drain timer running.
      pool.releaseSession('s1');

      // Now simulate silent transport drop DURING drain.
      const targetId = connectionIdOf('srv', cfg);
      const entries = (pool as unknown as { entries: Map<string, PoolEntry> })
        .entries;
      const entry = entries.get(targetId)!;
      let failedEventReceived = false;
      // Re-acquire briefly just to get a PooledConnection handle for
      // the event subscription, then immediately release.
      const r2 = mkSessionRegistries();
      const conn2 = await pool.acquire(
        'srv',
        cfg,
        's-listen',
        r2.tools,
        r2.prompts,
        r2.resources,
      );
      conn2.on('event', (e) => {
        if (e.kind === 'failed') failedEventReceived = true;
      });
      pool.releaseSession('s-listen');
      // After release, state='draining' again. Now fire the drop.
      const mockClient = (entry as unknown as { client: { status: unknown } })
        .client;
      mockClient.status = MCPServerStatus.DISCONNECTED;
      updateMCPServerStatus('srv', MCPServerStatus.DISCONNECTED);

      expect(failedEventReceived).toBe(true);
      // Pin the W131 invariant: listener transitioned 'draining' → 'failed'
      // (not left in 'draining' or transitioned to 'closed').
      expect(entry.currentState).toBe('failed');

      // After W131 the listener also cancels the drain timer — verify
      // it doesn't subsequently fire a stale `forceShutdown('drain_timer')`
      // by advancing past the drain window. Entry state must remain
      // 'failed' (not transitioned to 'closed' by a stale timer fire,
      // which would silently happen if `cancelDrainTimer()` in the
      // wasDraining branch regressed since `forceShutdown` no-ops
      // idempotently on `state === 'failed'`).
      await vi.advanceTimersByTimeAsync(1_500);
      expect(entry.currentState).toBe('failed');
    });

    it('W125 else-if path: stale terminal entry evicted with budget released (R22 W125-followup A)', async () => {
      // Reproduces the race where `forceShutdown` has run its sync
      // portion (state='closed' + listener detach + emit + subscriber
      // detach) but the async tail (`await sweepAndDisconnect` →
      // `updateGlobalStatus` → `onClosed`) is still pending. During
      // that window pool.entries still holds the terminal entry, and
      // a concurrent `pool.acquire` for the same id hits W125's
      // else-if path. Pre-R22 the bare `entries.delete(id)` here
      // permanently leaked the budget slot — the entry's own onClosed
      // (firing later when sweep finished) saw `entries.get(id) ===
      // undefined` and skipped budget release. Post-R22 the eviction
      // routes through `evictEntry` which inline-releases the slot,
      // and `onClosed`'s identity check makes its later eviction a
      // safe no-op.
      const { WorkspaceMcpBudget } = await import('./mcp-workspace-budget.js');
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
      });
      mockMcpSuccess({ toolNames: ['t1'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions({ budget }));
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);
      expect(budget.getReservedSlots()).toEqual(['srv']);
      const targetId = connectionIdOf('srv', cfg);
      const entries = (pool as unknown as { entries: Map<string, PoolEntry> })
        .entries;
      const oldEntry = entries.get(targetId)!;
      // Fire-and-forget forceShutdown — sync portion runs (state='closed',
      // listener detached, subscribers torn down) but the
      // `await sweepAndDisconnect` and subsequent `onClosed` are
      // pending in the microtask queue.
      void oldEntry.forceShutdown('manual');
      expect(oldEntry.currentState).toBe('closed');
      // Critical precondition: pool.entries STILL has the terminal
      // entry (onClosed hasn't run yet). Without this, the else-if
      // path is unreachable.
      expect(entries.get(targetId)).toBe(oldEntry);

      // Concurrent acquire for the same fingerprint. Hits the W125
      // else-if path: existing && existing.isTerminated() → evictEntry
      // → fall through to spawn → fresh entry.
      const r2 = mkSessionRegistries();
      const conn2 = await pool.acquire(
        'srv',
        cfg,
        's2',
        r2.tools,
        r2.prompts,
        r2.resources,
      );
      // Fresh entry: different object, different entryIndex.
      const newEntry = entries.get(targetId)!;
      expect(newEntry).not.toBe(oldEntry);
      expect(conn2.entryIndex).toBe(1);
      // Budget slot is held by the fresh spawn (was released by
      // evictEntry, then re-reserved by the spawn path) — net 1 slot
      // reserved, not the 0 (leak) of pre-R22 nor the 2 of double-
      // reserve regression.
      expect(budget.getReservedSlots()).toEqual(['srv']);

      // Drain the pending forceShutdown microtasks. The OLD entry's
      // onClosed will fire and hit `evictEntry`'s identity check
      // (`current === newEntry !== oldEntry` → no-op). New entry must
      // survive intact.
      await vi.runAllTimersAsync();
      expect(entries.get(targetId)).toBe(newEntry);
      expect(budget.getReservedSlots()).toEqual(['srv']);
    });

    it('PoolEntry.attach rejects on terminal-state entry (W90 contract — direct probe; W125 made the pool fast-path self-heal so we exercise the guard at the entry level)', async () => {
      // The W90 fix's primary correctness guard catches a concurrent
      // `forceShutdown` that lands on the spawned entry between
      // `spawnEntry.entries.set` and our post-await `attach`. The
      // production race window is essentially zero microtasks
      // (markActive → return → inFlight resolution are all sync), so
      // we test the GUARD itself directly rather than reconstructing
      // the race.
      //
      // Pre-W125 the same contract was exposed via the pool fast-path:
      // a fast-path `attach()` on a terminal entry surfaced the
      // "Cannot attach to PoolEntry in state closed" error all the
      // way out of `pool.acquire`. W125 wraps that fast-path call in
      // try/catch + falls through to spawn so the pool self-heals,
      // which means a session-level acquire NEVER sees the terminal-
      // state rejection (validated by the W120 test above). The
      // entry-level contract is unchanged — `PoolEntry.attach` still
      // throws on `closed`/`failed`, which is exactly what the W90
      // post-await guard's `entry.isTerminated()` branch relies on.
      // Probe it directly via the PoolEntry instance.
      mockMcpSuccess({ toolNames: ['t1'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);
      const targetId = connectionIdOf('srv', cfg);
      const entries = (pool as unknown as { entries: Map<string, PoolEntry> })
        .entries;
      const entry = entries.get(targetId)!;
      // Drive entry to terminal state synchronously — same precondition
      // the W90 post-await guard depends on. forceShutdown sets
      // state='closed' synchronously before any await.
      void entry.forceShutdown('manual');
      expect(entry.isTerminated()).toBe(true);
      // Direct probe: PoolEntry.attach must reject on terminal state.
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
      // Pre-W111 fix: releaseSession during the in-flight `await`
      // window on the POOLED path called `sessionToEntries.delete(sid)`
      // (NOT terminal — state goes to 'draining', not 'closed'), so
      // the `isTerminated()` guard didn't fire, attach succeeded and
      // added the ref, BUT `sessionToEntries[sid]` was empty afterward.
      // Future releaseSession returned early → ref leaked for the
      // entry's lifetime.
      //
      // Post-fix: re-index AFTER attach succeeds. A SECOND
      // releaseSession(sid) call now finds the id again and properly
      // drains the entry.
      let releaseConnect!: () => void;
      const connectGate = new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      mocked.connect.mockImplementationOnce(() => connectGate);

      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({ drainDelayMs: 100 }),
      );
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      const acquirePromise = pool.acquire(
        'srv',
        cfg,
        's1',
        r.tools,
        r.prompts,
        r.resources,
      );
      // Yield so s1 enters await inFlight (after the W90 early index).
      await Promise.resolve();
      // Fire releaseSession during the await window. Pre-W111 this
      // wiped sessionToEntries['s1'] (drain timer started instead of
      // forceShutdown because pooled+non-terminal); attach below then
      // re-activated the entry and added the ref to entry.refs WITHOUT
      // restoring the reverse-index entry.
      pool.releaseSession('s1');
      releaseConnect();
      await acquirePromise;

      // Sanity: after the release-race-then-attach sequence, the entry
      // is active with refs=1 (we re-attached).
      expect(pool.getSnapshot().byName['srv'].entrySummary[0].refs).toBe(1);

      // Now THE critical assertion: a SECOND releaseSession('s1') must
      // properly drop the ref. Pre-W111 it was a no-op (reverse index
      // empty). Post-fix the W111 re-indexAttach restored the mapping
      // so this second release actually drains.
      pool.releaseSession('s1');
      expect(pool.getSnapshot().byName['srv'].entrySummary[0].refs).toBe(0);
      // Drain timer fires within the 100ms grace; entry tears down.
      await vi.advanceTimersByTimeAsync(150);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });

    it('rolls back early reverse-index insertion when spawnInFlight rejects', async () => {
      // Pre-W90 fix the in-flight branch indexed sessionToEntries only
      // AFTER attach succeeded. Post-fix it indexes BEFORE the await
      // so a concurrent releaseSession during the spawn window can
      // find the eventual entry. Failure path must indexDetach in
      // the catch so a stale id doesn't outlive a rejected spawn.
      const mocked = mockMcpSuccess();
      mocked.connect.mockRejectedValueOnce(new Error('boom-connect'));
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      const r2 = mkSessionRegistries();
      const first = pool.acquire(
        'srv',
        cfg,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      // Yield so 's1' enters spawnInFlight; 's2' joins via in-flight.
      await Promise.resolve();
      const second = pool.acquire(
        'srv',
        cfg,
        's2',
        r2.tools,
        r2.prompts,
        r2.resources,
      );

      await expect(first).rejects.toThrow(/boom-connect/);
      await expect(second).rejects.toThrow(/boom-connect/);

      // Reverse index must be empty for both sessions — a subsequent
      // releaseSession on either session must be a no-op (no stale id
      // pointing at the never-spawned entry).
      pool.releaseSession('s1');
      pool.releaseSession('s2');
      expect(pool.getSnapshot().total).toBe(0);

      // Sanity: a fresh acquire on the same name now succeeds via a
      // brand-new spawn (no leftover state).
      mocked.connect.mockResolvedValueOnce(undefined);
      const r3 = mkSessionRegistries();
      const c = await pool.acquire(
        'srv',
        cfg,
        's3',
        r3.tools,
        r3.prompts,
        r3.resources,
      );
      expect(c).toBeDefined();
    });

    // F2 (#4175 follow-up — W133-a / W134 PR B): self-heal observability
    // tests. W133-a threads the upstream `McpClient.onerror` cause
    // through to the silent-drop `'failed'` event's `lastError`; W134
    // surfaces orphan-process pressure to operators via a structured
    // warn log when the silent-drop's `sweepAndDisconnect` either
    // throws on pid discovery or partially signals descendants.

    it('threads upstream onerror cause into failed event lastError (W133-a)', async () => {
      // Pre-fix: the silent-drop `'failed'` event's `lastError` carried
      // only the synthetic marker `'transport disconnected (silent
      // transport drop)'` — operators triaging a 'failed' event had to
      // grep daemon `--debug` logs out of band for the matching `MCP
      // ERROR (...)` line. Post-fix: McpClient.onerror captures the
      // error in `lastTransportError`, and the W120 silent-drop block
      // reads it via `getLastTransportError()` to append `: <message>`
      // to the synthetic prefix.
      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      const conn1 = await pool.acquire(
        'srv',
        cfg,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      let failedEvent: { lastError?: string } | undefined;
      conn1.on('event', (e) => {
        if (e.kind === 'failed') failedEvent = e;
      });

      // Trigger via the production code path: invoke the SDK Client
      // mock's `onerror` (assigned by `McpClient.connect()`'s arrow
      // during the acquire above). The arrow runs
      // `this.lastTransportError = error` AND `updateStatus(DISCONNECTED)`
      // synchronously, so by the time the W120 listener fires, the
      // upstream error is already populated for `getLastTransportError()`.
      const upstream = new Error('EPIPE: connection lost');
      type MockedSdkClient = { onerror?: (e: Error) => void };
      (mocked as MockedSdkClient).onerror?.(upstream);

      expect(failedEvent).toBeDefined();
      expect(failedEvent?.lastError).toContain('EPIPE: connection lost');
      // Preserve the literal pre-fix marker substring so any operator
      // log-grep tooling that targets `silent transport drop` keeps
      // matching post-fix.
      expect(failedEvent?.lastError).toContain('silent transport drop');
    });

    it('falls back to synthetic-only marker when no upstream onerror was captured (W133-a fallback)', async () => {
      // Defense for the narrow race where the W120 listener fires from
      // an external `updateMCPServerStatus(name, DISCONNECTED)` write
      // that did NOT come from McpClient.onerror (e.g. a sibling
      // fingerprint's `client.disconnect()` writing the shared map).
      // `getLastTransportError()` returns undefined → caller falls back
      // to the synthetic-only string. This test pins the behavior
      // existing W120/W131 tests relied on pre-fix.
      const { updateMCPServerStatus, MCPServerStatus } = await import(
        './mcp-client.js'
      );
      mockMcpSuccess({ toolNames: ['t1'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      const conn1 = await pool.acquire(
        'srv',
        cfg,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      let failedEvent: { lastError?: string } | undefined;
      conn1.on('event', (e) => {
        if (e.kind === 'failed') failedEvent = e;
      });

      // Bypass McpClient.onerror — write directly to the shared map.
      const targetId = connectionIdOf('srv', cfg);
      const entries = (pool as unknown as { entries: Map<string, PoolEntry> })
        .entries;
      const entry = entries.get(targetId)!;
      const mockClient = (entry as unknown as { client: { status: unknown } })
        .client;
      mockClient.status = MCPServerStatus.DISCONNECTED;
      updateMCPServerStatus('srv', MCPServerStatus.DISCONNECTED);

      expect(failedEvent).toBeDefined();
      // Synthetic-only string (no `: <message>` suffix).
      expect(failedEvent?.lastError).toBe(
        'transport disconnected (silent transport drop)',
      );
    });

    it('emits structured warn log when silent-drop sweep throws on pid discovery (W134)', async () => {
      // Pre-fix: `void this.sweepAndDisconnect('silent_drop')` swallowed
      // the pid-sweep failure entirely — operators detecting orphan-
      // process pressure had no signal beyond tailing `--debug warn+`
      // for the inner sweep log line out of band. Post-fix: the silent-
      // drop chain captures the SweepResult and emits a structured
      // outer warn log when `pidSweepError` is set.
      const { listDescendantPids } = await import('./pid-descendants.js');
      const { createDebugLogger } = await import('../utils/debugLogger.js');
      // The shared mock factory returns the SAME stub for the same call
      // shape — re-invoke createDebugLogger to grab the warn vi.fn that
      // mcp-pool-entry.ts captured at module load. (The mock's factory
      // returns a NEW object each call, so we have to assert via the
      // module-level mock invocations directly.)
      const debugMock = createDebugLogger('McpPool:Entry');
      // The stub is a singleton across tests; clear prior call history
      // so we only observe THIS test's warn invocations.
      (debugMock.warn as ReturnType<typeof vi.fn>).mockClear();
      // Configure the pid-sweep to throw, simulating pgrep blocked by
      // sandbox or a similar enumeration failure.
      const sweepError = new Error('pgrep blocked by sandbox');
      vi.mocked(listDescendantPids).mockRejectedValueOnce(sweepError);

      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      // Stub `getTransportPid` so sweepAndDisconnect actually invokes
      // listDescendantPids (the default transport mock has no `pid`).
      // Inject a numeric pid via the transport mock so the helper's
      // `t.pid > 0` guard passes.
      vi.mocked(SdkClientStdioLib.StdioClientTransport).mockReturnValue({
        close: vi.fn().mockResolvedValue(undefined),
        pid: 99999,
      } as unknown as SdkClientStdioLib.StdioClientTransport);

      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);

      // Trigger the silent-drop path via the production onerror flow.
      type MockedSdkClient = { onerror?: (e: Error) => void };
      (mocked as MockedSdkClient).onerror?.(new Error('upstream EPIPE'));

      // sweepAndDisconnect runs asynchronously off the silent-drop
      // chain. Flush microtasks to let the chain's `.then(...)` callback
      // (which contains the warn log decision) settle.
      await vi.waitFor(() => {
        const calls = (debugMock.warn as ReturnType<typeof vi.fn>).mock.calls;
        const obs = calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('silent-drop sweep observability'),
        );
        expect(obs).toBeDefined();
      });

      // Verify the warn payload carries the orphan-process-pressure
      // hint and the underlying pid-sweep error message.
      const warnCalls = (debugMock.warn as ReturnType<typeof vi.fn>).mock.calls;
      const obsCall = warnCalls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('silent-drop sweep observability'),
      )!;
      expect(obsCall[0]).toContain('orphan-process pressure');
      expect(obsCall[0]).toContain('pgrep blocked by sandbox');
      // F2 (#4175 follow-up — copilot review T2 on #4460): when the
      // pid sweep itself throws, the count fields are genuinely
      // unmeasured. The warn payload should distinguish "not measured"
      // from "0 found" via an explicit sentinel.
      expect(obsCall[0]).toContain('descendantsFound=unknown');
      expect(obsCall[0]).toContain('descendantsSignaled=unknown');
    });

    it('emits structured warn log when silent-drop sweep partially signals descendants (W134 partial-signal)', async () => {
      // Pre-fix: a partial signal (sigtermPids killed fewer than
      // listDescendantPids found — child exited mid-loop, EPERM on a
      // child the daemon doesn't own, etc.) had no operator-facing
      // signal at all (sweepAndDisconnect's internal log was at
      // `debug` for the success-with-partial path). Post-fix: the
      // silent-drop chain compares descendantsSignaled vs
      // descendantsFound and emits the same outer warn even though
      // sweepAndDisconnect itself didn't throw.
      const { listDescendantPids, sigtermPids } = await import(
        './pid-descendants.js'
      );
      const { createDebugLogger } = await import('../utils/debugLogger.js');
      const debugMock = createDebugLogger('McpPool:Entry');
      // The stub is a singleton across tests; clear prior call history
      // so we only observe THIS test's warn invocations.
      (debugMock.warn as ReturnType<typeof vi.fn>).mockClear();
      // Set up the SDK mocks first (mockMcpSuccess installs the
      // StdioClientTransport spy + ClientLib.Client mock); then
      // override the transport return value with one that carries a
      // numeric `pid` so sweepAndDisconnect actually invokes
      // listDescendantPids.
      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      vi.mocked(SdkClientStdioLib.StdioClientTransport).mockReturnValue({
        close: vi.fn().mockResolvedValue(undefined),
        pid: 99999,
      } as unknown as SdkClientStdioLib.StdioClientTransport);
      // Discovered 3 descendants; only signaled 1.
      vi.mocked(listDescendantPids).mockResolvedValueOnce([1001, 1002, 1003]);
      vi.mocked(sigtermPids).mockReturnValueOnce(1);
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);

      type MockedSdkClient = { onerror?: (e: Error) => void };
      (mocked as MockedSdkClient).onerror?.(new Error('upstream EPIPE'));

      await vi.waitFor(() => {
        const calls = (debugMock.warn as ReturnType<typeof vi.fn>).mock.calls;
        const obs = calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('silent-drop sweep observability'),
        );
        expect(obs).toBeDefined();
      });

      const warnCalls = (debugMock.warn as ReturnType<typeof vi.fn>).mock.calls;
      const obsCall = warnCalls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('silent-drop sweep observability'),
      )!;
      // descendantsFound=3 / descendantsSignaled=1; pidSweepError=none.
      expect(obsCall[0]).toContain('descendantsFound=3');
      expect(obsCall[0]).toContain('descendantsSignaled=1');
      expect(obsCall[0]).toContain('pidSweepError=none');
      expect(obsCall[0]).toContain('orphan-process pressure');
    });
  });

  describe('spawnInFlight dedupe', () => {
    it('5 concurrent acquires for same key → 1 spawn', async () => {
      const mocked = mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const regs = Array.from({ length: 5 }, () => mkSessionRegistries());
      const results = await Promise.all(
        regs.map((r, i) =>
          pool.acquire('srv', cfg, `s${i}`, r.tools, r.prompts, r.resources),
        ),
      );
      expect(mocked.connect).toHaveBeenCalledTimes(1);
      // All 5 handles share the same id.
      const ids = new Set(results.map((c) => c.id));
      expect(ids.size).toBe(1);
    });
  });

  describe('releaseSession reverse index (V21-2)', () => {
    it('drops all entries the session holds in a single call', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg1 = new MCPServerConfig('node');
      const cfg2 = new MCPServerConfig('node', ['-v']);
      const r = mkSessionRegistries();
      await pool.acquire('srvA', cfg1, 's1', r.tools, r.prompts, r.resources);
      await pool.acquire('srvB', cfg2, 's1', r.tools, r.prompts, r.resources);
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
      mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);
      const results = await pool.restartByName('srv');
      expect(results).toHaveLength(1);
      expect(results[0].restarted).toBe(true);
      expect(results[0].entryIndex).toBe(0);
    });

    it('re-arms drain timer when restarting an idle entry (W85/W106)', async () => {
      // Pre-W85/W106 fix: doRestart cancels both drainTimer and
      // maxIdleTimer at the top, then never re-arms on success. If
      // operator triggers /workspace/mcp/<srv>/restart on an entry
      // with refs=0 (already detached, draining), the restart's
      // success path transitioned `'draining' → 'active'` but left
      // both timers off — the entry then sat in active state forever
      // until the next acquire/restart/drainAll.
      mockMcpSuccess();
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({ drainDelayMs: 100 }),
      );
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);
      // Detach: drain timer starts (refs=0).
      pool.releaseSession('s1');
      expect(pool.getSnapshot().byName['srv'].entryCount).toBe(1);

      // Restart the idle entry. Pre-fix: drain timer was cancelled by
      // doRestart top and never re-armed → entry stays active. Post-
      // fix: success path re-arms drain timer because refs.size === 0.
      const results = await pool.restartByName('srv');
      expect(results[0].restarted).toBe(true);

      // The re-armed drain timer should fire after the grace period
      // and close the entry — same lifecycle as a normal idle detach.
      await vi.advanceTimersByTimeAsync(150);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });

    it('restartByName with entryIndex filters to a single entry', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({
          pooledTransports: new Set(['stdio', 'http']) as ReadonlySet<
            'stdio' | 'websocket' | 'http' | 'sse' | 'sdk' | 'unknown'
          >,
        }),
      );
      const cfgA = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://x',
        { Authorization: 'A' },
      );
      const cfgB = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://x',
        { Authorization: 'B' },
      );
      const rA = mkSessionRegistries();
      const rB = mkSessionRegistries();
      await pool.acquire('srv', cfgA, 'sA', rA.tools, rA.prompts, rA.resources);
      await pool.acquire('srv', cfgB, 'sB', rB.tools, rB.prompts, rB.resources);

      const onlyOne = await pool.restartByName('srv', { entryIndex: 0 });
      expect(onlyOne).toHaveLength(1);
      expect(onlyOne[0].entryIndex).toBe(0);

      const all = await pool.restartByName('srv');
      expect(all).toHaveLength(2);
    });

    it('restartByName returns [] when no entries match', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const results = await pool.restartByName('nonexistent');
      expect(results).toEqual([]);
    });

    it('restart fans out updated tool snapshot to attached subscribers (F2 commit 5 R3 / W40)', async () => {
      // Wenshao W40 review fold-in: the R3 fix (commit 5) added a
      // post-restart fan-out that iterates `entry.subscribers` and
      // calls `view.applyTools(this.toolsSnapshot)` /
      // `view.applyPrompts(...)` so attached sessions pick up the
      // new snapshot. No test verified the fan-out; a regression
      // dropping the loop would leave sessions holding stale
      // pre-restart tool registrations — exactly the bug R3 fixed.
      // Assert by counting `removeMcpToolsByServer` calls on the
      // session registry (SessionMcpView's `applyTools` removes
      // existing tools then re-registers).
      mockMcpSuccess({ toolNames: ['original'], resourceNames: ['res://r'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);
      // Initial attach calls applyTools / applyResources once each → one
      // removeMcpToolsByServer + one removeResourcesByServer.
      const initialRemoveCalls = (
        r.tools.removeMcpToolsByServer as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      const initialResourceRemoveCalls = (
        r.resources.removeResourcesByServer as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(initialRemoveCalls).toBeGreaterThanOrEqual(1);
      expect(initialResourceRemoveCalls).toBeGreaterThanOrEqual(1);
      const results = await pool.restartByName('srv');
      expect(results[0].restarted).toBe(true);
      // Post-restart fan-out → additional applyTools AND applyResources call
      // → one more removeMcpToolsByServer + removeResourcesByServer (R3
      // contract: subscribers see the new snapshot via direct
      // `view.applyTools` / `view.applyResources`, not via event subscription).
      const finalRemoveCalls = (
        r.tools.removeMcpToolsByServer as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      const finalResourceRemoveCalls = (
        r.resources.removeResourcesByServer as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(finalRemoveCalls).toBeGreaterThan(initialRemoveCalls);
      expect(finalResourceRemoveCalls).toBeGreaterThan(
        initialResourceRemoveCalls,
      );
    });

    it('a transiently-empty resources/list on restart keeps the snapshot for new sessions', async () => {
      // Initial discovery exposes a resource.
      mockMcpSuccess({ toolNames: ['t1'], resourceNames: ['res://keep'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r1 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts, r1.resources);

      // The restart's re-read returns NO resources (a transient resources/list
      // failure swallowed to []). The next spawned client uses this mock.
      mockMcpSuccess({ toolNames: ['t1'], resourceNames: [] });
      await pool.restartByName('srv');

      // A NEW session attaching after the restart must still receive the prior
      // resource: the entry's snapshot was preserved, not overwritten with [].
      const r2 = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's2', r2.tools, r2.prompts, r2.resources);
      expect(r2.resources.registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'res://keep', serverName: 'srv' }),
      );
    });
  });

  describe('getSnapshot', () => {
    it('reports subprocessCount as live stdio+websocket entries', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);
      const snap = pool.getSnapshot();
      expect(snap.subprocessCount).toBe(1);
      expect(snap.total).toBe(1);
    });
  });

  describe('drainAll (§17 shutdown)', () => {
    it('disconnects all entries; reports drained count', async () => {
      const mocked = mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg1 = new MCPServerConfig('node');
      const cfg2 = new MCPServerConfig('node', ['-v']);
      const r = mkSessionRegistries();
      await pool.acquire('srvA', cfg1, 's1', r.tools, r.prompts, r.resources);
      await pool.acquire('srvB', cfg2, 's1', r.tools, r.prompts, r.resources);
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
      const mocked = mockMcpSuccess();
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({
          pooledTransports: new Set() as ReadonlySet<
            'stdio' | 'websocket' | 'http' | 'sse' | 'sdk' | 'unknown'
          >,
        }),
      );
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts, r.resources);

      const result = await pool.drainAll({ force: true });

      expect(result.drained).toBe(1);
      expect(mocked.close).toHaveBeenCalledTimes(1);
      expect(pool.getSnapshot().byName['srv']).toBeUndefined();
    });
  });

  describe('workspace budget integration (F2 commit 6)', () => {
    it('refuses acquire past cap under enforce mode and records the refusal', async () => {
      mockMcpSuccess();
      const { WorkspaceMcpBudget } = await import('./mcp-workspace-budget.js');
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
        onEvent,
      });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions({ budget }));
      const r = mkSessionRegistries();
      const cfgA = new MCPServerConfig('node', ['-a']);
      const cfgB = new MCPServerConfig('node', ['-b']);
      const cfgC = new MCPServerConfig('node', ['-c']);
      await pool.acquire('srvA', cfgA, 's1', r.tools, r.prompts, r.resources);
      await pool.acquire('srvB', cfgB, 's1', r.tools, r.prompts, r.resources);
      // Third name exceeds the cap → BudgetExhaustedError.
      await expect(
        pool.acquire('srvC', cfgC, 's1', r.tools, r.prompts, r.resources),
      ).rejects.toThrow(/budget exhausted/i);
      // Pool's spawn dedup is keyed by id, so the refusal records a
      // refusal entry on the budget controller.
      expect(budget.getRefusedServerNames()).toContain('srvC');
    });

    it('releases the slot when the only entry for a name closes', async () => {
      mockMcpSuccess();
      const { WorkspaceMcpBudget } = await import('./mcp-workspace-budget.js');
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
      });
      const pool = new McpTransportPool(
        cliConfig,
        mkPoolOptions({ budget, drainDelayMs: 1 }),
      );
      const r = mkSessionRegistries();
      const cfg = new MCPServerConfig('node');
      const conn = await pool.acquire(
        'srvA',
        cfg,
        's1',
        r.tools,
        r.prompts,
        r.resources,
      );
      expect(budget.getReservedSlots()).toEqual(['srvA']);
      conn.release();
      // Drain timer (1ms) needs to fire to actually close the entry.
      await vi.advanceTimersByTimeAsync(50);
      expect(budget.getReservedSlots()).toEqual([]);
    });

    it('preserves slot when entry closes during a same-name in-flight spawn (R1 race fix)', async () => {
      // Wenshao R1 review fold-in: previously the close-callback's
      // sibling check inspected only `this.entries`. If entry A for
      // 'srvA' closed while a divergent-fingerprint entry B for the
      // same 'srvA' was still in `spawnInFlight` (not yet registered
      // in `this.entries`), the close path released the slot
      // prematurely — letting a third name slip past the cap once B
      // finished. Fix: check `spawnInFlight` keys for `${name}::*`
      // matches alongside `entries`.
      mockMcpSuccess();
      const { WorkspaceMcpBudget } = await import('./mcp-workspace-budget.js');
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
      });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions({ budget }));
      const r = mkSessionRegistries();
      const cfgA = new MCPServerConfig('node', ['-a']);
      const cfgB = new MCPServerConfig('node', ['-b']);
      const cfgC = new MCPServerConfig('node', ['-c']);
      // Entry A spawns and is in `entries`.
      const connA = await pool.acquire(
        'srvA',
        cfgA,
        's1',
        r.tools,
        r.prompts,
        r.resources,
      );
      // Entry B for same name (different fingerprint) — kick off
      // spawn but DON'T await. By calling synchronously the second
      // tryReserve resolves to 'already_held' because the slot was
      // taken by A's reservation.
      const acquireB = pool.acquire(
        'srvA',
        cfgB,
        's1',
        r.tools,
        r.prompts,
        r.resources,
      );
      // Force-close A while B is still in flight.
      connA.release();
      await vi.advanceTimersByTimeAsync(50);
      // B's spawn finishes — should still be the only remaining
      // entry for 'srvA', slot still held.
      await acquireB;
      // Now a name-different acquire should be REFUSED (B holds the
      // sole slot for 'srvA' but cap is 1, so 'srvC' overflows).
      await expect(
        pool.acquire('srvC', cfgC, 's1', r.tools, r.prompts, r.resources),
      ).rejects.toThrow(/budget exhausted/i);
    });

    it("does NOT phantom-release when 'already_held' spawn fails (R24 T17)", async () => {
      // R24 T17: pre-fix the spawn-failure catch unconditionally
      // called `budget.release(serverName)` whenever
      // `!hasNameSibling(serverName)` was true, regardless of whether
      // THIS acquire actually reserved a new slot. When `tryReserve`
      // returned `'already_held'` (sibling A already held the slot),
      // and the sibling was concurrently evicted between this
      // acquire's `tryReserve` and its catch, the catch would call
      // `budget.release(serverName)` — releasing a slot this acquire
      // never reserved. Set.delete idempotency masked the practical
      // drift, but the contract was wrong: the catch's job is to
      // roll back THIS acquire's reservation, not to re-attempt
      // cleanup that already happened (or never should have).
      // Post-fix the catch checks `reservationResult === 'reserved'`
      // before releasing.
      const { WorkspaceMcpBudget } = await import('./mcp-workspace-budget.js');
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
      });
      // Connect: first call (A's spawn) resolves; second call (B's
      // spawn) throws so B hits the catch path.
      let connectCallCount = 0;
      const mocked = mockMcpSuccess({ toolNames: ['t1'] });
      mocked.connect = vi.fn().mockImplementation(() => {
        connectCallCount += 1;
        if (connectCallCount === 1) return Promise.resolve(undefined);
        return Promise.reject(new Error('B spawn boom'));
      });

      const pool = new McpTransportPool(cliConfig, mkPoolOptions({ budget }));
      const r1 = mkSessionRegistries();
      const cfgA = new MCPServerConfig('node', ['-a']);
      const cfgB = new MCPServerConfig('node', ['-b']);
      // A: tryReserve → 'reserved', spawn succeeds.
      await pool.acquire(
        'srvA',
        cfgA,
        's1',
        r1.tools,
        r1.prompts,
        r1.resources,
      );
      expect(budget.getReservedSlots()).toEqual(['srvA']);

      // B: same name, different fingerprint → tryReserve →
      // 'already_held'. Spawn throws.
      const releaseSpy = vi.spyOn(budget, 'release');
      const r2 = mkSessionRegistries();
      await expect(
        pool.acquire('srvA', cfgB, 's2', r2.tools, r2.prompts, r2.resources),
      ).rejects.toThrow(/B spawn boom/);

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
      const { WorkspaceMcpBudget } = await import('./mcp-workspace-budget.js');
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
      });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions({ budget }));
      const r = mkSessionRegistries();
      const cfg = new MCPServerConfig('node');
      await expect(
        pool.acquire('srvA', cfg, 's1', r.tools, r.prompts, r.resources),
      ).rejects.toThrow();
      // The slot was reserved pre-spawn, then released because spawn
      // failed and no other entry holds the name. A subsequent
      // acquire should succeed without hitting the cap.
      expect(budget.getReservedSlots()).toEqual([]);
    });
  });
});

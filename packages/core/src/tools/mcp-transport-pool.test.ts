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
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  McpTransportPool,
  type McpTransportPoolOptions,
} from './mcp-transport-pool.js';
import type { ToolRegistry } from './tool-registry.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js');
vi.mock('@modelcontextprotocol/sdk/client/stdio.js');
vi.mock('@google/genai');

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
  } = {},
) {
  const tools = opts.toolNames ?? ['t1'];
  const prompts = opts.promptNames ?? [];
  const mockedClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    registerCapabilities: vi.fn(),
    setRequestHandler: vi.fn(),
    getServerCapabilities: vi
      .fn()
      .mockReturnValue(prompts.length > 0 ? { prompts: {} } : {}),
    request: vi.fn().mockResolvedValue({
      prompts: prompts.map((name) => ({ name, description: 'p' })),
    }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
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
      const c1 = await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts);
      const r2 = mkSessionRegistries();
      const c2 = await pool.acquire('srv', cfg, 's2', r2.tools, r2.prompts);
      const r3 = mkSessionRegistries();
      const c3 = await pool.acquire('srv', cfg, 's3', r3.tools, r3.prompts);

      expect(mocked.connect).toHaveBeenCalledTimes(1);
      expect(c1.id).toBe(c2.id);
      expect(c2.id).toBe(c3.id);
      // All three sessions appear in the pool snapshot for the entry.
      const snap = pool.getSnapshot();
      expect(snap.byName['srv'].entryCount).toBe(1);
      expect(snap.byName['srv'].entrySummary[0].refs).toBe(3);
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
      const cA = await pool2.acquire('srv', cfgA, 's1', r1.tools, r1.prompts);
      const cB = await pool2.acquire('srv', cfgB, 's2', r2.tools, r2.prompts);
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
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts);
      pool.release(`srv::${'a'.repeat(16)}` as never, 'unknown'); // unknown id no-op
      pool.releaseSession('s1');
      // Drain timer started; reacquire within 1s cancels.
      await vi.advanceTimersByTimeAsync(500);
      const r2 = mkSessionRegistries();
      const c2 = await pool.acquire('srv', cfg, 's2', r2.tools, r2.prompts);
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
      await pool.acquire('srv', cfg, 's1', r1.tools, r1.prompts);
      pool.releaseSession('s1');
      await vi.advanceTimersByTimeAsync(150);
      const snap = pool.getSnapshot();
      // Entry removed via onClosed callback.
      expect(snap.byName['srv']).toBeUndefined();
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
          pool.acquire('srv', cfg, `s${i}`, r.tools, r.prompts),
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
      await pool.acquire('srvA', cfg1, 's1', r.tools, r.prompts);
      await pool.acquire('srvB', cfg2, 's1', r.tools, r.prompts);
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
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts);
      const results = await pool.restartByName('srv');
      expect(results).toHaveLength(1);
      expect(results[0].restarted).toBe(true);
      expect(results[0].entryIndex).toBe(0);
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
      await pool.acquire('srv', cfgA, 'sA', rA.tools, rA.prompts);
      await pool.acquire('srv', cfgB, 'sB', rB.tools, rB.prompts);

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
      mockMcpSuccess({ toolNames: ['original'] });
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts);
      // Initial attach calls applyTools once → one removeMcpToolsByServer.
      const initialRemoveCalls = (
        r.tools.removeMcpToolsByServer as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(initialRemoveCalls).toBeGreaterThanOrEqual(1);
      const results = await pool.restartByName('srv');
      expect(results[0].restarted).toBe(true);
      // Post-restart fan-out → additional applyTools call → one more
      // removeMcpToolsByServer (R3 contract: subscribers see the new
      // snapshot via direct `view.applyTools` invocation, not via
      // event subscription).
      const finalRemoveCalls = (
        r.tools.removeMcpToolsByServer as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(finalRemoveCalls).toBeGreaterThan(initialRemoveCalls);
    });
  });

  describe('getSnapshot', () => {
    it('reports subprocessCount as live stdio+websocket entries', async () => {
      mockMcpSuccess();
      const pool = new McpTransportPool(cliConfig, mkPoolOptions());
      const cfg = new MCPServerConfig('node');
      const r = mkSessionRegistries();
      await pool.acquire('srv', cfg, 's1', r.tools, r.prompts);
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
      await pool.acquire('srvA', cfg1, 's1', r.tools, r.prompts);
      await pool.acquire('srvB', cfg2, 's1', r.tools, r.prompts);
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
      await pool.acquire('srvA', cfgA, 's1', r.tools, r.prompts);
      await pool.acquire('srvB', cfgB, 's1', r.tools, r.prompts);
      // Third name exceeds the cap → BudgetExhaustedError.
      await expect(
        pool.acquire('srvC', cfgC, 's1', r.tools, r.prompts),
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
      const conn = await pool.acquire('srvA', cfg, 's1', r.tools, r.prompts);
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
      const connA = await pool.acquire('srvA', cfgA, 's1', r.tools, r.prompts);
      // Entry B for same name (different fingerprint) — kick off
      // spawn but DON'T await. By calling synchronously the second
      // tryReserve resolves to 'already_held' because the slot was
      // taken by A's reservation.
      const acquireB = pool.acquire('srvA', cfgB, 's1', r.tools, r.prompts);
      // Force-close A while B is still in flight.
      connA.release();
      await vi.advanceTimersByTimeAsync(50);
      // B's spawn finishes — should still be the only remaining
      // entry for 'srvA', slot still held.
      await acquireB;
      // Now a name-different acquire should be REFUSED (B holds the
      // sole slot for 'srvA' but cap is 1, so 'srvC' overflows).
      await expect(
        pool.acquire('srvC', cfgC, 's1', r.tools, r.prompts),
      ).rejects.toThrow(/budget exhausted/i);
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
        pool.acquire('srvA', cfg, 's1', r.tools, r.prompts),
      ).rejects.toThrow();
      // The slot was reserved pre-spawn, then released because spawn
      // failed and no other entry holds the name. A subsequent
      // acquire should succeed without hitting the cap.
      expect(budget.getReservedSlots()).toEqual([]);
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, MCPServerConfig } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  MCPServerStatus,
  McpClient,
  type SendSdkMcpMessage,
} from './mcp-client.js';
import {
  defaultPoolEntryOptions,
  PoolEntry,
  type PooledConnection,
  type PoolEntryOptions,
} from './mcp-pool-entry.js';
import { type ConnectionId } from './mcp-pool-events.js';
import {
  connectionIdOf,
  isPoolable,
  mcpTransportOf,
  parseConnectionId,
  POOLED_TRANSPORTS_DEFAULT,
  type McpTransportKind,
} from './mcp-pool-key.js';
import { SessionMcpView } from './session-mcp-view.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ToolRegistry } from './tool-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { WorkspaceMcpBudget } from './mcp-workspace-budget.js';
import {
  discoveryTimeoutFor,
  runWithTimeout,
} from './mcp-discovery-timeout.js';
// F2 (#4175 commit 6): same `BudgetExhaustedError` thrown by the
// per-session McpClientManager, re-used at the pool's acquire site
// so SDK consumers see the same error class regardless of which path
// (manager or pool) actually enforced the cap.
import { BudgetExhaustedError } from './mcp-client-manager.js';

const debugLogger = createDebugLogger('McpPool');

/**
 * Pool-wide configuration. Caller (typically `QwenAgent` in daemon
 * mode) supplies these from CLI flags + env vars.
 *
 * Per-entry tuning (drain, max idle, reconnect strategy) is resolved
 * from `defaultPoolEntryOptions(transport)` at entry creation; future
 * iterations may surface override knobs here.
 */
export interface McpTransportPoolOptions {
  /** Daemon-bound workspace context shared by all entries (single registration). */
  workspaceContext: WorkspaceContext;
  /** Debug logging flag forwarded to McpClient. */
  debugMode: boolean;
  /** SDK MCP message callback; per-session at the caller level — pool bypasses SDK MCP. */
  sendSdkMcpMessage?: SendSdkMcpMessage;
  /** Set of transport families that should share pool entries. Default {stdio, websocket}. */
  pooledTransports?: ReadonlySet<McpTransportKind>;
  /** Override drain grace (default 30s). */
  drainDelayMs?: number;
  /** Override per-entry options (rare; usually defaults are sufficient). */
  entryOptions?: (transport: McpTransportKind) => PoolEntryOptions;
  /**
   * F2 (#4175 commit 6): optional workspace-scoped budget controller.
   * When present, pool's `acquire` consults `tryReserve` pre-spawn
   * (refused → `BudgetExhaustedError` after `recordRefusal`) and
   * pool releases the slot when an entry transitions to `closed`
   * with no sibling entry sharing the same `serverName`. Absent →
   * pool runs unbounded (the per-session `McpClientManager`'s budget
   * machinery is dormant in pool mode anyway, so absent here means
   * "no enforcement at all" — operators get this when
   * `--mcp-client-budget` was not configured).
   */
  budget?: WorkspaceMcpBudget;
}

/**
 * Workspace-scoped shared MCP transport pool.
 *
 * F2 (#4175) core: N ACP sessions on one daemon share one transport
 * per unique (serverName + fingerprint) tuple, instead of each
 * spawning their own MCP child process.
 *
 * See `docs/design/f2-mcp-transport-pool.md` for the full design.
 * Key public methods:
 *   - `acquire(name, cfg, sessionId)` — get or spawn entry, return handle
 *   - `release(id, sessionId)` — drop one reference; pool starts drain at refs=0
 *   - `releaseSession(sessionId)` — bulk release all entries this session holds (uses reverse index, O(refs))
 *   - `restartByName(name, opts?)` — restart all entries (or one via entryIndex)
 *   - `drainAll(opts?)` — graceful + timeout-bounded shutdown for daemon close
 *
 * Lifecycle invariants:
 *   - Entries are eager: first `acquire` for a key spawns; subsequent acquires reuse
 *   - `spawnInFlight` dedupes concurrent acquires for the same key
 *   - Spawn failure releases the reserved budget slot (V21-4)
 *   - Drain timer cancelled on attach; restarted on last detach
 *   - `MAX_IDLE_MS` (5min default) hard cap survives drain/attach flap
 *   - Global `serverStatuses` Map written via aggregated status function (§8.1)
 */
export class McpTransportPool {
  private readonly entries = new Map<ConnectionId, PoolEntry>();
  private readonly unpooledIds = new Set<ConnectionId>();
  private readonly spawnInFlight = new Map<ConnectionId, Promise<PoolEntry>>();
  /** V21-2: reverse index for O(refs) `releaseSession`. */
  private readonly sessionToEntries = new Map<string, Set<ConnectionId>>();
  /**
   * Drain mutex (wenshao C5): when `drainAll` is in progress, new
   * acquires reject so they don't latch onto entries that are about
   * to be force-closed. Cleared by `drainAll` only on successful
   * teardown — once set, a fresh pool is required for further work.
   */
  private draining = false;
  /**
   * Monotonic per-server-name index for `entryIndex` (V21-7). Each
   * new entry for a name gets `nextIndexByName.get(name)++`; old
   * entries keep their assigned index even after newer ones appear
   * (so dashboards don't shuffle).
   */
  private readonly nextIndexByName = new Map<string, number>();
  private readonly opts: Required<
    Omit<McpTransportPoolOptions, 'sendSdkMcpMessage' | 'budget'>
  > & {
    sendSdkMcpMessage?: SendSdkMcpMessage;
    budget?: WorkspaceMcpBudget;
  };

  /**
   * @param cliConfig Daemon's bootstrap-session Config; used to call
   *   `client.discoverAndReturn(cliConfig)` during entry init. Per-
   *   session filtering / trust decoration happens later via
   *   `SessionMcpView`, not via this cliConfig.
   */
  constructor(
    private readonly cliConfig: Config,
    options: McpTransportPoolOptions,
  ) {
    this.opts = {
      workspaceContext: options.workspaceContext,
      debugMode: options.debugMode,
      sendSdkMcpMessage: options.sendSdkMcpMessage,
      pooledTransports: options.pooledTransports ?? POOLED_TRANSPORTS_DEFAULT,
      drainDelayMs: options.drainDelayMs ?? 30_000,
      entryOptions: options.entryOptions ?? defaultPoolEntryOptions,
      budget: options.budget,
    };
  }

  /**
   * F2 (#4175 commit 6): expose the budget controller for snapshot
   * builders + status routes. Returns `undefined` when no budget was
   * configured at boot (operator omitted `--mcp-client-budget`).
   */
  getBudget(): WorkspaceMcpBudget | undefined {
    return this.opts.budget;
  }

  /**
   * Check whether any pool entry (live OR currently spawning) shares
   * the given `serverName`. Used by the close-callback and spawn-
   * failure rollback to decide whether the budget slot for `name`
   * should still be held — slot ownership is per-NAME, so the slot
   * stays reserved as long as at least one entry / spawn for the
   * name exists.
   *
   * `spawnInFlight` keys have the form `${name}::${fingerprint}`.
   * Wenshao W21 review fix: pre-fix used `startsWith(`${name}::`)`
   * which produced a false positive when a sibling name BEGAN with
   * `${name}::` (server names can contain `::` per
   * `mcp-pool-key.test.ts:258`; `parseConnectionId` uses
   * `lastIndexOf('::')` precisely to split on the LAST occurrence).
   * `connectionIdOf` is just string concatenation — zero
   * sanitization. Now: parse each id with `parseConnectionId` and
   * compare the extracted `serverName` exactly. Malformed ids
   * (defensive) are skipped so a stray bad key in `spawnInFlight`
   * can't crash the rollback path.
   */
  private hasNameSibling(serverName: string): boolean {
    for (const e of this.entries.values()) {
      if (e.serverName === serverName) return true;
    }
    for (const id of this.spawnInFlight.keys()) {
      try {
        if (parseConnectionId(id).serverName === serverName) return true;
      } catch {
        // Malformed id — skip rather than crash the rollback path.
      }
    }
    return false;
  }

  /**
   * Acquire a pooled (or unpooled, if `cfg` is not poolable) connection
   * for `sessionId`. Returns the connection handle; caller should call
   * `pool.release(handle.id, sessionId)` when done.
   *
   * Concurrent acquires for the same `(name, cfg)` are deduped via
   * `spawnInFlight` so only one transport is created.
   *
   * @param sessionToolRegistry The acquiring session's ToolRegistry;
   *   passed to `SessionMcpView` so filtered tool snapshots register
   *   into THIS session, not the pool's shared state.
   * @param sessionPromptRegistry Same for prompts.
   */
  async acquire(
    serverName: string,
    cfg: MCPServerConfig,
    sessionId: string,
    sessionToolRegistry: ToolRegistry,
    sessionPromptRegistry: PromptRegistry,
  ): Promise<PooledConnection> {
    if (this.draining) {
      throw new Error(
        `McpTransportPool is draining; refusing acquire for ${serverName} (session ${sessionId})`,
      );
    }

    // For pooled transports, fast-path attach to an existing entry
    // — that entry's prior reservation already covers the slot, no
    // new tryReserve needed.
    const poolable = isPoolable(cfg, this.opts.pooledTransports);
    const id = poolable ? connectionIdOf(serverName, cfg) : undefined;
    if (id !== undefined) {
      const existing = this.entries.get(id);
      if (existing) {
        const view = new SessionMcpView(
          sessionToolRegistry,
          sessionPromptRegistry,
          sessionId,
          serverName,
          cfg,
        );
        // F2 (#4175 commit 6 review fix — wenshao W10): index update
        // happens AFTER `attach` succeeds. Pre-fix the order was
        // reversed; an `attach` rejection (e.g., entry transitioned
        // to `closed`/`failed` between the `entries.get` check and the
        // `attach` call) left a stale `sessionToEntries[sessionId]`
        // mapping with no matching `entry.refs.has(sessionId)` —
        // `releaseSession` would later iterate the stale id and call
        // `entry.detach` on a non-attached session.
        const conn = existing.attach(sessionId, view, {
          release: () => this.release(id, sessionId),
        });
        this.indexAttach(sessionId, id);
        return conn;
      }
    }

    // Below this point we're committed to creating a NEW connection
    // (pooled spawn OR unpooled). Apply the workspace budget check
    // by NAME — divergent fingerprints for the same name share one
    // slot (matches PR 14 v1's "configured server slots" semantic).
    //
    // F2 (#4175 commit 6 review fix — wenshao W65): pre-fix the
    // budget check ran AFTER the `!isPoolable` early-return, so
    // unpooled HTTP/SSE/SDK-MCP connections bypassed enforcement
    // entirely (`--mcp-client-budget=2` would let 3 HTTP MCP servers
    // connect without refusal). Now the check applies uniformly to
    // both branches; refusal under enforce mode throws
    // BudgetExhaustedError so the caller's catch translates to
    // `refused_batch` in the snapshot.
    if (this.opts.budget !== undefined) {
      const reservation = this.opts.budget.tryReserve(serverName);
      if (reservation === 'refused') {
        const transport = mcpTransportOf(cfg);
        this.opts.budget.recordRefusal(serverName, transport);
        throw new BudgetExhaustedError(
          serverName,
          this.opts.budget.getBudget() ?? 0,
          this.opts.budget.getReservedCount(),
        );
      }
      // 'reserved' or 'already_held' both proceed — `already_held`
      // means same-name divergent-fingerprint or a reconnect-after-
      // drain. Either way no slot is newly consumed.
    }

    // SDK MCP / non-pooled HTTP go through the per-session bypass.
    if (!poolable) {
      try {
        return await this.createUnpooledConnection(
          serverName,
          cfg,
          sessionId,
          sessionToolRegistry,
          sessionPromptRegistry,
        );
      } catch (err) {
        if (
          this.opts.budget !== undefined &&
          !this.hasNameSibling(serverName)
        ) {
          this.opts.budget.release(serverName);
        }
        throw err;
      }
    }

    // From here on poolable === true → id !== undefined (TS doesn't
    // narrow the local across the early-returns above, so re-narrow
    // explicitly via a type predicate). Throwing is unreachable; the
    // assertion documents the invariant for the spawn-in-flight block.
    if (id === undefined) {
      throw new Error('unreachable: poolable && id === undefined');
    }
    // In-flight path: another acquire for the same key is already
    // spawning the entry. Await its completion, then attach.
    let inFlight = this.spawnInFlight.get(id);
    if (!inFlight) {
      const spawnPromise = this.spawnEntry(serverName, cfg, id);
      // Order of cleanup matters: `finally` removes the in-flight
      // promise from `spawnInFlight` BEFORE the catch block runs the
      // budget rollback, so `hasNameSibling` (which inspects
      // `spawnInFlight.keys`) sees the post-cleanup state. Wenshao R1
      // race-fix: previously the rollback only checked `this.entries`
      // and a sibling entry could prematurely keep the slot reserved
      // even when this rollback should have released it.
      inFlight = spawnPromise
        .finally(() => {
          this.spawnInFlight.delete(id);
        })
        .catch((err) => {
          // F2 (#4175 commit 6): roll back the slot reservation on
          // spawn failure (V21-4) so a transient connect failure
          // doesn't leak the slot until daemon restart.
          if (this.opts.budget !== undefined) {
            if (!this.hasNameSibling(serverName)) {
              this.opts.budget.release(serverName);
            }
          }
          throw err;
        });
      this.spawnInFlight.set(id, inFlight);
    }
    const entry = await inFlight;

    const view = new SessionMcpView(
      sessionToolRegistry,
      sessionPromptRegistry,
      sessionId,
      serverName,
      cfg,
    );
    // W10 fix: same attach-then-index ordering as the fast path above.
    const conn = entry.attach(sessionId, view, {
      release: () => this.release(id, sessionId),
    });
    this.indexAttach(sessionId, id);
    return conn;
  }

  /**
   * Drop one session's reference to a connection. Starts the drain
   * grace timer if this was the last reference.
   *
   * Idempotent on unknown id (e.g. entry already closed via restart
   * or shutdown).
   */
  release(id: ConnectionId, sessionId: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.detach(sessionId);
    this.indexDetach(sessionId, id);
    if (entry.refs.size === 0) {
      if (this.unpooledIds.has(id)) {
        void entry.forceShutdown('manual');
        return;
      }
      entry.startDrainTimer(this.opts.drainDelayMs);
    }
  }

  /**
   * Bulk release all entries `sessionId` currently holds. O(refs of
   * this session) via the reverse index (V21-2). Use this from
   * `acpAgent.killSession` to ensure no leaked refs.
   */
  releaseSession(sessionId: string): void {
    const ids = this.sessionToEntries.get(sessionId);
    if (!ids) return;
    // Snapshot the set since detach mutates state.
    const idList = [...ids];
    for (const id of idList) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.detach(sessionId);
      if (entry.refs.size === 0) {
        if (this.unpooledIds.has(id)) {
          void entry.forceShutdown('manual');
          continue;
        }
        entry.startDrainTimer(this.opts.drainDelayMs);
      }
    }
    this.sessionToEntries.delete(sessionId);
  }

  /**
   * Restart all pool entries matching `serverName`, or just the one
   * with `entryIndex` if specified (V21-3). Runs in parallel via
   * `Promise.all` with per-entry try/catch (rejections never escape);
   * returns per-entry results so the caller can surface per-entry
   * success/failure (§13.1 restart route). W36 doc fix: previous
   * docstring named `Promise.allSettled`, but the implementation
   * actually uses `Promise.all` — the per-entry try/catch makes
   * Promise.all safe but the docstring was misleading.
   */
  async restartByName(
    serverName: string,
    opts?: { entryIndex?: number },
  ): Promise<
    Array<{
      entryIndex: number;
      restarted: boolean;
      durationMs?: number;
      reason?: string;
    }>
  > {
    // F2 (#4175 commit 6 review fix — wenshao W68): defense-in-depth
    // gate matching `acquire()`'s `draining` check. Pre-fix
    // `restartByName` could call `entry.restart()` mid-`drainAll()`,
    // spawning a fresh subprocess via `client.connect()` that
    // wasn't in the entry snapshot drainAll captured — leak path.
    if (this.draining) return [];
    const matching = [...this.entries.values()].filter(
      (e) =>
        e.serverName === serverName &&
        (opts?.entryIndex === undefined || e.entryIndex === opts.entryIndex),
    );
    if (matching.length === 0) return [];
    return Promise.all(
      matching.map(async (entry) => {
        const started = Date.now();
        try {
          await entry.restart();
          return {
            entryIndex: entry.entryIndex,
            restarted: true,
            durationMs: Date.now() - started,
          };
        } catch (err) {
          return {
            entryIndex: entry.entryIndex,
            restarted: false,
            reason: String(err instanceof Error ? err.message : err),
          };
        }
      }),
    );
  }

  // F2 (#4175 commit 6 review fix — wenshao W67): the pool-level
  // `onEntryEvent(id, listener)` subscriber API was removed since
  // it had zero callers — F4 (status stream route) was supposed to
  // consume it but isn't shipping in this PR. Sessions still
  // subscribe to entry events via `PooledConnection.on('event', ...)`
  // (used by `McpClientManager` for the `'failed'` evict path);
  // re-introduce the pool-level `onEntryEvent` API alongside its
  // first concrete F4 consumer.

  /**
   * Snapshot the pool's current state for the daemon's
   * `GET /workspace/mcp` status route. Returns a plain object so the
   * caller can serialize directly.
   *
   * `entryCount` per server name + `entrySummary` array (V21-7
   * opaque `entryIndex`, NOT raw fingerprint) for multi-entry name
   * collisions.
   */
  getSnapshot(): McpPoolSnapshot {
    const byName = new Map<
      string,
      {
        entryCount: number;
        entrySummary: Array<{
          entryIndex: number;
          refs: number;
          status: MCPServerStatus;
        }>;
      }
    >();
    let total = 0;
    let subprocessCount = 0;
    for (const entry of this.entries.values()) {
      const status = entry.getLocalStatus();
      if (status === MCPServerStatus.CONNECTED) {
        total += 1;
        // F2 (#4175 commit 5 review fix — wenshao R4 + R6): only
        // count `stdio` toward `subprocessCount`. Websocket transports
        // dial a (potentially remote) MCP server over the network and
        // don't spawn a local OS child — including them inflates the
        // subprocess metric and misleads operators doing capacity
        // planning. Read transport via the new `entry.transportKind`
        // getter so `entry.cfg` (carrying secrets) stays encapsulated.
        if (entry.transportKind === 'stdio') {
          subprocessCount += 1;
        }
      }
      const row = byName.get(entry.serverName) ?? {
        entryCount: 0,
        entrySummary: [],
      };
      row.entryCount += 1;
      row.entrySummary.push({
        entryIndex: entry.entryIndex,
        refs: entry.refs.size,
        status,
      });
      byName.set(entry.serverName, row);
    }
    return {
      total,
      subprocessCount,
      byName: Object.fromEntries(byName.entries()),
    };
  }

  /**
   * Aggregate the local statuses of all entries that share `name`,
   * collapsing to a single MCPServerStatus per the "any-CONNECTED
   * wins" rule (§8.1). Called by individual `PoolEntry` instances
   * via the callback wired in their constructor.
   */
  aggregateStatusByName(serverName: string): MCPServerStatus {
    let sawConnecting = false;
    for (const entry of this.entries.values()) {
      if (entry.serverName !== serverName) continue;
      const s = entry.getLocalStatus();
      if (s === MCPServerStatus.CONNECTED) return MCPServerStatus.CONNECTED;
      if (s === MCPServerStatus.CONNECTING) sawConnecting = true;
    }
    return sawConnecting
      ? MCPServerStatus.CONNECTING
      : MCPServerStatus.DISCONNECTED;
  }

  /**
   * Graceful (or force) shutdown of all entries. Used by `QwenAgent.close`.
   *
   * Returns `DrainResult` with counts for shutdown logging. Wall-clock
   * bounded by `timeoutMs` (default 10s); entries that fail to close
   * within budget are reported in `errors` and the pool nevertheless
   * clears its maps (caller is exiting the process).
   */
  async drainAll(opts?: {
    force?: boolean;
    timeoutMs?: number;
  }): Promise<DrainResult> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const force = opts?.force ?? false;

    // F2 (#4175 commit 4 review fix — wenshao C5): block new
    // acquires for the duration of drain. After this flag flips,
    // `acquire` rejects with a "draining" error so a session
    // attempting to attach mid-drain doesn't end up holding a handle
    // to an entry that's about to be force-closed.
    this.draining = true;
    const deadline = Date.now() + timeoutMs;

    // Wait for in-flight spawn promises to settle BEFORE taking the
    // entry snapshot, so a spawn that's about to call
    // `this.entries.set(id, entry)` doesn't sneak past `entries.clear()`
    // and leak. `Promise.allSettled` tolerates spawn rejection (the
    // failed entry simply won't appear in `this.entries`).
    //
    // F2 (#4175 commit 6 review fix — gpt-5.5 W73): the
    // `Promise.allSettled` wait was previously UNBOUNDED — a spawn
    // with a large `discoveryTimeoutMs` override (or a stuck spawn
    // running its own 30s default) would block daemon shutdown for
    // the full discovery timeout BEFORE `drainAll`'s 8-10s budget
    // even began, defeating the caller's shutdown deadline. Now the
    // in-flight wait races against the SAME `timeoutMs` budget; if
    // it doesn't settle, we proceed with whatever entries are
    // already in `this.entries` (the rest will be force-closed via
    // `clear()` below). Per-spawn timeouts (W25) bound individual
    // spawns; the race here is the safety net for misconfigured
    // overrides.
    if (this.spawnInFlight.size > 0) {
      const spawnWait = Promise.allSettled([...this.spawnInFlight.values()]);
      let inflightTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        spawnWait.then(() => {
          if (inflightTimer) clearTimeout(inflightTimer);
        }),
        new Promise<void>((resolve) => {
          inflightTimer = setTimeout(
            () => {
              const stuckIds = [...this.spawnInFlight.keys()];
              debugLogger.warn(
                `drainAll: spawnInFlight wait timed out after ${timeoutMs}ms; ` +
                  `${stuckIds.length} spawn(s) still in-flight: ${stuckIds.join(
                    ', ',
                  )}. Proceeding with drain.`,
              );
              resolve();
            },
            Math.max(0, deadline - Date.now()),
          );
          inflightTimer.unref?.();
        }),
      ]);
    }
    // Snapshot AFTER spawnInFlight settles (or timed out) so any
    // entry that just got `entries.set` from a completing spawn is
    // in the list.
    const entries = [...this.entries.values()];
    const drained: number[] = [];
    const errors: Array<{
      entryIndex: number;
      serverName: string;
      error: string;
    }> = [];
    const shutdownPromises = entries.map((entry) =>
      entry
        .forceShutdown(force ? 'manual' : 'drain_timer')
        .then(() => drained.push(entry.entryIndex))
        .catch((err: unknown) => {
          errors.push({
            entryIndex: entry.entryIndex,
            serverName: entry.serverName,
            error: String(err instanceof Error ? err.message : err),
          });
        }),
    );
    // F2 (#4175 commit 6 review fix — wenshao W63): clear the timer
    // when the shutdown promises win the race (otherwise it stays
    // armed until natural fire — `unref` prevents process hang but
    // the timer object leaks). Snapshot `drained` / `errors` lengths
    // BEFORE returning so the caller doesn't receive a live
    // reference to mutating arrays (background `shutdownPromises`
    // can keep pushing if any settle after the timeout). The
    // `forced` count is computed via subtraction at the snapshot
    // moment and clamped to non-negative so a late settle pushing
    // into `drained` after the snapshot can't make `forced` go
    // negative.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, deadline - Date.now());
    await Promise.race([
      Promise.all(shutdownPromises).then(() => {
        if (drainTimer) clearTimeout(drainTimer);
      }),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => resolve(), remaining);
        drainTimer.unref?.();
      }),
    ]);
    const drainedCount = drained.length;
    const errorsCount = errors.length;
    const forced = Math.max(0, entries.length - drainedCount - errorsCount);
    const errorsCopy = [...errors];
    this.entries.clear();
    this.unpooledIds.clear();
    this.sessionToEntries.clear();
    this.spawnInFlight.clear();
    return {
      drained: drainedCount,
      forced,
      errors: errorsCopy,
    };
  }

  // ---------- internals ----------

  private async spawnEntry(
    serverName: string,
    cfg: MCPServerConfig,
    id: ConnectionId,
  ): Promise<PoolEntry> {
    const entryIndex = this.allocateEntryIndex(serverName);
    const transport = mcpTransportOf(cfg);
    const entryOpts = this.opts.entryOptions(transport);

    const client = new McpClient(
      serverName,
      cfg,
      // The pool itself doesn't use the per-session registries — the
      // McpClient's `discoverAndReturn` (commit 1) is pure. Passing
      // placeholders that throw on use would catch any regression
      // where a pool path accidentally fell back to legacy `discover()`.
      poisonedToolRegistry(serverName),
      poisonedPromptRegistry(serverName),
      this.opts.workspaceContext,
      this.opts.debugMode,
      this.opts.sendSdkMcpMessage,
    );

    const entry = new PoolEntry(
      id,
      serverName,
      entryIndex,
      cfg,
      client,
      this.cliConfig,
      entryOpts,
      // F2 (#4175 commit 6): when an entry transitions to terminal
      // `closed` / `failed`, release its budget slot — but ONLY if
      // no sibling entry (live OR currently spawning) shares the same
      // `serverName`. Pool tracks slot ownership by NAME; multi-
      // fingerprint case where two divergent OAuth headers spawned
      // two entries should keep the slot until the LAST entry for
      // the name closes. Wenshao R1 fix: previous version checked
      // only `this.entries` and missed in-flight spawns — entry A
      // closing during entry B's still-pending spawn would
      // prematurely release the slot, letting a third name slip
      // past the cap once B finished.
      (closedId) => {
        const closing = this.entries.get(closedId);
        this.entries.delete(closedId);
        if (closing && this.opts.budget !== undefined) {
          if (!this.hasNameSibling(closing.serverName)) {
            this.opts.budget.release(closing.serverName);
          }
        }
      },
      (name) => this.aggregateStatusByName(name),
    );

    try {
      // F2 (#4175 commit 6 review fix — gpt-5.5 W25 + wenshao W43):
      // bound the `connect()` + `discoverAndReturn()` sequence with
      // a wall-clock timeout matching
      // `McpClientManager.runWithDiscoveryTimeout` (stdio default
      // 30s, remote 5s, per-server `discoveryTimeoutMs` override).
      // Pre-fix a hung server's connect/discover left
      // `spawnInFlight` unresolved forever — every session sharing
      // this `ConnectionId` waited indefinitely AND the budget slot
      // was never rolled back. The timeout's `reject` triggers the
      // catch path which forces shutdown + budget rollback (W1
      // fold-in).
      //
      // W43 (commit 6 review round 6): `entries.set(id, entry)` +
      // `entry.markActive(...)` MUST live OUTSIDE the
      // timeout-wrapped IIFE. Pre-fix they were inside; if the
      // timeout fired, the catch removed the entry and
      // forceShutdown'd it, but the IIFE kept running. When
      // connect/discover settled later, the IIFE's late `entries.set`
      // re-inserted the deleted entry and `markActive` set
      // `state='active'` + `localStatus=CONNECTED` on a transport
      // that was already disconnected by forceShutdown → zombie
      // entry that subsequent `acquire`s would attach to. Moving
      // them out of the IIFE means the timeout's reject reaches
      // the catch BEFORE these state writes can happen; if the
      // background IIFE eventually settles, its return value is
      // discarded by the rejected `await runWithTimeout(...)`.
      const timeoutMs = discoveryTimeoutFor(cfg);
      const snap = await runWithTimeout(
        (async () => {
          await client.connect();
          return client.discoverAndReturn(this.cliConfig);
        })(),
        timeoutMs,
        `pool spawn for ${id}`,
      );
      if (this.draining) {
        debugLogger.warn(
          `Spawn for ${id} completed while pool is draining; discarding entry`,
        );
        try {
          await entry.forceShutdown('manual');
        } catch {
          /* best effort — shutdown path already in progress */
        }
        throw new Error(`McpTransportPool is draining; discarded spawn ${id}`);
      }
      // F2 (#4175 commit 4 review fix — wenshao C6 follow-up):
      // register the entry in `this.entries` BEFORE markActive's
      // updateGlobalStatus runs. Pre-fix the order was reversed,
      // and `aggregateStatusByName(serverName)` iterated `entries`
      // without finding the just-spawned entry → returned
      // DISCONNECTED → wrote that to the module-level map → my
      // status-change listener echoed it back as `localStatus =
      // DISCONNECTED`, defeating the CONNECTED state markActive
      // had just set. Setting first means the aggregator sees the
      // entry mid-`active` transition and returns CONNECTED.
      this.entries.set(id, entry);
      entry.markActive(snap.tools, snap.prompts);
      debugLogger.info(
        `Spawned pool entry ${id} (entryIndex=${entryIndex}, transport=${transport})`,
      );
      return entry;
    } catch (err) {
      debugLogger.error(
        `Failed to spawn pool entry for '${serverName}' ` +
          `(id=${id}, transport=${transport}): ${String(err)}`,
      );
      // Don't leak the entry. McpClient self-flips status to
      // DISCONNECTED on discoverAndReturn error (commit 1 invariant).
      // `entries.delete` is idempotent — covers the race where the
      // error came from `markActive` AFTER `entries.set` ran (rare;
      // markActive is mostly assignment + updateGlobalStatus, but
      // a listener could throw). Catches both pre- and post-set
      // failure modes uniformly.
      //
      // F2 (#4175 commit 6 review fix — wenshao W1): also call
      // `entry.forceShutdown('manual')` to remove the
      // `statusChangeListener` that the `PoolEntry` constructor
      // registered. Pre-fix every spawn failure leaked one listener
      // permanently — module-level `serverStatuses` notifications
      // would still fire on the orphan listener, slowly degrading
      // status-update latency over the daemon's lifetime. Wrap in
      // try/catch because the entry is in an inconsistent state
      // (state machine never reached `active`); errors are
      // non-actionable here.
      try {
        await entry.forceShutdown('manual');
      } catch {
        /* best effort — entry never reached active state */
      }
      this.entries.delete(id);
      try {
        await client.disconnect();
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  private allocateEntryIndex(serverName: string): number {
    const next = this.nextIndexByName.get(serverName) ?? 0;
    this.nextIndexByName.set(serverName, next + 1);
    return next;
  }

  private indexAttach(sessionId: string, id: ConnectionId): void {
    let ids = this.sessionToEntries.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.sessionToEntries.set(sessionId, ids);
    }
    ids.add(id);
  }

  private indexDetach(sessionId: string, id: ConnectionId): void {
    const ids = this.sessionToEntries.get(sessionId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.sessionToEntries.delete(sessionId);
  }

  /**
   * Per-session connection for transports that bypass the pool (SDK
   * MCP, HTTP/SSE when not opt-in). Constructs a fresh `McpClient`
   * tied to THIS session's registries. No refcounting; lifetime
   * managed by the caller via `release()`.
   *
   * Stored in `this.entries` with an `unpooled-*` id so shared lifecycle
   * methods (`releaseSession`, `drainAll`, budget sibling checks, and
   * snapshots) can still reach it even though it is never reused by another
   * session.
   */
  private async createUnpooledConnection(
    serverName: string,
    cfg: MCPServerConfig,
    sessionId: string,
    sessionToolRegistry: ToolRegistry,
    sessionPromptRegistry: PromptRegistry,
  ): Promise<PooledConnection> {
    const entryIndex = this.allocateEntryIndex(serverName);
    const id: ConnectionId =
      `${serverName}::unpooled-${entryIndex}` as ConnectionId;
    const transport = mcpTransportOf(cfg);
    const entryOpts = this.opts.entryOptions(transport);
    const client = new McpClient(
      serverName,
      cfg,
      sessionToolRegistry,
      sessionPromptRegistry,
      this.opts.workspaceContext,
      this.opts.debugMode,
      this.opts.sendSdkMcpMessage,
    );

    // Build a SessionMcpView that wraps this session's registries
    // — but for unpooled entries we use McpClient.discover() (which
    // registers directly via the registries we just passed) instead
    // of the pure discoverAndReturn path. The view is constructed
    // but applyTools/applyPrompts are no-ops for unpooled (registration
    // already happened inside discover()).
    const view = new SessionMcpView(
      sessionToolRegistry,
      sessionPromptRegistry,
      sessionId,
      serverName,
      cfg,
    );

    const entry = new PoolEntry(
      id,
      serverName,
      entryIndex,
      cfg,
      client,
      this.cliConfig,
      entryOpts,
      // F2 (#4175 commit 6 review fix — wenshao W65): release the
      // budget slot when this unpooled entry closes. Pre-fix
      // unpooled connections (HTTP/SSE not in `pooledTransports`,
      // SDK MCP) bypassed budget enforcement entirely AND skipped
      // budget release on close — the slot was never reserved
      // either, but this hook makes the close-path symmetric for
      // when budget is now reserved at acquire (W65 follow-on).
      // `hasNameSibling` keeps the slot reserved if any pooled
      // entry or in-flight spawn shares the name.
      (closedId) => {
        this.entries.delete(closedId);
        this.unpooledIds.delete(closedId);
        if (this.opts.budget !== undefined) {
          if (!this.hasNameSibling(serverName)) {
            this.opts.budget.release(serverName);
          }
        }
      },
      // F2 (#4175 commit 4 review fix — wenshao S4): aggregator
      // delegates to McpClient.getStatus() instead of hardcoded
      // CONNECTED. After `forceShutdown` flips client to
      // DISCONNECTED, the global serverStatuses Map gets the
      // correct value rather than a permanently-stale CONNECTED
      // (which would mislead operators reading the global map
      // for unpooled servers).
      () => client.getStatus(),
    );

    try {
      this.entries.set(id, entry);
      this.unpooledIds.add(id);
      // F2 (#4175 commit 6 review fix — wenshao W62): bound the
      // unpooled connect+discover with the same `runWithTimeout`
      // wrapper `spawnEntry` (W25) and `doRestart` (W44) use. Pre-
      // fix a hung SDK MCP / non-pooled HTTP server blocked
      // `acquire` indefinitely, stalling the entire session's tool
      // discovery. Same `discoveryTimeoutFor(cfg)` resolution
      // (stdio 30s default, remote 5s, per-server override).
      const timeoutMs = discoveryTimeoutFor(cfg);
      await runWithTimeout(
        (async () => {
          await client.connect();
          // Per-session path: use the legacy discover() so the
          // supplied session registries are populated directly.
          // Avoids double-registration that would happen if we
          // also called applyTools.
          await client.discover(this.cliConfig);
        })(),
        timeoutMs,
        `unpooled spawn for ${id}`,
      );
      if (this.draining || !this.entries.has(id)) {
        try {
          await entry.forceShutdown('manual');
        } catch {
          /* best effort — pool is already draining */
        }
        throw new Error(
          `McpTransportPool is draining; discarded unpooled ${id}`,
        );
      }
      entry.markActive([], []);
      // Unpooled handle: skipReplay prevents `attach` from calling
      // `view.applyTools([])` which would `removeMcpToolsByServer`
      // and wipe the tools `discover()` just registered (commit-2
      // review P1 #2 fix). Release callback runs forceShutdown
      // directly — no pool refcount accounting for unpooled entries
      // since they're per-session.
      const conn = entry.attach(sessionId, view, {
        skipReplay: true,
        release: () => {
          this.indexDetach(sessionId, id);
          void entry.forceShutdown('manual');
        },
      });
      this.indexAttach(sessionId, id);
      return conn;
    } catch (err) {
      // F2 (#4175 commit 6 review fix — wenshao W14): same listener-
      // leak as the pooled spawn-failure path (W1). The unpooled
      // entry's ctor also registered a `statusChangeListener` via
      // `addMCPStatusChangeListener`, and only `forceShutdown`
      // removes it. Pre-fix every unpooled connect/discover failure
      // leaked one listener permanently.
      try {
        await entry.forceShutdown('manual');
      } catch {
        /* best effort — entry never reached active state */
      }
      this.entries.delete(id);
      this.unpooledIds.delete(id);
      try {
        await client.disconnect();
      } catch {
        /* best effort */
      }
      throw err;
    }
  }
}

/**
 * Snapshot shape returned by `pool.getSnapshot()`. The wrapping
 * status route (commit 5) projects this into the existing
 * `GET /workspace/mcp` response with `scope: 'workspace'`.
 */
export interface McpPoolSnapshot {
  /** Total CONNECTED clients across all entries. */
  total: number;
  /**
   * Live local-subprocess count — stdio entries that are CONNECTED.
   * Websocket transports dial a (potentially remote) MCP server over
   * the network and don't spawn a local OS child, so they're
   * deliberately excluded (per wenshao R4 review fold-in in commit 5).
   */
  subprocessCount: number;
  /** Per-server entry details. */
  byName: Record<
    string,
    {
      entryCount: number;
      entrySummary: Array<{
        entryIndex: number;
        refs: number;
        status: MCPServerStatus;
      }>;
    }
  >;
}

/**
 * Result of `pool.drainAll`. `forced` counts entries that didn't
 * close within the wall-clock budget — operator should investigate
 * the corresponding stderr logs.
 */
export interface DrainResult {
  drained: number;
  forced: number;
  errors: Array<{
    entryIndex: number;
    serverName: string;
    error: string;
  }>;
}

/**
 * A ToolRegistry stub that throws on any registration attempt. Used
 * inside the pool's `McpClient` instances so that any regression
 * where a pool entry accidentally falls back to legacy `discover()`
 * (which would write to these registries instead of returning a
 * snapshot) immediately surfaces as a loud error rather than
 * cross-contaminating sessions.
 */
function poisonedToolRegistry(serverName: string): ToolRegistry {
  return {
    registerTool() {
      throw new Error(
        `Pool invariant violated: poisoned ToolRegistry for ${serverName} ` +
          'received registerTool. A pool path must use discoverAndReturn, not discover.',
      );
    },
  } as unknown as ToolRegistry;
}

function poisonedPromptRegistry(serverName: string): PromptRegistry {
  return {
    registerPrompt() {
      throw new Error(
        `Pool invariant violated: poisoned PromptRegistry for ${serverName} ` +
          'received registerPrompt. A pool path must use discoverAndReturn.',
      );
    },
  } as unknown as PromptRegistry;
}

// `runWithTimeout` + `discoveryTimeoutFor` moved to
// `mcp-discovery-timeout.ts` so `PoolEntry.doRestart` (W44 fold-in)
// can share the same primitives without cross-module value imports.

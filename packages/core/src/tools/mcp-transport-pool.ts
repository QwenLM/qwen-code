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
// same `BudgetExhaustedError` thrown by the
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
   * optional workspace-scoped budget controller.
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
 * core: N ACP sessions on one daemon share one transport
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
 *   - Spawn failure releases the reserved budget slot
 *   - Drain timer cancelled on attach; restarted on last detach
 *   - `MAX_IDLE_MS` (5min default) hard cap survives drain/attach flap
 *   - Global `serverStatuses` Map written via aggregated status function
 */
export class McpTransportPool {
  private readonly entries = new Map<ConnectionId, PoolEntry>();
  private readonly unpooledIds = new Set<ConnectionId>();
  private readonly spawnInFlight = new Map<ConnectionId, Promise<PoolEntry>>();
  /** : reverse index for O(refs) `releaseSession`. */
  private readonly sessionToEntries = new Map<string, Set<ConnectionId>>();
  /**
   * Drain mutex : when `drainAll` is in progress, new
   * acquires reject so they don't latch onto entries that are about
   * to be force-closed. Cleared by `drainAll` only on successful
   * teardown — once set, a fresh pool is required for further work.
   */
  private draining = false;
  /**
   * Monotonic per-server-name index for `entryIndex`. Each
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
   * expose the budget controller for snapshot
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
   * : pre-fix used `startsWith(`${name}::`)`
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
      // defense-in-depth
      // against terminal-state attach race. With the silent-drop
      // listener calls `onClosed` which removes the entry from
      // `pool.entries`, so the common path is `entries.get(id) ===
      // undefined` → fall through to spawn. But a narrow race remains:
      // the listener could fire BETWEEN `entries.get(id)` above and
      // the `attach` call below. The pre-check + post-attach try/catch
      // both fall through to spawn so the pool self-heals without
      // surfacing "Cannot attach to PoolEntry in state failed" to the
      // session caller. Also handles the leftover stale entry case
      // (any pre-existing zombie not yet evicted by `onClosed`).
      if (existing && !existing.isTerminated()) {
        // index update
        // happens AFTER `attach` succeeds. Pre-fix the order was
        // reversed; an `attach` rejection (e.g., entry transitioned
        // to `closed`/`failed` between the `entries.get` check and the
        // `attach` call) left a stale `sessionToEntries[sessionId]`
        // mapping with no matching `entry.refs.has(sessionId)`
        // `releaseSession` would later iterate the stale id and call
        // `entry.detach` on a non-attached session. :
        // `attachPooledSession` is the shared view+attach helper;
        // call-site ordering (indexAttach AFTER attach, terminal-state
        // self-heal in catch) stays here, not in the helper.
        try {
          const conn = this.attachPooledSession(
            existing,
            id,
            serverName,
            cfg,
            sessionId,
            sessionToolRegistry,
            sessionPromptRegistry,
          );
          this.indexAttach(sessionId, id);
          return conn;
        } catch (err) {
          // : a race transitioned the entry to terminal between
          // the isTerminated() pre-check and the attach call. Evict
          // and fall through to spawn instead of propagating
          // "Cannot attach in state failed" out of the pool.
          if (existing.isTerminated()) {
            //
            // A): route through `evictEntry` so the budget slot is
            // released. Pre-fix the bare `entries.delete(id)` left
            // the slot reserved permanently — the entry's own
            // `onClosed` (when its async terminal-state tail finally
            // fired) saw `entries.get(id) === undefined` and skipped
            // budget release. `evictEntry` is identity-checked, so
            // it's safe under any interleaving with the entry's own
            // onClosed (the second call no-ops via `current !== entry`).
            this.evictEntry(id, existing);
            debugLogger.warn(
              `pool self-heal: evicted terminal entry ${id} ` +
                `(state='${existing.currentState}', serverName='${serverName}') ` +
                `mid-attach race; falling through to spawn fresh entry`,
            );
          } else {
            throw err;
          }
        }
      } else if (existing && existing.isTerminated()) {
        //
        // pre-existing terminal entry that hadn't been evicted yet
        // (e.g. mid-`forceShutdown` between the sync `state='closed'`
        // assignment and the async `await sweepAndDisconnect` →
        // `onClosed` tail). `evictEntry` is identity-checked + budget-
        // releasing, mirroring the eventual onClosed semantics. Pre-
        // fix the bare `entries.delete(id)` here permanently leaked
        // the budget slot for this race.
        this.evictEntry(id, existing);
        debugLogger.warn(
          `pool self-heal: evicted stale terminal entry ${id} ` +
            `(state='${existing.currentState}', serverName='${serverName}') ` +
            `before fast-path attach; falling through to spawn fresh entry`,
        );
      }
    }

    // Below this point we're committed to creating a NEW connection
    // (pooled spawn OR unpooled). Apply the workspace budget check
    // by NAME — divergent fingerprints for the same name share one
    // slot (matches v1's "configured server slots" semantic).
    //
    // pre-fix the
    // budget check ran AFTER the `!isPoolable` early-return, so
    // unpooled HTTP/SSE/SDK-MCP connections bypassed enforcement
    // entirely (`--mcp-client-budget=2` would let 3 HTTP MCP servers
    // connect without refusal). Now the check applies uniformly to
    // both branches; refusal under enforce mode throws
    // BudgetExhaustedError so the caller's catch translates to
    // `refused_batch` in the snapshot.
    //
    // hoist `reservationResult` into outer scope so the catch blocks
    // below can distinguish `'reserved'` (THIS acquire actually
    // consumed a slot, must roll back on failure) from
    // `'already_held'` (a same-name sibling held the slot, this
    // acquire reserved nothing, must NOT release on failure). Pre-
    // R24 the catches called `budget.release(serverName)` whenever
    // `!hasNameSibling()` was true — a sibling concurrently evicted
    // between this acquire's `tryReserve` and the catch would cause
    // a phantom release of a slot this acquire never reserved,
    // drifting the budget counter (false-positive
    // `BudgetExhaustedError` refusals or under-counted over-spawn).
    let reservationResult: 'reserved' | 'already_held' | undefined;
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
      reservationResult = reservation;
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
        //  (codified by as a shared helper): only
        // release if THIS acquire actually reserved a new slot.
        // `'already_held'` means the sibling holds it; not ours to
        // release.
        this.rollbackReservationOnSpawnFailure(reservationResult, serverName);
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
      // `spawnInFlight.keys`) sees the post-cleanup state.
      // race-fix: previously the rollback only checked `this.entries`
      // and a sibling entry could prematurely keep the slot reserved
      // even when this rollback should have released it.
      inFlight = spawnPromise
        .finally(() => {
          this.spawnInFlight.delete(id);
        })
        .catch((err) => {
          // roll back the slot reservation on
          // spawn failure so a transient connect failure
          // doesn't leak the slot until daemon restart.
          //
          //  contract (codified as `rollbackReservationOnSpawnFailure`
          // helper in ): only release if THIS acquire actually
          // reserved a new slot (`reservationResult === 'reserved'`).
          // `'already_held'` means a sibling holds the slot — phantom-
          // releasing here would decrement the counter if the sibling
          // were concurrently evicted between `tryReserve` and this
          // catch.
          this.rollbackReservationOnSpawnFailure(reservationResult, serverName);
          throw err;
        });
      this.spawnInFlight.set(id, inFlight);
    }
    // index the
    // sessionId BEFORE `await inFlight`. Symmetric to on the
    // unpooled path. Pre-fix the in-flight branch indexed only after
    // `attach` succeeded (former line 351), so `releaseSession(sessionId)`
    // fired during the await window walked an empty `sessionToEntries`
    // entry and missed the in-flight acquire. With the early index a
    // concurrent `releaseSession` AFTER the spawn's `entries.set` runs
    // finds the entry via the reverse index and invokes
    // `forceShutdown`, which the post-await `isTerminated()` guard
    // below catches. NOTE: a `releaseSession` that fires BEFORE
    // spawnEntry's `entries.set` is still a residual race — the reverse
    // index has the id but `entries.get(id)` is `undefined` so
    // `releaseSession`'s loop skips. Closing that window requires
    // per-session cancellation plumbing (tracked as -followup).
    this.indexAttach(sessionId, id);

    let entry: PoolEntry;
    try {
      entry = await inFlight;
    } catch (err) {
      // Roll back the early index on spawn failure so a later
      // `releaseSession(sessionId)` doesn't iterate a stale id with
      // no matching entry.
      this.indexDetach(sessionId, id);
      throw err;
    }

    // Post-await terminal-state guard ( / ): a concurrent
    // `releaseSession` after `entries.set` may have invoked
    // `forceShutdown` on the now-spawned entry, flipping state to
    // 'closed'. `attach` would throw with a deep "Cannot attach in
    // state closed" error; we surface a clearer message and clean up
    // the reverse index.
    if (!this.entries.has(id) || entry.isTerminated()) {
      this.indexDetach(sessionId, id);
      throw new Error(
        `PoolEntry ${id} torn down before attach (concurrent release)`,
      );
    }

    try {
      const conn = this.attachPooledSession(
        entry,
        id,
        serverName,
        cfg,
        sessionId,
        sessionToolRegistry,
        sessionPromptRegistry,
      );
      // re-index
      // AFTER attach succeeds. Pre-fix the early `indexAttach` at the
      // top of this branch was enough on the unpooled path
      // because a concurrent `releaseSession` during the spawn window
      // there always invoked `forceShutdown('manual')` (unpooled +
      // refs=0 → terminal), which the `isTerminated()` guard above
      // caught. On the POOLED path a concurrent `releaseSession`
      // instead calls `entry.startDrainTimer()` (state='draining',
      // NOT terminal) AND then `sessionToEntries.delete(sessionId)`.
      // The post-await guard wouldn't fire (state is 'draining', not
      // 'closed'/'failed'), `attach` would transition the entry back
      // to 'active' and add the ref — but `sessionToEntries[sessionId]`
      // would be empty, so subsequent `releaseSession(sessionId)`
      // returned early without ever dropping the ref. Result: leaked
      // pool ref for the entry's lifetime.
      //
      // Re-running `indexAttach` is idempotent (the underlying
      // `Set.add` is a no-op if the id is already there in the rare
      // case `releaseSession` didn't fire). The early indexAttach at
      // the top stays — it's load-bearing for the `isTerminated()`
      // guard to actually find an entry to forceShutdown if a
      // releaseSession DOES race AFTER `entries.set` runs.
      this.indexAttach(sessionId, id);
      return conn;
    } catch (err) {
      // Defensive: if `attach` throws between the `isTerminated` check
      // and this line (narrow but possible race window), clean up the
      // early index. Without this, `releaseSession` would later
      // iterate the stale id.
      this.indexDetach(sessionId, id);
      throw err;
    }
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
   * this session) via the reverse index. Use this from
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
   * with `entryIndex` if specified. Runs in parallel via
   * `Promise.all` with per-entry try/catch (rejections never escape);
   * returns per-entry results so the caller can surface per-entry
   * success/failure ( restart route). : previous
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
    // defense-in-depth
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
          //
          // re-arm the drain timer if the restarted entry has no
          // subscribers. `doRestart` unconditionally cancels both
          // `drainTimer` and `maxIdleTimer` at the top so the restart
          // can proceed atomically ( / ), but pre-fix the success
          // path never restored the drain lifecycle. If an operator
          // invokes `/workspace/mcp/<srv>/restart` on an idle entry
          // (refs=0, drain timer running), the entry transitioned back
          // to `'active'` and then sat forever with no subscribers
          // a leaked subprocess until the next restart or `drainAll`.
          // Re-arming here hands the lifecycle back to the standard
          // refs=0 → drain → close path. We do this at the pool level
          // rather than inside `entry.restart()` so the operator-
          // configured pool `drainDelayMs` is used instead of
          // `PoolEntry.opts.drainDelayMs` (which defaults to 30s and
          // is independent of the pool's setting).
          if (entry.refs.size === 0 && !this.unpooledIds.has(entry.id)) {
            entry.startDrainTimer(this.opts.drainDelayMs);
          }
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

  // the pool-level
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
   * `entryCount` per server name + `entrySummary` array (
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
        // only
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
   * wins" rule. Called by individual `PoolEntry` instances
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

    // block new
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
    // the
    // `Promise.allSettled` wait was previously UNBOUNDED — a spawn
    // with a large `discoveryTimeoutMs` override (or a stuck spawn
    // running its own 30s default) would block daemon shutdown for
    // the full discovery timeout BEFORE `drainAll`'s 8-10s budget
    // even began, defeating the caller's shutdown deadline. Now the
    // in-flight wait races against the SAME `timeoutMs` budget; if
    // it doesn't settle, we proceed with whatever entries are
    // already in `this.entries` (the rest will be force-closed via
    // `clear()` below). Per-spawn timeouts bound individual
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
    // clear the timer
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

  /**
   * shared
   * view+attach helper for the two POOLED `acquire()` branches (the
   * fast-path for an existing entry, and the post-spawn attach after
   * `await inFlight`). Pre-fix both branches inlined the same 3-step
   * pattern (build view → entry.attach → return) with identical
   * release-callback wiring; stated cleanup goal is to dedupe
   * without losing the per-call-site race-window invariant comments
   * that explain WHY each branch's surrounding ordering is what it is.
   *
   * NOT used by `createUnpooledConnection` — the unpooled release
   * callback runs `entry.forceShutdown('manual')` directly (no pool
   * refcount accounting since unpooled entries are per-session) and
   * also calls `indexDetach` from the release callback itself.
   *
   * Caller is responsible for:
   *   - Terminal-state pre-check (`!entry.isTerminated()`) + race-
   *     window self-heal (`evictEntry` on the catch path).
   *   - Reverse-index ordering (early `indexAttach` BEFORE await on
   *     the post-spawn branch per; AFTER attach on the fast-path
   *     per; re-indexAttach AFTER attach on post-spawn).
   *   The race-window comments live at the call sites because they
   *   describe the surrounding ordering, not the attach itself.
   */
  private attachPooledSession(
    entry: PoolEntry,
    id: ConnectionId,
    serverName: string,
    cfg: MCPServerConfig,
    sessionId: string,
    sessionToolRegistry: ToolRegistry,
    sessionPromptRegistry: PromptRegistry,
  ): PooledConnection {
    const view = new SessionMcpView(
      sessionToolRegistry,
      sessionPromptRegistry,
      sessionId,
      serverName,
      cfg,
    );
    return entry.attach(sessionId, view, {
      release: () => this.release(id, sessionId),
    });
  }

  /**
   * — /; codifies the
   *  contract): roll back THIS acquire's slot reservation on
   * spawn failure. Used by both the unpooled-spawn catch and the
   * pooled-spawn-in-flight catch — both decisions are identical:
   *   - `'reserved'` → THIS acquire newly held the slot; release
   *                        if no sibling holds it
   *   - `'already_held'` → sibling holds it; never release here (the
   *                        sibling's own onClosed / evictEntry will
   *                        handle it). Pre-R24 the bare
   *                        `!hasNameSibling()` check would phantom-
   *                        release a slot this acquire never reserved
   *                        when the sibling was concurrently evicted.
   *   - `undefined` → no budget configured; nothing to do.
   */
  private rollbackReservationOnSpawnFailure(
    reservationResult: 'reserved' | 'already_held' | undefined,
    serverName: string,
  ): void {
    if (
      this.opts.budget !== undefined &&
      reservationResult === 'reserved' &&
      !this.hasNameSibling(serverName)
    ) {
      this.opts.budget.release(serverName);
    }
  }

  /**
   *
   * Single source of truth for evicting a pooled entry from
   * `this.entries` AND releasing its budget slot. Used by:
   *   - The pool-managed onClosed callback (terminal-state transition
   *     paths: `forceShutdown`, `doRestart` catch, / silent-
   *     drop listener).
   *   - The fast-path self-heal branches (catch + else-if) which
   *     pre-fix called `this.entries.delete(id)` directly and bypassed
   *     budget release entirely → permanent slot leak per occurrence.
   *
   * Identity check (`current === entry`):
   *   The same id can host multiple entry objects across its lifetime
   *   (eviction + respawn). When `forceShutdown`'s async tail
   *   (`await sweepAndDisconnect`) runs concurrently with a
   *   fast-path eviction + spawn under the same id, the OLD entry's
   *   onClosed fires AFTER the NEW entry has been inserted. Without
   *   this guard, the OLD onClosed would silently evict the NEW
   *   entry and (incorrectly) release its budget slot. `entry` may
   *   be `undefined` only during the brief constructor window where
   *   the assignment hasn't completed; in production the callback
   *   is never invoked synchronously from the constructor.
   *
   * Budget release: matches the prior inline logic exactly
   * `hasNameSibling` keeps the slot reserved when divergent-
   * fingerprint entries (e.g. multi-OAuth) or in-flight spawns share
   * the name.
   */
  private evictEntry(id: ConnectionId, entry: PoolEntry | undefined): void {
    if (entry === undefined) return;
    const current = this.entries.get(id);
    if (current !== entry) return;
    this.entries.delete(id);
    if (this.opts.budget !== undefined) {
      if (!this.hasNameSibling(entry.serverName)) {
        this.opts.budget.release(entry.serverName);
      }
    }
  }

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

    //
    // capture `entry` in the onClosed callback closure so the eviction
    // helper can identity-check against a respawned entry. Pre-fix the
    // callback did `entries.get(closedId)` and unconditionally
    // `entries.delete(closedId)` — but if a concurrent fast-path
    // eviction + spawn replaced this id with a NEW entry between the
    // OLD entry's terminal-state transition and its async tail
    // (`forceShutdown`'s `await sweepAndDisconnect`), `onClosed(id)`
    // would silently evict the new entry and (incorrectly) release
    // its budget slot. `evictEntry` below short-circuits when the
    // current map slot doesn't match the captured ref — safe under
    // any interleaving with 's self-heal path.
    // Mutable holder so the onClosed callback can resolve the
    // captured entry reference at fire time (not construction time
    // the entry doesn't exist yet when we build the callback).
    // `entryRef.current` is guaranteed populated before the callback
    // is ever invoked: the assignment happens synchronously after the
    // PoolEntry constructor returns, and onClosed is only called from
    // terminal-state code paths that fire AFTER construction.
    const entryRef: { current: PoolEntry | undefined } = {
      current: undefined,
    };
    const onClosedForThisEntry = (closedId: ConnectionId) => {
      this.evictEntry(closedId, entryRef.current);
    };
    const entry = new PoolEntry(
      id,
      serverName,
      entryIndex,
      cfg,
      client,
      this.cliConfig,
      entryOpts,
      onClosedForThisEntry,
      (name) => this.aggregateStatusByName(name),
    );
    entryRef.current = entry;

    try {
      //
      // bound the `connect()` + `discoverAndReturn()` sequence with
      // a wall-clock timeout matching
      // `McpClientManager.runWithDiscoveryTimeout` (stdio default
      // 30s, remote 5s, per-server `discoveryTimeoutMs` override).
      // Pre-fix a hung server's connect/discover left
      // `spawnInFlight` unresolved forever — every session sharing
      // this `ConnectionId` waited indefinitely AND the budget slot
      // was never rolled back. The timeout's `reject` triggers the
      // catch path which forces shutdown + budget rollback (
      // ).
      //
      //  (commit 6 review round 6): `entries.set(id, entry)` +
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
          // explicitly
          // opt out of `applyConfigFilters` for pool snapshot. Per-
          // session `SessionMcpView.applyTools` is the authoritative
          // filter (otherwise pool-mode trust + include/exclude would
          // apply twice — once at the shared snapshot level and again
          // at the per-session view, with potentially divergent
          // decisions when sessions in the same workspace have
          // different runtime trust state).
          return client.discoverAndReturn(this.cliConfig, {
            applyConfigFilters: false,
          });
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
      //
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
      // DISCONNECTED on discoverAndReturn error .
      // `entries.delete` is idempotent — covers the race where the
      // error came from `markActive` AFTER `entries.set` ran (rare;
      // markActive is mostly assignment + updateGlobalStatus, but
      // a listener could throw). Catches both pre- and post-set
      // failure modes uniformly.
      //
      // also call
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

    // Build a SessionMcpView that wraps this session's registries.
    // post-/
    // refactor, the unpooled path uses `client.discoverAndReturn`
    // (pure) to obtain a snapshot, then routes through `markActive`
    // + `attach` (no `skipReplay`) — so `view.applyTools` /
    // `applyPrompts` are the AUTHORITATIVE filtered registration
    // (apply per-session `includeTools` / `excludeTools` and the
    // trust copy), not no-ops. Do NOT re-add `skipReplay: true` on
    // the `attach` call below — that would silently re-introduce
    //  (unpooled servers receiving ALL tools, every tool with
    // `trust: undefined`).
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
      // release the
      // budget slot when this unpooled entry closes. Pre-fix
      // unpooled connections (HTTP/SSE not in `pooledTransports`,
      // SDK MCP) bypassed budget enforcement entirely AND skipped
      // budget release on close — the slot was never reserved
      // either, but this hook makes the close-path symmetric for
      // when budget is now reserved at acquire ( follow-on).
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
      // aggregator
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
      // populate the
      // reverse index synchronously, BEFORE the connect/discover
      // await. Pre-fix, `releaseSession(sessionId)` fired during this
      // window walked an empty `sessionToEntries[sessionId]` and
      // returned without touching the in-flight unpooled entry — the
      // transport kept starting and `attach()` later registered tools/
      // prompts into a session that had already been closed. With the
      // early indexing, a concurrent `releaseSession` finds the entry,
      // calls `entry.forceShutdown('manual')` (which synchronously
      // flips state→'closed' per ), and the post-await
      // `isTerminated()` guard below catches it. Every error/discard
      // path now mirrors this with `indexDetach` to keep the index
      // consistent.
      this.indexAttach(sessionId, id);
      // bound the
      // unpooled connect+discover with the same `runWithTimeout`
      // wrapper `spawnEntry` and `doRestart` use. Pre-
      // fix a hung SDK MCP / non-pooled HTTP server blocked
      // `acquire` indefinitely, stalling the entire session's tool
      // discovery. Same `discoveryTimeoutFor(cfg)` resolution
      // (stdio 30s default, remote 5s, per-server override).
      const timeoutMs = discoveryTimeoutFor(cfg);
      // route
      // unpooled through the same `discoverAndReturn` snapshot path as
      // the pooled flow, so the per-session `SessionMcpView.applyTools`
      // / `applyPrompts` filter+trust+rename pipeline is the
      // authoritative registration. Pre-fix `client.discover(cliConfig)`
      // called `discoverAndReturn({ applyConfigFilters: false })` and
      // then registered the UNFILTERED snapshot directly into the
      // session registries, while `attach(skipReplay: true)` bypassed
      // the only filtering layer (view.applyTools). Net effect: SDK
      // MCP / HTTP / SSE servers with `includeTools` / `excludeTools`
      // received ALL tools and every tool had `trust: undefined`. The
      // prior "avoid double-registration" rationale is obsolete
      // `view.applyTools` calls `removeMcpToolsByServer(serverName)`
      // first, so the snapshot path is idempotent.
      const snap = await runWithTimeout(
        (async () => {
          await client.connect();
          // same
          // opt-out as the pooled spawn — view.applyTools handles
          // filtering for the unpooled path too (/ fix routes
          // unpooled through attach's snapshot-replay).
          return await client.discoverAndReturn(this.cliConfig, {
            applyConfigFilters: false,
          });
        })(),
        timeoutMs,
        `unpooled spawn for ${id}`,
      );
      // : re-check terminal state after the await — a concurrent
      // `releaseSession(sessionId)` may have invoked `forceShutdown`
      // while we were spawning. Without this guard, `markActive` /
      // `attach` would either resurrect the entry or throw deep in
      // attach's state check, leaking the in-flight transport. Now
      // that the / fix routes registration through `attach`'s
      // snapshot-replay path, no direct registry mutation has happened
      // yet at this point — `attach` is the only side-effecting call
      // below. `view.teardown` is still defensive in case a future
      // refactor moves registration earlier; it's a cheap no-op when
      // nothing has been registered for this server.
      if (this.draining || !this.entries.has(id) || entry.isTerminated()) {
        try {
          view.teardown();
        } catch {
          /* best effort — view may already be torn down */
        }
        try {
          await entry.forceShutdown('manual');
        } catch {
          /* best effort — pool is already draining */
        }
        this.indexDetach(sessionId, id);
        throw new Error(
          `McpTransportPool is draining or unpooled ${id} was cancelled`,
        );
      }
      entry.markActive(snap.tools, snap.prompts);
      // Unpooled handle: snapshot replay through `view.applyTools` /
      // `applyPrompts` applies per-session `includeTools` / `excludeTools`
      // filtering and the per-session trust copy ( fix). Release
      // callback runs `forceShutdown` directly — no pool refcount
      // accounting for unpooled entries since they're per-session.
      const conn = entry.attach(sessionId, view, {
        release: () => {
          this.indexDetach(sessionId, id);
          void entry.forceShutdown('manual');
        },
      });
      return conn;
    } catch (err) {
      // same listener-
      // leak as the pooled spawn-failure path. The unpooled
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
      // : roll back the early reverse-index insertion above so
      // `sessionToEntries[sessionId]` does not accumulate stale ids
      // pointing at deleted entries. `indexDetach` is a no-op if the
      // failure happened before we ever indexed (e.g. an error in
      // `entries.set` itself, which is impossible today but defends
      // against future restructuring).
      this.indexDetach(sessionId, id);
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
   * deliberately excluded .
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
// `mcp-discovery-timeout.ts` so `PoolEntry.doRestart`
// can share the same primitives without cross-module value imports.

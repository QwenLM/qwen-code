/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { Config, MCPServerConfig } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  MCPServerStatus,
  type DiscoveredMCPPrompt,
  type McpClient,
  updateMCPServerStatus,
} from './mcp-client.js';
import type { DiscoveredMCPTool } from './mcp-tool.js';
import type { McpTransportKind } from './mcp-pool-key.js';
import {
  type ConnectionId,
  type PoolEntryState,
  type PoolEvent,
} from './mcp-pool-events.js';
import type { SessionMcpView } from './session-mcp-view.js';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';

const debugLogger = createDebugLogger('McpPool:Entry');

/**
 * Per-pool-entry tuning. Operators override defaults via the wrapping
 * `McpTransportPool` constructor; daemon CLI flags map there.
 */
export interface PoolEntryOptions {
  /** Grace period after last subscriber detach before close. Default 30s. */
  drainDelayMs: number;
  /**
   * Hard cap on idle time, started at first idle and NEVER reset by
   * acquire/release flap. Defense against thrashing clients. Default 5min.
   */
  maxIdleMs: number;
  /** Reconnect attempt cap before transitioning to `failed`. Default 3 for stdio/ws, 5 for http/sse. */
  maxReconnectAttempts: number;
  /** Reconnect delay strategy. */
  reconnectStrategy:
    | { kind: 'fixed'; delayMs: number }
    | { kind: 'exponential'; baseMs: number; capMs: number };
}

/**
 * Pool entry defaults by transport family. See §6.6 reconnect backoff
 * in the design doc.
 */
export function defaultPoolEntryOptions(
  transport: McpTransportKind,
): PoolEntryOptions {
  const isRemote = transport === 'http' || transport === 'sse';
  return {
    drainDelayMs: 30_000,
    maxIdleMs: 5 * 60_000,
    maxReconnectAttempts: isRemote ? 5 : 3,
    reconnectStrategy: isRemote
      ? { kind: 'exponential', baseMs: 1_000, capMs: 16_000 }
      : { kind: 'fixed', delayMs: 5_000 },
  };
}

/**
 * Handle returned to acquirers. Holds a session reference and the
 * subscription seat; callers `release()` to detach. Emits the same
 * `PoolEvent` discriminated union as the parent entry, but scoped
 * to the acquiring session (subscribers only see events from this
 * entry, not other pool entries).
 */
export interface PooledConnection {
  readonly id: ConnectionId;
  readonly serverName: string;
  readonly entryIndex: number;
  readonly client: McpClient;
  /** Current canonical tool snapshot. Re-issued on `toolsChanged`. */
  readonly toolsSnapshot: readonly DiscoveredMCPTool[];
  /** Current canonical prompt snapshot. Re-issued on `promptsChanged`. */
  readonly promptsSnapshot: readonly DiscoveredMCPPrompt[];
  on(event: 'event', listener: (e: PoolEvent) => void): this;
  off(event: 'event', listener: (e: PoolEvent) => void): this;
  /** Release this session's reference; pool starts drain when refs=0. */
  release(): void;
}

/**
 * Internal pool-entry record. Created once per `ConnectionId`,
 * holds the shared `McpClient` + its tool/prompt snapshots + ref
 * accounting + reconnect state.
 *
 * Lifecycle: `spawning` → `active` ⇄ (`active` ↔ reconnect via
 * disconnect/connect) → (`active` → `draining` on last detach,
 * `draining` → `active` on attach OR `draining` → `closed` on timer).
 *
 * Restart: external `restart()` triggers a manual disconnect+connect
 * cycle, bumping `generation` and re-emitting snapshots.
 */
export class PoolEntry {
  private localStatus: MCPServerStatus = MCPServerStatus.CONNECTING;
  private state: PoolEntryState = 'spawning';
  private _generation = 0;
  readonly refs = new Set<string>();
  private subscribers = new Map<string, SessionMcpView>();
  private subscriberHandles = new Map<string, PooledConnectionImpl>();
  toolsSnapshot: DiscoveredMCPTool[] = [];
  promptsSnapshot: DiscoveredMCPPrompt[] = [];
  private drainTimer?: NodeJS.Timeout;
  private maxIdleTimer?: NodeJS.Timeout;
  private firstIdleAt?: number;
  private restartInFlight?: Promise<void>;
  /**
   * Pool-wide event emitter for entry-scoped events. Each
   * `PooledConnection` registers a single listener that forwards
   * to the subscriber's callback list.
   */
  private readonly emitter = new EventEmitter();

  /**
   * @param id Stable ConnectionId (`name::fingerprint`).
   * @param serverName Server name as advertised in `MCPServerConfig`.
   * @param entryIndex Opaque, monotonic-within-name-group index for
   *   status-route exposure (V21-7). Stable across reconnect / drain
   *   grace; only changes when an entry is fully closed and a new
   *   one created for the same name.
   * @param cfg Original config used to create the entry (read-only
   *   from `PoolEntry`'s perspective; pool may create a new entry
   *   with a different cfg → different fingerprint → different id).
   * @param client Connected `McpClient` (caller has already called
   *   `client.connect()`).
   * @param cliConfig For `client.discoverAndReturn(cliConfig)` calls;
   *   pool injects the bootstrap-session config (which provides the
   *   workspace / trust context; per-session filtering happens later
   *   in `SessionMcpView`).
   * @param opts Entry-scoped tuning (drain, max idle, reconnect).
   * @param onClosed Pool-level callback fired when this entry
   *   transitions to `closed` so the pool can drop it from its map.
   */
  constructor(
    readonly id: ConnectionId,
    readonly serverName: string,
    readonly entryIndex: number,
    readonly cfg: MCPServerConfig,
    readonly client: McpClient,
    private readonly cliConfig: Config,
    private readonly opts: PoolEntryOptions,
    private readonly onClosed: (id: ConnectionId) => void,
    private readonly aggregateStatusByName: (name: string) => MCPServerStatus,
  ) {
    // Unbounded listener count — N session views may attach.
    this.emitter.setMaxListeners(0);
  }

  get generation(): number {
    return this._generation;
  }

  get currentState(): PoolEntryState {
    return this.state;
  }

  /**
   * Mark the initial spawn complete. Caller (pool) must call this
   * after constructing the entry, performing the initial discovery,
   * and seeding `toolsSnapshot` / `promptsSnapshot`.
   */
  markActive(
    initialTools: DiscoveredMCPTool[],
    initialPrompts: DiscoveredMCPPrompt[],
  ): void {
    this.toolsSnapshot = initialTools;
    this.promptsSnapshot = initialPrompts;
    this.state = 'active';
    this.localStatus = MCPServerStatus.CONNECTED;
    this.updateGlobalStatus();
  }

  /**
   * Attach a session subscriber. Returns the `PooledConnection`
   * handle for the caller to interact with (events, release).
   *
   * Snapshot replay (V21 C4 / §7.2): immediately invokes
   * `view.applyTools` / `view.applyPrompts` with the current
   * snapshots so the new subscriber doesn't miss state captured
   * between in-flight discover completion and this attach.
   *
   * Cancels drain timer (entry is no longer idle).
   */
  attach(
    sessionId: string,
    view: SessionMcpView,
    opts?: { skipReplay?: boolean; release?: () => void },
  ): PooledConnection {
    if (this.state === 'closed' || this.state === 'failed') {
      throw new Error(
        `Cannot attach to PoolEntry ${this.id} in state ${this.state}`,
      );
    }
    this.refs.add(sessionId);
    this.subscribers.set(sessionId, view);
    this.cancelDrainTimer();
    if (this.state === 'draining') this.state = 'active';

    // Snapshot replay: synchronously apply current state so the new
    // view doesn't see a transient empty state.
    //
    // skipReplay = true for the unpooled path (`createUnpooledConnection`)
    // — the session's McpClient has already registered tools/prompts
    // directly via the legacy `discover()` flow, and the view's
    // snapshot is empty. Without this gate, `applyTools([])` would
    // call `removeMcpToolsByServer` and wipe those registrations
    // (commit-2 review P1 #2 fix).
    if (this.state === 'active' && opts?.skipReplay !== true) {
      try {
        view.applyTools(this.toolsSnapshot);
        view.applyPrompts(this.promptsSnapshot);
      } catch (err) {
        debugLogger.error(
          `Snapshot replay failed for ${sessionId}/${this.serverName}: ${String(err)}`,
        );
      }
    }

    const handle = new PooledConnectionImpl(
      this,
      sessionId,
      view,
      opts?.release,
    );
    this.subscriberHandles.set(sessionId, handle);
    return handle;
  }

  /**
   * Detach a session subscriber. Tears down the subscriber's
   * registrations via `view.teardown()` and removes the ref.
   * Caller (pool) starts the drain timer when `refs.size === 0`.
   */
  detach(sessionId: string): void {
    const view = this.subscribers.get(sessionId);
    if (view) {
      try {
        view.teardown();
      } catch (err) {
        debugLogger.error(
          `View teardown failed for ${sessionId}/${this.serverName}: ${String(err)}`,
        );
      }
    }
    this.subscribers.delete(sessionId);
    this.subscriberHandles.delete(sessionId);
    this.refs.delete(sessionId);
  }

  /**
   * Start the grace-period drain timer. Cancelled by subsequent
   * `attach()`. Fires `forceShutdown()` on expiry.
   */
  startDrainTimer(delayMs: number): void {
    this.cancelDrainTimer();
    this.state = 'draining';
    // Track first-idle time for the hard MAX_IDLE cap; only set if
    // not already idle (don't reset on flap).
    if (this.firstIdleAt === undefined) {
      this.firstIdleAt = Date.now();
      this.maxIdleTimer = setTimeout(() => {
        debugLogger.warn(
          `PoolEntry ${this.id} hit MAX_IDLE_MS (${this.opts.maxIdleMs}ms); force-closing`,
        );
        void this.forceShutdown('max_idle');
      }, this.opts.maxIdleMs);
      // Don't block process exit.
      this.maxIdleTimer.unref?.();
    }
    this.drainTimer = setTimeout(() => {
      void this.forceShutdown('drain_timer');
    }, delayMs);
    this.drainTimer.unref?.();
  }

  cancelDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    // Reset first-idle tracking only when truly returning to active
    // with subscribers — not when attach happens mid-drain timer
    // (we want max-idle to cap thrashing).
    if (this.refs.size > 0) {
      if (this.maxIdleTimer) {
        clearTimeout(this.maxIdleTimer);
        this.maxIdleTimer = undefined;
      }
      this.firstIdleAt = undefined;
    }
  }

  /**
   * Force shutdown of this entry. Disconnects the client (caller is
   * responsible for descendant pid sweep BEFORE calling this — see
   * commit 3's `pid-descendants` integration in
   * `McpTransportPool.shutdownEntry`).
   *
   * Idempotent: repeated calls no-op once state === `closed` or
   * `failed`.
   */
  async forceShutdown(
    reason: 'drain_timer' | 'max_idle' | 'manual',
  ): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.cancelDrainTimer();
    if (this.maxIdleTimer) {
      clearTimeout(this.maxIdleTimer);
      this.maxIdleTimer = undefined;
    }
    // Notify any remaining subscribers BEFORE disconnecting so
    // pending callTool promises can route to MCPCallInterruptedError.
    this.emit({
      kind: 'disconnected',
      serverName: this.serverName,
      generation: this._generation,
      reason: 'transport_closed',
    });
    // Tear down all subscriber views in case the pool didn't
    // releaseSession explicitly (defense in depth).
    for (const [sid] of this.subscribers) {
      this.detach(sid);
    }
    // F2 commit 3: SIGTERM descendant processes BEFORE disconnecting
    // the MCP client. Wrapper processes (`npx`, `uvx`, `pnpm dlx`)
    // spawn the actual server as a grandchild; killing only the
    // wrapper via `client.disconnect()` would leak the real server.
    // Best-effort: pid lookup returns undefined for remote transports
    // or already-exited stdio children; sigtermPids tolerates per-
    // pid failures (ESRCH for already-dead pids).
    try {
      const rootPid = this.client.getTransportPid?.();
      if (rootPid !== undefined) {
        const descendants = await listDescendantPids(rootPid);
        if (descendants.length > 0) {
          const signaled = sigtermPids(descendants);
          debugLogger.debug(
            `Sent SIGTERM to ${signaled}/${descendants.length} descendants ` +
              `of pid ${rootPid} for ${this.id} (${reason})`,
          );
        }
      }
    } catch (err) {
      debugLogger.warn(
        `Descendant pid sweep failed for ${this.id}: ${String(err)}. Proceeding with disconnect.`,
      );
    }
    try {
      await this.client.disconnect();
    } catch (err) {
      debugLogger.error(
        `client.disconnect failed for ${this.id} (${reason}): ${String(err)}`,
      );
    }
    this.state = 'closed';
    this.localStatus = MCPServerStatus.DISCONNECTED;
    this.updateGlobalStatus();
    this.onClosed(this.id);
  }

  /**
   * Manual restart: disconnect + reconnect + re-discover. Coalesces
   * concurrent calls into a single in-flight promise so the restart
   * route (§13.2) and a parallel health-monitor reconnect can't race.
   */
  async restart(): Promise<void> {
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.doRestart().finally(() => {
      this.restartInFlight = undefined;
    });
    return this.restartInFlight;
  }

  private async doRestart(): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') {
      throw new Error(
        `Cannot restart PoolEntry ${this.id} in state ${this.state}`,
      );
    }
    const oldGen = this._generation;
    this._generation += 1;
    this.emit({
      kind: 'disconnected',
      serverName: this.serverName,
      generation: oldGen,
      reason: 'restart',
    });
    try {
      await this.client.disconnect();
    } catch (err) {
      debugLogger.debug(
        `Restart disconnect (best-effort) failed for ${this.id}: ${String(err)}`,
      );
    }
    await this.client.connect();
    const snap = await this.client.discoverAndReturn(this.cliConfig);
    // Generation guard: if a second restart raced in, drop our results.
    if (oldGen + 1 !== this._generation) {
      debugLogger.debug(
        `Restart of ${this.id} superseded by newer generation; discarding stale snapshot`,
      );
      return;
    }
    this.toolsSnapshot = snap.tools;
    this.promptsSnapshot = snap.prompts;
    this.localStatus = MCPServerStatus.CONNECTED;
    this.updateGlobalStatus();
    this.emit({
      kind: 'reconnected',
      serverName: this.serverName,
      generation: this._generation,
    });
    this.emit({
      kind: 'toolsChanged',
      serverName: this.serverName,
      snapshot: this.toolsSnapshot,
      generation: this._generation,
    });
    this.emit({
      kind: 'promptsChanged',
      serverName: this.serverName,
      snapshot: this.promptsSnapshot,
      generation: this._generation,
    });
  }

  /**
   * Fire an event to all subscribers. Stays inside the entry's
   * EventEmitter so `PooledConnection.on('event', cb)` and
   * `removeListener` work correctly.
   */
  emit(event: PoolEvent): void {
    this.emitter.emit('event', event);
  }

  internalOn(listener: (e: PoolEvent) => void): void {
    this.emitter.on('event', listener);
  }

  internalOff(listener: (e: PoolEvent) => void): void {
    this.emitter.off('event', listener);
  }

  /**
   * Write the aggregated status (`any-CONNECTED-wins` across entries
   * with same `serverName`, per §8.1) into the process-global
   * `serverStatuses` Map. Pool delegates the aggregation function
   * because only the pool can see sibling entries.
   */
  private updateGlobalStatus(): void {
    const aggregated = this.aggregateStatusByName(this.serverName);
    updateMCPServerStatus(this.serverName, aggregated);
  }

  /** Local status for the pool's aggregator. Not part of public API. */
  getLocalStatus(): MCPServerStatus {
    return this.localStatus;
  }
}

/**
 * Public-facing connection handle. Wraps an entry-scoped event
 * listener so subscribers can `release()` cleanly without leaking
 * listeners.
 */
class PooledConnectionImpl implements PooledConnection {
  private readonly listeners = new Set<(e: PoolEvent) => void>();
  private released = false;

  constructor(
    private readonly entry: PoolEntry,
    readonly sessionId: string,
    // View kept for parity / future use (e.g. per-subscriber filters).
    _view: SessionMcpView,
    // Pool-supplied release callback. Wired by `pool.acquire` to call
    // `pool.release(id, sessionId)` so subscribers can `handle.release()`
    // without needing a pool reference (commit-2 review P1 #1 fix).
    private readonly releaseCallback?: () => void,
  ) {}

  get id(): ConnectionId {
    return this.entry.id;
  }
  get serverName(): string {
    return this.entry.serverName;
  }
  get entryIndex(): number {
    return this.entry.entryIndex;
  }
  get client(): McpClient {
    return this.entry.client;
  }
  get toolsSnapshot(): readonly DiscoveredMCPTool[] {
    return this.entry.toolsSnapshot;
  }
  get promptsSnapshot(): readonly DiscoveredMCPPrompt[] {
    return this.entry.promptsSnapshot;
  }

  on(event: 'event', listener: (e: PoolEvent) => void): this {
    if (event !== 'event') return this;
    this.listeners.add(listener);
    this.entry.internalOn(listener);
    return this;
  }

  off(event: 'event', listener: (e: PoolEvent) => void): this {
    if (event !== 'event') return this;
    this.listeners.delete(listener);
    this.entry.internalOff(listener);
    return this;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    // Detach all our listeners to avoid leaks (the entry may live
    // beyond this connection in the drain window).
    for (const l of this.listeners) {
      this.entry.internalOff(l);
    }
    this.listeners.clear();
    // Invoke the pool-supplied release callback so refs are properly
    // dropped and the drain timer can start at refs=0. Commit-2
    // review P1 #1 fix: prior to wiring this callback, calling
    // handle.release() was a no-op and leaked refs until the
    // session's `releaseSession` bulk-cleanup fired.
    this.releaseCallback?.();
  }
}

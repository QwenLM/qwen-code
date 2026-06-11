/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { Config, MCPServerConfig } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  addMCPStatusChangeListener,
  MCPServerStatus,
  removeMCPStatusChangeListener,
  type DiscoveredMCPPrompt,
  type McpClient,
  updateMCPServerStatus,
} from './mcp-client.js';
import type { DiscoveredMCPTool } from './mcp-tool.js';
import { mcpTransportOf, type McpTransportKind } from './mcp-pool-key.js';
import {
  type ConnectionId,
  type PoolEntryState,
  type PoolEvent,
} from './mcp-pool-events.js';
import type { SessionMcpView } from './session-mcp-view.js';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';
import {
  discoveryTimeoutFor,
  runWithTimeout,
} from './mcp-discovery-timeout.js';

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
 * Pool entry defaults by transport family. See reconnect backoff
 * in the design doc.
 */
export function defaultPoolEntryOptions(
  transport: McpTransportKind,
): PoolEntryOptions {
  // include
  // 'websocket' in the remote set so the classification matches
  // `discoveryTimeoutFor` in `mcp-discovery-timeout.ts:47`
  // (`!!(cfg.httpUrl || cfg.url || cfg.tcp)` — websocket configs
  // populate `cfg.tcp`/`cfg.url` and got the 5s remote discovery
  // timeout). Pre-fix websocket got remote-style discovery timing
  // (5s) but local-style reconnect timing (3 attempts, fixed 5s
  // delay).
  // NOTE: `maxReconnectAttempts` and `reconnectStrategy` are
  // currently unconsumed by any pool code path (pool mode has no
  // health monitor — see `mcp-client-manager.ts:1383-1386`); the
  // classification alignment is forward-looking for when the
  // health monitor lands. Keeping the field populated rather than
  // removing it because the design doc declares both as part of
  // the entry-options contract.
  const isRemote =
    transport === 'http' || transport === 'sse' || transport === 'websocket';
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
 * structured outcome of
 * `PoolEntry.sweepAndDisconnect`. The silent-drop fire-and-forget
 * caller (the silent-drop block inside `statusChangeListener`)
 * reads this off the chained promise to surface orphan-process
 * pressure to operators via a structured `warn` log. `forceShutdown`
 * and `doRestart` callers ignore the return — their own catch paths
 * carry richer error signals already.
 *
 * Both `descendantsFound` and `descendantsSignaled` are tracked
 * because partial-signal failure (`signaled < found`) is itself
 * orphan-process-pressure evidence even when the sweep itself does
 * NOT throw — e.g. a child exited between `listDescendantPids` and
 * `sigtermPids`, OR EPERM on a child the daemon doesn't own.
 *
 * Internal — NOT exported. The sweep result never crosses the wire
 * (pool events stay shape-compatible per `PoolEvent` union); this
 * type only exists to give the in-process caller something to chain
 * a log decision on.
 */
interface SweepResult {
  /** Set when `listDescendantPids` itself threw (sandbox blocking pgrep, ESRCH on root, etc.). */
  pidSweepError?: Error;
  /** Number of descendant pids `listDescendantPids` returned. Undefined if root pid unavailable or sweep threw. */
  descendantsFound?: number;
  /** Number of descendant pids `sigtermPids` successfully signaled. May be < `descendantsFound`. */
  descendantsSignaled?: number;
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
   * set
   * SYNCHRONOUSLY at the top of `doRestart` (before any side effects).
   * Distinct from `restartInFlight` which only becomes truthy AFTER
   * `doRestart()` returns its Promise — the status listener
   * fires synchronously inside `client.disconnect()`'s
   * `updateMCPServerStatus` call (via `sweepAndDisconnect`), which
   * happens BEFORE `restart()`'s `this.restartInFlight = ...` assignment.
   * Without this flag the listener would trip the 'failed'
   * transition mid-restart, aborting the restart at the state guard.
   */
  private restartInProgress = false;
  /**
   * Pool-wide event emitter for entry-scoped events. Each
   * `PooledConnection` registers a single listener that forwards
   * to the subscriber's callback list.
   */
  private readonly emitter = new EventEmitter();

  /**
   * status change
   * listener registered against the module-level `serverStatuses`
   * registry. McpClient.onerror flips the GLOBAL map to DISCONNECTED
   * on transport drop, but pool's `aggregateStatusByName` reads each
   * entry's `localStatus` and "any-CONNECTED-wins" overwrites
   * back. Without this listener, a transport drop would leave
   * `localStatus = CONNECTED` permanently while the actual transport
   * is dead, and snapshot consumers see lying status.
   *
   * Stored so `forceShutdown` can detach to avoid leaking listeners
   * on the module-level array across entry recreate.
   */
  private statusChangeListener?: Parameters<
    typeof addMCPStatusChangeListener
  >[0];

  /**
   * Re-entry guard: when our own `updateGlobalStatus` writes to the
   * module-level map, the status-change listener will fire back at
   * us. Skip those echoes (we already know our localStatus).
   */
  private suppressNextStatusEcho = false;

  /**
   * @param id Stable ConnectionId (`name::fingerprint`).
   * @param serverName Server name as advertised in `MCPServerConfig`.
   * @param entryIndex Opaque, monotonic-within-name-group index for
   *   status-route exposure. Stable across reconnect / drain
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
    // `cfg` carries
    // secrets (env API keys, header auth tokens, OAuth fields) and
    // must NOT be exposed publicly on the entry. Pool callers that
    // need transport classification go through `transportKind`
    // getter (computed via mcpTransportOf) instead of reading cfg
    // directly. Internal: cliConfig/opts/onClosed already private.
    private readonly cfg: MCPServerConfig,
    readonly client: McpClient,
    private readonly cliConfig: Config,
    private readonly opts: PoolEntryOptions,
    private readonly onClosed: (id: ConnectionId) => void,
    private readonly aggregateStatusByName: (name: string) => MCPServerStatus,
  ) {
    // Unbounded listener count — N session views may attach.
    this.emitter.setMaxListeners(0);

    // subscribe to McpClient's
    // module-level status writes (CONNECTING / CONNECTED /
    // DISCONNECTED). When the underlying SDK transport dies and
    // McpClient.onerror writes DISCONNECTED, we need to mirror it
    // into `localStatus` so subsequent `aggregateStatusByName` calls
    // surface accurate state. Filter by serverName; ignore removal
    // notifications (`status === undefined` after disable/uninstall).
    //
    // the module-level
    // `serverStatuses` map is shared across all entries for the same
    // `serverName`. When two entries A and B share a name (different
    // fingerprints — e.g. divergent OAuth tokens), entry A's
    // transport error writes DISCONNECTED to the shared map, and B's
    // listener fires with that status — corrupting B's `localStatus`
    // even though B's transport is healthy. Cross-check the incoming
    // `status` against `this.client.getStatus()` (per-entry truth)
    // so a sibling's status write doesn't bleed into our state.
    this.statusChangeListener = (name, status) => {
      if (name !== this.serverName) return;
      if (status === undefined) return;
      if (this.suppressNextStatusEcho) {
        this.suppressNextStatusEcho = false;
        return;
      }
      if (this.client.getStatus() !== status) return;
      if (status === this.localStatus) return;
      this.localStatus = status;
      // Do NOT call updateGlobalStatus here — it would loop back via
      // the listener. McpClient already wrote the authoritative
      // status to the module-level map; our job is to mirror it
      // into localStatus only.
      //
      //
      // transition the entry to terminal state when localStatus flips
      // to DISCONNECTED on a currently-active entry. Pre-fix the
      // transport could die silently (server crash, EPIPE, network
      // drop) and McpClient.onerror would write DISCONNECTED, but
      // `state` stayed `'active'` — only `forceShutdown` and
      // `doRestart`'s catch path transitioned state to terminal. A
      // subsequent `pool.acquire` for the same fingerprint hit the
      // fast-path (`mcp-transport-pool.ts:226-249`), `existing.attach`
      // only rejected on closed/failed, so it attached to the zombie
      // entry, replayed the stale snapshot, and the new session's
      // tool calls all failed on the dead transport. Pool mode has
      // no health monitor (`mcp-client-manager.ts:1383-1386`) so
      // there was no auto-recovery — operator had to manually
      // `POST /workspace/mcp/<name>/restart`. Now: emit `failed`
      // synchronously so the manager-side `onFailed` listener
      // (`mcp-client-manager.ts:1531-1538`) evicts the dead handle
      // from `pooledConnections`, AND set `state='failed'` so the
      // next fast-path `acquire` short-circuits to a fresh spawn via
      // `attach`'s state guard. `localStatus = DISCONNECTED` was
      // already set above; mirrors the sync ordering invariant.
      //
      // Gate on `!this.restartInProgress`: `doRestart`'s `sweepAndDisconnect`
      // intentionally disconnects the client mid-restart, which would
      // otherwise trip this listener and flip state to 'failed' before
      // the reconnect completes. Restart's own catch path handles the
      // 'failed' transition on a reconnect FAILURE; the restart's
      // success path leaves state='active'. Don't preempt that.
      //
      // also
      // catch DISCONNECTED in the 'draining' state. Pre-fix the gate
      // only triggered on 'active', so during the 30s drain window a
      // silent transport drop did NOT flip state→'failed'. A fresh
      // acquire arriving inside that window would hit the fast-path,
      // `attach()` flipped 'draining' → 'active' (cancelling drain
      // timer) and replayed the stale snapshot — exact same zombie-
      // attach failure was meant to prevent, just shifted into
      // the drain window. Cancel the drain timer on the 'draining'
      // path so the now-terminal entry doesn't fire its old
      // `forceShutdown('drain_timer')` after we've already evicted.
      if (
        status === MCPServerStatus.DISCONNECTED &&
        (this.state === 'active' || this.state === 'draining') &&
        !this.restartInProgress
      ) {
        const wasDraining = this.state === 'draining';
        this.state = 'failed';
        if (wasDraining) {
          this.cancelDrainTimer();
        }
        // full
        // terminal cleanup parity with `forceShutdown` (line 549-608).
        // Pre-fix the path only set state + emitted +
        // removed the status listener, leaving:
        //   - `maxIdleTimer` armed → fired later against an
        //     already-terminal entry (no-op via forceShutdown
        //     idempotency, but a leaked Node timer reference)
        //   - subscribers still attached → views held stale ref to a
        //     dead entry until session releaseSession bulk-cleanup
        //   - `pool.entries.get(id)` STILL returned this entry →
        //     next acquire fast-path hit `existing.attach()` which
        //     rejects on terminal state → "Cannot attach to PoolEntry
        //     in state failed" surfaced to caller, no self-heal. Pool
        //     mode has no health monitor, so the only recovery path
        //     was operator-triggered `/restart`. With `onClosed`
        //     wired below, the pool drops the entry from `entries`
        //     and the next acquire falls through to a fresh spawn.
        if (this.maxIdleTimer) {
          clearTimeout(this.maxIdleTimer);
          this.maxIdleTimer = undefined;
        }
        // Detach the status listener now that we're terminal
        // mirrors the cleanup symmetry in forceShutdown / doRestart
        // catch (otherwise the listener leaks across entry recreation).
        if (this.statusChangeListener) {
          removeMCPStatusChangeListener(this.statusChangeListener);
          this.statusChangeListener = undefined;
        }
        //
        // log the silent drop so operators tailing `--debug` see
        // which server / when / what state, mirroring the doRestart
        // catch path's `debugLogger.error`. Pre-fix the only signal
        // was the `'failed'` event itself; manager-side `onFailed`
        // silently deletes from `pooledConnections` without logging
        // a cause.
        debugLogger.error(
          `PoolEntry ${this.id} silent transport drop ` +
            `(prev state='${wasDraining ? 'draining' : 'active'}', ` +
            `localStatus→DISCONNECTED). ` +
            `Transitioning to 'failed'; evicting from pool.entries + ` +
            `pooledConnections (W122 R20).`,
        );
        // Emit BEFORE subscriber detach so subscribers receive the
        // 'failed' event and can route any pending callTool promises
        // to MCPCallInterruptedError. Mirrors forceShutdown's
        // emit→detach ordering at line 583-593.
        //
        // thread the upstream
        // McpClient.onerror cause (EPIPE, OAuth 401, server crash)
        // into `lastError` instead of emitting only the synthetic
        // marker. Pre-fix the only diagnostic carrier was the synthetic
        // string; operators triaging a 'failed' event had to grep
        // daemon `--debug` logs for the matching `MCP ERROR (...)` line
        // out of band. Now the actual error message is on the wire.
        // Preserves the literal `"silent transport drop"` substring so
        // any operator log-grep tooling that targets the pre-fix marker
        // keeps matching post-fix.
        const upstreamError = this.client.getLastTransportError();
        this.emit({
          kind: 'failed',
          serverName: this.serverName,
          generation: this._generation,
          lastError: upstreamError
            ? `transport disconnected (silent transport drop): ${upstreamError.message}`
            : 'transport disconnected (silent transport drop)',
        });
        // Detach all subscriber views. Snapshot keys
        // because detach mutates `subscribers`.
        for (const [sid] of [...this.subscribers]) {
          this.detach(sid);
        }
        // Ordering fix: chain `updateGlobalStatus` AFTER
        // `sweepAndDisconnect` resolves. Pre-fix the followup
        // called `updateGlobalStatus` synchronously BEFORE the void
        // sweep had run, so the sweep's later `client.disconnect()`
        // — which unconditionally writes
        // `updateMCPServerStatus(name, DISCONNECTED)` at
        // `mcp-client.ts:250` — overwrote the aggregate we just set.
        // For a multi-fingerprint server with an alive sibling,
        // global map flapped CONNECTED (sync) → DISCONNECTED (sweep
        // tail), self-healing only on the next sibling status event.
        // Now: keep the synchronous best-effort write (covers any
        // reader between now and sweep settle), AND chain a second
        // `updateGlobalStatus` onto the sweep so it lands AFTER
        // `client.disconnect()`'s stale write. Both calls are
        // idempotent — `aggregateStatusByName` reads only `localStatus`
        // of remaining entries, and our entry is removed from
        // `pool.entries` by `onClosed` below before either runs the
        // second time.
        //
        // `void` on the chain is intentional — we can't await in a
        // sync listener, and best-effort is the right shape for
        // wrapper-grandchild SIGTERM cleanup (the transport is
        // already dead via the McpClient.onerror that triggered us).
        // Errors inside the chain log at warn/error via
        // `sweepAndDisconnect`'s own catches.
        void this.sweepAndDisconnect('silent_drop').then(
          (result) => {
            // surface orphan-process
            // pressure to operators. Two failure shapes worth a
            // structured `warn` here:
            //   (a) `pidSweepError`: pid-discovery itself threw
            //       (pgrep blocked by sandbox, ESRCH at root pid,
            //       etc.). We may have leaked descendants we never
            //       enumerated.
            //   (b) Partial signal: discovery succeeded but
            //       `sigtermPids` killed fewer than discovered
            //       (some children already exited between listing
            //       and signaling, OR EPERM on a child the daemon
            //       doesn't own). Less alarming than (a) but still
            //       worth surfacing during silent drops.
            // Pre-fix `void` discarded both signals; the only
            // observability path was tailing `--debug warn+` for
            // the inner `sweepAndDisconnect` log line out of band.
            const partialSignal =
              result.descendantsFound !== undefined &&
              result.descendantsSignaled !== undefined &&
              result.descendantsSignaled < result.descendantsFound;
            if (result.pidSweepError !== undefined || partialSignal) {
              //
              // log `'unknown'` instead of `0` when the count fields are
              // undefined. They are undefined ONLY in the
              // `pidSweepError` branch (the throw happened before
              // assignment); operators triaging the warn should be able
              // to distinguish "0 found" (sweep succeeded, no children
              // — unusual but possible if grandchildren already exited)
              // from "not measured" (sweep itself threw, count is
              // genuinely unknown). Logging `0` for both was factually
              // ambiguous.
              debugLogger.warn(
                `PoolEntry ${this.id} silent-drop sweep observability: ` +
                  `descendantsFound=${result.descendantsFound ?? 'unknown'}, ` +
                  `descendantsSignaled=${result.descendantsSignaled ?? 'unknown'}, ` +
                  `pidSweepError=${result.pidSweepError?.message ?? 'none'}. ` +
                  `Possible orphan-process pressure — operator should ` +
                  `check for lingering subprocess descendants of the dead ` +
                  `transport.`,
              );
            }
            this.updateGlobalStatus();
          },
          () => {
            // sweepAndDisconnect catches its own errors; this branch
            // is unreachable in practice. Defense against a future
            // refactor that makes the helper rejectable.
            this.updateGlobalStatus();
          },
        );
        // Synchronous best-effort: covers any aggregator-reader
        // racing between now and the sweep's tail. Mirrors
        // forceShutdown line 606. With the chained call above this
        // becomes a leading edge of "eventually correct".
        this.updateGlobalStatus();
        // Notify the pool so it drops this entry from `pool.entries`
        // The next `pool.acquire(serverName, cfg)` for the
        // same fingerprint will then miss the fast-path lookup and
        // fall through to spawn a fresh entry — pool self-heals
        // after a silent transport drop without operator intervention.
        this.onClosed(this.id);
      }
    };
    addMCPStatusChangeListener(this.statusChangeListener);
  }

  get generation(): number {
    return this._generation;
  }

  get currentState(): PoolEntryState {
    return this.state;
  }

  /**
   * Transport family classification for snapshot consumers (e.g.
   * `subprocessCount` in `pool.getSnapshot()`). Exposed as a getter
   * instead of letting callers read `entry.cfg` so secrets in `cfg`
   * (env API keys, header auth tokens, OAuth fields) stay
   * encapsulated.
   */
  get transportKind(): McpTransportKind {
    return mcpTransportOf(this.cfg);
  }

  /**
   * public terminal-
   * state probe. Lets callers short-circuit before invoking
   * `markActive` / `attach` when a concurrent `forceShutdown` has
   * already torn the entry down (e.g. an unpooled connect/discover
   * window racing `releaseSession`).
   */
  isTerminated(): boolean {
    return this.state === 'closed' || this.state === 'failed';
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
    // never resurrect a
    // torn-down entry. `forceShutdown` may run concurrently with the
    // unpooled connect/discover window in `createUnpooledConnection`;
    // without this guard, `markActive` would overwrite `state='closed'`
    // back to `'active'`, letting `attach()` succeed against a
    // disconnected client.
    if (this.state === 'closed' || this.state === 'failed') return;
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
   * Snapshot replay : immediately invokes
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
    const previousState = this.state;
    const hadRef = this.refs.has(sessionId);
    const previousView = this.subscribers.get(sessionId);
    const previousHandle = this.subscriberHandles.get(sessionId);
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
    // call `removeMcpToolsByServer` and wipe those registrations.
    if (this.state === 'active' && opts?.skipReplay !== true) {
      try {
        view.applyTools(this.toolsSnapshot);
        view.applyPrompts(this.promptsSnapshot);
      } catch (err) {
        if (!hadRef) {
          this.refs.delete(sessionId);
          this.subscribers.delete(sessionId);
          this.subscriberHandles.delete(sessionId);
          try {
            view.teardown();
          } catch {
            /* best effort rollback */
          }
        } else if (previousView) {
          this.subscribers.set(sessionId, previousView);
          if (previousHandle) {
            this.subscriberHandles.set(sessionId, previousHandle);
          }
        }
        if (previousState === 'draining' && this.refs.size === 0) {
          this.startDrainTimer(this.opts.drainDelayMs);
        } else {
          this.state = previousState;
        }
        debugLogger.error(
          `Snapshot replay failed for ${sessionId}/${this.serverName}: ${String(err)}`,
        );
        throw err;
      }
    }

    const handle = new PooledConnectionImpl(this, sessionId, opts?.release);
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
        // the C2 fix
        // intentionally lets `maxIdleTimer` survive attach/detach
        // flap so the hard cap measures wall-clock from FIRST idle
        // — but the timer's fire-action must still respect current
        // refs. Pre-fix: a session re-attached inside the 30s drain
        // grace, used the entry for 4+ minutes, then `maxIdleTimer`
        // (started at the first detach) fired and force-closed an
        // actively-used entry. The session would then permanently
        // lose this server's tools because nothing re-acquires from
        // outside — `discoverAllMcpToolsViaPool` only runs at
        // discovery-pass boundaries and pool-mode disables health
        // checks. Now: if there are active refs, the timer is a
        // no-op that resets `firstIdleAt` so the next idle window
        // gets a fresh hard cap.
        if (this.refs.size > 0) {
          debugLogger.debug(
            `PoolEntry ${this.id} max-idle reached but ${this.refs.size} ` +
              `sessions active; deferring close, resetting first-idle window`,
          );
          this.maxIdleTimer = undefined;
          this.firstIdleAt = undefined;
          return;
        }
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
    // the maxIdle hard
    // cap is intentionally NEVER reset by attach/detach flap. Pre-fix
    // this code cleared `maxIdleTimer` + `firstIdleAt` whenever
    // `refs.size > 0`, but `attach()` adds the ref BEFORE calling
    // `cancelDrainTimer`, so the condition was always true and the
    // hard cap got reset on every attach — completely defeating its
    // purpose (per design: "started at first idle and NEVER
    // reset"). Now `cancelDrainTimer` only cancels the drain grace
    // timer; the maxIdle timer survives the entire entry lifetime
    // and is only cleared by `forceShutdown` (which is the entry's
    // terminal transition).
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
    // flip state to
    // `'closed'` SYNCHRONOUSLY before any await. Pre-fix this
    // assignment lived at line 361, after `await listDescendantPids`
    // and `await client.disconnect()` — during those yields a
    // concurrent `acquire` would call `attach()`, which only
    // rejects 'closed'/'failed', and would return a handle to an
    // entry mid-teardown (zombie connection). Now any concurrent
    // attach sees 'closed' immediately and rejects.
    this.state = 'closed';
    // missed sibling of
    // C4 fix. Pre-fix `localStatus = DISCONNECTED` happened AFTER
    // `await sweepAndDisconnect` — during that async yield,
    // `getSnapshot()` / `aggregateStatusByName` reading
    // `entry.getLocalStatus()` still returned `CONNECTED` for an
    // entry mid-teardown. Set it synchronously alongside `state` so
    // any concurrent reader sees a consistent (closed, disconnected)
    // pair.
    this.localStatus = MCPServerStatus.DISCONNECTED;
    this.suppressNextStatusEcho = true;
    this.cancelDrainTimer();
    if (this.maxIdleTimer) {
      clearTimeout(this.maxIdleTimer);
      this.maxIdleTimer = undefined;
    }
    // Detach the module-level status listener now that this entry
    // is terminal — leaving it attached would leak across entry
    // recreation.
    if (this.statusChangeListener) {
      removeMCPStatusChangeListener(this.statusChangeListener);
      this.statusChangeListener = undefined;
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
    // SIGTERM descendant
    // processes + disconnect via the shared `sweepAndDisconnect`
    // helper. Wrapper processes (`npx`, `uvx`, `pnpm dlx`) spawn the
    // actual server as a grandchild; killing only the wrapper via
    // `client.disconnect()` alone would leak the real server. The
    // helper unifies the sweep+disconnect pattern across
    // `forceShutdown` AND `doRestart` (both pre- and failure-
    // paths) so future changes to either step happen in one place.
    await this.sweepAndDisconnect(reason);
    // state + localStatus already set synchronously above.
    // Just propagate the now-stable status into
    // the module-global map for cross-name aggregators.
    this.updateGlobalStatus();
    this.onClosed(this.id);
  }

  /**
   * shared sweep +
   * disconnect helper used by `forceShutdown` AND `doRestart` (both
   * pre-call and failure path). Pre-fix the same try/catch pair was
   * duplicated 3 ways with different log levels — drift target.
   *
   * Order matters: descendant pids SIGTERMed BEFORE
   * `client.disconnect()` so wrapper grandchildren (`npx`, `uvx`,
   * `pnpm dlx`) get killed before their parent's transport closes.
   * Best-effort throughout: per-pid failures tolerated by
   * `sigtermPids`'s ESRCH-tolerant loop; pid lookup returns
   * undefined for remote transports / already-exited stdio children.
   *
   * Log levels: pid-sweep failure at `warn`
   * (operator should investigate orphan-process pressure);
   * disconnect failure at `error` (a stuck disconnect is rarer and
   * usually indicates a transport bug worth surfacing). Pre-
   * `doRestart` had logged both at `debug` — production
   * observability gap that masked PID exhaustion.
   *
   * now returns a `SweepResult` so the
   * silent-drop fire-and-forget caller (which `void`-discards the
   * promise and would otherwise lose the orphan-process-pressure
   * signal entirely) can chain a structured warn log when either pid
   * sweep threw or `sigtermPids` partially signaled. The `forceShutdown`
   * and `doRestart` callers continue to ignore the return value (their
   * caller-side `await` discards it) — those paths already carry rich
   * error signals via their own catches and don't need the extra
   * surface. The internal log lines stay unchanged for backward
   * compat with existing log-tail tooling.
   */
  private async sweepAndDisconnect(reason: string): Promise<SweepResult> {
    const result: SweepResult = {};
    try {
      const rootPid = this.client.getTransportPid?.();
      if (rootPid !== undefined) {
        const descendants = await listDescendantPids(rootPid);
        if (descendants.length > 0) {
          result.descendantsFound = descendants.length;
          result.descendantsSignaled = sigtermPids(descendants);
          debugLogger.debug(
            `Sent SIGTERM to ${result.descendantsSignaled}/${descendants.length} descendants ` +
              `of pid ${rootPid} for ${this.id} (${reason})`,
          );
        }
      }
    } catch (err) {
      result.pidSweepError =
        err instanceof Error ? err : new Error(String(err));
      debugLogger.warn(
        `Descendant pid sweep failed for ${this.id} (${reason}): ${String(
          err,
        )}. Proceeding with disconnect.`,
      );
    }
    try {
      await this.client.disconnect();
    } catch (err) {
      // Disconnect failure is rare (usually a transport bug worth
      // surfacing) and gets a structured error log here. No
      // SweepResult field captures this — the silent-drop chain
      // doesn't gate the outer warn on it (the inner error log
      // already gives operators the signal), and forceShutdown /
      // doRestart callers ignore the return entirely.
      // Note: was previously stored on `SweepResult.disconnectError`
      // but had no reader — removed as dead data.
      debugLogger.error(
        `client.disconnect failed for ${this.id} (${reason}): ${String(err)}`,
      );
    }
    return result;
  }

  /**
   * Manual restart: disconnect + reconnect + re-discover. Coalesces
   * concurrent calls into a single in-flight promise so the restart
   * route and a parallel health-monitor reconnect can't race.
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
    // set
    // the in-progress flag SYNCHRONOUSLY at the top of doRestart so
    // the listener (which fires synchronously inside the
    // upcoming `client.disconnect()` → `updateMCPServerStatus` chain)
    // skips its 'failed' transition for this entry's intentional
    // mid-restart disconnect. `restartInFlight` is set by the outer
    // `restart()` wrapper AFTER doRestart returns its Promise — too
    // late to gate the synchronous listener fire. Cleared by the
    // `finally` wrapper around `doRestartInner` (pre-fix
    // this comment said "Cleared in the success-path tail
    // AND every throw path below", but the actual mechanism is
    // try/finally — there are no per-path manual clears).
    this.restartInProgress = true;
    try {
      return await this.doRestartInner();
    } finally {
      this.restartInProgress = false;
    }
  }

  private async doRestartInner(): Promise<void> {
    // restart
    // supersedes drain. Pre-fix the entry could be in `'draining'`
    // state (refs=0, both `drainTimer` AND `maxIdleTimer` running)
    // when `restartByName` arrived; either timer firing during
    // `doRestart`'s awaits would call `forceShutdown` → entry
    // removed from `pool.entries`, subscribers detached. Then
    // `doRestart` resumes with `client.connect()` spawning a fresh
    // subprocess the pool no longer tracks. The drain fix cancelled
    // `drainTimer` but missed the `maxIdleTimer` sibling —
    // its fire-action's `refs.size > 0` check still fails when refs
    // are 0 mid-restart. Cancel BOTH timers + reset `firstIdleAt`
    // so a future detach starts a fresh idle window, and transition
    // `'draining' → 'active'` so the restart completes atomically.
    this.cancelDrainTimer();
    if (this.maxIdleTimer) {
      clearTimeout(this.maxIdleTimer);
      this.maxIdleTimer = undefined;
    }
    this.firstIdleAt = undefined;
    if (this.state === 'draining') {
      this.state = 'active';
    }
    const oldGen = this._generation;
    this._generation += 1;
    this.emit({
      kind: 'disconnected',
      serverName: this.serverName,
      generation: oldGen,
      reason: 'restart',
    });
    // sweep +
    // disconnect via the shared `sweepAndDisconnect` helper. Pre-fix
    // `client.disconnect` alone killed only the wrapper (npx /
    // uvx / pnpm dlx), letting the actual MCP server grandchild
    // survive as an orphan. The helper mirrors `forceShutdown`'s
    // sweep + disconnect with identical log levels (warn for sweep
    // failures, error for disconnect failures).
    await this.sweepAndDisconnect('restart');
    // wrap connect +
    // discover in try/catch. Pre-fix a thrown `client.connect()` or
    // `client.discoverAndReturn()` propagated up to `restartByName`
    // but left the entry in zombie state: `localStatus` still
    // CONNECTED (never updated on the failure path), `state` still
    // `active`, snapshot pointing at the pre-restart tools — pool
    // snapshot lies, subsequent acquires reuse the broken entry.
    // On failure: transition to `'failed'` terminal state so
    // `aggregateStatusByName` reflects reality and the next
    // `pool.acquire` for this fingerprint spawns a fresh entry.
    let snap: {
      tools: DiscoveredMCPTool[];
      prompts: DiscoveredMCPPrompt[];
    };
    try {
      // bound the
      // restart's connect+discover with the same wall-clock timeout
      // `spawnEntry` uses. Pre-fix a hung server during a
      // restart blocked `restartInFlight` indefinitely; because
      // `restart()` coalesces concurrent callers onto the same
      // promise, every subsequent restart attempt also hung forever
      // and the HTTP restart-route handler never returned. The
      // timeout falls through to the existing catch (which sweeps
      // descendants and transitions to `'failed'`).
      const timeoutMs = discoveryTimeoutFor(this.cfg);
      snap = await runWithTimeout(
        (async () => {
          await this.client.connect();
          // pool
          // restart path opts out of applyConfigFilters; per-session
          // SessionMcpView is the authoritative filter (mirrors the
          // pool spawn path in mcp-transport-pool.ts).
          return this.client.discoverAndReturn(this.cliConfig, {
            applyConfigFilters: false,
          });
        })(),
        timeoutMs,
        `pool restart for ${this.id}`,
      );
    } catch (err) {
      debugLogger.error(
        `Restart of ${this.id} failed at connect/discover: ${String(err)}. Transitioning to 'failed'.`,
      );
      // the failure
      // catch previously skipped the descendant pid sweep, leaving
      // grandchildren of the partially-spawned new transport (npx /
      // uvx wrappers that finished the prelude before connect or
      // discover threw) as orphans. `sweepAndDisconnect` here
      // targets the NEW transport's pid (the OLD transport was
      // already disconnected pre-attempt). Best-effort; per-pid
      // failures tolerated by sigtermPids inside the helper.
      await this.sweepAndDisconnect('restart_failed');
      this.state = 'failed';
      this.localStatus = MCPServerStatus.DISCONNECTED;
      this.suppressNextStatusEcho = true;
      this.updateGlobalStatus();
      // Detach the status listener — terminal state mirrors forceShutdown.
      if (this.statusChangeListener) {
        removeMCPStatusChangeListener(this.statusChangeListener);
        this.statusChangeListener = undefined;
      }
      this.emit({
        kind: 'failed',
        serverName: this.serverName,
        generation: this._generation,
        lastError: err instanceof Error ? err.message : String(err),
      });
      // Detach all subscribers since the entry is terminal — they'll
      // get the `failed` event above and remove this server's tools
      // from their session registries via SessionMcpView.teardown.
      for (const [sid] of this.subscribers) {
        this.detach(sid);
      }
      this.onClosed(this.id);
      throw err;
    }
    // Generation guard: if a second restart raced in, drop our results.
    //
    // also sweep the
    // newly-spawned transport before returning. `client.connect()`
    // above already spawned the new subprocess (npx/uvx/pnpm dlx
    // wrapper + MCP server grandchild); the OLD transport was
    // disconnected via `sweepAndDisconnect('restart')` pre-attempt,
    // so the new spawn would otherwise leak as net-new orphans. Same
    // class of leak that prior fixes were designed to prevent;
    // applying their pattern here closes the gap on the
    // generation-superseded path.
    if (oldGen + 1 !== this._generation) {
      // throw rather
      // than return silently. `restartByName`'s try/catch translates
      // the throw into `{restarted: false, reason: <message>}` on the
      // HTTP response. Pre-fix the void return resolved `restart()`
      // successfully → `restartByName` reported `{restarted: true}`
      // even though the snapshot was discarded and (on the state-
      // guard path) the entry was force-shut-down mid-restart.
      // Operators saw "restart succeeded" while sessions silently
      // lost the server. Sweep the new transport before throwing so
      // the leak fix still holds.
      await this.sweepAndDisconnect('restart_superseded');
      throw new Error(
        `Restart of ${this.id} superseded by newer generation; ` +
          `discarded stale snapshot + swept new transport.`,
      );
    }
    // state guard
    // after the generation guard. If `forceShutdown` ran during any
    // of `doRestart`'s awaits (e.g., a `drainAll` mid-restart on
    // shutdown, or a sibling restart that triggered a transient
    // close), the entry is in `'closed'` / `'failed'` — writing
    // CONNECTED + emitting `reconnected` on a pool-evicted zombie
    // entry would leave subscribers thinking they're attached to a
    // healthy connection. Drop the snapshot AND sweep the new
    // transport (`client.connect()` already spawned
    // the new subprocess by the time we got here, so a silent
    // return would leak grandchildren).
    //
    // Fix: read `this.state` into a `currentState: PoolEntryState`
    // local. TypeScript's CFA narrows `this.state` along the
    // non-throwing path of the `try { connect; discover } catch`
    // (the catch sets `state='failed'` and throws) — so by the time
    // CFA reaches this line, the type is `'spawning' | 'active'`
    // and the comparison against `'closed'` / `'failed'` becomes a
    // TS2367 "no overlap" build error. The runtime guard is
    // semantically required (concurrent `forceShutdown` CAN mutate
    // state across `await` boundaries), but we have to defeat the
    // narrowing.
    // `this.state as PoolEntryState` re-widens the type — assignment
    // alone preserves the narrowing through the local variable, so a
    // cast is required to defeat CFA explicitly.
    const currentState = this.state as PoolEntryState;
    if (currentState === 'closed' || currentState === 'failed') {
      // Same rationale as the generation-guard branch
      // above): throw so `restartByName` reports
      // `{restarted: false, reason: <message>}` to the HTTP caller
      // instead of falsely reporting success on an aborted restart.
      // Sweep the new transport first so the leak fix still
      // covers the throw path.
      await this.sweepAndDisconnect('restart_superseded');
      throw new Error(
        `Restart of ${this.id} aborted: entry state is ${currentState} ` +
          `(forceShutdown ran concurrently mid-restart). ` +
          `Snapshot discarded; new transport swept.`,
      );
    }
    this.toolsSnapshot = snap.tools;
    this.promptsSnapshot = snap.prompts;
    // subscribers don't
    // listen on the entry's EventEmitter, so emitting toolsChanged /
    // promptsChanged alone leaves session ToolRegistry instances
    // holding stale pre-restart registrations. Latent until commit 5
    // landed the restart HTTP route — now it's a correctness bug.
    // Iterate `this.subscribers` directly and re-apply the fresh
    // snapshots so each session's registry gets the new tools/prompts
    // (SessionMcpView.applyTools handles the
    // remove-old-then-register-new contract internally).
    for (const [sid, view] of this.subscribers) {
      try {
        view.applyTools(this.toolsSnapshot);
        view.applyPrompts(this.promptsSnapshot);
      } catch (err) {
        debugLogger.error(
          `Restart fan-out to view ${sid}/${this.serverName} failed: ${String(
            err,
          )}`,
        );
      }
    }
    this.localStatus = MCPServerStatus.CONNECTED;
    this.suppressNextStatusEcho = true;
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
    // the
    // caller (pool's `restartByName`) is responsible for re-arming
    // the drain timer when `refs.size === 0` after restart. The
    // re-arm lives at the pool level rather than here so it uses the
    // pool's operator-configured `drainDelayMs` (e.g. tight 100ms in
    // tests) instead of `PoolEntry.opts.drainDelayMs` which falls
    // through to the entry's transport-default 30s. See
    // `mcp-transport-pool.ts:restartByName` for the re-arm site.
  }

  /**
   * Fire an event to all subscribers. Stays inside the entry's
   * EventEmitter so `PooledConnection.on('event', cb)` and
   * `removeListener` work correctly.
   *
   * iterate listeners
   * with per-listener try/catch instead of delegating to
   * `EventEmitter.emit` directly. Pre-fix a synchronous throw from
   * one session's listener (e.g. session A's view triggered an
   * exception) crashed the emit call — siblings B, C never received
   * the event. In `forceShutdown`'s emit-then-disconnect sequence
   * (line 449), one buggy listener could prevent subprocess
   * cleanup, budget slot release, and entry eviction for ALL
   * sessions sharing the entry. Now per-listener errors log to
   * debug and the iteration continues to the next listener.
   */
  emit(event: PoolEvent): void {
    const listeners = this.emitter.listeners('event') as Array<
      (e: PoolEvent) => void
    >;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        debugLogger.error(
          `PoolEntry listener error for ${this.id} ` +
            `(event.kind=${event.kind}): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }
  }

  internalOn(listener: (e: PoolEvent) => void): void {
    this.emitter.on('event', listener);
  }

  internalOff(listener: (e: PoolEvent) => void): void {
    this.emitter.off('event', listener);
  }

  /**
   * Write the aggregated status (`any-CONNECTED-wins` across entries
   * with same `serverName`) into the process-global
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
    // the `_view`
    // parameter was accepted but never stored or referenced. The
    // underscore prefix signaled intent ("kept for parity / future
    // use") but the deferred-need never materialized; per-subscriber
    // filters live on `SessionMcpView` itself, not on the connection
    // handle. Removed entirely to drop the dead parameter from the
    // constructor signature and unblock callers from passing through
    // a redundant arg (the pool's `attach` already wires the view to
    // the entry's subscriber map at line ~410).
    // Pool-supplied release callback. Wired by `pool.acquire` to call
    // `pool.release(id, sessionId)` so subscribers can `handle.release()`
    // without needing a pool reference.
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
    // the local
    // `Set<>` deduplicates the public-API listener registration, but
    // `entry.internalOn` (a thin wrapper over `EventEmitter.on`)
    // does NOT dedup — calling `on(cb)` twice with the same listener
    // would register the listener twice on the entry's emitter while
    // appearing as a single entry in `this.listeners`. On `release()`
    // (line 1126) we'd call `internalOff(cb)` once, leaving one
    // registration leaking on the entry's emitter that fires once
    // per future event for the entry's lifetime. Detect the duplicate
    // pre-attach and short-circuit so internalOn is invoked exactly
    // once per unique (handle, listener) pair.
    if (this.listeners.has(listener)) return this;
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

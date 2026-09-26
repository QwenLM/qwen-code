/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type { ActiveWorkHoldCategory, ChildHeapReport } from './bridgeTypes.js';
import type { AcpChannel } from './channel.js';
import type { ChannelLivenessMonitor } from './channel-liveness.js';
import type { BridgeExecutionEngine } from './bridgeOptions.js';

export interface HarnessChannel {
  readonly id: string;
  readonly executionEngine?: BridgeExecutionEngine;
  lastUsedAt: number;
  readonly channel: AcpChannel;
  readonly connection: ClientSideConnection;
  /** Workspace-level control calls that use the shared channel without a session. */
  workspaceControlInFlight: number;
  /** A timed-out workspace operation will retire this channel after Sessions drain. */
  retireWhenSessionsDrain: boolean;
  /**
   * Set when an empty channel should be reaped after overlapping
   * session/workspace-control work drains.
   */
  emptyReapPending: boolean;
  /** Transport guard fired before the child process exited. */
  transportFailed: boolean;
  /** The transport guard, rather than an existing teardown, condemned it. */
  transportFailureInitiatedTeardown: boolean;
  /** Safe bounded code retained for telemetry; never the raw error message. */
  transportFailureCode?: string;
  /**
   * Bounded queue-budget detail for `ndjson_queue_limit_exceeded` transport
   * failures: which budget fired plus required/available/cap bytes. Derived
   * from typed error fields only; never the raw error message.
   */
  transportFailureDetail?: string;
  /**
   * Cached channel-close race for workspace-scoped status requests. Workspace
   * status can be polled frequently by dashboards, so keep one promise per
   * channel instead of attaching a new `.then()` to `channel.exited` per poll.
   */
  statusClosedReject?: Promise<never>;
  /**
   * Latest self-reported ACP-child resource sample (rss/cpu), refreshed by the
   * daemon's metrics sampler via `refreshChildResource`. Kept on the channel so
   * it drops automatically on a channel swap — the sampler always reads the
   * live channel's cache.
   */
  childRssBytes?: number;
  childCpuPercent?: number;
  childResourceAt?: number;
  /**
   * The child's lifetime old-generation high-water marks, when it reports
   * them. Absent — never zeroed — for a child that predates the fields or was
   * spawned without the daemon marker, so a reader can tell "not measured"
   * from a measured zero.
   */
  childHeap?: ChildHeapReport;
  /**
   * MUST be set to `true` synchronously by any teardown path BEFORE
   * awaiting `channel.kill()`. `ensureChannel` treats a dying channel
   * as absent and spawns a fresh one — without this flag a concurrent
   * `spawnOrAttach` arriving during the SIGTERM grace window (up to
   * 10s) would attach to a transport about to close, landing the
   * caller with a sessionId that 404s on every follow-up request.
   *
   * Teardown owners after the split:
   *
   * - `channel-startup.ts`, `start()`: initialize failure, transport failure,
   *   post-handshake dying/shutdown checks, and runtime-epoch failure.
   * - `session-control-plane.ts`, `doSpawn()` and `restoreSessionWithReplay()`:
   *   session-creation failure when the control plane's session/work predicates
   *   allow the physical channel to be reaped.
   * - `channel-harness.ts`, `killChannelWithLog()` / `reapPendingEmptyChannel()` /
   *   `reclaimIdleChannel()`: idle cleanup, retirement after session work drains,
   *   and explicit idle capacity reclamation.
   * - Control-plane `shutdown()` calls harness `markDying()` for its snapshot
   *   of `ChannelLifecycle.values()` before publishing session removals.
   *
   * **BkUyD invariant**: keep dying handles in `ChannelLifecycle.values()`
   * until `channel.exited` removes them. Harness `killAllSync()` must still
   * reach every child during its SIGTERM grace window, even after a replacement
   * becomes `ChannelLifecycle.current`. `isDying` controls attach availability;
   * lifecycle membership controls physical ownership until OS reap.
   */
  isDying: boolean;
  /**
   * Negotiated active-work reporting for this channel, or `undefined` when the
   * child never acknowledged the capability. `undefined` is *not* "idle": it
   * means this channel contributes no active-work facts at all, so the
   * daemon's reporting grade degrades and pre-existing cleanup behavior
   * applies unchanged. Conflating the two would let an older child either
   * pin every Session forever or look permanently idle.
   */
  activeWork?: {
    intervalMs: number;
    categories: readonly ActiveWorkHoldCategory[];
    /** Highest snapshot sequence applied; guards against reordering only. */
    seq: number;
    /** Latest report, retained for Sessions registered after it arrived. */
    snapshot?: {
      receivedAt: number;
      sessions: Map<string, Map<string, ActiveWorkHoldCategory>>;
    };
  };
  channelLiveness?: ChannelLivenessMonitor;
  handshakeComplete: boolean;
}

export interface ChannelLifecycle {
  readonly current: HarnessChannel | undefined;
  readonly starting: Promise<HarnessChannel> | undefined;
  readonly size: number;
  currentFor(engine?: BridgeExecutionEngine): HarnessChannel | undefined;
  startingFor(
    engine?: BridgeExecutionEngine,
  ): Promise<HarnessChannel> | undefined;
  startups(): IterableIterator<Promise<HarnessChannel>>;
  has(info: HarnessChannel): boolean;
  values(): IterableIterator<HarnessChannel>;
  track(info: HarnessChannel): void;
  publish(info: HarnessChannel): void;
  remove(info: HarnessChannel): void;
  startSpawn(
    spawn: () => Promise<HarnessChannel>,
    engine?: BridgeExecutionEngine,
  ): Promise<HarnessChannel>;
  finishSpawn(engine?: BridgeExecutionEngine): void;
}

export function createChannelLifecycle(
  defaultEngine?: BridgeExecutionEngine,
): ChannelLifecycle {
  // Each engine slot has one attach-available channel. Cleared
  // ONLY by the `channel.exited` handler in channel-harness.ts when the OS
  // reaps the underlying child process. Teardown initiators
  // (`killSession` last-session-leaving — via `startIdleTimer` ->
  // `killChannelWithLog` / `reapPendingEmptyChannel`,
  // `doSpawn`-newSession-failure on an empty channel, `ensureChannel`
  // init-failure / late-shutdown, `shutdown`) set `isDying = true`
  // but LEAVE
  // `channelInfo` pointing at the dying channel until OS reap — that
  // asymmetry IS the BkUyD invariant. It lets `killAllSync` reach a
  // mid-SIGTERM-grace channel through `aliveChannels` while a
  // concurrent `spawnOrAttach` can already start spawning a fresh
  // replacement (which overwrites `channelInfo` when its
  // handshake completes). Race-aware code paths (`ensureChannel`,
  // `killAllSync`) gate on `isDying` rather than presence; see
  // `HarnessChannel.isDying` for the per-set-site rationale.
  const channels = new Map<BridgeExecutionEngine | undefined, HarnessChannel>();
  // BkUyD: superset of `channelInfo` covering channels
  // that are dying but not yet OS-reaped. `killSession` /
  // `doSpawn`-newSession-failure / `shutdown` mark a channel as
  // `isDying` and start its async kill; meanwhile a concurrent
  // `spawnOrAttach` can spawn a FRESH channel and reassign
  // `channelInfo`. Without this set, the dying channel becomes
  // unreachable — a double-Ctrl+C arriving mid-grace would call
  // `killAllSync()`, find only the fresh channel in `channelInfo`,
  // force-kill it, and `process.exit(1)` would orphan the dying one
  // whose SIGTERM hadn't yet completed. The set is the OS-level
  // "still alive" source of truth: entries are added when a channel
  // is created and removed when its `channel.exited` resolves.
  // `killAllSync` iterates THIS set to fire SIGKILL on every alive
  // child regardless of whether it's still the attach target.
  const aliveChannels = new Set<HarnessChannel>();
  // Coalesces a concurrent second `ensureChannel()` call onto the
  // first one's spawn so we never create two children for the same
  // engine. Cleared in the `finally` of the creator.
  const starting = new Map<
    BridgeExecutionEngine | undefined,
    Promise<HarnessChannel>
  >();

  return {
    get current() {
      return channels.get(defaultEngine);
    },
    get starting() {
      return starting.get(defaultEngine);
    },
    currentFor: (engine = defaultEngine) => channels.get(engine),
    startingFor: (engine = defaultEngine) => starting.get(engine),
    startups: () => starting.values(),
    get size() {
      return aliveChannels.size;
    },
    has(info) {
      return aliveChannels.has(info);
    },
    values() {
      return aliveChannels.values();
    },
    track(info) {
      aliveChannels.add(info);
    },
    publish(info) {
      channels.set(info.executionEngine, info);
    },
    remove(info) {
      aliveChannels.delete(info);
      if (channels.get(info.executionEngine) === info)
        channels.delete(info.executionEngine);
    },
    startSpawn(spawn, engine = defaultEngine) {
      let promise = starting.get(engine);
      if (!promise) {
        promise = spawn();
        starting.set(engine, promise);
      }
      return promise;
    },
    finishSpawn(engine = defaultEngine) {
      starting.delete(engine);
    },
  };
}

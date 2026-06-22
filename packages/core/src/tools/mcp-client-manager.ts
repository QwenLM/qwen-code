/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, MCPServerConfig } from '../config/config.js';
import { isSdkMcpServerConfig } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  McpClient,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPServerStatus,
  populateMcpServerCommand,
  removeMCPServerStatus,
  setMCPDiscoveryState,
} from './mcp-client.js';
import type { SendSdkMcpMessage } from './mcp-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
import type { EventEmitter } from 'node:events';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
// `connectionIdOf` for
// the discoverAllMcpToolsViaPool diff. Static import from a leaf module
// is safe even though mcp-pool-key.ts imports `mcpTransportOf` from
// here — that import is a value-level back-edge that ES module hoisting
// resolves before either side's top-level code runs. The other pool
// modules (mcp-transport-pool.ts, mcp-pool-entry.ts) intentionally use
// `import('...')` types to avoid pulling in their RUNTIME code, but
// mcp-pool-key.ts is pure utility (hash + string concat) with no
// runtime side effects, so a static value import is fine.
import { connectionIdOf } from './mcp-pool-key.js';
import type { ConnectionId } from './mcp-pool-events.js';
import {
  McpBudgetWouldExceedError,
  McpServerSpawnFailedError,
  InvalidMcpConfigError,
} from './mcp-errors.js';

const debugLogger = createDebugLogger('MCP');

/**
 * Configuration for MCP health monitoring
 */
export interface MCPHealthMonitorConfig {
  /** Health check interval in milliseconds (default: 30000ms) */
  checkIntervalMs: number;
  /** Number of consecutive failures before marking as disconnected (default: 3) */
  maxConsecutiveFailures: number;
  /** Enable automatic reconnection (default: true) */
  autoReconnect: boolean;
  /** Delay before reconnection attempt in milliseconds (default: 5000ms) */
  reconnectDelayMs: number;
}

const DEFAULT_HEALTH_CONFIG: MCPHealthMonitorConfig = {
  checkIntervalMs: 30000, // 30 seconds
  maxConsecutiveFailures: 3,
  autoReconnect: true,
  reconnectDelayMs: 5000, // 5 seconds
};

/**
 * Upper threshold of the dual-threshold hysteresis used by both the
 * snapshot-based budget cell (v1) and the push-event state
 * machine. When `reservedSlots.size / clientBudget` crosses
 * this fraction upward, a `budget_warning` event fires and the
 * armed-state flips to "fired"; the next fire requires the ratio to
 * drop below `MCP_BUDGET_REARM_FRACTION` first.
 *
 * Picked 0.75 to mirror `slow_client_warning`
 * (`eventBus.ts:WARN_THRESHOLD_RATIO`) — same rationale: "warning"
 * fires before "error" with enough headroom for the operator to act.
 */
export const MCP_BUDGET_WARN_FRACTION = 0.75 as const;

/**
 * Lower threshold for the hysteresis state machine. After a
 * warning fires, the ratio must drop below this fraction before the
 * state machine re-arms — so a server that flaps just above 0.75
 * doesn't produce a flood of identical warnings. Mirrors
 * `eventBus.ts:WARN_RESET_RATIO` (0.375 = half of the warn fraction).
 */
export const MCP_BUDGET_REARM_FRACTION = 0.375 as const;

/**
 * Budget enforcement mode for MCP client guardrails.
 *
 * `off` — no accounting-driven enforcement (default when no budget is
 *   configured). `getMcpClientAccounting()` still works as pure
 *   observability; slot reservation is a no-op.
 * `warn` — measure-only. Reserved slots track the configured set even
 *   beyond the budget so operators see `liveCount > budget` in the
 *   snapshot. No connect is refused. Snapshot consumers render a
 *   warning cell when `liveCount >= 0.75 * budget`.
 * `enforce` — hard cap. Connects beyond the budget are refused, the
 *   per-server cell shows `errorKind: 'budget_exhausted'`, and the
 *   server name lands in `refusedServerNames`. Refusal is deterministic
 *   by `Object.entries(servers)` declaration order.
 */
export type McpBudgetMode = 'enforce' | 'warn' | 'off';

export interface McpBudgetConfig {
  /**
   * Cap on live MCP clients **per ACP session** (v1; R4 review
   * scope correction — see `acpAgent.newSessionConfig` constructs a
   * fresh `Config`/`McpClientManager` per session, so each session
   * enforces its own copy of the cap independently).
   * shared MCP pool will graduate this to per-workspace.
   * `undefined` = unlimited.
   */
  clientBudget?: number;
  /** Behavior at and above the cap. `off` when `clientBudget` is undefined. */
  budgetMode: McpBudgetMode;
  /**
   * optional callback invoked by the manager when a budget
   * threshold is crossed (`'budget_warning'`) or one or more servers
   * are refused during a discovery pass (`'refused_batch'`). The
   * manager stays decoupled from ACP wire types — the callback is
   * provided by `acpAgent.newSessionConfig` and translates each event
   * into a `connection.extNotification(...)` call carrying the
   * sessionId. Absent in `off` mode (state machine is dormant).
   */
  onBudgetEvent?: (event: McpBudgetEvent) => void;
}

/**
 * One refused-server entry in a `'refused_batch'` event payload.
 * `transport` is the family resolved at refusal time via `mcpTransportOf`;
 * `reason` is `'budget_exhausted'` until additional refusal causes are
 * defined.
 */
export interface McpRefusedServer {
  name: string;
  transport: McpTransportKind;
  reason: 'budget_exhausted';
}

/**
 * Discriminated union of guardrail events emitted to `onBudgetEvent`.
 *
 * - `budget_warning` fires on the upward crossing of
 *   `reservedSlots.size / clientBudget >= MCP_BUDGET_WARN_FRACTION`,
 *   then re-arms only after the ratio drops below
 *   `MCP_BUDGET_REARM_FRACTION`. Carries both `liveCount` (CONNECTED
 *   clients) and `reservedCount` (configured-set, including in-flight
 *   reservations) so SDK consumers can render either lens.
 * - `refused_batch` fires once per `discoverAllMcpTools*` pass when
 *   `lastRefusedServerNames.length > 0`, OR as a length-1 batch on the
 *   `readResource` lazy-spawn refusal path. `mode` is the literal
 *   `'enforce'` because `warn` mode never refuses.
 */
export type McpBudgetEvent =
  | {
      kind: 'budget_warning';
      liveCount: number;
      reservedCount: number;
      budget: number;
      thresholdRatio: typeof MCP_BUDGET_WARN_FRACTION;
      mode: 'warn' | 'enforce';
    }
  | {
      kind: 'refused_batch';
      refusedServers: McpRefusedServer[];
      budget: number;
      liveCount: number;
      reservedCount: number;
      mode: 'enforce';
    };

/** Transport family per `MCPServerConfig`. `unknown` covers misconfigured entries. */
export type McpTransportKind =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'websocket'
  | 'sdk'
  | 'unknown';

/**
 * Snapshot of the manager's live + reserved MCP state. The daemon's
 * read-only `GET /workspace/mcp` route fans this out via the ACP
 * `qwen/status/workspace/mcp` ext-method. `subprocessCount` is the
 * value `pgrep -P` baseline harness can validate against.
 */
export interface McpClientAccounting {
  /** Live (`MCPServerStatus.CONNECTED`) client count, all transports. */
  total: number;
  /** Live client count split by transport family. */
  byTransport: Record<McpTransportKind, number>;
  /** stdio + websocket — the only transports that spawn an OS process. */
  subprocessCount: number;
  /** Server names currently holding a budget slot (in or over the cap). */
  reservedSlots: string[];
  /** Server names refused during the most recent `discoverAllMcpTools*` pass. */
  refusedServerNames: string[];
}

/**
 * Thrown by `readResource` lazy-spawn path when the live count is
 * already at `clientBudget` and `budgetMode === 'enforce'`. Discovery-
 * time refusals don't throw (they're recorded in `refusedServerNames`
 * and reported via the snapshot), because the discovery loop is
 * best-effort and a thrown error would cancel sibling connects.
 */
export class BudgetExhaustedError extends Error {
  readonly serverName: string;
  readonly budget: number;
  /**
   * Number of slots currently reserved (== `reservedSlots.size` at the
   * time of the refusal). renamed
   * from `liveCount` because `reservedSlots` tracks reserved server
   * NAMES, not `MCPServerStatus.CONNECTED` clients — a reserved-but-
   * disconnected server still consumes a slot, and that's the
   * accurate quantity blocking this new server from getting in.
   * `getMcpClientAccounting().total` would have been the genuine
   * "live" count and is a different number.
   */
  readonly reservedCount: number;
  constructor(serverName: string, budget: number, reservedCount: number) {
    super(
      `MCP client budget exhausted: cannot reserve slot for '${serverName}' ` +
        `(budget=${budget}, reservedCount=${reservedCount}). ` +
        `Raise --mcp-client-budget or remove servers from mcpServers config.`,
    );
    this.name = 'BudgetExhaustedError';
    this.serverName = serverName;
    this.budget = budget;
    this.reservedCount = reservedCount;
  }
}

/**
 * Map an `MCPServerConfig` to its transport family. Aligned with the
 * detection order in `mcp-client.ts:createTransport` (sdk → httpUrl
 * → url → command) with ONE forward-looking exception: `tcp` is
 * mapped here to `websocket` matching the field's declared intent on
 * `MCPServerConfig`, but `createTransport` does NOT yet construct a
 * websocket transport. A config carrying both `tcp` and `command`
 * is labeled `websocket` in the accounting snapshot while the real
 * connection fires through the `command` path as `stdio`. The
 * `subprocessCount = stdio + websocket` arithmetic is therefore
 * accurate-by-vacancy today (no real websocket subprocesses exist
 * yet) and will need revisiting if a websocket transport ships.
 * This is a future core decision: (a) implement WS in
 * createTransport vs (b) drop `tcp` from `MCPServerConfig` + both
 * mappers.
 *
 * `sdk` is checked first because `SDK_MCP_SERVER_FIELDS` may coexist
 * with a placeholder `command` — without the sdk-first order, an
 * in-process SDK server would mis-report as `stdio`.
 */
export function mcpTransportOf(config: MCPServerConfig): McpTransportKind {
  if (isSdkMcpServerConfig(config)) return 'sdk';
  if (typeof config.httpUrl === 'string') return 'http';
  if (typeof config.url === 'string') return 'sse';
  if (typeof config.tcp === 'string') return 'websocket';
  if (typeof config.command === 'string') return 'stdio';
  return 'unknown';
}

/**
 * Resolve budget config from env vars when the constructor caller
 * doesn't pass one. Daemon-mode (`qwen serve`) sets these when
 * spawning the `qwen --acp` child; standalone `qwen` invocations
 * leave them unset and get `{ budgetMode: 'off' }` — the historical
 * behavior, no enforcement.
 *
 * `QWEN_SERVE_MCP_CLIENT_BUDGET` — positive integer; non-numeric /
 *   zero / negative / NaN are silently ignored (treated as unset).
 * `QWEN_SERVE_MCP_BUDGET_MODE` — `enforce|warn|off`. Defaults to
 *   `warn` when a budget is set, `off` otherwise.
 */
function readBudgetFromEnv(): McpBudgetConfig {
  const rawBudget = process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
  const rawMode = process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  let clientBudget: number | undefined;
  if (rawBudget !== undefined && rawBudget !== '') {
    const parsed = Number(rawBudget);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
      clientBudget = parsed;
    } else {
      // operator typos
      // like `QWEN_SERVE_MCP_CLIENT_BUDGET=abc` previously fell
      // through silently to "no budget" with zero indication. The
      // CLI parent (`commands/serve.ts` + `run-qwen-serve.ts`)
      // validates and throws, but the ACP child process — where
      // this function runs — has no such validation. Surface a
      // boot breadcrumb so operators see the misconfiguration in
      // journald / docker logs.
      process.stderr.write(
        `qwen serve: ignoring invalid QWEN_SERVE_MCP_CLIENT_BUDGET=` +
          `'${rawBudget}' (expected positive integer); ` +
          `MCP budget enforcement disabled for this child.\n`,
      );
    }
  }
  let budgetMode: McpBudgetMode;
  if (rawMode === 'enforce' || rawMode === 'warn' || rawMode === 'off') {
    budgetMode = rawMode;
  } else {
    if (rawMode !== undefined && rawMode !== '') {
      // Same operator-visibility rationale as the budget breadcrumb
      // above. Unknown mode value silently fell through to the
      // budget-driven default; now it gets a stderr line so the
      // typo is visible.
      process.stderr.write(
        `qwen serve: ignoring invalid QWEN_SERVE_MCP_BUDGET_MODE=` +
          `'${rawMode}' (expected enforce|warn|off); falling back to ` +
          `${clientBudget === undefined ? 'off' : 'warn'}.\n`,
      );
    }
    budgetMode = clientBudget === undefined ? 'off' : 'warn';
  }
  // mode-without-budget
  // downgrade. Originally only `enforce` got downgraded — but `warn`
  // mode without a budget threshold is equally meaningless: nothing
  // actionable can ever fire (no `liveCount >= 0.75 * budget`
  // comparison can be true when budget is undefined). Downgrading
  // BOTH to `off` removes the comment-vs-code mismatch in
  // `emitBudgetTelemetry` (which previously claimed
  // `mode !== 'off' ⇒ clientBudget defined` — true for enforce,
  // false for warn until this fix).
  //
  // R9 #7: emit a stderr breadcrumb when the downgrade fires.
  // Pre-fix the downgrade was silent — operator sets
  // `QWEN_SERVE_MCP_BUDGET_MODE=enforce` in a Docker Compose / k8s
  // env without the matching budget, daemon boots happy, snapshot
  // shows `budgetMode: 'off'`, and enforcement is silently
  // disabled. The CLI handler + `runQwenServe` path both throw on
  // this combination; the env-var fallback path (used by the ACP
  // child) was the laggard. Now mirrors the R7 #6 invalid-value
  // breadcrumb pattern.
  if (
    (budgetMode === 'enforce' || budgetMode === 'warn') &&
    clientBudget === undefined
  ) {
    process.stderr.write(
      `qwen serve: QWEN_SERVE_MCP_BUDGET_MODE=${budgetMode} requires ` +
        `QWEN_SERVE_MCP_CLIENT_BUDGET=N; downgrading to off. ` +
        `Set both env vars to enable MCP guardrail enforcement.\n`,
    );
    budgetMode = 'off';
  }
  return { clientBudget, budgetMode };
}

/**
 * options bag for
 * `McpClientManager` construction, replacing the prior 5 trailing
 * positional parameters (`eventEmitter`, `sendSdkMcpMessage`,
 * `healthConfig`, `budgetConfig`, `pool`). Pre-fix every test site
 * threaded 4 explicit `undefined`s to reach the trailing `pool` arg
 * the fixed positions also blocked future option additions without
 * re-ordering. The options-object form lets each caller name only the
 * fields it cares about and keeps the constructor signature stable
 * across future additions (e.g. when the health-monitor wire-up
 * lands a new `reconnectStrategy` knob).
 */
export interface McpClientManagerOptions {
  eventEmitter?: EventEmitter;
  sendSdkMcpMessage?: SendSdkMcpMessage;
  healthConfig?: Partial<MCPHealthMonitorConfig>;
  budgetConfig?: McpBudgetConfig;
  pool?: import('./mcp-transport-pool.js').McpTransportPool;
}

/**
 * Manages the lifecycle of multiple MCP clients, including local child processes.
 * This class is responsible for starting, stopping, and discovering tools from
 * a collection of MCP servers defined in the configuration.
 */
export class McpClientManager {
  private clients: Map<string, McpClient> = new Map();
  private readonly toolRegistry: ToolRegistry;
  private readonly cliConfig: Config;
  private discoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;
  private readonly eventEmitter?: EventEmitter;
  private readonly sendSdkMcpMessage?: SendSdkMcpMessage;
  private healthConfig: MCPHealthMonitorConfig;
  private healthCheckTimers: Map<string, NodeJS.Timeout> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private isReconnecting: Map<string, boolean> = new Map();
  private serverDiscoveryPromises: Map<string, Promise<void>> = new Map();

  /**
   * Budget bookkeeping. Slots are reserved synchronously by server name
   * inside the discovery loop BEFORE any `await client.connect()`, so
   * `Promise.all(discoveryPromises)` cannot interleave a second connect
   * past the cap. `enforce` mode refuses past the cap; `warn` mode
   * over-reserves so accounting reflects the configured set; `off`
   * doesn't reserve at all.
   */
  private readonly reservedSlots = new Set<string>();
  private readonly clientBudget?: number;
  private readonly budgetMode: McpBudgetMode;
  /**
   * names whose
   * slot was freshly reserved (not `'already_held'`) by an
   * in-flight `discoverMcpToolsForServerInternal` call. Read by
   * `runWithDiscoveryTimeout`'s timeout handler to decide whether
   * to release the slot on hard timeout — fresh reservations
   * release (server never connected, slot shouldn't permanently
   * block other servers); `'already_held'` reconnects keep their
   * slot (operator's previously-healthy server shouldn't be
   * permanently demoted by a transient timeout).
   *
   * Lifetime: `add` after `tryReserveSlot` returns `'reserved'`
   * with the `.has` guard, `delete` in success / catch / finally
   * cleanup. Idempotent — multiple deletes are no-ops.
   */
  private readonly freshReservations = new Set<string>();
  /**
   * Servers refused during the most recent `discoverAllMcpTools*` pass.
   * Reset at the start of each pass; survives between passes so a
   * snapshot taken between discoveries still shows the last set of
   * refusals to operators.
   */
  private lastRefusedServerNames: string[] = [];
  /**
   * transport family (`stdio`/`http`/...) resolved for each
   * entry in `lastRefusedServerNames`, captured at refusal time. The
   * `'refused_batch'` event payload includes the per-server transport
   * so dashboards can break down "which kind of servers got refused"
   * without re-walking config.
   *
   * Lifetime mirrors `lastRefusedServerNames`: reset at the start of
   * each `discoverAllMcpTools*` pass + on `stop()` + on
   * `dropRefusalEntry` (operator removed/disconnected the server).
   * NOT cleared on `emitRefusedBatchIfAny` — the snapshot-visible
   * refusal state survives between passes per the contract,
   * so a snapshot taken between passes still reports the last
   * refusal set with correct transport metadata. The push-event
   * idempotency invariant is held by the separate
   * `pendingRefusalNames` queue, not by clearing this map.
   */
  private lastRefusedTransports = new Map<string, McpTransportKind>();
  /**
   * queue of refusal names NOT YET emitted as a push event.
   * `lastRefusedServerNames` is the snapshot-visible state and MUST
   * survive between passes (contract). The push-event path
   * needs separate accounting so a length-1 batch fired by a single-
   * server / readResource refusal doesn't get re-emitted by the
   * bulk-pass end-of-pass call. `refuseAndLog` adds to both;
   * `emitRefusedBatchIfAny` drains and clears this set without
   * touching `lastRefusedServerNames`. Empty whenever there are no
   * unsent refusals, regardless of pass.
   */
  private pendingRefusalNames = new Set<string>();
  /**
   * hysteresis state for `'budget_warning'` events. `true`
   * means "next 75% upward crossing fires"; `false` means "warning
   * already fired, waiting for ratio to drop below 37.5% to re-arm".
   * Stays `true` permanently in `off` mode (the state machine
   * short-circuits before touching it). Initial value `true` so the
   * first crossing during a session always fires.
   */
  private warnArmed = true;
  /**
   * re-entrant counter that
   * tracks whether a bulk discovery pass is currently in flight.
   * Incremented on entry to `discoverAllMcpTools` /
   * `discoverAllMcpToolsIncremental`; decremented in the matching
   * `finally`. While > 0, `emitRefusedBatchIfAny` short-circuits so
   * per-server refusals queue up; the bulk pass's own end-of-pass
   * call (which runs AFTER `bulkPassDepth--`) drains the queue once
   * as a coalesced batch — preserving the documented "one batch per
   * pass" contract regardless of which inner code path enqueued the
   * refusals (`discoverMcpToolsForServerInternal` from incremental,
   * inline `refuseAndLog` from legacy bulk).
   *
   * Counter rather than boolean to defend against re-entry (a future
   * code path that nests bulk passes — e.g. a discovery hook that
   * itself triggers reload — wouldn't accidentally clear the flag
   * mid-outer-pass).
   */
  private bulkPassDepth = 0;
  /**
   * optional callback set at construction time OR via
   * `setOnBudgetEvent` after construction. When non-`null` and
   * `budgetMode !== 'off'`, the manager fires it on every threshold
   * crossing or non-empty refusal batch. Decouples core from ACP
   * wire types; `acpAgent.newSessionConfig` provides the adapter
   * that translates events into `connection.extNotification`.
   *
   * The setter exists because the production construction path
   * (`ToolRegistry` constructor → `loadCliConfig`) doesn't expose a
   * hook to thread the callback through. acpAgent registers the
   * callback after `loadCliConfig` returns but BEFORE
   * `config.initialize()` fires the first discovery — so no events
   * are missed.
   */
  private onBudgetEvent?: (event: McpBudgetEvent) => void;

  /**
   * when present, non-SDK MCP server discovery
   * delegates to the workspace-shared pool instead of spawning a
   * per-session `McpClient`. Tracked here so `disconnectServer` /
   * `stop` can `release` the pool reference cleanly without leaking
   * refs (the pool's drain timer kicks in when refs hit zero).
   *
   * SDK MCP servers (`isSdkMcpServerConfig`) always bypass the pool
   * — the `sendSdkMcpMessage` callback is per-session by design and
   * the pool's transport is workspace-level. Per-server gating in
   * `discoverMcpToolsForServer` keeps the legacy path for SDK MCP.
   */
  private readonly pool?: import('./mcp-transport-pool.js').McpTransportPool;
  private readonly pooledConnections = new Map<
    string,
    import('./mcp-pool-entry.js').PooledConnection
  >();
  /**
   * re-entrancy guard
   * for `discoverAllMcpToolsViaPool`. Two passes interleaving (full
   * + incremental, or two incrementals) could see
   * `pooledConnections.has(name) === false` simultaneously and both
   * call `pool.acquire`, with the second `set(name, conn2)` silently
   * overwriting the first → conn1 leaks (refcount never reaches 0,
   * drain timer never fires). The mutex serializes passes; a second
   * caller awaits the same promise and sees the resolved state.
   */
  private discoveryInFlight?: Promise<void>;

  /**
   * set true by
   * `stop()` when its 5s shutdown-grace timer wins the race against
   * `discoveryInFlight`. The in-flight discovery pass checks this
   * flag before calling `pooledConnections.set(...)` so a late-
   * resolving `pool.acquire` (whose 30s default timeout exceeds the
   * shutdown cap) doesn't orphan an entry by re-populating the Map
   * after `releaseAllPooledConnections` cleared it.
   */
  private stopTimedOut = false;

  constructor(
    config: Config,
    toolRegistry: ToolRegistry,
    options: McpClientManagerOptions = {},
  ) {
    this.cliConfig = config;
    this.toolRegistry = toolRegistry;
    this.pool = options.pool;

    this.eventEmitter = options.eventEmitter;
    this.sendSdkMcpMessage = options.sendSdkMcpMessage;
    this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...options.healthConfig };
    const budgetConfig = options.budgetConfig;

    // Tests inject `budgetConfig` directly; production reads env vars
    // set by `qwen serve --mcp-client-budget=N --mcp-budget-mode=X`
    // when spawning the ACP child. Standalone `qwen` invocations
    // leave both unset and get `mode: 'off'` — the pre-PR-14 default.
    const resolved = budgetConfig ?? readBudgetFromEnv();
    let resolvedMode = resolved.budgetMode;
    // mirror
    // `readBudgetFromEnv`'s `(enforce|warn)`-without-budget
    // downgrade for the direct-`budgetConfig` path too. All
    // production callers (CLI handler, `runQwenServe`, env-var
    // fallback) validate upfront, but a future code path that
    // injects `budgetConfig` without running the validation
    // would re-introduce the silent fail-open. Defense in depth.
    //
    // R10 line 357: emit the same stderr breadcrumb the env-var
    // path uses. Pre-R10 the env-var path logged on downgrade but
    // this constructor path was silent — same operator-visibility
    // failure mode (operator only sees `budgetMode: 'off'` after
    // the fact via the snapshot). Now both paths surface the
    // misconfiguration at boot, so a future caller that bypasses
    // CLI / env-var validation can't ship a daemon that
    // advertises `mcp_guardrails` while silently disabling
    // enforcement.
    if (
      (resolvedMode === 'enforce' || resolvedMode === 'warn') &&
      resolved.clientBudget === undefined
    ) {
      process.stderr.write(
        `qwen serve: McpClientManager constructed with budgetMode=${resolvedMode} ` +
          `but no clientBudget; downgrading to off.\n`,
      );
      resolvedMode = 'off';
    }
    this.clientBudget = resolved.clientBudget;
    this.budgetMode = resolvedMode;
    // capture the optional event callback only when enforcement
    // is actually live. In `off` mode the state machine never runs, so
    // a stray callback would never fire — stash `undefined` to make
    // that invariant visible at the field level.
    this.onBudgetEvent =
      resolvedMode === 'off' ? undefined : resolved.onBudgetEvent;
  }

  /**
   * Atomic budget check + slot reservation. Synchronous so the
   * concurrent discovery loop (`Promise.all` over server entries) can't
   * interleave a second connect past the cap at any `await` boundary.
   *
   * Returns:
   *   `reserved` — slot newly held (or `off`-mode no-op)
   *   `already_held` — slot was already reserved (reconnect / dup)
   *   `refused` — `enforce` mode and the cap is full
   */
  private tryReserveSlot(
    serverName: string,
  ): 'reserved' | 'already_held' | 'refused' {
    if (this.reservedSlots.has(serverName)) return 'already_held';
    if (this.clientBudget === undefined || this.budgetMode === 'off') {
      return 'reserved';
    }
    if (
      this.budgetMode === 'enforce' &&
      this.reservedSlots.size >= this.clientBudget
    ) {
      return 'refused';
    }
    // `warn` mode (and `enforce` under cap) — track in the configured set.
    this.reservedSlots.add(serverName);
    // drive the hysteresis state
    // machine on every upward slot mutation so a 75% crossing during
    // bulk discovery fires inline, not at end-of-pass. Pre-fix the
    // bulk path's terminal evaluate saw the post-stabilization ratio
    // and missed transient crossings.
    this.evaluateBudgetState();
    return 'reserved';
  }

  /**
   * single release path for
   * `reservedSlots`. Delete + re-evaluate hysteresis on every
   * downward mutation so re-arming through the 37.5% boundary
   * happens whether the release came from operator
   * `disconnectServer`, config-driven `removeServer`, discovery
   * timeout cleanup, or a connect-failure catch block.
   *
   * Returns `true` when the name was actually held (parity with
   * `Set.delete`'s return); idempotent on already-released names.
   */
  private releaseSlotName(name: string): boolean {
    const had = this.reservedSlots.delete(name);
    if (had) this.evaluateBudgetState();
    return had;
  }

  /**
   * Snapshot the manager's MCP accounting for the daemon's read-only
   * `GET /workspace/mcp` route. Cheap to call — iterates `this.clients`
   * once and constructs a fresh struct each time so callers can mutate
   * the returned arrays without affecting internal state.
   *
   * `total` counts only `CONNECTED` clients; `reservedSlots` includes
   * the configured set (which under `enforce` mode is bounded by
   * `clientBudget`, but under `warn` mode can exceed it).
   */
  getMcpClientAccounting(): McpClientAccounting {
    const byTransport: Record<McpTransportKind, number> = {
      stdio: 0,
      sse: 0,
      http: 0,
      websocket: 0,
      sdk: 0,
      unknown: 0,
    };
    let total = 0;
    const servers = this.cliConfig.getMcpServers() ?? {};
    for (const [name, client] of this.clients) {
      if (client.getStatus() !== MCPServerStatus.CONNECTED) continue;
      const cfg = servers[name];
      const transport: McpTransportKind = cfg ? mcpTransportOf(cfg) : 'unknown';
      byTransport[transport] += 1;
      total += 1;
    }
    return {
      total,
      byTransport,
      subprocessCount: byTransport.stdio + byTransport.websocket,
      reservedSlots: Array.from(this.reservedSlots),
      refusedServerNames: [...this.lastRefusedServerNames],
    };
  }

  /** Resolved budget mode (env-var or constructor-supplied). */
  getMcpBudgetMode(): McpBudgetMode {
    return this.budgetMode;
  }

  /** Resolved client budget, or `undefined` when unlimited. */
  getMcpClientBudget(): number | undefined {
    return this.clientBudget;
  }

  /**
   * register (or replace) the budget-event callback. Production
   * code path: acpAgent constructs Config (which constructs the
   * manager via env-var defaults) then calls this BEFORE
   * `config.initialize()` so the callback is wired before the first
   * discovery pass fires.
   *
   * No-op in `off` mode — the state machine never runs, so a callback
   * here would never fire. Tests can pass a callback at construction
   * via `budgetConfig.onBudgetEvent` instead, which avoids this
   * setter path.
   */
  setOnBudgetEvent(
    callback: ((event: McpBudgetEvent) => void) | undefined,
  ): void {
    if (this.budgetMode === 'off') return;
    this.onBudgetEvent = callback;
  }

  /**
   * Whether a discovery / reconnect for `serverName` is currently in
   * flight (started but not yet resolved). Used by the daemon's
   * `POST /workspace/mcp/:server/restart` route
   * to short-circuit a redundant restart with `skipped:in_flight`
   * rather than awaiting the original discovery promise. Calling
   * `discoverMcpToolsForServer` during an in-flight pass is safe
   * (it joins the existing promise), but the route prefers the
   * fast-path skip so the HTTP latency stays bounded.
   */
  isServerDiscovering(serverName: string): boolean {
    return this.serverDiscoveryPromises.has(serverName);
  }

  /**
   * drop a server's
   * entry from the per-pass refusal log, if present. The
   * `indexOf` + `splice` pattern was repeated at 4 sites
   * (`removeServer`, `disconnectServer`, `runWithDiscoveryTimeout`
   * timeout handler, `readResource` late-reserve clear). Centralizing
   * here makes future fixes (e.g. emitting an `mcp_budget_cleared`
   * event when the entry is dropped) a one-place change.
   */
  private dropRefusalEntry(serverName: string): void {
    const idx = this.lastRefusedServerNames.indexOf(serverName);
    if (idx >= 0) {
      this.lastRefusedServerNames.splice(idx, 1);
    }
    // keep the transport map aligned with the names list so a
    // late-cleared refusal (e.g. operator removed the server) doesn't
    // leave stale transport metadata that would surface in a future
    // batch event if the same name later got refused again.
    this.lastRefusedTransports.delete(serverName);
    // drop the name from the unsent-refusals queue too. If it
    // was queued but not yet emitted, the operator action that
    // cleared it (disconnect, server removed) makes the queued
    // event stale; if it was already emitted, this is a no-op.
    this.pendingRefusalNames.delete(serverName);
  }

  /**
   * record a refusal +
   * emit the operator-visible stderr breadcrumb. The push +
   * stderr.write block was repeated at 3 sites (`discoverAllMcpTools`
   * + `discoverAllMcpToolsIncremental` + `discoverMcpToolsForServerInternal`).
   * Centralizing here keeps the message format consistent and makes
   * future telemetry additions (e.g. `recordStartupEvent` per
   * refusal) a one-place change.
   *
   * Idempotent on the push: if `serverName` is already in the list
   * (rare but possible for the lazy-spawn refusal path which can be
   * reached more than once for the same server), the array isn't
   * grown. The stderr line still fires so the operator sees the
   * refusal at every reproduction.
   */
  private refuseAndLog(
    serverName: string,
    serverConfig: MCPServerConfig | undefined,
  ): void {
    if (!this.lastRefusedServerNames.includes(serverName)) {
      this.lastRefusedServerNames.push(serverName);
    }
    // record the transport family at refusal time so the
    // `refused_batch` event payload can break it down. Latest-write
    // wins: a duplicate refusal in the same pass updates the entry
    // instead of growing the names list (mirrors the `.includes`
    // guard above).
    this.lastRefusedTransports.set(
      serverName,
      serverConfig ? mcpTransportOf(serverConfig) : 'unknown',
    );
    // queue the name for the next push-event emit. Set
    // semantics make repeated `refuseAndLog` for the same name in
    // one pass collapse into one queued entry (matches the
    // `lastRefusedServerNames.includes` guard above).
    this.pendingRefusalNames.add(serverName);
    process.stderr.write(
      `qwen serve: MCP server '${serverName}' refused (budget exhausted, ` +
        `budget=${this.clientBudget}, mode=enforce)\n`,
    );
  }

  /**
   * post-discovery budget
   * telemetry was duplicated verbatim in `discoverAllMcpTools` and
   * `discoverAllMcpToolsIncremental`. Centralized here so future
   * field additions to `mcp_budget_decision` happen in one place.
   * `off` mode is a no-op — operators who never set a budget don't
   * pollute the startup-event sink.
   *
   * Invariant (post R8 #2): `mode !== 'off'` ⇒ `clientBudget` was
   * resolved. Both `readBudgetFromEnv` AND the constructor downgrade
   * `enforce`/`warn`-without-budget to `off` so neither call site can
   * leave a budgetless mode reaching this telemetry path.
   * `clientBudget ?? 0` is kept as belt-and-suspenders against future
   * call sites that might bypass both validations.
   */
  private emitBudgetTelemetry(configuredCount: number): void {
    if (this.budgetMode === 'off') return;
    recordStartupEvent('mcp_budget_decision', {
      mode: this.budgetMode,
      budget: this.clientBudget ?? 0,
      configured: configuredCount,
      reserved: this.reservedSlots.size,
      refused: this.lastRefusedServerNames.length,
    });
  }

  /**
   * hysteresis state machine for `'budget_warning'` events.
   * Called at end of each discovery pass and in the `readResource`
   * lazy-spawn path after a successful slot reservation.
   *
   * Invariants:
   *   - In `off` mode or with no budget configured: hard no-op.
   *     `warnArmed` stays at its initial `true`, never read or
   *     mutated. The constructor's `onBudgetEvent` capture is
   *     `undefined` in `off` mode, so an accidental call wouldn't
   *     fire anyway — defense in depth.
   *   - Trigger is `reservedSlots.size / clientBudget`, NOT
   *     `liveCount / clientBudget`. Reservations include in-flight
   *     connects and survive transient `disconnectServer` calls,
   *     making the trigger stable against connect/disconnect
   *     chatter. Payload exposes BOTH so SDK consumers can pick.
   *   - One fire per upward 75% crossing; no fire while the ratio
   *     stays at or above 0.75; re-arms only on dropping below
   *     0.375. Mirrors `slow_client_warning`'s hysteresis exactly.
   */
  private evaluateBudgetState(): void {
    if (this.budgetMode === 'off' || this.clientBudget === undefined) return;
    const ratio = this.reservedSlots.size / this.clientBudget;
    if (this.warnArmed && ratio >= MCP_BUDGET_WARN_FRACTION) {
      this.warnArmed = false;
      // visibility for oncall
      // pre-fix `evaluateBudgetState` had ZERO log output, so
      // operators couldn't distinguish "events emitted but
      // dropped downstream" from "events never emitted." Mirrors
      // the stderr breadcrumb in `refuseAndLog` for the refusal
      // side; warning side now has its own debug trail.
      debugLogger.info(
        `MCP budget warning fired (ratio=${ratio.toFixed(2)}, ` +
          `reservedCount=${this.reservedSlots.size}, ` +
          `budget=${this.clientBudget}, mode=${this.budgetMode})`,
      );
      this.emitBudgetEvent({
        kind: 'budget_warning',
        liveCount: this.getMcpClientAccounting().total,
        reservedCount: this.reservedSlots.size,
        budget: this.clientBudget,
        thresholdRatio: MCP_BUDGET_WARN_FRACTION,
        mode: this.budgetMode,
      });
    } else if (!this.warnArmed && ratio < MCP_BUDGET_REARM_FRACTION) {
      this.warnArmed = true;
      // re-arm transitions are silent
      // by design (no SDK event), but operators dashboarding budget
      // pressure benefit from knowing the manager has re-armed
      // the next 75% crossing will fire a fresh warning.
      debugLogger.info(
        `MCP budget warning re-armed (ratio=${ratio.toFixed(2)}, ` +
          `budget=${this.clientBudget}; next 75% crossing will fire)`,
      );
    }
  }

  /**
   * coalesce per-pass refusals into a single `'refused_batch'`
   * event. Called at end of `discoverAllMcpTools` and
   * `discoverAllMcpToolsIncremental`, plus the `readResource` lazy-
   * spawn refusal path (where it emits a length-1 batch for shape
   * consistency).
   *
   * Idempotent on empty queue: when `pendingRefusalNames.size === 0`
   * the call short-circuits without firing or clearing.
   *
   * What gets cleared on a successful emit:
   * - `pendingRefusalNames` — drained, so a follow-up
   *   `emitRefusedBatchIfAny` in the same pass is a no-op.
   *
   * What does NOT get cleared on emit (doc fix):
   * - `lastRefusedServerNames` — snapshot-visible, must survive
   *   between passes so `GET /workspace/mcp` reports the last
   *   refusal set even after the push event fired.
   * - `lastRefusedTransports` — sidecar of the names list, same
   *   lifetime: reset at start of each pass / `stop()` /
   *   `dropRefusalEntry`, NOT on emit.
   *
   * `mode: 'enforce'` is a literal: `warn` mode never refuses, so the
   * code path that calls `refuseAndLog` (the only writer of
   * `lastRefusedServerNames`) is reachable only under `enforce`.
   */
  private emitRefusedBatchIfAny(): void {
    // suppress inline emit while
    // a bulk pass is active. The bulk pass's terminal emit (after
    // `bulkPassDepth--` in its `finally`) will drain the queue once.
    // This preserves the documented "one batch per `discoverAllMcpTools*`
    // pass" contract — pre-fix, every per-server refusal inside an
    // incremental pass produced its own length-1 batch, breaking the
    // contract for the most common refusal scenario.
    if (this.bulkPassDepth > 0) return;
    if (this.pendingRefusalNames.size === 0) return;
    if (this.clientBudget === undefined || this.budgetMode !== 'enforce') {
      // Defensive: refusals queued without `enforce` + budget means
      // some upstream path mis-reserved. Drain the queue so it
      // doesn't loop into the next pass; skip the emit (we can't
      // build a truthful payload without a real budget value).
      //
      // pre-fix this branch was silent.
      // The two writers of `pendingRefusalNames` (`refuseAndLog`)
      // are gated on `enforce` mode, so reaching this point means
      // an invariant violation. Surface the regression at debug
      // level so a future bug can be diagnosed by flipping debug
      // on, not by reverse-engineering missing telemetry.
      debugLogger.warn(
        `MCP guardrail: dropped ${this.pendingRefusalNames.size} ` +
          `pending refusal(s) — invariant violation ` +
          `(budget=${this.clientBudget}, mode=${this.budgetMode}). ` +
          `This branch should be unreachable; investigate the ` +
          `refuseAndLog call sites.`,
      );
      this.pendingRefusalNames.clear();
      return;
    }
    // emit names in `lastRefusedServerNames` insertion order,
    // restricted to the not-yet-emitted set. Insertion order matches
    // config-declaration order (the loop in `discoverAllMcpTools*`
    // uses `Object.entries`), giving SDK consumers a deterministic
    // ordering across reconnects.
    const namesInOrder = this.lastRefusedServerNames.filter((n) =>
      this.pendingRefusalNames.has(n),
    );
    if (namesInOrder.length === 0) {
      // The pending set is non-empty but none of the names appear in
      // `lastRefusedServerNames` — shouldn't happen given `refuseAndLog`
      // adds to both. Drain defensively to avoid a stuck queue.
      //
      // same rationale as the
      // budget/mode invariant branch above — surface unreachable
      // states so future regressions are diagnosable.
      debugLogger.warn(
        `MCP guardrail: dropped ${this.pendingRefusalNames.size} ` +
          `pending refusal(s) — names absent from ` +
          `lastRefusedServerNames (the two writers in refuseAndLog ` +
          `are paired; reaching this branch indicates a sync gap).`,
      );
      this.pendingRefusalNames.clear();
      return;
    }
    const refusedServers: McpRefusedServer[] = namesInOrder.map((name) => ({
      name,
      transport: this.lastRefusedTransports.get(name) ?? 'unknown',
      reason: 'budget_exhausted' as const,
    }));
    this.emitBudgetEvent({
      kind: 'refused_batch',
      refusedServers,
      budget: this.clientBudget,
      liveCount: this.getMcpClientAccounting().total,
      reservedCount: this.reservedSlots.size,
      mode: 'enforce',
    });
    this.pendingRefusalNames.clear();
  }

  /**
   * single boundary for `onBudgetEvent`
   * invocation. The manager's state machine and refused-batch
   * coalescer both call this — the production ACP adapter wraps its
   * extNotification in `void ... .catch()` so async failures don't
   * leak, but the callback ITSELF could throw synchronously (a future
   * test fixture, a buggy adapter, an unexpected serialization
   * crash). Without this guard, the throw would propagate into MCP
   * discovery / `readResource` / `disconnectServer` paths and abort
   * unrelated work — budget push events are best-effort telemetry,
   * NEVER critical-path.
   *
   * Logs at `debug` level so production daemons stay quiet on the
   * happy path; oncall flips debug on when investigating an MCP
   * guardrail incident and sees both delivery successes (via
   * `evaluateBudgetState`'s info logs) and failures.
   */
  private emitBudgetEvent(event: McpBudgetEvent): void {
    if (!this.onBudgetEvent) return;
    try {
      this.onBudgetEvent(event);
    } catch (err) {
      debugLogger.debug(
        `MCP budget event callback threw (kind=${event.kind}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Initiates the tool discovery process for all configured MCP servers.
   * It connects to each server, discovers its available tools, and registers
   * them with the `ToolRegistry`.
   *
   * in pool mode (`this.pool !== undefined`),
   * non-SDK MCP servers go through the workspace-shared transport
   * pool. SDK MCP and HTTP/SSE (when not opt-in) fall back through
   * the pool's own `createUnpooledConnection` path so this manager
   * doesn't need to maintain a parallel SDK code path. Pool entries
   * are tracked in `this.pooledConnections` for `disconnectServer` /
   * `stop` to release cleanly.
   */
  async discoverAllMcpTools(cliConfig: Config): Promise<void> {
    if (cliConfig.isTrustedFolder?.() === false) {
      return;
    }
    if (this.pool) {
      return this.discoverAllMcpToolsViaPool(cliConfig);
    }
    await this.stop();

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    // mark the bulk pass active
    // so per-server `emitRefusedBatchIfAny` calls (which the inner
    // `discoverMcpToolsForServer` path makes when it refuses a slot)
    // queue the names instead of firing length-1 batches inline. The
    // matching `bulkPassDepth--` + terminal `emitRefusedBatchIfAny`
    // run after `Promise.all` resolves, draining the queue once as
    // a coalesced length-N batch.
    this.bulkPassDepth++;
    try {
      this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
      // Reset per-pass refusal log so a snapshot taken after this pass
      // reflects THIS pass's refusals, not a stale one. Reservations
      // (this.reservedSlots) persist across passes — they're keyed by
      // server name, which is the operator's intent unit.
      this.lastRefusedServerNames = [];
      // keep the transport sidecar aligned with the names list,
      // and drain any unsent refusal queue from a prior pass so it
      // can't bleed into this pass's batch.
      this.lastRefusedTransports.clear();
      this.pendingRefusalNames.clear();

      this.eventEmitter?.emit('mcp-client-update', this.clients);
      const discoveryPromises = Object.entries(servers).map(
        async ([name, config]) => {
          // Skip disabled servers
          if (cliConfig.isMcpServerDisabled(name)) {
            debugLogger.debug(`Skipping disabled MCP server: ${name}`);
            return;
          }

          // Skip project-scoped (`.mcp.json`) servers the user has not
          // approved (#4615). This MUST be before `tryReserveSlot` /
          // `new McpClient` / `connect()` so an untrusted `.mcp.json` never
          // spawns a process, opens a transport, or runs a health check.
          if (cliConfig.isMcpServerPendingApproval?.(name)) {
            debugLogger.debug(`Skipping MCP server pending approval: ${name}`);
            return;
          }

          // Budget gate : synchronous slot reservation BEFORE the
          // `await client.connect()` below. Refusal only happens under
          // `enforce` mode; `warn` mode reserves regardless so accounting
          // reflects the configured set. `off` is a no-op.
          const reservation = this.tryReserveSlot(name);
          if (reservation === 'refused') {
            this.refuseAndLog(name, config);
            return;
          }

          // For SDK MCP servers, pass the sendSdkMcpMessage callback
          const sdkCallback = isSdkMcpServerConfig(config)
            ? this.sendSdkMcpMessage
            : undefined;

          const client = new McpClient(
            name,
            config,
            this.toolRegistry,
            this.cliConfig.getPromptRegistry(),
            this.cliConfig.getWorkspaceContext(),
            this.cliConfig.getDebugMode(),
            sdkCallback,
          );
          this.clients.set(name, client);

          this.eventEmitter?.emit('mcp-client-update', this.clients);
          try {
            await client.connect();
            await client.discover(cliConfig);
            this.eventEmitter?.emit('mcp-client-update', this.clients);
          } catch (error) {
            // zombie slot leak.
            // `tryReserveSlot(name)` reserved a slot above. If `connect()`
            // throws, the slot would stay reserved forever and the client
            // entry would stay in `this.clients` in a never-CONNECTED
            // state, blocking other servers in `enforce` mode until a
            // full discovery restart. Release both so the budget cap
            // reflects actual usable capacity.
            //
            // Slot bookkeeping in this bulk path is partially redundant
            // with `await this.stop()` at the top of
            // `discoverAllMcpTools` (line ~320) — the next bulk run
            // wipes `reservedSlots` regardless. But the SAME catch
            // ALSO needs to handle the transport (see below): the
            // client object held by `clients.delete(name)` only had
            // its tracking reference removed, not its underlying
            // transport closed. Leaving the orphan transport alive
            // would leak the stdio child / WebSocket / HTTP socket
            // for the rest of the process — `stop()` can't clean it
            // because we just removed it from the map.
            //
            // The per-server reconnect path
            // (`discoverMcpToolsForServerInternal`) keeps the slot
            // when `weReservedSlot === false` so health-monitor retry
            // doesn't have to compete for capacity — different
            // lifecycle, different contract. Bulk path always releases
            // because every server is "fresh" here (preceded by
            // stop()).
            //
            // also
            // call `await client.disconnect()` BEFORE dropping the
            // reference. R7 #3 fixed the analogous leak in the
            // per-server path; this is the bulk-path mirror. Errors
            // intentionally swallowed (we're already in a discovery-
            // failure catch; double-throwing would lose the original
            // error context).
            try {
              await client.disconnect();
            } catch {
              // best-effort transport cleanup
            }
            this.releaseSlotName(name);
            this.clients.delete(name);
            this.eventEmitter?.emit('mcp-client-update', this.clients);
            // Log the error but don't let a single failed server stop the others
            debugLogger.error(
              `Error during discovery for server '${name}': ${getErrorMessage(
                error,
              )}`,
            );
          }
        },
      );

      await Promise.all(discoveryPromises);
      this.discoveryState = MCPDiscoveryState.COMPLETED;
      this.emitBudgetTelemetry(Object.keys(servers).length);
    } finally {
      // fix #3: drop the bulk-pass marker BEFORE the terminal
      // emit so `emitRefusedBatchIfAny` actually fires (its early-
      // return guard reads `bulkPassDepth`). The warning event fires
      // inline from `tryReserveSlot` / `releaseSlotName` whenever a
      // slot mutation crosses the 75% threshold
      // #4 — so no terminal `evaluateBudgetState` is needed here.
      // Refused batch is the only deferred emit (coalesced over the
      // whole pass — fix #3 makes this a strict invariant).
      this.bulkPassDepth--;
      this.emitRefusedBatchIfAny();
    }
  }

  /**
   * Connects to a single MCP server and discovers its tools/prompts.
   * The connected client is tracked so it can be closed by {@link stop}.
   *
   * This is primarily used for on-demand re-discovery flows (e.g. after OAuth).
   */
  async discoverMcpToolsForServer(
    serverName: string,
    cliConfig: Config,
  ): Promise<void> {
    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      return;
    }
    if (this.pool && !isSdkMcpServerConfig(serverConfig)) {
      await this.discoverAllMcpToolsViaPool(cliConfig);
      return;
    }

    const inProgressDiscovery = this.serverDiscoveryPromises.get(serverName);
    if (inProgressDiscovery) {
      await inProgressDiscovery;
      return;
    }

    const discoveryPromise = this.discoverMcpToolsForServerInternal(
      serverName,
      cliConfig,
    );
    this.serverDiscoveryPromises.set(serverName, discoveryPromise);

    try {
      await discoveryPromise;
    } finally {
      if (this.serverDiscoveryPromises.get(serverName) === discoveryPromise) {
        this.serverDiscoveryPromises.delete(serverName);
      }
    }
  }

  private async discoverMcpToolsForServerInternal(
    serverName: string,
    cliConfig: Config,
  ): Promise<void> {
    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      return;
    }
    if (cliConfig.isTrustedFolder?.() === false) {
      debugLogger.debug(
        `Skipping MCP server in untrusted folder: ${serverName}`,
      );
      return;
    }
    // disabled gate.
    // `discoverMcpToolsForServerInternal` is reachable from
    // `/mcp reconnect`, OAuth re-discovery, and the health monitor's
    // `reconnectServer`. Without this check those paths could
    // resurrect a server the operator has explicitly disabled,
    // wasting a budget slot and registering tools the user told us
    // to ignore. Mirrors the disabled checks in
    // `discoverAllMcpTools` + `discoverAllMcpToolsIncremental` +
    // `readResource`.
    //
    // Optional-chain on `isMcpServerDisabled` is defensive against
    // test fixtures that omit the method (the bulk paths already
    // assume it exists; this single-server path was the laggard).
    // Production `Config` always defines the method.
    if (this.cliConfig.isMcpServerDisabled?.(serverName)) {
      debugLogger.debug(`Skipping disabled MCP server: ${serverName}`);
      return;
    }

    // Pending-approval project servers (`.mcp.json`) are never connected on the
    // single-server path either (#4615). Optional-chain matches the defensive
    // style above for test fixtures that omit the method.
    if (this.cliConfig.isMcpServerPendingApproval?.(serverName)) {
      debugLogger.debug(`Skipping MCP server pending approval: ${serverName}`);
      return;
    }

    // single-server rediscovery (reachable from
    // `/mcp reconnect <name>` and `ToolRegistry.discoverToolsForServer`)
    // previously bypassed the budget gate, so a server refused at startup
    // could be brought online later under `enforce` mode and exceed the
    // cap. True reconnect against a held slot returns `'already_held'`
    // and falls through unchanged; only a fresh attempt against a server
    // without a reservation can be refused. Best-effort semantics — log
    // the refusal and return without creating an `McpClient`; the caller
    // observes the absence via `getStatus()` like any other discovery
    // failure.
    const reservation = this.tryReserveSlot(serverName);
    if (reservation === 'refused') {
      this.refuseAndLog(serverName, serverConfig);
      // single-server refusal (e.g. health-monitor retry into
      // a full budget, `/mcp reconnect <name>`) emits a length-1
      // batch for shape consistency with the bulk-pass refusal.
      // Operators / dashboards see one event shape regardless of
      // entrypoint.
      this.emitRefusedBatchIfAny();
      return;
    }
    // track whether THIS call
    // freshly reserved the slot. Used in the connect-failure catch
    // below — only the fresh-reserve case releases the slot; a true
    // reconnect (`'already_held'`) keeps its existing reservation so
    // health-monitor retry doesn't have to compete for capacity.
    //
    // The `reservedSlots.has(serverName)` guard distinguishes a real
    // reservation from an `off`-mode no-op: in `off` mode
    // `tryReserveSlot` returns `'reserved'` WITHOUT adding to the
    // set (no enforcement), so we don't want to fire cleanup for
    // a slot we never actually took — that would unnecessarily
    // remove the failed client entry and break the
    // health-monitor-driven retry loop (regression test:
    // "should restore health checks after failed server
    // rediscovery").
    const weReservedSlot =
      reservation === 'reserved' && this.reservedSlots.has(serverName);
    // mark this name in
    // `freshReservations` so the `runWithDiscoveryTimeout` timeout
    // handler can distinguish fresh-reservation timeouts (release
    // the slot — never connected, shouldn't block others) from
    // `'already_held'` reconnect timeouts (keep the slot — operator's
    // previously-healthy server shouldn't be demoted by a transient
    // timeout). Cleared in success / catch / finally below so the
    // marker only spans the current discoverMcpToolsForServerInternal
    // invocation.
    if (weReservedSlot) {
      this.freshReservations.add(serverName);
    }

    this.stopHealthCheck(serverName);

    // Ensure we don't leak an existing connection for this server.
    const existingClient = this.clients.get(serverName);
    if (existingClient) {
      try {
        await existingClient.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error stopping client '${serverName}': ${getErrorMessage(error)}`,
        );
      } finally {
        this.clients.delete(serverName);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
      }
    }

    // For SDK MCP servers, pass the sendSdkMcpMessage callback.
    const sdkCallback = isSdkMcpServerConfig(serverConfig)
      ? this.sendSdkMcpMessage
      : undefined;

    const client = new McpClient(
      serverName,
      serverConfig,
      this.toolRegistry,
      this.cliConfig.getPromptRegistry(),
      this.cliConfig.getWorkspaceContext(),
      this.cliConfig.getDebugMode(),
      sdkCallback,
    );

    this.clients.set(serverName, client);
    this.eventEmitter?.emit('mcp-client-update', this.clients);

    try {
      await client.connect();
      await client.discover(cliConfig);
      // a server that
      // was refused at a previous discovery pass and is now
      // successfully (re)connected via this path (e.g. `/mcp
      // reconnect`, health-monitor retry after another server was
      // removed) leaves a stale entry in `lastRefusedServerNames`.
      // The snapshot would then report `error / disabledReason:
      // 'budget'` for a CONNECTED server until the next discovery
      // pass clears the per-pass log. Clear it here so post-success
      // snapshots immediately reflect reality. Mirrors the same
      // pattern in `readResource`'s late-reserve branch.
      this.dropRefusalEntry(serverName);
      // fix #4: hysteresis is driven inline by
      // `tryReserveSlot` (upward) and `releaseSlotName` (downward).
      // The standalone `evaluateBudgetState` that used to live here
      // is now redundant — the reservation that opened this branch
      // already fired the warning if it crossed 75%.
    } catch (error) {
      // two-mode
      // cleanup for connect failure, matching the `readResource`
      // R2 C3 fix pattern:
      //
      //   - `weReservedSlot === true` (this call freshly took a
      //     slot for a brand-new server): RELEASE the slot + drop
      //     the client. The server never successfully held a slot
      //     and shouldn't permanently block another server in
      //     `enforce` mode. Operator can re-add it later; the next
      //     `discoverAllMcpToolsIncremental` pass will re-reserve
      //     if capacity is available.
      //   - `weReservedSlot === false` (reconnect against an
      //     `'already_held'` slot — e.g. health-monitor retry,
      //     `/mcp reconnect` against a stable-but-momentarily-flaky
      //     server): KEEP the slot. The original successful connect
      //     established operator intent + capacity reservation; a
      //     transient reconnect hiccup shouldn't lose that.
      //
      // Corrected here: align with
      // `discoverAllMcpTools` (bulk) catch and `readResource`
      // (lazy spawn) catch. All three paths now use the same
      // weReserved-driven cleanup.
      if (weReservedSlot) {
        // transport
        // leak — when `connect()` succeeded (transport established)
        // but `discover()` later threw, deleting the client without
        // calling `disconnect()` left the stdio child process /
        // socket alive until Node exits. Best-effort disconnect
        // here closes the transport before dropping our reference.
        // Errors from disconnect are intentionally swallowed
        // (we're already in a discovery-failure catch; double-
        // throwing would lose the original error context).
        try {
          await client.disconnect();
        } catch {
          // best-effort transport cleanup
        }
        this.releaseSlotName(serverName);
        this.clients.delete(serverName);
      }
      // Log the error but don't throw: callers expect best-effort discovery.
      debugLogger.error(
        `Error during discovery for server '${serverName}': ${getErrorMessage(
          error,
        )}`,
      );
    } finally {
      this.startHealthCheck(serverName);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
      // R8 #4: clear the fresh-reservation marker — this in-flight
      // call has settled (success, catch, OR a timeout that already
      // ran its handler). Idempotent on the timeout-already-deleted
      // case.
      this.freshReservations.delete(serverName);
    }
  }

  /**
   * pool-mode discovery. Iterates configured
   * servers and calls `pool.acquire(name, cfg, sessionId, toolReg,
   * promptReg)` for each non-disabled server. Pool internally:
   *   - Returns the existing PoolEntry if same fingerprint already
   *     spawned for this workspace (other sessions sharing it)
   *   - Spawns a new entry otherwise (deduped via spawnInFlight)
   *   - For SDK MCP / non-pooled HTTP: routes to
   *     `createUnpooledConnection` (per-session McpClient with the
   *     supplied session registries)
   *   - On attach: synchronously applies tool/prompt snapshots into
   *     the supplied session registries via `SessionMcpView`
   *
   * Per-session reconnect / health monitoring / budget enforcement
   * lives inside the pool, NOT in this manager — `this.reservedSlots`
   * / `this.healthCheckTimers` etc. stay empty in pool mode (they're
   * still allocated for legacy mode coexistence).
   *
   * Pre-pool path's `await this.stop()` releases EVERYTHING; here we
   * only need to drop the manager's own pool refs because cross-
   * session pool entries still belong to the pool.
   */
  private discoverAllMcpToolsViaPool(cliConfig: Config): Promise<void> {
    // Re-entrancy guard : if a pass is in flight, return the
    // same promise so the caller awaits the in-flight resolution
    // instead of triggering a parallel pass that races on
    // `pooledConnections`. Cleanup runs in `.finally` so the next
    // call (after this pass completes) starts fresh.
    if (this.discoveryInFlight) return this.discoveryInFlight;
    this.discoveryInFlight = this.runDiscoverAllMcpToolsViaPool(
      cliConfig,
    ).finally(() => {
      this.discoveryInFlight = undefined;
    });
    return this.discoveryInFlight;
  }

  private async runDiscoverAllMcpToolsViaPool(
    cliConfig: Config,
  ): Promise<void> {
    if (!this.pool) return; // unreachable; caller already gates
    // reset the
    // shutdown-timeout flag at the START of every discovery pass. The
    // flag is sticky — it persists across `stop()` calls until
    // explicitly reset. Without this reset, a manager that survived
    // one timed-out shutdown (e.g., a slow MCP server during SIGTERM
    // exceeding the 5s grace cap) would then enter every subsequent
    // discovery pass with the guard already true, silently calling
    // `conn.release()` and skipping `pooledConnections.set(...)` for
    // every server — the manager would appear to discover servers but
    // none would be reachable for subsequent tool calls. A fresh
    // discovery pass means we're past any prior shutdown phase.
    this.stopTimedOut = false;
    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
    // also write the
    // module-global `mcpDiscoveryState`. Pre-fix the pool path only
    // updated `this.discoveryState` (manager-local) — `GET /workspace/mcp`
    // and the MCP preflight cell read the GLOBAL via
    // `getMCPDiscoveryState()` and reported `not_started` for a
    // workspace whose pool discovery was running or already
    // complete. Snapshot now reflects reality regardless of which
    // discovery path (legacy per-session or pool) is active.
    setMCPDiscoveryState(MCPDiscoveryState.IN_PROGRESS);
    // bracket the pass with the pool's budget
    // bulk-pass scope so per-server BudgetExhaustedError refusals
    // accumulate into ONE coalesced `refused_batch` event at end of
    // pass — matches per-pass contract for the snapshot
    // route AND the typed push event consumers depend on.
    const poolBudget = this.pool.getBudget();
    poolBudget?.beginBulkPass();
    try {
      const sessionId = this.cliConfig.getSessionId();
      const promptRegistry = this.cliConfig.getPromptRegistry();
      const resourceRegistry = this.cliConfig.getResourceRegistry();
      const servers = populateMcpServerCommand(
        this.cliConfig.getMcpServers() || {},
        this.cliConfig.getMcpServerCommand(),
      );
      // diff against the
      // current `pooledConnections` instead of releasing all then
      // re-acquiring everything. Pre-fix every incremental discovery
      // pass (the default progressive-mode boot path also routes
      // through here) was: `release-all` → `view.teardown` →
      // `removeMcpToolsByServer` for every server, then
      // `pool.acquire` → `view.applyTools` re-registers everything.
      // That left a brief window with zero MCP tools registered AND
      // bounced every pool entry's drain timer for no reason. Now:
      //   1. Build the desired (name, fingerprint) set from current
      //      config + filters (skip disabled, skip SDK MCP).
      //   2. Release stale pooled connections (server removed,
      //      disabled, or fingerprint changed) — survivors stay
      //      attached, no tool registry churn.
      //   3. Acquire only the desired connections we don't already
      //      hold by id.
      // SDK MCP servers always re-run via legacy
      // `discoverMcpToolsForServer` (idempotent on re-call; the
      // legacy path's `discoverMcpToolsForServer` purges existing
      // entries before rediscovery).
      const desiredIds = new Map<string, ConnectionId>();
      for (const [name, config] of Object.entries(servers)) {
        if (cliConfig.isMcpServerDisabled(name)) continue;
        if (isSdkMcpServerConfig(config)) continue;
        desiredIds.set(name, connectionIdOf(name, config));
      }
      // Release connections that are stale (no longer wanted, or
      // wanted but with a different fingerprint).
      for (const [name, conn] of [...this.pooledConnections]) {
        const desired = desiredIds.get(name);
        if (desired === undefined || desired !== conn.id) {
          try {
            conn.release();
          } catch (err) {
            debugLogger.debug(
              `Pool release error (ignored): ${getErrorMessage(err)}`,
            );
          }
          this.pooledConnections.delete(name);
        }
      }
      const acquirePromises = Object.entries(servers).map(
        async ([name, config]) => {
          if (cliConfig.isMcpServerDisabled(name)) {
            debugLogger.debug(
              `Skipping disabled MCP server (pool mode): ${name}`,
            );
            return;
          }
          // SDK MCP servers MUST
          // stay on the legacy McpClientManager path because their
          // `sendSdkMcpMessage` callback is bound per-session in this
          // manager's ctor, but the workspace-shared pool was
          // constructed in `QwenAgent` ctor without it. Routing SDK
          // MCP through `pool.acquire` would yield an McpClient with
          // `sendSdkMcpMessage: undefined`, breaking SDK MCP server
          // tool calls. The legacy path below preserves the
          // per-session callback wiring and SDK servers continue to
          // work bit-for-bit identically to the legacy daemon mode.
          if (isSdkMcpServerConfig(config)) {
            await this.discoverMcpToolsForServer(name, cliConfig);
            return;
          }
          // R2 follow-on: skip if we already hold the exact desired
          // connection (survived the diff above). Avoids the redundant
          // `pool.acquire` call which would otherwise just bump the
          // entry's refcount + trigger a snapshot replay.
          if (this.pooledConnections.has(name)) return;
          try {
            const conn = await this.pool!.acquire(
              name,
              config,
              sessionId,
              this.toolRegistry,
              promptRegistry,
              resourceRegistry,
            );
            //
            // subscribe to entry-level events so a `'failed'` event
            // (entry's restart hit reconnect-budget exhaustion →
            // terminal failure → entry removed from `pool.entries`)
            // evicts our stale handle.
            //
            // Keep a NAMED listener and unregister it on
            // 'failed' BEFORE deleting from `pooledConnections`. Pre-
            // fix the anonymous arrow stayed attached to the entry's
            // EventEmitter even after we deleted from
            // `pooledConnections` — the listener's closure pinned
            // `this` (manager) and `conn` (PooledConnection wrapper),
            // making cleanup depend on whole-object GC. With named +
            // self-unregister, the listener detaches as soon as the
            // 'failed' event fires.
            //
            // Idempotent — a second 'failed' event on the same id
            // is a no-op via `get(name) === conn` guard;
            // `releaseAllPooledConnections` / `stop` also call
            // `conn.release()` independently.
            const onFailed = (e: import('./mcp-pool-events.js').PoolEvent) => {
              if (e.kind !== 'failed') return;
              if (this.pooledConnections.get(name) === conn) {
                this.pooledConnections.delete(name);
              }
              conn.off('event', onFailed);
            };
            conn.on('event', onFailed);
            // skip
            // the set if shutdown already passed its 5s grace cap and
            // released pool connections. A late-resolving pool.acquire
            // (whose own 30s stdio timeout exceeds the shutdown cap)
            // would otherwise repopulate `pooledConnections` AFTER
            // `releaseAllPooledConnections` cleared it — orphan entry
            // (refcount never reaches 0, drain timer never fires).
            // Release the just-acquired connection so the pool's
            // refcount drops back to where it would have been if the
            // acquire had been refused.
            if (this.stopTimedOut) {
              try {
                conn.release();
              } catch {
                /* best effort — shutdown in progress */
              }
              return;
            }
            this.pooledConnections.set(name, conn);
          } catch (err) {
            // Pool acquire failure for one server is non-fatal for
            // siblings (matches the legacy `discoverMcpToolsForServer`
            // catch behavior). Operator visibility through standard
            // error logger; status snapshot reflects reality via the
            // global `serverStatuses` Map (pool's
            // `aggregateStatusByName` keeps it consistent).
            //
            // `BudgetExhaustedError` from the
            // pool's pre-spawn budget gate is not a "failure" — the
            // refusal was deliberate, already recorded by the pool's
            // `recordRefusal`, and will surface as a `refused_batch`
            // event at end of pass. Log at debug to avoid flooding
            // operators with one error per refused server.
            if (err instanceof BudgetExhaustedError) {
              debugLogger.debug(
                `Pool refused acquire for ${name} (budget exhausted, ` +
                  `budget=${err.budget}, reservedCount=${err.reservedCount})`,
              );
            } else {
              debugLogger.error(
                `Pool acquire failed for ${name}: ${getErrorMessage(err)}`,
              );
            }
          }
        },
      );
      await Promise.all(acquirePromises);
    } finally {
      poolBudget?.endBulkPass();
      this.discoveryState = MCPDiscoveryState.COMPLETED;
      // Same global update as the IN_PROGRESS write
      // above; preflight cell + snapshot route both read the global.
      setMCPDiscoveryState(MCPDiscoveryState.COMPLETED);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }
  }

  private releaseAllPooledConnections(): void {
    for (const conn of this.pooledConnections.values()) {
      try {
        conn.release();
      } catch (err) {
        debugLogger.debug(
          `Pool release error (ignored): ${getErrorMessage(err)}`,
        );
      }
    }
    this.pooledConnections.clear();
  }

  /**
   * Stops all running local MCP servers and closes all client connections.
   * This is the cleanup method to be called on application exit.
   */
  async stop(): Promise<void> {
    // Stop all health checks first
    this.stopAllHealthChecks();

    // drain
    // the in-flight pool discovery pass BEFORE releasing pool refs.
    // Pre-fix `stop()` called `releaseAllPooledConnections()` while a
    // pool-mode `discoverAllMcpToolsViaPool` was still mid-flight (e.g.
    // progressive discovery running during shutdown). The in-flight
    // pass would subsequently call `pool.acquire(...)` and attach a
    // fresh entry to `pooledConnections` AFTER the release loop had
    // already cleared the Map — leaking pool refs that no caller now
    // tracks.
    //
    // Hardening over plain `await`:
    //   1. Outer 5s deadline via `Promise.race` — a single hung MCP
    //      server should not block daemon SIGTERM indefinitely;
    //      individual acquires are bounded by `runWithTimeout`
    //      (stdio default 30s, remote 5s), but the aggregate
    //      `discoveryInFlight` promise has no inherent cap. Matches
    //      the pool's own `drainAll` shutdown-bounded contract.
    //   2. Debug log on entry + on rejection — pre-fix the empty catch
    //      silently swallowed rejections; an MCP-discovery hang during
    //      shutdown left zero log trail. Now operators tailing
    //      `--debug` see what `stop()` waited on AND whether the wait
    //      ended via resolution / rejection / timeout.
    //   3. Timer `unref()` so the grace timer doesn't hold the event
    //      loop open if discovery actually resolves first.
    if (this.discoveryInFlight) {
      debugLogger.debug(
        'stop(): awaiting in-flight pool discovery to drain (5s cap)',
      );
      const SHUTDOWN_DISCOVERY_GRACE_MS = 5_000;
      // clear the
      // grace timer in `finally` so its callback doesn't fire after
      // discovery settles cleanly. Without this, every clean shutdown
      // logs the false-positive "did not settle within 5s grace"
      // debug line 5s later (whenever the event loop happens to still
      // be alive). `t.unref()` only prevents the timer from holding
      // the loop open — it does NOT prevent the callback from
      // executing if other refs keep the loop alive.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      // The `stopTimedOut` flag is set synchronously inside
      // the grace-timer callback below — i.e. the instant the timer
      // fires (when `Promise.race` resolves via the timeout branch)
      // and BEFORE `stop()` proceeds to `releaseAllPooledConnections`.
      // Any in-flight `pool.acquire` callback that resolves between
      // the grace timeout firing and the release loop running sees
      // the gate at line ~1572 and skips the `pooledConnections.set`,
      // preventing the orphan-entry bug described below. Previously the
      // comment said "set BEFORE the race" which misled readers into
      // expecting a synchronous pre-set; the line citation `~1539`
      // was also stale (the consumer guard is at ~1572).
      // Pre-fix: a slow `pool.acquire` (stdio default 30s timeout)
      // that resolved at 8s did `pooledConnections.set` AFTER the
      // release loop had cleared the Map — orphan entry in the pool.
      try {
        await Promise.race([
          this.discoveryInFlight,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(() => {
              this.stopTimedOut = true;
              debugLogger.debug(
                'stop(): in-flight discovery did not settle within 5s grace; proceeding',
              );
              resolve();
            }, SHUTDOWN_DISCOVERY_GRACE_MS);
            graceTimer.unref?.();
          }),
        ]);
      } catch (err) {
        debugLogger.debug(
          `stop(): in-flight discovery rejected (proceeding): ${getErrorMessage(
            err,
          )}`,
        );
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    }

    // release all pool refs this manager holds.
    // Pool's drain timer kicks in for entries that hit refs=0; other
    // sessions still referencing the same entry keep it alive.
    this.releaseAllPooledConnections();

    const disconnectionPromises = Array.from(this.clients.entries()).map(
      async ([name, client]) => {
        try {
          await client.disconnect();
        } catch (error) {
          debugLogger.error(
            `Error stopping client '${name}': ${getErrorMessage(error)}`,
          );
        }
      },
    );

    await Promise.all(disconnectionPromises);
    this.clients.clear();
    this.consecutiveFailures.clear();
    this.isReconnecting.clear();
    this.serverDiscoveryPromises.clear();
    // clean shutdown releases ALL budget slots. A subsequent
    // `discoverAllMcpTools*` (e.g. the `discoverAllMcpTools` call in
    // its own body line 90, which awaits `this.stop()` first) starts
    // from an empty reservation set.
    this.reservedSlots.clear();
    this.freshReservations.clear();
    this.lastRefusedServerNames = [];
    // post-`stop` the manager is fresh — clear refusal
    // transport sidecar, drain the unsent-refusal queue, and re-arm
    // the warning state machine so the next discovery pass that
    // crosses 75% fires anew.
    this.lastRefusedTransports.clear();
    this.pendingRefusalNames.clear();
    this.warnArmed = true;
  }

  /**
   * Disconnects a specific MCP server.
   * @param serverName The name of the server to disconnect.
   */
  async disconnectServer(serverName: string): Promise<void> {
    // Stop health check for this server
    this.stopHealthCheck(serverName);

    // release this server's pool reference if
    // we acquired one. Pool starts drain timer at refs=0; entry will
    // be force-closed unless another session re-acquires.
    const pooled = this.pooledConnections.get(serverName);
    if (pooled) {
      pooled.release();
      this.pooledConnections.delete(serverName);
    }

    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error disconnecting client '${serverName}': ${getErrorMessage(error)}`,
        );
      } finally {
        this.clients.delete(serverName);
        this.consecutiveFailures.delete(serverName);
        this.isReconnecting.delete(serverName);
        this.serverDiscoveryPromises.delete(serverName);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
      }
    }
    // explicit operator-driven disconnect releases the budget
    // slot AND drops the entry from the per-pass refusal log. Outside
    // the `if (client)` guard because a budget-refused server has NO
    // `McpClient` instance — but operator intent ("stop tracking this
    // server") still demands the records be cleared so a subsequent
    // snapshot doesn't keep tagging it as `budget_exhausted`. The
    // internal reconnect path (`discoverMcpToolsForServerInternal`)
    // calls `existingClient.disconnect()` directly, NOT this public
    // method, so reconnect still doesn't release the slot.
    this.releaseSlotName(serverName);
    this.dropRefusalEntry(serverName);
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
  }

  getServerInstructions(): Map<string, string> {
    const instructions = new Map<string, string>();
    for (const [serverName, client] of this.clients) {
      const serverInstructions = client.getInstructions();
      if (serverInstructions) {
        instructions.set(serverName, serverInstructions);
      }
    }
    return instructions;
  }

  /**
   * Gets the health monitoring configuration
   */
  getHealthConfig(): MCPHealthMonitorConfig {
    return { ...this.healthConfig };
  }

  /**
   * Updates the health monitoring configuration
   */
  updateHealthConfig(config: Partial<MCPHealthMonitorConfig>): void {
    this.healthConfig = { ...this.healthConfig, ...config };
    // Restart health checks with new configuration
    this.stopAllHealthChecks();
    if (this.healthConfig.autoReconnect) {
      this.startAllHealthChecks();
    }
  }

  /**
   * Starts health monitoring for a specific server
   */
  private startHealthCheck(serverName: string): void {
    if (!this.healthConfig.autoReconnect) {
      return;
    }

    // Don't arm a health-check timer for a server that no longer has a
    // tracked client. The discovery-timeout handler deletes the client
    // before the discovery `finally` block runs `startHealthCheck`, and
    // without this guard we'd create a timer that fires every
    // checkIntervalMs and ultimately reconnects an intentionally
    // timed-out server (bypassing `runWithDiscoveryTimeout`).
    if (!this.clients.has(serverName)) {
      return;
    }

    // Clear existing timer if any
    this.stopHealthCheck(serverName);

    const timer = setInterval(async () => {
      await this.performHealthCheck(serverName);
    }, this.healthConfig.checkIntervalMs);

    this.healthCheckTimers.set(serverName, timer);
  }

  /**
   * Stops health monitoring for a specific server
   */
  private stopHealthCheck(serverName: string): void {
    const timer = this.healthCheckTimers.get(serverName);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(serverName);
    }
  }

  /**
   * Stops all health checks
   */
  private stopAllHealthChecks(): void {
    for (const [, timer] of this.healthCheckTimers.entries()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();
  }

  /**
   * Starts health checks for all connected servers
   */
  private startAllHealthChecks(): void {
    for (const serverName of this.clients.keys()) {
      this.startHealthCheck(serverName);
    }
  }

  /**
   * Performs a health check on a specific server
   */
  private async performHealthCheck(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      return;
    }

    // Skip if already reconnecting
    if (this.isReconnecting.get(serverName)) {
      return;
    }

    try {
      // Check if client is connected by getting its status
      const status = client.getStatus();

      if (status !== MCPServerStatus.CONNECTED) {
        // Connection is not healthy
        const failures = (this.consecutiveFailures.get(serverName) || 0) + 1;
        this.consecutiveFailures.set(serverName, failures);

        debugLogger.warn(
          `Health check failed for server '${serverName}' (${failures}/${this.healthConfig.maxConsecutiveFailures})`,
        );

        if (failures >= this.healthConfig.maxConsecutiveFailures) {
          // Trigger reconnection
          await this.reconnectServer(serverName);
        }
      } else {
        // Connection is healthy, reset failure count
        this.consecutiveFailures.set(serverName, 0);
      }
    } catch (error) {
      debugLogger.error(
        `Error during health check for server '${serverName}': ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Reconnects a specific server
   */
  private async reconnectServer(serverName: string): Promise<void> {
    if (this.isReconnecting.get(serverName)) {
      return;
    }

    this.isReconnecting.set(serverName, true);
    debugLogger.info(`Attempting to reconnect to server '${serverName}'...`);

    try {
      // Wait before reconnecting
      await new Promise((resolve) =>
        setTimeout(resolve, this.healthConfig.reconnectDelayMs),
      );

      await this.discoverMcpToolsForServer(serverName, this.cliConfig);

      // Reset failure count on successful reconnection
      this.consecutiveFailures.set(serverName, 0);
      debugLogger.info(`Successfully reconnected to server '${serverName}'`);
    } catch (error) {
      debugLogger.error(
        `Failed to reconnect to server '${serverName}': ${getErrorMessage(error)}`,
      );
    } finally {
      this.isReconnecting.set(serverName, false);
    }
  }

  /**
   * Discovers tools incrementally for all configured servers.
   * Only updates servers that have changed or are new.
   */
  async discoverAllMcpToolsIncremental(cliConfig: Config): Promise<void> {
    if (!cliConfig.isTrustedFolder()) {
      return;
    }
    // incremental
    // discovery is the path `Config.startMcpDiscoveryInBackground` takes
    // during `config.initialize()` under the default progressive mode.
    // Without this gate, daemon-mode sessions would bypass the
    // workspace-shared pool and silently revert to per-session
    // McpClient spawning during boot — the exact regression `discoverAllMcpTools`
    // was hardened against. Route through the same pool branch so every
    // discovery entry point honors the pool injection.
    if (this.pool) {
      return this.discoverAllMcpToolsViaPool(cliConfig);
    }

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    // suppress per-server
    // length-1 batches inside this incremental pass — the
    // `discoverMcpToolsForServerInternal` calls below would otherwise
    // emit one batch per refused server, breaking the documented
    // "one batch per pass" contract. The terminal
    // `emitRefusedBatchIfAny` (after `bulkPassDepth--`) drains the
    // queue once.
    this.bulkPassDepth++;
    try {
      this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
      // Reset per-pass refusal log; see the sibling reset in
      // `discoverAllMcpTools` for rationale.
      this.lastRefusedServerNames = [];
      // keep the transport sidecar aligned with the names list,
      // and drain any unsent refusal queue from a prior pass.
      this.lastRefusedTransports.clear();
      this.pendingRefusalNames.clear();
      recordStartupEvent('mcp_discovery_start', {
        serverCount: Object.keys(servers).length,
        incremental: true,
      });
      // Mirrors `discoverAllMcpTools`: announce IN_PROGRESS so UI subscribers
      // (MCP status pill, AppContainer batch-flush effect) know discovery
      // started, even when no servers need updates this pass.
      this.eventEmitter?.emit('mcp-client-update', this.clients);

      // Tracks the first successful server discover so we can emit the
      // `mcp_first_tool_registered` event exactly once. "First successful
      // discover" rather than a tool-count delta — simpler and aligns with the
      // user-perceived metric ("first MCP server is ready").
      let firstToolEventFired = false;

      // Find servers that are new or have changed configuration
      const serversToUpdate: string[] = [];
      const currentServerNames = new Set(this.clients.keys());
      const newServerNames = new Set(Object.keys(servers));

      // process removals BEFORE the new-server
      // reservation pass so freed slots are visible to `tryReserveSlot`.
      // Scenario: budget=2, currently `{a, b}` reserved, new config
      // `{a, c}`. Pre-fix order refused `c` because `b`'s slot was only
      // freed after the new-server loop. Now `b` is removed first →
      // reservedSlots={a} → `c` reservation succeeds. Disabled-mid-session
      // removals stay inline (below) because they also release slots
      // via `removeServer`'s `reservedSlots.delete` — same call, just
      // reached from a different branch.
      for (const name of currentServerNames) {
        if (!newServerNames.has(name)) {
          // Server was removed from configuration
          await this.removeServer(name);
        }
      }

      // Check for new servers or configuration changes
      for (const [name] of Object.entries(servers)) {
        // Mirror `discoverAllMcpTools` (line ~102): users who explicitly
        // disabled a server via `mcpServers.<name>.disabled: true` must not
        // see it reconnected by the incremental path. Without this, the
        // PR-A background path silently re-registers tools the user has
        // told us to ignore.
        // A project server (`.mcp.json`) that was pending approval at startup
        // is treated exactly like a disabled server here: never reconnected,
        // and torn down if a prior pass had connected it.
        if (
          cliConfig.isMcpServerDisabled(name) ||
          cliConfig.isMcpServerPendingApproval?.(name)
        ) {
          debugLogger.debug(
            cliConfig.isMcpServerDisabled(name)
              ? `Skipping disabled MCP server: ${name}`
              : `Skipping MCP server pending approval: ${name}`,
          );
          // If the server was previously enabled and got connected, we now
          // need to tear it down — otherwise its client, registered tools
          // and health checks linger after an enabled→disabled mid-session
          // transition (e.g. via `/mcp disable <name>`). `removeServer`
          // disconnects, drops the client entry, removes tools from the
          // registry, stops the health check, and removes the global
          // status so the Footer pill stops counting it.
          if (this.clients.has(name)) {
            await this.removeServer(name);
          }
          continue;
        }
        const existingClient = this.clients.get(name);
        if (!existingClient) {
          // pre-reservation
          // here was a TOCTOU race. The inner
          // `discoverMcpToolsForServerInternal` ALSO does `tryReserveSlot`
          // (added in R1 fix #1). With BOTH sites reserving, the
          // reservation lifecycle didn't align with the timeout
          // cleanup site — `runWithDiscoveryTimeout`'s timeout handler
          // could release the slot mid-flight while the inner
          // `connect()` later resolves successfully, leaving a
          // CONNECTED client with NO reservation. Next pass admits
          // another new server because `reservedSlots.size < budget`,
          // and `enforce` mode silently exceeds the cap.
          //
          // Fix: delete the pre-reservation. `discoverMcpToolsForServerInternal`
          // owns the reservation lifecycle end-to-end (reserve →
          // try-catch around connect → release on weReservedSlot
          // failure path → cleared by timeout handler if it fires).
          // Refusal still happens — just inside the inner call. The
          // operator-visible behavior is identical; only the race is
          // closed.
          serversToUpdate.push(name);
        } else if (
          existingClient.getStatus() === MCPServerStatus.DISCONNECTED
        ) {
          // Disconnected server, try to reconnect
          serversToUpdate.push(name);
        }
        // Note: Configuration change detection would require comparing
        // the old and new config, which is not implemented here
      }

      // Update only the servers that need it. Each per-server discover is
      // wrapped in a discovery-only timeout (stdio default 30s, remote 5s,
      // per-server override via `discoveryTimeoutMs`). Tool-call timeout is
      // intentionally left alone — a long-running tool invocation is not a
      // startup pathology.
      const discoveryPromises = serversToUpdate.map(async (name) => {
        const serverConfig = servers[name];
        try {
          await this.runWithDiscoveryTimeout(name, serverConfig, () =>
            this.discoverMcpToolsForServer(name, cliConfig),
          );
          // `discoverMcpToolsForServerInternal` swallows connect/discover
          // errors (best-effort discovery semantics — see its catch block),
          // so the try here resolves even for failed servers. Only the
          // timeout path reaches the catch below. Consult the actual
          // server status to decide which outcome to record, otherwise
          // every auth failure / crash / "no tools found" looks like
          // `ready` in the startup profile.
          const client = this.clients.get(name);
          const actuallyReady =
            !!client && getMCPServerStatus(name) === MCPServerStatus.CONNECTED;
          if (actuallyReady) {
            if (!firstToolEventFired) {
              firstToolEventFired = true;
              recordStartupEvent('mcp_first_tool_registered', {
                serverName: name,
              });
            }
            recordStartupEvent(`mcp_server_ready:${name}`, {
              outcome: 'ready',
            });
          } else {
            recordStartupEvent(`mcp_server_ready:${name}`, {
              outcome: 'failed',
              reason: 'connect or discover error',
            });
          }
        } catch (error) {
          // Defensive cleanup: the dedup Map entry is normally removed by
          // `discoverMcpToolsForServer`'s `finally`, but `runWithDiscoveryTimeout`
          // can reject before that finally runs (the timeout also disconnects
          // the client to abort the underlying handshake). Without this
          // explicit delete, a brief window exists where a subsequent
          // `discoverMcpToolsForServer(name)` call would short-circuit on
          // a now-doomed promise.
          this.serverDiscoveryPromises.delete(name);
          recordStartupEvent(`mcp_server_ready:${name}`, {
            outcome: 'failed',
            reason: getErrorMessage(error),
          });
          debugLogger.error(
            `Error during incremental discovery for server '${name}': ${getErrorMessage(error)}`,
          );
        }
      });

      await Promise.all(discoveryPromises);

      // Start health checks for all connected servers
      if (this.healthConfig.autoReconnect) {
        this.startAllHealthChecks();
      }

      this.discoveryState = MCPDiscoveryState.COMPLETED;
      recordStartupEvent('mcp_all_servers_settled', {
        serverCount: Object.keys(servers).length,
        incremental: true,
      });
      this.emitBudgetTelemetry(Object.keys(servers).length);
    } finally {
      // fix #3: drop the bulk marker BEFORE the terminal
      // emit so `emitRefusedBatchIfAny` actually fires the coalesced
      // batch. Warning fires inline from `tryReserveSlot` /
      // `releaseSlotName` (fix #4) — no terminal
      // `evaluateBudgetState` here.
      this.bulkPassDepth--;
      this.emitRefusedBatchIfAny();
    }
    // Trailing `mcp-client-update` AFTER flipping discoveryState to
    // COMPLETED. Without this the per-server updates above all fire while
    // the state is still IN_PROGRESS, so the AppContainer batch-flush
    // subscriber never observes the terminal state.
    this.eventEmitter?.emit('mcp-client-update', this.clients);
  }

  /**
   * Caps how long a single MCP server's discover handshake is allowed to
   * take during startup. Local stdio servers default to 30s; remote
   * HTTP/SSE servers default to 5s (mirrors Claude Code's
   * `CLAUDE_AI_MCP_TIMEOUT_MS`). Per-server override via
   * `mcpServers.<name>.discoveryTimeoutMs` in settings.
   */
  private runWithDiscoveryTimeout<T>(
    serverName: string,
    serverConfig: MCPServerConfig | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.discoveryTimeoutFor(serverConfig);
    let timedOut = false;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(async () => {
        timedOut = true;
        // CRITICAL: rejecting `runWithDiscoveryTimeout` does NOT cancel
        // the underlying `discoverMcpToolsForServer` — it keeps trying
        // to `connect()` / `discover()`, and if the slow server
        // eventually responds, `discover()` registers its tools into
        // the live `toolRegistry` and re-emits `mcp-client-update`.
        // From the user's perspective the server "failed" but its tools
        // are silently active, including any that shadow built-ins.
        //
        // Disconnect the client to abort the handshake so the background
        // promise rejects, then drop any tools that DID slip through the
        // race window. A fire-and-forget `client.disconnect()` is NOT
        // enough: `disconnect()` awaits `transport.close()`, and the
        // in-flight `discover()` may have already pumped its `tools/list`
        // response through the transport AND iterated
        // `toolRegistry.registerTool(tool)` synchronously by the time
        // the close lands. The earlier fix's comment described the
        // pre-fix state as a "remote-exploitable silent-tool-registration
        // vector" — `await` plus `removeMcpToolsByServer` closes it.
        const client = this.clients.get(serverName);
        if (client) {
          try {
            await client.disconnect();
          } catch (err) {
            debugLogger.debug(
              `Forced disconnect of timed-out server '${serverName}' threw: ${getErrorMessage(err)}`,
            );
          }
        }
        // Drop any tools that registered during the disconnect window. No-op
        // if the server hadn't reached `discover()` yet, so it's safe to
        // always call.
        this.toolRegistry.removeMcpToolsByServer(serverName);
        // Prevent the discovery `finally` block's `startHealthCheck` from
        // resurrecting this server: without removing the client entry,
        // `performHealthCheck` would observe `status !== CONNECTED` for
        // ~maxConsecutiveFailures intervals and then call
        // `reconnectServer()` → `discoverMcpToolsForServer()` directly,
        // bypassing `runWithDiscoveryTimeout` entirely. The intentionally
        // timed-out server would silently come back. Removing the client
        // entry + stopping any pending health-check timer closes that
        // loop; `startHealthCheck` early-returns when the client is
        // absent, so the trailing `finally`-block call becomes a no-op.
        this.stopHealthCheck(serverName);
        this.clients.delete(serverName);
        // Release the budget slot ONLY if THIS in-flight
        // discoverMcpToolsForServerInternal call freshly reserved
        // it. `freshReservations.has(serverName)` distinguishes:
        //
        //   - Fresh reservation (never connected): release — a server
        //     that never connected shouldn't permanently consume a
        //     slot under enforce mode.
        //   - `'already_held'` reconnect (server was previously
        //     healthy, now flaky): KEEP the slot. Health-monitor
        //     retry doesn't have to compete for capacity with new
        //     servers admitted during the timeout window.
        //
        // Originally treated all timeouts as "release"
        // R8 #4 caught the asymmetry with the connect-failure
        // path's `weReservedSlot` guard. Now they match.
        if (this.freshReservations.has(serverName)) {
          this.releaseSlotName(serverName);
          this.freshReservations.delete(serverName);
        }
        // And drop any stale refusal entry — operator intent shifts
        // when a slot becomes free again, and snapshot consumers
        // shouldn't keep tagging a now-slotless server as
        // `disabledReason: 'budget'`.
        this.dropRefusalEntry(serverName);
        reject(
          new Error(
            `MCP server '${serverName}' discovery timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      fn().then(
        (value) => {
          clearTimeout(timer);
          // Suppress success after timeout — the timeout already
          // rejected the outer promise; resolving it again is a no-op
          // but the success path would also re-emit
          // `mcp_server_ready:ready` and `mcp_first_tool_registered`
          // even though the rest of the system has moved on.
          if (!timedOut) resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          if (!timedOut) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });
  }

  /**
   * Minimum / maximum discovery timeouts. `0` or a negative value as a
   * per-server override would cause every discover to fire its timeout on
   * the next tick — combined with the lack of disconnect on timeout this
   * was a remote-exploitable silent-tool-registration vector (a
   * MITM/attacker-controlled MCP server could land its tools after the
   * timeout fired). `Infinity` / very large values would hang
   * `waitForMcpReady()` forever for non-interactive paths. The 100ms
   * floor is generous (real handshakes start in single-digit ms locally,
   * tens of ms remote); the 5-minute ceiling matches the longest tool
   * call timeouts we've documented.
   */
  private static readonly MIN_DISCOVERY_TIMEOUT_MS = 100;
  private static readonly MAX_DISCOVERY_TIMEOUT_MS = 300_000;

  private discoveryTimeoutFor(serverConfig?: MCPServerConfig): number {
    const override = serverConfig?.discoveryTimeoutMs;
    if (override !== undefined && Number.isFinite(override)) {
      return Math.max(
        McpClientManager.MIN_DISCOVERY_TIMEOUT_MS,
        Math.min(override, McpClientManager.MAX_DISCOVERY_TIMEOUT_MS),
      );
    }
    // Remote transports (HTTP/SSE/WebSocket) carry network risk and get
    // a shorter default; stdio servers we trust the user already runs
    // locally. `tcp` is the WebSocket transport field on
    // `MCPServerConfig` — without it, websocket servers fall through to
    // the stdio default and a hung WS handshake holds back the
    // non-interactive `waitForMcpReady()` for 30s instead of 5s.
    const isRemote = !!(
      serverConfig?.httpUrl ||
      serverConfig?.url ||
      serverConfig?.tcp
    );
    return isRemote ? 5_000 : 30_000;
  }

  /**
   * Removes a server and its tools
   */
  private async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error disconnecting removed server '${serverName}': ${getErrorMessage(error)}`,
        );
      }
      this.clients.delete(serverName);
      this.stopHealthCheck(serverName);
      this.consecutiveFailures.delete(serverName);
    }

    // server gone from config (or disabled mid-session) releases
    // the budget slot too — operator intent is "this server should not
    // be running", so it must not block a different server from taking
    // its place on the next discovery pass.
    this.releaseSlotName(serverName);
    // also drop the entry from the per-pass
    // refusal log so a snapshot taken between discoveries doesn't
    // stale-tag the (now-disabled or now-removed) server as
    // `disabledReason: 'budget'`. Operator action wins over the
    // last-pass startup refusal record.
    this.dropRefusalEntry(serverName);

    // Remove tools for this server from registry
    this.toolRegistry.removeMcpToolsByServer(serverName);

    // The server has been removed from configuration, so drop it from the
    // global status registry too — the health pill should no longer count it.
    removeMCPServerStatus(serverName);

    this.eventEmitter?.emit('mcp-client-update', this.clients);
  }

  async readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );
    const serverConfig = servers[serverName];
    if (this.cliConfig.isMcpServerDisabled(serverName)) {
      throw new Error(`MCP server '${serverName}' is disabled.`);
    }
    const pooled = this.pooledConnections.get(serverName);
    if (pooled) {
      // self-heal
      // pre-call health check. There is a narrow window between a
      // silent transport drop (/ flips entry to 'failed' +
      // emits the 'failed' event) and the manager-side `onFailed`
      // listener evicting the handle from `pooledConnections`. A
      // `readResource` landing in that window pre-fix delegated to
      // `pooled.client.readResource` on a dead transport and
      // surfaced an opaque MCP `"Transport is closed"` error.
      // Detect the dead handle, evict it inline (so the next call
      // re-acquires through the legacy spawn path below), and throw
      // a clear server-unavailable error the caller can surface.
      // Mirrors the self-heal philosophy: the pool already
      // owns the eviction, we just close the observability gap on
      // the read path.
      if (pooled.client.getStatus() !== MCPServerStatus.CONNECTED) {
        this.pooledConnections.delete(serverName);
        throw new Error(
          `MCP server '${serverName}' pool entry disconnected; retry after discovery.`,
        );
      }
      return pooled.client.readResource(uri, options);
    }

    let client = this.clients.get(serverName);
    // track whether THIS call
    // reserved the slot + created the client, so the zombie-leak
    // cleanup on `connect()` failure (below) only fires for
    // newly-created lazy spawns — never for a reuse of an already-
    // CONNECTED client (`client !== undefined` branch).
    let weReservedSlot = false;
    // hoist the
    // serverConfig lookup so the timeout-wrapped connect site
    // (below) can pass it to `discoveryTimeoutFor` regardless of
    // whether we're on the lazy-spawn or already-existing-client
    // path. Existing clients get the same per-server discovery
    // timeout as fresh ones — uniform behavior across spawn paths.
    if (!client) {
      // invariant : the lookup→
      // disabled-check→budget-reserve→client-create sequence below
      // runs synchronously — no `await` until `client.connect()`.
      // `cliConfig.getMcpServers()` returns the current Map snapshot,
      // and `cliConfig` is mutated only between discovery passes (via
      // settings reload) or via `removeServer` (which releases its
      // own slot). So the TOCTOU window between `serverConfig`
      // lookup and `tryReserveSlot` is closed by Node's single-
      // threaded execution model. If the manager ever grows an
      // `await`-containing branch in this section, wrap from line
      // below through `clients.set` in `try { ... } catch {
      // this.reservedSlots.delete(serverName); throw; }` to close
      // a real race.
      if (!serverConfig) {
        throw new Error(`MCP server '${serverName}' is not configured.`);
      }

      // the lazy-spawn path
      // previously bypassed `isMcpServerDisabled`. A server the
      // operator disabled via `mcpServers.<name>.disabled: true` or
      // `/mcp disable <name>` could be resurrected by any resource
      // read call. Now matches the disabled-check pattern in
      // `discoverAllMcpTools` and `discoverAllMcpToolsIncremental`.
      // Placed BEFORE the budget gate so a disabled server reports
      // its actual reason rather than a misleading budget refusal.
      if (this.cliConfig.isMcpServerDisabled(serverName)) {
        throw new Error(`MCP server '${serverName}' is disabled.`);
      }

      // A pending-approval project server (`.mcp.json`) must not be lazy-spawned
      // by a resource read either (#4615).
      if (this.cliConfig.isMcpServerPendingApproval?.(serverName)) {
        throw new Error(`MCP server '${serverName}' is pending approval.`);
      }

      // Budget gate : a lazy `readResource` against a server
      // that was refused at discovery time (or that the operator has
      // never connected) must NOT silently spawn a new MCP client past
      // the cap. Discovery-time refusals don't throw (best-effort
      // semantics), but the resource-read caller has a synchronous
      // consumer that benefits from a typed error it can render.
      const reservation = this.tryReserveSlot(serverName);
      if (reservation === 'refused') {
        // R7 #7 helper: refuseAndLog records the entry + emits the
        // operator-visible stderr breadcrumb. Calling it BEFORE the
        // throw so operators get the same stderr trail as bulk
        // discovery refusals — the throw alone doesn't surface to
        // stderr (caller decides what to do with the typed error).
        this.refuseAndLog(serverName, serverConfig);
        // lazy-spawn refusal emits a length-1 batch BEFORE
        // throwing so SDK consumers see the structured event whether
        // or not they catch the typed error. Order matches the
        // discovery paths: emit, then throw / return.
        this.emitRefusedBatchIfAny();
        throw new BudgetExhaustedError(
          serverName,
          this.clientBudget as number,
          this.reservedSlots.size,
        );
      }
      // R7 #4: align with `discoverMcpToolsForServerInternal`
      // `tryReserveSlot` returns `'reserved'` in `off` mode WITHOUT
      // adding to the set. The `.has` guard ensures we only treat it
      // as a real reservation when the slot was actually taken.
      weReservedSlot =
        reservation === 'reserved' && this.reservedSlots.has(serverName);

      // a server
      // that was refused at discovery time stays in
      // `lastRefusedServerNames` so the snapshot reports it. If a
      // later `readResource` call successfully reserves a slot for
      // that server (e.g., another server was disconnected and
      // freed capacity), the refusal entry becomes stale — the
      // snapshot would keep tagging the now-connected server as
      // `disabledReason: 'budget'`. Drop the stale entry here so
      // the next snapshot reflects the late-reservation success.
      if (weReservedSlot) {
        this.dropRefusalEntry(serverName);
        // no inline evaluate
        // needed — `tryReserveSlot` already fired the warning if
        // the upward crossing happened during reservation.
      }

      const sdkCallback = isSdkMcpServerConfig(serverConfig)
        ? this.sendSdkMcpMessage
        : undefined;

      client = new McpClient(
        serverName,
        serverConfig,
        this.toolRegistry,
        this.cliConfig.getPromptRegistry(),
        this.cliConfig.getWorkspaceContext(),
        this.cliConfig.getDebugMode(),
        sdkCallback,
      );
      this.clients.set(serverName, client);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }

    // when an already-
    // tracked client exists (the `if (!client)` block above is
    // skipped), the disabled gate added in R3 #5 doesn't fire. So a
    // server connected pre-disable, then operator-disabled mid-
    // session via `/mcp disable <name>` or a settings reload, would
    // still serve resource reads via its existing CONNECTED client
    // until the next incremental discovery pass calls `removeServer`.
    // Re-check disabled state on every readResource, regardless of
    // whether the client was just lazy-spawned or pre-existing.
    if (this.cliConfig.isMcpServerDisabled(serverName)) {
      throw new Error(`MCP server '${serverName}' is disabled.`);
    }

    // Re-check pending approval on every readResource too (#4615): a server can
    // flip to pending if its `.mcp.json` config changed since approval.
    if (this.cliConfig.isMcpServerPendingApproval?.(serverName)) {
      throw new Error(`MCP server '${serverName}' is pending approval.`);
    }

    if (client.getStatus() !== MCPServerStatus.CONNECTED) {
      try {
        // wrap the
        // lazy-spawn `client.connect()` in the same discovery
        // timeout the bulk + incremental paths use. Pre-fix a hung
        // MCP server during a resource-read spawn would block
        // forever and permanently consume a budget slot under
        // `enforce` mode, cascading into total budget exhaustion
        // on subsequent discovery passes. Reuses
        // `discoveryTimeoutFor` so per-server `discoveryTimeoutMs`
        // overrides apply uniformly across spawn paths.
        //
        // R10 line 1572 cleanup contract: when the timeout side
        // wins the race, the catch below calls
        // `await client.disconnect()` to abort the orphan
        // `client.connect()` that's still pending in the
        // background. This relies on `McpClient.disconnect()`
        // cancelling an in-flight connect — closing the underlying
        // transport (stdio child SIGTERM, WebSocket close frame,
        // HTTP socket teardown) so the pending connect promise
        // settles. If `disconnect()` on a never-completed connect
        // were a no-op, the orphan transport would survive with
        // no `this.clients` entry and `stop()` couldn't reach it.
        // This same contract is relied on by
        // `runWithDiscoveryTimeout`'s timeout handler (bulk +
        // incremental paths), so all three spawn paths share the
        // assumption — verified by the bulk path having shipped
        // production-stable for several releases. Worth a unit
        // test in a follow-up that exercises the
        // disconnect-cancels-pending-connect invariant against
        // a fixture that asserts the transport is actually torn
        // down.

        const timeoutMs = this.discoveryTimeoutFor(serverConfig);
        let timeoutId: NodeJS.Timeout | undefined;
        await Promise.race([
          client.connect(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(
                new Error(
                  `MCP server '${serverName}' lazy connect timed out after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs);
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
        // start
        // the health monitor on a successful lazy spawn. Pre-fix
        // a lazy-spawned server that later disconnected (crash,
        // network) had no automatic reconnect path — the client
        // sat DISCONNECTED in `this.clients` until the next
        // readResource or incremental pass. Mirror the
        // `discoverMcpToolsForServerInternal` finally-block
        // pattern.
        this.startHealthCheck(serverName);
      } catch (err) {
        //
        // zombie slot leak + transport leak.
        //
        // A failed lazy spawn would otherwise permanently consume
        // a budget slot AND leave a never-CONNECTED client entry
        // in `this.clients` (which `getMcpClientAccounting`
        // correctly excludes from `total`, but the slot still
        // blocks other servers). Only release if THIS call did
        // the reservation — a reuse path with an already-tracked
        // client must not collateral-damage another caller's
        // slot.
        //
        // R9 #2: `connect()` may have established the transport
        // (spawned the stdio child / opened the socket) before
        // throwing on a later handshake step. Best-effort
        // `await client.disconnect()` closes that transport
        // before dropping the reference — mirrors the R7 #3 +
        // R8 #1 fixes in the discovery-side catch blocks.
        if (weReservedSlot) {
          try {
            await client.disconnect();
          } catch {
            // best-effort transport cleanup
          }
          this.releaseSlotName(serverName);
          this.clients.delete(serverName);
          this.eventEmitter?.emit('mcp-client-update', this.clients);
        }
        throw err;
      }
    }

    return client.readResource(uri, options);
  }

  // ────────────────────────────────────────────────────────────────────
  // T2.8: Runtime MCP server lifecycle (add / remove)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Add (or replace) a runtime MCP server, wiring:
   *   1. Config runtime overlay (shadow-over-settings detection)
   *   2. Budget guard (enforce throws, warn returns skipped)
   *   3. Pool acquire (or standalone McpClient connect + discover)
   *
   * Returns a result object describing what happened. Throws
   * `McpBudgetWouldExceedError` on hard-cap violations,
   * `McpServerSpawnFailedError` on transport failures,
   * `InvalidMcpConfigError` on bad config.
   */
  async addRuntimeMcpServer(
    name: string,
    config: MCPServerConfig,
    originatorClientId: string,
  ): Promise<AddRuntimeMcpServerResult> {
    // Reject explicitly excluded servers
    if (this.cliConfig.isMcpServerDisabled(name)) {
      throw new InvalidMcpConfigError(
        name,
        `server '${name}' is in excludedMcpServers and cannot be added at runtime`,
      );
    }

    debugLogger.info(
      `addRuntimeMcpServer: ${name} (transport=${mcpTransportOf(config)}, client=${originatorClientId})`,
    );

    // Validate config minimally: must have at least one transport field
    const transport = mcpTransportOf(config);
    if (transport === 'unknown') {
      throw new InvalidMcpConfigError(
        name,
        'config must specify at least one of: command, url, httpUrl, tcp',
      );
    }

    // Detect shadow-over-settings
    const settingsServers = this.cliConfig.getSettingsMcpServers() ?? {};
    const shadowedSettings = name in settingsServers;

    // Check for idempotent replace: same name + same fingerprint means
    // no pool churn needed. Compare against the existing pooled
    // connection (if any).
    const newConnId = connectionIdOf(name, config);
    const existingConn = this.pooledConnections.get(name);
    if (existingConn && existingConn.id === newConnId) {
      // Same fingerprint — no transport churn, just update Config overlay
      this.cliConfig.addRuntimeMcpServer(name, config);
      const toolCount = existingConn.toolsSnapshot.length;
      return {
        name,
        transport,
        replaced: false,
        shadowedSettings,
        toolCount,
        originatorClientId,
      };
    }

    // Budget guard — check using the appropriate budget layer
    const budget = this.pool?.getBudget();
    if (budget) {
      // Pool mode: use workspace budget
      const mode = budget.getMode();
      if (mode === 'enforce' || mode === 'warn') {
        // Only apply budget check if this is a genuinely NEW name
        // (not a re-add of the same name already holding a slot)
        const reservation = budget.tryReserve(name);
        if (reservation === 'refused') {
          // Hard cap — enforce mode
          throw new McpBudgetWouldExceedError(name);
        }
        // In warn mode, if the budget is at or above capacity and this
        // is a new reservation, return a soft refusal
        if (
          mode === 'warn' &&
          reservation === 'reserved' &&
          budget.getBudget() !== undefined &&
          budget.getReservedCount() > budget.getBudget()!
        ) {
          // Roll back the reservation — we're not actually spawning
          budget.release(name);
          return {
            name,
            skipped: true,
            reason: 'budget_warning_only',
          };
        }
      }
    } else if (this.budgetMode !== 'off') {
      // Standalone mode: use manager-level budget
      const reservation = this.tryReserveSlot(name);
      if (reservation === 'refused') {
        throw new McpBudgetWouldExceedError(name);
      }
      if (
        this.budgetMode === 'warn' &&
        reservation === 'reserved' &&
        this.clientBudget !== undefined &&
        this.reservedSlots.size > this.clientBudget
      ) {
        this.releaseSlotName(name);
        return {
          name,
          skipped: true,
          reason: 'budget_warning_only',
        };
      }
    }

    // Release existing connection for this name (if replacing with
    // different fingerprint)
    const replaced = this.pooledConnections.has(name) || this.clients.has(name);
    if (existingConn) {
      try {
        existingConn.release();
      } catch {
        /* best effort */
      }
      this.pooledConnections.delete(name);
      this.toolRegistry.removeMcpToolsByServer(name);
      this.stopHealthCheck(name);
    }
    const existingClient = this.clients.get(name);
    if (existingClient) {
      this.stopHealthCheck(name);
      try {
        await existingClient.disconnect();
      } catch {
        /* best effort */
      }
      this.clients.delete(name);
      this.toolRegistry.removeMcpToolsByServer(name);
      // Do NOT releaseSlotName here — the budget slot carries over to
      // the new entry being spawned. Releasing + not re-reserving would
      // leave the running server unaccounted in the budget.
    }

    // Write the Config runtime overlay BEFORE spawning so
    // `getMcpServers()` reflects the new entry immediately (the pool
    // acquire + discover may read config for trust/filters).
    this.cliConfig.addRuntimeMcpServer(name, config);

    // Acquire the transport
    let toolCount = 0;
    try {
      if (this.pool && !isSdkMcpServerConfig(config)) {
        // Pool mode: acquire through the shared pool
        const sessionId = this.cliConfig.getSessionId();
        const promptRegistry = this.cliConfig.getPromptRegistry();
        const resourceRegistry = this.cliConfig.getResourceRegistry();
        const conn = await this.pool.acquire(
          name,
          config,
          sessionId,
          this.toolRegistry,
          promptRegistry,
          resourceRegistry,
        );
        this.pooledConnections.set(name, conn);
        toolCount = conn.toolsSnapshot.length;
      } else {
        // Standalone mode: create a per-session McpClient
        const sdkCallback = isSdkMcpServerConfig(config)
          ? this.sendSdkMcpMessage
          : undefined;
        const client = new McpClient(
          name,
          config,
          this.toolRegistry,
          this.cliConfig.getPromptRegistry(),
          this.cliConfig.getWorkspaceContext(),
          this.cliConfig.getDebugMode(),
          sdkCallback,
        );
        this.clients.set(name, client);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
        await client.connect();
        await client.discover(this.cliConfig);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
        toolCount = this.toolRegistry.getToolsByServer(name).length;
      }
    } catch (err) {
      // Spawn failed — roll back Config overlay + budget reservation
      this.cliConfig.removeRuntimeMcpServer(name);
      if (budget) {
        budget.release(name);
      } else if (this.budgetMode !== 'off') {
        this.releaseSlotName(name);
      }
      // Clean up any partial state (including tools from partial discover)
      this.toolRegistry.removeMcpToolsByServer(name);
      this.pooledConnections.delete(name);
      removeMCPServerStatus(name);
      const failedClient = this.clients.get(name);
      if (failedClient) {
        try {
          await failedClient.disconnect();
        } catch {
          /* best effort */
        }
      }
      this.clients.delete(name);
      this.stopHealthCheck(name);
      this.eventEmitter?.emit('mcp-client-update', this.clients);

      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timed out');
      const exitCode =
        err instanceof Error && 'exitCode' in err
          ? (err as { exitCode?: number }).exitCode
          : undefined;
      throw new McpServerSpawnFailedError(name, {
        exitCode,
        stderr: message,
        timeout: isTimeout,
      });
    }

    return {
      name,
      transport,
      replaced,
      shadowedSettings,
      toolCount,
      originatorClientId,
    };
  }

  /**
   * Remove a runtime MCP server previously added via
   * `addRuntimeMcpServer`. Drops the Config overlay, releases the
   * pool connection (or disconnects the standalone client), and
   * releases the budget slot.
   *
   * Idempotent: returns `{skipped: true, reason: 'not_present'}` when
   * no runtime entry exists for `name`.
   */
  async removeRuntimeMcpServer(
    name: string,
    originatorClientId: string,
  ): Promise<RemoveRuntimeMcpServerResult> {
    // Check whether this name is a runtime entry
    // Config.removeRuntimeMcpServer returns true only if the entry was
    // in the runtime map.
    const wasRuntime = this.cliConfig.removeRuntimeMcpServer(name);
    if (!wasRuntime) {
      return { name, skipped: true, reason: 'not_present' };
    }

    // Detect whether this was shadowing a settings-layer entry
    const settingsServers = this.cliConfig.getSettingsMcpServers() ?? {};
    const wasShadowingSettings = name in settingsServers;

    // Release pool connection (identity-check prevents race with concurrent add)
    const poolConn = this.pooledConnections.get(name);
    if (poolConn) {
      try {
        poolConn.release();
      } catch {
        /* best effort */
      }
      if (this.pooledConnections.get(name) === poolConn) {
        this.pooledConnections.delete(name);
      }
    }

    // Disconnect standalone client
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.disconnect();
      } catch {
        /* best effort */
      }
      this.clients.delete(name);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }

    // Cleanup: tool registry, status, health check, diagnostics (mirrors removeServer)
    this.toolRegistry.removeMcpToolsByServer(name);
    removeMCPServerStatus(name);
    this.stopHealthCheck(name);
    this.consecutiveFailures.delete(name);
    this.isReconnecting.delete(name);
    this.dropRefusalEntry(name);

    // Release budget slot
    const budget = this.pool?.getBudget();
    if (budget) {
      budget.release(name);
    } else if (this.budgetMode !== 'off') {
      this.releaseSlotName(name);
    }

    return {
      name,
      removed: true,
      wasShadowingSettings,
      originatorClientId,
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// T2.8: Result types for runtime MCP server add/remove
// ────────────────────────────────────────────────────────────────────

export type AddRuntimeMcpServerResult =
  | {
      name: string;
      transport: McpTransportKind;
      replaced: boolean;
      shadowedSettings: boolean;
      toolCount: number;
      originatorClientId: string;
    }
  | {
      name: string;
      skipped: true;
      reason: 'budget_warning_only';
    };

export type RemoveRuntimeMcpServerResult =
  | {
      name: string;
      removed: true;
      wasShadowingSettings: boolean;
      originatorClientId: string;
    }
  | {
      name: string;
      skipped: true;
      reason: 'not_present';
    };

// Re-export error classes for convenience
export {
  McpBudgetWouldExceedError,
  McpServerSpawnFailedError,
  InvalidMcpConfigError,
} from './mcp-errors.js';

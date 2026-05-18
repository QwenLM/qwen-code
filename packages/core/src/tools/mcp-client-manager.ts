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
} from './mcp-client.js';
import type { SendSdkMcpMessage } from './mcp-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
import type { EventEmitter } from 'node:events';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

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
 * Single-threshold warning fraction for the snapshot-based budget cell
 * (PR 14 v1). When `liveCount >= MCP_BUDGET_WARN_FRACTION * budget` the
 * `budgets[0].status` flips to `'warning'`. Exported and consumed by
 * (a) `acpAgent.buildBudgetCells` (snapshot status) and (b)
 * `commands/serve.ts` (stderr boot breadcrumb) — pre-extract these
 * shared so PR 14b can swap to a dual-threshold hysteresis pair
 * (`armed` boolean per opencode `cli/heap.ts`) by editing one file.
 *
 * Picked 0.75 to mirror PR 10's `slow_client_warning`
 * (`eventBus.ts:WARN_THRESHOLD_RATIO`) — same rationale: "warning"
 * fires before "error" with enough headroom for the operator to act.
 */
export const MCP_BUDGET_WARN_FRACTION = 0.75 as const;

/**
 * Budget enforcement mode for MCP client guardrails (issue #4175 PR 14).
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
  /** Cap on live MCP clients per workspace. `undefined` = unlimited. */
  clientBudget?: number;
  /** Behavior at and above the cap. `off` when `clientBudget` is undefined. */
  budgetMode: McpBudgetMode;
}

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
 * value PR 1's `pgrep -P` baseline harness can validate against.
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
   * time of the refusal). PR 14 fix (review #4247 wenshao S6): renamed
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
 * Tracked: PR 14b / future core decision (see PR #4247 thread for
 * Copilot finding #8 + wenshao P2 line 147 — defer pending direction
 * on (a) implement WS in createTransport vs (b) drop `tcp` from
 * `MCPServerConfig` + both mappers).
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
      // PR 14 fix (review #4247 wenshao R7 line 191): operator typos
      // like `QWEN_SERVE_MCP_CLIENT_BUDGET=abc` previously fell
      // through silently to "no budget" with zero indication. The
      // CLI parent (`commands/serve.ts` + `runQwenServe.ts`)
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
  // PR 14 fix (review #4247 wenshao S4 + R8 #2): mode-without-budget
  // downgrade. Originally only `enforce` got downgraded — but `warn`
  // mode without a budget threshold is equally meaningless: nothing
  // actionable can ever fire (no `liveCount >= 0.75 * budget`
  // comparison can be true when budget is undefined). Downgrading
  // BOTH to `off` removes the comment-vs-code mismatch in
  // `emitBudgetTelemetry` (which previously claimed
  // `mode !== 'off' ⇒ clientBudget defined` — true for enforce,
  // false for warn until this fix).
  if (
    (budgetMode === 'enforce' || budgetMode === 'warn') &&
    clientBudget === undefined
  ) {
    budgetMode = 'off';
  }
  return { clientBudget, budgetMode };
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
   * PR 14 fix (review #4247 wenshao R8 #4 line 1221): names whose
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

  constructor(
    config: Config,
    toolRegistry: ToolRegistry,
    eventEmitter?: EventEmitter,
    sendSdkMcpMessage?: SendSdkMcpMessage,
    healthConfig?: Partial<MCPHealthMonitorConfig>,
    budgetConfig?: McpBudgetConfig,
  ) {
    this.cliConfig = config;
    this.toolRegistry = toolRegistry;

    this.eventEmitter = eventEmitter;
    this.sendSdkMcpMessage = sendSdkMcpMessage;
    this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...healthConfig };

    // Tests inject `budgetConfig` directly; production reads env vars
    // set by `qwen serve --mcp-client-budget=N --mcp-budget-mode=X`
    // when spawning the ACP child. Standalone `qwen` invocations
    // leave both unset and get `mode: 'off'` — the pre-PR-14 default.
    const resolved = budgetConfig ?? readBudgetFromEnv();
    let resolvedMode = resolved.budgetMode;
    // PR 14 fix (review #4247 wenshao R8 #5): mirror
    // `readBudgetFromEnv`'s `(enforce|warn)`-without-budget
    // downgrade for the direct-`budgetConfig` path too. All
    // production callers (CLI handler, `runQwenServe`, env-var
    // fallback) validate upfront, but a future code path that
    // injects `budgetConfig` without running the validation
    // would re-introduce the silent fail-open. Defense in depth.
    if (
      (resolvedMode === 'enforce' || resolvedMode === 'warn') &&
      resolved.clientBudget === undefined
    ) {
      resolvedMode = 'off';
    }
    this.clientBudget = resolved.clientBudget;
    this.budgetMode = resolvedMode;
  }

  /**
   * Atomic budget check + slot reservation. Synchronous so the
   * concurrent discovery loop (`Promise.all` over server entries) can't
   * interleave a second connect past the cap at any `await` boundary.
   *
   * Returns:
   *   `reserved`     — slot newly held (or `off`-mode no-op)
   *   `already_held` — slot was already reserved (reconnect / dup)
   *   `refused`      — `enforce` mode and the cap is full
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
    return 'reserved';
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
   * PR 14 fix (review #4247 wenshao R7 line 464): drop a server's
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
  }

  /**
   * PR 14 fix (review #4247 wenshao R7 line 464): record a refusal +
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
  private refuseAndLog(serverName: string): void {
    if (!this.lastRefusedServerNames.includes(serverName)) {
      this.lastRefusedServerNames.push(serverName);
    }
    process.stderr.write(
      `qwen serve: MCP server '${serverName}' refused (budget exhausted, ` +
        `budget=${this.clientBudget}, mode=enforce)\n`,
    );
  }

  /**
   * PR 14 fix (review #4247 wenshao S5): post-discovery budget
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
   * Initiates the tool discovery process for all configured MCP servers.
   * It connects to each server, discovers its available tools, and registers
   * them with the `ToolRegistry`.
   */
  async discoverAllMcpTools(cliConfig: Config): Promise<void> {
    if (!cliConfig.isTrustedFolder()) {
      return;
    }
    await this.stop();

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
    // Reset per-pass refusal log so a snapshot taken after this pass
    // reflects THIS pass's refusals, not a stale one. Reservations
    // (this.reservedSlots) persist across passes — they're keyed by
    // server name, which is the operator's intent unit.
    this.lastRefusedServerNames = [];

    this.eventEmitter?.emit('mcp-client-update', this.clients);
    const discoveryPromises = Object.entries(servers).map(
      async ([name, config]) => {
        // Skip disabled servers
        if (cliConfig.isMcpServerDisabled(name)) {
          debugLogger.debug(`Skipping disabled MCP server: ${name}`);
          return;
        }

        // Budget gate (PR 14): synchronous slot reservation BEFORE the
        // `await client.connect()` below. Refusal only happens under
        // `enforce` mode; `warn` mode reserves regardless so accounting
        // reflects the configured set. `off` is a no-op.
        const reservation = this.tryReserveSlot(name);
        if (reservation === 'refused') {
          this.refuseAndLog(name);
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
          // PR 14 fix (review #4247 wenshao C2): zombie slot leak.
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
          // PR 14 fix (review #4247 wenshao R8 #1 line 532): also
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
          this.reservedSlots.delete(name);
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
    // PR 14 fix (review #4247 wenshao R7 line 528): disabled gate.
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

    // PR 14 fix (review #4247): single-server rediscovery (reachable from
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
      this.refuseAndLog(serverName);
      return;
    }
    // PR 14 fix (review #4247 wenshao R3-R4): track whether THIS call
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
    // PR 14 fix (review #4247 wenshao R8 #4): mark this name in
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
      // PR 14 fix (review #4247 wenshao R7 line 612): a server that
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
    } catch (error) {
      // PR 14 fix (review #4247 wenshao R3 line 546): two-mode
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
      // Round 3 documented "always keep" — corrected here per
      // wenshao R3 P3 line 390 + R4 line 546/639: align with
      // `discoverAllMcpTools` (bulk) catch and `readResource`
      // (lazy spawn) catch. All three paths now use the same
      // weReserved-driven cleanup.
      if (weReservedSlot) {
        // PR 14 fix (review #4247 wenshao R7 line 634): transport
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
        this.reservedSlots.delete(serverName);
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
   * Stops all running local MCP servers and closes all client connections.
   * This is the cleanup method to be called on application exit.
   */
  async stop(): Promise<void> {
    // Stop all health checks first
    this.stopAllHealthChecks();

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
    // PR 14: clean shutdown releases ALL budget slots. A subsequent
    // `discoverAllMcpTools*` (e.g. the `discoverAllMcpTools` call in
    // its own body line 90, which awaits `this.stop()` first) starts
    // from an empty reservation set.
    this.reservedSlots.clear();
    this.freshReservations.clear();
    this.lastRefusedServerNames = [];
  }

  /**
   * Disconnects a specific MCP server.
   * @param serverName The name of the server to disconnect.
   */
  async disconnectServer(serverName: string): Promise<void> {
    // Stop health check for this server
    this.stopHealthCheck(serverName);

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
    // PR 14: explicit operator-driven disconnect releases the budget
    // slot AND drops the entry from the per-pass refusal log. Outside
    // the `if (client)` guard because a budget-refused server has NO
    // `McpClient` instance — but operator intent ("stop tracking this
    // server") still demands the records be cleared so a subsequent
    // snapshot doesn't keep tagging it as `budget_exhausted`. The
    // internal reconnect path (`discoverMcpToolsForServerInternal`)
    // calls `existingClient.disconnect()` directly, NOT this public
    // method, so reconnect still doesn't release the slot.
    this.reservedSlots.delete(serverName);
    this.dropRefusalEntry(serverName);
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
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

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
    // Reset per-pass refusal log; see the sibling reset in
    // `discoverAllMcpTools` for rationale.
    this.lastRefusedServerNames = [];
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

    // PR 14 fix (review #4247): process removals BEFORE the new-server
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
      if (cliConfig.isMcpServerDisabled(name)) {
        debugLogger.debug(`Skipping disabled MCP server: ${name}`);
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
        // PR 14 fix (review #4247 wenshao R6 line 956): pre-reservation
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
      } else if (existingClient.getStatus() === MCPServerStatus.DISCONNECTED) {
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
          recordStartupEvent(`mcp_server_ready:${name}`, { outcome: 'ready' });
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
        // PR 14 fix (review #4247 wenshao R5 line 956 + R8 #4 line
        // 1221): release the budget slot ONLY if THIS in-flight
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
        // R5 originally treated all timeouts as "release"; wenshao
        // R8 #4 caught the asymmetry with the connect-failure
        // path's `weReservedSlot` guard. Now they match.
        if (this.freshReservations.has(serverName)) {
          this.reservedSlots.delete(serverName);
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

    // PR 14: server gone from config (or disabled mid-session) releases
    // the budget slot too — operator intent is "this server should not
    // be running", so it must not block a different server from taking
    // its place on the next discovery pass.
    this.reservedSlots.delete(serverName);
    // PR 14 fix (review #4247): also drop the entry from the per-pass
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
    let client = this.clients.get(serverName);
    // PR 14 fix (review #4247 wenshao C3): track whether THIS call
    // reserved the slot + created the client, so the zombie-leak
    // cleanup on `connect()` failure (below) only fires for
    // newly-created lazy spawns — never for a reuse of an already-
    // CONNECTED client (`client !== undefined` branch).
    let weReservedSlot = false;
    if (!client) {
      // PR 14 invariant (wenshao R2 P3 line 501): the lookup→
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
      const servers = populateMcpServerCommand(
        this.cliConfig.getMcpServers() || {},
        this.cliConfig.getMcpServerCommand(),
      );
      const serverConfig = servers[serverName];
      if (!serverConfig) {
        throw new Error(`MCP server '${serverName}' is not configured.`);
      }

      // PR 14 fix (review #4247 wenshao R2-#5): the lazy-spawn path
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

      // Budget gate (PR 14): a lazy `readResource` against a server
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
        this.refuseAndLog(serverName);
        throw new BudgetExhaustedError(
          serverName,
          this.clientBudget as number,
          this.reservedSlots.size,
        );
      }
      // R7 #4: align with `discoverMcpToolsForServerInternal` —
      // `tryReserveSlot` returns `'reserved'` in `off` mode WITHOUT
      // adding to the set. The `.has` guard ensures we only treat it
      // as a real reservation when the slot was actually taken.
      weReservedSlot =
        reservation === 'reserved' && this.reservedSlots.has(serverName);

      // PR 14 fix (review #4247 wenshao R5 line 1268-1): a server
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

    // PR 14 fix (review #4247 wenshao R7 line 1342): when an already-
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

    if (client.getStatus() !== MCPServerStatus.CONNECTED) {
      try {
        await client.connect();
      } catch (err) {
        // PR 14 fix (review #4247 wenshao C3): zombie slot leak.
        // A failed lazy spawn would otherwise permanently consume a
        // budget slot AND leave a never-CONNECTED client entry in
        // `this.clients` (which `getMcpClientAccounting` correctly
        // excludes from `total`, but the slot still blocks other
        // servers). Only release if THIS call did the reservation —
        // a reuse path with an already-tracked client must not
        // collateral-damage another caller's slot.
        if (weReservedSlot) {
          this.reservedSlots.delete(serverName);
          this.clients.delete(serverName);
          this.eventEmitter?.emit('mcp-client-update', this.clients);
        }
        throw err;
      }
    }

    return client.readResource(uri, options);
  }
}

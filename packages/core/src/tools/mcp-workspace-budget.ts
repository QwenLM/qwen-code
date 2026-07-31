/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import {
  type McpBudgetEvent,
  type McpBudgetMode,
  type McpRefusedServer,
  MCP_BUDGET_REARM_FRACTION,
  MCP_BUDGET_WARN_FRACTION,
} from './mcp-client-manager.js';

const debugLogger = createDebugLogger('McpPool:Budget');

/**
 * workspace-scoped MCP budget controller.
 *
 * Owns the same state machine `McpClientManager` carries inline
 * (slot reservation, 75% hysteresis warning, refused-batch coalescing
 * across a `discoverAllMcpTools*` pass) but lives ONE-PER-WORKSPACE
 * inside `McpTransportPool` instead of N-per-session inside each
 * ACP child's manager. The pool delegates `acquire`/`release` calls
 * here so the cap caps the workspace, not each session — see
 * `docs/design/f2-mcp-transport-pool.md`.
 *
 * Pool-mode budget semantics:
 *   - **Reservation key is server NAME** (matches v1 contract;
 *     two pool entries that share a name but differ by fingerprint
 *     consume ONE slot together, not two — operators should think of
 *     budget as "configured server slots" not "subprocess count").
 *     Subprocess accounting is exposed separately via
 *     `pool.getSnapshot().subprocessCount`.
 *   - **Hysteresis triggers on `reservedSlots.size / clientBudget`**
 *     rather than live (CONNECTED) count, mirroring the manager
 *     because reservation is the bound that prevents over-spawn,
 *     and reservations include in-flight connects + survive
 *     transient `disconnectServer` calls. Stable trigger.
 *   - **Refused batch coalescing** preserves the per-pass contract:
 *     bracket each `discoverAllMcpToolsViaPool` invocation with
 *     `beginBulkPass()` / `endBulkPass()` so per-server refusals
 *     accumulate into a single `refused_batch` event at end of pass.
 *     Out-of-pass refusals (e.g. lazy `readResource` spawn) emit
 *     length-1 batches inline for shape consistency.
 *
 * The legacy `McpClientManager` budget machinery STAYS as-is for
 * standalone qwen and SDK MCP servers (which bypass the pool per
 * ). Pool mode → pool's `WorkspaceMcpBudget` enforces;
 * standalone / SDK MCP → manager's inline machinery enforces. No
 * double-counting because pool mode's `discoverAllMcpToolsViaPool`
 * never calls the manager's `tryReserveSlot`.
 */
export class WorkspaceMcpBudget {
  private readonly clientBudget?: number;
  private readonly mode: McpBudgetMode;
  private readonly onEvent?: (event: McpBudgetEvent) => void;

  /**
   * Server names currently holding a budget slot. Used as the
   * authoritative count for hysteresis evaluation and snapshot
   * accounting. Pre-`acquire` the pool calls `tryReserve(name)` and
   * gates the subsequent `spawnEntry` on the result.
   */
  private readonly reservedSlots = new Set<string>();

  /**
   * Server names refused during the most recent
   * `beginBulkPass`/`endBulkPass` window. Drained on `endBulkPass`
   * (where the coalesced `refused_batch` event fires); persists into
   * `lastRefusedServerNames` for snapshot consumers.
   */
  private readonly pendingRefusalNames = new Set<string>();
  /** Sidecar of `pendingRefusalNames`, same lifetime — emitted in batch. */
  private readonly pendingRefusalTransports = new Map<
    string,
    McpRefusedServer['transport']
  >();

  /**
   * Snapshot-visible list — refused names from the most recent
   * completed pass. NOT cleared on `endBulkPass` emit; only on
   * `beginBulkPass` of the NEXT pass. Backs `getAccounting().refusedServerNames`.
   */
  private lastRefusedServerNames: readonly string[] = [];

  /**
   * Hysteresis state for `budget_warning`. Initial `true` = "armed";
   * fires once on upward 75% crossing then disarms; re-arms on
   * downward 37.5% crossing. Mirrors `McpClientManager.warnArmed`.
   */
  private warnArmed = true;

  /**
   * Reentrancy counter for nested bulk passes. Pool's
   * `discoverAllMcpToolsViaPool` increments on entry and decrements
   * in `finally`. While > 0, inline refusals queue without firing
   * (the terminal end-of-pass call drains and emits). Hooks in tests
   * or future code paths that nest passes won't double-emit.
   */
  private bulkPassDepth = 0;

  constructor(opts: {
    clientBudget?: number;
    mode: McpBudgetMode;
    onEvent?: (event: McpBudgetEvent) => void;
  }) {
    this.clientBudget = opts.clientBudget;
    // parity: stash undefined when mode is `off` so a stray
    // call after construction can't fire — defense in depth alongside
    // the per-method `mode === 'off'` short-circuits.
    this.mode = opts.mode;
    this.onEvent = opts.mode === 'off' ? undefined : opts.onEvent;
  }

  /** Resolved budget mode (immutable for the controller's lifetime). */
  getMode(): McpBudgetMode {
    return this.mode;
  }

  /** Resolved client budget, or `undefined` when unlimited. */
  getBudget(): number | undefined {
    return this.clientBudget;
  }

  /**
   * Snapshot `reservedSlots` for the snapshot route. Returns a fresh
   * array so callers can mutate without affecting internal state.
   */
  getReservedSlots(): string[] {
    return Array.from(this.reservedSlots);
  }

  /**
   * Snapshot `lastRefusedServerNames` for the snapshot route. Cleared
   * on the start of the NEXT bulk pass (so a `GET /workspace/mcp`
   * between passes still sees the last refusal set).
   */
  getRefusedServerNames(): readonly string[] {
    return this.lastRefusedServerNames;
  }

  /** Live count of reserved server names (== `reservedSlots.size`). */
  getReservedCount(): number {
    return this.reservedSlots.size;
  }

  /**
   * Atomic budget check + reservation. Synchronous so concurrent
   * `pool.acquire` calls under `Promise.all` can't interleave a
   * second reservation past the cap at any `await` boundary.
   *
   * Mirrors `McpClientManager.tryReserveSlot` semantics:
   *   - `reserved` — slot newly held (or `off`-mode no-op)
   *   - `already_held` — slot was already reserved (reconnect / dup
   *     fingerprint for same name)
   *   - `refused` — `enforce` mode and the cap is full
   */
  tryReserve(serverName: string): 'reserved' | 'already_held' | 'refused' {
    if (this.reservedSlots.has(serverName)) return 'already_held';
    if (this.clientBudget === undefined || this.mode === 'off') {
      return 'reserved';
    }
    if (
      this.mode === 'enforce' &&
      this.reservedSlots.size >= this.clientBudget
    ) {
      return 'refused';
    }
    this.reservedSlots.add(serverName);
    // Mirror manager's fix #4: drive hysteresis on every
    // upward mutation so a 75% crossing during bulk discovery fires
    // inline, not at end-of-pass.
    this.evaluateState();
    return 'reserved';
  }

  /**
   * Release a server's slot. Idempotent — returns `true` if the slot
   * was actually held (parity with `Set.delete`'s return). Called by
   * the pool when an entry transitions to `closed` / `failed` AND
   * no other entry shares the same name.
   */
  release(serverName: string): boolean {
    const had = this.reservedSlots.delete(serverName);
    if (had) this.evaluateState();
    return had;
  }

  /**
   * Record an `enforce`-mode refusal for the current bulk pass.
   * Adds to `pendingRefusalNames` (drained in `endBulkPass`'s emit)
   * AND to `lastRefusedServerNames` (snapshot-visible, drained at
   * NEXT bulk pass start). `warn` mode never refuses, so this should
   * only be called when `mode === 'enforce'`.
   */
  recordRefusal(
    serverName: string,
    transport: McpRefusedServer['transport'],
  ): void {
    if (this.mode !== 'enforce') return;
    this.pendingRefusalNames.add(serverName);
    this.pendingRefusalTransports.set(serverName, transport);
    debugLogger.warn(
      `MCP server '${serverName}' refused at pool acquire ` +
        `(budget exhausted, budget=${this.clientBudget}, mode=${this.mode})`,
    );
    // Mirror McpClientManager's `refuseAndLog → emitRefusedBatchIfAny`
    // semantic: an out-of-bulk-pass refusal (e.g. a `readResource`
    // lazy-spawn refusal, or a direct `pool.acquire` from a test)
    // flushes immediately as a length-1 batch. Inside a bulk pass,
    // the queue accumulates and `endBulkPass` does the coalesced emit.
    if (this.bulkPassDepth === 0) {
      this.flushRefusedBatch();
    }
  }

  /**
   * Open a bulk pass scope. Bracket the pool's
   * `discoverAllMcpToolsViaPool` body so per-server refusals from
   * concurrent acquires accumulate into ONE coalesced `refused_batch`
   * event at end of pass. Reentrant: depth counter so nested passes
   * (currently unused but reserved) don't drop refusals from the
   * outer pass.
   *
   * Side effect: on the OUTERMOST `beginBulkPass` (depth 0 → 1), this
   * resets `lastRefusedServerNames` so the new pass starts with a
   * clean slate. Snapshot consumers between passes see the previous
   * pass's refusals; the new pass's refusals appear once `endBulkPass`
   * fires.
   */
  beginBulkPass(): void {
    if (this.bulkPassDepth === 0) {
      this.lastRefusedServerNames = [];
    }
    this.bulkPassDepth += 1;
  }

  /**
   * Close a bulk pass scope. On the OUTERMOST close (depth 1 → 0),
   * drains `pendingRefusalNames` into `lastRefusedServerNames` and
   * fires a single `refused_batch` event if any refusals were
   * recorded during the pass. Inner closes are no-ops.
   */
  endBulkPass(): void {
    if (this.bulkPassDepth === 0) {
      // Defensive — caller paired endBulkPass without beginBulkPass.
      // Log and treat as no-op so we don't go negative.
      debugLogger.warn(
        'WorkspaceMcpBudget.endBulkPass called without matching beginBulkPass; ignoring',
      );
      return;
    }
    this.bulkPassDepth -= 1;
    if (this.bulkPassDepth > 0) return;
    this.flushRefusedBatch();
  }

  /**
   * Drain `pendingRefusalNames` into `lastRefusedServerNames` and fire
   * a single coalesced `refused_batch` event. Shared between
   * `endBulkPass` (the bulk-pass terminal flush) and `recordRefusal`
   * (the out-of-bulk-pass length-1 inline flush).
   */
  private flushRefusedBatch(): void {
    if (this.pendingRefusalNames.size === 0) return;
    if (this.clientBudget === undefined || this.mode !== 'enforce') {
      // Should be unreachable per recordRefusal's mode gate; defensive
      // drain to avoid leaking refusals into the next pass.
      this.pendingRefusalNames.clear();
      this.pendingRefusalTransports.clear();
      return;
    }
    const refusedServers: McpRefusedServer[] = [];
    const names: string[] = [];
    for (const name of this.pendingRefusalNames) {
      const transport = this.pendingRefusalTransports.get(name) ?? 'unknown';
      refusedServers.push({
        name,
        transport,
        reason: 'budget_exhausted',
      });
      names.push(name);
    }
    this.lastRefusedServerNames = Object.freeze(names);
    this.pendingRefusalNames.clear();
    this.pendingRefusalTransports.clear();
    if (this.onEvent) {
      try {
        this.onEvent({
          kind: 'refused_batch',
          refusedServers,
          budget: this.clientBudget,
          liveCount: this.reservedSlots.size,
          reservedCount: this.reservedSlots.size,
          mode: 'enforce',
        });
      } catch (err) {
        debugLogger.error(
          `WorkspaceMcpBudget refused_batch event delivery failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Hysteresis state machine for `budget_warning`. Mirrors
   * `McpClientManager.evaluateBudgetState` exactly: one fire per
   * upward 75% crossing; re-arms only on dropping below 37.5%.
   * Called on every `tryReserve` / `release` mutation.
   */
  private evaluateState(): void {
    if (this.mode === 'off' || this.clientBudget === undefined) return;
    const ratio = this.reservedSlots.size / this.clientBudget;
    if (this.warnArmed && ratio >= MCP_BUDGET_WARN_FRACTION) {
      this.warnArmed = false;
      debugLogger.info(
        `MCP workspace budget warning fired (ratio=${ratio.toFixed(2)}, ` +
          `reservedCount=${this.reservedSlots.size}, ` +
          `budget=${this.clientBudget}, mode=${this.mode})`,
      );
      if (this.onEvent) {
        try {
          this.onEvent({
            kind: 'budget_warning',
            // `liveCount` reflects reserved (configured) count for
            // workspace scope — the pool's CONNECTED count is queried
            // separately via `pool.getSnapshot().total` so consumers
            // that want the strict "live" lens still have it.
            liveCount: this.reservedSlots.size,
            reservedCount: this.reservedSlots.size,
            budget: this.clientBudget,
            thresholdRatio: MCP_BUDGET_WARN_FRACTION,
            mode: this.mode,
          });
        } catch (err) {
          debugLogger.error(
            `WorkspaceMcpBudget budget_warning event delivery failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } else if (!this.warnArmed && ratio < MCP_BUDGET_REARM_FRACTION) {
      this.warnArmed = true;
      debugLogger.info(
        `MCP workspace budget warning re-armed (ratio=${ratio.toFixed(2)}, ` +
          `budget=${this.clientBudget}; next 75% crossing will fire)`,
      );
    }
  }
}

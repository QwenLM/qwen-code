/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DiscoveredMCPTool } from './mcp-tool.js';
import type {
  DiscoveredMCPPrompt,
  DiscoveredMCPResource,
} from './mcp-client.js';

/**
 * Opaque identifier for a pooled connection, of the form
 * `${serverName}::${fingerprint}`. Two pool entries with the same
 * server name but different fingerprints (e.g. divergent OAuth
 * tokens) carry distinct ConnectionIds — see
 * `docs/design/f2-mcp-transport-pool.md` fingerprint key.
 */
export type ConnectionId = `${string}::${string}`;

/**
 * Internal `PoolEntry` lifecycle states. Public consumers only
 * observe `active` / `failed` / `disconnected` transitions via events;
 * `spawning` and `draining` are intermediate and not surfaced to
 * subscribers.
 */
export type PoolEntryState =
  | 'spawning' // initial async spawn in progress
  | 'active' // ready, refs ≥ 0 (may be in grace period if refs=0)
  | 'draining' // refs=0 and drain timer running; new acquire cancels
  | 'closed' // transport disconnected; entry is GC-able
  | 'failed'; // permanent failure — see PoolEvent['failed'] for the two causes

/**
 * Discriminated union of events emitted by a `PooledConnection` to
 * subscribed `SessionMcpView`s.
 *
 * See `docs/design/f2-mcp-transport-pool.md` for the full lifecycle
 * (toolsChanged on `notifications/tools/list_changed` and on reconnect;
 * promptsChanged analog; disconnected → reconnected on restart success;
 * disconnected → failed on restart's reconnect-budget exhaustion;
 * active/draining → failed directly on silent transport drop via
 * `statusChangeListener` — / path, no preceding `disconnected`).
 */
export type PoolEvent =
  | {
      kind: 'toolsChanged';
      serverName: string;
      snapshot: DiscoveredMCPTool[];
      /** Pool entry generation counter (incremented on reconnect). */
      generation: number;
    }
  | {
      kind: 'promptsChanged';
      serverName: string;
      snapshot: DiscoveredMCPPrompt[];
      generation: number;
    }
  | {
      kind: 'resourcesChanged';
      serverName: string;
      snapshot: DiscoveredMCPResource[];
      generation: number;
    }
  | {
      kind: 'disconnected';
      serverName: string;
      /**
       * Generation in effect at the time the disconnect was observed.
       * Used by `MCPCallInterruptedError` so subscribers can correlate
       * an in-flight tool-call rejection with the eventual
       * `reconnected` event.
       */
      generation: number;
      reason: 'transport_closed' | 'transport_error' | 'restart';
    }
  | {
      kind: 'reconnected';
      serverName: string;
      /** New generation post-reconnect. */
      generation: number;
    }
  | {
      kind: 'failed';
      serverName: string;
      generation: number;
      /**
       * Cause of the terminal failure. Two upstream sources today:
       *   - **Reconnect-budget exhaustion** — `doRestart`'s catch path
       *     after an explicit operator-triggered restart fails to
       *     reconnect (carries the `client.connect()` / discoverAndReturn
       *     error).
       *   - **Silent transport drop** — `statusChangeListener` in
       *     `mcp-pool-entry.ts` observes `McpClient.onerror` writing
       *     DISCONNECTED to the global registry from outside our
       *     restart machinery (server crash, EPIPE, network reset).
       *     Pool mode has no health monitor so there is no
       *     reconnect-budget concept; this case carries a synthetic
       *     marker string instead of the upstream cause (threading
       *     the real `McpClient` error to this emit is tracked as a
       *     follow-up.
       * SDK consumers writing reducers around `'failed'` should NOT
       * assume "reconnect was attempted and exhausted"; the entry is
       * simply terminal and the manager-side `onFailed` listener has
       * evicted it from `pooledConnections`.
       */
      lastError: string;
    };

/**
 * Error thrown when an in-flight `callTool` is interrupted by a
 * transport disconnect mid-call. Pool does NOT auto-retry — semantics
 * are unsafe for writes (commit, file edit, etc.) and the pool can't
 * distinguish read from write. Caller decides retry policy.
 *
 * See `docs/design/f2-mcp-transport-pool.md`.
 *
 * the throw
 * site lives in the pool's `callTool` wrapper which is scheduled
 * for a later follow-up (the design's in-flight call
 * interception). Type guards (`isToolsChangedEvent`, etc.),
 * `PoolEntryConnectionStatus`, and the `Prompt` re-export were
 * removed in the same change — none had any callers and they
 * were premature public surface. `MCPCallInterruptedError` stays
 * because the design doc declares it as the user-facing contract;
 * removing it now would lose the invariant carrier across the
 * pool's lifecycle. Re-introduce the type guards alongside their
 * first concrete consumer.
 */
export class MCPCallInterruptedError extends Error {
  override readonly name = 'MCPCallInterruptedError';
  readonly serverName: string;
  readonly entryIndex: number;
  /** Pool entry generation at the time the call was started. */
  readonly clientGeneration: number;
  /** Original args, surfaced so the caller can retry if the call is idempotent. */
  readonly args: unknown;

  constructor(
    serverName: string,
    entryIndex: number,
    clientGeneration: number,
    args: unknown,
    message?: string,
  ) {
    super(
      message ??
        `MCP call to server '${serverName}' (entry ${entryIndex}, ` +
          `generation ${clientGeneration}) was interrupted by transport ` +
          `disconnect. Pool does not auto-retry; caller must decide.`,
    );
    this.serverName = serverName;
    this.entryIndex = entryIndex;
    this.clientGeneration = clientGeneration;
    this.args = args;
  }
}

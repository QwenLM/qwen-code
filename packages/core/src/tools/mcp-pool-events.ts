/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { DiscoveredMCPTool } from './mcp-tool.js';
import type { DiscoveredMCPPrompt, MCPServerStatus } from './mcp-client.js';

/**
 * Opaque identifier for a pooled connection, of the form
 * `${serverName}::${fingerprint}`. Two pool entries with the same
 * server name but different fingerprints (e.g. divergent OAuth
 * tokens) carry distinct ConnectionIds — see
 * `docs/design/f2-mcp-transport-pool.md` §5 fingerprint key.
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
  | 'failed'; // permanent failure (reconnect budget exhausted)

/**
 * Discriminated union of events emitted by a `PooledConnection` to
 * subscribed `SessionMcpView`s.
 *
 * See `docs/design/f2-mcp-transport-pool.md` §7 for the full lifecycle
 * (toolsChanged on `notifications/tools/list_changed` and on reconnect;
 * promptsChanged analog; disconnected → reconnected on success path;
 * disconnected → failed on reconnect-budget exhaustion).
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
      /** Last error encountered when reconnect attempts were exhausted. */
      lastError: string;
    };

/**
 * Type guards for narrowing PoolEvent in subscriber handlers.
 */
export function isToolsChangedEvent(
  e: PoolEvent,
): e is Extract<PoolEvent, { kind: 'toolsChanged' }> {
  return e.kind === 'toolsChanged';
}

export function isPromptsChangedEvent(
  e: PoolEvent,
): e is Extract<PoolEvent, { kind: 'promptsChanged' }> {
  return e.kind === 'promptsChanged';
}

export function isDisconnectedEvent(
  e: PoolEvent,
): e is Extract<PoolEvent, { kind: 'disconnected' }> {
  return e.kind === 'disconnected';
}

export function isReconnectedEvent(
  e: PoolEvent,
): e is Extract<PoolEvent, { kind: 'reconnected' }> {
  return e.kind === 'reconnected';
}

export function isFailedEvent(
  e: PoolEvent,
): e is Extract<PoolEvent, { kind: 'failed' }> {
  return e.kind === 'failed';
}

/**
 * Error thrown when an in-flight `callTool` is interrupted by a
 * transport disconnect mid-call. Pool does NOT auto-retry — semantics
 * are unsafe for writes (commit, file edit, etc.) and the pool can't
 * distinguish read from write. Caller decides retry policy.
 *
 * See `docs/design/f2-mcp-transport-pool.md` §13.4.
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

/**
 * Re-export Prompt for downstream consumers that import event types and
 * want the underlying MCP prompt schema without pulling from the SDK directly.
 */
export type { Prompt };

/**
 * Pool-side projection of `MCPServerStatus` for snapshot consumers.
 * Mirrors the existing enum 1:1 — exported separately so pool callers
 * don't need to import the manager-era types directly.
 */
export type PoolEntryConnectionStatus = MCPServerStatus;

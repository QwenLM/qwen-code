/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for serve-bridge MCP server.
 *
 * Runtime implementations are in:
 * - ./sse.ts — SSE stream lifecycle (startEventStream, stopEventStream, createPromptCollector)
 * - ./helpers.ts — Utility functions (handler, resolveSessionId)
 *
 * Tool modules should import runtime functions directly from their source files,
 * not from this module, to avoid circular dependency risks.
 */

import type { DaemonClient } from '../../daemon/DaemonClient.js';
import type { DaemonEvent, PromptResult } from '../../daemon/types.js';

/**
 * Options for creating a serve-bridge MCP server.
 */
export interface ServeBridgeMcpServerOptions {
  /** Daemon base URL (e.g. "http://127.0.0.1:4170"). */
  daemonUrl: string;
  /** Bearer token for daemon auth. */
  token?: string;
  /** Workspace CWD for auto-session creation. */
  workspaceCwd?: string;
  /** Allow tools to write to global scope (memory, agents). Defaults to false for security. */
  allowGlobalScope?: boolean;
}

/**
 * Tracks a per-prompt message collection cycle.
 * The promise signals collected metadata or termination; metadata can arrive
 * between model rounds and does not itself mean the prompt has completed.
 */
export interface PromptCollector {
  texts: string[];
  resolve: () => void;
  promise: Promise<void>;
  resolved: boolean;
  /** Events received before the prompt response identifies its turn. */
  pendingEvents?: Array<DaemonEvent | null>;
  /** Present for a nonblocking daemon response; terminals must match it. */
  promptId?: string;
  result?: PromptResult;
  error?: Error;
  /** Set only by a terminal event or a successful, fully collected prompt reply. */
  completed?: boolean;
  /** Set when collection ends before the prompt completes. */
  interrupted?: boolean;
}

/**
 * Persistent SSE connection for a session.
 * Established at session_create, torn down at session_close.
 */
export interface SessionEventStream {
  sessionId: string;
  abortCtrl: AbortController;
  /** Settles when the REST subscription is accepted or the stream closes. */
  ready?: Promise<void>;
  /** Current active prompt collector (null when idle). */
  activeCollector: PromptCollector | null;
  /** Timestamp of last activity (prompt sent or chunk received). */
  lastActivityMs: number;
}

/**
 * Mutable bridge state shared across all tool handlers.
 */
export interface BridgeState {
  client: DaemonClient;
  /** Daemon base URL for raw fetch calls to endpoints not in DaemonClient. */
  daemonUrl: string;
  /** Bearer token for auth headers in raw fetch calls. */
  token: string | undefined;
  defaultSessionId: string | undefined;
  workspaceCwd: string | undefined;
  /** Persistent SSE connections keyed by sessionId. */
  eventStreams: Map<string, SessionEventStream>;
  /** Whether global scope writes are allowed (default: false). */
  allowGlobalScope: boolean;
}

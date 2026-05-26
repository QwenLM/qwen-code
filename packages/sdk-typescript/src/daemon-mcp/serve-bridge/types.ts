/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for serve-bridge MCP server.
 *
 * Implementation is split across:
 * - ./sse.ts — SSE stream lifecycle (startEventStream, stopEventStream, createPromptCollector)
 * - ./helpers.ts — Utility functions (handler, resolveSessionId, authHeaders, daemonFetch)
 */

import type { DaemonClient } from '../../daemon/DaemonClient.js';

// Re-export implementations for backward compatibility
export {
  createPromptCollector,
  startEventStream,
  stopEventStream,
} from './sse.js';
export {
  authHeaders,
  daemonFetch,
  resolveSessionId,
  handler,
} from './helpers.js';

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
}

/**
 * Tracks a per-prompt message collection cycle.
 * Created before sending a prompt, resolved when _meta arrives or prompt returns.
 */
export interface PromptCollector {
  texts: string[];
  resolve: () => void;
  promise: Promise<void>;
  resolved: boolean;
}

/**
 * Persistent SSE connection for a session.
 * Established at session_create, torn down at session_close.
 */
export interface SessionEventStream {
  sessionId: string;
  abortCtrl: AbortController;
  /** Current active prompt collector (null when idle). */
  activeCollector: PromptCollector | null;
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
}

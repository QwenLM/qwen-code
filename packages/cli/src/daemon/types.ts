/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/** Information stored in the daemon lock file for process discovery. */
export interface DaemonLockInfo {
  /** Process ID of the daemon. */
  pid: number;
  /** HTTP server port. */
  port: number;
  /** Authentication token for API access. */
  authToken: string;
  /** Working directory the daemon was started in. */
  cwd: string;
  /** ISO 8601 timestamp when the daemon was started. */
  startedAt: string;
}

/** Status of a daemon session visible to the web UI. */
export interface DaemonSessionInfo {
  /** Unique session identifier (used in URL path). */
  sessionId: string;
  /** WebSocket client count for this session. */
  clientCount: number;
  /** ISO 8601 timestamp of session creation. */
  createdAt: string;
  /** First user prompt text (truncated). */
  prompt: string;
}

/** Message sent over WebSocket between client and daemon. */
export interface DaemonWsMessage {
  type:
    | 'prompt'
    | 'output'
    | 'status'
    | 'error'
    | 'stop'
    | 'history'
    | 'connected';
  sessionId?: string;
  data?: unknown;
}

/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Stable error codes; the daemon passes `code` to the host as-is. */
export type DaemonMcpErrorCode =
  | 'BUSY'
  | 'IDENTITY_CHANGED'
  | 'UNSUPPORTED'
  | 'SETTINGS_UNREADABLE'
  | 'NOT_FOUND'
  | 'DISABLED'
  | 'NOT_CONNECTED'
  | 'DISCOVERY_FAILED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_NOT_ALLOWED'
  | 'NOT_WRITABLE'
  | 'MCP_UNAVAILABLE'
  | 'RELOAD_FAILED'
  | 'NOT_IN_PROGRESS'
  | 'AUTH_FAILED'
  | 'INVALID_CONFIG'
  | 'VERSION_CONFLICT'
  | 'ALREADY_EXISTS'
  | 'CONFIRM_REQUIRED'
  | 'CONFIRM_EXPIRED'
  | 'WRITE_FAILED';

export class DaemonMcpError extends Error {
  constructor(
    readonly code: DaemonMcpErrorCode,
    message: string,
    /** Wire-shaped (snake_case), secret-free detail, e.g. per-item issues. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DaemonMcpError';
  }
}

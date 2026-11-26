/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Model } from '../../provider/model/model.js';

export interface McpModelInfo {
  displayName: string;
  key: string;
  /** Current session ID, forwarded to MCP calls as X-Qoder-Session-Id. */
  sessionId?: string;
  /**
   * Current request-set ID, forwarded to MCP HTTP calls as X-RequestSet-ID.
   * The session ID is additionally forwarded as X-Session-ID.
   */
  requestSetId?: string;
  /**
   * Exact model selected for the calling request. Core only passes it through;
   * product transports derive their own metadata (e.g. headers) from it.
   * May carry connection material on direct-connection models, so never log or
   * serialize it.
   */
  modelEntry?: Model;
  /**
   * Absolute working directory of the session issuing the call. Connections are
   * pooled across sessions, so the per-session directory travels with the call
   * rather than living on the connection.
   */
  cwd?: string;
  /** Every workspace directory of the calling session, cwd included. */
  workspaceDirectories?: readonly string[];
}

export const mcpModelContext = new AsyncLocalStorage<McpModelInfo>();

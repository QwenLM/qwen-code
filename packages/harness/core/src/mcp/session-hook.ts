/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Session-scoped attachment point for the process-global MCP pool.
//
// A hook is built per session (with that session's Config, so it can read
// session posture) but attaches to the shared McpManager, because the things it
// contributes — the protocol extensions advertised on every connection and the
// `_meta` added to outgoing tool calls — are process-level facts (e.g. one
// logged-in identity shared by all sessions in the process).

import type { Config } from '../config/config.js';
import type { McpManager } from './mcpManager.js';

export interface McpSessionHook {
  /**
   * Called once with the process pool after the session's manager exists and
   * before its servers are used — early enough to influence the handshake.
   */
  onReady?(manager: McpManager): void | Promise<void>;

  /** Called before the session tears its MCP wiring down. */
  onTeardown?(): void | Promise<void>;
}

/**
 * Builds a hook for one session. Called by Config during initialization with
 * the session's own instance, so a hook can read session posture without Config
 * having to know what the hook does.
 */
export type McpSessionHookFactory = (config: Config) => McpSessionHook;

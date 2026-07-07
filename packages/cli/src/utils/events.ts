/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';

export enum AppEvent {
  OpenDebugConsole = 'open-debug-console',
  LogError = 'log-error',
  OauthDisplayMessage = 'oauth-display-message',
  OauthAuthUrl = 'oauth-auth-url',
  /**
   * A settings hot-reload changed the set of gated MCP servers pending
   * approval (e.g. an edit to a `workspace`/`project`-scoped server invalidated
   * its hash-bound approval). Drives the interactive approval dialog to
   * re-evaluate mid-session instead of only at startup. See issue #4615.
   */
  McpPendingApprovalChanged = 'mcp-pending-approval-changed',
  LspStatusChanged = 'lsp-status-changed',
}

export const appEvents = new EventEmitter();

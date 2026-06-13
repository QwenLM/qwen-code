/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------------------------------------------------------------------------
// Shared ACP route table
// ---------------------------------------------------------------------------
// Single source of truth for the URL→JSON-RPC mapping used by both
// `AcpWsTransport` and `AcpHttpTransport`. Keeping a single table
// prevents route inconsistencies between the two transport variants.
// ---------------------------------------------------------------------------

import { isRecord } from './acpTransportUtils.js';

export interface RouteMapping {
  method: string;
  /** Extract JSON-RPC params from URL path segments + request body. */
  extractParams: (
    segments: string[],
    body: unknown,
    httpMethod: string,
  ) => Record<string, unknown>;
  /**
   * True for notifications (no response expected). The transport will
   * NOT wait for a JSON-RPC response from the server.
   */
  notification?: boolean;
}

export interface RouteEntry {
  httpMethod: string;
  pattern: RegExp;
  mapping: RouteMapping;
}

/**
 * Map of `METHOD PATH_PATTERN` to JSON-RPC method + params extractor.
 * Path segments are split by `/` after stripping the base URL prefix.
 *
 * Pattern conventions:
 *   - `:param` = named path param (consumed positionally)
 *   - `*`      = rest wildcard
 */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  // POST /session → session/new
  {
    httpMethod: 'POST',
    pattern: /^\/session\/?$/,
    mapping: {
      method: 'session/new',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // POST /session/:id/prompt → session/prompt
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/prompt$/,
    mapping: {
      method: 'session/prompt',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/cancel → session/cancel (notification)
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/cancel$/,
    mapping: {
      method: 'session/cancel',
      extractParams: (segs) => ({ sessionId: segs[0] }),
      notification: true,
    },
  },
  // DELETE /session/:id → session/close
  {
    httpMethod: 'DELETE',
    pattern: /^\/session\/([^/]+)\/?$/,
    mapping: {
      method: 'session/close',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/load → session/load
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/load$/,
    mapping: {
      method: 'session/load',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/resume → session/resume
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/resume$/,
    mapping: {
      method: 'session/resume',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/permission/:reqId → session/permission
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/permission\/([^/]+)$/,
    mapping: {
      method: 'session/permission',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        requestId: segs[1],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /permission/:reqId (without session prefix)
  {
    httpMethod: 'POST',
    pattern: /^\/permission\/([^/]+)$/,
    mapping: {
      method: 'session/permission',
      extractParams: (segs, body) => ({
        requestId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/model → session/set_config_option
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/model$/,
    mapping: {
      method: 'session/set_config_option',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /capabilities → use initialize result (handled specially)
  {
    httpMethod: 'GET',
    pattern: /^\/capabilities\/?$/,
    mapping: {
      method: '_capabilities',
      extractParams: () => ({}),
    },
  },
  // GET /health
  {
    httpMethod: 'GET',
    pattern: /^\/health\/?$/,
    mapping: {
      method: '_qwen/health',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/* → _qwen/workspace
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_qwen/workspace',
      extractParams: (segs) => ({
        path: segs[0],
      }),
    },
  },
  // POST /workspace/* → _qwen/workspace
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_qwen/workspace',
      extractParams: (segs, body) => ({
        path: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // PATCH /session/:id/metadata → session/metadata
  {
    httpMethod: 'PATCH',
    pattern: /^\/session\/([^/]+)\/metadata$/,
    mapping: {
      method: 'session/metadata',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/heartbeat
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/heartbeat$/,
    mapping: {
      method: 'session/heartbeat',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/recap
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/recap$/,
    mapping: {
      method: 'session/recap',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/btw
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/btw$/,
    mapping: {
      method: 'session/btw',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/shell
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/shell$/,
    mapping: {
      method: 'session/shell',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/approval-mode
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/approval-mode$/,
    mapping: {
      method: 'session/approval_mode',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/branch
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/branch$/,
    mapping: {
      method: 'session/branch',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },

  // POST /session/:id/detach → session/detach
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/detach$/,
    mapping: {
      method: 'session/detach',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },

  // ---- Session diagnostic / action routes --------------------------------

  // GET /session/:id/context → session/context
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context$/,
    mapping: {
      method: 'session/context',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/context-usage → session/context_usage
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context-usage$/,
    mapping: {
      method: 'session/context_usage',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/supported-commands → session/supported_commands
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/supported-commands$/,
    mapping: {
      method: 'session/supported_commands',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/tasks → session/tasks
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/tasks$/,
    mapping: {
      method: 'session/tasks',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/tasks/:taskId/cancel → session/task_cancel
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/tasks\/([^/]+)\/cancel$/,
    mapping: {
      method: 'session/task_cancel',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        taskId: segs[1],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/goal/clear → session/goal_clear
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/goal\/clear$/,
    mapping: {
      method: 'session/goal_clear',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /session/:id/stats → session/stats
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/stats$/,
    mapping: {
      method: 'session/stats',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/rewind/snapshots → session/rewind_snapshots
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/rewind\/snapshots$/,
    mapping: {
      method: 'session/rewind_snapshots',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/rewind → session/rewind
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/rewind$/,
    mapping: {
      method: 'session/rewind',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/language → session/language
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/language$/,
    mapping: {
      method: 'session/language',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },

  // GET /session/:id/hooks → session/hooks
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/hooks$/,
    mapping: {
      method: 'session/hooks',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },

  // ---- File system routes -----------------------------------------------
  // These map the DaemonClient's file-system helpers to _qwen/file/* RPC
  // methods on the ACP daemon.

  // GET /file → _qwen/file/read (query params forwarded as RPC params)
  {
    httpMethod: 'GET',
    pattern: /^\/file\/?$/,
    mapping: {
      method: '_qwen/file/read',
      extractParams: () => ({}),
    },
  },
  // GET /file/bytes → _qwen/file/read_bytes
  {
    httpMethod: 'GET',
    pattern: /^\/file\/bytes\/?$/,
    mapping: {
      method: '_qwen/file/read_bytes',
      extractParams: () => ({}),
    },
  },
  // GET /stat → _qwen/file/stat
  {
    httpMethod: 'GET',
    pattern: /^\/stat\/?$/,
    mapping: {
      method: '_qwen/file/stat',
      extractParams: () => ({}),
    },
  },
  // GET /list → _qwen/file/list
  {
    httpMethod: 'GET',
    pattern: /^\/list\/?$/,
    mapping: {
      method: '_qwen/file/list',
      extractParams: () => ({}),
    },
  },
  // GET /glob → _qwen/file/glob
  {
    httpMethod: 'GET',
    pattern: /^\/glob\/?$/,
    mapping: {
      method: '_qwen/file/glob',
      extractParams: () => ({}),
    },
  },
  // POST /file/write → _qwen/file/write
  {
    httpMethod: 'POST',
    pattern: /^\/file\/write\/?$/,
    mapping: {
      method: '_qwen/file/write',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // POST /file/edit → _qwen/file/edit
  {
    httpMethod: 'POST',
    pattern: /^\/file\/edit\/?$/,
    mapping: {
      method: '_qwen/file/edit',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },

  // ---- Bulk session operations -------------------------------------------

  // POST /sessions/delete → _qwen/sessions/delete
  {
    httpMethod: 'POST',
    pattern: /^\/sessions\/delete\/?$/,
    mapping: {
      method: '_qwen/sessions/delete',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
];

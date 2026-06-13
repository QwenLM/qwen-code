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
  // ACP standard: session/new always creates an isolated session.
  // Strip non-standard params (sessionScope) — the server enforces
  // 'thread' regardless, so passing it is harmless but misleading.
  {
    httpMethod: 'POST',
    pattern: /^\/session\/?$/,
    mapping: {
      method: 'session/new',
      extractParams: (_s, body) => {
        if (!isRecord(body)) return {};
        const { sessionScope: _, ...rest } = body as Record<string, unknown>;
        return rest;
      },
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
  // POST /session/:id/model → session/set_model
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/model$/,
    mapping: {
      method: 'session/set_model',
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

  // ---- Vendor session extensions (_qwen/ prefix) -------------------------

  // PATCH /session/:id/metadata → _qwen/session/update_metadata
  {
    httpMethod: 'PATCH',
    pattern: /^\/session\/([^/]+)\/metadata$/,
    mapping: {
      method: '_qwen/session/update_metadata',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/heartbeat → _qwen/session/heartbeat
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/heartbeat$/,
    mapping: {
      method: '_qwen/session/heartbeat',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/recap → _qwen/session/recap
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/recap$/,
    mapping: {
      method: '_qwen/session/recap',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/btw → _qwen/session/btw
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/btw$/,
    mapping: {
      method: '_qwen/session/btw',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/shell → _qwen/session/shell
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/shell$/,
    mapping: {
      method: '_qwen/session/shell',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/branch → session/fork
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/branch$/,
    mapping: {
      method: 'session/fork',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/detach → _qwen/session/detach
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/detach$/,
    mapping: {
      method: '_qwen/session/detach',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },

  // ---- Session diagnostic routes (_qwen/ prefix) -------------------------

  // GET /session/:id/context → _qwen/session/context
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context$/,
    mapping: {
      method: '_qwen/session/context',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/context-usage → _qwen/session/context_usage
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context-usage$/,
    mapping: {
      method: '_qwen/session/context_usage',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/supported-commands → _qwen/session/supported_commands
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/supported-commands$/,
    mapping: {
      method: '_qwen/session/supported_commands',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/tasks → _qwen/session/tasks
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/tasks$/,
    mapping: {
      method: '_qwen/session/tasks',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },

  // ---- Granular workspace routes (_qwen/workspace/*) ---------------------

  // GET /workspace/mcp → _qwen/workspace/mcp
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/mcp\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/skills → _qwen/workspace/skills
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/skills\/?$/,
    mapping: {
      method: '_qwen/workspace/skills',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/providers → _qwen/workspace/providers
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/providers\/?$/,
    mapping: {
      method: '_qwen/workspace/providers',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/env → _qwen/workspace/env
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/env\/?$/,
    mapping: {
      method: '_qwen/workspace/env',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/preflight → _qwen/workspace/preflight
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/preflight\/?$/,
    mapping: {
      method: '_qwen/workspace/preflight',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/init → _qwen/workspace/init
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/init\/?$/,
    mapping: {
      method: '_qwen/workspace/init',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/tools → _qwen/workspace/tools
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/tools\/?$/,
    mapping: {
      method: '_qwen/workspace/tools',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/memory → _qwen/workspace/memory
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/memory\/?$/,
    mapping: {
      method: '_qwen/workspace/memory',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/memory → _qwen/workspace/memory/write
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/memory\/?$/,
    mapping: {
      method: '_qwen/workspace/memory/write',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/agents → _qwen/workspace/agents/list
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/agents\/?$/,
    mapping: {
      method: '_qwen/workspace/agents/list',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/agents → _qwen/workspace/agents/create
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/agents\/?$/,
    mapping: {
      method: '_qwen/workspace/agents/create',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/agents/:agentType → _qwen/workspace/agents/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/agents\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/agents/get',
      extractParams: (segs) => ({ agentType: segs[0] }),
    },
  },
  // DELETE /workspace/agents/:agentType → _qwen/workspace/agents/delete
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/agents\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/agents/delete',
      extractParams: (segs, body) => ({
        agentType: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /workspace/mcp/:server/tools → _qwen/workspace/mcp/tools
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/mcp\/([^/]+)\/tools\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp/tools',
      extractParams: (segs) => ({ serverName: segs[0] }),
    },
  },
  // POST /workspace/mcp/servers → _qwen/workspace/mcp/servers/add
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/mcp\/servers\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp/servers/add',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // DELETE /workspace/mcp/servers/:name → _qwen/workspace/mcp/servers/remove
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/mcp\/servers\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp/servers/remove',
      extractParams: (segs, body) => ({
        name: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /workspace/set-tool-enabled → _qwen/workspace/set_tool_enabled
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/set-tool-enabled\/?$/,
    mapping: {
      method: '_qwen/workspace/set_tool_enabled',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // POST /workspace/mcp/:server/restart → _qwen/workspace/restart_mcp_server
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/mcp\/([^/]+)\/restart\/?$/,
    mapping: {
      method: '_qwen/workspace/restart_mcp_server',
      extractParams: (segs, body) => ({
        serverName: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /workspace/auth/status → _qwen/workspace/auth/status
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/auth\/status\/?$/,
    mapping: {
      method: '_qwen/workspace/auth/status',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/auth/device-flow → _qwen/workspace/auth/device_flow/start
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/auth\/device-flow\/?$/,
    mapping: {
      method: '_qwen/workspace/auth/device_flow/start',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/auth/device-flow/:id → _qwen/workspace/auth/device_flow/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/auth\/device-flow\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/auth/device_flow/get',
      extractParams: (segs) => ({ id: segs[0] }),
    },
  },
  // DELETE /workspace/auth/device-flow/:id → _qwen/workspace/auth/device_flow/cancel
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/auth\/device-flow\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/auth/device_flow/cancel',
      extractParams: (segs) => ({ id: segs[0] }),
    },
  },

  // ---- Workspace catch-all (must be AFTER all specific workspace routes) --
  // Handles any workspace path not matched above (e.g., /workspace/custom/path).
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_qwen/workspace',
      extractParams: (segs) => ({ path: segs[0] }),
    },
  },
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

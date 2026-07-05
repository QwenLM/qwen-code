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
  /**
   * Extract JSON-RPC params from URL path segments, request body, and — for the
   * REST-style query-backed helpers (`/file?path=…&maxBytes=…`, `/stat`,
   * `/list`, `/glob`, `context-usage?detail=…`) — the URL query string. The
   * daemon's ACP handlers are strictly typed (e.g. `maxBytes` must be a
   * `number`, `detail` must be the boolean `true`), so query values — which
   * arrive as strings — are coerced to the expected type here via
   * `strParam`/`numParam`/`boolParam`.
   */
  extractParams: (
    segments: string[],
    body: unknown,
    httpMethod: string,
    query?: URLSearchParams,
  ) => Record<string, unknown>;
  /**
   * True for notifications (no response expected). The transport will
   * NOT wait for a JSON-RPC response from the server.
   */
  notification?: boolean;
}

/** A string query param, omitted when absent. */
function strParam(
  q: URLSearchParams | undefined,
  name: string,
): Record<string, string> {
  const v = q?.get(name);
  return v == null ? {} : { [name]: v };
}

/**
 * A numeric query param coerced to a `number`, omitted when absent. The daemon's
 * ACP handlers require a real number (a query string's `"123"` would be
 * rejected). An unparseable value forwards as `NaN`, which the daemon rejects
 * the same way it would a malformed REST query.
 *
 * An empty value (`?maxBytes=`) is treated as ABSENT, not `0`: `Number('')` is
 * `0`, a plausible-but-unintended value the handler would otherwise honor.
 */
function numParam(
  q: URLSearchParams | undefined,
  name: string,
): Record<string, number> {
  const v = q?.get(name);
  return v == null || v === '' ? {} : { [name]: Number(v) };
}

/** A boolean query param (`?detail=true`), omitted when absent. */
function boolParam(
  q: URLSearchParams | undefined,
  name: string,
): Record<string, boolean> {
  const v = q?.get(name);
  // Treat an empty value (`?detail=`) as absent, mirroring `numParam`, so we
  // don't forward `{ detail: false }` for a param the caller never set.
  return v == null || v === '' ? {} : { [name]: v === 'true' };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
        requestId: segs[1],
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
        ...bodyRecord(body),
        requestId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
      }),
    },
  },
  // PATCH /session/:id/organization → _qwen/session/update_organization
  {
    httpMethod: 'PATCH',
    pattern: /^\/session\/([^/]+)\/organization$/,
    mapping: {
      method: '_qwen/session/update_organization',
      extractParams: (segs, body) => ({
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
      }),
    },
  },
  // GET /session/:id/artifacts → _qwen/session/artifacts
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/artifacts$/,
    mapping: {
      method: '_qwen/session/artifacts',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/artifacts → _qwen/session/artifacts/add
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/artifacts$/,
    mapping: {
      method: '_qwen/session/artifacts/add',
      extractParams: (segs, body) => ({
        ...bodyRecord(body),
        sessionId: segs[0],
      }),
    },
  },
  // POST /session/:id/artifacts/:artifactId/pin → _qwen/session/artifacts/pin
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/artifacts\/([^/]+)\/pin$/,
    mapping: {
      method: '_qwen/session/artifacts/pin',
      extractParams: (segs, body) => ({
        ...(isRecord(body) ? body : {}),
        sessionId: segs[0],
        artifactId: segs[1],
      }),
    },
  },
  // DELETE /session/:id/artifacts/:artifactId/pin → _qwen/session/artifacts/unpin
  {
    httpMethod: 'DELETE',
    pattern: /^\/session\/([^/]+)\/artifacts\/([^/]+)\/pin$/,
    mapping: {
      method: '_qwen/session/artifacts/unpin',
      extractParams: (segs, body) => ({
        ...(isRecord(body) ? body : {}),
        sessionId: segs[0],
        artifactId: segs[1],
      }),
    },
  },
  // GET /session/:id/artifacts/fsck → _qwen/session/artifacts/fsck
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/artifacts\/fsck$/,
    mapping: {
      method: '_qwen/session/artifacts/fsck',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/artifacts/gc → _qwen/session/artifacts/gc
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/artifacts\/gc$/,
    mapping: {
      method: '_qwen/session/artifacts/gc',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // DELETE /session/:id/artifacts/:artifactId → _qwen/session/artifacts/remove
  {
    httpMethod: 'DELETE',
    pattern: /^\/session\/([^/]+)\/artifacts\/([^/]+)$/,
    mapping: {
      method: '_qwen/session/artifacts/remove',
      extractParams: (segs, body) => ({
        ...(isRecord(body) ? body : {}),
        sessionId: segs[0],
        artifactId: segs[1],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
        ...bodyRecord(body),
        sessionId: segs[0],
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
  // GET /session/:id/context-usage?detail=true → _qwen/session/context_usage
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context-usage$/,
    mapping: {
      method: '_qwen/session/context_usage',
      extractParams: (segs, _b, _m, q) => ({
        sessionId: segs[0],
        ...boolParam(q, 'detail'),
      }),
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
  // GET /session/:id/lsp -> _qwen/session/lsp
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/lsp$/,
    mapping: {
      method: '_qwen/session/lsp',
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
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // GET /workspace/trust → _qwen/workspace/trust
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/trust\/?$/,
    mapping: {
      method: '_qwen/workspace/trust',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/trust/request → _qwen/workspace/trust/request
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/trust\/request\/?$/,
    mapping: {
      method: '_qwen/workspace/trust/request',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // GET /workspace/permissions → _qwen/workspace/permissions
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/permissions\/?$/,
    mapping: {
      method: '_qwen/workspace/permissions',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/permissions → _qwen/workspace/permissions/set
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/permissions\/?$/,
    mapping: {
      method: '_qwen/workspace/permissions/set',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // GET /workspace/voice → _qwen/workspace/voice
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/voice\/?$/,
    mapping: {
      method: '_qwen/workspace/voice',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/voice → _qwen/workspace/voice/set
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/voice\/?$/,
    mapping: {
      method: '_qwen/workspace/voice/set',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // POST /workspace/setup-github → _qwen/workspace/setup-github
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/setup-github\/?$/,
    mapping: {
      method: '_qwen/workspace/setup-github',
      extractParams: (_s, body) => bodyRecord(body),
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
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // POST /workspace/memory/remember → _qwen/workspace/memory/remember
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/memory\/remember\/?$/,
    mapping: {
      method: '_qwen/workspace/memory/remember',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // GET /workspace/memory/remember/:taskId → _qwen/workspace/memory/remember/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/memory\/remember\/([^/]+)$/,
    mapping: {
      method: '_qwen/workspace/memory/remember/get',
      extractParams: (segs) => ({ taskId: segs[0] }),
    },
  },
  // POST /workspace/memory/forget → _qwen/workspace/memory/forget
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/memory\/forget\/?$/,
    mapping: {
      method: '_qwen/workspace/memory/forget',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // GET /workspace/memory/forget/:taskId → _qwen/workspace/memory/forget/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/memory\/forget\/([^/]+)$/,
    mapping: {
      method: '_qwen/workspace/memory/forget/get',
      extractParams: (segs) => ({ taskId: segs[0] }),
    },
  },
  // POST /workspace/memory/dream → _qwen/workspace/memory/dream
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/memory\/dream\/?$/,
    mapping: {
      method: '_qwen/workspace/memory/dream',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/memory/dream/:taskId → _qwen/workspace/memory/dream/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/memory\/dream\/([^/]+)$/,
    mapping: {
      method: '_qwen/workspace/memory/dream/get',
      extractParams: (segs) => ({ taskId: segs[0] }),
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
      extractParams: (_s, body) => bodyRecord(body),
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
        ...bodyRecord(body),
        agentType: segs[0],
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
  // GET /workspace/mcp/:server/resources → _qwen/workspace/mcp/resources
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/mcp\/([^/]+)\/resources\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp/resources',
      extractParams: (segs) => ({ serverName: segs[0] }),
    },
  },
  // POST /workspace/mcp/servers → _qwen/workspace/mcp/servers/add
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/mcp\/servers\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp/servers/add',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // DELETE /workspace/mcp/servers/:name → _qwen/workspace/mcp/servers/remove
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/mcp\/servers\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/mcp/servers/remove',
      extractParams: (segs, body) => ({
        ...bodyRecord(body),
        name: segs[0],
      }),
    },
  },
  // POST /workspace/set-tool-enabled → _qwen/workspace/set_tool_enabled
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/set-tool-enabled\/?$/,
    mapping: {
      method: '_qwen/workspace/set_tool_enabled',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // POST /workspace/mcp/:server/restart → _qwen/workspace/restart_mcp_server
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/mcp\/([^/]+)\/restart\/?$/,
    mapping: {
      method: '_qwen/workspace/restart_mcp_server',
      extractParams: (segs, body) => ({
        ...bodyRecord(body),
        serverName: segs[0],
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
      extractParams: (_s, body) => bodyRecord(body),
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

  // GET /workspace/:id/sessions → session/list
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)\/sessions\/?$/,
    mapping: {
      method: 'session/list',
      extractParams: (segs, _body, _method, query) => {
        const size = query?.get('size');
        return {
          workspaceCwd: segs[0],
          ...strParam(query, 'cursor'),
          ...strParam(query, 'archiveState'),
          ...strParam(query, 'view'),
          ...strParam(query, 'group'),
          ...(size == null || size === ''
            ? {}
            : { _meta: { size: Number(size) } }),
        };
      },
    },
  },
  // GET /workspace/:id/session-groups → _qwen/workspace/session_groups/list
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)\/session-groups\/?$/,
    mapping: {
      method: '_qwen/workspace/session_groups/list',
      extractParams: (segs) => ({ workspaceCwd: segs[0] }),
    },
  },
  // POST /workspace/:id/session-groups → _qwen/workspace/session_groups/create
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/(.+)\/session-groups\/?$/,
    mapping: {
      method: '_qwen/workspace/session_groups/create',
      extractParams: (segs, body) => ({
        ...bodyRecord(body),
        workspaceCwd: segs[0],
      }),
    },
  },
  // PATCH /workspace/:id/session-groups/:groupId → _qwen/workspace/session_groups/update
  {
    httpMethod: 'PATCH',
    pattern: /^\/workspace\/(.+)\/session-groups\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/session_groups/update',
      extractParams: (segs, body) => ({
        ...bodyRecord(body),
        workspaceCwd: segs[0],
        groupId: segs[1],
      }),
    },
  },
  // DELETE /workspace/:id/session-groups/:groupId → _qwen/workspace/session_groups/delete
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/(.+)\/session-groups\/([^/]+)\/?$/,
    mapping: {
      method: '_qwen/workspace/session_groups/delete',
      extractParams: (segs) => ({
        workspaceCwd: segs[0],
        groupId: segs[1],
      }),
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
        ...bodyRecord(body),
        path: segs[0],
      }),
    },
  },

  // ---- File system routes -----------------------------------------------
  // These map the DaemonClient's file-system helpers to _qwen/file/* RPC
  // methods on the ACP daemon.

  // GET /file?path=…&maxBytes=…&line=…&limit=… → _qwen/file/read
  {
    httpMethod: 'GET',
    pattern: /^\/file\/?$/,
    mapping: {
      method: '_qwen/file/read',
      extractParams: (_s, _b, _m, q) => ({
        ...strParam(q, 'path'),
        ...numParam(q, 'maxBytes'),
        ...numParam(q, 'line'),
        ...numParam(q, 'limit'),
      }),
    },
  },
  // GET /file/bytes?path=…&offset=…&maxBytes=… → _qwen/file/read_bytes
  {
    httpMethod: 'GET',
    pattern: /^\/file\/bytes\/?$/,
    mapping: {
      method: '_qwen/file/read_bytes',
      extractParams: (_s, _b, _m, q) => ({
        ...strParam(q, 'path'),
        ...numParam(q, 'offset'),
        ...numParam(q, 'maxBytes'),
      }),
    },
  },
  // GET /stat?path=… → _qwen/file/stat
  {
    httpMethod: 'GET',
    pattern: /^\/stat\/?$/,
    mapping: {
      method: '_qwen/file/stat',
      extractParams: (_s, _b, _m, q) => ({ ...strParam(q, 'path') }),
    },
  },
  // GET /list?path=… → _qwen/file/list
  {
    httpMethod: 'GET',
    pattern: /^\/list\/?$/,
    mapping: {
      method: '_qwen/file/list',
      extractParams: (_s, _b, _m, q) => ({ ...strParam(q, 'path') }),
    },
  },
  // GET /glob?pattern=… → _qwen/file/glob
  {
    httpMethod: 'GET',
    pattern: /^\/glob\/?$/,
    mapping: {
      method: '_qwen/file/glob',
      extractParams: (_s, _b, _m, q) => ({ ...strParam(q, 'pattern') }),
    },
  },
  // POST /file/write → _qwen/file/write
  {
    httpMethod: 'POST',
    pattern: /^\/file\/write\/?$/,
    mapping: {
      method: '_qwen/file/write',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // POST /file/edit → _qwen/file/edit
  {
    httpMethod: 'POST',
    pattern: /^\/file\/edit\/?$/,
    mapping: {
      method: '_qwen/file/edit',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },

  // ---- Bulk session operations -------------------------------------------

  // POST /sessions/delete → _qwen/sessions/delete
  {
    httpMethod: 'POST',
    pattern: /^\/sessions\/delete\/?$/,
    mapping: {
      method: '_qwen/sessions/delete',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // POST /sessions/archive → _qwen/sessions/archive
  {
    httpMethod: 'POST',
    pattern: /^\/sessions\/archive\/?$/,
    mapping: {
      method: '_qwen/sessions/archive',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
  // POST /sessions/unarchive → _qwen/sessions/unarchive
  {
    httpMethod: 'POST',
    pattern: /^\/sessions\/unarchive\/?$/,
    mapping: {
      method: '_qwen/sessions/unarchive',
      extractParams: (_s, body) => bodyRecord(body),
    },
  },
];

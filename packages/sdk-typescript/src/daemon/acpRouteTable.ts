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
export const ROUTE_TABLE: ReadonlyArray<RouteEntry> = [
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
];

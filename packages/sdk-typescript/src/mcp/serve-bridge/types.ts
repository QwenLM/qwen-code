/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '../../daemon/DaemonClient.js';

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
}

/**
 * Build authorization headers for raw fetch calls.
 */
export function authHeaders(state: BridgeState): Record<string, string> {
  const headers: Record<string, string> = {};
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  return headers;
}

/**
 * Raw fetch helper for daemon endpoints not exposed by DaemonClient.
 * Throws on non-OK responses with the response body as message.
 */
export async function daemonFetch(
  state: BridgeState,
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${state.daemonUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { headers: authHeaders(state) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${path}: ${text || res.statusText}`);
  }
  return await res.json();
}

/**
 * Resolve the session ID from explicit arg or default state.
 * Returns the session ID or throws a descriptive error.
 */
export function resolveSessionId(
  state: BridgeState,
  explicitSessionId?: string,
): string {
  const sessionId = explicitSessionId ?? state.defaultSessionId;
  if (!sessionId) {
    throw new Error(
      'No session active. Call session_create first, or pass an explicit session_id.',
    );
  }
  return sessionId;
}

/**
 * Create an MCP tool handler that catches errors and returns them as
 * isError responses. Also satisfies the (args, extra) signature.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function handler<T>(
  fn: (args: T) => Promise<any>,
): (args: T, extra: unknown) => Promise<any> {
  return async (args: T, _extra: unknown) => {
    try {
      return await fn(args);
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}

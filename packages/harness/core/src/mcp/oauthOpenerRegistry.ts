/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide routing for the MCP OAuth "open the browser" hook.
 *
 * Core keeps a **single** opener slot (`setMcpOAuthBrowserOpener`): installing
 * one replaces the previous, clearing it drops it. A daemon runs many
 * sessions plus its own daemon-level authorizations in one process, so each
 * of them registers here instead of taking the slot:
 *
 * - the first registration installs the dispatcher, later ones only join the
 *   table; the slot is cleared once the table is empty again (restoring core's
 *   default browser launcher);
 * - the dispatcher asks each registered opener in registration order. An
 *   opener that has no flow for the server throws, and the next one is asked;
 *   when nobody claims the request the last error is rethrown, which makes
 *   core fall back to its default launcher.
 *
 * Host-driven flows carry a flowId. Owners must match it before claiming the
 * request; the provider never falls back to a browser for an unclaimed flowId.
 */

import {
  setMcpOAuthBrowserOpener,
  type McpOAuthBrowserOpenMeta,
  type McpOAuthBrowserOpenResult,
  type McpOAuthBrowserOpener,
} from './connector/oauth/provider.js';

const registrations = new Map<symbol, McpOAuthBrowserOpener>();

export function registerMcpOAuthOpener(opener: McpOAuthBrowserOpener): symbol {
  const key = Symbol('mcp-oauth-opener');
  registrations.set(key, opener);
  if (registrations.size === 1) {
    setMcpOAuthBrowserOpener(dispatchOAuthOpen);
  }
  return key;
}

export function unregisterMcpOAuthOpener(key: symbol | undefined): void {
  if (key === undefined || !registrations.delete(key)) return;
  if (registrations.size === 0) {
    setMcpOAuthBrowserOpener(null);
  }
}

async function dispatchOAuthOpen(
  authUrl: string,
  meta: McpOAuthBrowserOpenMeta,
): Promise<void | McpOAuthBrowserOpenResult> {
  let lastError: unknown;
  for (const opener of registrations.values()) {
    try {
      return await opener(authUrl, meta);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('no MCP OAuth flow is in progress');
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  isSdkMcpServerConfig,
  type MCPServerConfig,
} from '../config/config.js';
import type { MCPOAuthConfig } from '../mcp/oauth-provider.js';
import { type McpTransportKind, mcpTransportOf } from './mcp-client-manager.js';
import type { ConnectionId } from './mcp-pool-events.js';

/**
 * Truncated SHA-256 hex (first 16 chars = 64 bits). At realistic pool
 * size (N < 1000 entries per workspace, typically < 100), birthday-
 * collision probability is < 10^-15 — safe to use as map key without
 * a fallback path.
 */
export type PoolKey = string;

/**
 * `McpTransportKind` and `mcpTransportOf` re-exported from
 * `mcp-client-manager.ts` (where they originated as part of the
 * budget guardrail accounting). imports + re-exports
 * via the pool barrel for downstream daemon code.
 */
export { mcpTransportOf, type McpTransportKind } from './mcp-client-manager.js';

/**
 * Default set of transports the pool will share. stdio + websocket
 * are true OS subprocesses whose state is observable and isolatable;
 * HTTP/SSE servers often bind state to the request stream and need
 * explicit operator opt-in. See `docs/design/f2-mcp-transport-pool.md`.
 */
export const POOLED_TRANSPORTS_DEFAULT: ReadonlySet<McpTransportKind> = new Set(
  ['stdio', 'websocket'],
);

/**
 * Decide whether a server config is eligible for pool sharing.
 * SDK MCP servers always bypass (per-session by design); other
 * transports gated on the operator's `pooledTransports` selection.
 */
export function isPoolable(
  cfg: MCPServerConfig,
  pooledTransports: ReadonlySet<McpTransportKind>,
): boolean {
  if (isSdkMcpServerConfig(cfg)) return false;
  return pooledTransports.has(mcpTransportOf(cfg));
}

/**
 * Normalize OAuth config so functionally-equivalent shapes collapse
 * to the same fingerprint. `undefined`, `null`, `{}`, `{enabled: false}`
 * all mean "no OAuth" → all return `null`.
 *
 * Scopes / audiences sorted so callsite order doesn't matter; explicit
 * `null` defaults so an undefined field doesn't change the hash vs an
 * explicitly null one.
 *
 * hash every
 * `MCPOAuthConfig` field (oauth-provider.ts:51-62). Pre-fix only
 * `clientId` / `scopes` / `authorizationUrl` / `tokenUrl` were hashed
 * — so two configs differing ONLY in `clientSecret` / `audiences` /
 * `redirectUri` / `tokenParamName` / `registrationUrl` collapsed to
 * the same fingerprint and shared a pool entry, leaking the first
 * config's effective credentials/audience/redirect into the second
 * session's transport. Especially load-bearing for `clientSecret`
 * (confidential client) and `audiences` (multi-audience tokens).
 */
export function canonicalOAuth(
  o?: MCPOAuthConfig | null,
): Record<string, unknown> | null {
  if (!o || !o.enabled) return null;
  return {
    enabled: true,
    clientId: o.clientId ?? null,
    clientSecret: o.clientSecret ?? null,
    scopes: o.scopes ? [...o.scopes].sort() : null,
    audiences: o.audiences ? [...o.audiences].sort() : null,
    authorizationUrl: o.authorizationUrl ?? null,
    tokenUrl: o.tokenUrl ?? null,
    redirectUri: o.redirectUri ?? null,
    tokenParamName: o.tokenParamName ?? null,
    registrationUrl: o.registrationUrl ?? null,
  };
}

/**
 * Sort entries by key for stable JSON. Returns `[]` for nullish input
 * so callsites can treat `undefined` env / headers identically to
 * empty objects.
 */
function sortedEntries(
  obj: Record<string, string> | undefined | null,
): Array<[string, string]> {
  if (!obj) return [];
  return Object.entries(obj).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
}

/**
 * Compute the pool fingerprint for an MCP server config. Two configs
 * with identical transport semantics + auth + env produce the same
 * fingerprint and thus share a pool entry; any divergence creates a
 * distinct entry.
 *
 * Hashed fields (transport-defining):
 *   transport, command, args, cwd, env, url, httpUrl, headers,
 *   timeout, oauth
 *
 * Excluded fields (per-session filter / metadata; do NOT change the
 * underlying transport):
 *   includeTools, excludeTools, trust, description, extensionName,
 *   discoveryTimeoutMs (operational tuning; honored from the first
 *   acquire's config but not in the key — see TODO below)
 *
 * TODO(follow-up): if two sessions race-acquire the same key with
 * different discoveryTimeoutMs values, the first wins. This matches
 * previous behavior (per-session managers each used their own timeout)
 * but could surprise operators tuning per-session. Acceptable for v1.
 */
export function fingerprint(cfg: MCPServerConfig): PoolKey {
  const canonical = {
    transport: mcpTransportOf(cfg),
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? null,
    env: sortedEntries(cfg.env),
    url: cfg.url ?? null,
    httpUrl: cfg.httpUrl ?? null,
    tcp: cfg.tcp ?? null,
    headers: sortedEntries(cfg.headers),
    timeout: cfg.timeout ?? null,
    oauth: canonicalOAuth(cfg.oauth),
    authProviderType: cfg.authProviderType ?? null,
    targetAudience: cfg.targetAudience ?? null,
    targetServiceAccount: cfg.targetServiceAccount ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build the `ConnectionId` from server name + computed fingerprint.
 * Form: `${name}::${fp16hex}`. Same name + different fingerprints
 * (e.g. divergent OAuth tokens or env between sessions) yields
 * distinct ConnectionIds — see global state coexistence for how
 * the global `serverStatuses` Map handles multi-entry name collisions.
 */
export function connectionIdOf(
  serverName: string,
  cfg: MCPServerConfig,
): ConnectionId {
  return `${serverName}::${fingerprint(cfg)}` as ConnectionId;
}

/**
 * Parse a ConnectionId back into its components. Useful for status
 * routes that need to surface the (serverName, entryIndex) pair
 * without exposing the raw fingerprint to clients.
 */
export function parseConnectionId(id: ConnectionId): {
  serverName: string;
  fingerprint: PoolKey;
} {
  const sep = id.lastIndexOf('::');
  if (sep < 0) {
    throw new Error(`Invalid ConnectionId: ${id}`);
  }
  return {
    serverName: id.slice(0, sep),
    fingerprint: id.slice(sep + 2),
  };
}

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import stableStringify from 'json-stable-stringify';
import { getPluginEnvironment } from './connector/transport/support.js';
import { normalizeMcpServerType } from '../config/mcpServerTypeNormalization.js';
import { expandMcpEnvVars } from './mcpEnvExpansion.js';
import type { MCPServerConfig } from './mcpServerConfig.js';
import { isMcpHostAuthenticated } from './authenticationOwnership.js';

/** Which stored OAuth credentials belong to a server. */
export interface McpOAuthCredentialIdentity {
  /**
   * The storage key: `<name>|<16 hex of sha256({type, url, headers})>`, the
   * name being `plugin:<plugin name>:<server>` for a plugin's server. A
   * change of transport, address or static headers is a new identity.
   */
  readonly key: string;
  /** Where credentials were stored before: the bare server name. */
  readonly legacyKey: string;
  /** The server address, expanded and normalized. */
  readonly url: string;
  readonly fromPlugin: boolean;
}

/**
 * The credential identity of a server that signs in with local OAuth;
 * undefined for one that cannot (stdio, SDK-hosted, or host-authenticated).
 * Variables are expanded the way the connection expands them, so a raw and
 * an expanded config give the same identity.
 */
export function mcpOAuthCredentialIdentity(
  serverName: string,
  config: MCPServerConfig,
): McpOAuthCredentialIdentity | undefined {
  const rawUrl = config.httpUrl ?? config.url;
  if (!rawUrl || isMcpHostAuthenticated(config) || config.type === 'sdk') {
    return undefined;
  }
  const env = { ...process.env, ...getPluginEnvironment(config.plugin) };
  const url = normalizeMcpServerUrl(expandMcpEnvVars(rawUrl, env));
  // A bare `url` is tried as Streamable HTTP first; the key must not depend
  // on whether this connection later fell back to SSE. Aliases are folded
  // here, as not every caller hands over a normalized config.
  const type = config.httpUrl
    ? 'http'
    : normalizeMcpServerType(config.type ?? 'http');
  const headers = Object.fromEntries(
    Object.entries(config.headers ?? {}).map(([name, value]) => [
      name,
      expandMcpEnvVars(value, env),
    ]),
  );
  const digest = createHash('sha256')
    .update(stableStringify({ type, url, headers }) ?? '')
    .digest('hex')
    .slice(0, 16);
  const name = config.plugin
    ? `plugin:${config.plugin.name}:${serverName}`
    : serverName;
  return {
    key: `${name}|${digest}`,
    legacyKey: serverName,
    url,
    fromPlugin: config.plugin !== undefined,
  };
}

/**
 * One spelling per address: lower-case host, no default port, no fragment,
 * no trailing `/` on a non-root path. Anything that is not a URL is kept as
 * written.
 */
export function normalizeMcpServerUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

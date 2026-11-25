/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The daemon's `serverId`: `user:<configKey>` for user settings entries,
 * `plugin:<url-encoded plugin id>:<name>` for servers a plugin declares. The
 * plugin id is encoded so it holds no `:`; the name is everything after it.
 */

import {
  mcpServerKeyId,
  type McpServerKey,
  type McpServerRegistration,
} from '@qwen-code/core';
import { userMcpServerKey } from '../../../mcp/framework.js';

const USER_PREFIX = 'user:';
const PLUGIN_PREFIX = 'plugin:';

export type ParsedServerId =
  | { readonly kind: 'user'; readonly configKey: string }
  | { readonly kind: 'enterprise'; readonly sourceId: string; readonly name: string }
  | {
      readonly kind: 'plugin';
      readonly pluginId: string;
      readonly name: string;
    };

export function userMcpServerId(configKey: string): string {
  return `${USER_PREFIX}${configKey}`;
}

export function pluginMcpServerId(pluginId: string, name: string): string {
  return `${PLUGIN_PREFIX}${encodeURIComponent(pluginId)}:${name}`;
}

/** The same id `serverIdOf` produces, from a pool key alone. */
export function serverIdForKey(key: McpServerKey): string {
  if (key.source.startsWith(PLUGIN_PREFIX)) {
    const separator = key.source.indexOf('~');
    const pluginId = decodeURIComponent(
      key.source.slice(
        PLUGIN_PREFIX.length,
        separator < 0 ? undefined : separator,
      ),
    );
    return pluginMcpServerId(pluginId, key.name);
  }
  if (key.source === userMcpServerKey(key.name).source) {
    return userMcpServerId(key.name);
  }
  return mcpServerKeyId(key);
}

/** Undefined for anything that is not a well-formed id. */
export function parseServerId(serverId: string): ParsedServerId | undefined {
  if (serverId.startsWith(USER_PREFIX)) {
    const configKey = serverId.slice(USER_PREFIX.length);
    return configKey ? { kind: 'user', configKey } : undefined;
  }
  if (serverId.startsWith('enterprise:')) {
    const match = /^enterprise:([^:]+):([^:]+)$/.exec(serverId);
    return match ? { kind: 'enterprise', sourceId: match[1]!, name: match[2]! } : undefined;
  }
  if (!serverId.startsWith(PLUGIN_PREFIX)) return undefined;
  const rest = serverId.slice(PLUGIN_PREFIX.length);
  const separator = rest.indexOf(':');
  const name = rest.slice(separator + 1);
  if (separator <= 0 || !name) return undefined;
  try {
    return {
      kind: 'plugin',
      pluginId: decodeURIComponent(rest.slice(0, separator)),
      name,
    };
  } catch {
    return undefined;
  }
}

/**
 * The `serverId` of a registration the daemon gave the pool. Built from what
 * the registration declares (its plugin, its name), never from the pool
 * key's format, so it stays the same when the plugin's config changes.
 */
export function serverIdOf(
  registration: Pick<McpServerRegistration, 'key' | 'config'>,
): string {
  const { key, config } = registration;
  if (config.plugin) return pluginMcpServerId(config.plugin.id, key.name);
  if (key.source === userMcpServerKey(key.name).source) {
    return userMcpServerId(key.name);
  }
  return mcpServerKeyId(key);
}

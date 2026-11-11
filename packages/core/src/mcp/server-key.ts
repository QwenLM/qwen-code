/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Identity for one MCP server config within a process.
//
// A logical server name on its own is not unique: the same name can arrive from
// a user settings file, a project `.mcp.json`, a plugin, an SDK bridge, or a
// per-session injection, and those are different servers that must not collide
// in a shared connection pool. The source discriminates them, so the pool can
// hand the same underlying server to two sessions while keeping a project file
// and a plugin that happen to share a name apart.

/**
 * Where a server config came from. Fixed for the life of the config: a server
 * that changes source is a different server, not an update to the same one.
 */
export type McpSourceId =
  /** A settings/`.mcp.json` file, identified by its realpath-normalized path. */
  | `file:${string}`
  /**
   * A CLI-flag injection (`--mcp-config` / the brand-prefixed `MCP_CONFIG`
   * env var). The daemon receives the flag with each session's argv, so the
   * same name can carry a different endpoint or credential per session; the
   * fingerprint part keeps those injections apart in the shared pool.
   */
  | `flag:${string}`
  /** A plugin, identified by `plugin.id` (`name@source`) — not the display name. */
  | `plugin:${string}`
  /** Injected for one session (ACP `session/new`, `mcp_set_servers`). */
  | `session:${string}`
  /** `settings.mcp.serverCommand`; the server name is always the fixed `mcp`. */
  | 'server-command'
  /** An SDK-hosted in-process server. */
  | 'sdk';

/** A fully-qualified MCP server identity: where it came from plus its name. */
export interface McpServerKey {
  readonly source: McpSourceId;
  readonly name: string;
}

export function mcpServerKey(
  source: McpSourceId,
  name: string,
): McpServerKey {
  return { source, name };
}

/** Source id for a settings/`.mcp.json` file. Pass an already-realpath'd path. */
export function fileMcpSourceId(realpath: string): McpSourceId {
  return `file:${realpath}`;
}

/** Source id for a CLI-flag injected server, discriminated by its injected config. */
export function flagMcpSourceId(
  origin: string,
  configFingerprint: string,
): McpSourceId {
  return `flag:${origin}#${configFingerprint}`;
}

/** Source id for a plugin. Pass `plugin.id` (`name@source`), not the name. */
export function pluginMcpSourceId(pluginId: string): McpSourceId {
  return `plugin:${pluginId}`;
}

/** Source id for servers injected into one session. */
export function sessionMcpSourceId(sessionId: string): McpSourceId {
  return `session:${sessionId}`;
}

/** Session-owned servers (dynamic, agent-inline, SDK-hosted) are not shared. */
export function isSessionMcpSource(source: McpSourceId): boolean {
  return source.startsWith('session:');
}

/** The fixed source id for `settings.mcp.serverCommand`. */
export const SERVER_COMMAND_MCP_SOURCE_ID: McpSourceId = 'server-command';

/** The fixed source id for SDK-hosted in-process servers. */
export const SDK_MCP_SOURCE_ID: McpSourceId = 'sdk';

/** The server name `settings.mcp.serverCommand` always registers under. */
export const SERVER_COMMAND_MCP_SERVER_NAME = 'mcp';

/**
 * Stable string form, for use as a `Map` key or dedup identity. A NUL separator
 * keeps a name that itself contains `:` from colliding with the source prefix.
 */
export function mcpServerKeyId(key: McpServerKey): string {
  return `${key.source}\u0000${key.name}`;
}

export function mcpServerKeysEqual(a: McpServerKey, b: McpServerKey): boolean {
  return a.source === b.source && a.name === b.name;
}

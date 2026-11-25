/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Listing MCP servers with their live status, one server's tools, and
 * reconnecting one server.
 *
 * Two kinds of servers are listed:
 * - user-level: config from the user settings file, read fresh on every call;
 *   status from the pool entry the startup prewarm and sessions share.
 *   Config is returned as written, secrets included, so the host can edit it
 *   without losing values (it runs as the same user and could read the file).
 * - plugin: servers in the pool that a plugin declares. They are read-only and
 *   expose no config: a plugin config may carry substituted user secrets.
 */

import {
  getErrorMessage,
  inferMcpTransportType,
  isMcpAppToolVisible,
  isRecord,
  MCPServerStatus,
  Storage,
  type DiscoveredMCPTool,
  type McpClient,
  type MCPServerConfig,
  type McpServerKey,
} from '@qwen-code/core';
import { userMcpServerKey } from '../../../mcp/framework.js';
import { defaultMcpAuthMethod, requireManager, type DaemonMcpContext } from './context.js';
import { DaemonMcpError } from './errors.js';
import { parseServerId, serverIdOf, userMcpServerId } from './serverIds.js';
import {
  configIssues,
  mcpConfigVersion,
  rawUserMcpServers,
  requireReadable,
} from './userSettings.js';

export type McpTransport = 'stdio' | 'sse' | 'http' | 'ws' | 'unknown';

/**
 * `oauth`: MCP OAuth run by this process; `brokered`: authorized through a
 * product gateway; `none`: nothing to authorize (local transports).
 */
export type McpAuthMethod = 'none' | 'oauth' | 'brokered';

export interface McpServerSummary {
  readonly serverId: string;
  /** The `mcpServers` key for user-level servers; the server name otherwise. */
  readonly configKey: string;
  readonly source: 'user' | 'plugin' | 'enterprise';
  /** Plugin that declares the server; plugin servers only. */
  readonly pluginId?: string;
  readonly pluginName?: string;
  readonly displayName?: string;
  readonly originalName?: string;
  readonly canDisable?: boolean;
  /** Only user-level entries can be changed through the write methods. */
  readonly writable: boolean;
  readonly transport: McpTransport;
  readonly authMethod: McpAuthMethod;
  /** User-level: the entry as written. Plugin: always empty. */
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly status: MCPServerStatus | 'unknown';
  /** Last connection error while not connected. */
  readonly error?: string;
  readonly hasCredentials: boolean;
}

/**
 * A user-level entry that does not load. A host can open `config` in its form,
 * show `issues`, and fix it in place by `configKey`.
 */
export interface McpInvalidEntry {
  readonly configKey: string;
  readonly message: string;
  /** The entry as written; absent when it is not an object. */
  readonly config?: Record<string, unknown>;
  readonly issues: readonly string[];
}

export interface McpServerList {
  readonly configPath: string;
  readonly configVersion: string;
  /** User-level servers in settings order, then plugin servers by id. */
  readonly servers: readonly McpServerSummary[];
  readonly invalidEntries: readonly McpInvalidEntry[];
}

export interface McpServerTools {
  readonly serverId: string;
  readonly tools: readonly DiscoveredMCPTool[];
}

export interface McpServerInfo {
  readonly serverId: string;
  readonly info: {
    readonly source: 'initialize' | 'discover';
    readonly capabilities: Record<string, unknown>;
    readonly raw: Record<string, unknown>;
  } | null;
}

/** Host-facing tool call on one pooled server, without a Session. */
export interface McpServerToolCall {
  readonly serverId: string;
  readonly result: Record<string, unknown>;
}

/** Host-facing resource catalog/read result on one pooled server. */
export interface McpServerResourceResult {
  readonly serverId: string;
  readonly result: Record<string, unknown>;
}

/**
 * A server addressed by `serverId`. User-level servers must exist in settings
 * and be enabled; plugin servers must be in the pool.
 */
export interface ResolvedMcpServer {
  readonly key: McpServerKey;
  readonly name: string;
  readonly source: 'user' | 'plugin' | 'enterprise';
  assertCurrent?(): void;
  /** The config the connection uses (user: variables expanded). */
  readonly config: MCPServerConfig;
  /** False for a user server disabled in settings; a clear still applies. */
  readonly enabled: boolean;
  describe(): Promise<McpServerSummary>;
}

export async function listMcpServers(
  context: DaemonMcpContext,
): Promise<McpServerList> {
  const view = readUserServers(context);
  const userServers = await Promise.all(
    [...view.entries].map(([configKey, entry]) =>
      describeUserServer(context, configKey, entry),
    ),
  );
  const pluginServers = await Promise.all(
    pluginClients(context).map((client) =>
      describePluginServer(context, client),
    ),
  );
  pluginServers.sort((a, b) => a.serverId.localeCompare(b.serverId));
  return {
    configPath: Storage.getGlobalSettingsPath(),
    configVersion: view.configVersion,
    servers: [...userServers, ...pluginServers],
    invalidEntries: view.invalidEntries,
  };
}

export function getMcpServerTools(
  context: DaemonMcpContext,
  serverId: string,
  target = resolveServer(context, serverId),
): McpServerTools {
  const client = requireManager(context).getClient(target.key);
  const status = client?.getStatus() ?? MCPServerStatus.DISCONNECTED;
  if (!client || status !== MCPServerStatus.CONNECTED) {
    throw new DaemonMcpError(
      'NOT_CONNECTED',
      `MCP server "${target.name}" is not connected (status: ${status}).`,
    );
  }
  // A failed tools/list is not an empty catalog: say so instead of [].
  const discoveryError = client.getToolDiscoveryError();
  if (discoveryError) {
    throw new DaemonMcpError(
      'DISCOVERY_FAILED',
      `Failed to list tools of "${target.name}": ${getErrorMessage(discoveryError)}`,
    );
  }
  return { serverId, tools: client.getDiscoveredTools() };
}

/** Raw initialize result for one pooled server, or null while disconnected. */
export function getMcpServerInfo(
  context: DaemonMcpContext,
  serverId: string,
  target = resolveServer(context, serverId),
): McpServerInfo {
  const client = requireManager(context).getClient(target.key);
  const info =
    client?.isConnected() === true ? client.getServerInfo() : undefined;
  return {
    serverId,
    info: info
      ? {
          source: info.source,
          capabilities: info.capabilities as Record<string, unknown>,
          raw: info.raw,
        }
      : null,
  };
}

/**
 * Calls a discovered tool on a pooled server. Uses the same app-visibility
 * permission check as the session-facing `mcp_call_tool`.
 */
export async function callMcpServerTool(
  context: DaemonMcpContext,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpServerToolCall> {
  if (parseServerId(serverId)?.kind === 'enterprise')
    throw new DaemonMcpError(
      'UNSUPPORTED',
      'Use a session to execute enterprise MCP tools and resources.',
    );
  const target = resolveServer(context, serverId);
  const client = requireManager(context).getClient(target.key);
  if (!client || !client.isConnected()) {
    throw new DaemonMcpError(
      'NOT_CONNECTED',
      `MCP server "${target.name}" is not connected.`,
    );
  }
  const tool = client
    .getDiscoveredTools()
    .find(
      (candidate) =>
        candidate.serverToolName === toolName || candidate.name === toolName,
    );
  if (!tool) {
    throw new DaemonMcpError(
      'TOOL_NOT_FOUND',
      `Unknown tool "${toolName}" on MCP server "${target.name}".`,
    );
  }
  if (!isMcpAppToolVisible(tool, 'app')) {
    throw new DaemonMcpError(
      'TOOL_NOT_ALLOWED',
      `Tool "${toolName}" is not available to apps.`,
    );
  }
  const result = await client.callMcpTool({
    name: tool.serverToolName,
    arguments: args,
  });
  return { serverId, result: result as Record<string, unknown> };
}

/** One page of a pooled server's resource catalog, without a Session. */
export async function listMcpServerResources(
  context: DaemonMcpContext,
  serverId: string,
  cursor?: string,
): Promise<McpServerResourceResult> {
  if (parseServerId(serverId)?.kind === 'enterprise')
    throw new DaemonMcpError(
      'UNSUPPORTED',
      'Use a session to execute enterprise MCP tools and resources.',
    );
  const target = resolveServer(context, serverId);
  const client = requireManager(context).getClient(target.key);
  if (!client || !client.isConnected()) {
    throw new DaemonMcpError(
      'NOT_CONNECTED',
      `MCP server "${target.name}" is not connected.`,
    );
  }
  const result = await client.listResourcesPage(cursor);
  return { serverId, result: result as unknown as Record<string, unknown> };
}

/** Reads one resource from a pooled server, without a Session. */
export async function readMcpServerResource(
  context: DaemonMcpContext,
  serverId: string,
  uri: string,
): Promise<McpServerResourceResult> {
  if (parseServerId(serverId)?.kind === 'enterprise')
    throw new DaemonMcpError(
      'UNSUPPORTED',
      'Use a session to execute enterprise MCP tools and resources.',
    );
  const target = resolveServer(context, serverId);
  const client = requireManager(context).getClient(target.key);
  if (!client || !client.isConnected()) {
    throw new DaemonMcpError(
      'NOT_CONNECTED',
      `MCP server "${target.name}" is not connected.`,
    );
  }
  const result = await client.readResource(uri);
  return { serverId, result: result as unknown as Record<string, unknown> };
}

/**
 * A fresh connection for one pooled server. Never starts an interactive
 * authorization; a server that needs one stays in `auth_required`.
 */
export async function reconnectMcpServer(
  context: DaemonMcpContext,
  serverId: string,
): Promise<McpServerSummary> {
  const target = resolveServer(context, serverId);
  const manager = requireManager(context);
  if (!manager.getClient(target.key)) {
    throw new DaemonMcpError(
      'NOT_CONNECTED',
      `MCP server "${target.name}" has no connection to restart yet.`,
    );
  }
  await manager.reconnect(target.key, false);
  return target.describe();
}

export function resolveServer(
  context: DaemonMcpContext,
  serverId: string,
  options: { readonly allowDisabled?: boolean } = {},
): ResolvedMcpServer {
  const parsed = parseServerId(serverId);
  if (parsed?.kind === 'enterprise') {
    if (context.resolveEnterprise)
      return context.resolveEnterprise(serverId, options.allowDisabled);
    throw new DaemonMcpError(
      'UNSUPPORTED',
      'Enterprise MCP runtime is unavailable.',
    );
  }
  if (parsed?.kind === 'plugin') {
    const client = pluginClients(context).find(
      (candidate) => serverIdOfClient(candidate) === serverId,
    );
    if (!client) {
      throw new DaemonMcpError(
        'NOT_FOUND',
        `Unknown MCP server "${serverId}" (plugin servers are listed while they are in the pool).`,
      );
    }
    return {
      key: client.getServerKey(),
      name: client.getServerName(),
      source: 'plugin',
      config: client.getServerConfig(),
      enabled: true,
      describe: () => describePluginServer(context, client),
    };
  }
  const entry =
    parsed?.kind === 'user'
      ? readUserServers(context).entries.get(parsed.configKey)
      : undefined;
  if (!parsed || !entry) {
    throw new DaemonMcpError('NOT_FOUND', `Unknown MCP server "${serverId}".`);
  }
  const { configKey } = parsed;
  const enabled = isEnabled(entry);
  if (!enabled && !options.allowDisabled) {
    throw new DaemonMcpError(
      'DISABLED',
      `MCP server "${configKey}" is disabled.`,
    );
  }
  return {
    key: entry.key,
    name: configKey,
    source: 'user',
    config: entry.resolved,
    enabled,
    describe: () => describeUserServer(context, configKey, entry),
  };
}

/** One user-level server, described as in the list; enabled or not. */
export async function describeUserMcpServer(
  context: DaemonMcpContext,
  configKey: string,
): Promise<McpServerSummary> {
  const entry = readUserServers(context).entries.get(configKey);
  if (!entry) {
    throw new DaemonMcpError(
      'NOT_FOUND',
      `Unknown MCP server "${userMcpServerId(configKey)}".`,
    );
  }
  return describeUserServer(context, configKey, entry);
}

// ── internals ──────────────────────────────────────────────────────────────

interface UserServerEntry {
  readonly key: McpServerKey;
  /** The entry as written, for display. */
  readonly raw: Record<string, unknown>;
  /** The entry with variables expanded, for transport and auth inference. */
  readonly resolved: MCPServerConfig;
}

function readUserServers(context: DaemonMcpContext): {
  readonly configVersion: string;
  readonly entries: ReadonlyMap<string, UserServerEntry>;
  readonly invalidEntries: readonly McpInvalidEntry[];
} {
  const settings = requireReadable(context.readUserSettings());
  const rawServers = rawUserMcpServers(settings);
  const resolvedServers: Record<string, unknown> =
    settings.user.settings.mcpServers ?? {};
  const entries = new Map<string, UserServerEntry>();
  const invalidEntries: McpInvalidEntry[] = [];
  for (const [configKey, raw] of Object.entries(rawServers)) {
    const resolved = resolvedServers[configKey];
    if (isRecord(raw) && isRecord(resolved)) {
      entries.set(configKey, {
        key: userMcpServerKey(configKey),
        raw,
        resolved: resolved as MCPServerConfig,
      });
      continue;
    }
    // The settings loader dropped it.
    const issues = configIssues(configKey, raw);
    invalidEntries.push({
      configKey,
      message: 'Invalid MCP server configuration; it is not loaded.',
      ...(isRecord(raw) ? { config: structuredClone(raw) } : {}),
      issues:
        issues.length > 0
          ? issues
          : ['The entry could not be loaded from settings.'],
    });
  }
  return {
    configVersion: mcpConfigVersion(rawServers),
    entries,
    invalidEntries,
  };
}

function isEnabled(entry: UserServerEntry): boolean {
  return entry.raw['disabled'] !== true;
}

async function describeUserServer(
  context: DaemonMcpContext,
  configKey: string,
  entry: UserServerEntry,
): Promise<McpServerSummary> {
  const enabled = isEnabled(entry);
  const client = enabled
    ? context.getMcpManager()?.getClient(entry.key)
    : undefined;
  const status = !enabled
    ? MCPServerStatus.DISABLED
    : (client?.getStatus() ?? MCPServerStatus.DISCONNECTED);
  return {
    serverId: userMcpServerId(configKey),
    configKey,
    source: 'user',
    writable: true,
    transport: transportOf(entry.resolved),
    authMethod:
      context.authMethodOf?.(entry.resolved) ??
      defaultMcpAuthMethod(entry.resolved),
    config: structuredClone(entry.raw),
    enabled,
    status,
    ...connectError(client, status),
    hasCredentials: await context.hasCredentials(configKey, entry.resolved),
  };
}

async function describePluginServer(
  context: DaemonMcpContext,
  client: McpClient,
): Promise<McpServerSummary> {
  const name = client.getServerName();
  const config = client.getServerConfig();
  const pluginId = config.plugin?.id ?? '';
  const status = client.getStatus();
  return {
    serverId: serverIdOfClient(client),
    configKey: name,
    source: 'plugin',
    pluginId,
    ...(config.plugin?.name ? { pluginName: config.plugin.name } : {}),
    writable: false,
    transport: transportOf(config),
    authMethod:
      context.authMethodOf?.(config) ?? defaultMcpAuthMethod(config),
    config: {},
    enabled: true,
    status,
    ...connectError(client, status),
    hasCredentials: await context.hasCredentials(name, config),
  };
}

function connectError(
  client: McpClient | undefined,
  status: MCPServerStatus,
): { error?: string } {
  if (!client || status === MCPServerStatus.CONNECTED) return {};
  const error = client.getLastConnectError();
  if (error === undefined || error === null) return {};
  return { error: getErrorMessage(error) };
}

/**
 * The pool connections of the daemon's own user-level plugin servers. Plugin
 * servers that only some session loaded (a project install, other config)
 * are not the daemon's to list or act on.
 */
function pluginClients(context: DaemonMcpContext): McpClient[] {
  const manager = context.getMcpManager();
  return context.userRegistrations().flatMap((registration) => {
    if (!registration.config.plugin) return [];
    const client = manager?.getClient(registration.key);
    return client ? [client] : [];
  });
}

function serverIdOfClient(client: McpClient): string {
  return serverIdOf({
    key: client.getServerKey(),
    config: client.getServerConfig(),
  });
}

function transportOf(config: MCPServerConfig): McpTransport {
  switch (inferMcpTransportType(config)) {
    case 'stdio':
      return 'stdio';
    case 'sse':
      return 'sse';
    case 'streamable_http':
      return 'http';
    case 'websocket':
      return 'ws';
    default:
      return 'unknown';
  }
}

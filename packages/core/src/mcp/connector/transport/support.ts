/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Transport plumbing shared by every MCP connector: header expansion and
// sanitization, the per-method fetch timeout policy, the model-aware fetch
// wrapper, and the plugin environment injection.
//
// Split out of mcp-client.ts so the connector implementations can use it
// without importing the client — which would be a cycle, since the client
// dispatches to the connectors.

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ENV_PLUGIN_ROOT, ENV_PLUGIN_DATA } from '../../../config/brand.js';
import {
  resolveMcpRequestTimeoutMs,
  resolveMcpToolHardTimeoutMs,
} from '../../tools/mcp-timeouts.js';
import { proxiedFetch, withFetchTimeouts } from '../../../utils/fetch.js';
import { runLogger } from '../../../utils/runLogger.js';
import { expandMcpEnvVars } from '../../mcpEnvExpansion.js';
import type { EnvironmentSanitizationConfig } from '../../../services/environmentSanitization.js';
import { getPluginDataDir } from '../../../plugins/pluginDirectories.js';
import type {
  McpPluginOwner,
  MCPServerConfig,
} from '../../mcpServerConfig.js';

/** Default MCP request timeout. Lives here so the fetch wrapper can use it. */
export const MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000; // default to 10 minutes

/**
 * Create RequestInit for TransportOptions.
 *
 * @param mcpServerConfig The MCP server configuration
 * @param headers Additional headers
 * @param sanitizationConfig Configuration for environment sanitization
 */
export function createTransportRequestInit(
  mcpServerConfig: MCPServerConfig,
  headers: Record<string, string>,
  _sanitizationConfig?: EnvironmentSanitizationConfig,
): RequestInit {
  const pluginEnv = getPluginEnvironment(mcpServerConfig.plugin);
  const expansionEnv = { ...process.env, ...pluginEnv };

  const expandedHeaders: Record<string, string> = {};
  if (mcpServerConfig.headers) {
    for (const [key, value] of Object.entries(mcpServerConfig.headers)) {
      expandedHeaders[key] = expandMcpEnvVars(value, expansionEnv);
    }
  }

  // Connection-level headers (user config + helper) are the only caller-owned
  // surface. Strip host-reserved names here so a forged value can never reach
  // the wire; the product fetch decorator writes the legitimate value per call,
  // after this point.
  const mergedHeaders = { ...expandedHeaders, ...headers };
  stripReservedHeaders(mergedHeaders);
  return { headers: mergedHeaders };
}

export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '').trim();
}

const additionalReservedHeaders = new Set<string>();

/**
 * Declares a header name the host injects itself. Core strips it from
 * connection-level headers unconditionally, so a product decorator only has to
 * write the legitimate value per call; user-supplied MCP config can never forge
 * it even when the decorator is skipped. Names are case-insensitive and
 * duplicate registration is a no-op. Call before creating transports.
 */
export function registerReservedMcpHeader(name: string): () => void {
  const normalized = name.toLowerCase();
  additionalReservedHeaders.add(normalized);
  return () => {
    additionalReservedHeaders.delete(normalized);
  };
}

function stripReservedHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (additionalReservedHeaders.has(key.toLowerCase())) delete headers[key];
  }
}

export function getMcpJsonRpcMethods(body: BodyInit | null | undefined): string[] {
  if (typeof body !== 'string') return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages
      .map((message) =>
        typeof message === 'object' && message !== null
          ? (message as { method?: unknown }).method
          : undefined,
      )
      .filter((method): method is string => typeof method === 'string');
  } catch {
    return [];
  }
}

const MCP_SHORT_FETCH_TIMEOUT_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
]);

export function getMcpFetchTimeoutMs(
  mcpServerConfig: MCPServerConfig | undefined,
  init: RequestInit | undefined,
): number {
  const methods = getMcpJsonRpcMethods(init?.body);
  if (methods.includes('tools/call')) {
    return resolveMcpToolHardTimeoutMs(mcpServerConfig);
  }
  if (
    methods.length > 0 &&
    methods.every((method) => MCP_SHORT_FETCH_TIMEOUT_METHODS.has(method))
  ) {
    return resolveMcpRequestTimeoutMs();
  }

  // GET SSE streams and OAuth helper fetches do not carry a JSON-RPC body.
  // Keep them on the historical MCP budget. User-triggered MCP requests such
  // as prompts/get and resources/read also land here so discovery stays short
  // without imposing a 30-second transport cap on normal work.
  return MCP_DEFAULT_TIMEOUT_MSEC;
}

/** @internal test-only */
export const _getMcpFetchTimeoutMsForTesting = getMcpFetchTimeoutMs;


export function withMcpFetchTimeouts(
  init: RequestInit | undefined,
  timeoutMs: number,
): RequestInit {
  return withFetchTimeouts(init, {
    requestTimeoutMs: timeoutMs,
    bodyIdleTimeoutMs: timeoutMs,
  });
}

export function createMcpTransportFetch(mcpServerConfig: MCPServerConfig): FetchLike {
  const base: FetchLike = (url, init) =>
    modelAwareFetchWithTimeout(
      url,
      init,
      getMcpFetchTimeoutMs(mcpServerConfig, init),
    );
  return mcpFetchDecorators.reduce((fetch, decorate) => {
    try {
      return decorate(fetch);
    } catch (error) {
      runLogger.warn(
        'MCP transport fetch decorator failed; continuing without it',
        error,
      );
      return fetch;
    }
  }, base);
}

export type McpTransportFetchDecorator = (fetch: FetchLike) => FetchLike;

const mcpFetchDecorators: McpTransportFetchDecorator[] = [];

/**
 * Host extension point: wrap the fetch used by every MCP transport, including
 * the ones built for OAuth retries and SSE fallback. Core keeps no knowledge of
 * what a decorator adds. Registration is read when a transport fetch is built,
 * so it must happen before any transport is created. Returns a disposer;
 * registering the same decorator twice is a no-op so repeated product wiring
 * cannot stack duplicates.
 */
export function registerMcpTransportFetchDecorator(
  decorator: McpTransportFetchDecorator,
): () => void {
  if (!mcpFetchDecorators.includes(decorator)) {
    mcpFetchDecorators.push(decorator);
  }
  return () => {
    const index = mcpFetchDecorators.indexOf(decorator);
    if (index >= 0) mcpFetchDecorators.splice(index, 1);
  };
}

export function modelAwareFetchWithTimeout(
  url: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  return proxiedFetch(url, withMcpFetchTimeouts(init, timeoutMs));
}

/** @internal test-only — exposed so unit tests can drive header injection directly. */
export const modelAwareFetch: FetchLike = (url, init) =>
  modelAwareFetchWithTimeout(url, init, MCP_DEFAULT_TIMEOUT_MSEC);

export function getPluginEnvironment(plugin?: McpPluginOwner): Record<string, string> {
  const env: Record<string, string> = {};
  if (plugin) {
    // Inject branded plugin path names and the upstream-compatible aliases.
    env[ENV_PLUGIN_ROOT] = plugin.path;
    env['CLAUDE_PLUGIN_ROOT'] = plugin.path;
    if (plugin.id) {
      const dataDir = getPluginDataDir(plugin.id);
      env[ENV_PLUGIN_DATA] = dataDir;
      env['CLAUDE_PLUGIN_DATA'] = dataDir;
    }
  }
  return env;
}

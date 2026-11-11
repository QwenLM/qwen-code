/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthProviderType } from '@qwen-code/resource';

// MCP server config value types live in this leaf module so tools, agents and
// the MCP client can construct them without importing config.ts, which pulls
// in most of the package. config.ts re-exports everything here.

import type { MCPOAuthConfig } from '../mcp/connector/oauth/provider.js';

/** Runtime ownership metadata attached to MCP servers loaded from a plugin. */
export interface McpPluginOwner {
  name: string;
  path: string;
  id: string;
  mcpServers?: Record<string, MCPServerConfig>;
}

/**
 * Origin of an MCP server config. Runtime-only metadata — never persisted
 * to disk. See docs/design/mcp-source-model.md.
 *
 * - 'user' / 'local' / 'project' / 'flag' : disk source (governed by trust
 *   gate, project approval, enterprise allowlist, disabled field)
 * - 'dynamic' : runtime injection from ACP session/new or mcp_set_servers
 *   control command (exempt from trust gate; only enterprise allowlist applies)
 */
export type McpServerScope = 'user' | 'local' | 'project' | 'flag' | 'dynamic';

export interface McpToolRuntimeOverride {
  exposedName?: string;
  alwaysLoad?: boolean;
}

export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    // Transport type (optional, for use with 'url' field)
    // When set to 'http', uses StreamableHTTPClientTransport
    // When set to 'sse', uses SSEClientTransport
    // When set to 'ws', uses WebSocketClientTransport
    // When set to 'sdk', the server runs in the SDK process and is bridged
    //   over the structured-IO control protocol (no command/url required).
    // When omitted, auto-detects transport type
    // Note: 'httpUrl' is deprecated in favor of 'url' + 'type'
    readonly type?: 'sse' | 'http' | 'ws' | 'sdk',
    // Common
    readonly timeout?: number,
    readonly trust?: boolean,
    // Metadata
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly plugin?: McpPluginOwner,
    // OAuth configuration
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
    // Dynamic headers helper script
    readonly headersHelper?: string,
    readonly disabled?: boolean,
    readonly alwaysAllow?: string[],
    // Source tag — runtime-only; stripped before persistence. See
    // docs/design/mcp-source-model.md for the per-scope governance matrix.
    readonly scope?: McpServerScope,
    // Per-tool model-surface overrides keyed by the raw name from tools/list.
    readonly toolOverrides?: Record<string, McpToolRuntimeOverride>,
    // Keep this server's tools out of model declarations; reach them through
    // CodeMode discovery or the MCP meta tools.
    readonly deferred?: boolean,
  ) {}
}

/**
 * Narrow mutable interface exposing the MCPServerConfig fields that are subject
 * to `${user_config.*}` substitution. Used by the plugin-config substitution
 * layer so that upstream field additions to MCPServerConfig produce compile
 * errors rather than silently being missed.
 */
export interface MCPServerConfigFields {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
}

/**
 * Build a virtual MCPServerConfig for an in-process MCP server hosted by the
 * SDK. The CLI never spawns or dials this server; instead, every JSON-RPC
 * request is ferried back to the SDK over the control protocol
 * (`control_request{subtype:'mcp_message'}`). See
 * {@link ../mcp/sdk-control-client-transport.ts} for the bridge.
 */
export function createSdkMcpServerConfig(
  toolOverrides?: Record<string, McpToolRuntimeOverride>,
): MCPServerConfig {
  return new MCPServerConfig(
    /* command */ undefined,
    /* args */ undefined,
    /* env */ undefined,
    /* cwd */ undefined,
    /* url */ undefined,
    /* httpUrl */ undefined,
    /* headers */ undefined,
    /* tcp */ undefined,
    /* type */ 'sdk',
    /* timeout */ undefined,
    /* trust */ undefined,
    /* description */ undefined,
    /* includeTools */ undefined,
    /* excludeTools */ undefined,
    /* plugin */ undefined,
    /* oauth */ undefined,
    /* authProviderType */ undefined,
    /* headersHelper */ undefined,
    /* disabled */ undefined,
    /* alwaysAllow */ undefined,
    /* scope */ undefined,
    /* toolOverrides */ toolOverrides,
  );
}

export { AuthProviderType } from '@qwen-code/resource';

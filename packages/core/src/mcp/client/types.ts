/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Public surface of the session-agnostic MCP connection. Kept apart from the
// class so an owner (the global manager, a session) can depend on the shapes
// without importing the implementation.

import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { DiscoveredMCPPrompt } from '../tools/mcp-prompt.js';
import type { McpClientContext } from '../mcpClientContext.js';
import type { McpElicitationHandler } from '../elicitation.js';
import type { MCPServerStatus } from './mcpClient.js';
import type { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { McpServerKey } from '../server-key.js';
import type { McpClient } from './mcpClient.js';

/**
 * Outward notifications from one pooled connection. The owner reacts to these;
 * the client itself never writes to a registry, gates a server, or touches a
 * session. Status changes and catalog changes both flow through here, so a
 * session sees a server's tools appear, change, or its connection drop without
 * polling.
 */
export type McpClientEvent =
  | {
      readonly type: 'status';
      readonly status: MCPServerStatus;
      readonly reason?: string;
    }
  | { readonly type: 'tools'; readonly tools: readonly DiscoveredMCPTool[] }
  | {
      readonly type: 'prompts';
      readonly prompts: readonly DiscoveredMCPPrompt[];
    }
  | { readonly type: 'resources'; readonly resources: readonly Resource[] };

export type McpClientListener = (
  event: McpClientEvent,
) => void | Promise<void>;

/**
 * Contributes `_meta` to each outgoing tool call on this connection. Awaited, so
 * a provider can also hold the call until its own state is settled. Process-level
 * concerns (e.g. a shared credential identity) attach here rather than per session.
 */
export type McpClientCallMetadataProvider = (
  client: McpClient,
) =>
  | Promise<Record<string, unknown> | undefined>
  | Record<string, unknown>
  | undefined;

/** Per-connect options. */
export interface McpClientConnectRequest {
  readonly signal?: AbortSignal;
  /**
   * Whether this attempt may run an interactive OAuth flow. Prewarm passes
   * false; session registrations pass true.
   */
  readonly allowAuthentication?: boolean;
}

/** Everything a pooled, session-agnostic connection needs at construction. */
export interface McpClientInit {
  readonly serverKey: McpServerKey;
  readonly serverName: string;
  readonly serverConfig: MCPServerConfig;
  readonly clientVersion: string;
  readonly debugMode: boolean;
  /**
   * Session-agnostic host capabilities: diagnostics, sanitization and trust.
   * Deliberately carries no elicitation bridge and no session id — a pooled
   * connection is shared across sessions, so session-specific behaviour (roots
   * beyond the project path, elicitation, per-session gating) belongs to the
   * owner, not here.
   */
  readonly hostContext: McpClientContext;
  readonly listener: McpClientListener;
  /** Contributes `_meta` to each outgoing tool call. */
  readonly callMetadataProvider?: McpClientCallMetadataProvider;
  /**
   * Per-session elicitation wiring. Only session-owned servers receive one;
   * plugin and disk-configured servers must not.
   */
  readonly elicitationHandler?: McpElicitationHandler;
}

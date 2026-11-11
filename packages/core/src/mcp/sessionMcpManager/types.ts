/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-session view over the process-global MCP connection pool.
//
// The global McpManager owns connections (shared across sessions). A session
// still needs its own view: which servers it may use (all sources merged, then
// gate + enable/disable applied), their tools/prompts/resources published into
// THIS session's registries, lazy vs eager tool exposure, and status. That view
// is the SessionMcpManager. It registers the session's active servers with the
// pool, subscribes to pool changes for its own keys, and republishes catalogs
// into the session registries — it never owns a connection itself.

import type { EventEmitter } from 'node:events';
import type { CodeModeExposure } from '../../codemode/settings.js';

export type McpRegistrationMode = 'lazy' | 'eager' | 'deferred';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { McpAuthTool } from '../../tools/mcp-auth-tool.js';
import type { McpAuthorizationCoordinator } from '../authorization.js';
import type { McpElicitationHost } from '../elicitation.js';

/**
 * Enum representing the overall MCP discovery state for one session.
 */
export enum MCPDiscoveryState {
  /** Discovery has not started yet */
  NOT_STARTED = 'not_started',
  /** Discovery is currently in progress */
  IN_PROGRESS = 'in_progress',
  /** Discovery has completed (with or without errors) */
  COMPLETED = 'completed',
}

/**
 * The session surface a SessionMcpManager drives. `Config` implements it: the
 * manager reads the session's merged servers, lists, lazy mode, cwd and
 * registries, and calls back through `mcpToolListChange` when the session's tool
 * set changes so Config can refresh the tool registry snapshot and permission
 * checkers.
 */
export interface McpSessionManagerCreateOptions {
  /** Session working directory; defaults to `McpSessionContext.getTargetDir()`. */
  readonly cwd?: string;
  /** Initial lazy MCP mode; owned by the session manager afterwards. */
  readonly lazyMode?: boolean;
  /** Disk MCP config files visible to this session, for source identity/roots. */
  readonly mcpConfigPaths?: readonly string[];
  readonly eventEmitter?: EventEmitter;
  /**
   * Host-brokered authorization coordinator for this session. Product managers
   * inject their implementation; core sessions without it only support OAuth.
   */
  readonly createAuthorizationCoordinator?: () => McpAuthorizationCoordinator;
  /**
   * Session-level elicitation service. Only session-owned registrations
   * (dynamic and SDK-injected servers) receive a handler backed by it.
   */
  readonly elicitationHost?: McpElicitationHost;
}

export interface McpSessionContext {
  getSessionId(): string;
  getCodeModeExposure?(): CodeModeExposure | undefined;
  getSetting?(key: 'codeMode'): unknown;
  getMcpServers(): Record<string, MCPServerConfig> | undefined;
  getAllowedMcpServers(): readonly string[] | undefined;
  getBlockedMcpServers(): readonly string[] | undefined;
  getTargetDir(): string;
  isTrustedFolder(): boolean;
  getToolRegistry(): ToolRegistry;
  /** Whether the user has disabled a server this session (toggle / persisted). */
  isServerEnabled?(name: string): boolean;
  /** Whether this session can drive an interactive (browser) auth flow. */
  isInteractive?(): boolean;
  /** Registers the lazy `mcp_list`/`mcp_get`/`mcp_call` meta-tools. */
  registerLazyMetaTools?(registry: ToolRegistry): void;
  /** Called when the session's MCP tool set changed. */
  mcpToolListChange(): void | Promise<void>;
}

/** One MCP tool's metadata for the lazy-mode aggregator and `mcp_call` dispatch. */
export interface LazyMcpToolEntry {
  readonly qualifiedName: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly tool: DiscoveredMCPTool | McpAuthTool;
  readonly alwaysLoad: boolean;
  /**
   * Where the entry came from: a pooled server connection ('client', including
   * SDK-hosted) or a locally-minted OAuth 'authenticate' pseudo-tool ('auth').
   */
  readonly source: 'client' | 'sdk' | 'auth';
}

/** Counts only, for startup wait diagnostics. */
export interface SessionMcpStartupSnapshot {
  readonly active: number;
  readonly pending: number;
  readonly tools: number;
}

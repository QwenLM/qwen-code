/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for the DaemonWorkspaceService layer.
 *
 * The facade exposes workspace-scoped status queries plus the
 * tool-toggle / init / MCP-restart mutations. Each method takes a
 * `WorkspaceRequestContext` as its first parameter so audit,
 * client-identity, and route metadata flow naturally without threading
 * individual fields.
 */

import type {
  ServeWorkspaceMcpStatus,
  ServeWorkspaceSkillsStatus,
  ServeWorkspaceProvidersStatus,
  ServeWorkspaceHooksStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspacePreflightStatus,
  DaemonStatusProvider,
} from '@qwen-code/acp-bridge';

// ---------------------------------------------------------------------------
// WorkspaceRequestContext
// ---------------------------------------------------------------------------

/**
 * Per-request context threaded to all facade methods. Carries optional
 * fields the workspace layer needs for audit correlation and
 * client-identity gating.
 *
 * `originatorClientId` is optional because status reads work without a
 * registered client (e.g. stateless GET routes that don't carry the
 * header). `sessionId` is optional for audit correlation on
 * workspace-scoped routes that have no session context.
 */
export interface WorkspaceRequestContext {
  /** Daemon-stamped client identity (from X-Qwen-Client-Id header). */
  originatorClientId?: string;
  /** ACP session id for cross-correlating audit + session events. */
  sessionId?: string;
  /** Route name like 'GET /workspace/mcp' for audit. */
  route: string;
  /** Absolute path to the workspace root — trust boundary. */
  workspaceCwd: string;
}

// ---------------------------------------------------------------------------
// DaemonWorkspaceService (facade)
// ---------------------------------------------------------------------------

/**
 * Callback shape for querying workspace status from the ACP child.
 * Used by the facade to delegate child-dependent status queries
 * without taking a direct reference to the bridge (avoiding circular
 * dependency).
 */
export type QueryWorkspaceStatusFn = <T>(
  method: string,
  idle: () => T,
) => Promise<T>;

/**
 * Callback shape for invoking workspace-level mutation commands
 * through the ACP child. Analogous to `QueryWorkspaceStatusFn` but
 * for state-changing operations (e.g. restart MCP server, toggle tool).
 */
export type InvokeWorkspaceCommandFn = <T>(
  method: string,
  params?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<T>;

/**
 * The unified facade for workspace-scoped daemon operations. Routes
 * delegate here instead of reaching into the bridge for workspace
 * concerns.
 */
export interface DaemonWorkspaceService {
  // -- Workspace status (delegated to ACP child via callbacks) --

  /** MCP server status for the bound workspace. */
  getWorkspaceMcpStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspaceMcpStatus>;

  /** Skill status for the bound workspace. */
  getWorkspaceSkillsStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspaceSkillsStatus>;

  /** Model-provider status for the bound workspace. */
  getWorkspaceProvidersStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspaceProvidersStatus>;

  /** Environment snapshot for the bound workspace. */
  getWorkspaceEnvStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspaceEnvStatus>;

  /** Preflight diagnostics for the bound workspace. */
  getWorkspacePreflightStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspacePreflightStatus>;

  /** Hook configuration status for the bound workspace. */
  getWorkspaceHooksStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspaceHooksStatus>;

  // -- Workspace mutations --

  /** Toggle a tool enabled/disabled in workspace settings. */
  setWorkspaceToolEnabled(
    ctx: WorkspaceRequestContext,
    toolName: string,
    enabled: boolean,
  ): Promise<{ toolName: string; enabled: boolean }>;

  /** Scaffold (init) a QWEN.md file in the workspace. */
  initWorkspace(
    ctx: WorkspaceRequestContext,
    opts: { force?: boolean },
  ): Promise<{ path: string; action: 'created' | 'overwrote' | 'noop' }>;

  /** Restart a configured MCP server. */
  restartMcpServer(
    ctx: WorkspaceRequestContext,
    serverName: string,
    opts?: { entryIndex?: number },
  ): Promise<RestartMcpServerResult>;
}

// -- Result types for workspace mutations --

/** Discriminated union for MCP server restart outcomes. */
export type RestartMcpServerResult =
  | { serverName: string; restarted: true; durationMs: number }
  | {
      serverName: string;
      restarted: false;
      skipped: true;
      reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
    }
  | {
      serverName: string;
      entries: Array<{
        entryIndex: number;
        restarted: boolean;
        durationMs?: number;
        reason?: string;
      }>;
    };

// ---------------------------------------------------------------------------
// DaemonWorkspaceServiceDeps
// ---------------------------------------------------------------------------

/**
 * Construction-time dependencies for `DaemonWorkspaceService`.
 *
 * Uses callback functions for bridge interactions (not the bridge type
 * directly) to avoid circular dependencies between the workspace
 * service and the bridge.
 */
export interface DaemonWorkspaceServiceDeps {
  /** Canonical absolute path of the bound workspace. */
  boundWorkspace: string;

  /** Context filename (e.g. 'QWEN.md') from workspace settings. */
  contextFilename: string;

  /**
   * Daemon-host status provider for env + preflight cells.
   * When present, `getWorkspaceEnvStatus` returns daemon-local process state
   * without querying ACP. When absent, falls back to idle placeholders.
   */
  statusProvider?: DaemonStatusProvider;

  /**
   * Returns whether the ACP channel is currently live. Used by
   * `getWorkspaceEnvStatus` to populate the `acpChannelLive` field
   * without requiring an ACP round-trip.
   */
  isChannelLive?: () => boolean;

  /** Persist tool enable/disable to workspace settings file. */
  persistDisabledTools: (
    workspace: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;

  /**
   * Query workspace status from the ACP child. The bridge owns the
   * child lifecycle; this callback abstracts that dependency.
   */
  queryWorkspaceStatus: QueryWorkspaceStatusFn;

  /**
   * Invoke a workspace-level mutation command through the ACP child.
   * For commands like tool-toggle, MCP restart, init-workspace.
   */
  invokeWorkspaceCommand: InvokeWorkspaceCommandFn;

  /**
   * Publish a workspace-wide event to all sessions' SSE buses.
   * Used after mutations that affect all connected clients.
   */
  publishWorkspaceEvent: (event: {
    type: string;
    data: unknown;
    originatorClientId?: string;
  }) => void;
}

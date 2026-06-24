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
  ServeWorkspaceExtensionsStatus,
  ServeWorkspaceHooksStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspacePreflightStatus,
  DaemonStatusProvider,
} from '@qwen-code/acp-bridge';
import type { WorkspaceTrustStatus } from '../../config/trustedFolders.js';
import type {
  PermissionRuleType,
  PermissionSettingsScope,
  QwenPermissionSettings,
} from '../../config/permission-settings.js';
import type { SettingScope, EnvReloadResult } from '../../config/settings.js';
import type { WorkspaceVoiceStatus } from '../../services/voice-service.js';
import type { VoiceMode } from '../../services/voice-settings.js';
import type { WorkspaceProvidersStatusProvider } from '../workspace-providers-status.js';

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

export type RefreshExtensionsForAllSessionsFn = () => Promise<{
  refreshed: number;
  failed: number;
}>;

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

  /** Installed extension status for the bound workspace. */
  getWorkspaceExtensionsStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<ServeWorkspaceExtensionsStatus>;

  /** Trust status for the bound workspace. */
  getWorkspaceTrustStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<WorkspaceTrustStatus>;

  /** Permission settings for the bound workspace. */
  getWorkspacePermissionsStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<QwenPermissionSettings>;

  /** Voice settings and selectable transcription models for the workspace. */
  getWorkspaceVoiceStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<WorkspaceVoiceStatus>;

  // -- Workspace mutations --

  /** Request that the local operator change workspace trust. */
  requestWorkspaceTrustChange(
    ctx: WorkspaceRequestContext,
    request: WorkspaceTrustChangeRequest,
  ): Promise<WorkspaceTrustChangeResult>;

  /** Replace one permission rule list. */
  setWorkspacePermissionRules(
    ctx: WorkspaceRequestContext,
    request: WorkspacePermissionRulesUpdate,
  ): Promise<QwenPermissionSettings>;

  /** Persist workspace voice settings. */
  setWorkspaceVoiceSettings(
    ctx: WorkspaceRequestContext,
    request: WorkspaceVoiceSettingsUpdate,
  ): Promise<WorkspaceVoiceStatus>;

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

  /** Reload all settings (env + model + permissions + tools + memory). */
  reload(ctx: WorkspaceRequestContext): Promise<ReloadResponse>;

  /** Broadcast extension refresh to all active sessions (fire-and-forget). */
  refreshExtensionsForAllSessions(): Promise<{
    refreshed: number;
    failed: number;
  }>;
}

// -- Result types for workspace mutations --

export type { EnvReloadResult };

export interface ReloadResponse {
  env: EnvReloadResult;
  changedKeys: string[];
  sessionsRefreshed?: string[];
  sessionsSkipped?: string[];
  childReloaded: boolean;
  childError?: string;
}

export type WorkspaceTrustDesiredState = 'trusted' | 'untrusted';

export interface WorkspaceTrustChangeRequest {
  desiredState: WorkspaceTrustDesiredState;
  reason?: string;
}

export interface WorkspaceTrustChangeResult {
  accepted: boolean;
  desiredState: WorkspaceTrustDesiredState;
  requiresOperatorAction: true;
}

export interface WorkspacePermissionRulesUpdate {
  scope: PermissionSettingsScope;
  ruleType: PermissionRuleType;
  rules: string[];
}

export class WorkspacePermissionRulesSessionRequiredError extends Error {
  constructor() {
    super(
      'setWorkspacePermissionRules requires a live ACP session to update active permission rules',
    );
    this.name = 'WorkspacePermissionRulesSessionRequiredError';
  }
}

export interface WorkspaceVoiceSettingsUpdate {
  enabled?: boolean;
  mode?: VoiceMode;
  language?: string;
  voiceModel?: string;
}

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
   * Daemon-local provider catalog/default-model snapshot. When present,
   * `/workspace/providers` is answered from fresh workspace settings/env
   * instead of querying the ACP child.
   */
  workspaceProvidersStatusProvider?: WorkspaceProvidersStatusProvider;

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

  persistSetting?: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
  ) => Promise<void>;

  persistSettings?: (
    workspace: string,
    writes: Array<{ scope: SettingScope; key: string; value: unknown }>,
  ) => Promise<void>;

  /** Reload daemon-side process.env from .env / settings.env. */
  reloadDaemonEnv?: (workspace: string) => Promise<EnvReloadResult>;

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
   * Broadcast an extension refresh to every live session. This must not
   * delegate to `invokeWorkspaceCommand`, which targets only one live channel.
   */
  refreshExtensionsForAllSessions?: RefreshExtensionsForAllSessionsFn;

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

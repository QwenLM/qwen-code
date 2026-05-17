/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';

export const STATUS_SCHEMA_VERSION = 1 as const;

export const SERVE_STATUS_EXT_METHODS = {
  workspaceMcp: 'qwen/status/workspace/mcp',
  workspaceSkills: 'qwen/status/workspace/skills',
  workspaceProviders: 'qwen/status/workspace/providers',
  sessionContext: 'qwen/status/session/context',
  sessionSupportedCommands: 'qwen/status/session/supported_commands',
} as const;

export type ServeStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'not_started'
  | 'unknown';

export interface ServeStatusCell {
  kind: string;
  status: ServeStatus;
  error?: string;
  errorKind?: string;
  hint?: string;
}

export type ServeMcpDiscoveryState =
  | 'not_started'
  | 'in_progress'
  | 'completed';

export type ServeMcpServerRuntimeStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected';

export type ServeMcpTransport =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'websocket'
  | 'sdk'
  | 'unknown';

export interface ServeWorkspaceMcpServerStatus extends ServeStatusCell {
  kind: 'mcp_server';
  name: string;
  mcpStatus?: ServeMcpServerRuntimeStatus;
  transport: ServeMcpTransport;
  disabled: boolean;
  description?: string;
  extensionName?: string;
  /**
   * Why this server is not live, when known. Distinguishes
   * operator-disabled (`disabled: true` from `disabledMcpServers`
   * config) from PR 14 budget-refused (`status: 'error', errorKind:
   * 'budget_exhausted'`). Operators dashboarding the workspace
   * shouldn't have to cross-reference the `errors[]` or `budgets[]`
   * arrays to render a per-server row correctly.
   */
  disabledReason?: 'config' | 'budget';
}

/** Budget mode for the MCP client guardrails (issue #4175 PR 14). */
export type ServeMcpBudgetMode = 'enforce' | 'warn' | 'off';

/**
 * Workspace-level budget status cell. Surfaced as one entry in
 * `ServeWorkspaceMcpStatus.budgets[]`. The list shape (vs a single
 * `budget?` field) is forward-compat for Wave 5 PR 23, which will
 * add a `scope: 'pool'` cell alongside without a schema bump.
 *
 * Consumers MUST tolerate additional entries with unrecognized
 * `scope` values — drop them rather than failing.
 */
export interface ServeMcpBudgetStatusCell extends ServeStatusCell {
  kind: 'mcp_budget';
  /**
   * Identifies which accounting scope this cell describes.
   *
   * **PR 14 v1 emits `'session'`** because each ACP session creates
   * its own `Config`/`McpClientManager` via `acpAgent.newSessionConfig()`
   * — so the budget caps live MCP clients **per session**, not
   * per-workspace. The snapshot reflects the bootstrap session's
   * view; concurrent sessions each enforce their own copy of the
   * cap independently. See `qwen-serve-protocol.md` "PR 14 v1
   * scope: per-session" for the operator-facing rationale.
   *
   * Future PRs:
   *   - Wave 5 PR 23 (shared MCP pool) introduces a workspace-scoped
   *     manager and will emit `'workspace'` (or `'pool'`) cells.
   *   - The `string & {}` widening keeps IDE autocomplete + literal
   *     narrowing for known scopes while allowing unknown scopes
   *     through without a compile-time break — the protocol contract
   *     is "consumers MUST tolerate additional scope values, drop
   *     don't fail."
   */
  scope: 'session' | 'workspace' | (string & {});
  /** Live (CONNECTED) MCP client count at snapshot time. */
  liveCount: number;
  /** Configured cap (positive integer). Absent only when mode is `off`. */
  budget?: number;
  /** Active enforcement mode. `off` mode produces no cell — `budgets: []`. */
  mode: ServeMcpBudgetMode;
  /** Servers refused during the most recent discovery pass. */
  refusedCount: number;
}

export interface ServeWorkspaceMcpStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  discoveryState?: ServeMcpDiscoveryState;
  servers: ServeWorkspaceMcpServerStatus[];
  errors?: ServeStatusCell[];
  /** PR 14: live MCP client count (sum across all transports). */
  clientCount?: number;
  /** PR 14: configured budget. Absent when no cap was set. */
  clientBudget?: number;
  /** PR 14: active enforcement mode. Absent on pre-PR-14 daemons. */
  budgetMode?: ServeMcpBudgetMode;
  /**
   * PR 14: workspace-level status cells for budget enforcement. Always
   * an array (possibly empty) on post-PR-14 daemons; absent on older
   * daemons. PR 23 will add a `scope: 'pool'` cell alongside.
   */
  budgets?: ServeMcpBudgetStatusCell[];
}

export type ServeSkillLevel = 'project' | 'user' | 'extension' | 'bundled';

export interface ServeWorkspaceSkillStatus extends ServeStatusCell {
  kind: 'skill';
  name: string;
  description: string;
  level: ServeSkillLevel;
  modelInvocable: boolean;
  argumentHint?: string;
  model?: string;
  extensionName?: string;
}

export interface ServeWorkspaceSkillsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  skills: ServeWorkspaceSkillStatus[];
  errors?: ServeStatusCell[];
}

export interface ServeWorkspaceProviderCurrent {
  authType?: string;
  modelId?: string;
}

export interface ServeWorkspaceProviderModel {
  modelId: string;
  baseModelId: string;
  name: string;
  description?: string | null;
  contextLimit?: number;
  isCurrent: boolean;
  isRuntime: boolean;
}

export interface ServeWorkspaceProviderStatus extends ServeStatusCell {
  kind: 'model_provider';
  authType: string;
  current: boolean;
  models: ServeWorkspaceProviderModel[];
}

export interface ServeWorkspaceProvidersStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  current?: ServeWorkspaceProviderCurrent;
  providers: ServeWorkspaceProviderStatus[];
  errors?: ServeStatusCell[];
}

export interface ServeSessionContextStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspaceCwd: string;
  state: {
    models?: unknown;
    modes?: unknown;
    configOptions?: unknown[] | null;
    [key: string]: unknown;
  };
}

export interface ServeSessionSupportedCommandsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  availableCommands: AvailableCommand[];
  availableSkills: string[];
}

export function createIdleWorkspaceMcpStatus(
  workspaceCwd: string,
): ServeWorkspaceMcpStatus {
  // PR 14: an idle workspace has zero live clients and no enforcement
  // pressure. `budgetMode` is `'off'` (regardless of how the operator
  // configured it) because no discovery has run, so no reservation
  // could have happened. `budgets` is an empty array, not absent —
  // the daemon DOES support the surface, the snapshot just has
  // nothing to report yet. Older daemons omitting the array entirely
  // are still spec-compliant; consumers default-coalesce to `[]`.
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    discoveryState: 'not_started',
    servers: [],
    clientCount: 0,
    budgetMode: 'off',
    budgets: [],
  };
}

export function createIdleWorkspaceSkillsStatus(
  workspaceCwd: string,
): ServeWorkspaceSkillsStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    skills: [],
  };
}

export function createIdleWorkspaceProvidersStatus(
  workspaceCwd: string,
): ServeWorkspaceProvidersStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    providers: [],
  };
}

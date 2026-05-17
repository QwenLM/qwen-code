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
  workspaceMemory: 'qwen/status/workspace/memory',
  workspaceAgents: 'qwen/status/workspace/agents',
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
}

export interface ServeWorkspaceMcpStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  discoveryState?: ServeMcpDiscoveryState;
  servers: ServeWorkspaceMcpServerStatus[];
  errors?: ServeStatusCell[];
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

/**
 * Issue #4175 PR 16: workspace memory + agents read surfaces.
 *
 * Both shapes mirror the `kind / status / error? / errorKind? / hint?`
 * cell pattern that PR 12's mcp/skills/providers status structures use,
 * so the SDK reducer can render any of these with one pattern.
 */

export type ServeContextFileScope = 'workspace' | 'global';

export interface ServeWorkspaceMemoryFile {
  kind: 'memory_file';
  /** Absolute path to the discovered memory file. */
  path: string;
  /**
   * 'workspace' for files under the bound workspace tree, 'global' for
   * `~/.qwen/QWEN.md` style entries. Helps adapters render scope chips.
   */
  scope: ServeContextFileScope;
  /** Size in bytes of the file's serialized contents on disk. */
  bytes: number;
}

export interface ServeWorkspaceMemoryStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  files: ServeWorkspaceMemoryFile[];
  /** Total bytes across all hierarchical files (sum of `files[].bytes`). */
  totalBytes: number;
  /**
   * Number of merged QWEN.md / AGENTS.md files the loader pulled in.
   * Mirrors `LoadServerHierarchicalMemoryResponse.fileCount`.
   */
  fileCount: number;
  /** Baseline path-rule count from `.qwen/rules/`. */
  ruleCount: number;
  errors?: ServeStatusCell[];
}

/**
 * Storage level for a subagent definition surfaced through
 * `GET /workspace/agents` and the per-`agentType` detail route.
 *
 * `project` / `user` / `builtin` are the values the daemon actually
 * returns today. `extension` and `session` are forward-compat slots:
 * the daemon-scoped `SubagentManager` runs against a stub `Config`
 * whose `getActiveExtensions()` returns `[]`, and session-level
 * subagents live in a runtime-only cache no CRUD route reads.
 * Mirrors `DaemonAgentLevel` in `@qwen-code/sdk` so route + SDK
 * consumers see the same forward-compat union.
 */
export type ServeAgentLevel =
  | 'project'
  | 'user'
  | 'builtin'
  | 'extension'
  | 'session';

export interface ServeWorkspaceAgentSummary {
  kind: 'agent';
  name: string;
  description: string;
  level: ServeAgentLevel;
  isBuiltin: boolean;
  /** Whether this agent restricts the tool set via `tools:` frontmatter. */
  hasTools: boolean;
  model?: string;
  color?: string;
  background?: boolean;
  approvalMode?: string;
  extensionName?: string;
  /** Absolute path to the file backing this agent (or sentinel for built-ins). */
  filePath?: string;
}

export interface ServeWorkspaceAgentDetail extends ServeWorkspaceAgentSummary {
  systemPrompt: string;
  tools?: string[];
  disallowedTools?: string[];
  runConfig?: { max_time_minutes?: number; max_turns?: number };
}

export interface ServeWorkspaceAgentsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  agents: ServeWorkspaceAgentSummary[];
  errors?: ServeStatusCell[];
}

export function createIdleWorkspaceMemoryStatus(
  workspaceCwd: string,
): ServeWorkspaceMemoryStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    files: [],
    totalBytes: 0,
    fileCount: 0,
    ruleCount: 0,
  };
}

export function createIdleWorkspaceAgentsStatus(
  workspaceCwd: string,
): ServeWorkspaceAgentsStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    agents: [],
  };
}

export function createIdleWorkspaceMcpStatus(
  workspaceCwd: string,
): ServeWorkspaceMcpStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    discoveryState: 'not_started',
    servers: [],
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

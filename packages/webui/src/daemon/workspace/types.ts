/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type {
  DaemonAgentMutationResult,
  DaemonAuthProviderId,
  DaemonAuthStatusSnapshot,
  DaemonCapabilities,
  DaemonClient,
  DaemonCreateAgentRequest,
  DaemonDeviceFlowStartResult,
  DaemonDeviceFlowState,
  DaemonInitWorkspaceResult,
  DaemonMcpRestartResult,
  DaemonUpdateAgentRequest,
  DaemonWorkspaceAgentDetail,
  DaemonWorkspaceAgentsStatus,
  DaemonWorkspaceEnvStatus,
  DaemonWorkspaceFile,
  DaemonWorkspaceFileBytes,
  DaemonWorkspaceFileEditRequest,
  DaemonWorkspaceFileEditResult,
  DaemonWorkspaceFileWriteRequest,
  DaemonWorkspaceFileWriteResult,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMcpToolsStatus,
  DaemonWorkspaceMemoryStatus,
  DaemonWorkspacePreflightStatus,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceSkillsStatus,
  DaemonWorkspaceToolsStatus,
  DaemonSessionSummary,
  DaemonWriteMemoryRequest,
  DaemonWriteMemoryResult,
} from '@qwen-code/sdk/daemon';

// ── Resource Hook Types (shared by workspace hooks) ────────────────

export interface DaemonResourceOptions {
  autoLoad?: boolean;
  enabled?: boolean;
}

export interface ResourceState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
}

export interface ResourceResult<T> extends ResourceState<T> {
  reload: () => Promise<T | undefined>;
}

// ── Workspace Provider ──────────────────────────────────────────────

export interface DaemonWorkspaceProviderProps {
  baseUrl: string;
  token?: string;
  workspaceCwd?: string;
  autoConnect?: boolean;
  children: ReactNode;
}

export type DaemonWorkspaceStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export interface DaemonWorkspaceContextValue {
  client: DaemonClient;
  token?: string;
  baseUrl: string;
  workspaceCwd?: string;
  status: DaemonWorkspaceStatus;
  error?: Error;
  capabilities?: DaemonCapabilities;
  actions: DaemonWorkspaceActions;
}

// ── File System Types (server-only, no SDK coverage) ────────────────

export interface DaemonFileStat {
  kind: 'stat';
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes: number;
  modifiedMs: number;
}

export interface DaemonDirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  ignored: boolean;
}

export interface DaemonDirectoryListing {
  kind: 'list';
  path: string;
  entries: DaemonDirectoryEntry[];
  truncated: boolean;
}

// ── Workspace Actions ───────────────────────────────────────────────

export interface DaemonGlobOptions {
  maxResults?: number;
  includeIgnored?: boolean;
  cwd?: string;
}

export interface DaemonGlobResult {
  matches: string[];
}

export interface DaemonWorkspaceActions {
  // Sessions
  listSessions(): Promise<DaemonSessionSummary[]>;
  deleteSession(sessionId: string, clientId?: string): Promise<boolean>;
  deleteSessions(
    sessionIds: string[],
    clientId?: string,
  ): Promise<{
    removed: string[];
    notFound: string[];
    errors: Array<{ sessionId: string; error: string }>;
  }>;

  // MCP
  loadMcpStatus(): Promise<DaemonWorkspaceMcpStatus>;
  loadMcpTools(serverName: string): Promise<DaemonWorkspaceMcpToolsStatus>;
  restartMcpServer(serverName: string): Promise<DaemonMcpRestartResult>;

  // Skills (read-only)
  loadSkillsStatus(): Promise<DaemonWorkspaceSkillsStatus>;

  // Tools
  loadToolsStatus(): Promise<DaemonWorkspaceToolsStatus>;
  setWorkspaceToolEnabled(toolName: string, enabled: boolean): Promise<unknown>;

  // Memory
  loadMemoryStatus(): Promise<DaemonWorkspaceMemoryStatus>;
  readWorkspaceFile(filePath: string): Promise<DaemonWorkspaceFile>;
  writeMemory(req: DaemonWriteMemoryRequest): Promise<DaemonWriteMemoryResult>;

  // Agents (CRUD)
  listAgents(): Promise<DaemonWorkspaceAgentsStatus>;
  getAgent(agentType: string): Promise<DaemonWorkspaceAgentDetail>;
  createAgent(
    req: DaemonCreateAgentRequest,
  ): Promise<DaemonAgentMutationResult>;
  deleteAgent(agentType: string, scope?: 'workspace' | 'global'): Promise<void>;

  // Files
  globWorkspace(
    pattern: string,
    opts?: DaemonGlobOptions,
  ): Promise<DaemonGlobResult>;
  readFileBytes(
    filePath: string,
    opts?: { offset?: number; maxBytes?: number },
  ): Promise<DaemonWorkspaceFileBytes>;
  writeFile(
    req: DaemonWorkspaceFileWriteRequest,
  ): Promise<DaemonWorkspaceFileWriteResult>;
  editFile(
    req: DaemonWorkspaceFileEditRequest,
  ): Promise<DaemonWorkspaceFileEditResult>;
  stat(filePath: string): Promise<DaemonFileStat>;
  listDirectory(dirPath: string): Promise<DaemonDirectoryListing>;

  // Providers / env (read-only diagnostics)
  loadProviders(): Promise<DaemonWorkspaceProvidersStatus>;
  loadEnv(): Promise<DaemonWorkspaceEnvStatus>;
  loadPreflight(): Promise<DaemonWorkspacePreflightStatus>;

  // Workspace init
  initWorkspace(opts?: { force?: boolean }): Promise<DaemonInitWorkspaceResult>;

  // Agent update
  updateAgent(
    agentType: string,
    req: DaemonUpdateAgentRequest,
    scope?: 'workspace' | 'global',
  ): Promise<DaemonAgentMutationResult>;

  // Auth device-flow
  startDeviceFlow(
    providerId: DaemonAuthProviderId,
  ): Promise<DaemonDeviceFlowStartResult>;
  getDeviceFlow(
    deviceFlowId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonDeviceFlowState>;
  cancelDeviceFlow(deviceFlowId: string): Promise<void>;
  getAuthStatus(): Promise<DaemonAuthStatusSnapshot>;
}

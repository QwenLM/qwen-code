/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type {
  DaemonAgentMutationResult,
  DaemonAuthProviderId,
  DaemonAuthProviderCatalog,
  DaemonAuthProviderInstallRequest,
  DaemonAuthProviderInstallResult,
  DaemonAuthStatusSnapshot,
  DaemonCapabilities,
  DaemonClient,
  DaemonCreateAgentRequest,
  DaemonGeneratedAgentContent,
  DaemonDeviceFlowStartResult,
  DaemonDeviceFlowState,
  ExtensionMutationResponse,
  ExtensionInteractionResponse,
  ExtensionInteractionResponseResult,
  ExtensionOperationStatus,
  ExtensionRefreshResponse,
  ExtensionScopeRequest,
  ExtensionInstallRequest,
  ExtensionInstallResponse,
  ExtensionUpdateCheckResponse,
  DaemonInitWorkspaceResult,
  DaemonMcpRestartResult,
  DaemonMcpManageAction,
  DaemonMcpManageResult,
  DaemonUpdateAgentRequest,
  DaemonWorkspaceAgentDetail,
  DaemonWorkspaceAgentsStatus,
  DaemonWorkspaceEnvStatus,
  DaemonWorkspaceExtensionsStatus,
  DaemonWorkspaceFile,
  DaemonWorkspaceFileBytes,
  DaemonWorkspaceFileEditRequest,
  DaemonWorkspaceFileEditResult,
  DaemonWorkspaceFileWriteRequest,
  DaemonWorkspaceFileWriteResult,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMcpToolsStatus,
  DaemonWorkspaceMcpResourcesStatus,
  DaemonWorkspaceMemoryStatus,
  DaemonWorkspacePreflightStatus,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceSkillsStatus,
  DaemonWorkspaceToolsStatus,
  DaemonWorkspaceSettingsStatus,
  DaemonSettingUpdateResult,
  DaemonSessionGroup,
  DaemonSessionGroupCatalog,
  DaemonSessionGroupInput,
  DaemonSessionGroupUpdate,
  DaemonSessionListPage,
  DaemonSessionListPageOptions,
  DaemonSessionOrganizationResult,
  DaemonSessionOrganizationUpdate,
  DaemonSessionSummary,
  DaemonSessionExportFormat,
  DaemonSessionExportResult,
  DaemonStatusReport,
  DaemonStatusReportDetail,
  DaemonUsageDashboard,
  DaemonUsageRange,
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
  /**
   * Optional pluggable transport forwarded to `DaemonClient`. When
   * omitted the client uses the default REST+SSE transport.
   */
  transport?: import('@qwen-code/sdk/daemon').DaemonTransport;
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
  getCapabilities?: () => Promise<DaemonCapabilities>;
  /**
   * Force a fresh `/capabilities` fetch and push the result into the
   * provider's `capabilities` state so consumers re-render. Unlike
   * `getCapabilities` — which memoizes its first in-flight promise for the
   * lifetime of the connection and never calls `setCapabilities` outside the
   * initial mount — this bypasses that cache. Use it after a mutation that
   * changes capabilities (e.g. registering a workspace) so the new state
   * shows without a full page reload.
   */
  refreshCapabilities?: () => Promise<DaemonCapabilities>;
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

// ── Scheduled Tasks (durable cron, server-only) ─────────────────────

/** A durable scheduled task as returned by the daemon. `name`/`enabled` are
 * normalized (never undefined): `name: null` = unnamed, `enabled` defaults to
 * true for tasks created before the field existed. */
/** One recorded fire of a recurring scheduled task, newest last in
 * {@link DaemonScheduledTask.runs}. Mirrors the daemon's wire shape. */
export interface DaemonScheduledTaskRun {
  /** Fire time (epoch ms). */
  at: number;
  /** `'scheduled'` (on-time), `'catch-up'` (fired late), or `'manual'` (user
   * "run now"); absent = scheduled. */
  kind?: 'scheduled' | 'catch-up' | 'manual';
  /** The session the fire ran in, when the task is bound to one. Mirrors the
   * daemon's `CronTaskRun.sessionId` so run-attribution isn't silently dropped
   * on the client (not surfaced in the UI yet). */
  sessionId?: string;
  /** READ-ONLY legacy compat: a pre-removal version stamped this on a fire whose
   * precondition withheld the prompt. Never written now, but kept so the UI can
   * still mark such stored entries "skipped" instead of showing them as ordinary
   * successful runs. Absent = a real dispatched run. */
  withheld?: boolean;
}

export interface DaemonScheduledTask {
  id: string;
  name: string | null;
  cron: string;
  prompt: string;
  recurring: boolean;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  /** Next scheduled fire (epoch ms), or null for a disabled task. A GET-time
   * snapshot the UI counts down against; it advances on the next reload. */
  nextRunAt: number | null;
  /** Id of the dedicated session this task is bound to — its transcript is the
   * task's run history. Null for unbound tool-created/legacy tasks. */
  sessionId: string | null;
  /** Bounded, newest-last history of recent fires. Empty for tasks that have
   * not fired (and, by nature, for one-shots — they are deleted on fire). */
  runs: DaemonScheduledTaskRun[];
  /** The registered workspace this task belongs to, when the aggregated
   * multi-workspace view tagged it client-side. Absent (single-workspace) means
   * the primary workspace. `workspaceId` targets its workspace-qualified route;
   * `workspaceCwd` labels the card. The daemon never sends these — they are
   * attached by the client after a per-workspace fetch. */
  workspaceId?: string;
  workspaceCwd?: string;
}

export interface DaemonCreateScheduledTaskRequest {
  cron: string;
  prompt: string;
  /** Omit or null for an unnamed task. */
  name?: string | null;
  /** Defaults to true (fire on every match until deleted/expired). */
  recurring?: boolean;
  /** Defaults to true. */
  enabled?: boolean;
}

/** Partial update. `name: null` (or '') clears the name. Omitted fields are
 * left unchanged. */
export interface DaemonUpdateScheduledTaskRequest {
  cron?: string;
  prompt?: string;
  name?: string | null;
  recurring?: boolean;
  enabled?: boolean;
}

export interface DaemonAddWorkspaceResult {
  id: string;
  cwd: string;
  primary: boolean;
  trusted: boolean;
  persisted?: boolean;
}

export interface DaemonWorkspaceActions {
  // Sessions
  listSessions(
    options?: DaemonSessionListPageOptions,
  ): Promise<DaemonSessionSummary[]>;
  listSessionsPage(
    options?: DaemonSessionListPageOptions,
  ): Promise<DaemonSessionListPage>;
  listSessionGroups(): Promise<DaemonSessionGroupCatalog>;
  createSessionGroup(
    input: DaemonSessionGroupInput,
  ): Promise<DaemonSessionGroup>;
  updateSessionGroup(
    groupId: string,
    update: DaemonSessionGroupUpdate,
  ): Promise<DaemonSessionGroup>;
  deleteSessionGroup(groupId: string): Promise<{ deleted: boolean }>;
  updateSessionOrganization(
    sessionId: string,
    update: DaemonSessionOrganizationUpdate,
  ): Promise<DaemonSessionOrganizationResult>;
  deleteSession(sessionId: string): Promise<boolean>;
  deleteSessions(sessionIds: string[]): Promise<{
    removed: string[];
    notFound: string[];
    errors: Array<{ sessionId: string; error: string }>;
  }>;
  exportSession(
    sessionId: string,
    format?: DaemonSessionExportFormat,
  ): Promise<DaemonSessionExportResult>;
  /**
   * Move a session to the archived directory. Idempotent: an
   * already-archived session resolves `true`. Rejects if the daemon
   * reports a per-session error (e.g. an archive/unarchive conflict).
   */
  archiveSession(sessionId: string): Promise<boolean>;
  /** Restore an archived session to the active directory. Idempotent. */
  unarchiveSession(sessionId: string): Promise<boolean>;

  // MCP
  loadMcpStatus(): Promise<DaemonWorkspaceMcpStatus>;
  loadMcpTools(serverName: string): Promise<DaemonWorkspaceMcpToolsStatus>;
  loadMcpResources(
    serverName: string,
  ): Promise<DaemonWorkspaceMcpResourcesStatus>;
  restartMcpServer(serverName: string): Promise<DaemonMcpRestartResult>;
  manageMcpServer(
    serverName: string,
    action: DaemonMcpManageAction,
  ): Promise<DaemonMcpManageResult>;

  // Daemon status (read-only)
  loadDaemonStatus(
    detail?: DaemonStatusReportDetail,
  ): Promise<DaemonStatusReport>;

  // Token-usage dashboard (read-only)
  loadUsageDashboard(opts?: {
    range?: DaemonUsageRange;
    heatmapDays?: number;
  }): Promise<DaemonUsageDashboard>;

  // Skills (read-only)
  loadSkillsStatus(): Promise<DaemonWorkspaceSkillsStatus>;

  // Extensions
  loadExtensionsStatus(): Promise<DaemonWorkspaceExtensionsStatus>;

  // Tools
  loadToolsStatus(): Promise<DaemonWorkspaceToolsStatus>;
  setWorkspaceToolEnabled(toolName: string, enabled: boolean): Promise<unknown>;

  // Settings
  loadSettingsStatus(): Promise<DaemonWorkspaceSettingsStatus>;
  setWorkspaceSetting(
    scope: 'workspace',
    key: string,
    value: unknown,
  ): Promise<DaemonSettingUpdateResult>;

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
  generateAgent(description: string): Promise<DaemonGeneratedAgentContent>;
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

  // Scheduled tasks (durable cron). The optional `workspaceId` targets a
  // registered non-primary workspace's own cron file via the workspace-qualified
  // route; omit it (or pass the primary's) to hit the primary `/scheduled-tasks`
  // surface. The aggregated Web Shell view fans `listScheduledTasks` out over
  // every trusted workspace and threads each task's `workspaceId` back into the
  // mutations.
  listScheduledTasks(workspaceId?: string): Promise<DaemonScheduledTask[]>;
  createScheduledTask(
    req: DaemonCreateScheduledTaskRequest,
    workspaceId?: string,
  ): Promise<DaemonScheduledTask>;
  updateScheduledTask(
    id: string,
    patch: DaemonUpdateScheduledTaskRequest,
    workspaceId?: string,
  ): Promise<DaemonScheduledTask>;
  /** Record a manual run (updates lastFiredAt + appends a 'manual' run). The
   * prompt itself is executed by the caller in the task's bound session. */
  runScheduledTask(
    id: string,
    workspaceId?: string,
  ): Promise<DaemonScheduledTask>;
  deleteScheduledTask(id: string, workspaceId?: string): Promise<void>;

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

  // Extensions
  installExtension(
    params: ExtensionInstallRequest,
    clientId?: string,
  ): Promise<ExtensionInstallResponse>;
  extensionOperationStatus(
    operationId: string,
  ): Promise<ExtensionOperationStatus>;
  respondToExtensionInteraction(
    operationId: string,
    interactionId: string,
    response: ExtensionInteractionResponse,
    clientId?: string,
  ): Promise<ExtensionInteractionResponseResult>;
  checkExtensionUpdates(
    clientId?: string,
  ): Promise<ExtensionUpdateCheckResponse>;
  refreshExtensions(clientId?: string): Promise<ExtensionRefreshResponse>;
  enableExtension(
    name: string,
    params: ExtensionScopeRequest,
    clientId?: string,
  ): Promise<ExtensionMutationResponse>;
  disableExtension(
    name: string,
    params: ExtensionScopeRequest,
    clientId?: string,
  ): Promise<ExtensionMutationResponse>;
  updateExtension(
    name: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse>;
  uninstallExtension(
    name: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse>;

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
  getAuthProviders(): Promise<DaemonAuthProviderCatalog>;
  installAuthProvider(
    req: DaemonAuthProviderInstallRequest,
  ): Promise<DaemonAuthProviderInstallResult>;

  // Workspace management
  addWorkspace(
    cwd: string,
    options?: { persist?: boolean },
  ): Promise<DaemonAddWorkspaceResult>;
}

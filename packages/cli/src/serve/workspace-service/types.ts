/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for the DaemonWorkspaceService layer.
 *
 * Each sub-service gets a `WorkspaceRequestContext` as its first
 * parameter so audit, client-identity, and route metadata flow
 * naturally without threading individual fields.
 */

import type {
  ServeWorkspaceMcpStatus,
  ServeWorkspaceSkillsStatus,
  ServeWorkspaceProvidersStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspacePreflightStatus,
  ServeWorkspaceMemoryStatus,
  ServeWorkspaceAgentsStatus,
  ServeWorkspaceAgentDetail,
  ServeContextFileScope,
} from '@qwen-code/acp-bridge';

import type {
  WorkspaceFileSystemFactory,
  ResolvedPath,
  FsStat,
  FsEntry,
  ReadMeta,
  ReadTextOptions,
  ReadBytesOptions,
  ReadBytesOutcome,
  ListOptions,
  GlobOptions,
  WriteTextAtomicOptions,
  WriteTextAtomicOutcome,
} from '../fs/index.js';

import type {
  DeviceFlowRegistry,
  DeviceFlowPublicView,
  DeviceFlowProviderId,
} from '../auth/deviceFlow.js';

// ---------------------------------------------------------------------------
// WorkspaceRequestContext
// ---------------------------------------------------------------------------

/**
 * Per-request context threaded to all sub-service methods. Extends the
 * filesystem `RequestContext` with optional fields the workspace layer
 * needs for audit correlation and client-identity gating.
 *
 * `originatorClientId` is optional because file reads work without a
 * registered client (e.g. stateless GET routes that don't carry the
 * header). `sessionId` is optional for audit correlation on
 * workspace-scoped routes that have no session context.
 */
export interface WorkspaceRequestContext {
  /** Daemon-stamped client identity (from X-Qwen-Client-Id header). */
  originatorClientId?: string;
  /** ACP session id for cross-correlating audit + session events. */
  sessionId?: string;
  /** Route name like 'GET /workspace/memory' for audit. */
  route: string;
  /** Absolute path to the workspace root — trust boundary. */
  workspaceCwd: string;
}

// ---------------------------------------------------------------------------
// FileService
// ---------------------------------------------------------------------------

/**
 * Workspace filesystem operations. Thin delegation layer over
 * `WorkspaceFileSystem` that accepts `WorkspaceRequestContext`
 * instead of requiring callers to construct a `RequestContext`
 * themselves.
 */
export interface FileService {
  resolve(
    ctx: WorkspaceRequestContext,
    input: string,
    intent: 'read' | 'write' | 'stat' | 'list' | 'glob',
  ): Promise<ResolvedPath>;

  stat(ctx: WorkspaceRequestContext, p: ResolvedPath): Promise<FsStat>;

  readText(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    opts?: ReadTextOptions,
  ): Promise<{ content: string; meta: ReadMeta }>;

  readBytes(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    opts?: ReadBytesOptions,
  ): Promise<Buffer>;

  readBytesWindow(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    opts?: ReadBytesOptions,
  ): Promise<ReadBytesOutcome>;

  list(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    opts?: ListOptions,
  ): Promise<FsEntry[]>;

  glob(
    ctx: WorkspaceRequestContext,
    pattern: string,
    opts?: GlobOptions,
  ): Promise<ResolvedPath[]>;

  writeTextAtomic(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    content: string,
    opts: WriteTextAtomicOptions,
  ): Promise<WriteTextAtomicOutcome>;

  writeTextOverwrite(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    content: string,
  ): Promise<WriteTextAtomicOutcome>;

  edit(
    ctx: WorkspaceRequestContext,
    p: ResolvedPath,
    content: string,
    opts: WriteTextAtomicOptions,
  ): Promise<WriteTextAtomicOutcome>;
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

/** Parameters for starting a device flow. */
export interface AuthStartDeviceFlowParams {
  providerId: DeviceFlowProviderId;
}

/** Result of starting (or attaching to) a device flow. */
export interface AuthStartDeviceFlowResult {
  view: DeviceFlowPublicView;
  attached: boolean;
}

/** Result of cancelling a device flow. */
export interface AuthCancelDeviceFlowResult {
  alreadyTerminal: boolean;
}

/**
 * Authentication operations scoped to the workspace daemon. Wraps
 * `DeviceFlowRegistry` and auth-status queries.
 */
export interface AuthService {
  /** Start a new device flow (or attach to an existing one for the same provider). */
  startDeviceFlow(
    ctx: WorkspaceRequestContext,
    params: AuthStartDeviceFlowParams,
  ): Promise<AuthStartDeviceFlowResult>;

  /** Get the public view of a device flow by id. */
  getDeviceFlow(
    ctx: WorkspaceRequestContext,
    deviceFlowId: string,
  ): DeviceFlowPublicView | undefined;

  /** Cancel a pending device flow. Returns undefined for unknown ids. */
  cancelDeviceFlow(
    ctx: WorkspaceRequestContext,
    deviceFlowId: string,
  ): AuthCancelDeviceFlowResult | undefined;

  /** List currently pending device flows. */
  listPendingDeviceFlows(ctx: WorkspaceRequestContext): DeviceFlowPublicView[];

  /** Get overall auth status for the workspace. */
  getAuthStatus(
    ctx: WorkspaceRequestContext,
  ): Promise<{ authenticated: boolean; pendingFlows: DeviceFlowPublicView[] }>;
}

// ---------------------------------------------------------------------------
// AgentsService
// ---------------------------------------------------------------------------

/** Parameters for creating a new agent. */
export interface CreateAgentParams {
  name: string;
  description: string;
  systemPrompt: string;
  level?: 'project' | 'user';
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  color?: string;
  background?: boolean;
  approvalMode?: string;
  runConfig?: { max_time_minutes?: number; max_turns?: number };
}

/** Parameters for updating an existing agent. */
export interface UpdateAgentParams {
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  color?: string;
  background?: boolean;
  approvalMode?: string;
  runConfig?: { max_time_minutes?: number; max_turns?: number };
}

/**
 * Workspace agent CRUD operations. Wraps `SubagentManager` for
 * daemon-scoped agent management.
 */
export interface AgentsService {
  /** List all agents (project + user + builtin). */
  listAgents(ctx: WorkspaceRequestContext): Promise<ServeWorkspaceAgentsStatus>;

  /** Get full detail for a specific agent by name. */
  getAgent(
    ctx: WorkspaceRequestContext,
    agentName: string,
  ): Promise<ServeWorkspaceAgentDetail | undefined>;

  /** Create a new agent definition. */
  createAgent(
    ctx: WorkspaceRequestContext,
    params: CreateAgentParams,
  ): Promise<ServeWorkspaceAgentDetail>;

  /** Update an existing agent definition. */
  updateAgent(
    ctx: WorkspaceRequestContext,
    agentName: string,
    params: UpdateAgentParams,
  ): Promise<ServeWorkspaceAgentDetail>;

  /** Delete an agent definition. Idempotent — no-throw for missing agents. */
  deleteAgent(
    ctx: WorkspaceRequestContext,
    agentName: string,
  ): Promise<{ deleted: boolean }>;
}

// ---------------------------------------------------------------------------
// MemoryService
// ---------------------------------------------------------------------------

/** Parameters for writing workspace memory. */
export interface WriteMemoryParams {
  scope: ServeContextFileScope;
  content: string;
  mode: 'append' | 'replace';
}

/** Result of a memory write operation. */
export interface WriteMemoryResult {
  path: string;
  scope: ServeContextFileScope;
  bytes: number;
}

/**
 * Workspace memory (QWEN.md / AGENTS.md) read + write operations.
 */
export interface MemoryService {
  /** List memory entries (file list + totals). */
  list(ctx: WorkspaceRequestContext): Promise<ServeWorkspaceMemoryStatus>;

  /** Read a specific memory entry by key/path. */
  read(
    ctx: WorkspaceRequestContext,
    key: string,
  ): Promise<{ content: string; path: string }>;

  /** Write content to a workspace or global memory file. */
  write(
    ctx: WorkspaceRequestContext,
    params: WriteMemoryParams,
  ): Promise<WriteMemoryResult>;

  /** Delete a memory entry. */
  delete(
    ctx: WorkspaceRequestContext,
    key: string,
  ): Promise<{ deleted: boolean }>;
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
  readonly file: FileService;
  readonly auth: AuthService;
  readonly agents: AgentsService;
  readonly memory: MemoryService;

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

  /** Factory for per-request filesystem instances. */
  fsFactory: WorkspaceFileSystemFactory;

  /** Device-flow auth registry. */
  deviceFlowRegistry: DeviceFlowRegistry;

  /** Subagent manager for agents CRUD. */
  subagentManager: unknown;

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

  /**
   * Set of all currently known client ids across live sessions.
   * Used for client-id validation on mutation routes.
   */
  knownClientIds: () => ReadonlySet<string>;
}

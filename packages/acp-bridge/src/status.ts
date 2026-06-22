/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { HookEventName } from '@qwen-code/qwen-code-core';
import { SkillError } from '@qwen-code/qwen-code-core';

export const STATUS_SCHEMA_VERSION = 1 as const;

/**
 * Closed enumeration of structured error categories surfaced on diagnostic
 * status cells. Cells produced by `/workspace/preflight`, `/workspace/env`,
 * and (eventually) the MCP guardrails route share this taxonomy so SDK
 * consumers can branch on a known set rather than parsing free-form strings.
 */
export const SERVE_ERROR_KINDS = [
  'missing_binary',
  'blocked_egress',
  'auth_env_error',
  'init_timeout',
  'protocol_error',
  'missing_file',
  'parse_error',
  'stat_failed',
  // Budget refusal under `--mcp-budget-mode=enforce`.
  // Surfaced on per-server `mcp_server` cells (refused at discovery)
  // and on the workspace-level `mcp_budget` cell (any refusal this pass).
  'budget_exhausted',
  // Runtime MCP mutation routes
  'mcp_budget_would_exceed',
  'mcp_server_spawn_failed',
  'invalid_config',
  // Prompt deadline + writer idle timeout
  'prompt_deadline_exceeded',
  'writer_idle_timeout',
] as const;

export type ServeErrorKind = (typeof SERVE_ERROR_KINDS)[number];

/**
 * Typed timeout raised by `withTimeout` in the bridge. Lets the diagnostic
 * mapping helper recognize init/heartbeat/extMethod timeouts via `instanceof`
 * instead of regex-matching message strings.
 */
export class BridgeTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`AcpSessionBridge ${label} timed out after ${timeoutMs}ms`);
    this.name = 'BridgeTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raised when the bridge observes its ACP child's transport closing while
 * a request is in flight (workspace status, session/* restore, or
 * mid-prompt). Replaces three `new Error('agent channel closed …')` sites
 * so `mapDomainErrorToErrorKind` can recognize the failure via
 * `instanceof` rather than regex-matching `.message`. The `context` suffix
 * preserves the legacy message wording so log greps and existing
 * diagnostic surfaces keep working.
 */
export class BridgeChannelClosedError extends Error {
  readonly context: string;
  constructor(context: string) {
    super(`agent channel closed ${context}`);
    this.name = 'BridgeChannelClosedError';
    this.context = context;
  }
}

/**
 * Raised by `defaultSpawnChannelFactory` when neither `QWEN_CLI_ENTRY` nor
 * `process.argv[1]` resolves to a path that can be re-spawned for the ACP
 * child. Replaces a generic `new Error(...)` so `mapDomainErrorToErrorKind`
 * can return `'missing_binary'` via `instanceof` rather than regex-matching
 * `.message`. The constructor message is preserved verbatim so existing
 * operator-facing diagnostics stay byte-for-byte compatible.
 */
export class MissingCliEntryError extends Error {
  constructor() {
    super(
      'Cannot determine CLI entry path for spawning the ACP child: ' +
        'process.argv[1] is empty and QWEN_CLI_ENTRY is unset. ' +
        'Set QWEN_CLI_ENTRY to the absolute path of the qwen entry ' +
        'script (e.g. `export QWEN_CLI_ENTRY=$(which qwen)`) to override.',
    );
    this.name = 'MissingCliEntryError';
  }
}

export const SERVE_STATUS_EXT_METHODS = {
  workspaceMcp: 'qwen/status/workspace/mcp',
  workspaceMcpTools: 'qwen/status/workspace/mcp/tools',
  workspaceSkills: 'qwen/status/workspace/skills',
  workspaceTools: 'qwen/status/workspace/tools',
  workspaceProviders: 'qwen/status/workspace/providers',
  workspaceMemory: 'qwen/status/workspace/memory',
  workspaceAgents: 'qwen/status/workspace/agents',
  workspacePreflight: 'qwen/status/workspace/preflight',
  sessionContext: 'qwen/status/session/context',
  sessionContextUsage: 'qwen/status/session/context_usage',
  sessionSupportedCommands: 'qwen/status/session/supported_commands',
  sessionTasks: 'qwen/status/session/tasks',
  sessionStats: 'qwen/status/session/stats',
  sessionRewindSnapshots: 'qwen/status/session/rewind_snapshots',
  workspaceHooks: 'qwen/status/workspace/hooks',
  sessionHooks: 'qwen/status/session/hooks',
  workspaceExtensions: 'qwen/status/workspace/extensions',
} as const;

/**
 * Control-plane (mutation) ACP extMethods introduced in Mutation control.
 * Distinct from `SERVE_STATUS_EXT_METHODS` so reviewers can grep mutation
 * surface independently from read-only diagnostics. Each route in
 * `server.ts` forwards through the matching extMethod into `acpAgent.ts`
 * which then mutates Config / ToolRegistry / McpClientManager state.
 */
export const SERVE_CONTROL_EXT_METHODS = {
  sessionClose: 'qwen/control/session/close',
  sessionApprovalMode: 'qwen/control/session/approval_mode',
  sessionBranch: 'qwen/control/session/branch',
  sessionForkAgent: 'qwen/control/session/fork_agent',
  sessionRecap: 'qwen/control/session/recap',
  sessionBtw: 'qwen/control/session/btw',
  sessionShellHistory: 'qwen/control/session/shell_history',
  sessionLanguage: 'qwen/control/session/language',
  sessionRewind: 'qwen/control/session/rewind',
  sessionTitle: 'qwen/control/session/title',
  workspaceMcpRestart: 'qwen/control/workspace/mcp/restart',
  workspaceMcpManage: 'qwen/control/workspace/mcp/manage',
  workspaceAgentGenerate: 'qwen/control/workspace/agents/generate',
  // Runtime MCP server mutation ext-methods
  sessionTaskCancel: 'qwen/control/session/task/cancel',
  sessionGoalClear: 'qwen/control/session/goal/clear',
  workspaceMcpRuntimeAdd: 'qwen/control/workspace/mcp/runtime-add',
  workspaceMcpRuntimeRemove: 'qwen/control/workspace/mcp/runtime-remove',
  workspaceReload: 'qwen/control/workspace/reload',
  workspaceExtensionsRefresh: 'qwen/control/workspace/extensions/refresh',
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
  errorKind?: ServeErrorKind;
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
  hasOAuthTokens?: boolean;
  source?: 'user' | 'project' | 'extension';
  config?: {
    command?: string;
    args?: string[];
    httpUrl?: string;
    url?: string;
    cwd?: string;
  };
  description?: string;
  extensionName?: string;
  /**
   * Why this server is not live, when known. Distinguishes
   * operator-disabled (`disabled: true` from `disabledMcpServers`
   * config) from The budget feature budget-refused (`status: 'error', errorKind:
   * 'budget_exhausted'`). Operators dashboarding the workspace
   * shouldn't have to cross-reference the `errors[]` or `budgets[]`
   * arrays to render a per-server row correctly.
   */
  disabledReason?: 'config' | 'budget';
  /**
   * Pool-mode workspaces can hold multiple
   * `PoolEntry` instances under the same `name` when sessions inject
   * different fingerprints (e.g. per-session OAuth headers). Absent on
   * older daemons and on daemons with `QWEN_SERVE_NO_MCP_POOL=1`;
   * present (≥1) when the pool advertises `mcp_workspace_pool`.
   * Operators use this to render an "N entries" badge or drill into
   * `entrySummary` for the per-entry breakdown.
   */
  entryCount?: number;
  /**
   * Per-entry breakdown for multi-entry server
   * names. `entryIndex` is a stable opaque integer assigned at entry
   * creation (V21-7) — NOT the raw fingerprint, which would leak
   * OAuth/env rotation timing through snapshot diffs. `refs` is the
   * count of sessions currently attached. `status` is the per-entry
   * runtime status (`connected` / `connecting` / `disconnected`) so
   * dashboards can show per-entry health when the aggregated
   * `mcpStatus` rolls up to `connected` while one entry is still
   * reconnecting.
   *
   * Old SDK clients ignore the field per the additive-only protocol
   * contract; new clients gate UI on `entryCount > 1`. The pair
   * (`entryCount`, `entrySummary`) is always present together when
   * advertised — `mcp_workspace_pool` capability tag implies both.
   */
  entrySummary?: ReadonlyArray<{
    entryIndex: number;
    refs: number;
    status: ServeMcpServerRuntimeStatus;
  }>;
}

/** Budget mode for the MCP client guardrails. */
export type ServeMcpBudgetMode = 'enforce' | 'warn' | 'off';

/**
 * Workspace-level budget status cell. Surfaced as one entry in
 * `ServeWorkspaceMcpStatus.budgets[]`. The list shape (vs a single
 * `budget?` field) is forward-compat for a future change that may
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
   * **The budget feature v1 emits `'session'`** because each ACP session creates
   * its own `Config`/`McpClientManager` via `acpAgent.newSessionConfig()`
   * — so the budget caps live MCP clients **per session**, not
   * per-workspace. The snapshot reflects the bootstrap session's
   * view; concurrent sessions each enforce their own copy of the
   * cap independently. See `qwen-serve-protocol.md` "The budget feature v1
   * scope: per-session" for the operator-facing rationale.
   *
   * Future PRs:
   *   - A future shared MCP pool may introduce a workspace-scoped
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
  /** The budget feature: live MCP client count (sum across all transports). */
  clientCount?: number;
  /** The budget feature: configured budget. Absent when no cap was set. */
  clientBudget?: number;
  /** The budget feature: active enforcement mode. Absent on older daemons. */
  budgetMode?: ServeMcpBudgetMode;
  /**
   * The budget feature: workspace-level status cells for budget enforcement. Always
   * an array (possibly empty) on newer daemons; absent on older
   * daemons. A future version may add a `scope: 'pool'` cell alongside.
   */
  budgets?: ServeMcpBudgetStatusCell[];
}

export interface ServeWorkspaceMcpToolStatus {
  name: string;
  serverToolName?: string;
  description?: string;
  schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  isValid: boolean;
  invalidReason?: string;
}

export interface ServeWorkspaceMcpToolsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  serverName: string;
  initialized: boolean;
  acpChannelLive: boolean;
  tools: ServeWorkspaceMcpToolStatus[];
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
  baseUrl?: string;
  fastModelId?: string;
}

export interface ServeWorkspaceProviderModel {
  modelId: string;
  baseModelId: string;
  name: string;
  description?: string | null;
  contextLimit?: number;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  baseUrl?: string;
  envKey?: string;
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

export interface ServeContextCategoryBreakdown {
  systemPrompt: number;
  builtinTools: number;
  mcpTools: number;
  memoryFiles: number;
  skills: number;
  messages: number;
  freeSpace: number;
  autocompactBuffer: number;
}

export interface ServeContextToolDetail {
  name: string;
  tokens: number;
}

export interface ServeContextMemoryDetail {
  path: string;
  tokens: number;
}

export interface ServeContextSkillDetail {
  name: string;
  tokens: number;
  loaded?: boolean;
  bodyTokens?: number;
}

export interface ServeSessionContextUsage {
  modelName: string;
  totalTokens: number;
  contextWindowSize: number;
  breakdown: ServeContextCategoryBreakdown;
  builtinTools: ServeContextToolDetail[];
  mcpTools: ServeContextToolDetail[];
  memoryFiles: ServeContextMemoryDetail[];
  skills: ServeContextSkillDetail[];
  isEstimated?: boolean;
  showDetails?: boolean;
}

export interface ServeSessionContextUsageStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspaceCwd: string;
  usage: ServeSessionContextUsage;
  formattedText: string;
}

export interface ServeSessionSupportedCommandsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  availableCommands: AvailableCommand[];
  availableSkills: string[];
}

export type ServeSessionTaskLifecycleStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ServeSessionProcessTaskLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ServeSessionAgentTaskStatus {
  kind: 'agent';
  id: string;
  label: string;
  description: string;
  status: ServeSessionTaskLifecycleStatus;
  startTime: number;
  endTime?: number;
  runtimeMs: number;
  outputFile?: string;
  subagentType?: string;
  isBackgrounded: boolean;
  error?: string;
  resumeBlockedReason?: string;
  stats?: { totalTokens: number; toolUses: number; durationMs: number };
  recentActivities?: Array<{ name: string; description: string; at: number }>;
  prompt?: string;
}

export interface ServeSessionShellTaskStatus {
  kind: 'shell';
  id: string;
  label: string;
  description: string;
  status: ServeSessionProcessTaskLifecycleStatus;
  startTime: number;
  endTime?: number;
  runtimeMs: number;
  outputFile?: string;
  command: string;
  cwd: string;
  pid?: number;
  exitCode?: number;
  error?: string;
}

export interface ServeSessionMonitorTaskStatus {
  kind: 'monitor';
  id: string;
  label: string;
  description: string;
  status: ServeSessionProcessTaskLifecycleStatus;
  startTime: number;
  endTime?: number;
  runtimeMs: number;
  command: string;
  pid?: number;
  eventCount: number;
  lastEventTime: number;
  droppedLines: number;
  exitCode?: number;
  error?: string;
  ownerAgentId?: string;
}

export type ServeSessionTaskStatus =
  | ServeSessionAgentTaskStatus
  | ServeSessionShellTaskStatus
  | ServeSessionMonitorTaskStatus;

export interface ServeSessionTasksStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  now: number;
  tasks: ServeSessionTaskStatus[];
}

export interface ServeSessionStatsModelMetrics {
  api: {
    totalRequests: number;
    totalErrors: number;
    totalLatencyMs: number;
  };
  tokens: {
    prompt: number;
    candidates: number;
    total: number;
    cached: number;
    thoughts: number;
  };
}

export interface ServeSessionStatsToolByName {
  count: number;
  success: number;
  fail: number;
  durationMs: number;
  decisions: {
    accept: number;
    reject: number;
    modify: number;
    auto_accept: number;
  };
}

export interface ServeSessionStatsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspaceCwd: string;
  sessionStartTimeMs: number;
  durationMs: number;
  promptCount: number;
  models: Record<string, ServeSessionStatsModelMetrics>;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    totalDurationMs: number;
    byName: Record<string, ServeSessionStatsToolByName>;
  };
  files: {
    totalLinesAdded: number;
    totalLinesRemoved: number;
  };
}

/**
 * Workspace memory + agents read surfaces.
 *
 * Both shapes mirror the `kind / status / error? / errorKind? / hint?`
 * cell pattern that The mcp/skills/providers status structures use,
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

// ---------------------------------------------------------------------------
// Issue #4514 T3.9: workspace + session hooks diagnostic surfaces.
// ---------------------------------------------------------------------------

export type ServeHookMatcherKind =
  | 'toolName'
  | 'agentType'
  | 'trigger'
  | 'sessionTrigger'
  | 'error'
  | 'notificationType'
  | 'commandName'
  | 'filePath';

export interface ServeHookEventMeta {
  description: string;
  matcherKind?: ServeHookMatcherKind;
}

export interface ServeCommandHookConfig {
  type: 'command';
  command: string;
  name?: string;
  description?: string;
  timeout?: number;
  env?: Record<string, string>;
  async?: boolean;
  shell?: 'bash' | 'powershell';
  statusMessage?: string;
}

export interface ServeHttpHookConfig {
  type: 'http';
  url: string;
  name?: string;
  description?: string;
  timeout?: number;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  if?: string;
  statusMessage?: string;
  once?: boolean;
}

export interface ServeFunctionHookConfig {
  type: 'function';
  id?: string;
  name?: string;
  description?: string;
  timeout?: number;
  errorMessage?: string;
  statusMessage?: string;
}

export interface ServePromptHookConfig {
  type: 'prompt';
  prompt: string;
  name?: string;
  description?: string;
  timeout?: number;
  model?: string;
  statusMessage?: string;
}

export interface ServeUnknownHookConfig {
  type: string;
  name?: string;
  description?: string;
  timeout?: number;
  statusMessage?: string;
}

export type ServeHookConfig =
  | ServeCommandHookConfig
  | ServeHttpHookConfig
  | ServeFunctionHookConfig
  | ServePromptHookConfig
  | ServeUnknownHookConfig;

export type ServeHookSource =
  | 'project'
  | 'user'
  | 'system'
  | 'extensions'
  | 'session';

export interface ServeHookEntry {
  kind: 'hook';
  eventName: string;
  config: ServeHookConfig;
  source: ServeHookSource;
  matcher?: string;
  sequential?: boolean;
  enabled: boolean;
  hookId?: string;
  skillRoot?: string;
}

export interface ServeWorkspaceHooksStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  disabled: boolean;
  hooks: ServeHookEntry[];
  events: Record<string, ServeHookEventMeta>;
  errors?: ServeStatusCell[];
}

export interface ServeSessionHooksStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspaceCwd: string;
  disabled: boolean;
  hooks: ServeHookEntry[];
  errors?: ServeStatusCell[];
}

export const IDLE_HOOK_EVENTS: Record<HookEventName, ServeHookEventMeta> = {
  PreToolUse: { description: 'Before tool execution', matcherKind: 'toolName' },
  PostToolUse: { description: 'After tool execution', matcherKind: 'toolName' },
  PostToolUseFailure: {
    description: 'After tool execution fails',
    matcherKind: 'toolName',
  },
  PostToolBatch: { description: 'After a batch of tool calls resolves' },
  Notification: {
    description: 'When notifications are sent',
    matcherKind: 'notificationType',
  },
  UserPromptSubmit: { description: 'When the user submits a prompt' },
  UserPromptExpansion: {
    description: 'When a slash command expands into a prompt',
    matcherKind: 'commandName',
  },
  SessionStart: {
    description: 'When a new session is started',
    matcherKind: 'sessionTrigger',
  },
  Stop: { description: 'Right before Qwen Code concludes its response' },
  SubagentStart: {
    description: 'When a subagent is started',
    matcherKind: 'agentType',
  },
  SubagentStop: {
    description: 'Right before a subagent concludes its response',
    matcherKind: 'agentType',
  },
  PreCompact: {
    description: 'Before conversation compaction',
    matcherKind: 'trigger',
  },
  PostCompact: {
    description: 'After conversation compaction',
    matcherKind: 'trigger',
  },
  SessionEnd: {
    description: 'When a session is ending',
    matcherKind: 'sessionTrigger',
  },
  PermissionRequest: {
    description: 'When a permission dialog is displayed',
    matcherKind: 'toolName',
  },
  PermissionDenied: {
    description: 'When a tool call is denied',
    matcherKind: 'toolName',
  },
  StopFailure: {
    description: 'When the turn ends due to an API error',
    matcherKind: 'error',
  },
  TodoCreated: { description: 'When a new todo item is created' },
  TodoCompleted: { description: 'When a todo item is marked as completed' },
  InstructionsLoaded: {
    description: 'When an instruction or context file is loaded',
    matcherKind: 'filePath',
  },
};

// ---------------------------------------------------------------------------
// Workspace extensions diagnostic surface.
// ---------------------------------------------------------------------------

export type ServeExtensionInstallType =
  | 'git'
  | 'local'
  | 'link'
  | 'github-release'
  | 'npm'
  | 'archive-url';

export type ServeExtensionOriginSource = 'QwenCode' | 'Claude' | 'Gemini';

export interface ServeExtensionCapabilities {
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
  hookCount: number;
  commandCount: number;
  contextFileCount: number;
  channelCount: number;
  hasSettings: boolean;
}

export type ServeExtensionUpdateState =
  | 'checking for updates'
  | 'updated, needs restart'
  | 'updating'
  | 'updated'
  | 'update available'
  | 'up to date'
  | 'error'
  | 'not updatable'
  | 'unknown';

export interface ServeExtensionDetails {
  mcpServers: string[];
  commands: string[];
  skills: string[];
  agents: string[];
  contextFiles: string[];
  settings: string[];
}

export interface ServeExtensionEntry {
  kind: 'extension';
  id: string;
  name: string;
  displayName?: string;
  version: string;
  isActive: boolean;
  path: string;
  source?: string;
  installType?: ServeExtensionInstallType;
  originSource?: ServeExtensionOriginSource;
  ref?: string;
  autoUpdate?: boolean;
  updateState?: ServeExtensionUpdateState;
  capabilities: ServeExtensionCapabilities;
  details?: ServeExtensionDetails;
}

export interface ServeWorkspaceExtensionsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  extensions: ServeExtensionEntry[];
  errors?: ServeStatusCell[];
}

export function createIdleWorkspaceExtensionsStatus(
  workspaceCwd: string,
): ServeWorkspaceExtensionsStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    extensions: [],
  };
}

export function createIdleWorkspaceHooksStatus(
  workspaceCwd: string,
): ServeWorkspaceHooksStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    disabled: false,
    hooks: [],
    events: IDLE_HOOK_EVENTS,
  };
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
  // The budget feature: an idle workspace has zero live clients and no enforcement
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

/**
 * Idle envelope for `/workspace/env` when the bridge
 * has no `DaemonStatusProvider` injected (Mode A in-process consumers,
 * tests, embedded callers that don't need daemon-host cells). Single
 * construction site so future optional-field additions to
 * `ServeWorkspaceEnvStatus` only need updating in one place — the
 * production builder in `cli/src/serve/env-snapshot.ts buildEnvStatusFromProcess`
 * and this helper would otherwise diverge silently (TS won't flag a
 * missing optional field).
 *
 * Note: `initialized: true` matches `buildEnvStatusFromProcess` —
 * the daemon answers env from `process.*` state without consulting
 * ACP, so even an "empty" envelope is initialized.
 */
export function createIdleEnvStatus(
  workspaceCwd: string,
  acpChannelLive: boolean,
): ServeWorkspaceEnvStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: true,
    acpChannelLive,
    cells: [],
  };
}

/**
 * Discriminant for diagnostic cells emitted by `/workspace/env`.
 * `env_var` cells are presence-only (the daemon never echoes secret values
 * even when redacted). The other kinds expose non-sensitive values like
 * runtime tag, platform, redacted proxy host, and sandbox profile name.
 */
export type ServeEnvKind =
  | 'runtime'
  | 'platform'
  | 'sandbox'
  | 'proxy'
  | 'env_var'
  | 'memory';

export interface ServeEnvCell extends ServeStatusCell {
  kind: ServeEnvKind;
  /** Stable identifier within the kind (e.g. env-var name, proxy var name). */
  name: string;
  present?: boolean;
  /** Non-sensitive value; ALWAYS omitted for kind='env_var'. */
  value?: string;
}

export interface ServeWorkspaceEnvStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  /** Always true — the daemon answers env without consulting ACP. */
  initialized: true;
  /** Whether an ACP channel is currently live; informational only. */
  acpChannelLive: boolean;
  cells: ServeEnvCell[];
  errors?: ServeStatusCell[];
}

export interface ServeWorkspaceToolStatus {
  name: string;
  displayName?: string;
  description?: string;
  enabled: boolean;
}

export interface ServeWorkspaceToolsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: true;
  acpChannelLive: boolean;
  tools: ServeWorkspaceToolStatus[];
  errors?: ServeStatusCell[];
}

/**
 * Discriminant for diagnostic cells emitted by `/workspace/preflight`. Cells
 * with `locality: 'daemon'` are answered by the bridge process directly and
 * are always populated. Cells with `locality: 'acp'` require a live ACP child
 * — when the daemon is idle they are emitted with `status: 'not_started'`.
 */
export type ServePreflightKind =
  | 'node_version'
  | 'cli_entry'
  | 'workspace_dir'
  | 'ripgrep'
  | 'git'
  | 'npm'
  | 'auth'
  | 'mcp_discovery'
  | 'skills'
  | 'providers'
  | 'tool_registry'
  | 'egress';

export interface ServePreflightCell extends ServeStatusCell {
  kind: ServePreflightKind;
  locality: 'daemon' | 'acp';
  /** Free-form structured detail (versions, counts, etc.). Never carries secret values. */
  detail?: Record<string, unknown>;
}

export interface ServeWorkspacePreflightStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  /** Always true — daemon-level cells are populated regardless of ACP state. */
  initialized: true;
  acpChannelLive: boolean;
  cells: ServePreflightCell[];
  errors?: ServeStatusCell[];
}

/**
 * The six preflight kinds that require a live ACP child to populate. Shared
 * between `createIdleAcpPreflightCells` (idle placeholder) and the
 * ACP-side `buildAcpPreflightCells` builder so the two sides cannot drift
 * — a future contributor adding a new ACP kind in one place sees the
 * other surface immediately.
 */
export const ACP_PREFLIGHT_KINDS = [
  'auth',
  'mcp_discovery',
  'skills',
  'providers',
  'tool_registry',
  'egress',
] as const satisfies readonly ServePreflightKind[];

/**
 * The narrow union of ACP-locality preflight kinds. Useful for callers
 * that need to dispatch on every ACP kind exhaustively (e.g. the
 * `Record<AcpPreflightKind, …>` builder map in `acpAgent.ts`).
 */
export type AcpPreflightKind = (typeof ACP_PREFLIGHT_KINDS)[number];

/**
 * Idle ACP cells: emitted when the daemon has no live ACP child. The bridge
 * stitches these in alongside its daemon-level cells so `/workspace/preflight`
 * always returns a complete cell set without spawning a child.
 */
export function createIdleAcpPreflightCells(): ServePreflightCell[] {
  return ACP_PREFLIGHT_KINDS.map((kind) => ({
    kind,
    status: 'not_started' as const,
    locality: 'acp' as const,
    hint: 'spawn a session to populate',
  }));
}

const SKILL_PARSE_CODES: ReadonlySet<string> = new Set([
  'PARSE_ERROR',
  'INVALID_CONFIG',
  'INVALID_NAME',
]);

const SKILL_FILE_CODES: ReadonlySet<string> = new Set([
  'FILE_ERROR',
  'NOT_FOUND',
]);

const FS_MISSING_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
]);

// `ModelConfigError` subclasses live inside core's models module and are not
// re-exported on the public package surface. We classify them by the `name`
// field that each subclass sets via `this.name = new.target.name`.
const MODEL_CONFIG_ERROR_NAMES: ReadonlySet<string> = new Set([
  'StrictMissingCredentialsError',
  'StrictMissingModelIdError',
  'MissingApiKeyError',
  'MissingModelError',
  'MissingBaseUrlError',
  'MissingAnthropicBaseUrlEnvError',
]);

/**
 * Map a thrown domain error onto one of the closed `ServeErrorKind` literals
 * so diagnostic cells can render structured remediation. Recognition is
 * `instanceof`-based for bridge-owned errors; cross-package classes
 * (`SkillError`, `TrustGateError`, model-config) are matched by `.code` or
 * `.name` because bundle duplication can break `instanceof` symmetry.
 *
 * Returns `undefined` when no rule matches; callers should leave `errorKind`
 * unset rather than coercing an unrelated error into a misleading category.
 */
export function mapDomainErrorToErrorKind(
  err: unknown,
): ServeErrorKind | undefined {
  if (err instanceof BridgeTimeoutError) return 'init_timeout';
  if (err instanceof BridgeChannelClosedError) return 'protocol_error';
  if (err instanceof MissingCliEntryError) return 'missing_binary';
  // `SkillError` is defined in `@qwen-code/qwen-code-core/skills`; same
  // cross-package bundling concern as `TrustGateError` below — when this
  // function is consumed from outside the monorepo (or under a bundler
  // that doesn't dedupe `file:` workspace deps), the `SkillError` class
  // identity at the throw site (cli's `SkillManager`) can diverge from
  // the one resolved here through acp-bridge's `@qwen-code/qwen-code-core`
  // dependency, silently making `instanceof` return `false` and
  // dropping the skill `errorKind` classification on diagnostic cells.
  // The `OR .name === 'SkillError'` branch keeps classification working
  // regardless of which copy of the class the value carries.

  if (
    err instanceof SkillError ||
    (err as Error | undefined)?.name === 'SkillError'
  ) {
    const code = (err as { code?: string }).code;
    if (code && SKILL_PARSE_CODES.has(code)) return 'parse_error';
    if (code && SKILL_FILE_CODES.has(code)) return 'missing_file';
    return undefined;
  }
  if (err instanceof SyntaxError) return 'parse_error';
  if (!(err instanceof Error)) return undefined;
  // `TrustGateError` is defined in `@qwen-code/qwen-code-core/config`; we
  // match by `.name` rather than `instanceof` because cross-package bundling
  // can produce duplicate class instances where `instanceof` returns false.
  if (err.name === 'TrustGateError') return 'auth_env_error';
  if (MODEL_CONFIG_ERROR_NAMES.has(err.name)) return 'auth_env_error';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && FS_MISSING_CODES.has(code)) {
    return 'missing_file';
  }
  return undefined;
}

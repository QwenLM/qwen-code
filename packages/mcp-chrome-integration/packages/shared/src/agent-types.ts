/**
 * Agent-side shared data contracts.
 * These types are shared between native-server and chrome-extension to ensure consistency.
 *
 * English is used for technical contracts; Chinese comments explain design choices.
 */

// ============================================================
// Core Types
// ============================================================

export type AgentRole = 'user' | 'assistant' | 'tool' | 'system';

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: AgentRole;
  content: string;
  messageType: 'chat' | 'tool_use' | 'tool_result' | 'status';
  cliSource?: string;
  requestId?: string;
  isStreaming?: boolean;
  isFinal?: boolean;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
// Stream Events
// ============================================================

export type StreamTransport = 'sse' | 'websocket';

export interface AgentStatusEvent {
  sessionId: string;
  status: 'starting' | 'ready' | 'running' | 'completed' | 'error' | 'cancelled';
  message?: string;
  requestId?: string;
}

export interface AgentConnectedEvent {
  sessionId: string;
  transport: StreamTransport;
  timestamp: string;
}

export interface AgentHeartbeatEvent {
  timestamp: string;
}

/** Usage statistics for a request */
export interface AgentUsageStats {
  sessionId: string;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
}

export type RealtimeEvent =
  | { type: 'message'; data: AgentMessage }
  | { type: 'status'; data: AgentStatusEvent }
  | { type: 'error'; error: string; data?: { sessionId?: string; requestId?: string } }
  | { type: 'connected'; data: AgentConnectedEvent }
  | { type: 'heartbeat'; data: AgentHeartbeatEvent }
  | { type: 'usage'; data: AgentUsageStats };

// ============================================================
// HTTP API Contracts
// ============================================================

export interface AgentAttachment {
  type: 'file' | 'image';
  name: string;
  mimeType: string;
  dataBase64: string;
}

export type AgentCliPreference = 'claude' | 'codex' | 'cursor' | 'qwen' | 'glm';

export interface AgentActRequest {
  instruction: string;
  cliPreference?: AgentCliPreference;
  model?: string;
  attachments?: AgentAttachment[];
  /**
   * Optional logical project identifier. When provided, the backend
   * can resolve a stable workspace configuration instead of relying
   * solely on ad-hoc paths.
   */
  projectId?: string;
  /**
   * Optional database session ID (sessions.id). When provided, the backend
   * will load session-level configuration (engine, model, permission mode,
   * resume ids, etc.) from the sessions table.
   */
  dbSessionId?: string;
  /**
   * Optional project root / workspace directory on the local filesystem
   * that the engine should use as its working directory.
   */
  projectRoot?: string;
  /**
   * Optional request id from client; server will generate one if missing.
   */
  requestId?: string;
  /**
   * Optional client metadata to store with the user message.
   * For extension-specific context that should be preserved.
   */
  clientMeta?: Record<string, unknown>;
  /**
   * Optional display text override for the instruction.
   * When set, UI should display this instead of raw instruction.
   */
  displayText?: string;
}

export interface AgentActResponse {
  requestId: string;
  sessionId: string;
  status: 'accepted';
}

// ============================================================
// Project & Engine Types
// ============================================================

export interface AgentProject {
  id: string;
  name: string;
  description?: string;
  /**
   * Absolute filesystem path for this project workspace.
   */
  rootPath: string;
  preferredCli?: AgentCliPreference;
  selectedModel?: string;
  /**
   * Active Claude session ID (UUID format) for session resumption.
   * Captured from SDK's system/init message and used for the 'resume' parameter.
   */
  activeClaudeSessionId?: string;
  /**
   * Whether to use Claude Code Router (CCR) for this project.
   * When enabled, the engine will auto-detect CCR configuration.
   */
  useCcr?: boolean;
  /**
   * Whether to enable Chrome MCP integration for this project.
   * Default: true
   */
  enableChromeMcp?: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

export interface AgentEngineInfo {
  name: string;
  supportsMcp?: boolean;
}

// ============================================================
// Session Types
// ============================================================

/**
 * System prompt configuration for a session.
 */
export type AgentSystemPromptConfig =
  | { type: 'custom'; text: string }
  | { type: 'preset'; preset: 'claude_code'; append?: string };

/**
 * Tools configuration - can be a list of tool names or a preset.
 */
export type AgentToolsConfig = string[] | { type: 'preset'; preset: 'claude_code' };

/**
 * Session options configuration.
 */
export interface AgentSessionOptionsConfig {
  settingSources?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: AgentToolsConfig;
  betas?: string[];
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, unknown>;
  outputFormat?: Record<string, unknown>;
  enableFileCheckpointing?: boolean;
  sandbox?: Record<string, unknown>;
  env?: Record<string, string>;
  /**
   * Optional Codex-specific configuration overrides.
   * Only applicable when using CodexEngine.
   */
  codexConfig?: Partial<CodexEngineConfig>;
}

/**
 * Cached management information from Claude SDK.
 */
export interface AgentManagementInfo {
  tools?: string[];
  agents?: string[];
  plugins?: Array<{ name: string; path?: string }>;
  skills?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
  slashCommands?: string[];
  model?: string;
  permissionMode?: string;
  cwd?: string;
  outputStyle?: string;
  betas?: string[];
  claudeCodeVersion?: string;
  apiKeySource?: string;
  lastUpdated?: string;
}

/**
 * Agent session - represents an independent conversation within a project.
 */
export interface AgentSession {
  id: string;
  projectId: string;
  engineName: AgentCliPreference;
  engineSessionId?: string;
  name?: string;
  /** Preview text from first user message, for display in session list */
  preview?: string;
  model?: string;
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  systemPromptConfig?: AgentSystemPromptConfig;
  optionsConfig?: AgentSessionOptionsConfig;
  managementInfo?: AgentManagementInfo;
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for creating a new session.
 */
export interface CreateAgentSessionInput {
  engineName: AgentCliPreference;
  name?: string;
  model?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  systemPromptConfig?: AgentSystemPromptConfig;
  optionsConfig?: AgentSessionOptionsConfig;
}

/**
 * Options for updating a session.
 */
export interface UpdateAgentSessionInput {
  name?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  allowDangerouslySkipPermissions?: boolean | null;
  systemPromptConfig?: AgentSystemPromptConfig | null;
  optionsConfig?: AgentSessionOptionsConfig | null;
}

// ============================================================
// Stored Message (for persistence)
// ============================================================

export interface AgentStoredMessage {
  id: string;
  projectId: string;
  sessionId: string;
  conversationId?: string | null;
  role: AgentRole;
  content: string;
  messageType: AgentMessage['messageType'];
  metadata?: Record<string, unknown>;
  cliSource?: string | null;
  createdAt?: string;
  requestId?: string;
}

// ============================================================
// Codex Engine Configuration
// ============================================================

/**
 * Sandbox mode for Codex CLI execution.
 */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Reasoning effort for Codex models.
 * - low/medium/high: supported by all models
 * - xhigh: only supported by gpt-5.2 and gpt-5.1-codex-max
 */
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Configuration options for Codex Engine.
 * These can be overridden per-session via session settings.
 */
export interface CodexEngineConfig {
  /** Enable apply_patch tool for file modifications. Default: true */
  includeApplyPatchTool: boolean;
  /** Enable plan tool for task planning. Default: true */
  includePlanTool: boolean;
  /** Enable web search capability. Default: true */
  enableWebSearch: boolean;
  /** Use experimental streamable shell tool. Default: true */
  useStreamableShell: boolean;
  /** Sandbox mode for command execution. Default: 'danger-full-access' */
  sandboxMode: CodexSandboxMode;
  /** Maximum number of turns. Default: 20 */
  maxTurns: number;
  /** Maximum thinking tokens. Default: 4096 */
  maxThinkingTokens: number;
  /** Reasoning effort for supported models. Default: 'medium' */
  reasoningEffort: CodexReasoningEffort;
  /** Auto instructions for autonomous behavior. Default: AUTO_INSTRUCTIONS */
  autoInstructions: string;
  /** Append project context (file listing) to prompt. Default: true */
  appendProjectContext: boolean;
}

/**
 * Default auto instructions for Codex to act autonomously.
 * Aligned with other/cweb implementation.
 */
export const CODEX_AUTO_INSTRUCTIONS = `Act autonomously without asking for confirmations.
Use apply_patch to create and modify files directly in the current working directory (do not create subdirectories unless the user explicitly requests it).
Use exec_command to run, build, and test as needed.
You have full permissions. Keep taking concrete actions until the task is complete.
Respect the existing project structure when creating or modifying files.
Prefer concise status updates over questions.`;

/**
 * Default configuration for Codex Engine.
 * Aligned with other/cweb implementation for feature parity.
 */
export const DEFAULT_CODEX_CONFIG: CodexEngineConfig = {
  includeApplyPatchTool: true,
  includePlanTool: true,
  enableWebSearch: true,
  useStreamableShell: true,
  sandboxMode: 'danger-full-access',
  maxTurns: 20,
  maxThinkingTokens: 4096,
  reasoningEffort: 'medium',
  autoInstructions: CODEX_AUTO_INSTRUCTIONS,
  appendProjectContext: true,
};

// ============================================================
// Attachment Types
// ============================================================

/**
 * Metadata for a persisted attachment file.
 */
export interface AttachmentMetadata {
  /** Schema version for forward compatibility */
  version: number;
  /** Kind of attachment (e.g., 'image', 'file') */
  kind: string;
  /** Project ID this attachment belongs to */
  projectId: string;
  /** Message ID this attachment is associated with */
  messageId: string;
  /** Index of this attachment in the message */
  index: number;
  /** Persisted filename under project dir */
  filename: string;
  /** URL path to access this attachment */
  urlPath: string;
  /** MIME type of the attachment */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Original filename from upload */
  originalName: string;
  /** Timestamp when attachment was created */
  createdAt: string;
}

/**
 * Statistics for attachments in a single project.
 */
export interface AttachmentProjectStats {
  projectId: string;
  /** Directory path for this project's attachments */
  dirPath: string;
  /** Whether the directory exists */
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  /** Last modification timestamp (only when exists is true) */
  lastModifiedAt?: string;
}

/**
 * Cleanup result for a single project.
 */
export interface CleanupProjectResult {
  projectId: string;
  dirPath: string;
  existed: boolean;
  removedFiles: number;
  removedBytes: number;
}

/**
 * Response for attachment statistics endpoint.
 */
export interface AttachmentStatsResponse {
  success: boolean;
  rootDir: string;
  totalFiles: number;
  totalBytes: number;
  projects: Array<
    AttachmentProjectStats & {
      projectName?: string;
      existsInDb: boolean;
    }
  >;
  orphanProjectIds: string[];
}

/**
 * Request body for attachment cleanup endpoint.
 */
export interface AttachmentCleanupRequest {
  /** If provided, cleanup only these projects. Otherwise cleanup all. */
  projectIds?: string[];
}

/**
 * Response for attachment cleanup endpoint.
 */
export interface AttachmentCleanupResponse {
  success: boolean;
  scope: 'project' | 'selected' | 'all';
  removedFiles: number;
  removedBytes: number;
  results: CleanupProjectResult[];
}

// ============================================================
// Open Project Types
// ============================================================

/**
 * Target application for opening a project directory.
 */
export type OpenProjectTarget = 'vscode' | 'terminal';

/**
 * Request body for open-project endpoint.
 */
export interface OpenProjectRequest {
  /** Target application to open the project in */
  target: OpenProjectTarget;
}

/**
 * Response for open-project endpoint.
 */
export type OpenProjectResponse = { success: true } | { success: false; error: string };

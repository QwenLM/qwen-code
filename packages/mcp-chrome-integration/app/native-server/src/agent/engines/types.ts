import type { AgentAttachment, RealtimeEvent } from '../types';
import type { CodexEngineConfig } from 'chrome-mcp-shared';

export interface EngineInitOptions {
  sessionId: string;
  instruction: string;
  model?: string;
  projectRoot?: string;
  requestId: string;
  /**
   * AbortSignal for cancellation support.
   */
  signal?: AbortSignal;
  /**
   * Optional attachments (images/files) to include with the instruction.
   * Note: When using persisted attachments, use resolvedImagePaths instead.
   */
  attachments?: AgentAttachment[];
  /**
   * Resolved absolute paths to persisted image files.
   * These are used by engines instead of writing temp files from base64.
   * Set by chat-service after saving attachments to persistent storage.
   */
  resolvedImagePaths?: string[];
  /**
   * Optional project ID for session persistence.
   * When provided, engines can use this to save/load session state.
   */
  projectId?: string;
  /**
   * Optional database session ID (sessions.id) for session-scoped configuration and persistence.
   */
  dbSessionId?: string;
  /**
   * Optional session-scoped permission mode override (Claude SDK option).
   */
  permissionMode?: string;
  /**
   * Optional session-scoped permission bypass override (Claude SDK option).
   */
  allowDangerouslySkipPermissions?: boolean;
  /**
   * Optional session-scoped system prompt configuration.
   */
  systemPromptConfig?: unknown;
  /**
   * Optional session-scoped engine option overrides.
   */
  optionsConfig?: unknown;
  /**
   * Optional Claude session ID (UUID) for resuming a previous session.
   * Only applicable to ClaudeEngine; retrieved from sessions.engineSessionId (preferred)
   * or project's activeClaudeSessionId (legacy fallback).
   */
  resumeClaudeSessionId?: string;
  /**
   * Whether to use Claude Code Router (CCR) for this request.
   * Only applicable to ClaudeEngine; when true, CCR will be auto-detected.
   */
  useCcr?: boolean;
  /**
   * Optional Codex-specific configuration overrides.
   * Only applicable to CodexEngine; merged with DEFAULT_CODEX_CONFIG.
   */
  codexConfig?: Partial<CodexEngineConfig>;
}

/**
 * Callback to persist Claude session ID after initialization.
 */
export type ClaudeSessionPersistCallback = (sessionId: string) => Promise<void>;

/**
 * Management information extracted from Claude SDK system:init message.
 */
export interface ClaudeManagementInfo {
  tools?: string[];
  agents?: string[];
  /** Plugins with name and path (SDK returns { name, path }[]) */
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
}

/**
 * Callback to persist management information after SDK initialization.
 */
export type ManagementInfoPersistCallback = (info: ClaudeManagementInfo) => Promise<void>;

export type EngineName = 'claude' | 'codex' | 'cursor' | 'qwen' | 'glm';

export interface EngineExecutionContext {
  /**
   * Emit a realtime event to all connected clients for the current session.
   */
  emit(event: RealtimeEvent): void;
  /**
   * Optional callback to persist Claude session ID after SDK initialization.
   * Only called by ClaudeEngine when projectId is provided.
   */
  persistClaudeSessionId?: ClaudeSessionPersistCallback;
  /**
   * Optional callback to persist management information after SDK initialization.
   * Only called by ClaudeEngine when dbSessionId is provided.
   */
  persistManagementInfo?: ManagementInfoPersistCallback;
}

export interface AgentEngine {
  name: EngineName;
  /**
   * Whether this engine can act as an MCP client natively.
   */
  supportsMcp?: boolean;
  initializeAndRun(options: EngineInitOptions, ctx: EngineExecutionContext): Promise<void>;
}

/**
 * Represents a running engine execution that can be cancelled.
 */
export interface RunningExecution {
  requestId: string;
  sessionId: string;
  engineName: EngineName;
  abortController: AbortController;
  startedAt: Date;
}

/**
 * Backend Abstraction Types
 *
 * Defines the core interface that AI backends must implement.
 * The CraftAgent facade delegates to the backend runtime while
 * maintaining a consistent API surface.
 *
 * Key design decisions:
 * - Provider-agnostic events: All backends emit the same AgentEvent types
 * - Capabilities-driven UI: Model/thinking selectors read from capabilities()
 * - Callback pattern: Facade sets callbacks after creating backend
 * - AsyncGenerator for streaming: Consistent with existing CraftAgent API
 */

import type {
  AgentEvent,
  AskUserQuestionItem,
  AvailableSlashCommand,
  AvailableSkillDetail,
  Message,
  MessageTextElement,
} from '@craft-agent/core/types'
import type { FileAttachment } from '../../utils/files.ts'
import type { ThinkingLevel } from '../thinking-levels.ts'
import type { PermissionMode } from '../mode-manager.ts'
import type { LoadedSource } from '../../sources/types.ts'
import type { AuthRequest } from '../session-scoped-tools.ts'
import type { McpClientPool } from '../../mcp/mcp-pool.ts'
import type { Workspace } from '../../config/storage.ts'
import type { SessionConfig as Session } from '../../sessions/storage.ts'
import type { SourceManager } from '../core/source-manager.ts'

// Import AbortReason and RecoveryMessage from core module (single source of truth)
import { AbortReason, type RecoveryMessage } from '../core/index.ts'
export { AbortReason, type RecoveryMessage }

import type { ModelDefinition, ModelProvider } from '../../config/models.ts'

// Import LLM connection types for auth
import type {
  LlmAuthType,
  LlmProviderType,
} from '../../config/llm-connections.ts'
export type {
  LlmAuthType,
  LlmProviderType,
} from '../../config/llm-connections.ts'
import type { AutomationSystem } from '../../automations/index.ts'
import type {
  PermissionResponseOptions,
  QwenSkillDeleteRequest,
  QwenSkillDeleteResult,
  QwenSkillInstallRequest,
  QwenSkillInstallResult,
  QwenSkillSetEnabledRequest,
  QwenSkillSetEnabledResult,
} from '../../protocol/dto.ts'

/**
 * Provider identifier for AI backends.
 * @deprecated Use ModelProvider from config/models.ts instead
 */
export type AgentProvider = ModelProvider

// ============================================================
// Callback Types
// ============================================================

/**
 * Permission prompt types for different tool categories.
 */
export type PermissionRequestType =
  | 'bash'
  | 'file_write'
  | 'mcp_mutation'
  | 'api_mutation'
  | 'admin_approval'
  | 'ask_user_question'

/**
 * Permission request callback signature.
 * Called when a tool requires user permission before execution.
 */
export type PermissionCallback = (request: {
  requestId: string
  toolName: string
  command?: string
  description: string
  type?: PermissionRequestType
  appName?: string
  reason?: string
  impact?: string
  requiresSystemPrompt?: boolean
  rememberForMinutes?: number
  commandHash?: string
  approvalTtlSeconds?: number
  questions?: AskUserQuestionItem[]
  metadata?: {
    source?: string
  }
}) => void

/**
 * Plan submission callback signature.
 * Called when agent submits a plan for user review.
 */
export type PlanCallback = (planPath: string) => void

/**
 * Auth request callback signature.
 * Called when a source requires authentication.
 */
export type AuthCallback = (request: AuthRequest) => void

/**
 * Source change callback signature.
 * Called when a source is activated, deactivated, or modified.
 */
export type SourceChangeCallback = (
  slug: string,
  source: LoadedSource | null,
) => void

/**
 * Source activation request callback.
 * Returns true if source was successfully activated.
 */
export type SourceActivationCallback = (sourceSlug: string) => Promise<boolean>

// ============================================================
// Lifecycle Types
// ============================================================

/**
 * Result of backend post-initialization (auth injection, config setup).
 * Returned by postInit() so the session layer can surface warnings.
 */
export interface PostInitResult {
  /** Whether auth credentials were successfully injected */
  authInjected: boolean
  /** Optional warning message to surface in UI */
  authWarning?: string
  /** Severity level for the warning */
  authWarningLevel?: 'error' | 'warning' | 'info'
}

export interface AvailableCommandsSnapshot {
  availableCommands: AvailableSlashCommand[]
  availableSkills?: string[]
  availableSkillDetails?: AvailableSkillDetail[]
}

export interface BackendSessionMessagesResult
  extends Partial<AvailableCommandsSnapshot> {
  messages: Message[]
}

export interface BackendRewindResult {
  historyBeforeRewind?: unknown[]
  targetTurnIndex?: number
  apiTruncateIndex?: number
}

/**
 * Context for applying bridge/config updates mid-session.
 * Used when sources change, tokens refresh, or auth completes.
 */
export interface BridgeUpdateContext {
  /** Path to the session folder */
  sessionPath: string
  /** Currently enabled sources */
  enabledSources: LoadedSource[]
  /** Pre-built MCP server configs */
  mcpServers: Record<string, SdkMcpServerConfig>
  /** Session ID */
  sessionId: string
  /** Workspace root path */
  workspaceRootPath: string
  /** Descriptive context for logging (e.g., 'token refresh', 'source enable') */
  context: string
  /** URL of the McpPoolServer HTTP endpoint */
  poolServerUrl?: string
}

/**
 * Host runtime context passed from the application shell (Electron/CLI/etc.).
 * This is intentionally provider-agnostic metadata; backend drivers resolve
 * provider-specific paths from this context internally.
 */
export interface BackendHostRuntimeContext {
  /** App root path (packaged app path or repository root in development) */
  appRootPath: string
  /** Optional resources path (needed for packaged Windows runtime resolution) */
  resourcesPath?: string
  /** Whether the host app is running as a packaged build */
  isPackaged: boolean
  /** Optional runtime override for Node/Bun executable */
  nodeRuntimePath?: string
  /** Optional interceptor bundle override (CJS bundle loaded via --require) */
  interceptorBundlePath?: string
}

/**
 * Provider-agnostic backend configuration used by the session layer.
 * Provider-specific runtime details are resolved by backend drivers internally.
 */
export interface CoreBackendConfig {
  /** Workspace configuration */
  workspace: Workspace

  /** Session configuration (for resume) */
  session?: Session

  /** Initial model ID */
  model?: string

  /** Mini/utility model for summarization/title generation/mini-completions */
  miniModel?: string

  /** Initial thinking level */
  thinkingLevel?: ThinkingLevel

  /** Headless mode flag (disables interactive tools) */
  isHeadless?: boolean

  /** Skip agent-level config file watching (server already owns a workspace-level watcher) */
  skipConfigWatcher?: boolean

  /** Debug mode configuration */
  debugMode?: {
    enabled: boolean
    logFilePath?: string
  }

  /** System prompt preset ('default' | 'mini' | custom string) */
  systemPromptPreset?: 'default' | 'mini' | string

  /** Workspace-level automation system for user-defined automations (automations.json) */
  automationSystem?: AutomationSystem

  /**
   * Per-session environment variable overrides for the SDK subprocess.
   * Spread after process.env in backend-specific option builders.
   */
  envOverrides?: Record<string, string>

  /**
   * Centralized MCP client pool for source tool execution.
   * Owns all MCP source connections in the main process.
   */
  mcpPool?: McpClientPool

  /**
   * URL of the McpPoolServer HTTP endpoint for this session.
   * External SDK subprocesses connect here to access pool-managed MCP tools.
   */
  poolServerUrl?: string

  /** Callback when SDK session ID is captured/updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void

  /** Callback when SDK session ID is cleared (e.g., after failed resume) */
  onSdkSessionIdCleared?: () => void

  /**
   * Callback when ACP has consumed queued mid-turn user messages.
   * Hosts can use this as an acknowledgement to remove replay fallbacks.
   */
  onMidTurnMessagesDrained?: (messages: string[]) => void

  /** Callback when a backend reports its live model list for the session. */
  onAvailableModelsUpdate?: (
    models: ModelDefinition[],
    currentModelId?: string,
  ) => void

  /** Callback to get recent messages for recovery context */
  getRecoveryMessages?: () => RecoveryMessage[]

  /**
   * Get ALL parent messages for branch fork fallback (not limited to 6).
   * Called when SDK-level branch fork fails and we need to summarize
   * the parent conversation for context injection via mini completion.
   * Returns empty array for non-branched sessions.
   */
  getBranchFallbackMessages?: () => RecoveryMessage[]

  /**
   * Callback to get branch seed messages (up to branch cutoff) for first turn in seeded branch mode.
   * When provided and non-empty, BaseAgent injects a hidden context block before the first user turn.
   */
  getBranchSeedMessages?: () => RecoveryMessage[]

  /** Callback invoked after branch seed context has been injected. */
  markBranchSeedApplied?: () => void

  /** One-shot hidden summary to inject on the first turn of a transferred session. */
  getTransferredSessionSummary?: () => string | null

  /** Callback invoked after transferred session summary has been injected. */
  markTransferredSessionSummaryApplied?: () => void

  /**
   * Optional callback to resize an oversized image for API compatibility.
   * Called from PreToolUse when Read targets an image exceeding the base64 size limit.
   * Returns path to the resized temp file, or null if resize not possible.
   * Provided by the host app (Electron uses nativeImage, server could use sharp, etc.).
   */
  onImageResize?: (
    filePath: string,
    maxSizeBytes: number,
  ) => Promise<string | null>

  /** Enable 1M context window for Opus 4.7. Default: true. Set false to use 200K and conserve usage limits. */
  enable1MContext?: boolean

  /**
   * Pre-computed source configurations for initial setup.
   * Passed at construction so backends can set up sources in postInit().
   */
  initialSources?: {
    enabledSources: LoadedSource[]
    mcpServers: Record<string, SdkMcpServerConfig>
    apiServers: Record<string, unknown>
    enabledSlugs: string[]
  }
}

// ============================================================
// Backend Interface
// ============================================================

/**
 * Options for the chat method.
 */
export interface ChatOptions {
  /** Retry flag (internal use for session recovery) */
  isRetry?: boolean
  /** Override thinking level for this message only */
  thinkingOverride?: ThinkingLevel
  /** Semantic annotations for the user-authored text. */
  textElements?: MessageTextElement[]
}

export interface BackendSessionInfo {
  sessionId: string
  cwd: string
  title?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  startTime?: string | null
  preview?: string | null
  messageCount?: number | null
  gitBranch?: string | null
  titleSource?: 'manual' | 'auto' | null
}

export interface BackendSessionListOptions {
  cwd?: string
  cursor?: string | null
  size?: number
}

export interface BackendSessionListResult {
  sessions: BackendSessionInfo[]
  nextCursor?: string | null
}

/**
 * SDK-compatible MCP server configuration.
 * Supports HTTP/SSE (remote) and stdio (local subprocess) transports.
 */
export type SdkMcpServerConfig =
  | {
      type: 'http' | 'sse'
      url: string
      headers?: Record<string, string>
      /** Environment variable name containing bearer token (Codex-specific) */
      bearerTokenEnvVar?: string
    }
  | {
      type: 'stdio'
      command: string
      args?: string[]
      /** Environment variables to set (literal values) */
      env?: Record<string, string>
      /** Environment variable names to forward from parent process (Codex-specific) */
      envVars?: string[]
      /** Working directory for the server process (Codex-specific) */
      cwd?: string
    }

/**
 * Core backend interface - all AI providers must implement this.
 *
 * The interface is designed to:
 * 1. Abstract provider/runtime differences
 * 2. Enable the facade pattern in CraftAgent
 * 3. Support streaming via AsyncGenerator
 * 4. Allow capability-based UI adaptation
 */
export interface AgentBackend {
  // ============================================================
  // Chat & Lifecycle
  // ============================================================

  /**
   * Send a message and stream back events.
   * This is the core agentic loop - handles tool execution, permission checks, etc.
   *
   * @param message - User message text
   * @param attachments - Optional file attachments
   * @param options - Optional chat configuration
   * @yields AgentEvent stream
   */
  chat(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent>

  /**
   * Abort current query (user stop or internal abort).
   *
   * @param reason - Optional reason for abort (for logging/debugging)
   */
  abort(reason?: string): Promise<void>

  /**
   * Force abort with specific reason.
   * Used for true hard-stop semantics (user stop, redirect fallback, teardown).
   *
   * @param reason - AbortReason enum value
   */
  forceAbort(reason: AbortReason): void

  /**
   * Interrupt the current turn because control is being handed to the UI.
   *
   * Used for pause points like plan submission and auth requests, where the
   * session should stop cleanly without necessarily using the backend's
   * hardest abort primitive.
   *
   * @param reason - AbortReason enum value for the handoff boundary
   */
  interruptForHandoff(reason: AbortReason): void

  /**
   * Redirect the agent mid-stream with a new user message.
   * Called when the user sends a message while the agent is still processing.
   *
   * Each backend decides its own strategy:
   * - Backends with native steering inject the message into the
   *   current stream and return true — events continue through the existing
   *   generator, no abort needed.
   * - Backends without steering call forceAbort(Redirect) internally and
   *   return false — the session layer queues the message for re-send.
   *
   * @param message - The new user message
   * @returns true if steered (events flow through existing stream),
   *          false if aborted (session layer must queue + re-send)
   */
  redirect(message: string): boolean

  /**
   * Queue a user message for injection at the next safe tool-result boundary
   * inside the current turn.
   *
   * The session layer keeps its own replay fallback until the backend confirms
   * the message was drained, so backends can accept candidates before knowing
   * whether this turn will actually produce a tool boundary.
   */
  enqueueMidTurnMessage?(message: string): boolean

  /**
   * Run a simple text completion using the backend's auth infrastructure.
   * Used for connection testing, title generation, and summarization.
   */
  runMiniCompletion(prompt: string): Promise<string | null>

  /**
   * List provider-native sessions when supported by the backend.
   *
   * ACP-backed providers use this to expose CLI/native history to the app
   * without parsing provider-private storage directly.
   */
  listSessions?(
    options?: BackendSessionListOptions,
  ): Promise<BackendSessionListResult>

  /** Delete a provider-native session when supported. */
  deleteBackendSession?(
    sessionId: string,
    options?: { cwd?: string },
  ): Promise<boolean>

  /** Rename a provider-native session when supported. */
  renameBackendSession?(
    sessionId: string,
    title: string,
    options?: { cwd?: string },
  ): Promise<boolean>

  /** Load provider-native transcript messages when supported. */
  loadSessionMessages?(
    sessionId: string,
    options?: { cwd?: string },
  ): Promise<Message[] | BackendSessionMessagesResult>

  /** Refresh provider-advertised slash commands when supported. */
  refreshAvailableCommands?(): Promise<AvailableCommandsSnapshot | null>

  /** Install a provider-native skill when supported. */
  installSkill?(
    request: QwenSkillInstallRequest,
  ): Promise<QwenSkillInstallResult>

  /** Delete a provider-native skill when supported. */
  deleteSkill?(request: QwenSkillDeleteRequest): Promise<QwenSkillDeleteResult>

  /** Enable or disable a provider-native skill when supported. */
  setSkillEnabled?(
    request: QwenSkillSetEnabledRequest,
  ): Promise<QwenSkillSetEnabledResult>

  /** Rewind provider-native history to before a zero-based user turn. */
  rewindToUserTurn?(targetTurnIndex: number): Promise<BackendRewindResult>

  /**
   * Clean up resources (MCP connections, watchers, etc.)
   */
  destroy(): void

  /**
   * Alias for destroy() for consistency.
   */
  dispose(): void

  /**
   * Post-construction initialization.
   * Handles auth injection, initial config generation, etc.
   * Called after construction and callback wiring, before first chat().
   */
  postInit(): Promise<PostInitResult>

  /**
   * Apply bridge/config updates mid-session.
   * Called when sources change, tokens refresh, or auth completes.
   * Each backend implements its own strategy.
   */
  applyBridgeUpdates(context: BridgeUpdateContext): Promise<void>

  /**
   * Ensure branch sessions are backend-ready before first user message.
   * Called at branch creation time to avoid creating "fake branches" that have
   * copied transcript history but no actual backend branch context.
   *
   * Default behavior can be a no-op for providers that don't need preflight.
   */
  ensureBranchReady(): Promise<void>

  /**
   * Check if currently processing a query.
   */
  isProcessing(): boolean

  // ============================================================
  // Model & Thinking Configuration
  // ============================================================

  /** Get current model ID */
  getModel(): string

  /** Set model (should validate against capabilities) */
  setModel(model: string): void

  /** Get current thinking level */
  getThinkingLevel(): ThinkingLevel

  /** Set thinking level */
  setThinkingLevel(level: ThinkingLevel): void

  // ============================================================
  // Permission Mode
  // ============================================================

  /** Get current permission mode */
  getPermissionMode(): PermissionMode

  /** Set permission mode */
  setPermissionMode(mode: PermissionMode): void

  /** Cycle to next permission mode */
  cyclePermissionMode(): PermissionMode

  // ============================================================
  // State
  // ============================================================

  /** Get SDK session ID (for resume, null if no session) */
  getSessionId(): string | null

  /** Whether this backend supports session branching */
  readonly supportsBranching: boolean

  // ============================================================
  // Source Management
  // ============================================================

  /**
   * Set the MCP server configurations for sources.
   * Called by facade when sources are activated/deactivated.
   *
   * @param mcpServers Pre-built MCP server configs with auth headers
   * @param apiServers In-process MCP servers for REST APIs
   * @param intendedSlugs Source slugs that should be considered active
   */
  setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
  ): void | Promise<void>

  /**
   * Get currently active source slugs.
   */
  getActiveSourceSlugs(): string[]

  /**
   * Get the raw user message for the current turn (cleared between turns).
   * Used by SessionManager.activateSourceInSessionFn to capture the message
   * that should be re-sent after a source_test-triggered auto-restart.
   */
  getCurrentTurnUserMessage(): string | null

  /**
   * Schedule a source-activation auto-restart. Consumed by the backend's
   * event loop after the next tool_result, which yields `source_activated`
   * and `forceAbort`s the turn — triggering the renderer's existing
   * auto_retry effect. Set by SessionManager after a successful mid-turn
   * activation (source_test auto-enable).
   */
  setPendingSourceActivationRestart(pending: {
    sourceSlug: string
    userMessage: string
  }): void

  /**
   * Get all sources (for context injection).
   */
  getAllSources(): LoadedSource[]

  /**
   * Set all sources (for context injection).
   */
  setAllSources(sources: LoadedSource[]): void

  /**
   * Mark a source as unseen (will show introduction text again).
   */
  markSourceUnseen(sourceSlug: string): void

  /**
   * Get a bound summarize callback for passing to API tool builders.
   */
  getSummarizeCallback(): (prompt: string) => Promise<string | null>

  // ============================================================
  // Session & Workspace State
  // ============================================================

  /** Update the working directory */
  updateWorkingDirectory(path: string): void

  /** Update the SDK cwd (transcript storage location) */
  updateSdkCwd(path: string): void

  /** Set workspace configuration */
  setWorkspace(workspace: Workspace): void

  /** Set session ID */
  setSessionId(sessionId: string | null): void

  /** Get SourceManager for advanced queries */
  getSourceManager(): SourceManager

  /** Generate a session title from user message */
  generateTitle(
    message: string,
    options?: { language?: string },
  ): Promise<string | null>

  /** Regenerate a session title from recent conversation */
  regenerateTitle(
    recentUserMessages: string[],
    lastAssistantResponse: string,
    options?: { language?: string },
  ): Promise<string | null>

  // ============================================================
  // Permission Resolution
  // ============================================================

  /**
   * Respond to a pending permission request.
   *
   * @param requestId - Permission request ID
   * @param allowed - Whether permission was granted
   * @param alwaysAllow - Whether to remember this permission for session
   */
  respondToPermission(
    requestId: string,
    allowed: boolean,
    alwaysAllow?: boolean,
    options?: PermissionResponseOptions,
  ): void

  // ============================================================
  // Callbacks (set by facade after construction)
  // ============================================================

  /** Called when a tool requires permission */
  onPermissionRequest: PermissionCallback | null

  /** Called when agent submits a plan */
  onPlanSubmitted: PlanCallback | null

  /** Called when a source requires authentication */
  onAuthRequest: AuthCallback | null

  /** Called when a source config changes */
  onSourceChange: SourceChangeCallback | null

  /** Called when permission mode changes */
  onPermissionModeChange: ((mode: PermissionMode) => void) | null

  /** Called with debug messages */
  onDebug: ((message: string) => void) | null

  /** Called when a source tool is used but source isn't active */
  onSourceActivationRequest: SourceActivationCallback | null

  /**
   * Called when backend-specific authentication is required.
   * Replaces per-backend auth callbacks.
   * The session layer wires this to surface auth warnings in the UI.
   */
  onBackendAuthRequired: ((reason: string) => void) | null

  /** Called when agent requests spawning a new session */
  onSpawnSession:
    | ((
        request: import('../base-agent.ts').SpawnSessionRequest,
      ) => Promise<import('../base-agent.ts').SpawnSessionResult>)
    | null
}

/**
 * Configuration for creating a backend.
 */
export interface BackendConfig extends CoreBackendConfig {
  /**
   * Provider/runtime to use for this backend.
   * Qwen-only builds instantiate QwenAgent.
   */
  provider: AgentProvider

  /**
   * Full provider type from LLM connection.
   * Includes compat variants and cloud providers.
   * Used for routing validation, credential lookup, etc.
   */
  providerType?: LlmProviderType

  /**
   * Authentication mechanism from LLM connection.
   * Determines how credentials are retrieved and passed to the backend.
   */
  authType?: LlmAuthType

  /**
   * @deprecated Use authType instead. Kept for backwards compatibility.
   */
  legacyAuthType?: 'api_key' | 'oauth_token'

  /** MCP token override (for testing) */
  mcpToken?: string

  /**
   * Connection slug for credential routing.
   * Set by factory when creating from a connection.
   * Used to read/write credentials under the correct key.
   */
  connectionSlug?: string

  /** Workspace-level automation system for user-defined SDK hooks (automations.json) */
  automationSystem?: AutomationSystem

  /**
   * Opaque runtime payload resolved by backend drivers.
   * This keeps provider-specific runtime details out of the public config surface.
   */
  runtime?: Record<string, unknown>
}

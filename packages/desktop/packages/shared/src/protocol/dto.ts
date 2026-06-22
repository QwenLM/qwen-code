/**
 * Server DTO types — data shapes used by RPC handlers and SessionManager.
 *
 * These were previously in apps/electron/src/shared/types.ts.
 * Extracted here so handler code in @craft-agent/server-core can import
 * from @craft-agent/shared/protocol without reaching into the app.
 */

import type {
  Message,
  TypedError,
  MessageTextElement,
  ToolDisplayMeta,
  AnnotationV1,
  WorkspaceKind,
  PermissionRequest as BasePermissionRequest,
  AvailableSlashCommand as BaseAvailableSlashCommand,
  AvailableSkillDetail as BaseAvailableSkillDetail,
} from '@craft-agent/core/types'
import type { PermissionMode } from '../agent/mode-types'
import type { ThinkingLevel } from '../agent/thinking-levels'
import type {
  AuthRequest as SharedAuthRequest,
  CredentialInputMode as SharedCredentialInputMode,
  CredentialAuthRequest as SharedCredentialAuthRequest,
} from '../agent/index'

// Re-export generateMessageId for handler convenience
export { generateMessageId } from '@craft-agent/core/types'
export type AvailableSlashCommand = BaseAvailableSlashCommand
export type AvailableSkillDetail = BaseAvailableSkillDetail

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/**
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string

export type BuiltInStatusId =
  | 'todo'
  | 'in-progress'
  | 'needs-review'
  | 'done'
  | 'cancelled'

/**
 * Electron-specific Session type (includes runtime state).
 * Extends core Session with messages array and processing state.
 */
export interface Session {
  id: string
  workspaceId: string
  workspaceName: string
  name?: string
  /** Preview of first user message (from JSONL header, for lazy-loaded sessions) */
  preview?: string
  lastMessageAt: number
  messages: Message[]
  isProcessing: boolean
  isFlagged?: boolean
  /** Permission mode for this session */
  permissionMode?: PermissionMode
  sessionStatus?: SessionStatus
  /** Labels (additive tags, many-per-session — bare IDs or "id::value" entries) */
  labels?: string[]
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  enabledSourceSlugs?: string[]
  workingDirectory?: string
  sessionFolderPath?: string
  sharedUrl?: string
  sharedId?: string
  model?: string
  llmConnection?: string
  thinkingLevel?: ThinkingLevel
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  lastFinalMessageId?: string
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  currentStatus?: {
    message: string
    statusType?: string
  }
  createdAt?: number
  messageCount?: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  isArchived?: boolean
  archivedAt?: number
  supportsBranching?: boolean
  /** Provider-advertised slash commands for the current session. Runtime-only. */
  availableCommands?: AvailableSlashCommand[]
  /** Provider-advertised skill command names for the current session. Runtime-only. */
  availableSkills?: string[]
  /** Provider-advertised skill metadata for the current session. Runtime-only. */
  availableSkillDetails?: AvailableSkillDetail[]
}

export interface CreateSessionOptions {
  name?: string
  /** Optional prompt/title text used only to generate a readable session folder id. */
  slugHint?: string
  permissionMode?: PermissionMode
  /**
   * Reasoning/thinking level override. When set, takes precedence over workspace
   * and global defaults. Silently ignored by the underlying SDK on non-reasoning
   * models (e.g. gpt-4o) — provider drivers don't attach the reasoning param to
   * the API request for models with `reasoning: false` in the model catalog.
   */
  thinkingLevel?: ThinkingLevel
  /**
   * Working directory for the session:
   * - 'user_default' or undefined: Use workspace's configured default working directory
   * - 'none': No working directory (session folder only)
   * - Absolute path string: Use this specific path
   */
  workingDirectory?: string | 'user_default' | 'none'
  model?: string
  llmConnection?: string
  systemPromptPreset?: 'default' | 'mini' | string
  hidden?: boolean
  sessionStatus?: SessionStatus
  labels?: string[]
  isFlagged?: boolean
  enabledSourceSlugs?: string[]
  /**
   * Message ID to branch from. This is a hard context cutoff:
   * the new session must not include model context from later parent messages.
   */
  branchFromMessageId?: string
  /** Parent session ID used together with branchFromMessageId. */
  branchFromSessionId?: string
}

export interface RefreshAvailableCommandsOptions {
  workspaceId?: string
  workingDirectory?: string
  llmConnection?: string
  model?: string
  permissionMode?: PermissionMode
  thinkingLevel?: ThinkingLevel
  enabledSourceSlugs?: string[]
}

export interface RemoteSessionTransferPayload {
  sourceSessionId: string
  name?: string
  sessionStatus?: SessionStatus
  labels?: string[]
  permissionMode?: PermissionMode
  summary: string
}

export interface ImportRemoteSessionTransferResult {
  sessionId: string
}

export interface PermissionModeState {
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion: number
  changedAt: string
  changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

// ---------------------------------------------------------------------------
// Session events (main → renderer)
// ---------------------------------------------------------------------------

interface SessionEventContext {
  workspaceId?: string
}

// turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
export type SessionEvent = (
  | { type: 'text_delta'; sessionId: string; delta: string; turnId?: string }
  | {
      type: 'text_complete'
      sessionId: string
      text: string
      isIntermediate?: boolean
      intermediateKind?: 'commentary' | 'thought'
      turnId?: string
      parentToolUseId?: string
      timestamp?: number
      messageId?: string
    }
  | {
      type: 'tool_start'
      sessionId: string
      toolName: string
      toolUseId: string
      toolInput: Record<string, unknown>
      toolIntent?: string
      toolDisplayName?: string
      toolDisplayMeta?: ToolDisplayMeta
      turnId?: string
      parentToolUseId?: string
      timestamp?: number
    }
  | {
      type: 'tool_result'
      sessionId: string
      toolUseId: string
      toolName: string
      result: string
      turnId?: string
      parentToolUseId?: string
      isError?: boolean
      timestamp?: number
    }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | {
      type: 'typed_error'
      sessionId: string
      error: TypedError
      timestamp?: number
    }
  | {
      type: 'complete'
      sessionId: string
      tokenUsage?: Session['tokenUsage']
      hasUnread?: boolean
    }
  | {
      type: 'interrupted'
      sessionId: string
      message?: Message
      queuedMessages?: string[]
    }
  | {
      type: 'status'
      sessionId: string
      message: string
      statusType?: 'compacting'
    }
  | {
      type: 'info'
      sessionId: string
      message: string
      statusType?: 'compaction_complete'
      level?: 'info' | 'warning' | 'error' | 'success'
      timestamp?: number
    }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | {
      type: 'working_directory_changed'
      sessionId: string
      workingDirectory: string
    }
  | {
      type: 'permission_request'
      sessionId: string
      request: PermissionRequest
    }
  | {
      type: 'credential_request'
      sessionId: string
      request: CredentialRequest
    }
  | {
      type: 'permission_mode_changed'
      sessionId: string
      permissionMode: PermissionMode
      previousPermissionMode?: PermissionMode
      transitionDisplay?: string
      modeVersion?: number
      changedAt?: string
      changedBy?: PermissionModeState['changedBy']
    }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'sources_changed'; sessionId: string; enabledSourceSlugs: string[] }
  | { type: 'labels_changed'; sessionId: string; labels: string[] }
  | {
      type: 'connection_changed'
      sessionId: string
      connectionSlug: string
      supportsBranching?: boolean
    }
  | {
      type: 'task_backgrounded'
      sessionId: string
      toolUseId: string
      taskId: string
      intent?: string
      turnId?: string
    }
  | {
      type: 'shell_backgrounded'
      sessionId: string
      toolUseId: string
      shellId: string
      intent?: string
      command?: string
      turnId?: string
    }
  | {
      type: 'task_progress'
      sessionId: string
      toolUseId: string
      elapsedSeconds: number
      turnId?: string
    }
  | {
      type: 'task_completed'
      sessionId: string
      taskId: string
      status: 'completed' | 'failed' | 'stopped'
      outputFile?: string
      summary?: string
      turnId?: string
    }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | {
      type: 'user_message'
      sessionId: string
      message: Message
      status: 'accepted' | 'queued' | 'processing'
      optimisticMessageId?: string
    }
  | { type: 'session_flagged'; sessionId: string }
  | { type: 'session_unflagged'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | { type: 'session_model_changed'; sessionId: string; model: string | null }
  | {
      type: 'session_status_changed'
      sessionId: string
      sessionStatus: SessionStatus
    }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | {
      // Emitted when a session's id is canonicalized in place (e.g. a Qwen
      // managed session adopting the ACP/SDK session id after the first turn).
      // This is a rename, NOT a delete+create: renderers must migrate the
      // active selection and per-session state from previousId -> sessionId.
      type: 'session_id_changed'
      previousId: string
      sessionId: string
    }
  | { type: 'session_shared'; sessionId: string; sharedUrl: string }
  | { type: 'session_unshared'; sessionId: string }
  | {
      type: 'auth_request'
      sessionId: string
      message: Message
      request: SharedAuthRequest
    }
  | {
      type: 'auth_completed'
      sessionId: string
      requestId: string
      success: boolean
      cancelled?: boolean
      error?: string
    }
  | {
      type: 'source_activated'
      sessionId: string
      sourceSlug: string
      originalMessage: string
    }
  | {
      type: 'usage_update'
      sessionId: string
      tokenUsage: { inputTokens: number; contextWindow?: number }
    }
  | {
      type: 'available_commands_update'
      sessionId: string
      availableCommands: AvailableSlashCommand[]
      availableSkills?: string[]
      availableSkillDetails?: AvailableSkillDetail[]
    }
  | {
      type: 'message_content_updated'
      sessionId: string
      message: Message
      truncateAfterMessageId?: string
    }
  | {
      type: 'message_annotations_updated'
      sessionId: string
      messageId: string
      annotations: AnnotationV1[]
    }
  | { type: 'working_directory_error'; sessionId: string; error: string }
) &
  SessionEventContext

export interface SendMessageOptions {
  skillSlugs?: string[]
  textElements?: MessageTextElement[]
  optimisticMessageId?: string
}

// ---------------------------------------------------------------------------
// Session commands (consolidated operations)
// ---------------------------------------------------------------------------

export type SessionCommand =
  | { type: 'flag' }
  | { type: 'unflag' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'setSessionStatus'; state: SessionStatus }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'updateWorkingDirectory'; dir: string }
  | { type: 'setSources'; sourceSlugs: string[] }
  | { type: 'setLabels'; labels: string[] }
  | { type: 'showInFinder' }
  | { type: 'copyPath' }
  | { type: 'shareToViewer' }
  | { type: 'updateShare' }
  | { type: 'revokeShare' }
  | { type: 'refreshTitle' }
  | { type: 'getQwenPermissionSettings' }
  | {
      type: 'setQwenPermissionRules'
      scope: PermissionSettingsScope
      ruleType: PermissionRuleType
      rules: string[]
    }
  | { type: 'getQwenCoreSettings' }
  | {
      type: 'setQwenCoreSetting'
      scope: QwenSettingsScope
      key: QwenCoreSettingKey
      value: QwenSettingValue
    }
  | {
      type: 'setQwenMcpServer'
      scope: QwenSettingsScope
      name: string
      server: QwenMcpServerConfig
    }
  | { type: 'removeQwenMcpServer'; scope: QwenSettingsScope; name: string }
  | {
      type: 'setQwenHook'
      scope: QwenSettingsScope
      event: QwenHookEvent
      index?: number
      hook: QwenHookDefinition
    }
  | {
      type: 'removeQwenHook'
      scope: QwenSettingsScope
      event: QwenHookEvent
      index: number
    }
  | {
      type: 'setQwenExtensionSetting'
      extensionId: string
      settingKey: string
      scope: QwenSettingsScope
      value: QwenSettingValue
    }
  | ({ type: 'refreshAvailableCommands' } & RefreshAvailableCommandsOptions)
  | { type: 'setConnection'; connectionSlug: string }
  | {
      type: 'setPendingPlanExecution'
      planPath: string
      draftInputSnapshot?: string
    }
  | { type: 'markCompactionComplete' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'updateMessageContent'; messageId: string; content: string }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | {
      type: 'updateAnnotation'
      messageId: string
      annotationId: string
      patch: Partial<AnnotationV1>
    }

export interface NewChatActionParams {
  input?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Qwen permission settings
// ---------------------------------------------------------------------------

export type PermissionRuleType = 'allow' | 'ask' | 'deny'
export type PermissionSettingsScope = 'user' | 'workspace'

export interface PermissionRuleSet {
  allow: string[]
  ask: string[]
  deny: string[]
}

export interface PermissionSettingsScopeState {
  path: string
  rules: PermissionRuleSet
}

export interface QwenPermissionSettings {
  user: PermissionSettingsScopeState
  workspace: PermissionSettingsScopeState
  merged: PermissionRuleSet
  isTrusted: boolean
}

// ---------------------------------------------------------------------------
// Qwen core settings
// ---------------------------------------------------------------------------

export type QwenSettingsScope = 'user' | 'workspace'
export type QwenSettingValue = string | number | boolean | string[] | undefined
export type QwenMcpTransport = 'stdio' | 'http' | 'sse'

export type QwenCoreSettingKey =
  | 'model.name'
  | 'fastModel'
  | 'general.outputLanguage'
  | 'general.language'
  | 'tools.approvalMode'
  | 'general.vimMode'
  | 'general.enableAutoUpdate'
  | 'general.showSessionRecap'
  | 'general.sessionRecapAwayThresholdMinutes'
  | 'general.terminalBell'
  | 'general.gitCoAuthor.commit'
  | 'general.gitCoAuthor.pr'
  | 'general.defaultFileEncoding'
  | 'context.fileFiltering.respectGitIgnore'
  | 'context.fileFiltering.respectQwenIgnore'
  | 'context.fileFiltering.enableFuzzySearch'
  | 'memory.enableManagedAutoMemory'
  | 'memory.enableManagedAutoDream'
  | 'memory.enableAutoSkill'
  | 'memory.autoSkillConfirm'
  | 'disableAllHooks'

export interface QwenMcpServerConfig {
  transport: QwenMcpTransport
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  httpUrl?: string
  url?: string
  headers?: Record<string, string>
  timeout?: number
  trust?: boolean
  description?: string
  includeTools?: string[]
  excludeTools?: string[]
  extensionName?: string
}

export interface QwenMcpServerEntry {
  name: string
  scope: QwenSettingsScope | 'extension'
  server: QwenMcpServerConfig
}

export type QwenHookEvent =
  | 'UserPromptSubmit'
  | 'Stop'
  | 'Notification'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PermissionRequest'

export interface QwenHookConfig {
  type: 'command' | 'http'
  command?: string
  url?: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  name?: string
  description?: string
  timeout?: number
  env?: Record<string, string>
  async?: boolean
  once?: boolean
  statusMessage?: string
  shell?: 'bash' | 'powershell'
}

export interface QwenHookDefinition {
  matcher?: string
  sequential?: boolean
  hooks: QwenHookConfig[]
}

export interface QwenHookEntry {
  event: QwenHookEvent
  index: number
  scope: QwenSettingsScope | 'extension'
  hook: QwenHookDefinition
}

export interface QwenExtensionSettingDefinition {
  type: 'string' | 'number' | 'boolean'
  default?: QwenSettingValue
  description?: string
  sensitive?: boolean
}

export interface QwenExtensionSettingsEntry {
  id: string
  name: string
  displayName?: string
  version?: string
  isActive?: boolean
  path?: string
  commands: unknown[]
  skills: string[]
  mcpServers: string[]
  settings: Array<
    QwenExtensionSettingDefinition & {
      name: string
      envVar: string
      userValue?: QwenSettingValue
      workspaceValue?: QwenSettingValue
      effectiveValue?: QwenSettingValue
      effectiveScope?: QwenSettingsScope
      hasUserValue: boolean
      hasWorkspaceValue: boolean
    }
  >
}

export interface QwenCoreSettingsScopeState {
  path: string
  values: Partial<Record<QwenCoreSettingKey, QwenSettingValue>>
  mcpServers: QwenMcpServerEntry[]
  hooks: QwenHookEntry[]
}

export interface QwenCoreSettingsSnapshot {
  user: QwenCoreSettingsScopeState
  workspace: QwenCoreSettingsScopeState
  merged: {
    values: Partial<Record<QwenCoreSettingKey, QwenSettingValue>>
    mcpServers: QwenMcpServerEntry[]
    hooks: QwenHookEntry[]
    extensions: QwenExtensionSettingsEntry[]
  }
  workspaceTrusted: boolean
}

// ---------------------------------------------------------------------------
// Permission / credential types
// ---------------------------------------------------------------------------

export type { BasePermissionRequest }

/**
 * Permission request with session context (for multi-session Electron app)
 */
export interface PermissionRequest extends BasePermissionRequest {
  sessionId: string
}

export interface PermissionResponseOptions {
  rememberForMinutes?: number
  answers?: Record<string, string>
}

// Re-export for handler convenience
export type { SharedCredentialInputMode as CredentialInputMode }
export type CredentialRequest = SharedCredentialAuthRequest
export type { SharedAuthRequest as AuthRequest }

export interface CredentialResponse {
  type: 'credential'
  value?: string
  username?: string
  password?: string
  headers?: Record<string, string>
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Directory browsing types (remote mode)
// ---------------------------------------------------------------------------

/** Server-side directory listing result (for remote directory browsing). */
export interface DirectoryListingResult {
  /** Normalized absolute path of the listed directory (after resolve(), not symlink-resolved). */
  currentPath: string
  /** Parent directory path, or null if at root. */
  parentPath: string | null
  /** Pre-split breadcrumb segments for display (computed server-side). */
  breadcrumbs: Array<{ name: string; path: string }>
  /** Server platform info. */
  platform: 'win32' | 'darwin' | 'linux'
  /** Whether the server truncated the directory list for safety/performance. */
  truncated: boolean
  /** Total number of matching child directories before truncation. */
  totalEntries: number
  /** Child directory entries. */
  entries: Array<{ name: string; path: string; isSymlink: boolean }>
}

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'unknown'
  path: string
  name: string
  mimeType: string
  base64?: string
  text?: string
  size: number
  thumbnailBase64?: string
}

export interface SessionFile {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: SessionFile[]
}

export interface FileSearchResult {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

// ---------------------------------------------------------------------------
// LLM connection types
// ---------------------------------------------------------------------------

export interface QwenProviderBaseUrlOption {
  id: string
  label: string
  url: string
  documentationUrl?: string
  apiKeyUrl?: string
}

export interface QwenProviderModelSpec {
  id: string
  contextWindowSize?: number
  enableThinking?: boolean
  description?: string
}

export interface QwenProviderSummary {
  id: string
  label: string
  description: string
  protocol: string
  protocolOptions: string[]
  baseUrl?: string | QwenProviderBaseUrlOption[]
  baseUrlPlaceholder?: string
  defaultModelIds: string[]
  models: QwenProviderModelSpec[]
  modelsEditable: boolean
  showAdvancedConfig: boolean
  apiKeyPlaceholder?: string
  documentationUrl?: string
  uiGroup: string
  uiLabels?: {
    flowTitle?: string
    baseUrlStepTitle?: string
  }
  existingConfig?: {
    protocol?: string
    baseUrl?: string
    apiKey?: string
    modelIds?: string[]
    advancedConfig?: QwenProviderAdvancedConfig
  }
}

export interface QwenProviderCatalog {
  providers: QwenProviderSummary[]
}

export interface QwenProviderAdvancedConfig {
  enableThinking?: boolean
  multimodal?: {
    image?: boolean
    video?: boolean
    audio?: boolean
    pdf?: boolean
  }
  contextWindowSize?: number
  maxTokens?: number
}

export interface QwenProviderConnectParams {
  providerId: string
  protocol?: string
  baseUrl?: string
  apiKey: string
  modelIds?: string[]
  advancedConfig?: QwenProviderAdvancedConfig
  scope?: QwenSettingsScope
}

export interface QwenProviderConnectResult {
  success: boolean
  error?: string
  providerId?: string
  providerLabel?: string
  authType?: string
  modelId?: string
}

export interface LlmConnectionSetup {
  slug: string
  /** When true, reject setup if the connection doesn't already exist (reauth guard). */
  updateOnly?: boolean
}

export interface TestLlmConnectionParams {
  provider: 'qwen'
  apiKey?: string
  model?: string
}

export interface TestLlmConnectionResult {
  success: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Source / skill types
// ---------------------------------------------------------------------------

export interface SkillFile {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: SkillFile[]
}

export interface SkillMarketplaceItem {
  id: string
  slug: string
  name: string
  tagline: string
  description: string
  iconKey: string
  websiteUrl?: string
  sourceUrl: string
  examples: SkillMarketplaceExample[]
  heroImage?: string
  installed: boolean
}

export interface SkillMarketplaceExample {
  title: string
  prompt: string
}

export interface SkillMarketplaceInstallResult {
  id: string
  slug: string
  installedPath?: string
  source?: 'qwen-acp'
}

export interface QwenSkillInstallRequest {
  id: string
  slug: string
  name: string
  description?: string
  sourceUrl: string
  scope?: 'global'
}

export interface QwenSkillInstallResult {
  id?: string
  slug?: string
  installed?: boolean
  installedPath?: string
  message?: string
}

export interface QwenSkillDeleteRequest {
  slug: string
  scope?: 'global'
}

export interface QwenSkillDeleteResult {
  slug?: string
  deleted?: boolean
  message?: string
}

export interface QwenSkillSetEnabledRequest {
  slug: string
  enabled: boolean
  scope?: 'global' | 'project'
}

export interface QwenSkillSetEnabledResult {
  slug?: string
  enabled?: boolean
  installedPath?: string
  message?: string
}

export interface OAuthResult {
  success: boolean
  error?: string
}

export interface McpValidationResult {
  success: boolean
  error?: string
  tools?: string[]
}

export interface McpToolWithPermission {
  name: string
  description?: string
  allowed: boolean
}

export interface McpToolsResult {
  success: boolean
  error?: string
  tools?: McpToolWithPermission[]
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface SessionSearchMatch {
  sessionId: string
  lineNumber: number
  snippet: string
}

export interface SessionSearchResult {
  sessionId: string
  matchCount: number
  matches: SessionSearchMatch[]
}

// ---------------------------------------------------------------------------
// Session result types
// ---------------------------------------------------------------------------

export interface UnreadSummary {
  totalUnreadSessions: number
  byWorkspace: Record<string, number>
  hasUnreadByWorkspace: Record<string, boolean>
}

export interface ShareResult {
  success: boolean
  url?: string
  error?: string
}

export interface RefreshTitleResult {
  success: boolean
  title?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string
  description: string
  tools?: string[]
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

export interface Plan {
  id: string
  title: string
  summary?: string
  steps: PlanStep[]
  questions?: string[]
  state?:
    | 'creating'
    | 'refining'
    | 'ready'
    | 'executing'
    | 'completed'
    | 'cancelled'
  createdAt?: number
  updatedAt?: number
}

// ---------------------------------------------------------------------------
// System types
// ---------------------------------------------------------------------------

export interface GitBashStatus {
  found: boolean
  path: string | null
  platform: 'win32' | 'darwin' | 'linux'
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  downloadProgress: number
  error?: string
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  name?: string
  kind?: WorkspaceKind
  isProtected?: boolean
  pinned?: boolean
  model?: string
  permissionMode?: PermissionMode
  cyclablePermissionModes?: PermissionMode[]
  thinkingLevel?: ThinkingLevel
  workingDirectory?: string
  localMcpEnabled?: boolean
  defaultLlmConnection?: string
  enabledSourceSlugs?: string[]
}

// ---------------------------------------------------------------------------
// Auth result types
// ---------------------------------------------------------------------------

export interface OAuthConnectionResult {
  success: boolean
  token?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

export type TestAutomationAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string }
  | {
      type: 'webhook'
      url: string
      method?: string
      headers?: Record<string, string>
      bodyFormat?: 'json' | 'form' | 'raw'
      body?: unknown
      captureResponse?: boolean
      auth?:
        | { type: 'basic'; username: string; password: string }
        | { type: 'bearer'; token: string }
    }

export interface TestAutomationPayload {
  workspaceId: string
  automationId?: string
  automationName?: string
  actions: TestAutomationAction[]
  permissionMode?: PermissionMode
  labels?: string[]
}

export type TestAutomationActionResult =
  | {
      type: 'prompt'
      success: boolean
      stderr?: string
      sessionId?: string
      duration: number
    }
  | {
      type: 'webhook'
      success: boolean
      url: string
      statusCode: number
      error?: string
      duration: number
    }

export interface TestAutomationResult {
  actions: TestAutomationActionResult[]
}

// ---------------------------------------------------------------------------
// Window types
// ---------------------------------------------------------------------------

export type WindowCloseRequestSource =
  | 'keyboard-shortcut'
  | 'window-button'
  | 'unknown'

export interface WindowCloseRequest {
  source: WindowCloseRequestSource
}

// ---------------------------------------------------------------------------
// Browser / navigation types (data shapes used by BroadcastEventMap)
// ---------------------------------------------------------------------------

export interface BrowserInstanceInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  agentControlActive: boolean
  themeColor: string | null
  presentation?: 'window' | 'docked'
  dockExpanded?: boolean
}

export interface DeepLinkNavigation {
  view?: string
  tabType?: string
  tabParams?: Record<string, string>
  action?: string
  actionParams?: Record<string, string>
}

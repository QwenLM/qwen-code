/**
 * Message types for conversations
 */

/**
 * Message roles for display (runtime)
 */
export type MessageRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'status'
  | 'info'
  | 'warning'
  | 'plan'
  | 'auth-request'

export type IntermediateMessageKind = 'commentary' | 'thought'

/**
 * Credential input modes for different auth types
 */
export type CredentialInputMode =
  | 'bearer' // Single token field (Bearer Token, API Key)
  | 'basic' // Username + Password fields
  | 'header' // API Key with custom header name
  | 'query' // API Key for query parameter
  | 'multi-header' // Multiple header fields

/**
 * Auth request types
 */
export type AuthRequestType =
  | 'credential'
  | 'oauth'
  | 'oauth-google'
  | 'oauth-slack'
  | 'oauth-microsoft'

/**
 * Auth request status
 */
export type AuthStatus = 'pending' | 'completed' | 'cancelled' | 'failed'

/**
 * Tool execution status
 */
export type ToolStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'error'
  | 'backgrounded'

/**
 * Tool display metadata - embedded at storage time for viewer compatibility
 * Icons are base64-encoded to work in both Electron and web viewer
 */
export interface ToolDisplayMeta {
  /** Display name for the tool (e.g., "Commit", "Linear") */
  displayName: string
  /** Base64-encoded icon as data URL (e.g., "data:image/png;base64,...") - 32x32px */
  iconDataUrl?: string
  /** Description of what this tool does */
  description?: string
  /** Category for grouping/styling */
  category?: 'skill' | 'source' | 'native' | 'mcp'
}

/**
 * Attachment type categories
 */
export type AttachmentType = 'image' | 'text' | 'pdf' | 'office' | 'unknown'

/**
 * Attachment preview for display in user messages (runtime, before storage)
 */
export interface MessageAttachment {
  type: AttachmentType
  name: string
  mimeType: string
  size: number
  base64?: string // For images - enables thumbnail rendering
}

/**
 * Content badge for inline display in user messages
 * Badges are self-contained with all display data (label, icon)
 */
export interface ContentBadge {
  /** Badge type - used for fallback icon if iconBase64 not available */
  type: 'source' | 'skill' | 'context' | 'command' | 'file' | 'folder'
  /** Display label (e.g., "Linear", "Commit") */
  label: string
  /** Original text pattern (e.g., "@linear", "@commit") */
  rawText: string
  /** Icon as data URL (e.g., "data:image/png;base64,...") - preserves mime type */
  iconDataUrl?: string
  /** Start position in content string */
  start: number
  /** End position in content string */
  end: number
  /**
   * Collapsed label for context badges (e.g., "Edit: Permissions")
   * When set, the badge replaces the entire marked range with this label
   * and hides the original content
   */
  collapsedLabel?: string
  /**
   * File path for file badges - stores the full path for click handler
   * Used when the badge represents a clickable file reference
   */
  filePath?: string
}

export type MessageTextElementType =
  | 'source'
  | 'skill'
  | 'context'
  | 'slash_command'
  | 'file'
  | 'folder'

export interface MessageTextElement {
  /** Semantic text element type, independent of presentation. */
  type: MessageTextElementType
  /** UTF-8 byte offsets into the message content. */
  byte_range: {
    start: number
    end: number
  }
  /** Original placeholder text occupying the byte range. */
  placeholder: string
  /** Optional display label for rendering. */
  label?: string
  /** Optional stable target, such as a source slug, skill slug, command name, or file path. */
  target?: string
  /** Optional element-specific data kept out of the top-level protocol. */
  metadata?: Record<string, unknown>
}

/**
 * Author metadata for annotations
 */
export interface AnnotationAuthor {
  id: string
  name?: string
  type?: 'user' | 'agent' | 'system'
}

/**
 * Annotation body payloads (extensible)
 */
export type AnnotationBody =
  | { type: 'highlight' }
  | { type: 'note'; text: string; format?: 'plain' | 'markdown' }
  | { type: 'tag'; value: string }

/**
 * Annotation intent (tight v1 semantics).
 */
export type AnnotationIntent = 'highlight' | 'comment' | 'question'

/**
 * Optional lifecycle status for annotation workflows.
 */
export type AnnotationStatus =
  | 'pending'
  | 'acknowledged'
  | 'resolved'
  | 'dismissed'

/**
 * Block types for block selectors.
 */
export type AnnotationBlockType =
  | 'paragraph'
  | 'code'
  | 'latex'
  | 'mermaid'
  | 'datatable'
  | 'spreadsheet'
  | 'image-preview'
  | 'pdf-preview'
  | 'html-preview'

/**
 * Selector union used to anchor an annotation target.
 * Multiple selectors can be stored for robust fallback resolution.
 */
export type AnnotationSelector =
  | {
      type: 'text-quote'
      exact: string
      prefix?: string
      suffix?: string
    }
  | {
      type: 'text-position'
      start: number
      end: number
      textVersion?: string
    }
  | {
      type: 'block'
      blockType: AnnotationBlockType
      path: string
      blockId?: string
    }
  | {
      type: 'xywh'
      unit: 'pixel' | 'percent'
      x: number
      y: number
      w: number
      h: number
      page?: number
      rotation?: number
    }
  | {
      type: 'table-cell'
      rowKey: string | number
      columnKey: string
    }

/**
 * Annotation target definition.
 */
export interface AnnotationTarget {
  source: {
    sessionId: string
    messageId: string
  }
  selectors: AnnotationSelector[]
}

/**
 * Persisted annotation payload (schema-versioned for migration safety).
 */
export interface AnnotationV1 {
  id: string
  schemaVersion: 1
  createdAt: number
  updatedAt?: number
  createdBy?: AnnotationAuthor
  deletedAt?: number
  body: AnnotationBody[]
  target: AnnotationTarget
  /** Optional workflow intent (tight v1 semantics). */
  intent?: AnnotationIntent
  /** Optional lifecycle status. */
  status?: AnnotationStatus
  /** Optional reference to the conversation/thread around this annotation. */
  threadRef?: {
    threadId?: string
    sessionId?: string
  }
  style?: {
    color?: 'yellow' | 'green' | 'blue' | 'pink' | string
    opacity?: number
  }
  meta?: Record<string, unknown>
}

/**
 * Stored attachment metadata (persisted to disk, no base64)
 * Created when user sends a message with attachments
 */
export interface StoredAttachment {
  id: string // Unique identifier
  type: AttachmentType
  name: string // Original filename
  mimeType: string
  size: number // Final size (after any resize)
  originalSize?: number // Original size before resize (if applicable)
  storedPath: string // Full path to copied file on disk
  thumbnailPath?: string // Path to OS-generated thumbnail (images/PDFs/Office)
  thumbnailBase64?: string // Base64-encoded thumbnail PNG (for renderer display)
  markdownPath?: string // For Office files: converted markdown
  wasResized?: boolean // True if image was auto-resized for backend limits
  resizedBase64?: string // Base64 of resized image (only when wasResized=true)
}

/**
 * Runtime message type (includes transient fields like isStreaming)
 */
export interface Message {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  // Tool-specific fields
  toolName?: string
  toolUseId?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  toolStatus?: ToolStatus
  toolDuration?: number
  toolIntent?: string
  toolDisplayName?: string
  /** Tool display metadata with base64 icon - embedded at storage time for viewer */
  toolDisplayMeta?: ToolDisplayMeta
  // Parent tool ID for nested tool calls (e.g., child tools inside Task subagent)
  parentToolUseId?: string
  // Background task fields
  taskId?: string // For Task with run_in_background
  shellId?: string // For Bash with run_in_background
  elapsedSeconds?: number // Live progress updates
  isBackground?: boolean // Flag for UI differentiation
  // Stored attachments for user messages (persistent, no base64)
  attachments?: StoredAttachment[]
  // Semantic text elements for inline references and collapsed ranges
  textElements?: MessageTextElement[]
  /** Annotation payloads for this message */
  annotations?: AnnotationV1[]
  isError?: boolean
  isStreaming?: boolean
  // Pending: streaming text where we don't yet know if it's intermediate
  // Set to true when text_delta creates message, false when text_complete arrives
  // Also used for optimistic user messages before backend confirmation
  isPending?: boolean
  // Queued: user message that is waiting to be processed (sent during ongoing response)
  isQueued?: boolean
  // Intermediate text (commentary between tool calls, not final response)
  isIntermediate?: boolean
  intermediateKind?: IntermediateMessageKind
  // Turn ID: Correlation ID from the API's message.id, groups all messages in an assistant turn
  turnId?: string
  // Status type for special status messages (e.g., compacting)
  statusType?: 'compacting' | 'compaction_complete'
  // Info level for info messages (determines icon/color)
  infoLevel?: 'info' | 'warning' | 'error' | 'success'
  // Error-specific fields (for typed errors with diagnostics)
  errorCode?: string
  errorTitle?: string
  errorDetails?: string[]
  errorOriginal?: string
  errorCanRetry?: boolean
  errorActions?: Array<{
    key: string
    label: string
    action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source'
    url?: string
    sourceSlug?: string
  }>
  // Plan-specific fields (for role='plan')
  planPath?: string // Path to the plan markdown file
  // Auth-request-specific fields (for role='auth-request')
  authRequestId?: string // Unique ID for the auth request
  authRequestType?: AuthRequestType
  authSourceSlug?: string
  authSourceName?: string
  authStatus?: AuthStatus
  authCredentialMode?: CredentialInputMode // For credential requests
  authHeaderName?: string // For header auth - the header name
  authHeaderNames?: string[] // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
  authLabels?: {
    // Custom field labels
    credential?: string
    username?: string
    password?: string
  }
  authDescription?: string // Description/instructions
  authHint?: string // Hint about where to find credentials
  authSourceUrl?: string // Source URL for password manager domain matching (1Password)
  authPasswordRequired?: boolean // For basic auth: whether password is required (default true)
  authError?: string // Error message if auth failed
  authEmail?: string // Authenticated email (for OAuth)
  authWorkspace?: string // Authenticated workspace (for Slack)
}

/**
 * Stored message format (persistence)
 * Excludes transient runtime-only fields (isStreaming, isPending)
 */
export interface StoredMessage {
  id: string
  type: MessageRole
  content: string
  timestamp?: number
  // Tool-specific fields
  toolName?: string
  toolUseId?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  toolStatus?: ToolStatus
  toolDuration?: number
  toolIntent?: string
  toolDisplayName?: string
  /** Tool display metadata with base64 icon - embedded at storage time for viewer */
  toolDisplayMeta?: ToolDisplayMeta
  // Parent tool ID for nested tool calls (persisted for session restore)
  parentToolUseId?: string
  // Background task fields (persisted)
  taskId?: string
  shellId?: string
  elapsedSeconds?: number
  isBackground?: boolean
  isError?: boolean
  /** Stored attachments for user messages (persisted to disk) */
  attachments?: StoredAttachment[]
  /** Semantic text elements for inline references and collapsed ranges */
  textElements?: MessageTextElement[]
  /** Annotations persisted at message level */
  annotations?: AnnotationV1[]
  // Turn grouping - critical for TurnCard rendering after reload
  isIntermediate?: boolean
  intermediateKind?: IntermediateMessageKind
  turnId?: string
  // Status type for compaction messages (persisted for reload)
  statusType?: 'compacting' | 'compaction_complete'
  // Info level for info messages (persisted for reload)
  infoLevel?: 'info' | 'warning' | 'error' | 'success'
  // Error display fields
  errorCode?: string
  errorTitle?: string
  errorDetails?: string[]
  errorOriginal?: string
  errorCanRetry?: boolean
  errorActions?: Array<{
    key: string
    label: string
    action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source'
    url?: string
    sourceSlug?: string
  }>
  // Plan-specific fields (for role='plan')
  planPath?: string
  // Auth-request-specific fields (for role='auth-request')
  authRequestId?: string
  authRequestType?: AuthRequestType
  authSourceSlug?: string
  authSourceName?: string
  authStatus?: AuthStatus
  authCredentialMode?: CredentialInputMode
  authHeaderName?: string
  authHeaderNames?: string[]
  authLabels?: {
    credential?: string
    username?: string
    password?: string
  }
  authDescription?: string
  authHint?: string
  authSourceUrl?: string
  authPasswordRequired?: boolean
  authError?: string
  authEmail?: string
  authWorkspace?: string
  // Queued: user message that is waiting to be processed (persisted for recovery)
  isQueued?: boolean
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  contextTokens: number
  costUsd: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * Recovery action for typed errors
 */
export interface RecoveryAction {
  /** Keyboard shortcut (single letter) */
  key: string
  /** Description of the action */
  label: string
  /** Slash command to execute (e.g., '/settings') */
  command?: string
  /** Custom action type for special handling */
  action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source'
  /** URL to open (for open_url action) */
  url?: string
  /** Source slug (for reconnect_source action) */
  sourceSlug?: string
}

/**
 * Error codes for typed errors - must match AgentError.code in shared/agent/errors.ts
 */
export type ErrorCode =
  | 'invalid_api_key'
  | 'invalid_credentials'
  | 'response_too_large'
  | 'expired_oauth_token'
  | 'token_expired'
  | 'rate_limited'
  | 'service_error'
  | 'service_unavailable'
  | 'network_error'
  | 'proxy_error' // Proxy/firewall/captive portal intercepted the request
  | 'mcp_auth_required'
  | 'mcp_unreachable'
  | 'billing_error'
  | 'model_no_tool_support' // Model doesn't support tool/function calling
  | 'invalid_model' // Model ID not found
  | 'data_policy_error' // OpenRouter data policy restriction
  | 'invalid_request' // API rejected the request (e.g., bad image, invalid content)
  | 'image_too_large' // Image exceeds API dimension/size limits
  | 'provider_error' // AI provider experiencing issues (overloaded, unavailable)
  | 'unknown_error'

/**
 * Typed error from agent
 */
export interface TypedError {
  /** Error code for programmatic handling */
  code: ErrorCode
  /** User-friendly title */
  title: string
  /** Detailed message explaining what went wrong */
  message: string
  /** Suggested recovery actions */
  actions: RecoveryAction[]
  /** Whether auto-retry is possible */
  canRetry: boolean
  /** Retry delay in ms (if canRetry is true) */
  retryDelayMs?: number
  /** Diagnostic check results for debugging */
  details?: string[]
  /** Original error message for debugging */
  originalError?: string
}

/**
 * Permission request type categories
 */
export type PermissionRequestType =
  | 'bash'
  | 'file_write'
  | 'mcp_mutation'
  | 'api_mutation'
  | 'admin_approval'
  | 'ask_user_question'

export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect?: boolean
}

/**
 * Permission request from agent (e.g., bash command approval)
 */
export interface PermissionRequest {
  requestId: string
  toolName: string
  command?: string // Optional: bash commands have it, MCP tools may not
  description: string
  type?: PermissionRequestType // Type of permission request
  /** Friendly app/package label for admin approval prompts */
  appName?: string
  /** Plain-language reason shown in admin approval prompt */
  reason?: string
  /** Plain-language impact shown in admin approval prompt */
  impact?: string
  /** Whether native OS auth prompt is expected */
  requiresSystemPrompt?: boolean
  /** Optional remember window for this exact command */
  rememberForMinutes?: number
  /** Hash binding for approval integrity checks */
  commandHash?: string
  /** Approval validity window */
  approvalTtlSeconds?: number
  /** Structured questions for ask_user_question requests */
  questions?: AskUserQuestionItem[]
  /** Optional metadata from the ask_user_question tool */
  metadata?: {
    source?: string
  }
}

/**
 * Usage data emitted by CraftAgent in 'complete' events
 * Note: This is a subset of TokenUsage - totalTokens/contextTokens are computed by consumers
 */
export interface AgentEventUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number
}

/**
 * Slash command advertised by a provider runtime.
 */
export interface AvailableSlashCommand {
  name: string
  description?: string
  input?: Record<string, unknown> | null
}

/**
 * Skill metadata advertised by a provider runtime.
 */
export interface AvailableSkillDetail {
  name: string
  description?: string
  body?: string
  filePath?: string
  level?: string
  modelInvocable?: boolean
}

/**
 * Events emitted by CraftAgent during chat
 * turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
 */
export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'info'; message: string }
  | {
      type: 'text_delta'
      text: string
      turnId?: string
      parentToolUseId?: string
    }
  | {
      type: 'text_complete'
      text: string
      isIntermediate?: boolean
      intermediateKind?: IntermediateMessageKind
      turnId?: string
      parentToolUseId?: string
    }
  | {
      type: 'tool_start'
      toolName: string
      toolUseId: string
      input: Record<string, unknown>
      intent?: string
      displayName?: string
      turnId?: string
      parentToolUseId?: string
      toolDisplayMeta?: ToolDisplayMeta
    }
  | {
      type: 'tool_result'
      toolUseId: string
      toolName?: string
      result: string
      isError: boolean
      input?: Record<string, unknown>
      turnId?: string
      parentToolUseId?: string
    }
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      command?: string
      description: string
      permissionType?: PermissionRequestType
      appName?: string
      reason?: string
      impact?: string
      requiresSystemPrompt?: boolean
      rememberForMinutes?: number
      commandHash?: string
      approvalTtlSeconds?: number
    }
  | { type: 'error'; message: string }
  | { type: 'typed_error'; error: TypedError }
  | { type: 'complete'; usage?: AgentEventUsage }
  | { type: 'working_directory_changed'; workingDirectory: string }
  | {
      type: 'task_backgrounded'
      toolUseId: string
      taskId: string
      intent?: string
      turnId?: string
    }
  | {
      type: 'shell_backgrounded'
      toolUseId: string
      shellId: string
      intent?: string
      command?: string
      turnId?: string
    }
  | {
      type: 'task_progress'
      toolUseId: string
      elapsedSeconds: number
      turnId?: string
    }
  | {
      type: 'task_completed'
      taskId: string
      status: 'completed' | 'failed' | 'stopped'
      outputFile?: string
      summary?: string
      turnId?: string
    }
  | { type: 'shell_killed'; shellId: string; turnId?: string }
  | { type: 'source_activated'; sourceSlug: string; originalMessage: string }
  | {
      type: 'usage_update'
      usage: Pick<AgentEventUsage, 'inputTokens' | 'contextWindow'>
    }
  | {
      type: 'available_commands_update'
      availableCommands: AvailableSlashCommand[]
      availableSkills?: string[]
      availableSkillDetails?: AvailableSkillDetail[]
    }
  | { type: 'steer_undelivered'; message: string }

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

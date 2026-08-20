/**
 * Event Processor Types
 *
 * Defines the state and event types for the centralized event processor.
 * All agent events flow through a single pure function for consistent state transitions.
 */

import type { Session, Message, PermissionRequest, CredentialRequest, TypedError, PermissionMode, SessionStatus, AuthRequest, ToolDisplayMeta, AvailableSlashCommand } from '../../shared/types'

/**
 * Streaming state for a session - replaces streamingTextRef
 */
export interface StreamingState {
  content: string
  turnId?: string
  parentToolUseId?: string
}

/**
 * Complete state for a session - combines session + streaming
 */
export interface SessionState {
  session: Session
  streaming: StreamingState | null
}

/**
 * Text delta event - streaming text content
 */
export interface TextDeltaEvent {
  type: 'text_delta'
  sessionId: string
  delta: string
  turnId?: string
}

/**
 * Text complete event - finalizes streaming text
 */
export interface TextCompleteEvent {
  type: 'text_complete'
  sessionId: string
  text: string
  turnId?: string
  isIntermediate?: boolean
  intermediateKind?: 'commentary' | 'thought'
  parentToolUseId?: string
  /** Timestamp from main process for consistent ordering with session.jsonl */
  timestamp?: number
  /** Authoritative message ID from main process for persistence/branching parity */
  messageId?: string
}

/**
 * Tool start event - begins tool execution
 * Field names match SessionEvent from shared/types.ts
 */
export interface ToolStartEvent {
  type: 'tool_start'
  sessionId: string
  toolUseId: string
  toolName: string
  toolInput?: Record<string, unknown>
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
  turnId?: string
  parentToolUseId?: string
  toolIntent?: string
  toolDisplayName?: string
  /** Tool display metadata with base64-encoded icon for viewer compatibility */
  toolDisplayMeta?: ToolDisplayMeta
}

/**
 * Tool result event - completes tool execution
 */
export interface ToolResultEvent {
  type: 'tool_result'
  sessionId: string
  toolUseId: string
  toolName?: string
  result: string
  isError?: boolean
  turnId?: string
  parentToolUseId?: string
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Complete event - agent loop finished
 */
export interface CompleteEvent {
  type: 'complete'
  sessionId: string
  tokenUsage?: Session['tokenUsage']
  /** Explicit unread flag - set by main process based on viewing state */
  hasUnread?: boolean
}

/**
 * Error event - agent error occurred
 */
export interface ErrorEvent {
  type: 'error'
  sessionId: string
  error: string
  code?: string
  title?: string
  details?: string
  original?: string
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Permission request event
 * Matches SessionEvent shape from shared/types.ts
 */
export interface PermissionRequestEvent {
  type: 'permission_request'
  sessionId: string
  request: PermissionRequest
}

/**
 * Sources changed event
 */
export interface SourcesChangedEvent {
  type: 'sources_changed'
  sessionId: string
  enabledSourceSlugs: string[]
}

/**
 * Labels changed event
 */
export interface LabelsChangedEvent {
  type: 'labels_changed'
  sessionId: string
  labels: string[]
}

/**
 * Todo state changed event (external metadata change or agent tool)
 */
export interface SessionStatusChangedEvent {
  type: 'session_status_changed'
  sessionId: string
  sessionStatus?: string
}

/**
 * Session flagged/unflagged events (external metadata change)
 */
export interface SessionFlaggedEvent {
  type: 'session_flagged'
  sessionId: string
}

export interface SessionUnflaggedEvent {
  type: 'session_unflagged'
  sessionId: string
}

/**
 * Session archived/unarchived events (external metadata change)
 */
export interface SessionArchivedEvent {
  type: 'session_archived'
  sessionId: string
}

export interface SessionUnarchivedEvent {
  type: 'session_unarchived'
  sessionId: string
}

/**
 * Session name changed event (external metadata change)
 */
export interface NameChangedEvent {
  type: 'name_changed'
  sessionId: string
  name?: string
}

/**
 * Plan submitted event
 */
export interface PlanSubmittedEvent {
  type: 'plan_submitted'
  sessionId: string
  message: Message
}

/**
 * Typed error event
 */
export interface TypedErrorEvent {
  type: 'typed_error'
  sessionId: string
  error: TypedError
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Status event
 */
export interface StatusEvent {
  type: 'status'
  sessionId: string
  message: string
  statusType?: 'compacting'
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Info event
 */
export interface InfoEvent {
  type: 'info'
  sessionId: string
  message: string
  statusType?: 'compaction_complete'
  level?: 'info' | 'warning' | 'error' | 'success'
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Interrupted event
 */
export interface InterruptedEvent {
  type: 'interrupted'
  sessionId: string
  message?: Message
  /** Messages that were queued but not processed — should be restored to input field */
  queuedMessages?: string[]
}

/**
 * Title generated event
 */
export interface TitleGeneratedEvent {
  type: 'title_generated'
  sessionId: string
  title: string
  preview?: string  // First user message preview for sidebar fallback
}

/**
 * Title regenerating event - indicates title regeneration has started/finished
 * Used to show shimmer effect on title during regeneration
 * @deprecated Use AsyncOperationEvent instead
 */
export interface TitleRegeneratingEvent {
  type: 'title_regenerating'
  sessionId: string
  isRegenerating: boolean
}

/**
 * Generic async operation state event
 * Used to show shimmer effect during any async operation (sharing, updating, revoking, title regeneration)
 */
export interface AsyncOperationEvent {
  type: 'async_operation'
  sessionId: string
  isOngoing: boolean
}

/**
 * Working directory changed event (user-initiated via UI)
 */
export interface WorkingDirectoryChangedEvent {
  type: 'working_directory_changed'
  sessionId: string
  workingDirectory: string
}

/**
 * Working directory error event - server rejected the path (cross-platform, not found, etc.)
 */
export interface WorkingDirectoryErrorEvent {
  type: 'working_directory_error'
  sessionId: string
  error: string
}

/**
 * Permission mode changed event
 */
export interface PermissionModeChangedEvent {
  type: 'permission_mode_changed'
  sessionId: string
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion?: number
  changedAt?: string
  changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

/**
 * Session model changed event
 */
export interface SessionModelChangedEvent {
  type: 'session_model_changed'
  sessionId: string
  model: string | null
}

/**
 * LLM connection changed event - syncs session.llmConnection to renderer
 */
export interface LLMConnectionChangedEvent {
  type: 'connection_changed'
  sessionId: string
  connectionSlug: string
  supportsBranching?: boolean
}

/**
 * Credential request event - prompts user for credentials
 */
export interface CredentialRequestEvent {
  type: 'credential_request'
  sessionId: string
  request: CredentialRequest
}

/**
 * Task backgrounded event - background agent started
 */
export interface TaskBackgroundedEvent {
  type: 'task_backgrounded'
  sessionId: string
  toolUseId: string
  taskId: string
  intent?: string
  turnId?: string
}

/**
 * Shell backgrounded event - background bash shell started
 */
export interface ShellBackgroundedEvent {
  type: 'shell_backgrounded'
  sessionId: string
  toolUseId: string
  shellId: string
  intent?: string
  turnId?: string
}

/**
 * Task progress event - live progress updates for background tasks
 */
export interface TaskProgressEvent {
  type: 'task_progress'
  sessionId: string
  toolUseId: string
  elapsedSeconds: number
  turnId?: string
}

/**
 * Task completed event - background task finished execution
 * Updates the tool message status and result when a background task completes.
 */
export interface TaskCompletedEvent {
  type: 'task_completed'
  sessionId: string
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
  turnId?: string
}

/**
 * User message event - backend confirmation of optimistic user message
 * Used for optimistic UI: frontend shows message immediately,
 * backend confirms/updates status via this event
 */
export interface UserMessageEvent {
  type: 'user_message'
  sessionId: string
  message: Message
  status: 'accepted' | 'queued' | 'processing'
  /** Frontend's optimistic message ID for reliable matching */
  optimisticMessageId?: string
}

/**
 * Message content update event
 */
export interface MessageContentUpdatedEvent {
  type: 'message_content_updated'
  sessionId: string
  message: Message
  truncateAfterMessageId?: string
}

/**
 * Message annotation update event
 */
export interface MessageAnnotationsUpdatedEvent {
  type: 'message_annotations_updated'
  sessionId: string
  messageId: string
  annotations: NonNullable<Message['annotations']>
}

/**
 * Session shared event - session was shared to viewer
 */
export interface SessionSharedEvent {
  type: 'session_shared'
  sessionId: string
  sharedUrl: string
}

/**
 * Session unshared event - session share was revoked
 */
export interface SessionUnsharedEvent {
  type: 'session_unshared'
  sessionId: string
}

/**
 * Auth request event - unified auth flow (credential or OAuth)
 * Adds auth-request message to session and displays inline auth UI
 */
export interface AuthRequestEvent {
  type: 'auth_request'
  sessionId: string
  message: Message
  request: AuthRequest
}

/**
 * Auth completed event - auth request was completed (success, failure, or cancelled)
 * Updates the auth-request message status
 */
export interface AuthCompletedEvent {
  type: 'auth_completed'
  sessionId: string
  requestId: string
  success: boolean
  cancelled?: boolean
  error?: string
}

/**
 * Source activated event - a source was auto-activated mid-turn
 * Caller should re-send the original message to retry with the now-active source
 */
export interface SourceActivatedEvent {
  type: 'source_activated'
  sessionId: string
  sourceSlug: string
  originalMessage: string
}

/**
 * Usage update event - real-time context usage during processing
 * Allows UI to show growing context as agent processes, not just on complete
 */
export interface UsageUpdateEvent {
  type: 'usage_update'
  sessionId: string
  tokenUsage: {
    inputTokens: number
    contextWindow?: number
  }
}

/**
 * Available commands update event - provider-advertised slash commands and skills.
 */
export interface AvailableCommandsUpdateEvent {
  type: 'available_commands_update'
  sessionId: string
  availableCommands: AvailableSlashCommand[]
  availableSkills?: string[]
  availableSkillDetails?: import('@craft-agent/core/types').AvailableSkillDetail[]
}

/**
 * Union of all agent events
 */
export type AgentEvent =
  | TextDeltaEvent
  | TextCompleteEvent
  | ToolStartEvent
  | ToolResultEvent
  | CompleteEvent
  | ErrorEvent
  | TypedErrorEvent
  | PermissionRequestEvent
  | CredentialRequestEvent
  | SourcesChangedEvent
  | LabelsChangedEvent
  | SessionStatusChangedEvent
  | SessionFlaggedEvent
  | SessionUnflaggedEvent
  | SessionArchivedEvent
  | SessionUnarchivedEvent
  | NameChangedEvent
  | PlanSubmittedEvent
  | StatusEvent
  | InfoEvent
  | InterruptedEvent
  | TitleGeneratedEvent
  | TitleRegeneratingEvent
  | AsyncOperationEvent
  | WorkingDirectoryChangedEvent
  | WorkingDirectoryErrorEvent
  | PermissionModeChangedEvent
  | SessionModelChangedEvent
  | LLMConnectionChangedEvent
  | TaskBackgroundedEvent
  | ShellBackgroundedEvent
  | TaskProgressEvent
  | TaskCompletedEvent
  | UserMessageEvent
  | MessageContentUpdatedEvent
  | MessageAnnotationsUpdatedEvent
  | SessionSharedEvent
  | SessionUnsharedEvent
  | AuthRequestEvent
  | AuthCompletedEvent
  | SourceActivatedEvent
  | UsageUpdateEvent
  | AvailableCommandsUpdateEvent

/**
 * Side effects that need to be handled outside the pure processor
 */
export type Effect =
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'credential_request'; request: CredentialRequest }
  | { type: 'generate_title'; sessionId: string; userMessage: string }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown' }
  | { type: 'auto_retry'; sessionId: string; originalMessage: string; sourceSlug: string }
  | { type: 'restore_input'; text: string }
  | { type: 'queued_input_add'; message: Message; optimisticMessageId?: string }
  | { type: 'queued_input_remove'; messageId: string; optimisticMessageId?: string }
  | { type: 'toast_error'; message: string }

/**
 * Result of processing an event
 */
export interface ProcessResult {
  state: SessionState
  /** Side effects to execute (permissions, etc.) */
  effects: Effect[]
}

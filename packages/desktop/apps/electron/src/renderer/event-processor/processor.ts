/**
 * Event Processor
 *
 * Central pure function that processes all agent events.
 * Guarantees consistent state transitions and always returns new references.
 *
 * Benefits:
 * - Single source of truth for event handling
 * - Pure functions - easy to test
 * - No race conditions - single update path
 * - Always new references - atom sync always works
 * - Message lookup by ID - never position-based
 */

import type { SessionState, AgentEvent, ProcessResult } from './types'
import { handleTextDelta, handleTextComplete } from './handlers/text'
import { handleToolStart, handleToolResult, handleTaskBackgrounded, handleShellBackgrounded, handleTaskProgress, handleTaskCompleted } from './handlers/tool'
import {
  handleComplete,
  handleError,
  handleTypedError,
  handleSourcesChanged,
  handleLabelsChanged,
  handleSessionStatusChanged,
  handleSessionFlagged,
  handleSessionUnflagged,
  handleSessionArchived,
  handleSessionUnarchived,
  handleNameChanged,
  handlePermissionRequest,
  handleCredentialRequest,
  handlePlanSubmitted,
  handleStatus,
  handleInfo,
  handleInterrupted,
  handleTitleGenerated,
  handleTitleRegenerating,
  handleAsyncOperation,
  handleWorkingDirectoryChanged,
  handlePermissionModeChanged,
  handleSessionModelChanged,
  handleConnectionChanged,
  handleUserMessage,
  handleMessageContentUpdated,
  handleMessageAnnotationsUpdated,
  handleSessionShared,
  handleSessionUnshared,
  handleAuthRequest,
  handleAuthCompleted,
  handleUsageUpdate,
  handleAvailableCommandsUpdate,
} from './handlers/session'

/**
 * Process an agent event, returning new state and any side effects
 *
 * This is a PURE FUNCTION - no side effects, always returns new state.
 * Guaranteed to return a new session reference (no referential equality issues).
 *
 * @param state - Current session state (session + streaming)
 * @param event - Agent event to process
 * @returns New state and any side effects to execute
 */
export function processEvent(
  state: SessionState,
  event: AgentEvent
): ProcessResult {
  switch (event.type) {
    case 'text_delta': {
      const newState = handleTextDelta(state, event)
      return { state: newState, effects: [] }
    }

    case 'text_complete': {
      const newState = handleTextComplete(state, event)
      return { state: newState, effects: [] }
    }

    case 'tool_start': {
      const newState = handleToolStart(state, event)
      return { state: newState, effects: [] }
    }

    case 'tool_result': {
      const newState = handleToolResult(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_backgrounded': {
      const newState = handleTaskBackgrounded(state, event)
      return { state: newState, effects: [] }
    }

    case 'shell_backgrounded': {
      const newState = handleShellBackgrounded(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_progress': {
      const newState = handleTaskProgress(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_completed': {
      const newState = handleTaskCompleted(state, event)
      return { state: newState, effects: [] }
    }

    case 'complete':
      return handleComplete(state, event)

    case 'error':
      return handleError(state, event)

    case 'typed_error':
      return handleTypedError(state, event)

    case 'status':
      return handleStatus(state, event)

    case 'info':
      return handleInfo(state, event)

    case 'interrupted':
      return handleInterrupted(state, event)

    case 'title_generated':
      return handleTitleGenerated(state, event)

    case 'title_regenerating':
      return handleTitleRegenerating(state, event)

    case 'async_operation':
      return handleAsyncOperation(state, event)

    case 'working_directory_changed':
      return handleWorkingDirectoryChanged(state, event)

    case 'working_directory_error':
      // No state change — just emit a toast effect
      return {
        state: { ...state, session: { ...state.session } },
        effects: [{ type: 'toast_error', message: event.error }],
      }

    case 'permission_mode_changed':
      return handlePermissionModeChanged(state, event)

    case 'session_model_changed':
      return handleSessionModelChanged(state, event)

    case 'connection_changed':
      return handleConnectionChanged(state, event)

    case 'sources_changed':
      return handleSourcesChanged(state, event)

    case 'labels_changed':
      return handleLabelsChanged(state, event)

    case 'session_status_changed':
      return handleSessionStatusChanged(state, event)

    case 'session_flagged':
      return handleSessionFlagged(state, event)

    case 'session_unflagged':
      return handleSessionUnflagged(state, event)

    case 'session_archived':
      return handleSessionArchived(state, event)

    case 'session_unarchived':
      return handleSessionUnarchived(state, event)

    case 'name_changed':
      return handleNameChanged(state, event)

    case 'permission_request':
      return handlePermissionRequest(state, event)

    case 'credential_request':
      return handleCredentialRequest(state, event)

    case 'plan_submitted':
      return handlePlanSubmitted(state, event)

    case 'user_message':
      return handleUserMessage(state, event)

    case 'message_content_updated':
      return handleMessageContentUpdated(state, event)

    case 'message_annotations_updated':
      return handleMessageAnnotationsUpdated(state, event)

    case 'session_shared':
      return handleSessionShared(state, event)

    case 'session_unshared':
      return handleSessionUnshared(state, event)

    case 'auth_request':
      return handleAuthRequest(state, event)

    case 'auth_completed':
      return handleAuthCompleted(state, event)

    case 'source_activated':
      // Source was auto-activated mid-turn, emit effect to auto-retry
      return {
        state,
        effects: [{
          type: 'auto_retry',
          sessionId: event.sessionId,
          originalMessage: event.originalMessage,
          sourceSlug: event.sourceSlug,
        }],
      }

    case 'usage_update':
      return handleUsageUpdate(state, event)

    case 'available_commands_update':
      return handleAvailableCommandsUpdate(state, event)

    default: {
      // Unknown event type - return state unchanged but as new reference
      // to ensure atom sync detects the "change"
      const _exhaustiveCheck: never = event
      return {
        state: { ...state, session: { ...state.session } },
        effects: [],
      }
    }
  }
}

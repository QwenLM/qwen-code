/**
 * turn-utils.ts
 *
 * Utilities for grouping messages by turn for TurnCard rendering.
 * Converts the flat Message[] array into grouped turns for email-like display.
 */

import type { Message, StoredMessage, MessageRole } from '@craft-agent/core'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { storedToMessage } from '@craft-agent/core'

export { storedToMessage }
import type { ActivityItem, ActivityStatus, ActivityType, ResponseContent, TodoItem } from './TurnCard'

// Re-export ActivityItem for consumers
export type { ActivityItem }

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip error wrapper tags and prefixes from tool error messages.
 * Some runtimes wrap errors in tags like <error><tool_use_error>...</tool_use_error></error>
 * which aren't user-friendly. Additionally, errorResponse() and blockWithReason() prefix
 * messages with "[ERROR] " so the backend can detect failures when a tool
 * protocol has no dedicated error signaling field. We strip that prefix here
 * for clean UI display.
 */
function stripErrorTags(content: string | undefined): string | undefined {
  if (!content) return content
  return content
    .replace(/<\/?error>/gi, '')
    .replace(/<\/?tool_use_error>/gi, '')
    .replace(/^\[ERROR]\s*/i, '')
    .trim()
}

const TERMINAL_MISSING_TOOL_RESULT = 'Tool result was not recorded.'

function hasTerminalMissingToolResult(turn: AssistantTurn): boolean {
  return turn.activities.some(activity =>
    activity.type === 'tool' &&
    activity.status === 'error' &&
    (activity.content === TERMINAL_MISSING_TOOL_RESULT ||
      activity.error === TERMINAL_MISSING_TOOL_RESULT)
  )
}

// ============================================================================
// Types
// ============================================================================

/** Represents one complete assistant turn */
export interface AssistantTurn {
  type: 'assistant'
  turnId: string
  activities: ActivityItem[]
  response?: ResponseContent
  intent?: string
  isStreaming: boolean
  isComplete: boolean
  timestamp: number
  /** Extracted from TodoWrite tool - latest todo state in this turn */
  todos?: TodoItem[]
}

/** Represents a user message */
export interface UserTurn {
  type: 'user'
  message: Message
  timestamp: number
}

/** Represents a system/info/error message that stands alone */
export interface SystemTurn {
  type: 'system'
  message: Message
  timestamp: number
}

/** Represents an auth request (credential input, OAuth flow) */
export interface AuthRequestTurn {
  type: 'auth-request'
  message: Message
  timestamp: number
}

export type Turn = AssistantTurn | UserTurn | SystemTurn | AuthRequestTurn

/**
 * Build a stable UI identity key for an assistant turn card.
 *
 * Why this exists:
 * - Backend turnId can be reused across visually split assistant cards
 *   (e.g., steer/interruption boundaries).
 * - Expansion state must be keyed by UI-card identity, not raw backend turnId.
 */
export function getAssistantTurnUiKey(turn: AssistantTurn, index: number): string {
  if (turn.response?.messageId) {
    return `assistant:msg:${turn.response.messageId}`
  }
  return `assistant:turn:${turn.turnId}:${turn.timestamp}:${index}`
}

// ============================================================================
// Turn Lifecycle Phase
// ============================================================================

/**
 * TurnPhase represents the current lifecycle state of an assistant turn.
 *
 * State Machine:
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  PENDING ──(tool_start)──► TOOL_ACTIVE ──(all_tools_done)──► AWAITING      │
 * │     │                          │                                  │        │
 * │     │ text_delta               │ text_delta                       │        │
 * │     ▼                          ▼                                  │        │
 * │  STREAMING ◄───────────── STREAMING (intermediate) ◄──────────────┘        │
 * │     │                          │                                           │
 * │     │ text_complete            │ text_complete + more work coming          │
 * │     ▼                          ▼                                           │
 * │  COMPLETE                   AWAITING                                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Key insight: The "awaiting" phase is the GAP between tool completion and
 * the next action. This was previously invisible, causing the turn card to
 * "disappear" after a tool completed.
 */
export type TurnPhase =
  | 'pending'      // Turn created, waiting for first activity
  | 'tool_active'  // At least one tool is currently running
  | 'awaiting'     // All tools done, waiting for next action (THE GAP!)
  | 'streaming'    // Final response text is actively streaming
  | 'complete'     // Turn is finished

/**
 * Derives the current phase of a turn from its data.
 *
 * This is a pure function that examines turn state to determine phase.
 * The phase is derived (not tracked), making it testable and consistent.
 *
 * Priority order (first match wins):
 * 1. complete - turn.isComplete is true
 * 2. streaming - response exists and is streaming (final response)
 * 3. tool_active - any TOOL activity has status 'running'
 * 4. awaiting - has activities but no tools running (the gap!)
 * 5. pending - no activities yet
 *
 * Note: Only `type: 'tool'` activities count for tool_active phase.
 * Intermediate text (type: 'intermediate') and status activities (type: 'status')
 * with 'running' status do NOT trigger tool_active - they show "Thinking..." instead.
 */
export function deriveTurnPhase(turn: AssistantTurn): TurnPhase {
  // Complete takes precedence - turn is definitively done
  if (turn.isComplete) {
    return 'complete'
  }

  // Check if final response is streaming
  // Note: turn.response only exists for final responses, not intermediate text
  if (turn.response && turn.response.isStreaming) {
    return 'streaming'
  }

  // Check if any TOOL activities are currently running.
  // Only tool-type activities count - intermediate text and status activities
  // with 'running' status should show "Thinking...", not tool spinners.
  const hasRunningTools = turn.activities.some(a => a.type === 'tool' && a.status === 'running')
  if (hasRunningTools) {
    return 'tool_active'
  }

  // Has activities but none running = the "gap" state
  // This is the critical state that was previously not represented,
  // causing the UI to hide the turn card after tool completion.
  if (turn.activities.length > 0) {
    return 'awaiting'
  }

  // No activities yet - turn is pending first action
  return 'pending'
}

/**
 * Determines if the "Thinking..." indicator should be shown.
 *
 * The thinking indicator appears when the turn is active but there's
 * nothing visible to show the user (no running tools, no streaming response).
 * This covers both the initial pending state and the gap after tools complete.
 *
 * @param phase - The current turn phase
 * @param isBuffering - Whether response text is still being buffered
 */
export function shouldShowThinkingIndicator(phase: TurnPhase, isBuffering: boolean): boolean {
  // Show thinking indicator during:
  // - pending: waiting for first activity
  // - awaiting: gap between tool completion and next action
  // - streaming but buffering: text started but not ready to display
  return phase === 'pending' || phase === 'awaiting' || (phase === 'streaming' && isBuffering)
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Convert tool status from message to ActivityStatus */
function getToolStatus(message: Message): ActivityStatus {
  // response_too_large is success (data was saved, just too large for inline display)
  if (message.errorCode === 'response_too_large') return 'completed'
  if (message.isError) return 'error'
  // Backgrounded takes priority — tool_result arrives before task_backgrounded,
  // so toolResult is set but the task is still running in the background
  if (message.toolStatus === 'backgrounded') return 'backgrounded'
  // Check explicit toolStatus first (set by tool_result handler)
  if (message.toolStatus === 'completed') return 'completed'
  // Fallback: check if toolResult exists (handles empty string results)
  if (message.toolResult !== undefined) return 'completed'
  if (message.toolStatus === 'pending') return 'pending'
  return 'running'
}

/**
 * Convert message to ActivityItem with incremental depth calculation.
 * Depth is calculated immediately using existing activities, enabling
 * correct tree view rendering during streaming (not just on flush).
 *
 * @param message - The message to convert
 * @param existingActivities - Activities already in the turn (for depth lookup)
 */
function messageToActivity(message: Message, existingActivities: ActivityItem[] = []): ActivityItem {
  const activity: ActivityItem = {
    id: message.id,
    type: 'tool' as ActivityType,
    status: getToolStatus(message),
    toolName: message.toolName,
    toolUseId: message.toolUseId,  // For parent-child matching
    toolInput: message.toolInput,
    content: message.toolResult || message.content,
    intent: message.toolIntent,
    displayName: message.toolDisplayName,  // LLM-generated human-friendly name
    toolDisplayMeta: message.toolDisplayMeta,  // Embedded metadata with base64 icon for viewer
    timestamp: message.timestamp,
    error: message.isError ? stripErrorTags(message.toolResult || message.content) : undefined,
    // parentId: The toolUseId of the parent tool (e.g., Task subagent).
    // This is tracked by session manager's parentToolStack, NOT the SDK's
    // parent_tool_use_id which is for result-matching, not hierarchy.
    parentId: message.parentToolUseId,
    // Background task fields
    taskId: message.taskId,
    shellId: message.shellId,
    elapsedSeconds: message.elapsedSeconds,
    isBackground: message.isBackground,
  }

  // Calculate depth incrementally using existing activities
  // This enables correct tree view rendering during streaming
  if (activity.parentId) {
    const parent = existingActivities.find(a => a.toolUseId === activity.parentId)
    activity.depth = parent ? (parent.depth || 0) + 1 : 1
  } else {
    activity.depth = 0
  }

  return activity
}

/**
 * Calculate nesting depths for activities based on parent-child relationships.
 * Modifies activities in place, adding depth field (0 = root, 1 = child, etc.)
 *
 * Note: With incremental depth calculation in messageToActivity(), this function
 * serves as a safety net for edge cases (e.g., parent arrives after child) and
 * ensures all depths are correctly set when a turn is flushed.
 */
function calculateActivityDepths(activities: ActivityItem[]): void {
  // Build a map of toolUseId -> activity for fast parent lookup
  const toolIdToActivity = new Map<string, ActivityItem>()
  for (const activity of activities) {
    if (activity.toolUseId) {
      toolIdToActivity.set(activity.toolUseId, activity)
    }
  }

  // Calculate depth for each activity (recalculates to handle edge cases)
  for (const activity of activities) {
    let depth = 0
    let parentId = activity.parentId

    // Walk up the parent chain, max 10 levels to prevent infinite loops
    while (parentId && depth < 10) {
      depth++
      const parent = toolIdToActivity.get(parentId)
      parentId = parent?.parentId
    }

    activity.depth = depth
  }
}

// ============================================================================
// TodoWrite Extraction
// ============================================================================

/**
 * Extract todos from TodoWrite tool results in activities.
 * Returns the latest todo state (from the most recent TodoWrite call).
 */
function extractTodosFromActivities(activities: ActivityItem[]): TodoItem[] | undefined {
  // Find all TodoWrite tool results, get the latest one
  const todoWriteActivities = activities
    .filter(a => a.toolName === 'TodoWrite' && a.status === 'completed' && a.content)
    .sort((a, b) => b.timestamp - a.timestamp) // Most recent first

  const latestActivity = todoWriteActivities[0]
  if (!latestActivity) return undefined

  const latestResult = latestActivity.content
  if (!latestResult) return undefined

  try {
    // TodoWrite result is typically a success message, but the input contains the todos
    // We need to get the toolInput which has the todos array
    const input = latestActivity.toolInput
    if (input && Array.isArray(input.todos)) {
      return input.todos.map((todo: { content: string; status: string; activeForm?: string }) => ({
        content: todo.content,
        status: todo.status as 'pending' | 'in_progress' | 'completed',
        activeForm: todo.activeForm,
      }))
    }
  } catch {
    // Failed to parse, return undefined
  }

  return undefined
}

// ============================================================================
// Main Grouping Function
// ============================================================================

/**
 * Groups messages into turns for TurnCard rendering
 *
 * Rules:
 * - User messages flush and start fresh context
 * - Tool messages + intermediate assistant messages belong to current turn
 * - Final assistant message (non-streaming, non-intermediate) flushes the turn
 * - Error/status/info messages are standalone system turns
 *
 * Note: We intentionally ignore turnId for grouping. The SDK generates a new
 * turnId for each API message, but from a user perspective, all work between
 * a user message and the final response should be ONE turn. We use isIntermediate
 * as the signal: isIntermediate=true means more work coming, isIntermediate=false
 * means final response.
 */
export function groupMessagesByTurn(messages: Message[]): Turn[] {
  // Sort by timestamp for correct chronological order
  // This ensures correct turn grouping even if messages are added out of order during streaming
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp)

  const turns: Turn[] = []
  let currentTurn: AssistantTurn | null = null

  const flushCurrentTurn = (interrupted = false) => {
    if (currentTurn) {
      // Sort activities by timestamp to ensure correct chronological order
      // This is necessary because buffering can delay when messages are added
      // to the array, causing commentary to appear after tools that started later
      currentTurn.activities.sort((a, b) => a.timestamp - b.timestamp)

      // Calculate nesting depths for parent-child tool relationships
      calculateActivityDepths(currentTurn.activities)

      // Extract todos from TodoWrite tool results
      currentTurn.todos = extractTodosFromActivities(currentTurn.activities)

      // If interrupted, mark any running activities as error and todos as interrupted
      if (interrupted) {
        currentTurn.activities = currentTurn.activities.map(activity =>
          activity.status === 'running'
            ? { ...activity, status: 'error' as ActivityStatus, error: 'Interrupted' }
            : activity
        )
        if (currentTurn.todos) {
          currentTurn.todos = currentTurn.todos.map(todo =>
            todo.status === 'in_progress'
              ? { ...todo, status: 'interrupted' as const }
              : todo
          )
        }
        currentTurn.isStreaming = false
        currentTurn.isComplete = true
      }

      if (!interrupted && hasTerminalMissingToolResult(currentTurn)) {
        currentTurn.isStreaming = false
        currentTurn.isComplete = true
      }

      // If no response but we have intermediate text, promote the last one to response
      // Don't do this for interrupted turns - respect user interruptions
      // Don't do this for turns with plans - the plan is the final output
      // Only promote when turn is complete (processing indicator hidden)
      const hasPlan = currentTurn.activities.some(a => a.type === 'plan')
      if (!interrupted && !hasPlan && !currentTurn.response && currentTurn.isComplete && currentTurn.activities.length > 0) {
        // Find the last intermediate text activity (reverse to get most recent)
        const lastTextActivity = [...currentTurn.activities]
          .reverse()
          .find(a =>
            a.type === 'intermediate' &&
            a.intermediateKind !== 'thought' &&
            !a.parentId &&
            a.content
          )

        if (lastTextActivity?.content) {
          currentTurn.response = {
            text: lastTextActivity.content,
            isStreaming: false,
            timestamp: lastTextActivity.timestamp,
            messageId: lastTextActivity.id,
          }
        }
      }

      turns.push(currentTurn)
      currentTurn = null
    }
  }

  for (const message of sortedMessages) {
    // Auth-request messages are standalone turns (credential input, OAuth flows)
    if (message.role === 'auth-request') {
      // If there's a current turn, it's complete (something follows it)
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'auth-request',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // User messages are their own turn
    if (message.role === 'user') {
      // If there's a current turn, it's complete (something follows it)
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'user',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // Status messages become activities within the current turn (don't break turn)
    if (message.role === 'status') {
      if (!currentTurn) {
        // Start a new turn for this status
        currentTurn = {
          type: 'assistant',
          turnId: message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: true,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      const statusActivity: ActivityItem = {
        id: message.id,
        type: 'status',
        status: 'running',
        content: message.content,
        timestamp: message.timestamp,
        statusType: message.statusType,
        depth: 0,
      }
      currentTurn.activities.push(statusActivity)
      continue
    }

    // Info messages with compaction_complete update the matching status activity
    if (message.role === 'info' && message.statusType === 'compaction_complete') {
      if (currentTurn) {
        const statusIdx = currentTurn.activities.findIndex(
          a => a.type === 'status' && a.statusType === 'compacting'
        )
        const existingActivity = currentTurn.activities[statusIdx]
        if (statusIdx !== -1 && existingActivity) {
          currentTurn.activities[statusIdx] = {
            ...existingActivity,
            status: 'completed',
            content: message.content,
          }
        }
      }
      continue  // Don't create a separate system turn
    }

    // Error/info/warning messages are standalone
    if (message.role === 'error' || message.role === 'info' || message.role === 'warning') {
      // Flush current turn first (mark as interrupted if info message)
      const isInterruption = message.role === 'info'
      // For error/warning (not info), the previous turn is complete
      if (currentTurn && !isInterruption) currentTurn.isComplete = true
      flushCurrentTurn(isInterruption)
      turns.push({
        type: 'system',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // Plan messages are added as activities to be time-sorted with tool calls
    // This ensures SubmitPlan tool appears before the plan content chronologically
    if (message.role === 'plan') {
      if (!currentTurn) {
        // Edge case: plan without preceding activities
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: false,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // Add plan as an activity so it gets time-sorted with other activities
      currentTurn.activities.push({
        id: message.id,
        type: 'plan' as ActivityType,
        status: 'completed',
        content: message.content,
        messageId: message.id,
        annotations: message.annotations,
        displayName: 'Plan',
        timestamp: message.timestamp,
      })
      currentTurn.isStreaming = false
      currentTurn.isComplete = true
      flushCurrentTurn()
      continue
    }

    // Tool messages belong to current assistant turn
    if (message.role === 'tool') {
      // Tool is complete if toolStatus is 'completed' OR toolResult exists (but NOT if backgrounded)
      const isToolComplete = (message.toolStatus === 'completed' || message.toolResult !== undefined) && message.toolStatus !== 'backgrounded'
      if (!currentTurn) {
        // Start a new turn
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: message.toolIntent,
          isStreaming: !isToolComplete,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // Always add to current turn (ignoring turnId differences)
      // Pass existing activities for incremental depth calculation
      currentTurn.activities.push(messageToActivity(message, currentTurn.activities))
      currentTurn.isStreaming = !isToolComplete
      continue
    }

    // Assistant messages are the response part of a turn
    if (message.role === 'assistant') {
      // Intermediate messages OR pending messages (don't know yet) are activities, not responses
      // Pending: streaming text where we don't yet know if it's intermediate - treat as intermediate
      // until text_complete arrives with the definitive isIntermediate flag
      if (message.isIntermediate || message.isPending) {
        if (!currentTurn) {
          // Start a new turn for this intermediate message
          currentTurn = {
            type: 'assistant',
            turnId: message.turnId || message.id,
            activities: [],
            response: undefined,
            intent: undefined,
            isStreaming: !!message.isPending,
            isComplete: false,
            timestamp: message.timestamp,
          }
        }
        // Always add to current turn as activity (ignoring turnId differences)
        // Pending messages show as 'running' until we know they're complete
        // Include parentId for intermediate messages to support nesting within subagents
        const intermediateActivity: ActivityItem = {
          id: message.id,
          type: 'intermediate',
          status: message.isPending ? 'running' : 'completed',
          content: message.content,
          intermediateKind: message.intermediateKind,
          timestamp: message.timestamp,
          parentId: message.parentToolUseId,
        }
        // Calculate depth for intermediate messages too
        if (intermediateActivity.parentId) {
          const parent = currentTurn.activities.find(a => a.toolUseId === intermediateActivity.parentId)
          intermediateActivity.depth = parent ? (parent.depth || 0) + 1 : 1
        } else {
          intermediateActivity.depth = 0
        }
        currentTurn.activities.push(intermediateActivity)

        // Update turn streaming state based on this message
        // If message is no longer pending/streaming, update turn state accordingly
        if (!message.isPending && !message.isStreaming) {
          currentTurn.isStreaming = false
        }
        continue
      }

      // Non-intermediate assistant message = final response
      if (!currentTurn) {
        // This is a response-only turn (no tools)
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: !!message.isStreaming,
          isComplete: !message.isStreaming,
          timestamp: message.timestamp,
        }
      }

      // Set as response on current turn (ignoring turnId differences)
      currentTurn.response = {
        text: message.content,
        isStreaming: !!message.isStreaming,
        streamStartTime: message.isStreaming ? message.timestamp : undefined,
        timestamp: message.timestamp,
        messageId: message.id,
        annotations: message.annotations,
      }
      currentTurn.isStreaming = !!message.isStreaming
      currentTurn.isComplete = !message.isStreaming

      // Flush when turn is complete (non-streaming = final response received)
      if (!message.isStreaming) {
        flushCurrentTurn()
      }
      continue
    }
  }

  // Flush any remaining turn
  flushCurrentTurn()

  return turns
}

function findSingleChangedMessageIndex(
  previousMessages: Message[],
  nextMessages: Message[]
): number | undefined {
  if (previousMessages.length !== nextMessages.length) return undefined

  let changedIndex: number | undefined
  for (let index = 0; index < previousMessages.length; index++) {
    if (previousMessages[index] === nextMessages[index]) continue
    if (changedIndex !== undefined) return undefined
    changedIndex = index
  }

  return changedIndex
}

function hasOnlyContentChanged(previousMessage: Message, nextMessage: Message): boolean {
  const previousRecord = previousMessage as unknown as Record<string, unknown>
  const nextRecord = nextMessage as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)])
  keys.delete('content')

  for (const key of keys) {
    if (!Object.is(previousRecord[key], nextRecord[key])) return false
  }

  return !Object.is(previousMessage.content, nextMessage.content)
}

function isStreamingAssistantContentUpdate(
  previousMessage: Message,
  nextMessage: Message
): boolean {
  return previousMessage.role === 'assistant' &&
    nextMessage.role === 'assistant' &&
    nextMessage.isStreaming === true &&
    typeof previousMessage.content === 'string' &&
    typeof nextMessage.content === 'string' &&
    hasOnlyContentChanged(previousMessage, nextMessage)
}

function patchAssistantTurnForStreamingMessage(
  turn: AssistantTurn,
  messageId: string,
  nextContent: string
): AssistantTurn | undefined {
  if (turn.response?.messageId === messageId) {
    return {
      ...turn,
      response: {
        ...turn.response,
        text: nextContent,
        isStreaming: true,
      },
      isStreaming: true,
      isComplete: false,
    }
  }

  const activityIndex = turn.activities.findIndex(activity => activity.id === messageId)
  if (activityIndex === -1) return undefined

  const activities = [...turn.activities]
  const activity = activities[activityIndex]
  if (!activity) return undefined

  activities[activityIndex] = {
    ...activity,
    content: nextContent,
    status: 'running',
  }

  return {
    ...turn,
    activities,
    isStreaming: true,
    isComplete: false,
  }
}

/**
 * Reuses grouped turns for the common text_delta path.
 *
 * The renderer receives frequent updates where the only message change is the
 * content of one streaming assistant message. Re-grouping the whole history for
 * that case is unnecessary, so this patches the matching turn in place and lets
 * callers fall back to groupMessagesByTurn for every other shape change.
 */
export function updateGroupedTurnsForStreamingMessage(
  previousMessages: Message[],
  nextMessages: Message[],
  previousTurns: Turn[]
): Turn[] | undefined {
  const changedIndex = findSingleChangedMessageIndex(previousMessages, nextMessages)
  if (changedIndex === undefined) return undefined

  const previousMessage = previousMessages[changedIndex]
  const nextMessage = nextMessages[changedIndex]
  if (!previousMessage || !nextMessage) return undefined
  if (!isStreamingAssistantContentUpdate(previousMessage, nextMessage)) return undefined

  const messageId = nextMessage.id
  const nextContent = nextMessage.content

  for (let turnIndex = previousTurns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = previousTurns[turnIndex]
    if (turn?.type !== 'assistant') continue

    const patchedTurn = patchAssistantTurnForStreamingMessage(turn, messageId, nextContent)
    if (!patchedTurn) continue

    const nextTurns = [...previousTurns]
    nextTurns[turnIndex] = patchedTurn
    return nextTurns
  }

  return undefined
}

/**
 * Get the primary intent for a turn (first available intent from activities)
 */
export function getTurnIntent(turn: AssistantTurn): string | undefined {
  // First check explicit turn intent
  if (turn.intent) return turn.intent

  // Then look for activity intents
  for (const activity of turn.activities) {
    if (activity.intent) return activity.intent
  }

  return undefined
}

/**
 * Check if any activity in the turn is still running
 */
export function hasPendingActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'backgrounded')
}

/**
 * Check if any activity in the turn has an error
 */
export function hasErrorActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'error')
}

/**
 * Get a summary of completed activities
 */
export function getActivitySummary(turn: AssistantTurn): string {
  const completed = turn.activities.filter(a => a.status === 'completed').length
  const running = turn.activities.filter(a => a.status === 'running').length
  const errors = turn.activities.filter(a => a.status === 'error').length

  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (completed > 0) parts.push(`${completed} completed`)
  if (errors > 0) parts.push(`${errors} failed`)

  return parts.join(', ') || 'No activities'
}

/**
 * Format an AssistantTurn as markdown for detailed viewing in Monaco
 * Shows full tool inputs, results, and response
 */
export function formatTurnAsMarkdown(turn: AssistantTurn): string {
  const lines: string[] = []

  // Header with intent if available
  if (turn.intent) {
    lines.push(`# ${turn.intent}`)
  } else {
    lines.push('# Turn Details')
  }
  lines.push('')

  // Summary
  const summary = getActivitySummary(turn)
  lines.push(`**Status:** ${turn.isComplete ? 'Complete' : 'In Progress'} · ${summary}`)
  lines.push('')

  // Activities section
  if (turn.activities.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Activities')
    lines.push('')

    for (const activity of turn.activities) {
      if (activity.type === 'intermediate') {
        // Intermediate text (thinking/commentary)
        lines.push(`### 💭 Commentary`)
        lines.push('')
        if (activity.content) {
          lines.push(activity.content)
        }
        lines.push('')
      } else if (activity.toolName) {
        // Tool call
        const statusEmoji = activity.status === 'completed' ? '✅' :
                           activity.status === 'error' ? '❌' :
                           activity.status === 'running' ? '⏳' : '⏸️'

        lines.push(`### ${statusEmoji} ${activity.toolName}`)
        lines.push('')

        // Intent if available
        if (activity.intent) {
          lines.push(`> ${activity.intent}`)
          lines.push('')
        }

        // Input
        if (activity.toolInput && Object.keys(activity.toolInput).length > 0) {
          lines.push('**Input:**')
          lines.push('```json')
          lines.push(JSON.stringify(activity.toolInput, null, 2))
          lines.push('```')
          lines.push('')
        }

        // Result/Output
        if (activity.content) {
          lines.push('**Result:**')
          // Check if result looks like JSON
          const trimmed = activity.content.trim()
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed)
              lines.push('```json')
              lines.push(JSON.stringify(parsed, null, 2))
              lines.push('```')
            } catch {
              // Not valid JSON, show as text
              lines.push('```')
              lines.push(activity.content)
              lines.push('```')
            }
          } else {
            lines.push('```')
            lines.push(activity.content)
            lines.push('```')
          }
          lines.push('')
        }

        // Error if present
        if (activity.error) {
          lines.push('**Error:**')
          lines.push('```')
          lines.push(activity.error)
          lines.push('```')
          lines.push('')
        }
      }
    }
  }

  // Response section
  if (turn.response?.text) {
    lines.push('---')
    lines.push('')
    lines.push('## Response')
    lines.push('')
    lines.push(turn.response.text)
  }

  return lines.join('\n')
}

/**
 * Format a single ActivityItem as markdown for detailed viewing in Monaco
 */
export function formatActivityAsMarkdown(activity: ActivityItem): string {
  const lines: string[] = []

  if (activity.type === 'intermediate') {
    // Commentary/thinking
    lines.push(activity.intermediateKind === 'thought' ? '# Thinking' : '# Commentary')
    lines.push('')
    if (activity.content) {
      lines.push(activity.content)
    }
    return lines.join('\n')
  }

  // Tool activity
  const statusEmoji = activity.status === 'completed' ? '✅' :
                     activity.status === 'error' ? '❌' :
                     activity.status === 'running' ? '⏳' : '⏸️'

  lines.push(`# ${statusEmoji} ${activity.toolName || 'Tool'}`)
  lines.push('')

  // Intent if available
  if (activity.intent) {
    lines.push(`> ${activity.intent}`)
    lines.push('')
  }

  // Input
  if (activity.toolInput && Object.keys(activity.toolInput).length > 0) {
    lines.push('## Input')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(activity.toolInput, null, 2))
    lines.push('```')
    lines.push('')
  }

  // Result/Output
  if (activity.content) {
    lines.push('## Result')
    lines.push('')
    // Check if result looks like JSON
    const trimmed = activity.content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        lines.push('```json')
        lines.push(JSON.stringify(parsed, null, 2))
        lines.push('```')
      } catch {
        // Not valid JSON, show as text
        lines.push('```')
        lines.push(activity.content)
        lines.push('```')
      }
    } else {
      lines.push('```')
      lines.push(activity.content)
      lines.push('```')
    }
    lines.push('')
  }

  // Error if present
  if (activity.error) {
    lines.push('## Error')
    lines.push('')
    lines.push('```')
    lines.push(activity.error)
    lines.push('```')
  }

  return lines.join('\n')
}

// ============================================================================
// Last Turn/Message Utilities
// ============================================================================

/**
 * Get the last assistant turn from a list of turns.
 * Useful for determining the current/most recent assistant response.
 */
export function getLastAssistantTurn(turns: Turn[]): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'assistant') {
      return turn as AssistantTurn
    }
  }
  return undefined
}

/**
 * Get the timestamp of the last user message from turns.
 * Useful for calculating elapsed time since user sent their message.
 */
export function getLastUserMessageTime(turns: Turn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'user') {
      return (turn as UserTurn).timestamp
    }
  }
  return undefined
}

/**
 * Check if the last assistant turn is still streaming/processing.
 */
export function isLastTurnStreaming(turns: Turn[]): boolean {
  const lastAssistant = getLastAssistantTurn(turns)
  return lastAssistant?.isStreaming ?? false
}

/**
 * Pre-compute which activities are the last child at their depth level.
 * Returns a Set of activity IDs that are last children.
 * This is O(n) instead of O(n²) for checking during render.
 */
export function computeLastChildSet(activities: ActivityItem[]): Set<string> {
  // Track the last activity for each parentId
  const lastByParent = new Map<string | undefined, string>()

  for (const activity of activities) {
    if (activity.depth && activity.depth > 0) {
      // This activity has a parent - mark it as the (potentially) last child
      lastByParent.set(activity.parentId, activity.id)
    }
  }

  return new Set(lastByParent.values())
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format duration in milliseconds to human-readable string.
 * @example formatDuration(1234) => "1.2s"
 * @example formatDuration(65000) => "1m 5s"
 * @example formatDuration(125000) => "2m+"
 */
export function formatDuration(ms: number): string {
  // Guard against invalid inputs
  if (!Number.isFinite(ms) || ms < 0) {
    return '--'
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes >= 2) {
    return `${minutes}m+`
  }
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * Format token count to human-readable string.
 * @example formatTokens(500) => "500"
 * @example formatTokens(1500) => "1.5k"
 * @example formatTokens(15000) => "15k"
 */
export function formatTokens(count: number): string {
  // Guard against invalid inputs
  if (!Number.isFinite(count) || count < 0) {
    return '0'
  }
  count = Math.floor(count) // Tokens are integers
  if (count < 1000) {
    return count.toString()
  }
  const k = count / 1000
  if (k < 10) {
    return `${k.toFixed(1)}k`
  }
  return `${Math.round(k)}k`
}

// ============================================================================
// Activity Grouping for Task Subagents
// ============================================================================

/**
 * Data extracted from TaskOutput tool result
 */
export interface TaskOutputData {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}

/**
 * Represents a Task tool with its child activities grouped together
 */
export interface ActivityGroup {
  type: 'group'
  parent: ActivityItem
  children: ActivityItem[]
  /** Data from TaskOutput result (duration, tokens) */
  taskOutputData?: TaskOutputData
}

/**
 * Type guard to check if an item is an ActivityGroup
 */
export function isActivityGroup(item: ActivityItem | ActivityGroup): item is ActivityGroup {
  return 'type' in item && item.type === 'group' && 'parent' in item && 'children' in item
}

/**
 * Extract TaskOutput data from an activity's result content.
 * TaskOutput results are JSON with: result, usage, total_cost_usd, duration_ms
 */
function extractTaskOutputData(activity: ActivityItem): TaskOutputData | undefined {
  if (!activity.content) return undefined

  try {
    const parsed = JSON.parse(activity.content)
    const data: TaskOutputData = {}

    if (typeof parsed.duration_ms === 'number') {
      data.durationMs = parsed.duration_ms
    }

    if (parsed.usage) {
      if (typeof parsed.usage.input_tokens === 'number') {
        data.inputTokens = parsed.usage.input_tokens
      }
      if (typeof parsed.usage.output_tokens === 'number') {
        data.outputTokens = parsed.usage.output_tokens
      }
    }

    // Only return if we have some data
    if (data.durationMs !== undefined || data.inputTokens !== undefined || data.outputTokens !== undefined) {
      return data
    }
  } catch {
    // Not valid JSON or missing fields
  }

  return undefined
}

/**
 * Groups activities by their parent Task tool.
 *
 * This transforms a flat chronological list into a grouped structure:
 * - Maintains chronological order of top-level items (orphans and Task groups)
 * - Each Task tool becomes a group containing its child activities
 * - Maintains chronological order within each group
 * - TaskOutput activities are hidden but their data enriches the parent Task
 *
 * @param activities - Flat list of activities sorted by timestamp
 * @returns Mixed array of standalone activities and activity groups
 */
export function groupActivitiesByParent(
  activities: ActivityItem[]
): (ActivityItem | ActivityGroup)[] {
  // First, build a set of valid Task toolUseIds (parents that actually exist)
  const taskToolUseIds = new Set<string>()
  for (const activity of activities) {
    if (isParentTaskTool(activity.toolName ?? '') && activity.toolUseId) {
      taskToolUseIds.add(activity.toolUseId)
    }
  }

  // Build a map of parentId -> children for efficient lookup
  // Only include children whose parent Task actually exists
  const childrenByParent = new Map<string, ActivityItem[]>()
  for (const activity of activities) {
    if (activity.parentId && taskToolUseIds.has(activity.parentId)) {
      const existing = childrenByParent.get(activity.parentId) || []
      existing.push(activity)
      childrenByParent.set(activity.parentId, existing)
    }
  }

  // Build set of child activity IDs to skip (they're included in their parent's group)
  // Activities with parentId pointing to non-existent parents are NOT added here,
  // so they'll appear as orphan activities at root level instead of being dropped
  const childIds = new Set<string>()
  for (const children of childrenByParent.values()) {
    for (const child of children) {
      childIds.add(child.id)
    }
  }

  // Build a map of task_id (agent ID) -> TaskOutput data
  // TaskOutput.toolInput.task_id contains the agent ID returned when Task runs in background
  const taskOutputByAgentId = new Map<string, TaskOutputData>()
  for (const activity of activities) {
    if (activity.toolName === 'TaskOutput' && activity.status === 'completed') {
      const taskId = activity.toolInput?.task_id as string | undefined
      if (taskId) {
        const data = extractTaskOutputData(activity)
        if (data) {
          taskOutputByAgentId.set(taskId, data)
        }
      }
    }
  }

  // Build a map of Task toolUseId -> agent ID (extracted from Task result content)
  // When Task runs with run_in_background: true, the result contains "agentId: xyz"
  const taskToAgentId = new Map<string, string>()
  for (const activity of activities) {
    if (isParentTaskTool(activity.toolName ?? '') && (activity.status === 'completed' || activity.status === 'backgrounded') && activity.content) {
      // Parse agent ID from Task result - look for "agentId: xyz" pattern
      const agentIdMatch = activity.content.match(/agentId:\s*([a-zA-Z0-9_-]+)/)
      const capturedAgentId = agentIdMatch?.[1]
      if (capturedAgentId && activity.toolUseId) {
        taskToAgentId.set(activity.toolUseId, capturedAgentId)
      }
    }
  }

  // Build the grouped result maintaining chronological order
  const result: (ActivityItem | ActivityGroup)[] = []

  for (const activity of activities) {
    // Skip activities that are children of a Task (they're in their parent's group)
    if (childIds.has(activity.id)) {
      continue
    }

    // Skip TaskOutput activities - their data is attached to parent Task groups
    if (activity.toolName === 'TaskOutput') {
      continue
    }

    // Task/Agent tools become groups with their children
    if (isParentTaskTool(activity.toolName ?? '')) {
      const children = activity.toolUseId
        ? (childrenByParent.get(activity.toolUseId) || [])
        : []

      // Look up TaskOutput data for this Task via the agent ID chain:
      // Task.toolUseId -> agentId -> TaskOutput data
      let taskOutputData: TaskOutputData | undefined
      if (activity.toolUseId) {
        const agentId = taskToAgentId.get(activity.toolUseId)
        if (agentId) {
          taskOutputData = taskOutputByAgentId.get(agentId)
        }
      }

      result.push({
        type: 'group',
        parent: activity,
        children: children.sort((a, b) => a.timestamp - b.timestamp),
        taskOutputData,
      })
    } else {
      // Orphan activity - add directly
      result.push(activity)
    }
  }

  return result
}

/**
 * Counts the total number of activities including those inside groups
 */
export function countTotalActivities(items: (ActivityItem | ActivityGroup)[]): number {
  let count = 0
  for (const item of items) {
    if (isActivityGroup(item)) {
      count += 1 + item.children.length // Parent + children
    } else {
      count += 1
    }
  }
  return count
}

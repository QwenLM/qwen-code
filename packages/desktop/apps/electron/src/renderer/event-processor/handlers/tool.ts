/**
 * Tool Event Handlers
 *
 * Handles tool_start and tool_result events.
 * Pure functions that return new state - no side effects.
 */

import type { SessionState, ToolStartEvent, ToolResultEvent, TaskBackgroundedEvent, ShellBackgroundedEvent, TaskProgressEvent, TaskCompletedEvent } from '../types'
import type { Message } from '../../../shared/types'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import {
  findToolMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/**
 * Handle tool_start - create or update tool message
 *
 * SDK sends two events per tool: first from stream_event (empty input),
 * second from assistant message (complete input). We handle both.
 */
export function handleToolStart(
  state: SessionState,
  event: ToolStartEvent
): SessionState {
  const { session, streaming } = state

  // Check if tool message already exists (SDK sends two events)
  const existingIndex = findToolMessage(session.messages, event.toolUseId)

  if (existingIndex !== -1) {
    // Update with complete input (second event has full input)
    const updatedSession = updateMessageAt(session, existingIndex, {
      toolInput: event.toolInput,
      toolIntent: event.toolIntent,
      toolDisplayName: event.toolDisplayName,
      toolDisplayMeta: event.toolDisplayMeta,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
    })
    return { session: updatedSession, streaming }
  }

  // Create new tool message
  const toolMessage: Message = {
    id: generateMessageId(),
    role: 'tool',
    content: '',
    timestamp: event.timestamp ?? Date.now(),
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolStatus: 'executing',
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
    toolIntent: event.toolIntent,
    toolDisplayName: event.toolDisplayName,
    toolDisplayMeta: event.toolDisplayMeta,
  }

  return {
    session: appendMessage(session, toolMessage),
    streaming,
  }
}

/**
 * Handle tool_result - complete tool execution
 *
 * Updates the tool message with result. If tool not found (out-of-order),
 * creates the tool message with result included.
 */
export function handleToolResult(
  state: SessionState,
  event: ToolResultEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  const inferredError = event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(event.result || '')

  if (toolIndex !== -1) {
    // Detect "persisted output" - SDK marks as error but data was actually saved successfully
    const isPersistedOutput = inferredError && (
      event.result?.includes('Output has been saved to') ||
      event.result?.includes('Full output saved to')
    )

    const effectiveIsError = isPersistedOutput ? false : inferredError

    // If the tool is already backgrounded, preserve that status — task_completed will set the final status.
    // tool_result arrives with the agentId but the task is still running in the background.
    const existingMessage = session.messages[toolIndex]
    const isBackgrounded = existingMessage?.toolStatus === 'backgrounded' || existingMessage?.isBackground
    const newToolStatus = isBackgrounded ? 'backgrounded' : (effectiveIsError ? 'error' : 'completed')

    // Update existing tool message
    let updatedSession = updateMessageAt(session, toolIndex, {
      toolResult: event.result,
      toolStatus: newToolStatus,
      isError: effectiveIsError,
      errorCode: isPersistedOutput ? 'response_too_large' : undefined,
    })

    // Safety net: when a parent Task completes, auto-complete any still-pending child tools.
    // This handles the case where child tool_result events never arrive.
    const completedTool = updatedSession.messages[toolIndex]
    if (completedTool && (isParentTaskTool(completedTool.toolName || '') || completedTool.toolName === 'TaskOutput')) {
      const hasOrphanedChildren = updatedSession.messages.some(
        m => m.parentToolUseId === event.toolUseId
          && m.toolStatus !== 'completed'
          && m.toolStatus !== 'error'
      )
      if (hasOrphanedChildren) {
        const updatedMessages = updatedSession.messages.map(m => {
          if (
            m.parentToolUseId === event.toolUseId
            && m.toolStatus !== 'completed'
            && m.toolStatus !== 'error'
          ) {
            return { ...m, toolStatus: 'completed' as const, toolResult: m.toolResult || '' }
          }
          return m
        })
        updatedSession = { ...updatedSession, messages: updatedMessages }
      }
    }

    return { session: updatedSession, streaming }
  }

  // No matching tool_start found — create message from result.
  // This is normal for background subagent child tools where tool_result arrives
  // without a prior tool_start. If tool_start arrives later, findToolMessage will
  // locate this message by toolUseId and update it with input/intent/displayMeta.

  // Detect "persisted output" - SDK marks as error but data was actually saved successfully
  const isPersistedOutput = inferredError && (
    event.result?.includes('Output has been saved to') ||
    event.result?.includes('Full output saved to')
  )

  const effectiveIsError = isPersistedOutput ? false : inferredError

  const toolMessage: Message = {
    id: generateMessageId(),
    role: 'tool',
    content: '',
    timestamp: event.timestamp ?? Date.now(),
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    toolResult: event.result,
    toolStatus: effectiveIsError ? 'error' : 'completed',
    isError: effectiveIsError,
    errorCode: isPersistedOutput ? 'response_too_large' : undefined,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  return {
    session: appendMessage(session, toolMessage),
    streaming,
  }
}

/**
 * Handle task_backgrounded - mark tool as backgrounded with task ID
 *
 * When a Task is executed with run_in_background: true, the SDK returns
 * immediately with an agentId. This event updates the tool message status
 * to 'backgrounded' and stores the taskId for later polling via TaskOutput.
 */
export function handleTaskBackgrounded(
  state: SessionState,
  event: TaskBackgroundedEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  if (toolIndex !== -1) {
    // Update tool status to backgrounded and add task ID
    const updatedSession = updateMessageAt(session, toolIndex, {
      toolStatus: 'backgrounded',
      taskId: event.taskId,
      isBackground: true,
    })
    return { session: updatedSession, streaming }
  }

  // Tool not found - shouldn't happen, but return state unchanged
  return state
}

/**
 * Handle shell_backgrounded - mark shell as backgrounded with shell ID
 *
 * When a Bash command is executed with run_in_background: true, the SDK
 * returns immediately with a shell_id. This event updates the tool message
 * status to 'backgrounded' and stores the shellId for later reference.
 */
export function handleShellBackgrounded(
  state: SessionState,
  event: ShellBackgroundedEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  if (toolIndex !== -1) {
    // Update tool status to backgrounded and add shell ID
    const updatedSession = updateMessageAt(session, toolIndex, {
      toolStatus: 'backgrounded',
      shellId: event.shellId,
      isBackground: true,
    })
    return { session: updatedSession, streaming }
  }

  // Tool not found - shouldn't happen, but return state unchanged
  return state
}

/**
 * Handle task_progress - update elapsed time for background task
 *
 * The SDK emits tool_progress events with elapsed_time_seconds for
 * background tasks. This event updates the elapsedSeconds field on
 * the tool message to display live progress in the UI.
 */
export function handleTaskProgress(
  state: SessionState,
  event: TaskProgressEvent
): SessionState {
  const { session, streaming } = state

  const toolIndex = findToolMessage(session.messages, event.toolUseId)

  if (toolIndex !== -1) {
    // Update elapsed time for live progress display
    const updatedSession = updateMessageAt(session, toolIndex, {
      elapsedSeconds: event.elapsedSeconds,
    })
    return { session: updatedSession, streaming }
  }

  // Tool not found - shouldn't happen, but return state unchanged
  return state
}

/**
 * Handle task_completed - update background task message on completion
 *
 * When a background task completes, the SDK sends a task_notification.
 * This handler finds the tool message by taskId and updates its status
 * and result summary.
 */
export function handleTaskCompleted(
  state: SessionState,
  event: TaskCompletedEvent
): SessionState {
  const { session, streaming } = state

  // Find the tool message by taskId (set when task_backgrounded was processed)
  const toolIndex = session.messages.findIndex(m => m.taskId === event.taskId)

  if (toolIndex !== -1) {
    const updatedSession = updateMessageAt(session, toolIndex, {
      toolStatus: event.status === 'failed' ? 'error' : 'completed',
      toolResult: event.summary || `Background task ${event.status}`,
    })
    return { session: updatedSession, streaming }
  }

  // Tool not found by taskId - return state unchanged
  return state
}

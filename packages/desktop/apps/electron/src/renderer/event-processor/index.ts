/**
 * Event Processor
 *
 * Centralized event processing for agent events.
 * Replaces scattered event handling in App.tsx with pure functions.
 */

export { processEvent } from './processor'
export { useEventProcessor } from './useEventProcessor'
export type {
  SessionState,
  StreamingState,
  AgentEvent,
  ProcessResult,
  Effect,
  TextDeltaEvent,
  TextCompleteEvent,
  ToolStartEvent,
  ToolResultEvent,
  CompleteEvent,
  ErrorEvent,
  PermissionRequestEvent,
  SourcesChangedEvent,
  PlanSubmittedEvent,
  TaskBackgroundedEvent,
  ShellBackgroundedEvent,
  TaskProgressEvent,
} from './types'
export {
  generateMessageId,
  findMessageByTurnId,
  findStreamingMessage,
  findAssistantMessage,
  findToolMessage,
  updateMessageAt,
  appendMessage,
  insertMessageAt,
  createEmptySession,
} from './helpers'

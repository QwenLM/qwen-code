/**
 * Message Operation Helpers
 *
 * Pure utility functions for finding and updating messages.
 * All lookups are by ID (turnId, toolUseId) - NEVER by position.
 */

import type { Message, Session } from '../../shared/types'

let messageIdCounter = 0

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

/**
 * Find message index by turnId
 * Returns -1 if not found
 */
export function findMessageByTurnId(
  messages: Message[],
  turnId: string | undefined,
  role?: 'assistant' | 'tool'
): number {
  if (!turnId) return -1
  return messages.findIndex(m =>
    m.turnId === turnId && (!role || m.role === role)
  )
}

/**
 * Find streaming assistant message by turnId
 * Falls back to last streaming assistant if no turnId
 */
export function findStreamingMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    const index = messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId && m.isStreaming
    )
    if (index !== -1) return index
  }
  // Fallback: find last streaming assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * Find assistant message by turnId (streaming or not)
 */
export function findAssistantMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    const index = messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId
    )
    if (index !== -1) return index
  }
  // Fallback: find last streaming assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * Find tool message by toolUseId
 */
export function findToolMessage(
  messages: Message[],
  toolUseId: string
): number {
  return messages.findIndex(m => m.toolUseId === toolUseId)
}

/**
 * Update message at index, returning new session
 * Always creates new references (immutable update)
 * @param updateTimestamp - If true, also update lastMessageAt
 */
export function updateMessageAt(
  session: Session,
  index: number,
  updates: Partial<Message>,
  updateTimestamp = false
): Session {
  if (index < 0 || index >= session.messages.length) {
    return session
  }
  const messages = [...session.messages]
  messages[index] = { ...messages[index], ...updates }
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * Append message to session, returning new session
 * @param updateTimestamp - If false, don't update lastMessageAt (for intermediate/tool messages)
 */
export function appendMessage(
  session: Session,
  message: Message,
  updateTimestamp = false
): Session {
  // Guard: skip if message with same ID already exists (prevents duplicate events on Windows)
  if (message.id && session.messages.some(m => m.id === message.id)) {
    return session
  }

  // Determine if this message role should update lastMessageRole (for badge display)
  const badgeRoles = ['user', 'assistant', 'plan', 'tool', 'error'] as const
  const roleForBadge = badgeRoles.includes(message.role as typeof badgeRoles[number])
    ? message.role as Session['lastMessageRole']
    : undefined

  return {
    ...session,
    messages: [...session.messages, message],
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
    ...(roleForBadge ? { lastMessageRole: roleForBadge } : {}),
  }
}

/**
 * Insert message at index, returning new session
 * @param updateTimestamp - If false, don't update lastMessageAt (for intermediate/tool messages)
 */
export function insertMessageAt(
  session: Session,
  index: number,
  message: Message,
  updateTimestamp = false
): Session {
  const messages = [...session.messages]
  messages.splice(index, 0, message)
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * Create an empty session for a given ID
 */
export function createEmptySession(sessionId: string, workspaceId: string, workspaceName: string = ''): Session {
  return {
    id: sessionId,
    workspaceId,
    workspaceName,
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: true,
  }
}

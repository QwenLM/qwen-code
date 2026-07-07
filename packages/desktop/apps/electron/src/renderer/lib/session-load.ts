import type { Message, Session, TransportConnectionState } from '../../shared/types'

export interface SessionContentHint {
  name?: string
  preview?: string
  lastFinalMessageId?: string
  messageCount?: number | null
}

export function hasSessionContentHint(session: SessionContentHint | null | undefined): boolean {
  if (!session) return false
  return Boolean(
    session.name
    || session.preview
    || session.lastFinalMessageId
    || (session.messageCount != null && session.messageCount > 0),
  )
}

export function shouldShowForegroundMessageLoading(
  messagesLoaded: boolean,
  visibleMessageCount: number | null | undefined,
  expectedMessageCount?: number | null,
  hasContentHint = false,
): boolean {
  if ((visibleMessageCount ?? 0) > 0) return false
  if (expectedMessageCount === 0 && (messagesLoaded || !hasContentHint)) return false
  if (messagesLoaded) return hasContentHint && expectedMessageCount !== 0
  return true
}

export function shouldShowMissingSessionState({
  hasSession,
  hasSessionMeta,
  missingForMs,
  confirmationDelayMs,
}: {
  hasSession: boolean
  hasSessionMeta: boolean
  missingForMs: number
  confirmationDelayMs: number
}): boolean {
  if (hasSession || hasSessionMeta) return false
  return missingForMs >= confirmationDelayMs
}

export function shouldTreatSessionLoadFailureAsTransportFallback(
  state: TransportConnectionState | null | undefined,
): boolean {
  if (!state || state.mode !== 'remote') return false

  if (state.lastError && ['auth', 'network', 'timeout'].includes(state.lastError.kind)) {
    return true
  }

  return state.status === 'connecting'
    || state.status === 'reconnecting'
    || state.status === 'failed'
    || state.status === 'disconnected'
}

export function formatSessionLoadFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown error'
}

function mergeMessageById(existingMessage: Message, freshMessage: Message): Message {
  if (
    existingMessage.role === 'assistant'
    && freshMessage.role === 'assistant'
    && existingMessage.isStreaming
    && freshMessage.isStreaming
    && typeof existingMessage.content === 'string'
    && typeof freshMessage.content === 'string'
    && freshMessage.content.length < existingMessage.content.length
  ) {
    return existingMessage
  }

  return freshMessage
}

function mergeMessagesById(existingMessages: Message[], freshMessages: Message[]): Message[] {
  const freshById = new Map(freshMessages.map(message => [message.id, message]))
  const seen = new Set<string>()
  const merged = existingMessages.map(message => {
    seen.add(message.id)
    const freshMessage = freshById.get(message.id)
    return freshMessage ? mergeMessageById(message, freshMessage) : message
  })

  for (const message of freshMessages) {
    if (!seen.has(message.id)) merged.push(message)
  }

  return merged
}

export function mergeSessionRefreshResult(
  existingSession: Session | null | undefined,
  freshSession: Session,
): { session: Session; preservedExistingMessages: boolean } {
  if (!existingSession || existingSession.messages.length === 0) {
    return { session: freshSession, preservedExistingMessages: false }
  }

  const freshMessages = freshSession.messages ?? []
  if (freshMessages.length === 0) {
    return {
      session: { ...freshSession, messages: existingSession.messages },
      preservedExistingMessages: true,
    }
  }

  const shouldMergeProcessingSnapshot =
    freshMessages.length <= existingSession.messages.length
    && (freshSession.isProcessing || existingSession.isProcessing)

  if (!shouldMergeProcessingSnapshot) {
    return { session: freshSession, preservedExistingMessages: false }
  }

  return {
    session: {
      ...freshSession,
      messages: mergeMessagesById(existingSession.messages, freshMessages),
    },
    preservedExistingMessages: true,
  }
}

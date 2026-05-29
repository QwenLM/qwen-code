import type { TransportConnectionState } from '../../shared/types'

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

import type { TransportConnectionState } from '../../shared/types'

export function shouldShowForegroundMessageLoading(
  messagesLoaded: boolean,
  visibleMessageCount: number | null | undefined,
  expectedMessageCount?: number | null,
): boolean {
  if (messagesLoaded) return false
  if ((visibleMessageCount ?? 0) > 0) return false
  if (expectedMessageCount === 0) return false
  return true
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

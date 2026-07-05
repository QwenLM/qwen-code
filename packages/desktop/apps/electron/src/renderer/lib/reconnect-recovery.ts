import type { SessionMeta } from '@/atoms/sessions'

export function getSessionsToRefreshAfterStaleReconnect(
  metaMap: Map<string, SessionMeta>,
  activeSessionId: string | null
): string[] {
  const refreshIds = new Set<string>()

  if (activeSessionId) {
    refreshIds.add(activeSessionId)
  }

  for (const [sessionId, meta] of metaMap) {
    if (meta.isProcessing) {
      refreshIds.add(sessionId)
    }
  }

  return [...refreshIds]
}

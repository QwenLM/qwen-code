export type BrowserOwnershipReleaser = {
  clearVisualsForSession(sessionId: string): Promise<void>
  unbindAllForSession(sessionId: string): void
}

export async function releaseBrowserOwnershipOnForcedStop(
  browserPaneManager: BrowserOwnershipReleaser | null | undefined,
  sessionId: string,
): Promise<void> {
  if (!browserPaneManager) return
  await browserPaneManager.clearVisualsForSession(sessionId)
  browserPaneManager.unbindAllForSession(sessionId)
}

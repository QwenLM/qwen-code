export interface ScopedInputEventTarget {
  sessionId?: string | null
  isFocusedPanel: boolean
  targetSessionId?: string
}

/**
 * Decide whether an input-affecting custom event should be handled by
 * this FreeFormInput instance.
 */
export function shouldHandleScopedInputEvent({
  sessionId,
  isFocusedPanel,
  targetSessionId,
}: ScopedInputEventTarget): boolean {
  if (targetSessionId) {
    return targetSessionId === sessionId
  }
  return isFocusedPanel
}

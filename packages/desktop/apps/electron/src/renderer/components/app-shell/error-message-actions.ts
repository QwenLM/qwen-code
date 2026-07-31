import { navigate, routes } from '@/lib/navigate'
import { dispatchFocusInputEvent } from '@/components/app-shell/input/focus-input-events'
import type { Message } from '../../../shared/types'

export type ErrorMessageAction = NonNullable<Message['errorActions']>[number]

export interface HandleErrorMessageActionOptions {
  sessionId?: string
  onOpenUrl?: (url: string) => void
  onOpenSettings?: () => void
  onRetryFocus?: (detail?: { sessionId?: string }) => void
  onRetry?: () => void
}

/**
 * Execute an error-message action using the app's canonical handlers.
 *
 * Retry intentionally routes through the session-scoped focus event system
 * instead of querying the DOM, which is fragile in multi-panel mode and
 * no longer matches the RichTextInput implementation.
 */
export function handleErrorMessageAction(
  action: ErrorMessageAction,
  {
    sessionId,
    onOpenUrl,
    onOpenSettings = () => navigate(routes.view.settings()),
    onRetryFocus = dispatchFocusInputEvent,
    onRetry,
  }: HandleErrorMessageActionOptions = {},
): void {
  if (action.action === 'open_url') {
    if (action.url && onOpenUrl) {
      onOpenUrl(action.url)
    }
    return
  }

  if (action.action === 'settings') {
    onOpenSettings()
    return
  }

  if (action.action === 'retry') {
    if (onRetry) {
      onRetry()
    } else {
      onRetryFocus({ sessionId })
    }
  }
}

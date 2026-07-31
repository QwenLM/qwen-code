/**
 * MessagingSessionMenuItem
 *
 * The "Connect Messaging → Telegram / WhatsApp" submenu block shared by
 * SessionMenu (real context/dropdown menus) and the playground preview.
 *
 * Behavior:
 *  - If the target platform isn't connected yet, route the user to the right
 *    setup entry point (WhatsApp opens the connect dialog; Telegram defaults
 *    to navigating to messaging settings + toasting — callers can override
 *    that via `onTelegramNotConfigured`).
 *  - If the platform is connected, dispatch `messagingDialogAtom` with a
 *    pairing-code dialog and kick off `generateMessagingPairingCode`.
 *
 * Renders the `<Sub>` block only — the caller decides placement and
 * separators. Reads menu primitives from `useMenuComponents()` so it works
 * identically inside a DropdownMenu or ContextMenu.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import type { TFunction } from 'i18next'
import { navigate, routes } from '@/lib/navigate'
import { useMenuComponents } from '@/components/ui/menu-context'
import { messagingDialogAtom } from '@/atoms/messaging'

export interface MessagingSessionMenuItemProps {
  /** Session to bind the pairing code to. */
  sessionId: string
  /**
   * Called when the user clicks Telegram but Telegram isn't connected yet.
   * Default: navigate to messaging settings + toast.
   * Playground overrides this to toast only (it has no router).
   */
  onTelegramNotConfigured?: () => void
  /**
   * Override the error classifier used when pairing-code generation fails.
   * Default: {@link classifyMessagingError} — matches "not connected" and
   * "rate limit" messages into i18n keys.
   */
  classifyError?: (err: unknown, t: TFunction) => string
}

export function MessagingSessionMenuItem({
  sessionId,
  onTelegramNotConfigured,
  classifyError = classifyMessagingError,
}: MessagingSessionMenuItemProps) {
  const { t } = useTranslation()
  const setMessagingDialog = useSetAtom(messagingDialogAtom)
  const { MenuItem, Sub, SubTrigger, SubContent } = useMenuComponents()

  const handleConnectMessaging = async (platform: 'telegram' | 'whatsapp') => {
    // First-run check — avoid hitting the server if the platform is not
    // connected. Failure to read config is treated as "unknown" and falls
    // through to attempting pairing so the server surfaces a real error.
    try {
      const cfg = await window.electronAPI.getMessagingConfig()
      const runtime = cfg?.runtime?.[platform]
      const isConnected = Boolean(runtime?.connected)
      if (!isConnected) {
        if (platform === 'whatsapp') {
          setMessagingDialog({ kind: 'wa_connect', continueToPairingSessionId: sessionId })
        } else if (onTelegramNotConfigured) {
          onTelegramNotConfigured()
        } else {
          navigate(routes.view.settings('messaging'))
          toast.info(t('toast.telegramNotConfiguredOpenSettings'))
        }
        return
      }
    } catch {
      // Fall through to attempting pairing code generation.
    }

    setMessagingDialog({
      kind: 'pairing',
      platform,
      sessionId,
      code: null,
      expiresAt: null,
    })
    try {
      const result = await window.electronAPI.generateMessagingPairingCode(sessionId, platform)
      setMessagingDialog({
        kind: 'pairing',
        platform,
        sessionId,
        code: result.code,
        expiresAt: result.expiresAt,
        botUsername: result.botUsername,
      })
    } catch (err) {
      setMessagingDialog({
        kind: 'pairing',
        platform,
        sessionId,
        code: null,
        expiresAt: null,
        error: classifyError(err, t),
      })
    }
  }

  return (
    <Sub>
      <SubTrigger className="pr-2">
        <MessageSquare className="h-3.5 w-3.5" />
        <span className="flex-1">{t('sessionMenu.connectMessaging')}</span>
      </SubTrigger>
      <SubContent>
        <MenuItem onClick={() => handleConnectMessaging('telegram')}>
          <span>Telegram</span>
        </MenuItem>
        <MenuItem onClick={() => handleConnectMessaging('whatsapp')}>
          <span>WhatsApp</span>
        </MenuItem>
      </SubContent>
    </Sub>
  )
}

/**
 * Translate raw errors from the pairing-code RPC into user-facing text.
 * Narrow on purpose — only classifies well-known failure modes; anything else
 * is surfaced verbatim so real errors aren't hidden.
 */
export function classifyMessagingError(err: unknown, t: TFunction): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/platform not connected|no adapter|not configured/i.test(msg)) {
    return t('toast.messagingNotConfigured')
  }
  if (/rate.?limit/i.test(msg)) {
    return t('toast.messagingRateLimited')
  }
  return msg
}

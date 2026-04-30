/**
 * MessagingSubmenuPreview
 *
 * Renders a focused demo of just the "Connect Messaging" submenu shared with
 * the real SessionMenu. Clicking either branch runs the same code path:
 *   - When the platform is not connected, it opens the WhatsApp connect
 *     dialog (WhatsApp) or toasts (Telegram — playground has no router).
 *   - When connected, it dispatches a pairing dialog via messagingDialogAtom.
 *
 * We mount <MessagingDialogHost /> so the dispatched dialogs actually show
 * up in the preview.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '../../../components/ui/styled-dropdown'
import { MessagingDialogHost } from '../../../components/messaging/MessagingDialogHost'
import { MessagingSessionMenuItem } from '../../../components/messaging/MessagingSessionMenuItem'
import { playgroundMessagingHandle } from '../../mock-utils'

export interface MessagingSubmenuPreviewProps {
  telegramConnected: boolean
  whatsappConnected: boolean
}

const PLAYGROUND_SESSION_ID = 'playground-session-xyz'

export function MessagingSubmenuPreview({
  telegramConnected,
  whatsappConnected,
}: MessagingSubmenuPreviewProps) {
  const { t } = useTranslation()

  // Keep the mock messaging state in sync with the variant props so the
  // connect flow's config check reflects what the preview claims.
  React.useEffect(() => {
    playgroundMessagingHandle.setTelegramConnected(
      telegramConnected,
      telegramConnected ? 'Playground Bot' : undefined,
    )
  }, [telegramConnected])

  React.useEffect(() => {
    playgroundMessagingHandle.setWhatsAppConnected(
      whatsappConnected,
      whatsappConnected ? 'Gyula' : undefined,
    )
  }, [whatsappConnected])

  return (
    <div className="flex flex-col items-start gap-4 p-6">
      <div className="text-xs text-muted-foreground">
        Click the button to open the session menu. Hover &ldquo;Connect Messaging&rdquo; for the submenu.
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent">
            Session options
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="start">
          <MessagingSessionMenuItem
            sessionId={PLAYGROUND_SESSION_ID}
            onTelegramNotConfigured={() => toast.info(t('toast.telegramNotConfiguredOpenSettings'))}
          />
        </StyledDropdownMenuContent>
      </DropdownMenu>
      <MessagingDialogHost />
    </div>
  )
}

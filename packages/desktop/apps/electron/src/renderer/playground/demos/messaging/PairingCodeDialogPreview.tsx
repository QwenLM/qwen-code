/**
 * PairingCodeDialogPreview
 *
 * Renders the real PairingCodeDialog with `open` wired to local state so the
 * user can dismiss it (ESC / outside click / close button) just like in the
 * real app. The dialog auto-reopens whenever any display prop changes so that
 * switching variants in the playground sidebar brings it back without needing
 * a separate "reopen" button. Computes `expiresAt` from an
 * `expiresInSeconds` prop so the variant sidebar can show "Expired" (0) or
 * a specific countdown state.
 */

import * as React from 'react'
import { PairingCodeDialog } from '../../../components/messaging/PairingCodeDialog'

export interface PairingCodeDialogPreviewProps {
  platform: 'telegram' | 'whatsapp'
  code: string
  expiresInSeconds: number
  botUsername: string
  error: string
}

export function PairingCodeDialogPreview({
  platform,
  code,
  expiresInSeconds,
  botUsername,
  error,
}: PairingCodeDialogPreviewProps) {
  const [open, setOpen] = React.useState(true)

  // Reopen on any prop change so switching variants in the sidebar brings
  // the dialog back up after the user has dismissed it.
  React.useEffect(() => {
    setOpen(true)
  }, [platform, code, expiresInSeconds, botUsername, error])

  // Recompute expiresAt when the countdown prop changes so the timer restarts.
  const expiresAt = React.useMemo(() => {
    if (expiresInSeconds < 0) return null
    return Date.now() + expiresInSeconds * 1000
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresInSeconds])

  return (
    <>
      <PairingCodeDialog
        open={open}
        onOpenChange={setOpen}
        platform={platform}
        code={code || null}
        expiresAt={expiresAt}
        botUsername={botUsername || undefined}
        error={error || undefined}
      />
      {!open && (
        <div className="p-6 text-sm text-foreground/60">
          Dialog dismissed.{' '}
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => setOpen(true)}
          >
            Reopen
          </button>
        </div>
      )}
    </>
  )
}

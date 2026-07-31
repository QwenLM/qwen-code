/**
 * TelegramConnectDialog — token-input pairing flow in a modal.
 *
 * Sibling to WhatsAppConnectDialog: same Dialog shape, different auth flow
 * (Telegram Bot API doesn't support QR login — only bot tokens issued by
 * @BotFather). User pastes a token → Test → Save → dialog closes.
 *
 * Used by MessagingSettingsPage as the only flow for saving Telegram tokens.
 * The `reconfigure` prop is set when the user picks "Reconfigure" from the
 * three-dot menu, so the UI treats it as replacing an existing token.
 */

import * as React from 'react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { SettingsSecretInput } from '@/components/settings'

interface TelegramConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing token" (used from Reconfigure menu item). */
  reconfigure?: boolean
  onSaved?: () => void
}

type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; botName?: string; botUsername?: string }
  | { state: 'error'; error: string }

export function TelegramConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: TelegramConnectDialogProps) {
  const { t } = useTranslation()
  const [token, setToken] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })

  // Reset local state whenever dialog (re)opens — keeps reconfigure attempts
  // from leaking previous success/error badges.
  React.useEffect(() => {
    if (!open) {
      setToken('')
      setTest({ state: 'idle' })
      setSaving(false)
    }
  }, [open])

  const handleTest = async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testTelegramToken(trimmed)
      if (result.success) {
        setTest({ state: 'success', botName: result.botName, botUsername: result.botUsername })
      } else {
        setTest({ state: 'error', error: result.error ?? t('common.error') })
      }
    } catch (err) {
      setTest({
        state: 'error',
        error: err instanceof Error ? err.message : t('common.error'),
      })
    }
  }

  const handleSave = async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await window.electronAPI.saveTelegramToken(trimmed)
      toast.success(t('settings.messaging.telegram.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.telegram.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.telegram.reconfigureTitle', {
                  defaultValue: 'Replace Telegram token',
                })
              : t('settings.messaging.telegram.connectTitle', {
                  defaultValue: 'Connect Telegram',
                })}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.telegram.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <SettingsSecretInput
            value={token}
            onChange={setToken}
            placeholder={t('settings.messaging.telegram.tokenPlaceholder')}
            disabled={saving}
          />

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!token.trim() || test.state === 'testing' || saving}
            >
              {test.state === 'testing' && <Spinner className="mr-1 text-[14px]" />}
              {t('settings.messaging.telegram.testConnection')}
            </Button>

            {test.state === 'success' && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t('settings.messaging.telegram.validBot', {
                  username: test.botUsername ?? test.botName ?? 'bot',
                })}
              </span>
            )}
            {test.state === 'error' && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                <X className="h-3.5 w-3.5" />
                {test.error}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={!token.trim() || test.state !== 'success' || saving}
          >
            {saving && <Spinner className="mr-1 text-[14px]" />}
            {t('settings.messaging.telegram.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

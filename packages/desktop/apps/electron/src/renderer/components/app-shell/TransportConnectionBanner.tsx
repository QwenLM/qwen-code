import i18n from 'i18next'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { TransportConnectionState } from '../../../shared/types'

export function shouldShowTransportConnectionBanner(state: TransportConnectionState | null): boolean {
  if (!state || state.mode === 'local') return false
  return state.status !== 'connected' && state.status !== 'idle'
}

export interface TransportBannerCopy {
  title: string
  description: string
  showRetry: boolean
  tone: 'warning' | 'error' | 'info'
}

export function getTransportBannerCopy(state: TransportConnectionState): TransportBannerCopy {
  switch (state.status) {
    case 'connecting':
      return {
        title: i18n.t('transport.connecting'),
        description: i18n.t('transport.connectingDesc', { url: state.url }),
        showRetry: false,
        tone: 'info',
      }

    case 'reconnecting': {
      const retry = state.nextRetryInMs != null ? i18n.t('transport.retryIn', { ms: state.nextRetryInMs }) : i18n.t('transport.retrying')
      return {
        title: i18n.t('transport.reconnecting'),
        description: i18n.t('transport.reconnectingDesc', { reason: getFailureReason(state), retry, attempt: state.attempt }),
        showRetry: true,
        tone: 'warning',
      }
    }

    case 'failed':
      return {
        title: i18n.t('transport.failed'),
        description: getFailureReason(state),
        showRetry: true,
        tone: 'error',
      }

    case 'disconnected':
      return {
        title: i18n.t('transport.disconnected'),
        description: getFailureReason(state),
        showRetry: true,
        tone: 'warning',
      }

    default:
      return {
        title: i18n.t('transport.defaultStatus'),
        description: getFailureReason(state),
        showRetry: true,
        tone: 'info',
      }
  }
}

function getFailureReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    if (err.kind === 'auth') return i18n.t('transport.authFailed')
    if (err.kind === 'protocol') return i18n.t('transport.protocolMismatch')
    if (err.kind === 'timeout') return i18n.t('transport.timeout', { url: state.url })
    if (err.kind === 'network') return i18n.t('transport.networkError', { url: state.url })
    return err.message
  }

  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? i18n.t('transport.wsClosedReason', { reason: state.lastClose.reason }) : ''
    return i18n.t('transport.wsClosedWithCode', { code: state.lastClose.code, reason })
  }

  return i18n.t('transport.waitingForConnection')
}

export function TransportConnectionBanner({
  state,
  onRetry,
}: {
  state: TransportConnectionState
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const copy = getTransportBannerCopy(state)

  const toneClasses = copy.tone === 'error'
    ? 'border-destructive/30 bg-destructive/10 text-destructive'
    : copy.tone === 'warning'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'

  return (
    <div className={`shrink-0 border-b px-4 py-2 ${toneClasses}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{copy.title}</p>
          <p className="text-xs opacity-90 truncate">{copy.description}</p>
        </div>
        {copy.showRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} className="shrink-0 h-7">
            {t('common.retry')}
          </Button>
        )}
      </div>
    </div>
  )
}

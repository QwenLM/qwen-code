import * as React from 'react'
import * as Sentry from '@sentry/electron/renderer'
import { useTranslation } from 'react-i18next'
import { AlertCircle, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface InputErrorBoundaryProps {
  sessionId?: string
  resetKey: string
  onClearDraft?: () => void
  children: React.ReactNode
}

interface InputErrorBoundaryState {
  hasError: boolean
}

/**
 * Keeps chat input failures local to the composer area so the rest of the chat
 * page remains usable. This is intentionally narrower than the root Sentry
 * boundary because malformed drafts or future composer bugs should not blank the
 * entire app.
 */
export class InputErrorBoundary extends React.Component<
  InputErrorBoundaryProps,
  InputErrorBoundaryState
> {
  state: InputErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): InputErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[InputErrorBoundary] Composer crashed:', error)
    Sentry.captureException(error, {
      tags: { errorSource: 'chat-input' },
      extra: {
        sessionId: this.props.sessionId,
        componentStack: info.componentStack,
      },
    })
  }

  componentDidUpdate(prevProps: InputErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  private retry = () => {
    this.setState({ hasError: false })
  }

  private clearDraftAndRetry = () => {
    this.props.onClearDraft?.()
    this.setState({ hasError: false })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <InputErrorFallback
        onRetry={this.retry}
        onClearDraft={this.clearDraftAndRetry}
      />
    )
  }
}

function InputErrorFallback({
  onRetry,
  onClearDraft,
}: {
  onRetry: () => void
  onClearDraft: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="rounded-[12px] border border-destructive/20 bg-background px-4 py-4 shadow-minimal">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
          <AlertCircle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('chat.inputFailedTitle')}</p>
          <p className="mt-1 text-xs text-foreground/60">
            {t('chat.inputFailedDescription')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" />
              {t('common.retry')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onClearDraft}>
              <Trash2 className="h-4 w-4" />
              {t('chat.clearDraft')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => window.location.reload()}>
              {t('common.reload')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

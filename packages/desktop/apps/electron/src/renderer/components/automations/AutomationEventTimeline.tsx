/**
 * AutomationEventTimeline
 *
 * Compact timeline showing recent automation executions.
 * Displayed as a section within AutomationInfoPage.
 * Webhook entries are expandable to show execution details.
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, ShieldAlert, ChevronDown, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavigation } from '@/contexts/NavigationContext'
import { type ExecutionEntry, type ExecutionStatus } from './types'
import { formatShortRelativeTime } from './utils'

// ============================================================================
// Helpers
// ============================================================================

const statusConfig: Record<ExecutionStatus, { icon: React.ElementType; classes: string }> = {
  success: { icon: CheckCircle2, classes: 'text-success' },
  error:   { icon: XCircle,      classes: 'text-destructive' },
  blocked: { icon: ShieldAlert,   classes: 'text-warning' },
}

function formatStatusCode(code: number, t: (key: string) => string): string {
  if (code === 0) return t('automations.noResponse')
  return String(code)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ============================================================================
// Component
// ============================================================================

export interface AutomationEventTimelineProps {
  entries: ExecutionEntry[]
  className?: string
  onReplay?: (automationId: string, event: string) => void
}

function CopyButton({ details }: { details: import('./types').WebhookDetails }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const meta: Record<string, unknown> = {
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      durationMs: details.durationMs,
    }
    if (details.attempts && details.attempts > 1) meta.attempts = details.attempts
    if (details.error) meta.error = details.error

    // Build copy text: structured metadata + raw response body (which may be truncated / not valid JSON)
    let text = JSON.stringify(meta, null, 2)
    if (details.responseBody) {
      text += '\n\n--- Response Body ---\n' + details.responseBody
    }

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [details])

  const Icon = copied ? Check : Copy

  return (
    <button
      className={cn(
        'shrink-0 p-1 rounded hover:bg-foreground/10 transition-colors',
        copied ? 'text-success' : 'text-foreground/40 hover:text-foreground/60',
      )}
      onClick={handleCopy}
      title={t('automations.copyPayload')}
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

export function AutomationEventTimeline({ entries, className, onReplay }: AutomationEventTimelineProps) {
  const { t } = useTranslation()
  const { navigateToSession } = useNavigation()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-muted-foreground">
        {t('automations.noActivityYet')}
      </div>
    )
  }

  return (
    <div className={cn('divide-y divide-border/30', className)}>
      {entries.map((entry) => {
        const config = statusConfig[entry.status]
        const StatusIcon = config.icon
        const isWebhook = !!entry.webhookDetails
        const isExpanded = expandedId === entry.id

        const handleToggle = isWebhook ? () => setExpandedId(isExpanded ? null : entry.id) : undefined
        const handleKeyDown = isWebhook ? (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpandedId(isExpanded ? null : entry.id)
          }
        } : undefined

        return (
          <div key={entry.id}>
            <div
              className={cn(
                'flex items-center gap-3 px-4 py-2.5 text-sm',
                isWebhook && 'cursor-pointer hover:bg-foreground/[0.03] transition-colors',
              )}
              onClick={handleToggle}
              onKeyDown={handleKeyDown}
              role={isWebhook ? 'button' : undefined}
              tabIndex={isWebhook ? 0 : undefined}
            >
              {/* Status icon */}
              <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', config.classes)} />

              {/* Time */}
              <span className="text-xs text-muted-foreground w-16 shrink-0 tabular-nums">
                {formatShortRelativeTime(entry.timestamp)}
              </span>

              {/* Action summary — truncated prompt text */}
              <span className="flex-1 min-w-0 truncate text-xs text-foreground/70">
                {entry.actionSummary || entry.error || '—'}
              </span>

              {/* Session deep link */}
              {entry.sessionId && (
                <button
                  className="shrink-0 text-[11px] text-accent hover:underline cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); navigateToSession(entry.sessionId!) }}
                >
                  {t('automations.openSession')}
                </button>
              )}

              {/* Retry button for failed webhook entries */}
              {entry.status === 'error' && isWebhook && onReplay && (
                <button
                  className="shrink-0 text-[11px] text-accent hover:underline cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); onReplay(entry.automationId, entry.event) }}
                >
                  {t('automations.retry')}
                </button>
              )}

              {/* Expand chevron for webhook entries */}
              {isWebhook && (
                <ChevronDown className={cn(
                  'h-3 w-3 shrink-0 text-foreground/40 transition-transform duration-150',
                  isExpanded && 'rotate-180',
                )} />
              )}
            </div>

            {/* Expanded webhook details */}
            {isExpanded && entry.webhookDetails && (
              <div className="mx-4 mb-3 mt-0.5 rounded-md border border-border/40 bg-foreground/[0.02] px-3 py-2.5 text-xs relative">
                <div className="absolute top-2 right-2">
                  <CopyButton details={entry.webhookDetails} />
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 pr-6">
                  <span className="text-foreground/50">{t('automations.webhookMethod')}</span>
                  <span className="font-mono text-foreground/80">{entry.webhookDetails.method}</span>

                  <span className="text-foreground/50">{t('automations.webhookUrl')}</span>
                  <span className="font-mono text-foreground/80 break-all">{entry.webhookDetails.url}</span>

                  <span className="text-foreground/50">{t('automations.webhookStatus')}</span>
                  <span className={cn(
                    'font-mono',
                    entry.webhookDetails.statusCode >= 200 && entry.webhookDetails.statusCode < 300
                      ? 'text-success'
                      : 'text-destructive',
                  )}>
                    {formatStatusCode(entry.webhookDetails.statusCode, t)}
                  </span>

                  <span className="text-foreground/50">{t('automations.webhookDuration')}</span>
                  <span className="font-mono text-foreground/80">{formatDuration(entry.webhookDetails.durationMs)}</span>

                  {entry.webhookDetails.attempts && entry.webhookDetails.attempts > 1 && (
                    <>
                      <span className="text-foreground/50">{t('automations.webhookAttempts')}</span>
                      <span className="font-mono text-foreground/80">{entry.webhookDetails.attempts}</span>
                    </>
                  )}

                  {entry.webhookDetails.error && (
                    <>
                      <span className="text-foreground/50">{t('automations.webhookError')}</span>
                      <span className="font-mono text-destructive">{entry.webhookDetails.error}</span>
                    </>
                  )}
                </div>

                {entry.webhookDetails.responseBody && (
                  <div className="mt-2 pt-2 border-t border-border/30">
                    <span className="text-foreground/50">{t('automations.webhookResponse')}</span>
                    <pre className="mt-1 max-h-24 overflow-auto rounded bg-foreground/[0.04] p-2 font-mono text-[11px] text-foreground/70 whitespace-pre-wrap break-all">
                      {entry.webhookDetails.responseBody}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * AutomationActionRow
 *
 * Inline display of a single automation action (prompt or webhook).
 * Used within the "Then" section of AutomationInfoPage.
 */

import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { AutomationAction } from './types'
import { ActionTypeIcon } from './ActionTypeIcon'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

export interface AutomationActionRowProps {
  action: AutomationAction
  index: number
  className?: string
}

/**
 * Highlight @mentions in prompt strings
 */
function PromptText({ text, t }: { text: string; t: (key: string) => string }) {
  if (!text) return <span className="text-sm text-muted-foreground italic">{t('automations.emptyPrompt')}</span>
  const parts = text.split(/(@\w[\w-]*)/g)
  return (
    <span className="text-sm break-words">
      {parts.map((part, i) =>
        part.startsWith('@') ? (
          <span key={i} className="text-accent font-medium">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  )
}

function WebhookText({ action }: { action: Extract<AutomationAction, { type: 'webhook' }> }) {
  const method = action.method ?? DEFAULT_WEBHOOK_METHOD
  return (
    <span className="text-sm break-words">
      <span className="font-mono font-medium text-accent">{method}</span>{' '}
      <span className="text-foreground/70">{action.url}</span>
      {action.bodyFormat && (
        <span className="text-foreground/40 ml-1">({action.bodyFormat})</span>
      )}
    </span>
  )
}

export function AutomationActionRow({ action, index, className }: AutomationActionRowProps) {
  const { t } = useTranslation()
  const isWebhook = action.type === 'webhook'

  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', className)}>
      {/* Index + icon — h-5 matches the first line height of text-sm content */}
      <div className="flex items-center gap-2 shrink-0 h-5 mt-[3px]">
        <span className="text-xs text-muted-foreground tabular-nums w-4 text-right">
          {index + 1}.
        </span>
        <ActionTypeIcon type={action.type} className="h-3.5 w-3.5" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isWebhook ? (
          <WebhookText action={action} />
        ) : (
          <PromptText text={action.prompt} t={t} />
        )}
      </div>
    </div>
  )
}

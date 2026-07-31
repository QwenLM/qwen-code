/**
 * AutomationActionPreview
 *
 * Compact action list for expanded rows in AutomationCard and AutomationsListPanel.
 * Shows MessageSquare/Webhook icon + truncated text.
 *
 * For the full-size info page with index numbering and @mention highlighting,
 * use AutomationActionRow instead.
 */

import { cn } from '@/lib/utils'
import type { AutomationAction } from './types'
import { ActionTypeIcon } from './ActionTypeIcon'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

export interface AutomationActionPreviewProps {
  actions: AutomationAction[]
  className?: string
}

export function AutomationActionPreview({ actions, className }: AutomationActionPreviewProps) {
  return (
    <div className={cn('space-y-1', className)}>
      {actions.map((action, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <ActionTypeIcon type={action.type} className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="text-foreground/70 break-words line-clamp-2">
            {action.type === 'webhook'
              ? `${action.method ?? DEFAULT_WEBHOOK_METHOD} ${action.url}`
              : action.prompt}
          </span>
        </div>
      ))}
    </div>
  )
}

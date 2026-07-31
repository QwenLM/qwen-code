/**
 * InlineExecution - Compact execution view for EditPopover
 *
 * Shows mini agent execution progress inline within a popover,
 * transitioning through: executing → success | error states.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, X } from 'lucide-react'
import { cn } from '@craft-agent/ui'
import { ActivityStatusIcon, SIZE_CONFIG, type ActivityItem, type ActivityStatus } from './TurnCard'
import { LoadingIndicator } from '../ui/LoadingIndicator'
import { Markdown } from '../markdown'

// ============================================================================
// Types
// ============================================================================

export type InlineExecutionStatus = 'executing' | 'success' | 'error'

export interface InlineActivityItem {
  id: string
  name: string
  status: ActivityStatus
  description?: string
}

export interface InlineExecutionProps {
  /** Current execution status */
  status: InlineExecutionStatus
  /** Activities to display (simplified from full ActivityItem) */
  activities: InlineActivityItem[]
  /** Result message on success */
  result?: string
  /** Error message on failure */
  error?: string
  /** Callback to cancel execution */
  onCancel?: () => void
  /** Callback to dismiss (on success/error) */
  onDismiss?: () => void
  /** Callback to retry (on error) */
  onRetry?: () => void
  /** Optional className */
  className?: string
}

// ============================================================================
// Simple Activity Row for Inline View
// ============================================================================

function InlineActivityRow({ activity }: { activity: InlineActivityItem }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-0.5 text-muted-foreground",
        SIZE_CONFIG.fontSize
      )}
    >
      <ActivityStatusIcon status={activity.status} toolName={activity.name} />
      <span className="shrink-0">{activity.name}</span>
      {activity.description && (
        <>
          <span className="opacity-60 shrink-0">·</span>
          <span className="truncate min-w-0 flex-1">{activity.description}</span>
        </>
      )}
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function InlineExecution({
  status,
  activities,
  result,
  error,
  onCancel,
  onDismiss,
  onRetry,
  className,
}: InlineExecutionProps) {
  const { t } = useTranslation()
  // Executing state
  if (status === 'executing') {
    return (
      <div className={cn("space-y-3", className)}>
        {/* Header with spinner */}
        <div className="flex items-center gap-2">
          <LoadingIndicator animated showElapsed />
          <span className={cn("text-foreground/80", SIZE_CONFIG.fontSize)}>
            {t('common.editing')}
          </span>
        </div>

        {/* Activity list - show only last 3 */}
        {activities.length > 0 && (
          <div className="space-y-0.5 pl-1">
            {activities.slice(-3).map((activity) => (
              <InlineActivityRow key={activity.id} activity={activity} />
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-start pt-1 border-t border-border/30">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              "text-muted-foreground hover:text-foreground transition-colors",
              SIZE_CONFIG.fontSize
            )}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    )
  }

  // Success state
  if (status === 'success') {
    return (
      <div className={cn("space-y-3", className)}>
        {/* Header with checkmark */}
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-success" />
          <span className={cn("text-foreground font-medium", SIZE_CONFIG.fontSize)}>
            {t('common.done')}
          </span>
        </div>

        {/* Result message - rendered as markdown */}
        {result && (
          <div className={cn("text-muted-foreground leading-relaxed prose-compact", SIZE_CONFIG.fontSize)}>
            <Markdown>{result}</Markdown>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end pt-1 border-t border-border/30">
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-md bg-success/10 text-success hover:bg-success/20 transition-colors",
              SIZE_CONFIG.fontSize
            )}
          >
            <CheckCircle2 className="w-3 h-3" />
            {t('common.done')}
          </button>
        </div>
      </div>
    )
  }

  // Error state
  return (
    <div className={cn("space-y-3", className)}>
      {/* Header with error icon */}
      <div className="flex items-center gap-2">
        <XCircle className="w-4 h-4 text-destructive" />
        <span className={cn("text-foreground font-medium", SIZE_CONFIG.fontSize)}>
          {t('common.failed')}
        </span>
      </div>

      {/* Error message - rendered as markdown */}
      {error && (
        <div className={cn("text-destructive/80 leading-relaxed prose-compact", SIZE_CONFIG.fontSize)}>
          <Markdown>{error}</Markdown>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/30">
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            "flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors",
            SIZE_CONFIG.fontSize
          )}
        >
          <X className="w-3 h-3" />
          {t('common.dismiss')}
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              "px-2 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors",
              SIZE_CONFIG.fontSize
            )}
          >
            {t('common.retry')}
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Utility: Map SessionEvent to InlineActivityItem
// ============================================================================

/**
 * Map a tool event to an InlineActivityItem.
 * Use this when processing session events in EditPopover.
 */
export function mapToolEventToActivity(
  toolName: string,
  toolUseId: string,
  status: ActivityStatus,
  description?: string
): InlineActivityItem {
  // Clean up tool names (strip MCP prefixes for display)
  const displayName = toolName
    .replace(/^mcp__[^_]+__/, '')  // Remove mcp__server__ prefix
    .replace(/_/g, ' ')            // Replace underscores with spaces
    .replace(/\b\w/g, c => c.toUpperCase())  // Title case

  return {
    id: toolUseId,
    name: displayName,
    status,
    description,
  }
}

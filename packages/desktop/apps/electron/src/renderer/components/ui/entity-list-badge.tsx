/**
 * EntityListBadge — Generic configurable pill badge for use inside EntityRow badge rows.
 *
 * Two variants:
 * - "text" (default): Fixed-height text pill (h-[18px]) with padding.
 * - "icon": 18×18 centered icon box (no text padding).
 *
 * Color is caller-controlled via `colorClass` or inline `style`.
 */

import * as React from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

export interface EntityListBadgeProps {
  /** Badge content (text or icon) */
  children: React.ReactNode
  /** "text" (default) = text pill, "icon" = 18×18 centered icon box */
  variant?: 'text' | 'icon'
  /** Color classes, e.g. "bg-accent/10 text-accent" */
  colorClass?: string
  /** Inline styles — for runtime-computed colors (e.g. label color-mix) */
  style?: React.CSSProperties
  /** Optional tooltip text (shown on hover) */
  tooltip?: string
  /** Additional className */
  className?: string
}

export function EntityListBadge({ children, variant = 'text', colorClass, style, tooltip, className }: EntityListBadgeProps) {
  const badge = (
    <span
      className={cn(
        "shrink-0 rounded",
        variant === 'icon'
          ? "h-[18px] w-[18px] flex items-center justify-center"
          : "h-[18px] px-1.5 text-[10px] font-medium flex items-center whitespace-nowrap",
        colorClass,
        className,
      )}
      style={style}
    >
      {children}
    </span>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <span className="text-xs">{tooltip}</span>
        </TooltipContent>
      </Tooltip>
    )
  }

  return badge
}

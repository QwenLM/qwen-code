/**
 * Info_Table
 *
 * Clean definition list style key-value display.
 * Use for Connection info, metadata display, etc.
 * No card wrapper - integrates cleanly with page.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface Info_TableProps {
  children: React.ReactNode
  /** Optional footer content (e.g., error alert) */
  footer?: React.ReactNode
  /** Label column width in pixels (default: 120) */
  labelWidth?: number
  className?: string
}

export interface Info_TableRowProps {
  /** Left column label */
  label: string
  /** Right column value (shorthand) */
  value?: React.ReactNode
  /** Right column content (for complex content, use instead of value) */
  children?: React.ReactNode
  className?: string
}

function Info_TableRoot({
  children,
  footer,
  labelWidth = 120,
  className,
}: Info_TableProps) {
  return (
    <div className={cn('py-2', className)}>
      <dl
        className="divide-y divide-border/30"
        style={{ '--label-width': `${labelWidth}px` } as React.CSSProperties}
      >
        {children}
      </dl>
      {footer}
    </div>
  )
}

function Info_TableRow({ label, value, children, className }: Info_TableRowProps) {
  const content = children ?? value

  return (
    <div className={cn('flex py-2.5 px-4 text-sm', className)}>
      <dt
        className="text-muted-foreground shrink-0"
        style={{ width: 'var(--label-width)' }}
      >
        {label}
      </dt>
      <dd className="flex-1 min-w-0">{content}</dd>
    </div>
  )
}

export const Info_Table = Object.assign(Info_TableRoot, {
  Row: Info_TableRow,
})

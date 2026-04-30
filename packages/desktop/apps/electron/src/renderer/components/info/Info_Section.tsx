/**
 * Info_Section
 *
 * Section container with title, optional description, and content card.
 * Matches SettingsSection styling pattern.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface Info_SectionProps {
  /** Section title */
  title: string
  /** Optional description below title */
  description?: string
  /** Optional right-aligned header actions */
  actions?: React.ReactNode
  /** Section content */
  children: React.ReactNode
  className?: string
}

export function Info_Section({
  title,
  description,
  actions,
  children,
  className,
}: Info_SectionProps) {
  return (
    <section className={cn('space-y-3 pt-2', className)}>
      <div className="flex items-start justify-between pl-1">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">
            {title}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden">
        {children}
      </div>
    </section>
  )
}

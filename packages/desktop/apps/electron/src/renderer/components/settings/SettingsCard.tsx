/**
 * SettingsCard
 *
 * Container card with muted background for grouping related settings.
 * Children are separated by internal dividers.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SettingsCardProps {
  /** Card content */
  children: React.ReactNode
  /** Additional className */
  className?: string
  /** Whether to add internal dividers between children */
  divided?: boolean
}

/**
 * SettingsCard - Container for grouping related settings
 *
 * @example
 * <SettingsCard>
 *   <SettingsToggle label="Option 1" ... />
 *   <SettingsToggle label="Option 2" ... />
 * </SettingsCard>
 */
export function SettingsCard({ children, className, divided = true }: SettingsCardProps) {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <div
      className={cn(
        'rounded-xl bg-background shadow-minimal overflow-hidden',
        className
      )}
    >
      {divided && childArray.length > 1
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {index > 0 && <div className="h-px bg-border/50 mx-4" />}
              {child}
            </React.Fragment>
          ))
        : children}
    </div>
  )
}

/**
 * SettingsCardContent - Inner padding wrapper for card content
 *
 * Use when you need custom content inside a SettingsCard
 */
export function SettingsCardContent({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('px-4 py-3.5', className)}>{children}</div>
}

/**
 * SettingsCardFooter - Footer section with actions
 */
export function SettingsCardFooter({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'px-4 py-3 border-t border-border/50 bg-muted/30 flex items-center justify-end gap-2',
        className
      )}
    >
      {children}
    </div>
  )
}

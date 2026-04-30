/**
 * SettingsRow
 *
 * Generic row component for settings with label on left and content on right.
 * Use for custom layouts that don't fit Toggle/Select patterns.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsRowProps {
  /** Row label (can be string or JSX for custom rendering) */
  label: React.ReactNode
  /** Optional description below label */
  description?: string
  /** Content on the right side */
  children?: React.ReactNode
  /** Click handler for the entire row */
  onClick?: () => void
  /** Optional action button (e.g., "Change" button) */
  action?: React.ReactNode
  /** Additional className */
  className?: string
  /** Whether the row is inside a card (affects padding) */
  inCard?: boolean
}

/**
 * SettingsRow - Generic row for custom settings layouts
 *
 * @example
 * <SettingsRow
 *   label="Working Directory"
 *   description="~/Documents"
 *   action={<Button variant="ghost" size="sm">Change</Button>}
 * />
 */
export function SettingsRow({
  label,
  description,
  children,
  onClick,
  action,
  className,
  inCard = true,
}: SettingsRowProps) {
  const Component = onClick ? 'button' : 'div'

  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      data-layout="settings-row"
      className={cn(
        'w-full flex items-center justify-between text-left',
        inCard ? 'px-4 py-3.5' : 'py-3',
        onClick && 'hover:bg-muted/70 transition-colors cursor-pointer',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <div className={settingsUI.label}>{label}</div>
        {description && (
          <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap, 'truncate')}>
            {description}
          </div>
        )}
      </div>
      {(children || action) && (
        <div data-layout="settings-control" className="flex items-center gap-3 ml-4 shrink-0">
          {children}
          {action}
        </div>
      )}
    </Component>
  )
}

/**
 * SettingsRowLabel - Standalone label for use outside SettingsRow
 *
 * @example
 * <SettingsRowLabel label="Theme" />
 * <SettingsSegmentedControl ... />
 */
export function SettingsRowLabel({
  label,
  description,
  className,
}: {
  label: string
  description?: string
  className?: string
}) {
  return (
    <div className={cn(settingsUI.labelGroup, className)}>
      <div className={settingsUI.label}>{label}</div>
      {description && (
        <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</div>
      )}
    </div>
  )
}

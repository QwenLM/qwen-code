/**
 * SettingsSection, SettingsGroup, SettingsDivider
 *
 * Structural components for organizing settings pages.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

// ============================================
// SettingsSection
// ============================================

export interface SettingsSectionProps {
  /** Section title */
  title: string
  /** Optional description below title (supports ReactNode for inline links) */
  description?: React.ReactNode
  /** Content - usually SettingsCard or SettingsRadioGroup */
  children: React.ReactNode
  /** Additional className */
  className?: string
  /** Variant for different visual treatments */
  variant?: 'default' | 'danger'
  /** Optional action element (e.g., Edit button) shown at the right of the header */
  action?: React.ReactNode
}

/**
 * SettingsSection - A semantic section with title and description
 *
 * @example
 * <SettingsSection title="Billing" description="Choose how you pay">
 *   <SettingsRadioGroup>...</SettingsRadioGroup>
 * </SettingsSection>
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
  variant = 'default',
  action,
}: SettingsSectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex items-start justify-between gap-4 pl-1">
        <div className="space-y-0.5">
          <h3
            className={cn(
              'text-base font-semibold',
              variant === 'danger' && 'text-destructive'
            )}
          >
            {title}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}

// ============================================
// SettingsGroup
// ============================================

export interface SettingsGroupProps {
  /** Group title (displayed uppercase) */
  title: string
  /** Content - usually multiple SettingsSection components */
  children: React.ReactNode
  /** Additional className */
  className?: string
}

/**
 * SettingsGroup - Top-level divider for major sections (e.g., "App" vs "Workspace")
 *
 * @example
 * <SettingsGroup title="Workspace">
 *   <SettingsSection title="Model">...</SettingsSection>
 *   <SettingsSection title="Permissions">...</SettingsSection>
 * </SettingsGroup>
 */
export function SettingsGroup({ title, children, className }: SettingsGroupProps) {
  return (
    <div className={cn('space-y-6', className)}>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pb-2 border-b border-border">
        {title}
      </h2>
      <div className="space-y-8">{children}</div>
    </div>
  )
}

// ============================================
// SettingsDivider
// ============================================

export interface SettingsDividerProps {
  /** Additional className */
  className?: string
}

/**
 * SettingsDivider - Horizontal separator between sections
 *
 * Use sparingly - vertical spacing is usually enough.
 */
export function SettingsDivider({ className }: SettingsDividerProps) {
  return <div className={cn('h-px bg-border', className)} />
}

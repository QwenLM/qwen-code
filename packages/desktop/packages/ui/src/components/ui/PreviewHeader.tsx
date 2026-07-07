/**
 * PreviewHeader - Unified header component for preview windows and overlays
 *
 * Works in two contexts:
 * - Electron windows: Traffic lights on left (handled by OS), badges centered
 * - Viewer overlays: Badges centered, close button on right
 *
 * Use `onClose` prop to show the close button on the right.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { X, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Badge variants using semantic colors
 */
export const PREVIEW_BADGE_VARIANTS = {
  edit: 'text-foreground/70',
  write: 'text-foreground/70',
  read: 'text-foreground/70',
  bash: 'text-foreground/70',
  grep: 'text-foreground/70',
  glob: 'text-foreground/70',
  blue: 'text-foreground/70',
  amber: 'text-foreground/70',
  orange: 'text-foreground/70',
  green: 'text-foreground/70',
  purple: 'text-foreground/70',
  gray: 'text-foreground/70',
  default: 'text-foreground/70',
} as const

export type PreviewBadgeVariant = keyof typeof PREVIEW_BADGE_VARIANTS

export interface PreviewHeaderBadgeProps {
  /** Icon component to display */
  icon?: LucideIcon
  /** Badge label text */
  label: string
  /** Badge variant (default: 'default') */
  variant?: PreviewBadgeVariant
  /** Click handler (makes it a clickable link-style button) */
  onClick?: () => void
  /** Title for tooltip */
  title?: string
  /** Additional className */
  className?: string
  /** Allow badge to shrink (for long paths) - default: false */
  shrinkable?: boolean
}

/**
 * PreviewHeaderBadge - Badge component for preview headers
 *
 * Style specs:
 * - Height: 26px
 * - Padding: 10px horizontal
 * - Border radius: 6px
 * - Font: Sans-serif, 13px, medium weight
 * - Truncation: CSS truncate, shrink, stay 1 line
 * - Clickable: underline on hover, pointer cursor
 */
export function PreviewHeaderBadge({
  icon: Icon,
  label,
  variant = 'default',
  onClick,
  title,
  className,
  shrinkable = false,
}: PreviewHeaderBadgeProps) {
  const variantClasses = PREVIEW_BADGE_VARIANTS[variant]
  const baseClasses = cn(
    'flex items-center gap-1.5 h-[26px] px-2.5 rounded-[6px] font-sans text-[13px] font-medium bg-background shadow-minimal',
    variantClasses,
    className
  )

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={cn(baseClasses, 'min-w-0 cursor-pointer group')}
        title={title || label}
      >
        {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate group-hover:underline">{label}</span>
      </button>
    )
  }

  return (
    <div className={cn(baseClasses, shrinkable ? 'min-w-0' : 'shrink-0')} title={title || label}>
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </div>
  )
}

export interface PreviewHeaderProps {
  /** Badge elements to render in center */
  children?: React.ReactNode
  /** Close handler - when provided, shows X button on right */
  onClose?: () => void
  /** Actions to render on the right, just before the close button */
  rightActions?: React.ReactNode
  /** Height of the header (default: 50px for windows, 44px for overlays) */
  height?: number
  /** Additional className for the header */
  className?: string
  /** Inline styles */
  style?: React.CSSProperties
}

/**
 * PreviewHeader - Header/toolbar for preview windows and overlays
 *
 * Layout:
 * - Left: 70px spacer (for macOS traffic lights in Electron)
 * - Center: Badges row
 * - Right: Close button (if onClose provided) or 70px spacer
 */
export function PreviewHeader({
  children,
  onClose,
  rightActions,
  height = 50,
  className,
  style,
}: PreviewHeaderProps) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-between px-3',
        className
      )}
      style={{ height, ...style }}
    >
      {/* Left side - space for traffic lights on macOS, flex-1 to balance with right side */}
      <div className="flex-1 min-w-[70px]" />

      {/* Center - badges row. no-drag so badges are clickable in the window drag region. */}
      <div className="flex items-center gap-2 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {children}
      </div>

      {/* Right side - actions + close button. no-drag so actions are clickable in the window drag region. */}
      <div className="flex-1 min-w-[70px] flex items-center gap-2 justify-end" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {rightActions}
        {onClose && (
          <button
            onClick={onClose}
            className={cn(
              'p-1.5 rounded-[6px] bg-background shadow-minimal cursor-pointer',
              'opacity-70 hover:opacity-100 transition-opacity',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            )}
            title={t('common.closeEsc')}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

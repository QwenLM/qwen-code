/**
 * LabelIcon - Renders a colored circle representing a label.
 *
 * Labels are color-only (no icons/emoji). The circle size scales
 * with the icon size variant for consistent inline display.
 */

import type { IconSize } from '@craft-agent/shared/icons'
import type { EntityColor } from '@craft-agent/shared/colors'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import { useTheme } from '@/context/ThemeContext'
import { cn } from '@/lib/utils'
import { Hash, CalendarDays, Type } from 'lucide-react'
import type { LabelConfig } from '@craft-agent/shared/labels'

interface LabelIconProps {
  /** Label configuration (matches LabelConfig from @craft-agent/shared/labels) */
  label: {
    id: string
    /** EntityColor: system color string or custom color object */
    color?: EntityColor
  }
  /** Size variant (default: 'sm' - labels are typically small inline elements) */
  size?: IconSize
  /** When true, renders an inner circle (radio-button style) to indicate nested children */
  hasChildren?: boolean
  /** Additional className */
  className?: string
}

/** Circle diameter in pixels for each icon size */
const CIRCLE_SIZES: Record<IconSize, number> = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
}

export function LabelIcon({ label, size = 'sm', hasChildren, className }: LabelIconProps) {
  const { isDark } = useTheme()

  // Resolve the label's color for inline styling
  const resolvedColor = label.color
    ? resolveEntityColor(label.color, isDark)
    : undefined

  // All labels use the same diameter for consistent spacing
  const diameter = CIRCLE_SIZES[size]
  const padding = 1 // Internal padding around the circle
  const center = diameter / 2
  const outerRadius = center - padding
  const dotRadius = 1 // 2px diameter inner dot

  const fillColor = resolvedColor || 'currentColor'

  return (
    <svg
      width={diameter}
      height={diameter}
      viewBox={`0 0 ${diameter} ${diameter}`}
      className={cn('shrink-0', className)}
      style={{ opacity: resolvedColor ? 1 : 0.4 }}
    >
      <circle cx={center} cy={center} r={outerRadius} fill={fillColor} />
      {/* Inner dot signals this label has nested children (radio-button style).
          Color is 85% background + 15% label color via color-mix. */}
      {hasChildren && (
        <circle
          cx={center}
          cy={center}
          r={dotRadius}
          style={{
            fill: `color-mix(in srgb, var(--background) 85%, ${fillColor} 15%)`,
          }}
        />
      )}
    </svg>
  )
}

/**
 * LabelValueTypeIcon - Renders a placeholder icon for typed labels with no value set.
 *
 * Maps valueType to a Lucide icon:
 *   - number → Hash
 *   - date   → CalendarDays
 *   - string → Type
 *
 * Returns null if the label has no valueType (boolean/presence-only labels).
 * Used in label badge rows and ActiveOptionBadges to indicate a typed label awaiting a value.
 */
const VALUE_TYPE_ICONS = {
  number: Hash,
  date: CalendarDays,
  string: Type,
} as const

interface LabelValueTypeIconProps {
  /** The label's valueType ('number' | 'date' | 'string' | undefined) */
  valueType: LabelConfig['valueType']
  /** Icon size in pixels (default: 11) */
  size?: number
  /** Additional className */
  className?: string
}

export function LabelValueTypeIcon({ valueType, size = 11, className }: LabelValueTypeIconProps) {
  if (!valueType) return null

  const IconComponent = VALUE_TYPE_ICONS[valueType]
  if (!IconComponent) return null

  return <IconComponent size={size} className={cn('shrink-0 opacity-45', className)} />
}

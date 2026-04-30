import * as React from 'react'
import type { CSSProperties } from 'react'
import type { StatusConfig } from '@craft-agent/shared/statuses'
import { isEmoji } from '@craft-agent/shared/utils/icon-constants'
import { resolveEntityColor, getDefaultStatusColor } from '@craft-agent/shared/colors'
import type { EntityColor } from '@craft-agent/shared/colors'
import { StatusIcon } from '@/components/ui/status-icon'
import { iconCache } from '@/lib/icon-cache'

// ============================================================================
// Types
// ============================================================================

// Dynamic status ID (any string now)
export type SessionStatusId = string

export interface SessionStatusConfig {
  id: string
  label: string
  color?: EntityColor
}

export interface SessionStatus extends SessionStatusConfig {
  /**
   * Resolved CSS color string for inline style application.
   * System colors resolve to var(--name) or color-mix(...).
   * Custom colors resolve to the appropriate light/dark hex value.
   */
  resolvedColor: string
  icon: React.ReactNode
  /**
   * Whether the icon responds to color styling (uses currentColor).
   * - true: SVGs with currentColor - apply status color
   * - false: Emojis, images, SVGs with hardcoded colors - render at full opacity
   */
  iconColorable: boolean
  category?: 'open' | 'closed'
  isFixed?: boolean
  isDefault?: boolean
}

// ============================================================================
// Status → SessionStatus Conversion
// ============================================================================

/**
 * Convert StatusConfig to SessionStatus.
 * Resolves EntityColor to a CSS color string for inline style use.
 * System colors (e.g., "accent") resolve to CSS variable references that
 * auto-adapt to light/dark theme. Custom colors use isDark to pick the right value.
 *
 * Colorability is determined synchronously:
 * - Emoji icons → not colorable (they have their own colors)
 * - Everything else (SVGs, fallback) → colorable (uses currentColor)
 */
export function statusConfigToSessionStatus(
  config: StatusConfig,
  workspaceId: string,
  isDark: boolean
): SessionStatus {
  // Emojis have their own colors and don't respond to CSS color inheritance.
  // SVGs with currentColor and the fallback Circle icon are colorable.
  const iconColorable = !isEmoji(config.icon)

  // Resolve EntityColor → CSS color string for inline style
  const entityColor = config.color ?? getDefaultStatusColor(config.id)
  const resolvedColor = resolveEntityColor(entityColor, isDark)

  return {
    id: config.id,
    label: config.label,
    color: config.color,
    resolvedColor,
    icon: (
      <StatusIcon
        statusId={config.id}
        icon={config.icon}
        workspaceId={workspaceId}
        size="xs"
        chromeless={!iconColorable}
      />
    ),
    iconColorable,
    category: config.category,
    isFixed: config.isFixed,
    isDefault: config.isDefault,
  }
}

/**
 * Convert array of StatusConfig to SessionStatus[]
 */
export function statusConfigsToSessionStatuses(
  configs: StatusConfig[],
  workspaceId: string,
  isDark: boolean
): SessionStatus[] {
  return configs.map(c => statusConfigToSessionStatus(c, workspaceId, isDark))
}

// ============================================================================
// Helper Functions (updated to work with dynamic states)
// ============================================================================

/**
 * Get the icon for a todo state
 */
export function getStateIcon(
  stateId: string,
  states: SessionStatus[]
): React.ReactNode {
  const state = states.find(s => s.id === stateId)
  return state?.icon ?? <span className="h-3.5 w-3.5">●</span>
}

/**
 * Return inline style for a status icon only when the icon is colorable.
 *
 * Colorable icons (SVG/currentColor) receive the resolved status color.
 * Non-colorable icons (emoji/images) return undefined so they render at full native color/opacity.
 */
export function getStatusIconStyle(state?: SessionStatus): CSSProperties | undefined {
  return state?.iconColorable ? { color: state.resolvedColor } : undefined
}

/**
 * Resolve a status by ID and return icon style only when color should be applied.
 */
export function getStateIconStyle(
  stateId: string,
  states: SessionStatus[]
): CSSProperties | undefined {
  return getStatusIconStyle(states.find(s => s.id === stateId))
}

/**
 * Get the resolved CSS color for a todo state (ready for inline style)
 */
export function getStateColor(
  stateId: string,
  states: SessionStatus[]
): string | undefined {
  return states.find(s => s.id === stateId)?.resolvedColor
}

/**
 * Get the label for a todo state
 */
export function getStateLabel(
  stateId: string,
  states: SessionStatus[]
): string {
  const state = states.find(s => s.id === stateId)
  return state?.label ?? stateId
}

/**
 * Get a complete state object by ID
 */
export function getState(
  stateId: string,
  states: SessionStatus[]
): SessionStatus | undefined {
  return states.find(s => s.id === stateId)
}

/**
 * Clear status icon cache (useful when statuses are updated).
 * Clears status-prefixed entries from the unified icon cache.
 */
export function clearIconCache(): void {
  for (const key of iconCache.keys()) {
    if (key.startsWith('status:')) iconCache.delete(key)
  }
}

/**
 * Entity Color Migration
 *
 * One-time migration from old Tailwind class format to new EntityColor format.
 * Called during config loading — if old format detected, migrates in-memory
 * and signals that the config should be written back to disk.
 *
 * Old format: "text-accent", "text-foreground/50", "#EF4444"
 * New format: "accent", "foreground/50", { light: "#EF4444" }
 */

import type { EntityColor } from './types.ts'

/**
 * Mapping from old Tailwind class prefixed colors to new EntityColor values.
 * Covers all known patterns used in existing configs.
 */
const TAILWIND_TO_ENTITY_COLOR: Record<string, EntityColor> = {
  'text-accent': 'accent',
  'text-info': 'info',
  'text-success': 'success',
  'text-error': 'destructive',
  'text-destructive': 'destructive',
  'text-foreground': 'foreground',
  'text-foreground/50': 'foreground/50',
  'text-foreground/60': 'foreground/60',
  'text-foreground/70': 'foreground/70',
  'text-foreground/80': 'foreground/80',
  'text-foreground/90': 'foreground/90',
  'text-warning': 'info', // warning maps to info (amber) in the design system
}

/**
 * Migrate a single color value from old format to new EntityColor.
 * Returns the migrated value, or undefined if no migration needed (already new format or null).
 *
 * @param oldColor - The color value from config (may be old or new format)
 * @returns Migrated EntityColor, or null if the value is already valid/undefined
 */
export function migrateColorValue(oldColor: unknown): { migrated: EntityColor; changed: boolean } | null {
  // No color set — nothing to migrate
  if (oldColor === undefined || oldColor === null) return null

  // Already an object (CustomColor) — no migration needed
  if (typeof oldColor === 'object') return null

  if (typeof oldColor !== 'string') return null

  // Check for known Tailwind class mappings
  const mapped = TAILWIND_TO_ENTITY_COLOR[oldColor]
  if (mapped) {
    return { migrated: mapped, changed: true }
  }

  // Check for generic text-foreground/N pattern not in the map.
  // Clamp opacity to 0-100 to ensure the migrated value passes validation.
  const fgOpacityMatch = /^text-foreground\/(\d+)$/.exec(oldColor)
  if (fgOpacityMatch) {
    const opacity = Math.min(100, Math.max(0, Number(fgOpacityMatch[1])))
    return { migrated: `foreground/${opacity}` as EntityColor, changed: true }
  }

  // Check for bare hex color — wrap in CustomColor object
  if (/^#[0-9A-Fa-f]{6}$/.test(oldColor)) {
    return { migrated: { light: oldColor }, changed: true }
  }
  if (/^#[0-9A-Fa-f]{8}$/.test(oldColor)) {
    return { migrated: { light: oldColor }, changed: true }
  }

  // Already a valid system color string (no text- prefix) — no migration needed
  return null
}

/**
 * Migrate all color values in a statuses config object.
 * Mutates the config in place and returns whether any changes were made.
 */
export function migrateStatusColors(config: { statuses: Array<{ color?: unknown }> }): boolean {
  let changed = false
  for (const status of config.statuses) {
    const result = migrateColorValue(status.color)
    if (result?.changed) {
      status.color = result.migrated
      changed = true
    }
  }
  return changed
}

/**
 * Migrate all color values in a labels config object.
 * Mutates the config in place and returns whether any changes were made.
 */
export function migrateLabelColors(config: { labels: Array<{ color?: unknown; children?: any[] }> }): boolean {
  let changed = false

  // Recursively migrate colors in the label tree
  function migrateTree(labels: Array<{ color?: unknown; children?: any[] }>): void {
    for (const label of labels) {
      const result = migrateColorValue(label.color)
      if (result?.changed) {
        label.color = result.migrated
        changed = true
      }
      if (label.children && label.children.length > 0) {
        migrateTree(label.children)
      }
    }
  }

  migrateTree(config.labels)
  return changed
}

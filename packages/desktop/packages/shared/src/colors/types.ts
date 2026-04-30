/**
 * Unified Entity Color Types
 *
 * Shared type definitions for the centralised color system.
 * Used by all entity configs (statuses, labels) for consistent color handling.
 *
 * Two color modes:
 * - System colors: Reference design system CSS variables (auto light/dark via theme)
 * - Custom colors: Explicit CSS color values with optional dark mode override
 *
 * This module is browser-safe (no Node.js dependencies).
 */

// ============================================================================
// System Colors (design system references)
// ============================================================================

/** Available design system color names (mapped to CSS variables) */
export type SystemColorName = 'accent' | 'info' | 'success' | 'destructive' | 'foreground'

/** All valid system color names for runtime validation */
export const SYSTEM_COLOR_NAMES: readonly SystemColorName[] = [
  'accent', 'info', 'success', 'destructive', 'foreground',
] as const

/**
 * System color string: a color name with optional opacity modifier.
 * Examples: "accent", "foreground/50", "info/80"
 *
 * Opacity is 0–100 (percentage). Rendered via color-mix with transparent.
 */
export type SystemColor = `${SystemColorName}` | `${SystemColorName}/${number}`

// ============================================================================
// Custom Colors (explicit CSS values)
// ============================================================================

/**
 * Custom color with explicit CSS color values.
 * Supports hex, OKLCH, RGB, HSL formats.
 * Dark mode variant is auto-derived if omitted (+20% OKLCH lightness).
 */
export interface CustomColor {
  /** Light mode color value (hex, OKLCH, RGB, or HSL) */
  light: string
  /** Dark mode color value. If omitted, auto-derived from light. */
  dark?: string
}

// ============================================================================
// Unified EntityColor Type
// ============================================================================

/**
 * Unified color type used in all entity configurations.
 *
 * Can be either:
 * - A system color string: "accent", "foreground/50", "info/80"
 * - A custom color object: { light: "#EF4444", dark: "#F87171" }
 *
 * System colors auto-adapt to light/dark theme via CSS variables.
 * Custom colors need explicit values (dark is auto-derived if omitted).
 */
export type EntityColor = SystemColor | CustomColor

/**
 * Entity Color Resolution
 *
 * Resolves EntityColor values to CSS color strings for inline style application.
 * All entity colors are rendered via inline `style={{ color }}` — no Tailwind
 * color classes, since JIT won't generate classes for runtime-loaded config values.
 *
 * System colors → CSS variable references (auto light/dark via theme)
 * System colors with opacity → color-mix with transparent (works in Chromium)
 * Custom colors → explicit CSS color values based on current theme mode
 */

import { type EntityColor, type SystemColor, type SystemColorName, SYSTEM_COLOR_NAMES } from './types.ts'

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve an EntityColor to a CSS color string for inline style application.
 *
 * @param color - The EntityColor value from config
 * @param isDark - Whether the current theme is dark mode
 * @returns CSS color string (e.g., "var(--accent)", "color-mix(...)", "#EF4444")
 *
 * @example
 * // System color (auto light/dark)
 * resolveEntityColor('accent', false) // → "var(--accent)"
 *
 * // System color with opacity
 * resolveEntityColor('foreground/50', false) // → "color-mix(in oklch, var(--foreground) 50%, transparent)"
 *
 * // Custom color
 * resolveEntityColor({ light: '#EF4444', dark: '#F87171' }, true) // → "#F87171"
 */
export function resolveEntityColor(color: EntityColor, isDark: boolean): string {
  if (typeof color === 'string') {
    // System color — parse name and optional opacity
    const parsed = parseSystemColor(color)
    if (!parsed) {
      // Fallback for invalid system color strings
      return 'var(--foreground)'
    }

    const cssVar = `var(--${parsed.name})`

    if (parsed.opacity !== undefined) {
      // Apply opacity via color-mix (works in Electron/Chromium without build step)
      return `color-mix(in oklch, ${cssVar} ${parsed.opacity}%, transparent)`
    }

    return cssVar
  }

  // Custom color — pick light or dark value
  if (isDark) {
    return color.dark ?? deriveDarkVariant(color.light)
  }
  return color.light
}

// ============================================================================
// Parsing
// ============================================================================

/** Parsed system color: name + optional opacity */
export interface ParsedSystemColor {
  name: SystemColorName
  opacity?: number
}

/**
 * Parse a system color string into its components.
 * Returns null if the string is not a valid system color.
 *
 * @example
 * parseSystemColor('accent')        // → { name: 'accent' }
 * parseSystemColor('foreground/50') // → { name: 'foreground', opacity: 50 }
 * parseSystemColor('invalid')       // → null
 */
export function parseSystemColor(value: string): ParsedSystemColor | null {
  const slashIndex = value.indexOf('/')
  const name = slashIndex === -1 ? value : value.slice(0, slashIndex)

  if (!isSystemColorName(name)) return null

  if (slashIndex === -1) {
    return { name }
  }

  const opacityStr = value.slice(slashIndex + 1)
  // Reject empty or non-numeric opacity (e.g., "foreground/" or "foreground/abc")
  if (!opacityStr || !/^\d+$/.test(opacityStr)) return null
  const opacity = Number(opacityStr)
  if (opacity > 100) return null

  return { name, opacity }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a valid SystemColorName.
 */
export function isSystemColorName(value: string): value is SystemColorName {
  return (SYSTEM_COLOR_NAMES as readonly string[]).includes(value)
}

/**
 * Check if an EntityColor value is a system color (string) vs custom color (object).
 */
export function isSystemColor(color: EntityColor): color is SystemColor {
  return typeof color === 'string'
}

// ============================================================================
// Dark Mode Derivation
// ============================================================================

/**
 * Auto-derive a dark mode variant from a light mode color.
 * Brightens the color by increasing OKLCH lightness by ~20%.
 *
 * For hex colors, converts to a brighter version.
 * For other formats, returns the original (custom colors should specify dark explicitly).
 */
export function deriveDarkVariant(lightColor: string): string {
  // Handle hex colors: brighten by blending toward white
  if (/^#[0-9A-Fa-f]{6}$/.test(lightColor)) {
    return brightenHex(lightColor, 0.3)
  }
  if (/^#[0-9A-Fa-f]{8}$/.test(lightColor)) {
    // 8-digit hex (with alpha) — brighten RGB portion
    return brightenHex(lightColor.slice(0, 7), 0.3) + lightColor.slice(7)
  }

  // For non-hex formats (OKLCH, RGB, HSL), return as-is.
  // Users should provide explicit dark values for these.
  return lightColor
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Brighten a 6-digit hex color by blending toward white.
 * @param hex - 6-digit hex color (e.g., "#EF4444")
 * @param amount - Blend factor 0–1 (0 = unchanged, 1 = white)
 */
function brightenHex(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)

  const newR = Math.round(r + (255 - r) * amount)
  const newG = Math.round(g + (255 - g) * amount)
  const newB = Math.round(b + (255 - b) * amount)

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`
}

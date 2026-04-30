/**
 * Entity Color Validation
 *
 * Zod schemas and validation utilities for EntityColor values.
 * Used by config validators to ensure color values in statuses/labels configs are valid.
 */

import { z } from 'zod'
import { SYSTEM_COLOR_NAMES } from './types.ts'

// ============================================================================
// CSS Color Validation
// ============================================================================

/** Hex color: #RGB, #RRGGBB, or #RRGGBBAA */
const HEX_PATTERN = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/

/** OKLCH: oklch(L C H) or oklch(L C H / A) */
const OKLCH_PATTERN = /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+(\s*\/\s*[\d.]+%?)?\s*\)$/

/** RGB/RGBA: rgb(r, g, b) or rgba(r, g, b, a) */
const RGB_PATTERN = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(\s*,\s*[\d.]+)?\s*\)$/

/** HSL/HSLA: hsl(h, s%, l%) or hsla(h, s%, l%, a) */
const HSL_PATTERN = /^hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%(\s*,\s*[\d.]+)?\s*\)$/

/**
 * Check if a string is a valid CSS color value.
 * Supports hex, OKLCH, RGB/RGBA, and HSL/HSLA formats.
 */
export function isValidCSSColor(value: string): boolean {
  return (
    HEX_PATTERN.test(value) ||
    OKLCH_PATTERN.test(value) ||
    RGB_PATTERN.test(value) ||
    HSL_PATTERN.test(value)
  )
}

// ============================================================================
// System Color Validation
// ============================================================================

/** Pattern for system color: name or name/opacity */
const SYSTEM_COLOR_PATTERN = /^([a-z]+)(\/(\d+))?$/

/**
 * Check if a string is a valid system color (name with optional /opacity).
 * Validates that the name is a known system color and opacity is 0–100.
 */
export function isValidSystemColor(value: string): boolean {
  const match = SYSTEM_COLOR_PATTERN.exec(value)
  if (!match) return false

  const name = match[1]!
  if (!(SYSTEM_COLOR_NAMES as readonly string[]).includes(name)) return false

  // Check opacity if present
  if (match[3] !== undefined) {
    const opacity = Number(match[3])
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) return false
  }

  return true
}

// ============================================================================
// EntityColor Validation
// ============================================================================

/**
 * Check if a value is a valid EntityColor.
 * Accepts system color strings or custom color objects.
 */
export function isValidEntityColor(value: unknown): boolean {
  if (typeof value === 'string') {
    return isValidSystemColor(value)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (typeof obj.light !== 'string' || !isValidCSSColor(obj.light)) return false
    if (obj.dark !== undefined && (typeof obj.dark !== 'string' || !isValidCSSColor(obj.dark))) return false
    return true
  }
  return false
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Zod schema for EntityColor.
 *
 * Uses superRefine instead of a raw z.union to produce a single, actionable error
 * message that an LLM can use to self-correct — rather than confusing dual-branch
 * union errors from Zod (which would show both "invalid string" and "expected object").
 *
 * Valid forms:
 * - System color string: "accent", "foreground/50", "info/80"
 * - Custom color object: { light: "#EF4444", dark?: "#F87171" }
 */
export const EntityColorSchema = z.any().superRefine((val, ctx) => {
  // --- String path: validate as system color ---
  if (typeof val === 'string') {
    if (!isValidSystemColor(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid color "${val}". `
          + `System colors: ${SYSTEM_COLOR_NAMES.join(', ')} (with optional /opacity 0-100). `
          + `Examples: "accent", "foreground/50". `
          + `For custom hex colors use an object: { "light": "#RRGGBB" }. `
          + `See statuses.md for full color format reference.`,
      })
    }
    return
  }

  // --- Object path: validate as custom color ---
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>

    if (typeof obj.light !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Custom color object requires a "light" field with a valid CSS color. `
          + `Example: { "light": "#EF4444", "dark": "#F87171" }. `
          + `Supported formats: #RGB, #RRGGBB, #RRGGBBAA, oklch(...), rgb(...), hsl(...).`,
      })
      return
    }

    if (!isValidCSSColor(obj.light)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid "light" color "${obj.light}". `
          + `Supported CSS formats: #RGB, #RRGGBB, #RRGGBBAA, oklch(L C H), rgb(r, g, b), hsl(h, s%, l%). `
          + `Example: "#EF4444" or "oklch(0.7 0.15 20)".`,
      })
    }

    if (obj.dark !== undefined) {
      if (typeof obj.dark !== 'string' || !isValidCSSColor(obj.dark)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid "dark" color "${obj.dark}". `
            + `Must be a valid CSS color (same formats as "light"). `
            + `Omit "dark" entirely to auto-derive from light (+30% brightness).`,
        })
      }
    }
    return
  }

  // --- Invalid type ---
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Invalid color value (got ${typeof val}). `
      + `Must be a system color string ("accent", "foreground/50") `
      + `or a custom color object ({ "light": "#hex", "dark?": "#hex" }). `
      + `See statuses.md for full color format reference.`,
  })
})

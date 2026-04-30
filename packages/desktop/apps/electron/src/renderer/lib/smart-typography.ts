/**
 * Smart Typography - Live text replacement for typographic symbols
 *
 * Transforms trigger when user types a space after the pattern.
 * This avoids complex partial-match handling and feels natural.
 *
 * Supported patterns:
 * - -> → (right arrow)
 * - <- → ← (left arrow)
 * - <-> → ↔ (left-right arrow)
 * - => → ⇒ (double right arrow)
 * - <=> → ⇔ (double bidirectional arrow)
 * - -- → – (en-dash)
 * - ... → … (ellipsis)
 * - != → ≠ (not equal)
 */

interface Replacement {
  /** Pattern to match (followed by space) */
  pattern: string
  /** Replacement character/string */
  replacement: string
}

/**
 * Ordered list of replacements - longer patterns first to avoid partial matches
 */
const REPLACEMENTS: Replacement[] = [
  // Longer patterns first
  { pattern: '<=>', replacement: '⇔' },
  { pattern: '<->', replacement: '↔' },
  { pattern: '...', replacement: '…' },
  // Shorter patterns
  { pattern: '->', replacement: '→' },
  { pattern: '<-', replacement: '←' },
  { pattern: '=>', replacement: '⇒' },
  { pattern: '--', replacement: '–' },
  { pattern: '!=', replacement: '≠' },
]

interface SmartTypographyResult {
  /** The transformed text */
  text: string
  /** The adjusted cursor position */
  cursor: number
  /** Whether a replacement was made */
  replaced: boolean
}

/**
 * Check if cursor is inside a code block (backticks)
 * Simple heuristic: count backticks before cursor, odd = inside code
 */
function isInsideCode(text: string, cursor: number): boolean {
  const textBeforeCursor = text.slice(0, cursor)

  // Check for triple backticks (code blocks)
  const tripleBackticks = (textBeforeCursor.match(/```/g) || []).length
  if (tripleBackticks % 2 === 1) return true

  // Check for single backticks (inline code) - but not triple
  // Remove triple backticks first, then count singles
  const withoutTriple = textBeforeCursor.replace(/```/g, '')
  const singleBackticks = (withoutTriple.match(/`/g) || []).length
  return singleBackticks % 2 === 1
}

/**
 * Apply smart typography replacements to text
 *
 * Transforms trigger when user types a space after a pattern.
 * e.g., "hello -> " becomes "hello → "
 *
 * @param text - The current input text
 * @param cursor - The current cursor position
 * @returns Object with transformed text, adjusted cursor, and whether replacement occurred
 */
export function applySmartTypography(
  text: string,
  cursor: number
): SmartTypographyResult {
  // Only transform if user just typed a space
  if (cursor === 0 || text[cursor - 1] !== ' ') {
    return { text, cursor, replaced: false }
  }

  // Don't transform if cursor is inside code
  if (isInsideCode(text, cursor)) {
    return { text, cursor, replaced: false }
  }

  // Get the text before the space to check for patterns
  const textBeforeSpace = text.slice(0, cursor - 1)

  // Try each replacement pattern (ordered by priority - longer first)
  for (const { pattern, replacement } of REPLACEMENTS) {
    if (textBeforeSpace.endsWith(pattern)) {
      // Found a match - replace pattern (keep the space)
      const patternStart = cursor - 1 - pattern.length
      const newText =
        text.slice(0, patternStart) + replacement + ' ' + text.slice(cursor)

      // Adjust cursor: pattern replaced with shorter replacement, space stays
      const cursorAdjustment = pattern.length - replacement.length
      const newCursor = cursor - cursorAdjustment

      return { text: newText, cursor: newCursor, replaced: true }
    }
  }

  // No replacement made
  return { text, cursor, replaced: false }
}

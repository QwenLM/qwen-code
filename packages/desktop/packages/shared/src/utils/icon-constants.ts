/**
 * Icon Constants
 *
 * Pure constants and functions for icon handling.
 * NO Node.js dependencies - safe for browser/renderer import.
 *
 * These are extracted from icon.ts so renderer code can import them
 * without pulling in fs/path dependencies.
 */

// ============================================================
// Constants
// ============================================================

/**
 * Comprehensive emoji detection regex.
 * Matches single emoji, emoji sequences, and multi-codepoint emoji (e.g., 👨‍💻).
 */
export const EMOJI_REGEX = /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*$/u;

/**
 * Supported icon file extensions in priority order.
 */
export const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif'];

// ============================================================
// Pure Functions (no Node.js dependencies)
// ============================================================

/**
 * Check if a string is an emoji (single or multi-codepoint).
 * Examples: "🔧", "👨‍💻", "🎉"
 */
export function isEmoji(str: string | undefined): boolean {
  if (!str || str.length === 0) return false;
  // Emoji should be short - most are under 20 chars even with modifiers
  if (str.length > 20) return false;
  return EMOJI_REGEX.test(str);
}

/**
 * Check if a string is a valid icon URL (http or https).
 */
export function isIconUrl(str: string): boolean {
  return str.startsWith('http://') || str.startsWith('https://');
}

/**
 * Check if an icon value is invalid (inline SVG or relative path).
 * These are explicitly not supported to keep configs clean.
 */
export function isInvalidIconValue(str: string): boolean {
  // Inline SVG starts with < (e.g., "<svg...")
  if (str.startsWith('<')) return true;
  // Relative paths start with . or /
  if (str.startsWith('.') || str.startsWith('/')) return true;
  return false;
}

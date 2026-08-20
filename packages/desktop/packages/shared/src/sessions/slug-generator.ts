/**
 * Human-Readable Session ID Generator
 *
 * Generates session IDs in the format: YYMMDD-readable-slug
 * Example: 260111-fix-session-names
 *
 * - Time-sortable by date prefix
 * - Human-readable and memorable
 * - Prompt/title-derived when a useful hint is available
 * - Random adjective-noun fallback for callers that cannot provide a hint
 * - Collision handling with numeric suffix
 */

import { ADJECTIVES, NOUNS } from './word-lists.ts';

/**
 * Generate date prefix in YYMMDD format
 */
export function generateDatePrefix(date: Date = new Date()): string {
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Get a random element from an array using crypto.getRandomValues
 */
function getRandomElement<T>(array: readonly T[]): T {
  const randomIndex = crypto.getRandomValues(new Uint32Array(1))[0]! % array.length;
  return array[randomIndex]!;
}

/**
 * Generate a random adjective-noun slug
 */
export function generateHumanSlug(): string {
  const adjective = getRandomElement(ADJECTIVES);
  const noun = getRandomElement(NOUNS);
  return `${adjective}-${noun}`;
}

/**
 * Convert a user-facing title or prompt into a filesystem-safe slug.
 */
export function generateSlugFromHint(hint?: string): string | null {
  const normalized = (hint ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  if (!normalized) return null;

  const maxLength = 48;
  if (normalized.length <= maxLength) return normalized;

  const truncated = normalized.slice(0, maxLength).replace(/-+$/g, '');
  return truncated || null;
}

/**
 * Generate a unique session ID, handling collisions
 *
 * @param existingIds - Set or array of existing session IDs in the workspace
 * @param date - Optional date for the prefix (defaults to now)
 * @param slugHint - Optional prompt/title text to derive the slug from
 * @returns A unique session ID like "260111-fix-session-names" or "260111-fix-session-names-2"
 */
export function generateUniqueSessionId(
  existingIds: Set<string> | string[],
  date: Date = new Date(),
  slugHint?: string,
): string {
  const existingSet = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const datePrefix = generateDatePrefix(date);
  const hintedSlug = generateSlugFromHint(slugHint);

  if (hintedSlug) {
    const baseId = `${datePrefix}-${hintedSlug}`;
    if (!existingSet.has(baseId)) {
      return baseId;
    }

    for (let suffix = 2; suffix <= 999; suffix++) {
      const suffixedId = `${baseId}-${suffix}`;
      if (!existingSet.has(suffixedId)) {
        return suffixedId;
      }
    }
  }

  // Try up to 100 times to find a unique slug
  for (let attempt = 0; attempt < 100; attempt++) {
    const slug = generateHumanSlug();
    const baseId = `${datePrefix}-${slug}`;

    // Check if base ID is available
    if (!existingSet.has(baseId)) {
      return baseId;
    }

    // Try with numeric suffixes
    for (let suffix = 2; suffix <= 99; suffix++) {
      const suffixedId = `${baseId}-${suffix}`;
      if (!existingSet.has(suffixedId)) {
        return suffixedId;
      }
    }
  }

  // Fallback: append random hex if all attempts fail (extremely unlikely)
  const fallbackSuffix = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(16).slice(0, 4);
  return `${datePrefix}-${generateHumanSlug()}-${fallbackSuffix}`;
}

/**
 * Parse a session ID to extract its components
 *
 * @param sessionId - A session ID like "260111-swift-river" or legacy UUID
 * @returns Parsed components or null if not in human-readable format
 */
export function parseSessionId(sessionId: string): {
  datePrefix: string;
  date: Date;
  slug: string;
  suffix?: number;
} | null {
  // Match YYMMDD-readable-slug or YYMMDD-readable-slug-N pattern
  const match = sessionId.match(/^(\d{6})-([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*?)(?:-(\d+))?$/u);
  if (!match) {
    return null;
  }

  const [, datePrefix, slug, suffixStr] = match;
  if (!datePrefix || !slug) {
    return null;
  }

  // Parse date from YYMMDD
  const year = 2000 + parseInt(datePrefix.slice(0, 2), 10);
  const month = parseInt(datePrefix.slice(2, 4), 10) - 1;
  const day = parseInt(datePrefix.slice(4, 6), 10);
  const date = new Date(year, month, day);

  return {
    datePrefix,
    date,
    slug,
    suffix: suffixStr ? parseInt(suffixStr, 10) : undefined,
  };
}

/**
 * Check if a session ID is in the new human-readable format
 */
export function isHumanReadableId(sessionId: string): boolean {
  return parseSessionId(sessionId) !== null;
}

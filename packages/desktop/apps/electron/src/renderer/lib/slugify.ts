/**
 * Slugify utility for workspace names
 *
 * Converts a human-readable name into a filesystem-safe slug.
 * Example: "My Project" → "my-project"
 */

/**
 * Convert a string to a URL/filesystem-safe slug
 * - Lowercase
 * - Replace spaces and underscores with hyphens
 * - Remove non-alphanumeric characters (except hyphens)
 * - Collapse multiple hyphens
 * - Trim leading/trailing hyphens
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove non-alphanumeric characters except hyphens
    .replace(/[^a-z0-9-]/g, '')
    // Collapse multiple hyphens into one
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-|-$/g, '')
}

/**
 * Check if a string is a valid slug (already slugified)
 */
export function isValidSlug(str: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(str)
}

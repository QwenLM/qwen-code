/**
 * @deprecated This file is deprecated. Use mentions.ts instead.
 * The unified mentions module supports both skills and sources.
 *
 * Utilities for parsing @skill mentions from chat messages
 */

/**
 * Extract valid @skill mentions from message text
 *
 * @param text - The message text to parse
 * @param availableSlugs - Valid skill slugs to match against
 * @returns Array of unique valid skill slugs mentioned in the text
 *
 * @example
 * parseSkillMentions('@bug-reporter help me fix this', ['bug-reporter', 'code-review'])
 * // Returns: ['bug-reporter']
 *
 * @example
 * parseSkillMentions('@foo @bar review this', ['bar'])
 * // Returns: ['bar'] (foo is not a valid slug)
 */
export function parseSkillMentions(text: string, availableSlugs: string[]): string[] {
  // Match @word patterns (allowing hyphens and underscores)
  // Must be at start of string or after whitespace
  const mentionPattern = /(?:^|\s)@([\w-]+)/g
  const mentions = new Set<string>()

  let match
  while ((match = mentionPattern.exec(text)) !== null) {
    const slug = match[1]
    if (availableSlugs.includes(slug)) {
      mentions.add(slug)
    }
  }

  return Array.from(mentions)
}

/**
 * Remove @mentions from message text
 *
 * @param text - The message text with mentions
 * @returns Text with @mentions removed, preserving other content
 *
 * @example
 * stripSkillMentions('@bug-reporter help me fix this')
 * // Returns: 'help me fix this'
 */
export function stripSkillMentions(text: string): string {
  // Remove @word patterns (must be at start or after whitespace)
  return text
    .replace(/(?:^|\s)@[\w-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

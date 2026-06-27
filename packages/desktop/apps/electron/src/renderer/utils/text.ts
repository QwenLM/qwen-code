import { remark } from 'remark'
import strip from 'strip-markdown'

// Pre-configured processor (reusable, avoids creating per call)
const processor = remark().use(strip)

// Regex to match emoji characters (using Unicode property escapes)
const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu

/**
 * Strip markdown formatting and emojis using remark AST parser.
 * Uses strip-markdown plugin from the unified/remark ecosystem.
 */
export function stripMarkdown(text: string): string {
  if (!text) return ''

  // Process synchronously (strip-markdown is sync)
  const result = processor.processSync(text)

  // Remove emojis and normalize whitespace
  return String(result)
    .replace(EMOJI_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim()
}

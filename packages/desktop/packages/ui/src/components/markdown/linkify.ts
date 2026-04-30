import LinkifyIt from 'linkify-it'
import { FILE_EXTENSIONS_PATTERN } from '../../lib/file-classification'

/**
 * Linkify - URL and file path detection for markdown preprocessing
 *
 * Uses linkify-it (12M downloads/week) for battle-tested URL detection,
 * plus custom regex for local file paths.
 */

// Initialize linkify-it with default settings (fuzzy URLs, emails enabled)
const linkify = new LinkifyIt()

// File path regex - detects absolute/home/explicit-relative/bare-relative paths with common extensions
// Examples: /Users/foo.ts, ~/src/app.tsx, ./README.md, ../guide.md, apps/electron/src/main.ts
// Extensions derived from file-classification.ts to stay in sync with preview support
const FILE_PATH_REGEX_SOURCE = `(?:^|[\\s([\\{<])((?:/|~/|\\./|\\.\\./|[A-Za-z0-9_][\\w\\-./@]*)[\\w\\-./@]*\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=[\\s)\\]}\\.,:;!?>]|$)`
const FILE_PATH_REGEX = new RegExp(FILE_PATH_REGEX_SOURCE, 'gi')
const FILE_PATH_PRETEST_REGEX = new RegExp(FILE_PATH_REGEX_SOURCE, 'i')

// File-path regex for markdown anchor targets (entire href/text value)
// Used by Markdown.tsx click handler to route file links to onFileClick.
const FILE_PATH_TARGET_REGEX = new RegExp(
  `^(?!https?://|mailto:|ftp://|data:)(?:/|~/|\./|\.\./|[A-Za-z0-9_][\\w\\-./@]*)[\\w\\-./@]*\\.(?:${FILE_EXTENSIONS_PATTERN})$`,
  'i'
)

interface DetectedLink {
  type: 'url' | 'email' | 'file'
  text: string
  url: string
  start: number
  end: number
}

interface CodeRange {
  start: number
  end: number
}

/**
 * Find all code block and inline code ranges in text
 * These ranges should be excluded from link detection
 */
function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // Find fenced code blocks (```...```)
  const fencedRegex = /```[\s\S]*?```/g
  let match
  while ((match = fencedRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // Find inline code (`...`)
  // But skip escaped backticks and code inside fenced blocks
  const inlineRegex = /(?<!`)`(?!`)([^`\n]+)`(?!`)/g
  while ((match = inlineRegex.exec(text)) !== null) {
    const pos = match.index
    // Check if this is inside a fenced block
    const insideFenced = ranges.some(r => pos >= r.start && pos < r.end)
    if (!insideFenced) {
      ranges.push({ start: pos, end: pos + match[0].length })
    }
  }

  return ranges
}

/**
 * Check if a position is inside any code range
 */
function isInsideCode(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * Find all markdown link ranges in text: both [text](...) and [text][ref] patterns.
 * Returns ranges covering the entire link syntax so any URL detected within
 * these spans is skipped by preprocessLinks() — preventing nested/broken links.
 */
function findMarkdownLinkRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // Match [text](url) — inline links
  const inlineLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\([^)]*\)/g
  let match
  while ((match = inlineLinkRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // Match [text][ref] — reference links
  const refLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\[[^\]]*\]/g
  while ((match = refLinkRegex.exec(text)) !== null) {
    // Avoid duplicates with inline links that already matched
    const r = { start: match.index, end: match.index + match[0].length }
    const alreadyCovered = ranges.some(existing => rangesOverlap(existing, r))
    if (!alreadyCovered) {
      ranges.push(r)
    }
  }

  return ranges
}

/**
 * Check if a position falls inside any markdown link range
 */
function isInsideMarkdownLink(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * Check if ranges overlap
 */
function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Detect all links (URLs, emails, file paths) in text
 */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = []

  // 1. Detect URLs and emails with linkify-it
  const urlMatches = linkify.match(text) || []
  // linkify-it doesn't strip trailing asterisks from bold/italic markdown,
  // which causes broken links when URLs are wrapped like **url** or *url*
  // Note: _ and ~ are valid URL chars so we only strip *
  const trailingMarkdownRe = /\*+$/
  for (const match of urlMatches) {
    let matchText = match.text
    let matchUrl = match.url
    let matchEnd = match.lastIndex

    const stripped = matchText.replace(trailingMarkdownRe, '')
    if (stripped !== matchText) {
      const diff = matchText.length - stripped.length
      matchText = stripped
      matchUrl = matchUrl.replace(trailingMarkdownRe, '')
      matchEnd -= diff
    }

    links.push({
      type: match.schema === 'mailto:' ? 'email' : 'url',
      text: matchText,
      url: matchUrl,
      start: match.index,
      end: matchEnd
    })
  }

  // 2. Detect file paths with custom regex
  // Reset regex state
  FILE_PATH_REGEX.lastIndex = 0
  let fileMatch
  while ((fileMatch = FILE_PATH_REGEX.exec(text)) !== null) {
    const path = fileMatch[1]
    if (!path) continue // Skip if no capture group

    // Calculate actual start position (after any leading whitespace/punctuation)
    const fullMatch = fileMatch[0]
    const pathOffset = fullMatch.indexOf(path)
    const start = fileMatch.index + pathOffset

    // Check for overlaps with URL matches (URLs take precedence)
    const pathRange = { start, end: start + path.length }
    const overlapsUrl = links.some(link => rangesOverlap(pathRange, link))
    if (overlapsUrl) continue

    links.push({
      type: 'file',
      text: path,
      url: path, // File paths are passed as-is to onFileClick handler
      start,
      end: start + path.length
    })
  }

  // Sort by position
  return links.sort((a, b) => a.start - b.start)
}

/**
 * Detect placeholder/fabricated URLs that the AI generated without knowing the real URL.
 * These are URLs like `https://github.com/...` or `https://example.com/...`
 * that should be stripped back to inline code instead of rendered as links.
 */
const PLACEHOLDER_URL_PATTERN = /\/\.\.\.(?:[)/\s#?]|$)/

/**
 * Check if a URL looks like a placeholder/fabricated URL.
 * Returns true for URLs containing path segments like `/...`
 */
export function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_URL_PATTERN.test(url)
}

/**
 * Strip markdown links with placeholder URLs back to plain text.
 * Converts `[text](https://github.com/...)` → `text`
 * Respects code blocks — links inside fenced or inline code are not touched.
 */
function stripPlaceholderLinks(text: string): string {
  const codeRanges = findCodeRanges(text)
  // Match markdown links [text](url) where url contains placeholder patterns
  return text.replace(
    /\[([^\[\]]*)\]\(([^)]*)\)/g,
    (fullMatch, linkText: string, url: string, offset: number) => {
      // Don't modify links inside code blocks
      if (isInsideCode(offset, codeRanges)) return fullMatch

      if (isPlaceholderUrl(url)) {
        // Strip the link, keep just the display text as plain text
        if (!linkText.trim()) return fullMatch
        return linkText
      }
      return fullMatch
    }
  )
}

/**
 * Preprocess text to convert raw URLs and file paths into markdown links
 * Skips code blocks and already-linked content
 */
export function preprocessLinks(text: string): string {
  // First pass: strip markdown links with placeholder/fabricated URLs
  // (e.g., AI-generated `[commit](https://github.com/...)` → `\`commit\``)
  text = stripPlaceholderLinks(text)

  // Quick check - if no potential links, return early
  if (!linkify.pretest(text) && !FILE_PATH_PRETEST_REGEX.test(text)) {
    return text
  }

  const codeRanges = findCodeRanges(text)
  const markdownLinkRanges = findMarkdownLinkRanges(text)
  const links = detectLinks(text)

  if (links.length === 0) return text

  // Build result, converting raw links to markdown links
  let result = ''
  let lastIndex = 0

  for (const link of links) {
    // Skip if inside code block
    if (isInsideCode(link.start, codeRanges)) continue

    // Skip if inside an existing markdown link (text or href portion)
    if (isInsideMarkdownLink(link.start, markdownLinkRanges)) continue

    // Add text before this link
    result += text.slice(lastIndex, link.start)

    // Convert to markdown link
    result += `[${link.text}](${link.url})`

    lastIndex = link.end
  }

  // Add remaining text
  result += text.slice(lastIndex)

  return result
}

/**
 * Test if text contains any detectable links
 * Useful for optimization - skip preprocessing if no links present
 */
export function hasLinks(text: string): boolean {
  return linkify.pretest(text) || FILE_PATH_PRETEST_REGEX.test(text)
}

/**
 * Check whether a markdown anchor target should be treated as a local file path.
 * Used by click handlers to route local paths to onFileClick instead of onUrlClick.
 */
export function isFilePathTarget(target: string): boolean {
  return FILE_PATH_TARGET_REGEX.test(target.trim())
}

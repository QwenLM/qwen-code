/**
 * Language utilities for code syntax highlighting.
 * Maps file extensions to language identifiers.
 */

/**
 * Map of file extensions to language IDs for syntax highlighting.
 */
export const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  graphql: 'graphql',
  dockerfile: 'dockerfile',
  toml: 'toml',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
}

/**
 * Get language ID from a file path.
 * @param filePath - The file path to detect language from
 * @param explicit - Optional explicit language override
 * @returns Language ID (defaults to 'text')
 */
export function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase()
  return LANGUAGE_MAP[ext || ''] || 'text'
}

/**
 * Format file path for display, replacing home directory with ~.
 * @param filePath - The file path to format
 * @returns Formatted path (e.g., /Users/john/code/file.ts → ~/code/file.ts)
 */
export function formatFilePath(filePath: string): string {
  const homeMatch = filePath.match(/^\/Users\/[^/]+\/(.+)$/)
  if (homeMatch) {
    return `~/${homeMatch[1]}`
  }
  return filePath
}

/**
 * Truncate a file path for display, keeping the filename visible.
 * Truncation priority: middle > start > end
 *
 * @param filePath - The file path to truncate
 * @param maxLength - Maximum character length (default: 60)
 * @returns Truncated path with ellipsis in middle if needed
 *
 * Examples:
 * - ~/very/long/path/to/some/file.ts → ~/very/…/some/file.ts
 * - /extremely/long/path/file.ts → …/long/path/file.ts
 */
export function truncateFilePath(filePath: string, maxLength = 60): string {
  // First format the path (replace home dir with ~)
  const formatted = formatFilePath(filePath)

  if (formatted.length <= maxLength) {
    return formatted
  }

  const parts = formatted.split('/')
  const filename = parts.pop() || ''

  // If filename alone is too long, truncate at end
  if (filename.length >= maxLength - 3) {
    return filename.slice(0, maxLength - 3) + '…'
  }

  // Reserve space for filename + ellipsis + separator
  const availableForPath = maxLength - filename.length - 4 // "…/" + "/" before filename

  if (availableForPath <= 0) {
    return '…/' + filename
  }

  // Try to keep first and last directory parts
  const dirPath = parts.join('/')

  if (dirPath.length <= availableForPath) {
    return formatted // Shouldn't happen but safety check
  }

  // Middle truncation: keep start and end of directory path
  const halfAvailable = Math.floor(availableForPath / 2)
  const startPart = dirPath.slice(0, halfAvailable)
  const endPart = dirPath.slice(-(availableForPath - halfAvailable))

  // Clean up partial directory names at truncation points
  const cleanStart = startPart.includes('/') ? startPart.slice(0, startPart.lastIndexOf('/')) : startPart
  const cleanEnd = endPart.includes('/') ? endPart.slice(endPart.indexOf('/')) : '/' + endPart

  return cleanStart + '/…' + cleanEnd + '/' + filename
}

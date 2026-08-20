/**
 * File utilities for language detection and path formatting.
 * Shared across code preview, diff preview, and multi-file diff components.
 */

/**
 * Map of file extensions to Monaco editor language IDs.
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
 * Get Monaco language ID from a file path.
 * @param filePath - The file path to detect language from
 * @param explicit - Optional explicit language override
 * @returns Monaco language ID (defaults to 'plaintext')
 */
export function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit

  const ext = filePath.split('.').pop()?.toLowerCase()
  return LANGUAGE_MAP[ext || ''] || 'plaintext'
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

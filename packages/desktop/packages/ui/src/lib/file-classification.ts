/**
 * File type classification for the link interceptor.
 *
 * Classifies file paths by extension to determine whether the app can show
 * an in-app preview overlay, and if so, which type of preview to use.
 * Used by useLinkInterceptor to decide between in-app preview vs. opening externally.
 */

/** Preview types that map to specific overlay components */
export type FilePreviewType = 'image' | 'code' | 'markdown' | 'json' | 'text' | 'pdf'

export interface FileClassification {
  /** The preview type, or null if no in-app preview is available */
  type: FilePreviewType | null
  /** Whether the file can be previewed in-app */
  canPreview: boolean
}

/**
 * Image formats — rendered in ImagePreviewOverlay via data URL.
 * Only includes formats Chromium can natively decode.
 * HEIC/HEIF and TIFF are excluded — Chromium has no codec for these,
 * so they fall through to system open (external app).
 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
])

/**
 * Code file extensions — rendered in CodePreviewOverlay with syntax highlighting.
 * Mirrors LANGUAGE_MAP from file-utils.ts but as a flat set for classification only.
 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less',
  'html', 'htm', 'xml', 'svg',  // SVG is also code-viewable, but image takes priority
  'yaml', 'yml', 'toml',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql',
  'dockerfile',
  'makefile',
  'r', 'lua', 'perl', 'php',
  'vue', 'svelte', 'astro', 'prisma',
])

/** Markdown files — rendered with the Markdown component */
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx'])

/** JSON files — rendered in JSONPreviewOverlay or code viewer */
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])

/** Plain text files — rendered as plaintext in code viewer */
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'tsv',
  'cfg', 'ini', 'conf',
  'env', 'env.local', 'env.development', 'env.production',
  'gitignore', 'gitattributes', 'editorconfig',
  'npmrc', 'nvmrc',
  'rtf',
])

/** PDF files — rendered in PDFPreviewOverlay via embedded viewer */
const PDF_EXTENSIONS = new Set(['pdf'])

/**
 * External-only file extensions — recognized as file links but opened externally.
 * These are included in FILE_EXTENSIONS_PATTERN so linkify.ts detects them as file paths,
 * but classifyFile() returns canPreview: false so they route to the system opener.
 */
const EXTERNAL_EXTENSIONS = new Set([
  'xlsx', 'xls', 'xlsm',   // Spreadsheets
  'docx', 'doc',             // Word documents
  'pptx', 'ppt',             // Presentations
  'zip', 'tar', 'gz', 'rar', '7z',  // Archives
  'dmg', 'pkg', 'exe', 'msi',       // Installers
  'mp3', 'wav', 'flac', 'aac',      // Audio
  'mp4', 'mov', 'avi', 'mkv',       // Video
  'heic', 'heif', 'tiff', 'tif',    // Images Chromium can't decode
])

/**
 * Extract the file extension from a path, lowercased.
 * Handles compound extensions like .env.local by returning the last segment.
 */
function getExtension(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === 0) return ''
  return basename.slice(dotIndex + 1).toLowerCase()
}

/**
 * Classify a file path by extension to determine preview capability.
 *
 * Priority order when an extension matches multiple sets (e.g. svg):
 * image > code > markdown > json > text > pdf
 */
export function classifyFile(filePath: string): FileClassification {
  const ext = getExtension(filePath)
  if (!ext) return { type: null, canPreview: false }

  if (IMAGE_EXTENSIONS.has(ext))    return { type: 'image', canPreview: true }
  if (MARKDOWN_EXTENSIONS.has(ext)) return { type: 'markdown', canPreview: true }
  if (JSON_EXTENSIONS.has(ext))     return { type: 'json', canPreview: true }
  if (CODE_EXTENSIONS.has(ext))     return { type: 'code', canPreview: true }
  if (TEXT_EXTENSIONS.has(ext))     return { type: 'text', canPreview: true }
  if (PDF_EXTENSIONS.has(ext))      return { type: 'pdf', canPreview: true }

  return { type: null, canPreview: false }
}

/**
 * Regex alternation of all known file extensions (e.g. "ts|tsx|js|...").
 * Derived from the classification sets above so link detection stays in sync
 * with preview support automatically.
 */
export const FILE_EXTENSIONS_PATTERN = [
  ...IMAGE_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...JSON_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...EXTERNAL_EXTENSIONS,
].join('|')

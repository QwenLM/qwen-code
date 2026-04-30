/**
 * Bundle File Utilities
 *
 * Shared helpers for serializing directory trees into portable JSON bundles.
 * Used by both session bundles and resource bundles.
 *
 * BundleFile.relativePath is always forward-slash separated for cross-platform portability.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, relative, dirname, sep } from 'path'
import { debug } from './debug.ts'

/**
 * Maximum bundle size in bytes (~100MB).
 */
export const MAX_BUNDLE_SIZE_BYTES = 100 * 1024 * 1024

/**
 * A file entry in a bundle.
 * Contains a portable relative path and base64-encoded content.
 */
export interface BundleFile {
  /** Portable relative path within the directory (always forward-slash separated) */
  relativePath: string
  /** Base64-encoded file content */
  contentBase64: string
  /** Original file size in bytes (for validation) */
  size: number
}

// ============================================================
// Path Portability
// ============================================================

/**
 * Normalize an OS-native relative path to portable forward-slash form.
 */
export function toPortableRelPath(relPath: string): string {
  return relPath.split(sep).join('/')
}

/**
 * Convert a portable forward-slash path to OS-native form for filesystem writes.
 */
export function fromPortableRelPath(portablePath: string): string {
  return portablePath.split('/').join(sep)
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate a single BundleFile entry for safety and integrity.
 * Returns an error message string, or null if valid.
 */
export function validateBundleFile(file: BundleFile): string | null {
  if (!file.relativePath || typeof file.relativePath !== 'string') {
    return 'Missing or invalid relativePath'
  }

  // Path traversal checks
  if (file.relativePath.includes('..')) {
    return `Path traversal detected: ${file.relativePath}`
  }
  if (file.relativePath.startsWith('/') || file.relativePath.startsWith('\\')) {
    return `Absolute path not allowed: ${file.relativePath}`
  }
  if (file.relativePath.includes('\\')) {
    return `Backslash path separator not allowed: ${file.relativePath}`
  }

  // Check for empty segments (double slashes)
  if (file.relativePath.includes('//')) {
    return `Invalid path (double slash): ${file.relativePath}`
  }

  // Validate base64 and size
  if (typeof file.contentBase64 !== 'string') {
    return `Invalid contentBase64 for ${file.relativePath}`
  }
  if (typeof file.size !== 'number' || file.size < 0) {
    return `Invalid size for ${file.relativePath}`
  }

  // Verify decoded size matches declared size
  try {
    const decoded = Buffer.from(file.contentBase64, 'base64')
    if (decoded.length !== file.size) {
      return `Size mismatch for ${file.relativePath}: declared ${file.size}, actual ${decoded.length}`
    }
  } catch {
    return `Invalid base64 encoding for ${file.relativePath}`
  }

  return null
}

// ============================================================
// Collection
// ============================================================

export interface CollectOptions {
  /** File names to skip (exact match, e.g., 'config.json') */
  skipFiles?: Set<string>
  /** Directory names to skip (exact match, e.g., 'tmp') */
  skipDirs?: Set<string>
}

/**
 * Collect all non-hidden regular files recursively from a directory.
 * Returns BundleFile entries sorted by relativePath for deterministic ordering.
 *
 * Skips:
 * - Hidden files and directories (starting with '.')
 * - Files/dirs matching skipFiles/skipDirs options
 * - Unreadable files (logged and skipped)
 */
export function collectDirectoryFiles(dir: string, options?: CollectOptions): BundleFile[] {
  const files: BundleFile[] = []
  const skipFiles = options?.skipFiles ?? new Set()
  const skipDirs = options?.skipDirs ?? new Set()

  function walk(currentDir: string): void {
    if (!existsSync(currentDir)) return

    const entries = readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      // Skip hidden files and directories
      if (entry.name.startsWith('.')) continue

      const fullPath = join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(fullPath)
      } else if (entry.isFile()) {
        if (skipFiles.has(entry.name)) continue

        try {
          const content = readFileSync(fullPath)
          const stat = statSync(fullPath)
          const relPath = relative(dir, fullPath)

          files.push({
            relativePath: toPortableRelPath(relPath),
            contentBase64: content.toString('base64'),
            size: stat.size,
          })
        } catch (err) {
          debug(`[bundle-files] Failed to read file ${fullPath}:`, err)
          // Skip unreadable files rather than failing the entire collection
        }
      }
    }
  }

  walk(dir)

  // Sort for deterministic output
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  return files
}

// ============================================================
// Restoration
// ============================================================

/**
 * Restore BundleFile entries to a target directory.
 * Creates subdirectories as needed. Validates each file before writing.
 *
 * @throws Error if any file fails path validation (path traversal, absolute path, etc.)
 */
export function restoreFiles(targetDir: string, files: BundleFile[]): void {
  for (const file of files) {
    const error = validateBundleFile(file)
    if (error) {
      throw new Error(`Invalid bundle file: ${error}`)
    }

    const nativePath = fromPortableRelPath(file.relativePath)
    const fullPath = join(targetDir, nativePath)

    // Safety: ensure resolved path is inside target dir
    if (!fullPath.startsWith(targetDir + sep) && fullPath !== targetDir) {
      throw new Error(`Path escapes target directory: ${file.relativePath}`)
    }

    // Ensure parent directory exists
    const parentDir = dirname(fullPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // Decode and write
    const content = Buffer.from(file.contentBase64, 'base64')
    writeFileSync(fullPath, content)
  }
}

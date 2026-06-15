/**
 * Thumbnail Protocol Handler
 *
 * Registers a custom `thumbnail://` protocol that serves thumbnail images
 * for files in the session sidebar. The browser handles all async loading
 * natively via <img src="thumbnail://encoded-path" />.
 *
 * Thumbnail generation strategy (cross-platform):
 * - macOS/Windows: nativeImage.createThumbnailFromPath() — uses OS-level
 *   thumbnail cache (Quick Look / Shell API). Fast (~5ms cached), handles
 *   images, PDFs, Office docs automatically.
 * - Linux: nativeImage.createFromPath() + resize() — uses Chromium's Skia
 *   engine. Works for images only. No PDF/Office support.
 *
 * Caching:
 * - In-memory LRU map keyed on `path + mtime`. Cache miss triggers generation.
 * - Entries auto-invalidate when file mtime changes (e.g. after file watcher fires).
 * - Capped at MAX_CACHE_ENTRIES to bound memory usage.
 */

import { protocol, nativeImage } from 'electron'
import { stat } from 'fs/promises'
import { isAbsolute } from 'path'
import { mainLog } from './logger'

/** Thumbnail output size in pixels (width and height) */
const THUMBNAIL_SIZE = 64

/** Maximum entries in the in-memory LRU cache */
const MAX_CACHE_ENTRIES = 200

/** File extensions that support thumbnail generation */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif',
])

/** Extensions that only work via OS thumbnail API (macOS/Windows) */
const OS_THUMBNAIL_EXTENSIONS = new Set([
  'pdf', 'svg', 'psd', 'ai',
])

/** All extensions we can potentially thumbnail */
const ALL_PREVIEWABLE = new Set([...IMAGE_EXTENSIONS, ...OS_THUMBNAIL_EXTENSIONS])

// In-memory LRU cache: path -> { mtime, data }
const cache = new Map<string, { mtime: number; data: Buffer }>()

/**
 * Evict oldest entries when cache exceeds max size.
 * Map iterates in insertion order, so first entries are oldest.
 */
function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
}

/**
 * Check if the current platform supports OS-level thumbnail generation.
 * nativeImage.createThumbnailFromPath() is only available on macOS and Windows.
 */
const supportsOSThumbnails = process.platform === 'darwin' || process.platform === 'win32'

/**
 * Generate a thumbnail buffer for the given file path.
 * Returns a PNG buffer or null if generation fails/unsupported.
 */
async function generateThumbnail(filePath: string, ext: string): Promise<Buffer | null> {
  // Strategy 1: OS-level thumbnail (macOS/Windows) — handles images + PDFs + more
  if (supportsOSThumbnails) {
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
      })
      if (!thumbnail.isEmpty()) {
        return thumbnail.toPNG()
      }
    } catch {
      // OS thumbnail failed — fall through to Skia-based fallback for images
    }
  }

  // Strategy 2: Skia-based resize (all platforms) — images only
  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const img = nativeImage.createFromPath(filePath)
      if (img.isEmpty()) return null
      const resized = img.resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE })
      return resized.toPNG()
    } catch {
      return null
    }
  }

  // Unsupported file type on this platform
  return null
}

/**
 * Register the thumbnail:// custom protocol scheme.
 * MUST be called before app.whenReady() — Electron requires scheme
 * registration during the earliest phase of app initialization.
 */
export function registerThumbnailScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'thumbnail',
      privileges: {
        // Allow the renderer to fetch from this scheme
        supportFetchAPI: true,
        // Standard scheme allows normal URL parsing (host, path, etc.)
        standard: true,
        // Allow cross-origin access from the renderer
        corsEnabled: true,
        // Stream support for efficient response delivery
        stream: true,
      },
    },
  ])
}

/**
 * Register the thumbnail:// protocol handler.
 * Must be called after app.whenReady() — the handler processes
 * incoming requests and returns thumbnail image responses.
 *
 * URL format: thumbnail://thumb/<encodeURIComponent(absolutePath)>
 * Examples:
 *   macOS:   thumbnail://thumb/%2FUsers%2Ffoo%2Fimage.png
 *   Windows: thumbnail://thumb/C%3A%5CUsers%5Cfoo%5Cimage.png
 */
export function registerThumbnailHandler(): void {
  protocol.handle('thumbnail', async (request) => {
    try {
      // Parse the file path from the URL
      // Format: thumbnail://thumb/<encoded-path>
      // URL.pathname includes a leading /, so we strip it before decoding
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.slice(1))

      // Basic validation: must be an absolute path (works on all platforms)
      if (!filePath || !isAbsolute(filePath)) {
        return new Response(null, { status: 400 })
      }

      // Check file extension is previewable
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      if (!ALL_PREVIEWABLE.has(ext)) {
        return new Response(null, { status: 404 })
      }

      // Get file mtime for cache validation
      let mtime: number
      try {
        const fileStat = await stat(filePath)
        mtime = fileStat.mtimeMs
      } catch {
        // File doesn't exist or is inaccessible
        return new Response(null, { status: 404 })
      }

      // Check cache — hit if path matches AND mtime hasn't changed
      const cached = cache.get(filePath)
      if (cached && cached.mtime === mtime) {
        return new Response(new Uint8Array(cached.data), {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'max-age=3600',
          },
        })
      }

      // Cache miss — generate thumbnail
      const data = await generateThumbnail(filePath, ext)
      if (!data) {
        return new Response(null, { status: 404 })
      }

      // Store in cache (move to end for LRU behavior by delete+set)
      cache.delete(filePath)
      cache.set(filePath, { mtime, data })
      evictIfNeeded()

      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'max-age=3600',
        },
      })
    } catch (error) {
      mainLog.error('Thumbnail protocol error:', error)
      return new Response(null, { status: 500 })
    }
  })

  mainLog.info('Registered thumbnail:// protocol handler')
}

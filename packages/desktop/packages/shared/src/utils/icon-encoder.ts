/**
 * Icon Encoder Utility
 *
 * Converts icon file paths to base64 data URLs for embedding in session storage.
 * This allows the session viewer (web) to display icons without filesystem access.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { extname, dirname, basename, join } from 'path';
import { isEmoji } from './icon-constants.ts';

/**
 * MIME type mappings for icon files
 */
const EXT_TO_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Target size for icon thumbnails (px).
 * Icons are displayed at 20x20 in the UI, so 32x32 provides good quality at 2x.
 */
const ICON_TARGET_SIZE = 32;

/**
 * Maximum file size for direct encoding without resize (50KB).
 * Files under this size are encoded as-is when no resize callback is provided.
 */
const MAX_FILE_SIZE = 50 * 1024;

/** Raster extensions that support resize (SVGs are vector, skip resize) */
const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif']);

export interface EncodeIconOptions {
  /** Resize raster icons to 32x32. Takes (buffer, targetSize), returns PNG buffer. */
  resize?: (buffer: Buffer, targetSize: number) => Buffer | undefined;
}

export interface EncodeIconOptionsAsync {
  /** Async resize raster icons to 32x32. Takes (buffer, targetSize), returns PNG buffer. */
  resize?: (buffer: Buffer, targetSize: number) => Promise<Buffer | undefined>;
}

/**
 * Get the thumbnail cache path for an icon file.
 * e.g., /path/to/icon.png → /path/to/icon.thumb.png
 */
function getThumbPath(iconPath: string): string {
  const dir = dirname(iconPath);
  const ext = extname(iconPath);
  const name = basename(iconPath, ext);
  return join(dir, `${name}.thumb.png`);
}

/**
 * Check if a cached thumbnail is still valid (exists and newer than original).
 */
function isThumbValid(iconPath: string, thumbPath: string): boolean {
  if (!existsSync(thumbPath)) return false;
  try {
    const originalMtime = statSync(iconPath).mtimeMs;
    const thumbMtime = statSync(thumbPath).mtimeMs;
    return thumbMtime >= originalMtime;
  } catch {
    return false;
  }
}

/**
 * Encode an icon file to a base64 data URL.
 *
 * When a `resize` callback is provided (via options), raster images are resized
 * to 32x32 and cached as `{name}.thumb.png` next to the original. SVGs are
 * always encoded directly (vector = resolution-independent).
 *
 * @param iconPath - Absolute path to the icon file
 * @param options - Optional resize callback for raster images
 * @returns Base64 data URL (e.g., "data:image/png;base64,...") or undefined if encoding fails
 */
export function encodeIconToDataUrl(iconPath: string | undefined, options?: EncodeIconOptions): string | undefined {
  if (!iconPath) {
    return undefined;
  }

  // Already a data URL - pass through
  if (iconPath.startsWith('data:')) {
    return iconPath;
  }

  // Emoji - not a file path, skip
  if (isEmoji(iconPath)) {
    return undefined;
  }

  // Check file exists
  if (!existsSync(iconPath)) {
    return undefined;
  }

  // Get MIME type from extension
  const ext = extname(iconPath).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    return undefined;
  }

  const isRaster = RASTER_EXTENSIONS.has(ext);

  // For raster images with a resize callback, always use 32x32 thumbnail
  if (isRaster && options?.resize) {
    const thumbPath = getThumbPath(iconPath);

    // Check for valid cached thumbnail
    if (isThumbValid(iconPath, thumbPath)) {
      try {
        const thumbBuffer = readFileSync(thumbPath);
        const base64 = thumbBuffer.toString('base64');
        return `data:image/png;base64,${base64}`;
      } catch {
        // Cache read failed, fall through to regenerate
      }
    }

    // Generate thumbnail
    try {
      const buffer = readFileSync(iconPath);
      const resized = options.resize(buffer, ICON_TARGET_SIZE);
      if (resized) {
        // Cache the thumbnail for next time
        try { writeFileSync(thumbPath, resized); } catch { /* cache write is best-effort */ }
        const base64 = resized.toString('base64');
        return `data:image/png;base64,${base64}`;
      }
    } catch {
      return undefined;
    }
  }

  // Fallback: encode directly (SVGs, or raster without resize callback)
  try {
    const buffer = readFileSync(iconPath);
    if (buffer.length > MAX_FILE_SIZE) {
      return undefined;
    }
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return undefined;
  }
}

/**
 * Async variant of encodeIconToDataUrl that supports async resize callbacks (e.g. sharp).
 * Same thumbnail caching behavior as the sync version.
 */
export async function encodeIconToDataUrlAsync(iconPath: string | undefined, options?: EncodeIconOptionsAsync): Promise<string | undefined> {
  if (!iconPath) {
    return undefined;
  }

  if (iconPath.startsWith('data:')) {
    return iconPath;
  }

  if (isEmoji(iconPath)) {
    return undefined;
  }

  if (!existsSync(iconPath)) {
    return undefined;
  }

  const ext = extname(iconPath).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    return undefined;
  }

  const isRaster = RASTER_EXTENSIONS.has(ext);

  if (isRaster && options?.resize) {
    const thumbPath = getThumbPath(iconPath);

    if (isThumbValid(iconPath, thumbPath)) {
      try {
        const thumbBuffer = readFileSync(thumbPath);
        const base64 = thumbBuffer.toString('base64');
        return `data:image/png;base64,${base64}`;
      } catch {
        // Cache read failed, fall through to regenerate
      }
    }

    try {
      const buffer = readFileSync(iconPath);
      const resized = await options.resize(buffer, ICON_TARGET_SIZE);
      if (resized) {
        try { writeFileSync(thumbPath, resized); } catch { /* cache write is best-effort */ }
        const base64 = resized.toString('base64');
        return `data:image/png;base64,${base64}`;
      }
    } catch {
      return undefined;
    }
  }

  try {
    const buffer = readFileSync(iconPath);
    if (buffer.length > MAX_FILE_SIZE) {
      return undefined;
    }
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return undefined;
  }
}

/**
 * Get the emoji value if the input is an emoji, otherwise undefined.
 * Used for ToolDisplayMeta where we might want to display emoji as icon.
 */
export function getEmojiIcon(value: string | undefined): string | undefined {
  if (value && isEmoji(value)) {
    return value;
  }
  return undefined;
}

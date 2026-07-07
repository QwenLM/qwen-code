/**
 * Unified Icon Utilities
 *
 * Shared icon handling for skills, sources, and statuses.
 * All three systems use the same icon format and behavior:
 *
 * Supported formats:
 * - Emoji: "🔧" - rendered as text in UI
 * - URL: "https://..." - auto-downloaded to icon.{ext} file
 * - File: icon.svg, icon.png, etc. - auto-discovered in directory
 *
 * Priority: Config value (emoji/URL) > Local file (auto-discovered)
 * Config is the source of truth. Local files are only used when config.icon is undefined.
 *
 * NOT supported (rejected):
 * - Inline SVG: "<svg>...</svg>"
 * - Relative paths: "./icon.svg", "/path/to/icon"
 */

import { existsSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { debug } from './debug.ts';

// Re-export pure constants from icon-constants.ts for backwards compatibility.
// Renderer code should import directly from icon-constants.ts to avoid Node.js deps.
export {
  EMOJI_REGEX,
  ICON_EXTENSIONS,
  isEmoji,
  isIconUrl,
  isInvalidIconValue,
} from './icon-constants.ts';

import { ICON_EXTENSIONS, isEmoji, isIconUrl, isInvalidIconValue } from './icon-constants.ts';

/**
 * Map of content-type to file extension for icon downloads.
 */
const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// ============================================================
// Validation Functions
// ============================================================

/**
 * Validate and normalize an icon value.
 * Returns the value if valid (emoji or URL), undefined if invalid.
 *
 * @param icon - The icon value to validate
 * @param context - Context for debug logging (e.g., "Skills", "Sources", "Statuses")
 */
export function validateIconValue(icon: unknown, context: string = 'Icon'): string | undefined {
  if (typeof icon !== 'string' || !icon.trim()) {
    return undefined;
  }

  const trimmed = icon.trim();

  // Reject invalid values (inline SVG, relative paths)
  if (isInvalidIconValue(trimmed)) {
    debug(`[${context}] Invalid icon value (inline SVG or relative path not supported):`, trimmed.slice(0, 50));
    return undefined;
  }

  // Accept emoji or URL
  if (isEmoji(trimmed) || isIconUrl(trimmed)) {
    return trimmed;
  }

  // Unknown format - reject
  debug(`[${context}] Unknown icon format, must be emoji or URL:`, trimmed);
  return undefined;
}

// ============================================================
// File Discovery
// ============================================================

/**
 * Find icon file in a directory.
 * Returns first matching icon.{svg,png,jpg,jpeg} or undefined.
 */
export function findIconFile(dir: string): string | undefined {
  for (const ext of ICON_EXTENSIONS) {
    const iconPath = join(dir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }
  return undefined;
}

// ============================================================
// Download Functions
// ============================================================

/**
 * Extract file extension from URL path.
 * Returns extension with dot (e.g., ".svg") or null if not found.
 */
function getExtensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    if (ICON_EXTENSIONS.includes(ext) || ext === '.jpeg') {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Download an icon from a URL and save it to a directory.
 * Returns the path to the downloaded icon, or null on failure.
 *
 * @param targetDir - Directory to save the icon to
 * @param iconUrl - URL to download the icon from
 * @param context - Context for debug logging
 * @param filenameBase - Custom filename base (default: 'icon'). Saved as {filenameBase}.{ext}
 */
export async function downloadIcon(
  targetDir: string,
  iconUrl: string,
  context: string = 'Icon',
  filenameBase: string = 'icon'
): Promise<string | null> {
  debug(`[${context}] Downloading icon from:`, iconUrl);

  try {
    const response = await fetch(iconUrl, {
      headers: {
        'User-Agent': 'Craft-Agent/1.0',
      },
    });

    if (!response.ok) {
      debug(`[${context}] Icon download failed:`, response.status, response.statusText);
      return null;
    }

    // Determine file extension from content-type or URL
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    let ext = contentType ? CONTENT_TYPE_TO_EXT[contentType] : null;

    // Fall back to URL extension if content-type doesn't match
    if (!ext) {
      ext = getExtensionFromUrl(iconUrl);
    }

    // Default to .svg if we can't determine the type
    if (!ext) {
      debug(`[${context}] Could not determine icon type, defaulting to .svg`);
      ext = '.svg';
    }

    // Read the response body and write to file
    const buffer = await response.arrayBuffer();
    const iconPath = join(targetDir, `${filenameBase}${ext}`);
    writeFileSync(iconPath, Buffer.from(buffer));

    debug(`[${context}] Icon downloaded successfully:`, iconPath);
    return iconPath;
  } catch (error) {
    debug(`[${context}] Icon download error:`, error);
    return null;
  }
}

/**
 * Check if an icon needs to be downloaded.
 * Returns true if icon is a URL and no local icon file exists.
 */
export function needsIconDownload(iconValue: string | undefined, localIconPath: string | undefined): boolean {
  // No icon URL specified
  if (!iconValue || !isIconUrl(iconValue)) {
    return false;
  }
  // Local icon file already exists
  if (localIconPath) {
    return false;
  }
  return true;
}

// ============================================================
// Icon Resolution
// ============================================================

/**
 * Result of resolving an icon for rendering.
 */
export interface ResolvedIcon {
  type: 'file' | 'emoji' | 'url' | 'none';
  /** For file: absolute path. For emoji: the emoji string. For url: the URL. */
  value?: string;
}

/**
 * Resolve an icon for rendering.
 * Config value is the source of truth. Local files are fallback for auto-discovery.
 *
 * Priority:
 * 1. Emoji in config → emoji
 * 2. URL in config → url (caller handles download/display)
 * 3. Local file (auto-discovered) → file
 * 4. None
 *
 * @param iconValue - The icon value from config (emoji or URL)
 * @param localIconPath - Path to local icon file if it exists (auto-discovered)
 */
export function resolveIcon(iconValue: string | undefined, localIconPath: string | undefined): ResolvedIcon {
  // Priority 1: Emoji from config
  if (iconValue && isEmoji(iconValue)) {
    return { type: 'emoji', value: iconValue };
  }

  // Priority 2: URL from config (caller handles download/display)
  if (iconValue && isIconUrl(iconValue)) {
    return { type: 'url', value: iconValue };
  }

  // Priority 3: Auto-discovered local file (only when config.icon is undefined)
  if (localIconPath) {
    return { type: 'file', value: localIconPath };
  }

  // No icon
  return { type: 'none' };
}

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { BRAND_TEMP_PATH_SLUG } from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';

/**
 * Directory for persisted MCP binary content. Callers pass the session-scoped
 * spill dir; the tmpdir fallback only serves contexts without a session.
 */
function ensureBlobDir(baseDir?: string): string {
  const dir = baseDir ?? path.join(os.tmpdir(), `${BRAND_TEMP_PATH_SLUG}-mcp-blobs`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist oversized binary data to disk and return a reference path.
 * Returns the file path where the data was saved.
 */
export function persistBinaryData(
  data: string,
  mimeType: string,
  toolName: string,
  baseDir?: string,
): string {
  const extension = mimeTypeToExtension(mimeType);
  const hash = crypto
    .createHash('sha256')
    .update(data)
    .digest('hex')
    .slice(0, 16);
  const filename = `${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${hash}${extension}`;
  const filePath = path.join(ensureBlobDir(baseDir), filename);

  try {
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(filePath, buffer);
    runLogger.debug(
      `Persisted MCP binary data to disk: ${filePath} (${buffer.length} bytes)`,
    );
    return filePath;
  } catch (error) {
    runLogger.warn(`Failed to persist MCP binary data: ${error}`);
    throw error;
  }
}

/**
 * Get the approximate decoded size in bytes from a base64 string.
 */
export function getBase64DecodedSize(base64: string): number {
  // base64 encodes 3 bytes into 4 characters
  // Padding '=' reduces effective data
  const padding = (base64.match(/=+$/) || [''])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Map common MIME types to file extensions.
 */
function mimeTypeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'application/octet-stream': '.bin',
  };
  return map[mimeType] || '.bin';
}

// ----- Unicode Sanitization -----

/**
 * Regex matching problematic Unicode characters that should be stripped
 * from MCP text content:
 * - Zero-width space (U+200B)
 * - Zero-width non-joiner (U+200C)
 * - Zero-width joiner (U+200D)
 * - Left-to-right mark (U+200E)
 * - Right-to-left mark (U+200F)
 * - Zero-width no-break space / BOM (U+FEFF)
 * - Word joiner (U+2060)
 * - Invisible separator (U+2063)
 * - Various control characters (C0 set, except \t\n\r)
 */
const PROBLEMATIC_UNICODE_RE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2063]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize text content from MCP responses by removing problematic
 * zero-width and control characters that can cause issues with model
 * processing or display.
 */
export function sanitizeUnicode(text: string): string {
  return text.replace(PROBLEMATIC_UNICODE_RE, '');
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import os from 'node:os';
import { detect as chardetDetect } from 'chardet';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('ENCODING');

// Cache for system encoding to avoid repeated detection
// Use undefined to indicate "not yet checked" vs null meaning "checked but failed"
let cachedSystemEncoding: string | null | undefined = undefined;

/**
 * Reset the encoding cache - useful for testing
 */
export function resetEncodingCache(): void {
  cachedSystemEncoding = undefined;
}

/**
 * Detects the encoding for a buffer of command output.
 *
 * Strategy: try UTF-8 first, then fall back to auto-detection.
 * This is optimistic about UTF-8 because:
 * - Modern developer tools increasingly output UTF-8
 * - PowerShell Core defaults to UTF-8
 * - git, node, and most CLI tools output UTF-8
 * - Legacy codepage bytes (0x80-0xFF) rarely form valid UTF-8
 *   multi-byte sequences by accident
 *
 * The system encoding is cached and used as a fallback when the buffer
 * is not valid UTF-8 and chardet-based detection fails.
 *
 * @param buffer A buffer to analyze for encoding detection.
 */
export function getCachedEncodingForBuffer(buffer: Buffer): string {
  // Try UTF-8 first: if the buffer is valid UTF-8, use it immediately.
  // This avoids misclassifying UTF-8 output as a legacy codepage on
  // systems where the system encoding happens to also be valid for
  // those same bytes.
  if (isValidUtf8(buffer)) {
    return 'utf-8';
  }

  // Buffer is not valid UTF-8 — try chardet-based detection
  const detected = detectEncodingFromBuffer(buffer);
  if (detected) {
    return detected;
  }

  // Fall back to system encoding
  if (cachedSystemEncoding === undefined) {
    cachedSystemEncoding = getSystemEncoding();
  }
  if (cachedSystemEncoding) {
    return cachedSystemEncoding;
  }

  // Last resort
  return 'utf-8';
}

/**
 * Checks whether a buffer contains valid UTF-8 data.
 * Uses Node.js TextDecoder in strict mode (fatal: true) to validate.
 */
function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects the system encoding based on the platform.
 * For Windows, it uses the 'chcp' command to get the current code page.
 * For Unix-like systems, it checks environment variables like LC_ALL, LC_CTYPE, and LANG.
 * If those are not set, it tries to run 'locale charmap' to get the encoding.
 * If detection fails, it returns null.
 * @returns The system encoding as a string, or null if detection fails.
 */
export function getSystemEncoding(): string | null {
  // Windows
  if (os.platform() === 'win32') {
    try {
      const output = execSync('chcp', { encoding: 'utf8' });
      const match = output.match(/:\s*(\d+)/);
      if (match) {
        const codePage = parseInt(match[1], 10);
        if (!isNaN(codePage)) {
          return windowsCodePageToEncoding(codePage);
        }
      }
      // Only warn if we can't parse the output format, not if windowsCodePageToEncoding fails
      throw new Error(
        `Unable to parse Windows code page from 'chcp' output "${output.trim()}". `,
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to get Windows code page using 'chcp' command: ${error instanceof Error ? error.message : String(error)}. ` +
          `Will attempt to detect encoding from command output instead.`,
      );
    }
    return null;
  }

  // Unix-like
  // Use environment variables LC_ALL, LC_CTYPE, and LANG to determine the
  // system encoding. However, these environment variables might not always
  // be set or accurate. Handle cases where none of these variables are set.
  const env = process.env;
  let locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';

  // Fallback to querying the system directly when environment variables are missing
  if (!locale) {
    try {
      locale = execSync('locale charmap', { encoding: 'utf8' })
        .toString()
        .trim();
    } catch (_e) {
      debugLogger.warn('Failed to get locale charmap.');
      return null;
    }
  }

  const match = locale.match(/\.(.+)/); // e.g., "en_US.UTF-8"
  if (match && match[1]) {
    return match[1].toLowerCase();
  }

  // Handle cases where locale charmap returns just the encoding name (e.g., "UTF-8")
  if (locale && !locale.includes('.')) {
    return locale.toLowerCase();
  }

  return null;
}

/**
 * Converts a Windows code page number to a corresponding encoding name.
 * @param cp The Windows code page number (e.g., 437, 850, etc.)
 * @returns The corresponding encoding name as a string, or null if no mapping exists.
 */
/** Windows code page number for UTF-8. */
export const WINDOWS_UTF8_CODE_PAGE = 65001;

export function windowsCodePageToEncoding(cp: number): string | null {
  // Most common mappings; extend as needed
  const map: { [key: number]: string } = {
    437: 'cp437',
    850: 'cp850',
    852: 'cp852',
    866: 'cp866',
    874: 'windows-874',
    932: 'shift_jis',
    936: 'gbk',
    949: 'euc-kr',
    950: 'big5',
    1200: 'utf-16le',
    1201: 'utf-16be',
    1250: 'windows-1250',
    1251: 'windows-1251',
    1252: 'windows-1252',
    1253: 'windows-1253',
    1254: 'windows-1254',
    1255: 'windows-1255',
    1256: 'windows-1256',
    1257: 'windows-1257',
    1258: 'windows-1258',
    [WINDOWS_UTF8_CODE_PAGE]: 'utf-8',
  };

  if (map[cp]) {
    return map[cp];
  }

  debugLogger.warn(`Unable to determine encoding for windows code page ${cp}.`);
  return null; // Return null if no mapping found
}

/**
 * Attempts to detect encoding from a buffer using chardet.
 * This is useful when system encoding detection fails.
 * Returns the detected encoding in lowercase, or null if detection fails.
 * @param buffer The buffer to analyze for encoding.
 * @return The detected encoding as a lowercase string, or null if detection fails.
 */
export function detectEncodingFromBuffer(buffer: Buffer): string | null {
  try {
    const detected = chardetDetect(buffer);
    if (detected && typeof detected === 'string') {
      return detected.toLowerCase();
    }
  } catch (error) {
    debugLogger.warn('Failed to detect encoding with chardet:', error);
  }

  return null;
}

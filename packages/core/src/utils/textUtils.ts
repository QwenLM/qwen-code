/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripVTControlCharacters } from 'node:util';

// C0/C1 control chars (incl. DEL) left behind after escape-sequence stripping.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strips terminal escape/control sequences from untrusted text: removes ANSI/VT
 * escape sequences (via Node's `stripVTControlCharacters`) and then any residual
 * C0/C1 control characters (including DEL).
 *
 * Use this for ANY untrusted string that may reach a terminal — marketplace
 * metadata rendered in the TUI, values interpolated into error messages, etc.
 * Centralised here so the rule can't drift between call sites: a bypass fixed
 * here is fixed everywhere instead of leaving a stale near-duplicate vulnerable.
 */
export function stripAnsiAndControl(text: string): string {
  return stripVTControlCharacters(text).replace(CONTROL_CHARS_RE, '');
}

/**
 * Safely replaces text with literal strings, avoiding ECMAScript GetSubstitution issues.
 * Escapes $ characters to prevent template interpretation.
 */
export function safeLiteralReplace(
  str: string,
  oldString: string,
  newString: string,
): string {
  if (oldString === '' || !str.includes(oldString)) {
    return str;
  }

  if (!newString.includes('$')) {
    return str.replaceAll(oldString, newString);
  }

  const escapedNewString = newString.replaceAll('$', '$$$$');
  return str.replaceAll(oldString, escapedNewString);
}

/**
 * Checks if a Buffer is likely binary by testing for the presence of a NULL byte.
 * The presence of a NULL byte is a strong indicator that the data is not plain text.
 * @param data The Buffer to check.
 * @param sampleSize The number of bytes from the start of the buffer to test.
 * @returns True if a NULL byte is found, false otherwise.
 */
export function isBinary(
  data: Buffer | null | undefined,
  sampleSize = 512,
): boolean {
  if (!data) {
    return false;
  }

  const sample = data.length > sampleSize ? data.subarray(0, sampleSize) : data;

  for (const byte of sample) {
    // The presence of a NULL byte (0x00) is one of the most reliable
    // indicators of a binary file. Text files should not contain them.
    if (byte === 0) {
      return true;
    }
  }

  // If no NULL bytes were found in the sample, we assume it's text.
  return false;
}

/**
 * Normalizes text content by stripping the UTF-8 BOM and converting all CRLF (\r\n)
 * or standalone CR (\r) line endings to LF (\n).
 *
 * This is crucial for cross-platform compatibility, particularly to prevent parsing
 * failures on Windows where files may be saved with CRLF line endings.
 *
 * @param content The raw text content to normalize
 * @returns The normalized string with uniform \n line endings
 */
export function normalizeContent(content: string): string {
  // Strip UTF-8 BOM to ensure string processing starts at the first real character.
  let normalized = content.replace(/^\uFEFF/, '');

  // Normalize line endings to LF (\n).
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return normalized;
}

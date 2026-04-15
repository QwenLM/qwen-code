/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Portable session storage utilities for efficient session metadata reading.
 *
 * Provides string-level JSON field extraction (no full parse) and head/tail
 * file reading for fast session metadata access on large JSONL files.
 */

import fs from 'node:fs';

/** Size of the head/tail buffer for lite metadata reads (64KB). */
export const LITE_READ_BUF_SIZE = 64 * 1024;

// ---------------------------------------------------------------------------
// JSON string field extraction — no full parse, works on truncated lines
// ---------------------------------------------------------------------------

/**
 * Unescape a JSON string value extracted as raw text.
 * Only allocates a new string when escape sequences are present.
 */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * Extracts a simple JSON string field value from raw text without full parsing.
 * Looks for `"key":"value"` or `"key": "value"` patterns.
 * Returns the first match, or undefined if not found.
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern);
    if (idx < 0) continue;

    const valueStart = idx + pattern.length;
    let i = valueStart;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i));
      }
      i++;
    }
  }
  return undefined;
}

/**
 * Like extractJsonStringField but finds the LAST occurrence.
 * Useful for fields that are appended (customTitle, aiTitle, etc.)
 * where the most recent entry should win.
 *
 * When `lineContains` is provided, only matches on lines that also contain
 * the given substring are considered. This prevents false matches from user
 * content that happens to contain the same key pattern.
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
  lineContains?: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  let lastValue: string | undefined;
  let lastOffset = -1;
  for (const pattern of patterns) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(pattern, searchFrom);
      if (idx < 0) break;

      // If lineContains is specified, verify the current line contains it
      if (lineContains) {
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        const lineEnd = text.indexOf('\n', idx);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (!line.includes(lineContains)) {
          searchFrom = idx + pattern.length;
          continue;
        }
      }

      const valueStart = idx + pattern.length;
      let i = valueStart;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          if (idx > lastOffset) {
            lastValue = unescapeJsonString(text.slice(valueStart, i));
            lastOffset = idx;
          }
          break;
        }
        i++;
      }
      searchFrom = i + 1;
    }
  }
  return lastValue;
}

// ---------------------------------------------------------------------------
// File I/O — read head and tail of a file
// ---------------------------------------------------------------------------

/**
 * Reads the first and last LITE_READ_BUF_SIZE bytes of a file synchronously.
 *
 * For small files where head covers the entire file, `tail === head`.
 * Returns `{ head: '', tail: '' }` on any error.
 */
export function readHeadAndTailSync(filePath: string): {
  head: string;
  tail: string;
} {
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return { head: '', tail: '' };

    const fd = fs.openSync(filePath, 'r');
    try {
      const headLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
      const headBuffer = Buffer.alloc(headLength);
      const headBytesRead = fs.readSync(fd, headBuffer, 0, headLength, 0);
      if (headBytesRead === 0) return { head: '', tail: '' };

      const head = headBuffer.toString('utf-8', 0, headBytesRead);

      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE);
      let tail = head;
      if (tailOffset > 0) {
        const tailLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
        const tailBuffer = Buffer.alloc(tailLength);
        const tailBytesRead = fs.readSync(
          fd,
          tailBuffer,
          0,
          tailLength,
          tailOffset,
        );
        tail = tailBuffer.toString('utf-8', 0, tailBytesRead);
      }

      return { head, tail };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { head: '', tail: '' };
  }
}

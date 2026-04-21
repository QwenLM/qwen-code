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
// File I/O — tail-first scan with full-file fallback
// ---------------------------------------------------------------------------

/**
 * Reads a JSON string field value from a JSONL file, returning the latest
 * occurrence (last in file order).
 *
 * Two-phase strategy:
 *   1. Scan the last LITE_READ_BUF_SIZE bytes of the file; if the field is
 *      present, return it immediately. This is the common path because
 *      ChatRecordingService.finalize() re-appends metadata records to EOF
 *      on every session lifecycle event, keeping the latest title near the
 *      end of the file.
 *   2. If the tail window has no match, stream the entire file in chunks
 *      and return the last hit. This guarantees we never miss a record that
 *      landed between the head and tail windows in a large file — a blind
 *      spot the previous head+tail approach had.
 *
 * Phase 2 is a full-file scan and is intentionally slower; it is only paid
 * when Phase 1 misses.
 *
 * Returns `undefined` on any I/O error or when the field is not found.
 *
 * @param lineContains Optional substring that must appear on the same line
 *   as the matched field. See {@link extractLastJsonStringField}.
 */
export function readLastJsonStringFieldSync(
  filePath: string,
  key: string,
  lineContains?: string,
): string | undefined {
  let fd: number | undefined;
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return undefined;

    fd = fs.openSync(filePath, 'r');

    // Phase 1: tail window — fast path.
    const tailLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
    const tailOffset = fileSize - tailLength;
    const tailBuffer = Buffer.alloc(tailLength);
    const tailBytes = fs.readSync(fd, tailBuffer, 0, tailLength, tailOffset);
    if (tailBytes > 0) {
      const tailText = tailBuffer.toString('utf-8', 0, tailBytes);
      const tailHit = extractLastJsonStringField(tailText, key, lineContains);
      if (tailHit !== undefined) {
        return tailHit;
      }
    }

    // If the whole file already fit in the tail window, there is nothing left
    // to scan.
    if (tailOffset === 0) return undefined;

    // Phase 2: stream the whole file and return the last hit. Scanning from
    // offset 0 (rather than [0, tailOffset)) avoids the edge case where a
    // single record straddles the Phase 1/Phase 2 boundary — duplicate work
    // on the tail bytes is harmless because we only care about the final
    // match.
    let lastHit: string | undefined;
    let readOffset = 0;
    let carry = '';
    while (readOffset < fileSize) {
      const toRead = Math.min(LITE_READ_BUF_SIZE, fileSize - readOffset);
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, readOffset);
      if (bytesRead === 0) break;
      readOffset += bytesRead;

      const chunk = carry + buf.toString('utf-8', 0, bytesRead);
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline < 0) {
        // No newline yet — the entire chunk is a partial line; keep carrying.
        carry = chunk;
        continue;
      }

      const complete = chunk.slice(0, lastNewline + 1);
      carry = chunk.slice(lastNewline + 1);

      const hit = extractLastJsonStringField(complete, key, lineContains);
      if (hit !== undefined) lastHit = hit;
    }

    // Final trailing line without a newline terminator.
    if (carry) {
      const hit = extractLastJsonStringField(carry, key, lineContains);
      if (hit !== undefined) lastHit = hit;
    }

    return lastHit;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: we already have our result (or decided there is none)
      }
    }
  }
}

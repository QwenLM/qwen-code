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

/**
 * Maximum size (bytes) we'll scan in the Phase-2 full-file fallback. Tail-
 * read fast path covers the realistic case (metadata is re-appended on every
 * session lifecycle event). A pathological / corrupt session file that's
 * tens of GB should NOT block the picker for minutes while we scan it all.
 * The session picker renders on the main event loop, so blocking I/O here
 * freezes the UI.
 */
export const MAX_FULL_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Flags used when opening session files for metadata reads. `O_NOFOLLOW`
 * refuses to follow symlinks — defense in depth so a symlink planted in
 * `~/.qwen/tmp/<hash>/chats/` (by another local user or an extension with
 * filesystem access) can't redirect a metadata read to an unrelated file.
 * Falls back to plain read-only when the flag isn't available (e.g. Windows
 * doesn't expose O_NOFOLLOW; the constant is `undefined` there).
 *
 * Computed lazily so tests that stub out `fs` don't blow up at module-init
 * time trying to read `fs.constants.O_RDONLY`.
 */
function getReadOpenFlags(): number {
  const constants = fs.constants;
  if (!constants) return 0;
  return (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0);
}

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
 * Like extractJsonStringField but finds the LAST well-formed occurrence of
 * `primaryKey` and returns every `otherKeys` value extracted from THAT SAME
 * line. Two separate `extractLastJsonStringField` calls can land on different
 * records when an older line contains only one of the fields — this function
 * guarantees the returned fields all come from the same record.
 *
 * Validation: a primary-key match counts only when its string value has a
 * proper closing quote. A crash-truncated trailing record (`"customTitle":"x`
 * with no closing `"`) is ignored — otherwise it could "win" the latest-match
 * race and cause the function to extract secondaries from a partial line
 * where they don't appear.
 *
 * When `lineContains` is provided, only lines containing that substring are
 * considered matches (same semantics as the single-field version).
 */
export function extractLastJsonStringFields(
  text: string,
  primaryKey: string,
  otherKeys: string[],
  lineContains?: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { [primaryKey]: undefined };
  for (const k of otherKeys) out[k] = undefined;

  const patterns = [`"${primaryKey}":"`, `"${primaryKey}": "`];

  let bestPrimaryValue: string | undefined;
  let bestLineStart = -1;
  let bestLineEnd = -1;
  let bestOffset = -1;

  for (const pattern of patterns) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(pattern, searchFrom);
      if (idx < 0) break;
      searchFrom = idx + pattern.length;

      // Line-contains filter first (cheap)
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const eol = text.indexOf('\n', idx);
      const lineEnd = eol < 0 ? text.length : eol;
      if (lineContains) {
        const line = text.slice(lineStart, lineEnd);
        if (!line.includes(lineContains)) continue;
      }

      // Validate the value: walk to a non-escaped closing quote. A truncated
      // trailing write (no closing quote before EOF) is rejected — this is
      // the guard that keeps crash-recovery safe.
      const valueStart = idx + pattern.length;
      let i = valueStart;
      let terminated = false;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          terminated = true;
          break;
        }
        i++;
      }
      if (!terminated) continue;

      // We accept this match; keep it if it's the latest so far.
      if (idx > bestOffset) {
        bestOffset = idx;
        bestLineStart = lineStart;
        bestLineEnd = lineEnd;
        bestPrimaryValue = unescapeJsonString(text.slice(valueStart, i));
      }
    }
  }

  if (bestOffset < 0) return out;
  out[primaryKey] = bestPrimaryValue;
  const line = text.slice(bestLineStart, bestLineEnd);
  for (const k of otherKeys) {
    out[k] = extractJsonStringField(line, k);
  }
  return out;
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

    fd = fs.openSync(filePath, getReadOpenFlags());

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

    // Phase 2: stream the file up to MAX_FULL_SCAN_BYTES and return the last
    // hit. Scanning from offset 0 (rather than [0, tailOffset)) avoids the
    // edge case where a single record straddles the Phase 1/Phase 2 boundary
    // — duplicate work on the tail bytes is harmless because we only care
    // about the final match. The hard cap bounds worst-case latency for
    // pathologically large session files (which would freeze the picker).
    let lastHit: string | undefined;
    let readOffset = 0;
    let carry = '';
    const scanLimit = Math.min(fileSize, MAX_FULL_SCAN_BYTES);
    while (readOffset < scanLimit) {
      const toRead = Math.min(LITE_READ_BUF_SIZE, scanLimit - readOffset);
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

/**
 * Like {@link readLastJsonStringFieldSync} but extracts multiple fields from
 * the same matching line atomically (single file scan, consistent pair).
 *
 * The primary key determines the "winning" line (latest occurrence on a line
 * that also contains `lineContains`). Every other requested field is pulled
 * from that same line — never from an earlier or later record — so callers
 * get a consistent record snapshot. Useful when a record pairs a payload
 * field with its metadata (e.g. `customTitle` + `titleSource`).
 *
 * Missing fields (primary or secondary) appear in the returned object with
 * value `undefined`. I/O errors yield `undefined` for every key.
 */
export function readLastJsonStringFieldsSync(
  filePath: string,
  primaryKey: string,
  otherKeys: string[],
  lineContains?: string,
): Record<string, string | undefined> {
  const emptyResult: Record<string, string | undefined> = {};
  emptyResult[primaryKey] = undefined;
  for (const k of otherKeys) emptyResult[k] = undefined;

  let fd: number | undefined;
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return emptyResult;

    fd = fs.openSync(filePath, getReadOpenFlags());

    // Phase 1: tail window fast path.
    const tailLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
    const tailOffset = fileSize - tailLength;
    const tailBuffer = Buffer.alloc(tailLength);
    const tailBytes = fs.readSync(fd, tailBuffer, 0, tailLength, tailOffset);
    if (tailBytes > 0) {
      const tailText = tailBuffer.toString('utf-8', 0, tailBytes);
      const hit = extractLastJsonStringFields(
        tailText,
        primaryKey,
        otherKeys,
        lineContains,
      );
      if (hit[primaryKey] !== undefined) return hit;
    }

    if (tailOffset === 0) return emptyResult;

    // Phase 2: stream the file up to MAX_FULL_SCAN_BYTES, track the latest
    // match. Hard cap bounds worst-case latency on pathological files.
    let latest: Record<string, string | undefined> | undefined;
    let readOffset = 0;
    let carry = '';
    const scanLimit = Math.min(fileSize, MAX_FULL_SCAN_BYTES);
    while (readOffset < scanLimit) {
      const toRead = Math.min(LITE_READ_BUF_SIZE, scanLimit - readOffset);
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, readOffset);
      if (bytesRead === 0) break;
      readOffset += bytesRead;
      const chunk = carry + buf.toString('utf-8', 0, bytesRead);
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline < 0) {
        carry = chunk;
        continue;
      }
      const complete = chunk.slice(0, lastNewline + 1);
      carry = chunk.slice(lastNewline + 1);

      const hit = extractLastJsonStringFields(
        complete,
        primaryKey,
        otherKeys,
        lineContains,
      );
      if (hit[primaryKey] !== undefined) latest = hit;
    }
    if (carry) {
      const hit = extractLastJsonStringFields(
        carry,
        primaryKey,
        otherKeys,
        lineContains,
      );
      if (hit[primaryKey] !== undefined) latest = hit;
    }

    return latest ?? emptyResult;
  } catch {
    return emptyResult;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

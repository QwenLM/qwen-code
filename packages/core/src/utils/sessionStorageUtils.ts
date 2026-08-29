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
import { _recoverObjectsFromLine } from './jsonl-utils.js';

/** Size of the head/tail buffer for lite metadata reads (64KB). */
export const LITE_READ_BUF_SIZE = 64 * 1024;

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

function readLatestTailIfGrown(
  fd: number,
  previousSize: number,
  buffer: Buffer,
): { text: string; size: number } | undefined {
  const currentSize = fs.fstatSync(fd).size;
  if (currentSize <= previousSize) return undefined;

  const tailLength = Math.min(currentSize, LITE_READ_BUF_SIZE);
  const tailOffset = currentSize - tailLength;
  const tailBytes = fs.readSync(fd, buffer, 0, tailLength, tailOffset);
  if (tailBytes <= 0) return undefined;

  return {
    text: buffer.toString('utf-8', 0, tailBytes),
    size: currentSize,
  };
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

interface JsonStringFieldMatch {
  keyOffset: number;
  valueStart: number;
  valueEnd: number;
  nextSearchOffset: number;
}

function isInlineJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function findNextJsonStringField(
  text: string,
  key: string,
  searchFrom: number,
): JsonStringFieldMatch | undefined {
  const quotedKey = `"${key}"`;
  let keyOffset = text.indexOf(quotedKey, searchFrom);

  fieldSearch: while (keyOffset >= 0) {
    let i = keyOffset + quotedKey.length;
    while (isInlineJsonWhitespace(text[i])) i++;

    if (text[i] !== ':') {
      keyOffset = text.indexOf(quotedKey, keyOffset + 1);
      continue;
    }

    i++;
    while (isInlineJsonWhitespace(text[i])) i++;

    if (text[i] !== '"') {
      keyOffset = text.indexOf(quotedKey, keyOffset + 1);
      continue;
    }

    const valueStart = i + 1;
    i = valueStart;
    while (i < text.length) {
      if (text[i] === '\n' || text[i] === '\r') {
        keyOffset = text.indexOf(quotedKey, keyOffset + 1);
        continue fieldSearch;
      }
      if (text[i] === '\\') {
        const nextChar = text[i + 1];
        if (nextChar === undefined || nextChar === '\n' || nextChar === '\r') {
          keyOffset = text.indexOf(quotedKey, keyOffset + 1);
          continue fieldSearch;
        }
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        return {
          keyOffset,
          valueStart,
          valueEnd: i,
          nextSearchOffset: i + 1,
        };
      }
      i++;
    }

    return undefined;
  }

  return undefined;
}

/**
 * Extracts a simple JSON string field value from raw text without full parsing.
 * Allows same-line spaces/tabs around the colon.
 * Returns the first match, or undefined if not found.
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const match = findNextJsonStringField(text, key, 0);
  return match
    ? unescapeJsonString(text.slice(match.valueStart, match.valueEnd))
    : undefined;
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

  let bestPrimaryValue: string | undefined;
  let bestLineStart = -1;
  let bestLineEnd = -1;
  let bestOffset = -1;

  let searchFrom = 0;
  while (true) {
    const match = findNextJsonStringField(text, primaryKey, searchFrom);
    if (!match) break;
    searchFrom = match.nextSearchOffset;

    // Keep metadata matches on the same JSONL record.
    const lineStart = text.lastIndexOf('\n', match.keyOffset) + 1;
    const eol = text.indexOf('\n', match.keyOffset);
    const lineEnd = eol < 0 ? text.length : eol;
    if (lineContains) {
      const line = text.slice(lineStart, lineEnd);
      if (!line.includes(lineContains)) continue;
    }

    // We accept this match; keep it if it's the latest so far.
    if (match.keyOffset > bestOffset) {
      bestOffset = match.keyOffset;
      bestLineStart = lineStart;
      bestLineEnd = lineEnd;
      bestPrimaryValue = unescapeJsonString(
        text.slice(match.valueStart, match.valueEnd),
      );
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
 * The outcome of scanning for a field on the LAST line carrying a marker.
 * Distinguishes "the newest record omits this field" from "no such record
 * was in view" — a difference `extractLastJsonStringField` erases, because
 * it keeps looking at older lines until some line does carry the field.
 */
export interface LastMatchingLineField {
  /** A line containing the marker was found in the scanned text. */
  matched: boolean;
  /** The field's value on that line — `undefined` when the line omits it. */
  value: string | undefined;
}

export type MatchingRecordFieldReader = (
  record: unknown,
) => LastMatchingLineField;

/**
 * Outcome of {@link readLastMatchingLineFieldSync}. A miss is not one thing:
 * only `absent` proves the record does not exist, and callers that would
 * otherwise fall back to a weaker source need to tell the three apart.
 */
export type LastMatchingLineScan =
  | { matched: true; value: string | undefined }
  | {
      matched: false;
      /**
       * - `absent` — the whole file was scanned and carries no such line.
       * - `out-of-window` — the file is larger than the scan window and the
       *   line is not in the tail; a newer record may exist out of reach.
       * - `unreadable` — the file could not be stat'ed, opened, or read.
       */
      reason: 'absent' | 'out-of-window' | 'unreadable';
    };

/**
 * Reads `key` from the LAST line containing `lineContains`, instead of the
 * last occurrence of `key` across every matching line.
 *
 * For lifecycle records this is the only correct reading. A record set where
 * a later entry legitimately drops the field — a `goal_state` record for a
 * cleared Goal carries `goal: null` and no `objective` — must not be read as
 * "the field is still whatever the previous record said". `matched: true`
 * with `value: undefined` is that answer, and it is different from
 * `matched: false`, which means no such record was in view at all.
 * A crash-truncated line that starts the field but never closes its string is
 * skipped; a well-formed matching line that omits the field remains decisive.
 *
 * A leading partial line contributes only a complete suffix record. Its
 * truncated outer record cannot win, but a later record glued onto that
 * prefix remains recoverable.
 *
 * `readRecordField` lets lifecycle callers interpret complete candidates
 * with their authoritative parser. When that parser is present, a malformed
 * newest marker is decisive and cannot expose an older lifecycle value.
 */
export function extractJsonStringFieldFromLastMatchingLine(
  text: string,
  lineContains: string,
  key: string,
  wholeLines = false,
  recordMatches?: (record: unknown) => boolean,
  readRecordField?: MatchingRecordFieldReader,
): LastMatchingLineField {
  const readParsedRecord = (
    parsed: unknown,
    record: string,
  ): LastMatchingLineField | undefined => {
    if (readRecordField) {
      const field = readRecordField(parsed);
      return field.matched ? field : undefined;
    }
    if (recordMatches && !recordMatches(parsed)) return undefined;
    return {
      matched: true,
      value: extractJsonStringField(record, key),
    };
  };

  let searchFrom = text.length;
  while (searchFrom > 0) {
    const hit = text.lastIndexOf(lineContains, searchFrom - 1);
    if (hit < 0) break;
    const lineStart = text.lastIndexOf('\n', hit) + 1;
    const eol = text.indexOf('\n', hit);
    const line = text.slice(lineStart, eol < 0 ? text.length : eol);
    const leadingPartial = !wholeLines && lineStart === 0;
    if (!leadingPartial) {
      try {
        const parsed = JSON.parse(line);
        const field = readParsedRecord(parsed, line);
        if (field) return field;
        searchFrom = lineStart;
        continue;
      } catch {
        // Recover complete records from a malformed physical line below.
      }
    }

    let markerOffset = line.lastIndexOf(lineContains);
    const latestMarkerOffset = markerOffset;
    while (markerOffset >= 0) {
      const recordStart = line.lastIndexOf('{', markerOffset);
      if (recordStart >= 0 && line[recordStart - 1] !== ':') {
        try {
          const parsed = JSON.parse(line.slice(recordStart));
          const record = JSON.stringify(parsed);
          if (record.includes(lineContains)) {
            const field = readParsedRecord(parsed, record);
            if (field) return field;
          }
        } catch {
          // The marker does not belong to a complete suffix record.
        }
      }
      markerOffset =
        markerOffset === 0
          ? -1
          : line.lastIndexOf(lineContains, markerOffset - 1);
    }

    if (!leadingPartial) {
      const recovered = _recoverObjectsFromLine<unknown>(line);
      for (let i = recovered.length - 1; i >= 0; i--) {
        const parsed = recovered[i];
        const record = JSON.stringify(parsed);
        if (record.includes(lineContains)) {
          if (readRecordField) {
            const recordOffset = line.lastIndexOf(record);
            if (
              recordOffset < 0 ||
              recordOffset + record.lastIndexOf(lineContains) !==
                latestMarkerOffset
            ) {
              continue;
            }
          }
          const field = readParsedRecord(parsed, record);
          if (field) return field;
        }
      }
    }

    if (readRecordField) {
      return { matched: true, value: undefined };
    }

    searchFrom = lineStart;
  }
  return { matched: false, value: undefined };
}

/**
 * File-level counterpart of
 * {@link extractJsonStringFieldFromLastMatchingLine}: reads the marker's
 * last line from the tail window only.
 *
 * There is deliberately no head-window fallback. {@link
 * readLastJsonStringFieldSync} can fall back because a title read only ever
 * gets *staler*, never wrong: the head copy of a title is a title the
 * session really had. A lifecycle field is different — a head-window hit on
 * a file larger than the window means an unknown number of later records,
 * including the one that cleared the state, are unreadable, so the value
 * cannot be trusted. `reason: 'absent'` reports that the scan saw the whole
 * file, which is what lets a caller tell "no such record exists" from "no
 * such record was reachable".
 *
 * Worst-case I/O: 1 × LITE_READ_BUF_SIZE per file (plus one re-read when a
 * concurrent writer grows the file, matching the sibling reader's bound).
 */
export function readLastMatchingLineFieldSync(
  filePath: string,
  lineContains: string,
  key: string,
  scratchBuffer?: Buffer,
  recordMatches?: (record: unknown) => boolean,
  readRecordField?: MatchingRecordFieldReader,
): LastMatchingLineScan {
  let fd: number | undefined;
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return { matched: false, reason: 'absent' };

    fd = fs.openSync(filePath, getReadOpenFlags());
    const buffer =
      scratchBuffer && scratchBuffer.length >= LITE_READ_BUF_SIZE
        ? scratchBuffer
        : Buffer.alloc(LITE_READ_BUF_SIZE);

    const scanTail = (tail: {
      text: string;
      size: number;
    }): LastMatchingLineScan => {
      const hit = extractJsonStringFieldFromLastMatchingLine(
        tail.text,
        lineContains,
        key,
        tail.size <= LITE_READ_BUF_SIZE,
        recordMatches,
        readRecordField,
      );
      if (hit.matched) return { matched: true, value: hit.value };
      return tail.size <= LITE_READ_BUF_SIZE
        ? { matched: false, reason: 'absent' }
        : { matched: false, reason: 'out-of-window' };
    };

    const firstTail = readLatestTailIfGrown(fd, 0, buffer);
    if (!firstTail) return { matched: false, reason: 'unreadable' };
    const fromTail = scanTail(firstTail);
    if (fromTail.matched) return fromTail;

    // A concurrent writer may have appended a newer lifecycle record between
    // the stat and the read; one bounded re-read catches it.
    const grownTail = readLatestTailIfGrown(fd, firstTail.size, buffer);
    if (grownTail) {
      const fromGrownTail = scanTail(grownTail);
      if (fromGrownTail.matched) return fromGrownTail;
      if (
        fromTail.reason === 'absent' &&
        fromGrownTail.reason === 'out-of-window' &&
        grownTail.size - firstTail.size <= LITE_READ_BUF_SIZE
      ) {
        return { matched: false, reason: 'absent' };
      }
      return fromGrownTail;
    }

    return fromTail;
  } catch {
    return { matched: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: the result is already decided
      }
    }
  }
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
  let lastValue: string | undefined;
  let lastOffset = -1;
  let searchFrom = 0;
  while (true) {
    const match = findNextJsonStringField(text, key, searchFrom);
    if (!match) break;
    searchFrom = match.nextSearchOffset;

    // If lineContains is specified, verify the current line contains it
    if (lineContains) {
      const lineStart = text.lastIndexOf('\n', match.keyOffset) + 1;
      const lineEnd = text.indexOf('\n', match.keyOffset);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
      if (!line.includes(lineContains)) {
        continue;
      }
    }

    if (match.keyOffset > lastOffset) {
      lastValue = unescapeJsonString(
        text.slice(match.valueStart, match.valueEnd),
      );
      lastOffset = match.keyOffset;
    }
  }
  return lastValue;
}

// ---------------------------------------------------------------------------
// File I/O — tail-first scan with head-window fallback
// ---------------------------------------------------------------------------

/**
 * Reads a JSON string field value from a JSONL file, returning the latest
 * occurrence (last in file order).
 *
 * Two bounded windows, never a full-file scan:
 *   1. Scan the last LITE_READ_BUF_SIZE bytes of the file. This is the
 *      common path because `ChatRecordingService` re-anchors metadata
 *      records to EOF every 32KB (the title re-anchor threshold, below
 *      the tail-window size) and on every lifecycle event (turn end,
 *      session switch, shutdown, resume).
 *   2. If the tail has no match, scan the FIRST LITE_READ_BUF_SIZE bytes
 *      of the file. The metadata record set on a brand-new session lands
 *      near offset 0 before any user/assistant turns push it forward, so
 *      the head window catches the legacy case where a session was
 *      created on a build prior to the re-anchor invariant.
 *
 * If neither window contains the field, returns `undefined`. Callers
 * that need a stronger guarantee must arrange for the writer to
 * maintain the head-or-tail invariant — by design we never trade
 * picker latency for completeness here.
 *
 * Normal worst-case I/O: 2 × LITE_READ_BUF_SIZE = 128KB per file.
 * If a concurrent writer grows the file between the initial stat and a
 * tail miss, we do one extra latest-tail read to catch a fresh EOF anchor
 * while preserving a fixed retry bound.
 *
 * @param lineContains Optional substring that must appear on the same line
 *   as the matched field. See {@link extractLastJsonStringField}.
 * @param scratchBuffer Optional caller-owned Buffer reused across many
 *   files in the same listing pass. Must be at least
 *   {@link LITE_READ_BUF_SIZE} bytes; only the leading `length` bytes
 *   are touched and decoded each call, so old data past the read region
 *   is never observed (we never read past the bytes we just wrote).
 *   The same buffer backs both the tail and head reads — they happen
 *   sequentially, so reuse is safe. When omitted, the function
 *   allocates per-call — preserves the simple call site for one-off
 *   reads (rename, single-session lookup) while letting `listSessions`
 *   skip the per-file alloc.
 */
export function readLastJsonStringFieldSync(
  filePath: string,
  key: string,
  lineContains?: string,
  scratchBuffer?: Buffer,
): string | undefined {
  let fd: number | undefined;
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return undefined;

    fd = fs.openSync(filePath, getReadOpenFlags());

    // Phase 1: tail window — fast path. This is where every well-behaved
    // session keeps its current title (ChatRecordingService re-anchors
    // it within the tail window).
    const tailLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
    const tailOffset = fileSize - tailLength;
    const buffer =
      scratchBuffer && scratchBuffer.length >= LITE_READ_BUF_SIZE
        ? scratchBuffer
        : Buffer.alloc(LITE_READ_BUF_SIZE);
    const tailBytes = fs.readSync(fd, buffer, 0, tailLength, tailOffset);
    if (tailBytes > 0) {
      const tailText = buffer.toString('utf-8', 0, tailBytes);
      const tailHit = extractLastJsonStringField(tailText, key, lineContains);
      if (tailHit !== undefined) {
        return tailHit;
      }
    }

    const grownTail = readLatestTailIfGrown(fd, fileSize, buffer);
    if (grownTail !== undefined) {
      const grownHit = extractLastJsonStringField(
        grownTail.text,
        key,
        lineContains,
      );
      if (grownHit !== undefined) {
        return grownHit;
      }
    }

    // If the whole file fit in the tail window, head == tail; nothing more
    // to do.
    if (tailOffset === 0) return undefined;

    // Phase 2: head window — fallback for legacy sessions and the
    // edge case where the title got written near offset 0 and the
    // re-anchor invariant hasn't kicked in yet (e.g. a session
    // recorded by a build that predates the re-anchor logic).
    const headLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
    const headBytes = fs.readSync(fd, buffer, 0, headLength, 0);
    if (headBytes > 0) {
      const rawHead = buffer.toString('utf-8', 0, headBytes);
      // Drop the trailing partial line: a record that started inside the
      // head window but whose closing quote lives past 64KB would be
      // silently skipped by the extractor (no terminating `"` before EOS).
      // For boundary-straddling pre-invariant records, that means the title
      // is lost. Truncating at the last newline keeps us on whole lines.
      const headText =
        headBytes < fileSize
          ? rawHead.slice(0, rawHead.lastIndexOf('\n') + 1)
          : rawHead;
      const headHit = extractLastJsonStringField(headText, key, lineContains);
      if (headHit !== undefined) {
        return headHit;
      }
    }

    return undefined;
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
  scratchBuffer?: Buffer,
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

    // Phase 1: tail window fast path. See the single-field variant for
    // the head-or-tail invariant and buffer-pool semantics.
    const tailLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
    const tailOffset = fileSize - tailLength;
    const buffer =
      scratchBuffer && scratchBuffer.length >= LITE_READ_BUF_SIZE
        ? scratchBuffer
        : Buffer.alloc(LITE_READ_BUF_SIZE);
    const tailBytes = fs.readSync(fd, buffer, 0, tailLength, tailOffset);
    if (tailBytes > 0) {
      const tailText = buffer.toString('utf-8', 0, tailBytes);
      const hit = extractLastJsonStringFields(
        tailText,
        primaryKey,
        otherKeys,
        lineContains,
      );
      if (hit[primaryKey] !== undefined) return hit;
    }

    const grownTail = readLatestTailIfGrown(fd, fileSize, buffer);
    if (grownTail !== undefined) {
      const hit = extractLastJsonStringFields(
        grownTail.text,
        primaryKey,
        otherKeys,
        lineContains,
      );
      if (hit[primaryKey] !== undefined) return hit;
    }

    if (tailOffset === 0) return emptyResult;

    // Phase 2: head window — fallback for legacy sessions written
    // before the title-anchor invariant existed.
    const headLength = Math.min(fileSize, LITE_READ_BUF_SIZE);
    const headBytes = fs.readSync(fd, buffer, 0, headLength, 0);
    if (headBytes > 0) {
      const rawHead = buffer.toString('utf-8', 0, headBytes);
      // Truncate to whole lines — see the single-field variant for why.
      const headText =
        headBytes < fileSize
          ? rawHead.slice(0, rawHead.lastIndexOf('\n') + 1)
          : rawHead;
      const hit = extractLastJsonStringFields(
        headText,
        primaryKey,
        otherKeys,
        lineContains,
      );
      if (hit[primaryKey] !== undefined) return hit;
    }

    return emptyResult;
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

export function readSessionTitleInfoFromFileSync(
  filePath: string,
  scratchBuffer?: Buffer,
): { title?: string; source?: 'auto' | 'manual' } {
  const hit = readLastJsonStringFieldsSync(
    filePath,
    'customTitle',
    ['titleSource'],
    '"subtype":"custom_title"',
    scratchBuffer,
  );
  const title = hit['customTitle'];
  if (!title) return {};
  const rawSource = hit['titleSource'];
  const source =
    rawSource === 'auto' || rawSource === 'manual' ? rawSource : undefined;
  return { title, source };
}

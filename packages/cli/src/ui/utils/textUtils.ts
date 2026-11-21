/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import stripAnsi from 'strip-ansi';
import ansiRegex from 'ansi-regex';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';

/**
 * Calculates the maximum *visual* width (terminal cells) of a multi-line
 * ASCII art string. Uses `string-width` semantics via `getCachedStringWidth`
 * so CJK fullwidth characters count as 2 cells and emoji are sized
 * correctly — `.length` would undercount these and let oversized art slip
 * past the width budget that `pickAsciiArtTier` applies.
 * @param asciiArt The ASCII art string.
 * @returns The widest line's terminal-cell width.
 */
export const getAsciiArtWidth = (asciiArt: string): number => {
  if (!asciiArt) {
    return 0;
  }
  const lines = asciiArt.split('\n');
  return Math.max(...lines.map((line) => getCachedStringWidth(line)));
};

/*
 * -------------------------------------------------------------------------
 *  Unicode‑aware helpers (work at the code‑point level rather than UTF‑16
 *  code units so that surrogate‑pair emoji count as one "column".)
 * ---------------------------------------------------------------------- */

// Cache for code points to reduce GC pressure
const codePointsCache = new Map<string, string[]>();
const MAX_STRING_LENGTH_TO_CACHE = 1000;

/** Max entries in each text cache before eviction */
export const TEXT_CACHE_MAX_ENTRIES = 500;

/**
 * Evict oldest entry if a cache reaches the soft cap.
 * Map iteration order is insertion order, so the first key is the oldest.
 */
function evictOldestTextCacheEntry<K, V>(cache: Map<K, V>): void {
  if (cache.size >= TEXT_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
}

export function toCodePoints(str: string): string[] {
  // ASCII fast path - check if all chars are ASCII (0-127)
  let isAscii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) {
    return str.split('');
  }

  // Cache short strings
  if (str.length <= MAX_STRING_LENGTH_TO_CACHE) {
    const cached = codePointsCache.get(str);
    if (cached) {
      return cached;
    }
  }

  const result = Array.from(str);

  // Cache result (bounded; oldest entry evicted at the cap)
  if (str.length <= MAX_STRING_LENGTH_TO_CACHE) {
    evictOldestTextCacheEntry(codePointsCache);
    codePointsCache.set(str, result);
  }

  return result;
}

export function cpLen(str: string): number {
  return toCodePoints(str).length;
}

export function cpSlice(str: string, start: number, end?: number): string {
  // Slice by code‑point indices and re‑join.
  const arr = toCodePoints(str).slice(start, end);
  return arr.join('');
}

/**
 * Strip characters that can break terminal rendering.
 *
 * Uses Node.js built-in stripVTControlCharacters to handle VT sequences,
 * then filters remaining control characters that can disrupt display.
 *
 * Characters stripped:
 * - ANSI escape sequences (via strip-ansi)
 * - VT control sequences (via Node.js util.stripVTControlCharacters)
 * - C0 control chars (0x00-0x1F) except TAB/CR/LF which are handled elsewhere
 * - C1 control chars (0x80-0x9F) that can cause display issues
 *
 * Characters preserved:
 * - All printable Unicode including emojis
 * - DEL (0x7F) - handled functionally by applyOperations, not a display issue
 * - TAB (0x09) - needed for pasted tab-separated data (e.g. from spreadsheets)
 * - CR/LF (0x0D/0x0A) - needed for line breaks
 */
export function stripUnsafeCharacters(str: string): string {
  const strippedAnsi = stripAnsi(str);
  const strippedVT = stripVTControlCharacters(strippedAnsi);

  return toCodePoints(strippedVT)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;

      // Preserve TAB/CR/LF for line handling and pasted tabular data
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

      // Remove C0 control chars (except CR/LF) that can break display
      // Examples: BELL(0x07) makes noise, BS(0x08) moves cursor, VT(0x0B), FF(0x0C)
      if (code >= 0x00 && code <= 0x1f) return false;

      // Remove C1 control chars (0x80-0x9f) - legacy 8-bit control codes
      if (code >= 0x80 && code <= 0x9f) return false;

      // Preserve DEL (0x7f) - it's handled functionally by applyOperations as backspace
      // and doesn't cause rendering issues when displayed

      // Preserve all other characters including Unicode/emojis
      return true;
    })
    .join('');
}

// String width caching for performance optimization
const stringWidthCache = new Map<string, number>();

/**
 * Cached version of stringWidth function for better performance.
 * Bounded with oldest-entry eviction so long sessions cannot grow it
 * without limit.
 */
export const getCachedStringWidth = (str: string): number => {
  // ASCII printable chars have width 1
  if (/^[\x20-\x7E]*$/.test(str)) {
    return str.length;
  }

  if (str.length > MAX_STRING_LENGTH_TO_CACHE) {
    return stringWidth(str);
  }

  if (stringWidthCache.has(str)) {
    return stringWidthCache.get(str)!;
  }

  const width = stringWidth(str);
  evictOldestTextCacheEntry(stringWidthCache);
  stringWidthCache.set(str, width);

  return width;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * The first `maxWidth` display columns of `text`, with no ellipsis.
 * Grapheme- and width-aware (via `getCachedStringWidth`) so CJK text — two
 * cells per character — is bounded correctly, and a double-width cell that
 * would straddle the budget is dropped whole. For the case where the clipped
 * text is followed by something that owns the next column.
 */
export function clipToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (getCachedStringWidth(text) <= maxWidth) {
    return text;
  }
  let width = 0;
  let result = '';
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = getCachedStringWidth(segment);
    if (width + segmentWidth > maxWidth) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }
  return result;
}

/**
 * Truncate text to a display width (terminal cells), appending an ellipsis
 * when clipped. The clip is `clipToWidth` against the budget the ellipsis
 * leaves, so the boundary rule lives in exactly one place. Returns an empty
 * string when even the ellipsis would overflow the budget.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (getCachedStringWidth(text) <= maxWidth) {
    return text;
  }
  const ellipsis = '…';
  const budget = Math.max(0, maxWidth - getCachedStringWidth(ellipsis));
  return `${clipToWidth(text, budget)}${ellipsis}`;
}

export interface VisualHeightSlice {
  text: string;
  hiddenLinesCount: number;
}

interface SliceTextByVisualHeightOptions {
  minHeight?: number;
  reservedRows?: number;
  overflowDirection?: 'top' | 'bottom';
}

/**
 * Bounds text by terminal visual rows before it reaches Ink/Yoga layout.
 *
 * Explicit newlines and soft wraps caused by narrow terminals both count as
 * visual rows. `overflowDirection: "top"` keeps the newest tail, which is
 * useful for streaming logs; `"bottom"` keeps the beginning, which is useful
 * for task prompts.
 */
export function sliceTextByVisualHeight(
  text: string,
  maxHeight: number | undefined,
  maxWidth: number,
  options: SliceTextByVisualHeightOptions = {},
): VisualHeightSlice {
  if (maxHeight === undefined) {
    return { text, hiddenLinesCount: 0 };
  }

  const targetMaxHeight = Math.max(
    Math.round(maxHeight),
    options.minHeight ?? 1,
  );
  const visibleContentHeight = Math.max(
    1,
    targetMaxHeight - (options.reservedRows ?? 0),
  );
  const visualWidth = Math.max(1, Math.floor(maxWidth));
  const overflowDirection = options.overflowDirection ?? 'top';
  const visibleLines: string[] = [];
  let visualLineCount = 0;
  let currentLine = '';
  let currentLineWidth = 0;

  const appendVisibleLine = (line: string) => {
    visualLineCount += 1;

    if (overflowDirection === 'bottom') {
      if (visibleLines.length < visibleContentHeight) {
        visibleLines.push(line);
      }
      return;
    }

    visibleLines.push(line);
    if (visibleLines.length > visibleContentHeight) {
      visibleLines.shift();
    }
  };

  const flushCurrentLine = () => {
    appendVisibleLine(currentLine);
    currentLine = '';
    currentLineWidth = 0;
  };

  for (const char of toCodePoints(text)) {
    if (char === '\n') {
      flushCurrentLine();
      continue;
    }

    const charWidth = Math.max(getCachedStringWidth(char), 1);
    if (currentLineWidth > 0 && currentLineWidth + charWidth > visualWidth) {
      flushCurrentLine();
    }

    currentLine += char;
    currentLineWidth += charWidth;
  }

  flushCurrentLine();

  // Compare against `visibleContentHeight`, not `targetMaxHeight`: when a
  // caller asks us to reserve rows for a separate footer/header (e.g. the
  // "...N task lines hidden..." line), the budget for the actual content is
  // `visibleContentHeight` and exceeding it must still trigger truncation.
  if (visualLineCount <= visibleContentHeight) {
    return { text, hiddenLinesCount: 0 };
  }

  return {
    text: visibleLines.join('\n'),
    hiddenLinesCount: visualLineCount - visibleContentHeight,
  };
}

/**
 * Clear the string width cache
 */
export const clearStringWidthCache = (): void => {
  stringWidthCache.clear();
};

/**
 * Report current sizes of the module-level text caches.
 * @internal — only used in tests to verify cache bounds.
 */
export const __getTextUtilsCacheSizes = (): {
  codePoints: number;
  stringWidth: number;
} => ({
  codePoints: codePointsCache.size,
  stringWidth: stringWidthCache.size,
});

const regex = ansiRegex();

// Bare C0 control bytes (plus DEL / C1) that `escapeAnsiCtrlCodes` (ansi-regex)
// leaves untouched because they carry no ESC prefix — BEL \x07, BS \x08,
// VT \x0b, FF \x0c, CR \x0d, SO \x0e, SI \x0f, etc. TAB (\x09) and LF (\x0a)
// are intentionally preserved: they legitimately structure multi-line output.
// eslint-disable-next-line no-control-regex
const BARE_C0_CONTROL_CHARS_REGEX = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Unicode bidirectional override / isolate characters (the "Trojan Source"
// attack class, CVE-2021-42572) that can visually reorder rendered text.
const BIDI_OVERRIDE_CHARS_REGEX = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Full sanitization for raw, untrusted text about to be rendered into a
 * terminal `<Text>` (e.g. tool output in the Ctrl+O transcript, or a caught
 * error message). Three passes: (1) neutralize ESC-prefixed ANSI sequences
 * (alt-screen exit, OSC 52 clipboard, …); (2) strip bare C0/C1 control bytes
 * ansi-regex misses, keeping only TAB/LF; (3) strip bidi override/isolate chars
 * (Trojan Source). Single source of truth so every render site stays aligned.
 */
export function sanitizeTerminalText(value: string): string {
  return escapeAnsiCtrlCodes(value)
    .replace(BARE_C0_CONTROL_CHARS_REGEX, '')
    .replace(BIDI_OVERRIDE_CHARS_REGEX, '');
}

/**
 * `stripUnsafeCharacters` for a run that must paint as one physical row (a
 * completion hint or badge): the same ANSI/VT/C0/C1 strip, then the bidi
 * override/isolate range (Trojan Source) goes too, and the TAB/CR/LF that
 * sanitizer keeps for pasted data flatten to single spaces — a surviving
 * newline paints a second row the caller's width budget never charged.
 */
export function sanitizeTerminalLine(value: string): string {
  return stripUnsafeCharacters(value)
    .replace(BIDI_OVERRIDE_CHARS_REGEX, '')
    .replace(/[\t\r\n]+/g, ' ');
}

/**
 * Caret-notation code for a C0/DEL control byte (0x00-0x1f, 0x7f): the
 * standard `^X` convention (byte XOR 0x40), e.g. BEL (0x07) -> `^G`,
 * ESC (0x1b) -> `^[`, DEL (0x7f) -> `^?`.
 */
function caretNotation(code: number): string {
  return code === 0x7f ? '^?' : '^' + String.fromCharCode(code ^ 0x40);
}

/**
 * `\uXXXX` (4 uppercase hex digits) for a code point on the Basic
 * Multilingual Plane, or `\u{X...}` for one beyond it (astral code points,
 * e.g. U+1D173 MUSICAL SYMBOL BEGIN BEAM, need more than 4 hex digits and
 * have no 4-digit form).
 */
function hexNotation(code: number): string {
  const hex = code.toString(16).toUpperCase();
  return code > 0xffff ? '\\u{' + hex + '}' : '\\u' + hex.padStart(4, '0');
}

/** C1 control bytes (0x80-0x9f, e.g. U+009B, CSI as a single code point):
 * not Default_Ignorable_Code_Point or Cf by Unicode's own classification
 * (they are Cc, Control), so {@link isInvisibleOrFormat} does not see them
 * and this stays a separate, explicit check. */
function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

// Any code point Unicode itself classifies as format (general category Cf)
// or marks Default_Ignorable_Code_Point: bidi overrides/isolates, zero-width
// joiners/spaces, variation selectors, soft hyphen, the tag block, and every
// other "invisible or near-invisible" code point in the standard -- not a
// hand-kept list of the ones a particular review happened to name. A list
// like that is always incomplete (a prior version of this function listed
// five zero-width code points and the bidi range by hand, and still let
// U+2063, U+061C, U+00AD and others straight through). Checked per code
// point without the `g` flag, since the caller already iterates one code
// point at a time.
const DEFAULT_IGNORABLE_OR_FORMAT_REGEX =
  /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

function isInvisibleOrFormat(code: number): boolean {
  return DEFAULT_IGNORABLE_OR_FORMAT_REGEX.test(String.fromCodePoint(code));
}

// Whether sanitizeTerminalLineLosslessWithFlag will itself turn the code
// point at codePoints[i] into a marker (so a literal backslash immediately
// before it, in the source text, must be doubled or the backslash fuses
// with the generated marker into something a different, clean rule could
// also produce).
function willBeReplaced(codePoints: string[], i: number): boolean {
  const code = codePoints[i]?.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x00 && code <= 0x1f) ||
    code === 0x7f ||
    isC1Control(code) ||
    isInvisibleOrFormat(code)
  );
}

// The exact alphabet caretNotation can produce as the character after `^`:
// code ^ 0x40 for code in 0x00-0x1f lands on '@'-'_' (0x40-0x5f), and DEL
// (0x7f) is the special case '?'. Deliberately narrower than "any letter"
// -- `\^foo` in a clean rule must stay untouched, and lowercase 'f' is not
// a shape caretNotation ever emits.
const CARET_MARKER_SECOND_CHAR_REGEX = /^[@A-Z[\\\]^_?]$/;

// Whether the literal text starting at codePoints[i] already spells out
// something indistinguishable from a marker this function generates, even
// though none of it is itself a code point this function would replace:
// a caret pair using caretNotation's real output alphabet (`\^G`, not
// `\^foo`), or an UPPERCASE `\uXXXX` / `\u{X...}` hex run (hexNotation
// always uppercases; `\u00e9` in a clean rule must stay untouched).
function looksLikeGeneratedMarker(codePoints: string[], i: number): boolean {
  const first = codePoints[i];
  if (first === undefined) return false;
  if (first === '^') {
    const second = codePoints[i + 1];
    return second !== undefined && CARET_MARKER_SECOND_CHAR_REGEX.test(second);
  }
  if (first === 'u') {
    const four = codePoints.slice(i + 1, i + 5).join('');
    if (/^[0-9A-F]{4}$/.test(four)) return true;
    if (codePoints[i + 1] === '{') {
      let j = i + 2;
      let hexDigits = 0;
      while (codePoints[j] !== undefined && /^[0-9A-F]$/.test(codePoints[j])) {
        j++;
        hexDigits++;
      }
      return hexDigits > 0 && codePoints[j] === '}';
    }
  }
  return false;
}

// A backslash is doubled only where leaving it alone could make clean,
// legitimate input (a Windows path, a regex) collide with a marker this
// function generates: immediately before a code point this function is
// about to replace (so the generated marker that follows can't fuse with
// an un-doubled backslash already there), or immediately before literal
// text that already spells out this function's own marker alphabet (so a
// real control byte's marker can't collide with a user who typed the same
// characters as plain text). Checked structurally against what the rest of
// this function actually does, not by guessing at surrounding word
// boundaries -- a boundary-based guess previously let a literal `\u2063`
// run into a following digit without doubling, while a real U+2063 in the
// same position rendered identically (R2-4). Any other backslash -- in
// `C:\tools\x.exe`, in `grep \.ts$`, in `grep \^foo`, in `grep \u00e9` (the
// marker alphabet is uppercase-only, so lowercase hex and a non-marker
// letter after `^` both fall through untouched) -- renders byte-identical,
// so "clean input renders identically before and after this function"
// stays true.
function mustDoubleBackslash(
  codePoints: string[],
  backslashIndex: number,
): boolean {
  const next = backslashIndex + 1;
  return (
    willBeReplaced(codePoints, next) ||
    looksLikeGeneratedMarker(codePoints, next)
  );
}

/**
 * Sanitizes a single-row label that stands for a *persisted* decision (an
 * "Always allow" rule), where two different underlying values must never
 * render identically — a human approving one grant must not be shown the
 * same text a different, already-approved grant would show. `sanitizeTerminalLine`
 * is wrong here: it deletes bare C0 bytes and C1 bytes, strips bidi
 * override/isolate characters, and leaves other invisible or format code
 * points untouched, so e.g. a rule carrying a BEL (U+0007), a bidi override
 * (U+202E, which renders as the text "U+202E" below, not the live character
 * itself), or a zero-width space (U+200B) can each collapse onto the same
 * visible label as the clean rule even though they are different stored
 * authorizations.
 *
 * Every C0/DEL/C1 control byte and every code point Unicode classifies as
 * format (Cf) or Default_Ignorable_Code_Point (bidi overrides, zero-width
 * joiners, variation selectors, the tag block, and the rest of that class,
 * not a hand-picked subset of it) is replaced with a visible, terminal-inert
 * stand-in (caret notation for C0/DEL, `\uXXXX` / `\u{X...}` for everything
 * else) instead of being dropped or passed through. Every literal backslash
 * already in the text that could otherwise be mistaken for part of a
 * generated marker is doubled first — so a real control byte's `\^G` (or a
 * real "U+202E" character) can never collide with a user who typed the same
 * characters as plain text (which becomes `\\^G` / `\\u202E`, a different
 * string) — while a backslash anywhere else (a Windows path, a regex) is
 * left alone, so clean input with no control bytes still renders identically
 * before and after this function. The result is a lossless, single-row,
 * terminal-safe stand-in for the raw value: no code point in either class is
 * silently discarded or passed through unexamined, so a different grant
 * always reads differently.
 */
export function sanitizeTerminalLineLossless(value: string): string {
  return sanitizeTerminalLineLosslessWithFlag(value).text;
}

/**
 * Same sanitizer as {@link sanitizeTerminalLineLossless}, but also reports
 * whether anything was replaced. A caller that renders this text into a
 * truncating, single-line UI slot (a `RadioButtonSelect` option with
 * `wrap="truncate"`, for instance) needs that boolean: the in-place marker
 * this function writes can itself fall past the truncation point on a long
 * value, which would silently recreate the exact collision this function
 * exists to prevent. Such a caller should prefix the *whole* label with a
 * fixed, always-visible marker when `replaced` is true, at the position
 * truncation can never reach (the very start), in addition to the in-place
 * marker for anyone who sees the untruncated text.
 */
export function sanitizeTerminalLineLosslessWithFlag(value: string): {
  text: string;
  replaced: boolean;
} {
  const codePoints = toCodePoints(value);
  let result = '';
  let replaced = false;
  for (let i = 0; i < codePoints.length; i++) {
    const char = codePoints[i];
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (char === '\\' && mustDoubleBackslash(codePoints, i)) {
      result += '\\\\';
      continue;
    }
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      result += '\\' + caretNotation(code);
      replaced = true;
      continue;
    }
    if (isC1Control(code) || isInvisibleOrFormat(code)) {
      result += hexNotation(code);
      replaced = true;
      continue;
    }
    result += char;
  }
  return { text: result, replaced };
}

/* Recursively traverses a JSON-like structure (objects, arrays, primitives)
 * and escapes all ANSI control characters found in any string values.
 *
 * This function is designed to be robust, handling deeply nested objects and
 * arrays. It applies a regex-based replacement to all string values to
 * safely escape control characters.
 *
 * To optimize performance, this function uses a "copy-on-write" strategy.
 * It avoids allocating new objects or arrays if no nested string values
 * required escaping, returning the original object reference in such cases.
 *
 * @param obj The JSON-like value (object, array, string, etc.) to traverse.
 * @returns A new value with all nested string fields escaped, or the
 * original `obj` reference if no changes were necessary.
 */
export function escapeAnsiCtrlCodes<T>(obj: T): T {
  if (typeof obj === 'string') {
    if (obj.search(regex) === -1) {
      return obj; // No changes return original string
    }

    regex.lastIndex = 0; // needed for global regex
    return obj.replace(regex, (match) =>
      JSON.stringify(match).slice(1, -1),
    ) as T;
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const record = obj as Record<string, unknown>;
  if (
    !Array.isArray(obj) &&
    typeof record['data'] === 'string' &&
    typeof record['mimeType'] === 'string' &&
    record['mimeType'].toLowerCase().startsWith('image/')
  ) {
    return obj;
  }

  if (Array.isArray(obj)) {
    let newArr: unknown[] | null = null;

    for (let i = 0; i < obj.length; i++) {
      const value = obj[i];
      const escapedValue = escapeAnsiCtrlCodes(value);
      if (escapedValue !== value) {
        if (newArr === null) {
          newArr = [...obj];
        }
        newArr[i] = escapedValue;
      }
    }
    return (newArr !== null ? newArr : obj) as T;
  }

  let newObj: T | null = null;
  const keys = Object.keys(obj);

  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    const escapedValue = escapeAnsiCtrlCodes(value);

    if (escapedValue !== value) {
      if (newObj === null) {
        newObj = { ...obj };
      }
      (newObj as Record<string, unknown>)[key] = escapedValue;
    }
  }

  return newObj !== null ? newObj : obj;
}

/**
 * Patterns that may indicate sensitive information like API keys, tokens, passwords.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys with common prefixes
  {
    pattern: /(sk-[a-zA-Z0-9]{20,})/g,
    replacement: 'sk-***REDACTED***',
  },
  {
    pattern: /(api[_-]?key[_-]?[=:]\s*)[a-zA-Z0-9_-]{20,}/gi,
    replacement: '$1***REDACTED***',
  },
  // Bearer tokens
  {
    pattern: /(Bearer\s+)[a-zA-Z0-9._-]+/gi,
    replacement: '$1***REDACTED***',
  },
  // Generic tokens
  {
    pattern: /(token[_-]?[=:]\s*)[a-zA-Z0-9._-]{10,}/gi,
    replacement: '$1***REDACTED***',
  },
  // Passwords in connection strings or assignments
  {
    pattern: /(password[_-]?[=:]\s*)[^\s]+/gi,
    replacement: '$1***REDACTED***',
  },
  {
    pattern: /(pwd[_-]?[=:]\s*)[^\s]+/gi,
    replacement: '$1***REDACTED***',
  },
  // AWS keys
  {
    pattern: /(AKIA[A-Z0-9]{16})/g,
    replacement: '***REDACTED***',
  },
  // Generic secret patterns
  {
    pattern: /(secret[_-]?[=:]\s*)[a-zA-Z0-9._-]{10,}/gi,
    replacement: '$1***REDACTED***',
  },
];

/**
 * Sanitizes text by redacting potentially sensitive information like API keys,
 * tokens, and passwords. Also truncates long text to a maximum length.
 *
 * @param text The text to sanitize
 * @param maxLength Maximum length of the output text (default: 200)
 * @returns Sanitized and truncated text
 */
export function sanitizeSensitiveText(
  text: string,
  maxLength: number = 200,
): string {
  let result = text;

  // Apply each sensitive pattern replacement
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  // Truncate if too long
  if (result.length > maxLength) {
    if (maxLength <= 3) {
      return result.slice(0, maxLength);
    }
    return result.slice(0, maxLength - 3) + '...';
  }

  return result;
}

// Match standalone C0 controls (incl. TAB/CR/LF/BEL/BS), DEL, and C1 controls.
// `escapeAnsiCtrlCodes` only neutralizes multi-byte ANSI sequences; raw single
// bytes like `\n`, `\r`, BEL, BS slip past it and can still break layouts or
// inject terminal effects when rendered as part of a git-supplied filename.
// The Unicode bidi embedding/isolate controls (U+202A–202E, U+2066–2069) are
// also stripped so a crafted filename can't visually spoof its extension.
/* eslint-disable no-control-regex */
const FILENAME_CONTROL_CHARS_REGEX =
  /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

// Same as FILENAME_CONTROL_CHARS_REGEX minus `\n` (row separator) and `\t`
// (benign indentation), which multi-line display treats as layout.
/* eslint-disable no-control-regex */
const MULTILINE_CONTROL_CHARS_REGEX =
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

function escapeControlChar(ch: string): string {
  switch (ch) {
    case '\b':
      return '\\b';
    case '\t':
      return '\\t';
    case '\n':
      return '\\n';
    case '\f':
      return '\\f';
    case '\r':
      return '\\r';
    default: {
      // DEL (0x7F) and C1 controls (0x80-0x9F) are returned as raw bytes by
      // JSON.stringify, which is exactly what we are trying to keep out of
      // rendered output. Hand-roll the \uXXXX escape so every matched code
      // point becomes printable.
      const code = ch.charCodeAt(0);
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
}

/**
 * Make a git-supplied filename safe to drop into a TUI text node or a
 * stdout / log line. Strips both multi-byte ANSI sequences (via
 * `escapeAnsiCtrlCodes`) and bare control bytes that git happily round-trips
 * through `-z` paths but which would otherwise inject color resets, cursor
 * moves, BEL, or layout-breaking newlines into the rendered output.
 *
 * Use this anywhere a path from `fetchGitDiff`, `fetchGitDiffHunks`, or a
 * file-history backup is rendered to the user.
 */
export function sanitizeFilenameForDisplay(name: string): string {
  return escapeAnsiCtrlCodes(name).replace(
    FILENAME_CONTROL_CHARS_REGEX,
    escapeControlChar,
  );
}

/**
 * Make untrusted multi-line text (e.g. model-generated file contents) safe to
 * render in the TUI while preserving its line structure: neutralizes
 * multi-byte ANSI/VT sequences (via `escapeAnsiCtrlCodes`), then escapes the
 * remaining bare control bytes — BEL, BS, CR, DEL, C1, the 8-bit CSI — as
 * inert, visible text. `\n` and `\t` pass through untouched.
 */
export function sanitizeMultilineForDisplay(text: string): string {
  return escapeAnsiCtrlCodes(text).replace(
    MULTILINE_CONTROL_CHARS_REGEX,
    escapeControlChar,
  );
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for reconciling LLM-proposed edits with on-disk text.
 *
 * The normalization pipeline intentionally stays deterministic: we first try
 * literal substring matches, then gradually relax comparison rules (smart
 * quotes, em-dashes, trailing whitespace, etc.) until we either locate the
 * exact slice from the file or conclude the edit cannot be applied.
 */

/* -------------------------------------------------------------------------- */
/* Character-level normalization                                             */
/* -------------------------------------------------------------------------- */

const UNICODE_EQUIVALENT_MAP: Record<string, string> = {
  // Hyphen variations → ASCII hyphen-minus.
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  // Curly single quotes → straight apostrophe.
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  // Curly double quotes → straight double quote.
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u201F': '"',
  // Whitespace variants → normal space.
  '\u00A0': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2004': ' ',
  '\u2005': ' ',
  '\u2006': ' ',
  '\u2007': ' ',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200A': ' ',
  '\u202F': ' ',
  '\u205F': ' ',
  '\u3000': ' ',
};

function normalizeBasicCharacters(text: string): string {
  if (text === '') {
    return text;
  }

  let normalized = '';
  for (const char of text) {
    normalized += UNICODE_EQUIVALENT_MAP[char] ?? char;
  }
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Line-based search helpers                                                 */
/* -------------------------------------------------------------------------- */

interface MatchedSliceResult {
  slice: string;
  removedTrailingFinalEmptyLine: boolean;
  lineBasedMatch?: boolean;
}

/**
 * Comparison passes become progressively more forgiving, making it possible to
 * match when only trailing whitespace differs. Leading whitespace (indentation)
 * is always preserved to avoid matching at incorrect scope levels.
 */
const LINE_COMPARISON_PASSES: Array<(value: string) => string> = [
  (value) => value,
  (value) => value.trimEnd(),
];

function normalizeLineForComparison(value: string): string {
  return normalizeBasicCharacters(value).trimEnd();
}

/**
 * Finds the first index where {@link pattern} appears within {@link lines} once
 * both sequences are transformed in the same way.
 */
function seekSequenceWithTransform(
  lines: string[],
  pattern: string[],
  transform: (value: string) => string,
): number | null {
  if (pattern.length === 0) {
    return 0;
  }

  if (pattern.length > lines.length) {
    return null;
  }

  outer: for (let i = 0; i <= lines.length - pattern.length; i++) {
    for (let p = 0; p < pattern.length; p++) {
      if (transform(lines[i + p]) !== transform(pattern[p])) {
        continue outer;
      }
    }
    return i;
  }

  return null;
}

function buildLineIndex(text: string): {
  lines: string[];
  offsets: number[];
} {
  const lines = text.split('\n');
  const offsets = new Array<number>(lines.length + 1);
  let cursor = 0;

  for (let i = 0; i < lines.length; i++) {
    offsets[i] = cursor;
    cursor += lines[i].length;
    if (i < lines.length - 1) {
      cursor += 1; // Account for the newline that split() removed.
    }
  }
  offsets[lines.length] = text.length;

  return { lines, offsets };
}

/**
 * Reconstructs the original characters for the matched lines, optionally
 * preserving the newline that follows the final line.
 */
function sliceFromLines(
  text: string,
  offsets: number[],
  lines: string[],
  startLine: number,
  lineCount: number,
  includeTrailingNewline: boolean,
): string {
  if (lineCount === 0) {
    return includeTrailingNewline ? '\n' : '';
  }

  const startIndex = offsets[startLine] ?? 0;
  const lastLineIndex = startLine + lineCount - 1;
  const lastLineStart = offsets[lastLineIndex] ?? 0;
  let endIndex = lastLineStart + (lines[lastLineIndex]?.length ?? 0);

  if (includeTrailingNewline) {
    const nextLineStart = offsets[startLine + lineCount];
    if (nextLineStart !== undefined) {
      endIndex = nextLineStart;
    } else if (text.endsWith('\n')) {
      endIndex = text.length;
    }
  }

  return text.slice(startIndex, endIndex);
}

function findLineBasedMatch(
  haystack: string,
  needle: string,
): MatchedSliceResult | null {
  const { lines, offsets } = buildLineIndex(haystack);
  const patternLines = needle.split('\n');
  const endsWithNewline = needle.endsWith('\n');

  if (patternLines.length === 0) {
    return null;
  }

  const attemptMatch = (candidate: string[]): number | null => {
    for (const pass of LINE_COMPARISON_PASSES) {
      const idx = seekSequenceWithTransform(lines, candidate, pass);
      if (idx !== null) {
        return idx;
      }
    }
    return seekSequenceWithTransform(
      lines,
      candidate,
      normalizeLineForComparison,
    );
  };

  let matchIndex = attemptMatch(patternLines);
  if (matchIndex !== null) {
    return {
      slice: sliceFromLines(
        haystack,
        offsets,
        lines,
        matchIndex,
        // The trailing split element is covered by the newline flag.
        patternLines.length - (endsWithNewline ? 1 : 0),
        endsWithNewline,
      ),
      removedTrailingFinalEmptyLine: false,
      lineBasedMatch: true,
    };
  }

  if (patternLines.at(-1) === '') {
    const trimmedPattern = patternLines.slice(0, -1);
    if (trimmedPattern.length === 0) {
      return null;
    }
    matchIndex = attemptMatch(trimmedPattern);
    if (matchIndex !== null) {
      return {
        slice: sliceFromLines(
          haystack,
          offsets,
          lines,
          matchIndex,
          trimmedPattern.length,
          false,
        ),
        removedTrailingFinalEmptyLine: true,
        lineBasedMatch: true,
      };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Slice discovery                                                           */
/* -------------------------------------------------------------------------- */

function findMatchedSlice(
  haystack: string,
  needle: string,
): MatchedSliceResult | null {
  if (needle === '') {
    return null;
  }

  const literalIndex = haystack.indexOf(needle);
  if (literalIndex !== -1) {
    return {
      slice: haystack.slice(literalIndex, literalIndex + needle.length),
      removedTrailingFinalEmptyLine: false,
    };
  }

  const normalizedHaystack = normalizeBasicCharacters(haystack);
  const normalizedNeedleChars = normalizeBasicCharacters(needle);
  const normalizedIndex = normalizedHaystack.indexOf(normalizedNeedleChars);
  if (normalizedIndex !== -1) {
    return {
      slice: haystack.slice(normalizedIndex, normalizedIndex + needle.length),
      removedTrailingFinalEmptyLine: false,
    };
  }

  return findLineBasedMatch(haystack, needle);
}

/**
 * Returns the literal slice from {@link haystack} that best corresponds to the
 * provided {@link needle}, or {@code null} when no match is found.
 */
/* -------------------------------------------------------------------------- */
/* Replacement helpers                                                       */
/* -------------------------------------------------------------------------- */

function removeTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) {
    return text.slice(0, -2);
  }
  if (text.endsWith('\n') || text.endsWith('\r')) {
    return text.slice(0, -1);
  }
  return text;
}

function adjustNewStringForTrailingLine(
  newString: string,
  removedTrailingLine: boolean,
): string {
  return removedTrailingLine ? removeTrailingNewline(newString) : newString;
}

export interface NormalizedEditStrings {
  oldString: string;
  newString: string;
  lineBasedMatch?: boolean;
}

const UNICODE_ESCAPE_PATTERN = /\\\\|\\u[0-9a-fA-F]{4}/g;
const MAX_UNICODE_RECOVERY_CODE_UNITS = 256;

function decodeUnicodeEscapes(text: string): string | null {
  const decoded = text.replace(UNICODE_ESCAPE_PATTERN, (escape) => {
    if (escape.length === 2) return escape;
    const code = parseInt(escape.slice(2), 16);
    return code >= 128 ? String.fromCharCode(code) : escape;
  });
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    decoded,
  )
    ? null
    : decoded;
}

function splitsEscapeSequence(text: string, offset: number): boolean {
  for (let start = Math.max(0, offset - 9); start < offset; start++) {
    if (text[start] !== '\\') continue;
    let runStart = start;
    while (runStart > 0 && text[runStart - 1] === '\\') runStart--;
    if ((start - runStart) % 2 === 1) continue;
    const escape =
      /^\\(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/.exec(
        text.slice(start, start + 10),
      );
    if (escape !== null && offset < start + escape[0].length) return true;
  }
  return false;
}

function findUnicodeEscapeMatch(
  fileContent: string,
  oldString: string,
  newString: string,
): NormalizedEditStrings | null {
  const decoded = decodeUnicodeEscapes(oldString);
  if (
    decoded === null ||
    decoded.length > MAX_UNICODE_RECOVERY_CODE_UNITS ||
    !/[\u0080-\uffff]/.test(decoded)
  ) {
    return null;
  }
  if (decoded === oldString && !fileContent.includes('\\u')) return null;

  const pattern = decoded
    .split('')
    .map((char) => {
      const literal = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (char.charCodeAt(0) < 128) return literal;
      const hex = char
        .charCodeAt(0)
        .toString(16)
        .padStart(4, '0')
        .replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
      return `(?:${literal}|(?<!\\\\)\\\\u${hex})`;
    })
    .join('');

  let canonical: string | undefined;
  let literalSearchStart = 0;
  const trailingBackslash = /(?:^|[^\\])(?:\\\\)*\\$/.test(newString);
  for (const match of fileContent.matchAll(new RegExp(pattern, 'g'))) {
    const end = match.index + match[0].length;
    if (
      splitsEscapeSequence(fileContent, match.index) ||
      splitsEscapeSequence(fileContent, end) ||
      (trailingBackslash && end < fileContent.length)
    ) {
      return null;
    }
    // A single canonical slice cannot represent different escaping styles.
    if (canonical !== undefined && canonical !== match[0]) return null;
    canonical = match[0];
    // Literal replacement must use exactly the same eligible positions.
    if (fileContent.indexOf(canonical, literalSearchStart) !== match.index) {
      return null;
    }
    literalSearchStart = match.index + canonical.length;
  }
  if (canonical === undefined) return null;
  if (fileContent.indexOf(canonical, literalSearchStart) !== -1) return null;

  const escapes = Array.from(
    canonical.matchAll(UNICODE_ESCAPE_PATTERN),
    (match) => match[0],
  ).filter(
    (escape) => escape.length === 6 && parseInt(escape.slice(2), 16) >= 128,
  );
  if (escapes.length === 0) {
    return {
      oldString: canonical,
      newString: decodeUnicodeEscapes(newString) ?? newString,
    };
  }
  if (/[\u0080-\uffff]/.test(canonical)) return null;
  if (/(?:^|[^\\])(?:\\\\)*\\[\u0080-\uffff]/.test(newString)) return null;

  const byChar = new Map(
    escapes.map((escape) => [
      String.fromCharCode(parseInt(escape.slice(2), 16)),
      escape,
    ]),
  );
  const digits = escapes.join('').replace(/\\u/g, '');
  const uppercase =
    (digits.match(/[A-F]/g)?.length ?? 0) >
    (digits.match(/[a-f]/g)?.length ?? 0);
  return {
    oldString: canonical,
    newString: newString
      .split('')
      .map((char) => {
        if (char.charCodeAt(0) < 128) return char;
        const hex = char.charCodeAt(0).toString(16).padStart(4, '0');
        return (
          byChar.get(char) ?? '\\u' + (uppercase ? hex.toUpperCase() : hex)
        );
      })
      .join(''),
  };
}

/**
 * Runs the core normalization pipeline:
 *   1. Attempt to find the literal text inside {@link fileContent}.
 *   2. If found through a relaxed match (smart quotes, line trims, etc.),
 *      return the canonical slice from disk so later replacements operate on
 *      exact bytes.
 *   3. If those matches fail, recover non-ASCII Unicode escape representations
 *      only when all candidates have the same bytes and Unicode style.
 *      Otherwise preserve newString as-is (it represents the LLM's intent).
 *
 * Note: Trailing whitespace in newString is intentionally NOT stripped.
 * While LLMs may sometimes accidentally add trailing whitespace, stripping it
 * unconditionally breaks legitimate use cases where trailing whitespace is
 * intentional (e.g., multi-line strings, heredocs). See issue #1618.
 */
export function normalizeEditStrings(
  fileContent: string | null,
  oldString: string,
  newString: string,
): NormalizedEditStrings {
  if (fileContent === null || oldString === '') {
    return {
      oldString,
      newString,
    };
  }

  const canonicalOriginal = findMatchedSlice(fileContent, oldString);
  if (canonicalOriginal !== null) {
    return {
      oldString: canonicalOriginal.slice,
      newString: adjustNewStringForTrailingLine(
        newString,
        canonicalOriginal.removedTrailingFinalEmptyLine,
      ),
      ...(canonicalOriginal.lineBasedMatch ? { lineBasedMatch: true } : {}),
    };
  }

  return (
    findUnicodeEscapeMatch(fileContent, oldString, newString) ?? {
      oldString,
      newString,
    }
  );
}

/**
 * When deleting text and the on-disk content contains the same substring with a
 * trailing newline, automatically consume that newline so the removal does not
 * leave a blank line behind.
 */
export function maybeAugmentOldStringForDeletion(
  fileContent: string | null,
  oldString: string,
  newString: string,
  lineBasedMatch = false,
): string {
  if (
    fileContent === null ||
    oldString === '' ||
    newString !== '' ||
    oldString.endsWith('\n')
  ) {
    return oldString;
  }

  const candidate = `${oldString}\n`;
  const hasCandidate = lineBasedMatch
    ? findLineBasedMatchOffsets(fileContent, candidate).length > 0
    : fileContent.includes(candidate);
  return hasCandidate ? candidate : oldString;
}

/**
 * Counts the number of non-overlapping occurrences of {@link substr} inside
 * {@link source}. Returns 0 when the substring is empty.
 */
export function countOccurrences(source: string, substr: string): number {
  if (substr === '') {
    return 0;
  }

  let count = 0;
  let index = source.indexOf(substr);
  while (index !== -1) {
    count++;
    index = source.indexOf(substr, index + substr.length);
  }
  return count;
}

/** Exact canonical slices from fuzzy line matching must remain whole lines. */
export function findLineBasedMatchOffsets(
  source: string,
  substr: string,
): number[] {
  const offsets: number[] = [];
  if (substr === '') {
    return offsets;
  }

  let index = source.indexOf(substr);
  while (index !== -1) {
    const end = index + substr.length;
    const startsLine = index === 0 || source[index - 1] === '\n';
    const endsLine =
      substr.endsWith('\n') || end === source.length || source[end] === '\n';
    if (startsLine && endsLine) {
      offsets.push(index);
      index = source.indexOf(substr, end);
    } else {
      index = source.indexOf(substr, index + 1);
    }
  }
  return offsets;
}

/**
 * Result from extracting a snippet showing the edited region.
 */
export interface EditSnippetResult {
  /** Starting line number (1-indexed) of the snippet */
  startLine: number;
  /** Ending line number (1-indexed) of the snippet */
  endLine: number;
  /** Total number of lines in the new content */
  totalLines: number;
  /** The snippet content (subset of lines from newContent) */
  content: string;
}

const SNIPPET_CONTEXT_LINES = 4;
const SNIPPET_MAX_LINES = 1000;

/**
 * Extracts a snippet from the edited file showing the changed region with
 * surrounding context. This compares the old and new content line-by-line
 * from both ends to locate the changed region.
 *
 * @param oldContent The original file content before the edit (null for new files)
 * @param newContent The new file content after the edit
 * @returns Snippet information, or null if no meaningful snippet can be extracted
 */
export function extractEditSnippet(
  oldContent: string | null,
  newContent: string,
): EditSnippetResult | null {
  const newLines = newContent.split('\n');
  const totalLines = newLines.length;

  if (oldContent === null) {
    return {
      startLine: 1,
      endLine: totalLines,
      totalLines,
      content: newContent,
    };
  }

  // No changes case
  if (oldContent === newContent || !newContent) {
    return null;
  }

  const oldLines = oldContent.split('\n');

  // Find the first line that differs from the start
  let firstDiffLine = 0;
  const minLength = Math.min(oldLines.length, newLines.length);

  while (firstDiffLine < minLength) {
    if (oldLines[firstDiffLine] !== newLines[firstDiffLine]) {
      break;
    }
    firstDiffLine++;
  }

  // Find the first line that differs from the end
  let oldEndIndex = oldLines.length - 1;
  let newEndIndex = newLines.length - 1;

  while (oldEndIndex >= firstDiffLine && newEndIndex >= firstDiffLine) {
    if (oldLines[oldEndIndex] !== newLines[newEndIndex]) {
      break;
    }
    oldEndIndex--;
    newEndIndex--;
  }

  // The changed region in the new content is from firstDiffLine to newEndIndex (inclusive)
  // Convert to 1-indexed line numbers
  const changeStart = firstDiffLine + 1;
  const changeEnd = newEndIndex + 1;

  // If the change region is too large, don't generate a snippet
  if (changeEnd - changeStart > SNIPPET_MAX_LINES) {
    return null;
  }

  // Calculate snippet bounds with context
  const snippetStart = Math.max(1, changeStart - SNIPPET_CONTEXT_LINES);
  const snippetEnd = Math.min(totalLines, changeEnd + SNIPPET_CONTEXT_LINES);

  const snippetLines = newLines.slice(snippetStart - 1, snippetEnd);

  return {
    startLine: snippetStart,
    endLine: snippetEnd,
    totalLines,
    content: snippetLines.join('\n'),
  };
}

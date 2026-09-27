/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { safeLiteralReplace } from './textUtils.js';

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
        patternLines.length,
        endsWithNewline,
      ),
      removedTrailingFinalEmptyLine: false,
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
}

/**
 * Runs the core normalization pipeline:
 *   1. Attempt to find the literal text inside {@link fileContent}.
 *   2. If found through a relaxed match (smart quotes, line trims, etc.),
 *      return the canonical slice from disk so later replacements operate on
 *      exact bytes.
 *   3. Preserve newString as-is (it represents the LLM's intent).
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
    };
  }

  return {
    oldString,
    newString,
  };
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
  return fileContent.includes(candidate) ? candidate : oldString;
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

/* -------------------------------------------------------------------------- */
/* Line-ending preserving splice                                            */
/* -------------------------------------------------------------------------- */

/**
 * The line ending that follows `index` in `content`, or `null` when `index` is
 * not immediately followed by a line break.
 */
function lineEndingAfter(content: string, index: number): string | null {
  if (content.startsWith('\r\n', index)) {
    return '\r\n';
  }
  if (content[index] === '\n') {
    return '\n';
  }
  return null;
}

/**
 * The line ending that most recently precedes `index` in `content`, or `null`
 * when the text before `index` has no line break in it.
 */
function lineEndingBefore(content: string, index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        return '\r\n';
      }
      return '\n';
    }
  }
  return null;
}

/**
 * The first line ending in `content`, or `'\n'` when it has none.
 *
 * This is a last resort for text that sits on a line with no break in front of
 * it and none after it, which in a file whose only break is at the very end means
 * the first line of the file. It is reached only from code that has already
 * established the content contains a CRLF, so a bare `'\n'` here would put an LF
 * into a CRLF file.
 */
function firstLineEnding(content: string): string {
  const index = content.indexOf('\n');
  if (index === -1) {
    return '\n';
  }
  return index > 0 && content[index - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Answers "which line ending most recently precedes this index" for a series of
 * indices that only move forwards.
 *
 * Matches are consumed in increasing order within one splice, so the character
 * before the current index has usually already been looked at for the previous
 * match. Scanning backwards from every match again makes `replace_all` over a
 * file that is essentially one long line quadratic in the file size, because each
 * match walks the whole distance back to the start. Carrying the answer forward
 * makes the total work linear.
 */
class PrecedingLineEnding {
  private readonly content: string;
  private scanned = 0;
  private ending: string | null = null;

  constructor(content: string) {
    this.content = content;
  }

  at(index: number): string | null {
    if (index < this.scanned) {
      // Not expected: the caller only ever moves forward. Answer directly rather
      // than trusting the cursor, so a future caller cannot get a wrong answer.
      return lineEndingBefore(this.content, index);
    }
    for (let i = this.scanned; i < index; i++) {
      if (this.content[i] === '\n') {
        this.ending = i > 0 && this.content[i - 1] === '\r' ? '\r\n' : '\n';
      }
    }
    this.scanned = index;
    return this.ending;
  }
}

/**
 * The line ending `content[end - 1]` ends with, when the span `content.slice(
 * start, end)` itself finishes on a line break.
 */
function spanTrailingLineEnding(
  content: string,
  start: number,
  end: number,
): string | null {
  if (end - 1 > start && content[end - 1] === '\n') {
    if (content[end - 2] === '\r') {
      return '\r\n';
    }
    return '\n';
  }
  return null;
}

/**
 * Maps every offset in the LF-normalized `normalizedContent` back to the offset
 * it came from in `rawContent`.
 *
 * Normalizing only ever removes the `\r` of a `\r\n`, so the mapping is
 * monotonic and one pass is enough. Entry `i` is the raw offset that produced
 * normalized offset `i`; the final entry is `rawContent.length`.
 */
function normalizedToRawOffsets(
  rawContent: string,
  normalizedLength: number,
): number[] {
  const offsets: number[] = new Array(normalizedLength + 1);
  let normalizedIndex = 0;
  for (let rawIndex = 0; rawIndex < rawContent.length; rawIndex++) {
    if (rawContent[rawIndex] === '\r' && rawContent[rawIndex + 1] === '\n') {
      // Normalization drops this `\r`, so the `\n` behind it keeps the
      // normalized index the `\r` would have taken.
      continue;
    }
    if (normalizedIndex < normalizedLength) {
      offsets[normalizedIndex] = rawIndex;
    }
    normalizedIndex++;
  }
  // A match that runs to the end of the normalized text starts after the last
  // character, which is the end of the raw text.
  offsets[normalizedLength] = rawContent.length;
  return offsets;
}

/**
 * Applies the same replacement as `applyReplacement`, but splices the result
 * into the bytes that were read instead of into the LF-normalized copy.
 *
 * `applyReplacement` runs on LF-normalized text so that matching and the
 * confirmation diff are line-ending agnostic, and `prepareTextFileContent`
 * re-expanded that text to one style per file. Between them, a file that mixes
 * CRLF and LF had every terminator rewritten by an edit that touched one line:
 * `detectLineEnding` answers `crlf` as soon as the file contains a single
 * `\r\n`, and `ensureCrlfLineEndings` then converts every `\n`.
 *
 * Here the untouched prefix and suffix are copied verbatim from `rawContent`, so
 * only the matched spans are replaced. Inserted text takes the line ending of
 * the region it replaced — the span's own trailing break, else the break that
 * follows it, else the one before it — so a uniformly-CRLF file does not gain
 * LF lines. For a file that is already uniformly LF or uniformly CRLF the result
 * is byte-identical to what the previous path produced.
 *
 * Matches are located in the normalized text and mapped back, so the spans are
 * the same ones `safeLiteralReplace` would have replaced, including its
 * replace-all behaviour.
 */
export function applyReplacementPreservingLineEndings(
  rawContent: string,
  normalizedContent: string,
  oldString: string,
  newString: string,
): string {
  if (oldString === '' || !normalizedContent.includes(oldString)) {
    return rawContent;
  }

  if (!rawContent.includes('\r\n')) {
    // Nothing to map: with no CRLF in the file the normalized copy is byte for
    // byte the file itself, so the replacement can be applied to it directly.
    // This is also exactly what the write path used to do for such a file.
    return safeLiteralReplace(rawContent, oldString, newString);
  }

  const offsets = normalizedToRawOffsets(rawContent, normalizedContent.length);

  let result = '';
  let copiedUpTo = 0;
  let searchFrom = 0;
  const preceding = new PrecedingLineEnding(rawContent);
  for (;;) {
    const matchAt = normalizedContent.indexOf(oldString, searchFrom);
    if (matchAt === -1) {
      break;
    }
    const matchEnd = matchAt + oldString.length;
    let rawStart = offsets[matchAt];
    // Normalization drops the `\r` of every CRLF, so a normalized `\n` maps to
    // the raw index of the `\n` and never to the `\r` in front of it. A match
    // that starts on such a newline owns that `\r`, so pull it into the span
    // rather than leave it in the untouched prefix -- otherwise the pair is
    // split and the file ends up with a doubled `\r`.
    if (
      rawStart > 0 &&
      rawContent[rawStart - 1] === '\r' &&
      rawContent[rawStart] === '\n'
    ) {
      rawStart--;
    }
    let rawEnd = offsets[matchEnd];
    // Normalization drops the `\r` of every CRLF, so a span can end up holding
    // one. That `\r` is not part of the text being replaced — it is the first
    // half of the break that follows the span — and leaving it out is what keeps
    // the pair intact for the untouched tail.
    while (
      rawEnd > rawStart &&
      rawContent[rawEnd - 1] === '\r' &&
      rawContent[rawEnd] === '\n'
    ) {
      rawEnd--;
    }

    // A line break the edit matched is replaced by one of the same kind: when
    // the span starts on a break, that break belonged to the line in front of
    // it, so the inserted text's first break keeps the ending of the line it
    // terminates. The guard above has already pulled a dropped `\r` into the
    // span, so its first character says which kind it was.
    const matchedLeadingEnding = rawContent[rawStart] === '\r' ? '\r\n' : '\n';
    // When the span starts on a break, the inserted text continues the line that
    // break terminated, so every break it adds takes the same kind. Decided first,
    // because in that case the span's own region is never consulted and the lookups
    // below would be performed only to be discarded.
    const spanStartsWithBreak =
      rawContent[rawStart] === '\n' || rawContent[rawStart] === '\r';
    // Otherwise the breaks the edit adds sit where the span was and take the ending
    // of that region: the span's own trailing break, else the one right after it,
    // else the one that opened the line, else -- when the span is the whole file
    // around it and there is no break either side -- the file's first ending.
    const ending = spanStartsWithBreak
      ? matchedLeadingEnding
      : (spanTrailingLineEnding(rawContent, rawStart, rawEnd) ??
        lineEndingAfter(rawContent, rawEnd) ??
        preceding.at(rawStart) ??
        firstLineEnding(rawContent));
    const insertedEnding = ending;
    const inserted = newString
      .split(/\r\n|\n/)
      .map((text, index) => (index === 0 ? text : `${insertedEnding}${text}`))
      .join('');

    result += rawContent.slice(copiedUpTo, rawStart) + inserted;
    copiedUpTo = rawEnd;
    searchFrom = matchEnd;
  }

  return result + rawContent.slice(copiedUpTo);
}

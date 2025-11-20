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

/**
 * Removes trailing whitespace from each line while keeping the original newline
 * separators intact.
 */
function stripTrailingWhitespacePreserveNewlines(text: string): string {
  const pieces = text.split(/(\r\n|\n|\r)/);
  let result = '';

  for (let i = 0; i < pieces.length; i++) {
    const segment = pieces[i];
    if (segment === undefined) {
      continue;
    }

    if (i % 2 === 0) {
      result += segment.trimEnd();
    } else {
      result += segment;
    }
  }

  return result;
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
 *   1. Strip trailing whitespace copied from numbered output.
 *   2. Attempt to find the literal text inside {@link fileContent}.
 *   3. If found through a relaxed match (smart quotes, line trims, etc.),
 *      return the canonical slice from disk so later replacements operate on
 *      exact bytes.
 */
export function normalizeEditStrings(
  fileContent: string | null,
  oldString: string,
  newString: string,
): NormalizedEditStrings {
  const trimmedNewString = stripTrailingWhitespacePreserveNewlines(newString);

  if (fileContent === null || oldString === '') {
    return {
      oldString,
      newString: trimmedNewString,
    };
  }

  const canonicalOriginal = findMatchedSlice(fileContent, oldString);
  if (canonicalOriginal !== null) {
    return {
      oldString: canonicalOriginal.slice,
      newString: adjustNewStringForTrailingLine(
        trimmedNewString,
        canonicalOriginal.removedTrailingFinalEmptyLine,
      ),
    };
  }

  return {
    oldString,
    newString: trimmedNewString,
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
 * @param contextLines Number of context lines to show before and after the change
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

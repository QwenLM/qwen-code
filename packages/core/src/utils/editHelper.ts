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
}

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

  for (let i = 0; i <= lines.length - pattern.length; i++) {
    let allEqual = true;
    for (let p = 0; p <= pattern.length - 1; p++) {
      const a = transform(lines[i + p]).replaceAll(' ', '');
      const b = transform(pattern[p]).replaceAll(' ', '');
      if (a !== b) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) {
      return i;
    }
  }

  return null;
}

// We assume that a line of text should include the trailing newline character.
// For example:
// `\naaa\nbbb\nccc` should be split into "\n", "aaa\n", "bbb\n", "ccc"
// `aaa\nbbb\nccc\n` should be split into "aaa\n", "bbb\n", "ccc\n"
// `aaa\nbbb\nccc`   should be split into "aaa\n", "bbb\n", "ccc"
function buildLineIndex(text: string): {
  lines: string[];
  offsets: number[];
} {
  const lines = text.split('\n');
  let endWithNewLine = false;
  if (lines[lines.length - 1] === '') {
    lines.pop();
    endWithNewLine = true;
  }
  const offsets = new Array<number>(lines.length);
  let cursor = 0;

  for (let i = 0; i <= lines.length - 1; i++) {
    if (i !== lines.length - 1 || endWithNewLine) {
      lines[i] = lines[i] + '\n'; // Add back the removed newline
    }
    offsets[i] = cursor;
    cursor += lines[i].length;
  }
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
): string {
  const startIndex = offsets[startLine] ?? 0;
  const lastLineIndex = startLine + lineCount - 1;
  const lastLineStart = offsets[lastLineIndex] ?? 0;
  const endIndex = lastLineStart + (lines[lastLineIndex]?.length ?? 0);
  return text.slice(startIndex, endIndex);
}

function findLineBasedMatch(
  haystack: string,
  needle: string,
): MatchedSliceResult | null {
  const { lines, offsets } = buildLineIndex(haystack);
  const patternLines = buildLineIndex(needle).lines;
  const endWithNewLine = isTrailingNewLine(
    patternLines[patternLines.length - 1],
  );
  if (patternLines.length === 0) {
    return null;
  }
  const matchIndex = seekSequenceWithTransform(
    lines,
    patternLines,
    normalizeLineForComparison,
  );
  if (matchIndex !== null) {
    const slice = sliceFromLines(
      haystack,
      offsets,
      lines,
      matchIndex,
      patternLines.length,
    );
    if (!endWithNewLine) {
      return {
        slice: removeTrailingNewline(slice),
      };
    }
    return {
      slice,
    };
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
    };
  }

  const normalizedHaystack = normalizeBasicCharacters(haystack);
  const normalizedNeedleChars = normalizeBasicCharacters(needle);
  const normalizedIndex = normalizedHaystack.indexOf(normalizedNeedleChars);
  if (normalizedIndex !== -1) {
    return {
      slice: haystack.slice(normalizedIndex, normalizedIndex + needle.length),
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

function isLeadingNewLine(text: string): boolean {
  if (text.startsWith('\r\n')) {
    return true;
  }
  return text.startsWith('\n') || text.startsWith('\r');
}

function isTrailingNewLine(text: string): boolean {
  if (text.endsWith('\r\n')) {
    return true;
  }
  return text.endsWith('\n') || text.endsWith('\r');
}

function removeLeadingNewLine(text: string): string {
  if (text.startsWith('\r\n')) {
    return text.slice(2, text.length);
  }
  if (text.startsWith('\n') || text.startsWith('\r')) {
    return text.slice(1, text.length);
  }
  return text;
}

function removeTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) {
    return text.slice(0, -2);
  }
  if (text.endsWith('\n') || text.endsWith('\r')) {
    return text.slice(0, -1);
  }
  return text;
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
  while (true) {
    if (isLeadingNewLine(oldString) && isLeadingNewLine(newString)) {
      oldString = removeLeadingNewLine(oldString);
      newString = removeLeadingNewLine(newString);
      continue;
    }
    if (isTrailingNewLine(oldString) && isTrailingNewLine(newString)) {
      oldString = removeTrailingNewline(oldString);
      newString = removeTrailingNewline(newString);
      continue;
    }
    break;
  }

  const canonicalOriginal = findMatchedSlice(fileContent, oldString);
  if (canonicalOriginal !== null) {
    return {
      oldString: canonicalOriginal.slice,
      newString,
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

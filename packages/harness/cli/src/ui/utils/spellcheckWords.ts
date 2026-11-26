/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which words in the prompt input are worth spell checking.
 *
 * Deliberately timid. A false underline under a filename, a flag, or an API name
 * is worse than no underline at all, so anything that could be code, a path, an
 * identifier, or another script is skipped whole. What survives is prose.
 *
 * Offsets are code points, matching the buffer's coordinates rather than the
 * UTF-16 indices a regex reports.
 */

import { runLogger } from '@qwen-code/core';

export interface ExtractedWord {
  word: string;
  /** Code-point offset into the text, inclusive. */
  start: number;
  /** Code-point offset into the text, exclusive. */
  end: number;
}

/** Words are letters and marks, with apostrophes allowed inside. */
const WORD_REGEX = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

/** Inline code and fenced blocks, whose contents are never prose. */
const CODE_SPAN_REGEX = /(``+)[\s\S]*?(?:\1|$)|`[^`\n]*(?:`|\n|$)/g;

const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 64;

/** Scripts a Latin dictionary cannot judge. */
const UNCHECKABLE_SCRIPT_REGEX =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Khmer}]/u;

/**
 * A chunk that opens like a flag, a relative path, a dotted name, or a tag.
 */
const CODE_LIKE_PREFIX_REGEX = /^(?:-|\.[A-Za-z]|<[A-Za-z/!])/;

/**
 * A chunk carrying any of these is treated as code: digits, separators,
 * brackets, operators, or an inner dotted name.
 */
const CODE_LIKE_CONTENT_REGEX = /[0-9_/\\@#=<>{}[\]()|~^$%*+:;`]|\.[A-Za-z]/;

/**
 * Quotes and prose punctuation stripped before judging a chunk.
 *
 * Parentheses are here because prose uses them; square and curly brackets are
 * not, because in this input they are far more often a placeholder
 * (`[Pasted Text: 6 lines]`) or code than an aside.
 */
const CHUNK_TRIM_REGEX = /^["'“”‘’(,.!?;:]+|["'“”‘’),.!?;:]+$/g;

/**
 * Beyond this the input is not a prompt anyone is proofreading, and tokenizing
 * it on every keystroke would cost more than the feature is worth.
 */
export const MAX_SPELLCHECK_TEXT_LENGTH = 10_000;

let warnedTooLong = false;

/** Test seam: the oversize warning is one-shot. */
export function resetSpellcheckWordWarningsForTesting(): void {
  warnedTooLong = false;
}

/**
 * Map UTF-16 indices to code-point offsets in one pass.
 *
 * Everything downstream — the buffer, the highlight tokens, the cursor — counts
 * in code points, so a single emoji ahead of a word would otherwise shift its
 * underline one column left.
 */
function buildCodePointIndex(text: string): (utf16Index: number) => number {
  // ASCII, the common case, needs no mapping at all.
  let hasAstral = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      hasAstral = true;
      break;
    }
  }
  if (!hasAstral) return (utf16Index) => utf16Index;

  const codePointByUtf16 = new Int32Array(text.length + 1);
  let cp = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    for (let k = 0; k < width; k++) codePointByUtf16[i + k] = cp;
    i += width;
    cp += 1;
  }
  codePointByUtf16[text.length] = cp;
  return (utf16Index) => codePointByUtf16[utf16Index] ?? cp;
}

function findCodeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  CODE_SPAN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SPAN_REGEX.exec(text)) !== null) {
    spans.push([match.index, match.index + match[0].length]);
    if (match[0].length === 0) CODE_SPAN_REGEX.lastIndex += 1;
  }
  return spans;
}

/** Expand a word to the whitespace-delimited chunk around it. */
function chunkAround(text: string, start: number, end: number): string {
  let left = start;
  while (left > 0 && !/\s/.test(text[left - 1]!)) left -= 1;
  let right = end;
  while (right < text.length && !/\s/.test(text[right]!)) right += 1;
  return text.slice(left, right);
}

/**
 * The prose words in `text`.
 *
 * @returns Words in document order, with code-point offsets.
 */
export function extractWords(text: string): ExtractedWord[] {
  if (text === '') return [];

  if ([...text].length > MAX_SPELLCHECK_TEXT_LENGTH) {
    if (!warnedTooLong) {
      warnedTooLong = true;
      runLogger.debug(
        `[spellcheck] input longer than ${MAX_SPELLCHECK_TEXT_LENGTH} ` +
          'characters is not checked',
      );
    }
    return [];
  }

  const toCodePoint = buildCodePointIndex(text);
  const codeSpans = findCodeSpans(text);
  const chunkVerdicts = new Map<string, boolean>();
  const words: ExtractedWord[] = [];

  WORD_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_REGEX.exec(text)) !== null) {
    const raw = match[0];
    const startUtf16 = match.index;
    const endUtf16 = startUtf16 + raw.length;

    if (codeSpans.some(([from, to]) => startUtf16 < to && endUtf16 > from)) {
      continue;
    }

    const length = [...raw].length;
    if (length < MIN_WORD_LENGTH || length > MAX_WORD_LENGTH) continue;

    // An interior capital means CamelCase, an acronym, or an API name.
    const tail = raw.slice(1);
    if (tail !== tail.toLowerCase()) continue;

    if (UNCHECKABLE_SCRIPT_REGEX.test(raw)) continue;

    const chunk = chunkAround(text, startUtf16, endUtf16);
    let chunkIsCode = chunkVerdicts.get(chunk);
    if (chunkIsCode === undefined) {
      const trimmed = chunk.replace(CHUNK_TRIM_REGEX, '');
      chunkIsCode =
        CODE_LIKE_PREFIX_REGEX.test(trimmed) ||
        CODE_LIKE_CONTENT_REGEX.test(trimmed);
      chunkVerdicts.set(chunk, chunkIsCode);
    }
    if (chunkIsCode) continue;

    words.push({
      word: raw,
      start: toCodePoint(startUtf16),
      end: toCodePoint(endUtf16),
    });
  }

  return words;
}

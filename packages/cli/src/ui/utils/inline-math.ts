/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const INLINE_MATH_MAX_CHARS = 1024;

export const INLINE_MATH_PATTERN_SOURCE = String.raw`(?<![\\\w$])\$(?![\s\d$])[^$\n]{0,${INLINE_MATH_MAX_CHARS - 1}}[^$\s](?<!\\)\$(?![\w$])`;

export const INLINE_CODE_SPAN_PATTERN_SOURCE = String.raw`(?<!\`)(?<inlineCodeFence>\`+)(?!\`).+?(?<!\`)\k<inlineCodeFence>(?!\`)`;

const INLINE_CODE_SPAN_RE = new RegExp(INLINE_CODE_SPAN_PATTERN_SOURCE, 'g');

export function findInlineMathExpressions(text: string): string[] {
  const codeRanges = [...text.matchAll(INLINE_CODE_SPAN_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const mathRegex = new RegExp(INLINE_MATH_PATTERN_SOURCE, 'g');
  const expressions: string[] = [];

  for (const match of text.matchAll(mathRegex)) {
    const start = match.index;
    const raw = match[0];
    const end = start + raw.length;
    if (codeRanges.some((range) => start >= range.start && end <= range.end)) {
      continue;
    }
    expressions.push(raw.slice(1, -1));
  }

  return expressions;
}

const INLINE_MATH_AT_RE = new RegExp(INLINE_MATH_PATTERN_SOURCE, 'y');

export function readInlineMathSpanAt(
  text: string,
  index: number,
): string | null {
  INLINE_MATH_AT_RE.lastIndex = index;
  return INLINE_MATH_AT_RE.exec(text)?.[0] ?? null;
}

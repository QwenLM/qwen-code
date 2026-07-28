/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const INLINE_MATH_MAX_CHARS = 1024;

export const INLINE_CODE_SPAN_PATTERN_SOURCE = String.raw`(?<!\`)(?<inlineCodeFence>\`+)(?!\`).+?(?<!\`)\k<inlineCodeFence>(?!\`)`;

const INLINE_CODE_SPAN_RE = new RegExp(INLINE_CODE_SPAN_PATTERN_SOURCE, 'g');

export interface InlineMathSpan {
  content: string;
  index: number;
  raw: string;
}

export type InlineToken =
  | { kind: 'markup'; match: RegExpMatchArray }
  | { kind: 'math'; span: InlineMathSpan };

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === '\\';
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isUnescapedDollarAt(text: string, index: number): boolean {
  return text[index] === '$' && !isEscapedAt(text, index);
}

export function unescapeMarkdownDollars(text: string): string {
  return text.replace(
    /(\\+)\$/g,
    (_match, slashes: string) =>
      `${'\\'.repeat(Math.floor(slashes.length / 2))}$`,
  );
}

export function unescapeMarkdownBeforeMath(text: string): string {
  return unescapeMarkdownDollars(`${text}$`).slice(0, -1);
}

// Escape state depends on the parity of the complete backslash run, and an
// escaped dollar inside math must be skipped while looking for the real closer.
function readInlineMathSpan(
  text: string,
  index: number,
): InlineMathSpan | null {
  if (!isUnescapedDollarAt(text, index)) {
    return null;
  }

  const previous = text[index - 1] ?? '';
  const next = text[index + 1] ?? '';
  if (
    /\w/.test(previous) ||
    isUnescapedDollarAt(text, index - 1) ||
    !next ||
    /[\s\d$]/.test(next)
  ) {
    return null;
  }

  let closingIndex = index + 1;
  while (
    closingIndex < text.length &&
    text[closingIndex] !== '\n' &&
    closingIndex - index - 1 <= INLINE_MATH_MAX_CHARS &&
    !isUnescapedDollarAt(text, closingIndex)
  ) {
    closingIndex += 1;
  }

  if (!isUnescapedDollarAt(text, closingIndex)) {
    return null;
  }

  const content = text.slice(index + 1, closingIndex);
  const following = text[closingIndex + 1] ?? '';
  if (
    content.length > INLINE_MATH_MAX_CHARS ||
    /\s$/.test(content) ||
    /[\w$]/.test(following)
  ) {
    return null;
  }

  return {
    content,
    index,
    raw: text.slice(index, closingIndex + 1),
  };
}

export function findNextInlineMath(
  text: string,
  fromIndex = 0,
): InlineMathSpan | null {
  for (let index = fromIndex; index < text.length; index += 1) {
    const span = readInlineMathSpan(text, index);
    if (span) {
      return span;
    }
  }
  return null;
}

export function* mergeInlineMathMatches(
  text: string,
  markupRegex: RegExp,
  enableInlineMath = true,
): Generator<InlineToken> {
  markupRegex.lastIndex = 0;
  const markupMatches = text.matchAll(markupRegex);
  let nextMarkup = markupMatches.next();
  let nextMath = enableInlineMath ? findNextInlineMath(text) : null;
  let cursor = 0;

  while (!nextMarkup.done || nextMath) {
    while (!nextMarkup.done && (nextMarkup.value.index ?? 0) < cursor) {
      nextMarkup = markupMatches.next();
    }

    if (nextMath && nextMath.index < cursor) {
      nextMath = findNextInlineMath(text, cursor);
    }

    const markupIndex = nextMarkup.done
      ? Number.POSITIVE_INFINITY
      : (nextMarkup.value.index ?? 0);
    const mathIndex = nextMath?.index ?? Number.POSITIVE_INFINITY;

    if (!nextMarkup.done && markupIndex <= mathIndex) {
      const match = nextMarkup.value;
      yield { kind: 'markup', match };
      cursor = markupIndex + match[0].length;
      nextMarkup = markupMatches.next();
    } else if (nextMath) {
      yield { kind: 'math', span: nextMath };
      cursor = mathIndex + nextMath.raw.length;
      nextMath = findNextInlineMath(text, cursor);
    }
  }
}

export function findInlineMathExpressions(text: string): string[] {
  const expressions: string[] = [];

  for (const token of mergeInlineMathMatches(text, INLINE_CODE_SPAN_RE)) {
    if (token.kind === 'math') {
      expressions.push(token.span.content);
    }
  }

  return expressions;
}

export function readInlineMathSpanAt(
  text: string,
  index: number,
): string | null {
  return readInlineMathSpan(text, index)?.raw ?? null;
}

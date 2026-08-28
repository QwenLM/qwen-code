/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plain-text conversions for screen-reader parity. Ink's screen-reader path
 * renders squashed text only (no styles, borders or backgrounds), so the
 * OpenTUI equivalent needs ANSI-stripped, markdown-reduced text for anything
 * it would otherwise draw with colors or structure.
 *
 * The reduction stays line-based on purpose: ink's InlineMarkdownRenderer
 * guards underscore emphasis at word boundaries so identifiers like
 * `__init__` survive, and a CommonMark parser (markdown-it) emphasizes them.
 * Fences, code spans and quote prefixes below follow the CommonMark rules
 * ink's renderer applies.
 */

import stripAnsiLib from 'strip-ansi';

// strip-ansi 7.x strips the introducer of CSI sequences with private
// parameter markers (e.g. the SGR mouse report \x1b[<0;5;1M) but leaves
// their parameter bytes as visible text; remove the full sequence first.
// eslint-disable-next-line no-control-regex
const PRIVATE_PARAM_CSI = /\x1b\[[?<>=][0-9;:<=>?]*[@-~]/g;

/** Strips all ANSI escape sequences, leaving the readable text. */
export function stripAnsi(text: string): string {
  return stripAnsiLib(text.replace(PRIVATE_PARAM_CSI, ''));
}

/**
 * Reduces markdown to the plain text a screen reader should announce:
 * headings lose their hashes, fenced code keeps its body, emphasis markers
 * disappear, links and images reduce to their text/alt, blockquote prefixes
 * and horizontal rules are dropped. Bullet markers stay — they are readable
 * content in the ink parity path too.
 */
export function markdownToPlainText(markdown: string): string {
  const result: string[] = [];
  // The character AND length of the fence that opened the current code
  // block, or null outside one. CommonMark: a fence only closes on the
  // same character with at least the opening length.
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  for (const rawLine of markdown.split('\n')) {
    // CommonMark fence: 3+ backticks/tildes, optionally indented up to 3
    // spaces. Inside a block only a same-char fence of >= length closes it;
    // every other line is literal body (no de-quoting — fenced bodies never
    // contain blockquote structure).
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const char = run.charAt(0) as '`' | '~';
      if (fenceChar === null) {
        fenceChar = char;
        fenceLength = run.length;
      } else if (fenceChar === char && run.length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      } else {
        result.push(rawLine);
      }
      continue;
    }
    if (fenceChar !== null) {
      result.push(rawLine);
      continue;
    }

    // Block-level passes run on the de-quoted view so headings inside
    // blockquotes are recognized; the prefix is not content. (Only outside
    // fences — a `>` line inside a fenced body is literal text.)
    let text = rawLine.replace(/^(?:\s*>\s?)+/, '');
    // Headings: "# Title" -> "Title".
    text = text.replace(/^ {0,3}#{1,6}\s+/, '');
    // Horizontal rules vanish in screen-reader output.
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      result.push('');
      continue;
    }
    // Extract code spans before the other inline passes: their contents are
    // literal text and must not be consumed as links/emphasis markup.
    // CommonMark: a span opens with N backticks and closes on the next run
    // of exactly N backticks (single backticks inside ``spans`` survive).
    const codeSpans: string[] = [];
    text = text.replace(/(?<!`)(`+)([\s\S]*?)\1(?!`)/g, (_, _ticks, span) => {
      codeSpans.push(span);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
    // Images -> alt text, links -> link text.
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Bold before italic so "**x**" is not eaten twice.
    text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1');
    // Underscore emphasis only applies at word boundaries (CommonMark), so
    // "__init__" and snake_case identifiers survive untouched.
    text = text.replace(/(^|\s)__(?=\S)([\s\S]*?\S)__(?=\s|$)/g, '$1$2');
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
    text = text.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '$1');
    text = text.replace(/(^|\s)_(?=\S)([\s\S]*?\S)_(?=\s|$)/g, '$1$2');
    // Restore the code-span contents last.
    text = text.replace(
      // eslint-disable-next-line no-control-regex -- NUL marks extracted code spans
      /\u0000(\d+)\u0000/g,
      (_, index: string) => codeSpans[Number(index)] ?? '',
    );

    result.push(text);
  }

  return result.join('\n');
}

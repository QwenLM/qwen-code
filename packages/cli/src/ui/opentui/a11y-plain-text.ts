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
 */

/**
 * Matches ANSI escape sequences: CSI (colors, cursor movement), OSC
 * (hyperlinks, title queries) with BEL/ST terminators, and two-character
 * Fe sequences.
 */
const ANSI_ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\u0007\x1b]*(?:\u0007|\x1b\\)?|[@-Z\\-_])/g;

/** Strips all ANSI escape sequences, leaving the readable text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPES, '');
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
  // The fence character that opened the current code block, or null outside
  // one. CommonMark: a fence only closes on the same character, so a
  // fence-like line inside a block opened by the other character is body.
  let fenceChar: '`' | '~' | null = null;

  for (const rawLine of markdown.split('\n')) {
    // Block-level passes run on the de-quoted view so headings and fences
    // inside blockquotes are recognized; the prefix is not content.
    const line = rawLine.replace(/^(?:\s*>\s?)+/, '');
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      const char = fenceMatch[1]!.charAt(0) as '`' | '~';
      if (fenceChar === null) {
        fenceChar = char;
      } else if (fenceChar === char) {
        fenceChar = null;
      } else {
        result.push(line);
      }
      continue;
    }
    if (fenceChar !== null) {
      result.push(line);
      continue;
    }

    let text = line;
    // Headings: "# Title" -> "Title".
    text = text.replace(/^ {0,3}#{1,6}\s+/, '');
    // Horizontal rules vanish in screen-reader output.
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      result.push('');
      continue;
    }
    // Extract code spans before the other inline passes: their contents are
    // literal text and must not be consumed as links/emphasis markup.
    const codeSpans: string[] = [];
    text = text.replace(/`([^`]*)`/g, (_, span: string) => {
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

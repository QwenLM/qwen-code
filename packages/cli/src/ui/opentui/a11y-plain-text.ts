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
// The intermediate-byte class (0x20-0x2F) covers DECRQCRA-style sequences
// whose final byte is preceded by one (e.g. CSI ? … $ y).
// eslint-disable-next-line no-control-regex
const PRIVATE_PARAM_CSI = /\x1b\[[?<>=][0-9;:<=>?]*[\x20-\x2F]*[@-~]/g;

// strip-ansi also leaves DCS/SOS/PM/APC sequences (only the 2-byte
// introducer of a DCS is consumed) and unterminated OSC bodies in place;
// consume them through ST/BEL/end-of-input so SIXEL payloads or tmux
// passthroughs never reach the screen reader as announced garbage.
/* eslint-disable no-control-regex */
const OTHER_ESCAPE_SEQUENCE =
  /\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07|$)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
/* eslint-enable no-control-regex */

/** Strips all ANSI escape sequences, leaving the readable text. */
export function stripAnsi(text: string): string {
  return stripAnsiLib(
    text.replace(PRIVATE_PARAM_CSI, '').replace(OTHER_ESCAPE_SEQUENCE, ''),
  );
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

  // CommonMark line endings: \r\n, \n, and lone \r all terminate a line;
  // splitting on \n alone leaves \r on the line, which `.` excludes and
  // `$` cannot see past, deadening fence detection for CRLF markdown.
  for (const rawLine of markdown.split(/\r\n|\n|\r/)) {
    // CommonMark fence: 3+ backticks/tildes, optionally indented up to 3
    // spaces. An OPENING fence may carry info text (```js); a CLOSING
    // fence cannot — a fence-like line with trailing content inside a
    // block is literal body, not a close.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const trailing = fenceMatch[2] ?? '';
      const char = run.charAt(0) as '`' | '~';
      if (fenceChar === null) {
        fenceChar = char;
        fenceLength = run.length;
      } else if (
        fenceChar === char &&
        run.length >= fenceLength &&
        trailing.trim() === ''
      ) {
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
    // Mirrors ink's INLINE_CODE_SPAN_PATTERN_SOURCE: non-empty content, and
    // the closing run is neither preceded nor followed by another backtick,
    // so `` and stray runs stay literal instead of being consumed reordered.
    const codeSpans: string[] = [];
    text = text.replace(
      /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g,
      (_, _ticks, span) => {
        codeSpans.push(span);
        return `\u0000${codeSpans.length - 1}\u0000`;
      },
    );
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
